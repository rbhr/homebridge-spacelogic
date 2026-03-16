import { EventEmitter } from 'node:events';
import type { Logging } from 'homebridge';
import { XMLParser } from 'fast-xml-parser';

import { CGateConnection } from './CGateConnection.js';
import type {
  CBusDevice,
  CGateConfig,
  ScpEvent,
  ScpLightingEvent,
  ScpMeasurementEvent,
} from './types.js';
import {
  CBUS_LIGHTING_APPLICATION,
  CBUS_MEASUREMENT_APPLICATION,
  COMMAND_TIMEOUT,
  DBGETXML_TIMEOUT,
  DEFAULT_KEEPALIVE_INTERVAL,
} from './types.js';

const SCP_LIGHTING_PATTERN = /^lighting\s+(on|off|ramp)\s+\/\/(\S+?)\/(\d+)\/(\d+)\/(\d+)(?:\s+(\d+)%?)?/;
const SCP_MEASUREMENT_PATTERN = /^measurement\s+data\s+\/\/(\S+?)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/;
const LEVEL_RESPONSE_PATTERN = /^300\s+\S+:\s+level=(\d+)/;

interface PendingCommand {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  response: string[];
  xmlMode: boolean;
}

export class CGateClient extends EventEmitter {
  private commandConn: CGateConnection;
  private eventConn: CGateConnection;
  private scpConn: CGateConnection;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private pendingCommand: PendingCommand | null = null;
  private commandQueue: Array<{ cmd: string; timeout: number; resolve: (v: string) => void; reject: (e: Error) => void }> = [];
  private _ready = false;
  private virtualGroups = new Set<string>();

  constructor(
    private readonly config: CGateConfig,
    private readonly log: Logging,
  ) {
    super();
    this.commandConn = new CGateConnection(config.host, config.commandPort, 'CMD', log);
    this.eventConn = new CGateConnection(config.host, config.eventPort, 'EVT', log);
    this.scpConn = new CGateConnection(config.host, config.scpPort, 'SCP', log);
  }

  get ready(): boolean {
    return this._ready;
  }

  async connect(): Promise<void> {
    // Set up line handlers before connecting
    this.commandConn.on('line', (line: string) => this.handleCommandLine(line));
    this.eventConn.on('line', (line: string) => this.handleEventLine(line));
    this.scpConn.on('line', (line: string) => this.handleScpLine(line));

    // Handle reconnections
    this.commandConn.on('connected', () => this.initCommandPort());
    this.commandConn.on('disconnected', () => {
      this._ready = false;
      this.rejectPendingCommand(new Error('Connection lost'));
      this.emit('disconnected');
    });

    this.eventConn.on('connected', () => this.initEventPort());
    this.scpConn.on('connected', () => {
      this.log.debug('SCP port connected, listening for state changes');
    });

    // Connect all three ports
    await Promise.all([
      this.connectPort(this.commandConn),
      this.connectPort(this.eventConn),
      this.connectPort(this.scpConn),
    ]);

    // Initialize command port (project use/start)
    await this.initCommandPort();
  }

  async disconnect(): Promise<void> {
    this._ready = false;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.rejectPendingCommand(new Error('Disconnecting'));
    this.commandConn.disconnect();
    this.eventConn.disconnect();
    this.scpConn.disconnect();
  }

