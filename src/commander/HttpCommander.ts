import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import type { Logging } from 'homebridge';

import type { CGateClient } from '../cgate/CGateClient.js';
import { DBGETXML_TIMEOUT } from '../cgate/types.js';
import { CONSOLE_HTML } from './console.html.js';

const SSE_KEEPALIVE_INTERVAL = 30_000;

/**
 * A project name is config, not user input, but it ends up in a
 * Content-Disposition header — where a quote or a newline would let it write
 * headers of its own. Anything outside this set is dropped rather than
 * escaped.
 */
function safeFileStem(project: string): string {
  const cleaned = project.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned || 'project';
}

export class HttpCommander {
  private server: Server | null = null;
  private readonly sseClients = new Set<ServerResponse>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // Bound listeners for cleanup
  private readonly onEventLine: (line: string) => void;
  private readonly onScpLine: (line: string) => void;

  constructor(
    private readonly port: number,
    private readonly cgateClient: CGateClient,
    private readonly log: Logging,
  ) {
    this.onEventLine = (line: string) => this.broadcast('event', line);
    this.onScpLine = (line: string) => this.broadcast('scp', line);
  }

  start(): void {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.log.error(`HTTP handler error: ${err instanceof Error ? err.message : err}`);
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Internal server error' }));
        }
      });
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.log.error(`Commander port ${this.port} is already in use. HTTP Commander disabled.`);
      } else {
        this.log.error(`Commander HTTP server error: ${err.message}`);
      }
    });

    this.server.listen(this.port, () => {
      this.log.info(`C-Gate Commander listening on http://localhost:${this.port}/`);
    });

    // Subscribe to C-Gate events
    this.cgateClient.on('eventLine', this.onEventLine);
    this.cgateClient.on('scpLine', this.onScpLine);

    // SSE keepalive
    this.keepaliveTimer = setInterval(() => {
      for (const client of this.sseClients) {
        try {
          client.write(': keepalive\n\n');
        } catch {
          this.sseClients.delete(client);
        }
      }
    }, SSE_KEEPALIVE_INTERVAL);
  }

  stop(): void {
    // Remove event listeners
    this.cgateClient.removeListener('eventLine', this.onEventLine);
    this.cgateClient.removeListener('scpLine', this.onScpLine);

    // Stop keepalive
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    // Close all SSE connections
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Ignore close errors
      }
    }
    this.sseClients.clear();

    // Close HTTP server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.log.info('C-Gate Commander stopped');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/console') {
      this.serveConsole(res);
    } else if (pathname === '/cgate') {
      await this.handleCommand(url, res);
    } else if (pathname === '/tag') {
      this.handleTagInfo(res);
    } else if (pathname === '/tag/download') {
      await this.handleTagDownload(res);
    } else if (pathname === '/events') {
      this.handleSSE(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private serveConsole(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(CONSOLE_HTML);
  }

  /**
   * What the console needs to label its download button before anyone clicks
   * it: which project, and whether C-Gate can currently be asked for it.
   */
  private handleTagInfo(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      project: this.cgateClient.project,
      ready: this.cgateClient.ready,
    }));
  }

  /**
   * Download the project's tag database as XML.
   *
   * This is not the `.cbz` the C-Gate add-on's console produces, and it cannot
   * be: that is a zip of the project *directory* — database plus the dynamic
   * labelling bitmaps — and this plugin is a C-Gate client that may not even be
   * on the same machine as those files. What a client can get is what C-Gate
   * will hand over the command interface, which is `DBGETXML`: the whole tag
   * database, and the counterpart of the `DBSETXML` that puts one back.
   *
   * It is the same document the plugin parses to discover groups, so it is also
   * the file to attach to a bug report about discovery.
   */
  private async handleTagDownload(res: ServerResponse): Promise<void> {
    const project = this.cgateClient.project;

    if (!this.cgateClient.ready) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'C-Gate not connected' }));
      return;
    }

    this.log.debug(`Commander tag database download: ${project}`);

    try {
      const xml = await this.cgateClient.sendCommand(`DBGETXML //${project}`, DBGETXML_TIMEOUT);
      if (!xml) {
        // C-Gate answered, but with nothing — an unloaded project rather than
        // an unreachable server, so it is worth saying which.
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          error: `DBGETXML returned no data for project ${project} — is it loaded?`,
        }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeFileStem(project)}.xml"`,
      });
      res.end(xml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.debug(`Commander tag database download failed: ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: message }));
    }
  }

  private async handleCommand(url: URL, res: ServerResponse): Promise<void> {
    const cmd = url.searchParams.get('cmd');

    if (!cmd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'Missing cmd parameter' }));
      return;
    }

    if (!this.cgateClient.ready) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'C-Gate not connected' }));
      return;
    }

    this.log.debug(`Commander command: ${cmd}`);

    try {
      const response = await this.cgateClient.sendCommand(cmd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', command: cmd, response }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.debug(`Commander command error: ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', command: cmd, error: message }));
    }
  }

  private handleSSE(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Initial connection comment
    res.write(': connected\n\n');

    this.sseClients.add(res);
    this.log.debug(`SSE client connected (${this.sseClients.size} total)`);

    res.on('close', () => {
      this.sseClients.delete(res);
      this.log.debug(`SSE client disconnected (${this.sseClients.size} total)`);
    });
  }

  private broadcast(eventType: string, data: string): void {
    const message = `event: ${eventType}\ndata: ${data}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(message);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}
