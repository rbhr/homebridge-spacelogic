import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { Logging } from 'homebridge';

import { CMD_BUFFER_LIMIT, DEFAULT_IDLE_TIMEOUT, TCP_KEEPALIVE_DELAY } from './types.js';

const INITIAL_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 60000;
const RECONNECT_BACKOFF_FACTOR = 2;

export class CGateConnection extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private destroyed = false;

  /**
   * @param idleTimeout Milliseconds of silence after which the socket is treated
   *   as dead and recycled. Pass 0 to disable, which is right for ports that are
   *   legitimately idle for long stretches — a quiet C-Bus network produces no
   *   event or SCP traffic at all, and recycling those sockets on a timer just
   *   drops state changes during each reconnect. Liveness on those ports comes
   *   from TCP keepalive instead.
   */
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly label: string,
    private readonly log: Logging,
    private readonly idleTimeout: number = DEFAULT_IDLE_TIMEOUT,
  ) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.destroyed) {
      return;
    }

    this.log.debug(`[${this.label}] Connecting to ${this.host}:${this.port}`);

    this.socket = new Socket();
    this.buffer = '';

    this.socket.on('connect', () => {
      this.log.info(`[${this.label}] Connected to ${this.host}:${this.port}`);
      this._connected = true;
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      this.emit('connected');
    });

    this.socket.on('data', (data: Buffer) => {
      this.buffer += data.toString();

      if (this.buffer.length > CMD_BUFFER_LIMIT) {
        this.log.warn(`[${this.label}] Buffer overflow, truncating`);
        this.buffer = this.buffer.slice(-CMD_BUFFER_LIMIT);
      }

      const lines = this.buffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.length > 0) {
          this.emit('line', line);
        }
      }
    });

    this.socket.on('close', () => {
      this.log.debug(`[${this.label}] Connection closed`);
      this._connected = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.socket.on('error', (err: Error) => {
      this.log.error(`[${this.label}] Socket error: ${err.message}`);
      this.emit('error', err);
    });

    this.socket.on('timeout', () => {
      this.log.warn(`[${this.label}] Socket timeout after ${this.idleTimeout / 1000}s of silence`);
      this.socket?.destroy();
    });

    // Detect a peer that has gone away without relying on inbound traffic, so
    // the idle timeout above is not the only liveness check.
    this.socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY);
    if (this.idleTimeout > 0) {
      this.socket.setTimeout(this.idleTimeout);
    }
    this.socket.connect(this.port, this.host);
  }

  write(data: string): void {
    if (!this._connected || !this.socket) {
      throw new Error(`[${this.label}] Not connected`);
    }
    this.socket.write(data + '\r\n');
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) {
      return;
    }

    this.log.info(`[${this.label}] Reconnecting in ${this.reconnectDelay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_FACTOR,
      MAX_RECONNECT_DELAY,
    );
  }
}