  async sendCommand(cmd: string, timeout = COMMAND_TIMEOUT): Promise<string> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ cmd, timeout, resolve, reject });
      this.processQueue();
    });
  }

  async turnOn(address: string): Promise<void> {
    await this.sendCommand(`ON ${address}`);
  }

  async turnOff(address: string): Promise<void> {
    await this.sendCommand(`OFF ${address}`);
  }

  async ramp(address: string, level: number, rateSeconds?: number): Promise<void> {
    const levelClamped = Math.max(0, Math.min(255, Math.round(level)));
    let cmd = `RAMP ${address} ${levelClamped}`;
    if (rateSeconds !== undefined && rateSeconds > 0) {
      cmd += ` ${rateSeconds}s`;
    }
    await this.sendCommand(cmd);
  }

  async getLevel(address: string): Promise<number> {
    if (this.virtualGroups.has(address)) {
      return 0;
    }
    try {
      const response = await this.sendCommand(`GET ${address} level`);
      const match = LEVEL_RESPONSE_PATTERN.exec(response);
      if (match) {
        return parseInt(match[1], 10);
      }
      this.log.warn(`Unexpected GET level response: ${response}`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401')) {
        this.log.debug(`Group ${address} is virtual (no physical unit), marking`);
        this.virtualGroups.add(address);
      }
      return 0;
    }
  }

  async discoverDevices(): Promise<CBusDevice[]> {
    const xmlContent = await this.fetchDbXml();
    if (!xmlContent) {
      return [];
    }
    return this.parseXmlDevices(xmlContent);
  }

  // --- Private methods ---

  private connectPort(conn: CGateConnection): Promise<void> {
    return new Promise((resolve, reject) => {
      conn.once('connected', () => resolve());
      conn.once('error', (err: Error) => reject(err));
      conn.connect();
    });
  }

  private async initCommandPort(): Promise<void> {
    try {
      // Wait briefly for the 201 greeting
      await this.delay(500);

      await this.sendCommand(`PROJECT USE ${this.config.project}`);
      await this.sendCommand(`PROJECT START ${this.config.project}`);

      this.startKeepalive();
      this._ready = true;
      this.log.info('C-Gate client ready');
      this.emit('ready');
    } catch (err) {
      this.log.error(`Failed to initialize command port: ${err instanceof Error ? err.message : err}`);
    }
  }

  private initEventPort(): void {
    try {
      this.eventConn.write('EVENT e5s1c1');
    } catch (err) {
      this.log.error(`Failed to initialize event port: ${err instanceof Error ? err.message : err}`);
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
    }
    this.keepaliveTimer = setInterval(() => {
      if (this.commandConn.connected && !this.pendingCommand) {
        this.sendCommand('NOOP').catch(() => {
          // Keepalive failure is logged by the command handler
        });
      }
    }, DEFAULT_KEEPALIVE_INTERVAL);
  }

  private processQueue(): void {
    if (this.pendingCommand || this.commandQueue.length === 0) {
      return;
    }

    const { cmd, timeout, resolve, reject } = this.commandQueue.shift()!;

    if (!this.commandConn.connected) {
      reject(new Error('Not connected'));
      this.processQueue();
      return;
    }

    const timer = setTimeout(() => {
      this.log.warn(`Command timed out: ${cmd}`);
      this.rejectPendingCommand(new Error(`Command timeout: ${cmd}`));
    }, timeout);

    this.pendingCommand = {
      resolve,
      reject,
      timer,
      response: [],
      xmlMode: false,
    };

    this.log.debug(`Sending command: ${cmd}`);
    try {
      this.commandConn.write(cmd);
    } catch (err) {
      this.rejectPendingCommand(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleCommandLine(line: string): void {
    // Skip the 201 greeting
    if (line.startsWith('201 ')) {
      return;
    }

    const pending = this.pendingCommand;
    if (!pending) {
      // Unsolicited line on command port
      this.log.debug(`Unsolicited command port line: ${line}`);
      return;
    }

    // XML mode: DBGETXML response
    if (line.startsWith('343')) {
      pending.xmlMode = true;
      return;
    }

    if (pending.xmlMode) {
      if (line.startsWith('344')) {
        // End of XML
        const xmlContent = pending.response.join('');
        this.resolvePendingCommand(xmlContent);
        return;
      }
      // XML content lines start with "347-"
      if (line.startsWith('347-')) {
        pending.response.push(line.slice(4));
      } else if (line.startsWith('347 ')) {
        pending.response.push(line.slice(4));
      }
      return;
    }

    // Check for response code (3 digits at start)
    const codeMatch = /^(\d{3})[\s-]/.exec(line);
    if (codeMatch) {
      const code = parseInt(codeMatch[1], 10);

      if (code >= 200 && code < 300) {
        // Success
        pending.response.push(line);
        this.resolvePendingCommand(pending.response.join('\n'));
      } else if (code >= 300 && code < 400) {
        // Object info — could be multi-line (continuation mark "-")
        pending.response.push(line);
        if (!line.startsWith(`${codeMatch[1]}-`)) {
          // Final line (space, not dash)
          this.resolvePendingCommand(pending.response.join('\n'));
        }
      } else if (code >= 400) {
        // Error
        this.rejectPendingCommand(new Error(`C-Gate error: ${line}`));
      }
    } else {
      // Continuation or other data
      pending.response.push(line);
    }
  }

  private handleEventLine(line: string): void {
    this.log.debug(`Event: ${line}`);
  }

  private handleScpLine(line: string): void {
    const event = this.parseScpLine(line);
    if (event) {
      this.emit('scpEvent', event);
    } else {
      this.log.debug(`Unparsed SCP line: ${line}`);
    }
  }

  private parseScpLine(line: string): ScpEvent | null {
    // Try lighting pattern
    const lightMatch = SCP_LIGHTING_PATTERN.exec(line);
    if (lightMatch) {
      const action = lightMatch[1] as 'on' | 'off' | 'ramp';
      const event: ScpLightingEvent = {
        kind: 'lighting',
        action,
        project: lightMatch[2],
        network: parseInt(lightMatch[3], 10),
        application: parseInt(lightMatch[4], 10),
        group: parseInt(lightMatch[5], 10),
        level: action === 'on' ? 100 : action === 'off' ? 0 : lightMatch[6] ? parseInt(lightMatch[6], 10) : undefined,
      };
      return event;
    }

    // Try measurement pattern
    const measMatch = SCP_MEASUREMENT_PATTERN.exec(line);
    if (measMatch) {
      const event: ScpMeasurementEvent = {
        kind: 'measurement',
        project: measMatch[1],
        network: parseInt(measMatch[2], 10),
        application: parseInt(measMatch[3], 10),
        device: parseInt(measMatch[4], 10),
        channel: parseInt(measMatch[5], 10),
        value: parseInt(measMatch[6], 10),
        exponent: parseInt(measMatch[7], 10),
        units: parseInt(measMatch[8], 10),
      };
      return event;
    }

    return null;
  }

  private resolvePendingCommand(response: string): void {
    const pending = this.pendingCommand;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingCommand = null;
    pending.resolve(response);
    this.processQueue();
  }

  private rejectPendingCommand(error: Error): void {
    const pending = this.pendingCommand;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingCommand = null;
    pending.reject(error);
    this.processQueue();
  }

  private async fetchDbXml(): Promise<string | null> {
    try {
      const response = await this.sendCommand(
        `DBGETXML //${this.config.project}`,
        DBGETXML_TIMEOUT,
      );
      return response;
    } catch (err) {
      this.log.error(`DBGETXML failed: ${err instanceof Error ? err.message : err}`);
      // Retry once
      try {
        await this.delay(5000);
        const response = await this.sendCommand(
          `DBGETXML //${this.config.project}`,
          DBGETXML_TIMEOUT,
        );
        return response;
      } catch (retryErr) {
        this.log.error(`DBGETXML retry failed: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
        return null;
      }
    }
  }

  private parseXmlDevices(xml: string): CBusDevice[] {
    const devices: CBusDevice[] = [];

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        isArray: (name) => ['Network', 'Application', 'Group'].includes(name),
      });
      const parsed = parser.parse(xml);

      // Navigate the XML structure to find networks
      const root = parsed.Installation || parsed.Project || parsed;
      const networks = this.findNetworks(root);

      for (const network of networks) {
        const netAddr = parseInt(network['@_Address'] || network.Address || '0', 10);
        const applications = this.findApplications(network);

        for (const app of applications) {
          const appAddr = parseInt(app['@_Address'] || app.Address || '0', 10);

          // Only process lighting (56) and measurement (228) applications
          if (appAddr !== CBUS_LIGHTING_APPLICATION && appAddr !== CBUS_MEASUREMENT_APPLICATION) {
            continue;
          }

          const groups = this.findGroups(app);
          for (const group of groups) {
            const groupAddr = parseInt(group['@_Address'] || group.Address || '0', 10);
            const tagName = group.TagName || group['@_TagName'] || '';

            // Skip group 0 (master/broadcast) and group 255 (broadcast)
            if (groupAddr === 0 || groupAddr === 255) {
              continue;
            }

            // Skip unnamed/placeholder groups
            if (this.isPlaceholderName(tagName, groupAddr)) {
              continue;
            }

            const addressString = `${netAddr}/${appAddr}/${groupAddr}`;
            devices.push({
              address: { network: netAddr, application: appAddr, group: groupAddr },
              name: tagName,
              addressString,
            });
          }
        }
      }
    } catch (err) {
      this.log.error(`XML parsing error: ${err instanceof Error ? err.message : err}`);
    }

    this.log.info(`Discovered ${devices.length} C-Bus groups`);
    return devices;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findNetworks(obj: any): any[] {
    if (!obj) {
      return [];
    }
    if (obj.Network) {
      return Array.isArray(obj.Network) ? obj.Network : [obj.Network];
    }
    // Search one level deeper
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key]?.Network) {
        return Array.isArray(obj[key].Network) ? obj[key].Network : [obj[key].Network];
      }
    }
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findApplications(network: any): any[] {
    if (!network) {
      return [];
    }
    if (network.Application) {
      return Array.isArray(network.Application) ? network.Application : [network.Application];
    }
    // Check under ApplicationList or similar
    for (const key of Object.keys(network)) {
      if (typeof network[key] === 'object' && network[key]?.Application) {
        return Array.isArray(network[key].Application) ? network[key].Application : [network[key].Application];
      }
    }
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findGroups(app: any): any[] {
    if (!app) {
      return [];
    }
    if (app.Group) {
      return Array.isArray(app.Group) ? app.Group : [app.Group];
    }
    for (const key of Object.keys(app)) {
      if (typeof app[key] === 'object' && app[key]?.Group) {
        return Array.isArray(app[key].Group) ? app[key].Group : [app[key].Group];
      }
    }
    return [];
  }

  private isPlaceholderName(name: string, groupAddr: number): boolean {
    if (!name || name.trim() === '') {
      return true;
    }
    const lower = name.toLowerCase().trim();
    if (lower === '<unused>' || lower === 'unused' || lower === 'untitled') {
      return true;
    }
    if (lower === `group ${groupAddr}` || lower === `group_${groupAddr}`) {
      return true;
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
