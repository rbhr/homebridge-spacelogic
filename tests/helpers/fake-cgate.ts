import { createServer, type Server, type Socket } from 'node:net';

/**
 * A C-Gate server good enough to drive the plugin's recovery paths.
 *
 * Speaks real TCP on all three ports, because the bugs this exists to catch —
 * an unhandled 'error' event killing the process, a second reconnect chain
 * being started by a stale socket — only happen against real sockets. A mocked
 * transport would not have reproduced any of them.
 *
 * Ports are allocated once at construction and kept for the object's lifetime,
 * so stop()/start() simulate C-Gate going away and coming back at the same
 * address, which is what the plugin actually has to survive.
 */
export interface FakeCGateOptions {
  /** When false, PROJECT USE is refused, so the handshake can never complete. */
  projectLoads?: boolean;
  /** Levels (0-255) returned by "GET <address> level". */
  levels?: Map<string, number>;
  /** Addresses that answer "GET ... level" with a 401, as a virtual group does. */
  virtualGroups?: Set<string>;
  /** Body returned by DBGETXML. Empty string means "reachable but no data". */
  xml?: string;
}

/** Two real lighting groups plus the placeholders the parser is meant to drop. */
export const DEFAULT_XML = [
  '<Network><TagName>Test Net</TagName><Address>254</Address>',
  '<Application><TagName>Lighting</TagName><Address>56</Address>',
  '<Group><TagName>&lt;Unused&gt;</TagName><Address>255</Address></Group>',
  '<Group><TagName>MASTER</TagName><Address>0</Address></Group>',
  '<Group><TagName>Kitchen</TagName><Address>1</Address></Group>',
  '<Group><TagName>Hallway</TagName><Address>2</Address></Group>',
  '</Application></Network>',
].join('');

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function lines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = '';
  socket.on('data', (data: Buffer) => {
    buffer += data.toString();
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        onLine(line);
      }
      index = buffer.indexOf('\n');
    }
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeCGate {
  commandPort = 0;
  eventPort = 0;
  scpPort = 0;

  /** Every line received on the command port, in order. */
  readonly commands: string[] = [];
  /** Every line received on the event port (the EVENT subscription). */
  readonly eventPortLines: string[] = [];
  /** How many times a client has connected to the command port. */
  commandConnectionCount = 0;

  options: FakeCGateOptions;

  private commandServer: Server;
  private eventServer: Server;
  private scpServer: Server;
  private readonly sockets = new Set<Socket>();
  private readonly scpSockets = new Set<Socket>();
  private listening = false;

  private constructor(options: FakeCGateOptions) {
    this.options = options;
    this.commandServer = createServer((socket) => this.onCommandSocket(socket));
    this.eventServer = createServer((socket) => this.onEventSocket(socket));
    this.scpServer = createServer((socket) => this.onScpSocket(socket));
  }

  static async create(options: FakeCGateOptions = {}): Promise<FakeCGate> {
    const server = new FakeCGate({
      projectLoads: true,
      levels: new Map(),
      virtualGroups: new Set(),
      xml: DEFAULT_XML,
      ...options,
    });
    await server.start();
    return server;
  }

  /** Begin listening, reusing the previously allocated ports after the first call. */
  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    this.commandPort = await listen(this.commandServer, this.commandPort);
    this.eventPort = await listen(this.eventServer, this.eventPort);
    this.scpPort = await listen(this.scpServer, this.scpPort);
    this.listening = true;
  }

  /**
   * Take C-Gate away entirely: sockets destroyed and nothing listening, so the
   * next connect attempt is refused. This is the outage the plugin used to die on.
   */
  async stop(): Promise<void> {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    this.destroySockets();
    await Promise.all([
      close(this.commandServer),
      close(this.eventServer),
      close(this.scpServer),
    ]);
    // A closed server cannot be re-listened, so build fresh ones for the next start().
    this.commandServer = createServer((socket) => this.onCommandSocket(socket));
    this.eventServer = createServer((socket) => this.onEventSocket(socket));
    this.scpServer = createServer((socket) => this.onScpSocket(socket));
  }

  /** Drop the live connections but keep listening, as a C-Gate restart would. */
  dropConnections(): void {
    this.destroySockets();
  }

  /** Push an unsolicited state-change line to every connected SCP client. */
  pushScp(line: string): void {
    for (const socket of this.scpSockets) {
      socket.write(`${line}\r\n`);
    }
  }

  /** Resolve once a command matching the predicate has been received. */
  async waitForCommand(match: (cmd: string) => boolean, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.commands.find(match);
      if (found) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for command. Saw: ${JSON.stringify(this.commands)}`);
      }
      await delay(20);
    }
  }

  private destroySockets(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.scpSockets.clear();
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    // The plugin destroys sockets abruptly; without a sink those surface as
    // unhandled errors in the test process rather than in the code under test.
    socket.on('error', () => {});
  }

  private onCommandSocket(socket: Socket): void {
    this.commandConnectionCount++;
    this.track(socket);
    socket.write('201 Service ready: Clipsal C-Gate Version: v4.15.2\r\n');
    lines(socket, (line) => {
      this.commands.push(line);
      this.respondToCommand(socket, line);
    });
  }

  private onEventSocket(socket: Socket): void {
    this.track(socket);
    lines(socket, (line) => this.eventPortLines.push(line));
  }

  private onScpSocket(socket: Socket): void {
    this.track(socket);
    this.scpSockets.add(socket);
    socket.on('close', () => this.scpSockets.delete(socket));
    lines(socket, () => {});
  }

  private respondToCommand(socket: Socket, line: string): void {
    const write = (text: string): void => {
      socket.write(`${text}\r\n`);
    };

    if (line.startsWith('PROJECT USE')) {
      write(this.options.projectLoads ? '200 OK.' : '401 Bad object or command.');
      return;
    }
    if (line.startsWith('PROJECT START')) {
      write('200 OK.');
      return;
    }
    if (line.startsWith('DBGETXML')) {
      const xml = this.options.xml ?? '';
      write('343 Begin XML snippet');
      for (const chunk of xml.match(/.{1,120}/g) ?? []) {
        write(`347-${chunk}`);
      }
      write('344 End XML snippet.');
      return;
    }

    const getMatch = /^GET\s+(\S+)\s+level$/.exec(line);
    if (getMatch) {
      const address = getMatch[1];
      if (this.options.virtualGroups?.has(address)) {
        write('401 Bad object or command.');
        return;
      }
      const level = this.options.levels?.get(address) ?? 0;
      write(`300 ${address}: level=${level}`);
      return;
    }

    // NOOP, ON, OFF, RAMP and anything else the plugin sends.
    write('200 OK.');
  }
}
