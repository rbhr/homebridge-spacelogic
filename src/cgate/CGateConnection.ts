import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { Logging } from 'homebridge';

import { CMD_BUFFER_LIMIT, DEFAULT_IDLE_TIMEOUT, TCP_KEEPALIVE_DELAY } from './types.js';

const INITIAL_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 60000;
const RECONNECT_BACKOFF_FACTOR = 2;
const RECONNECT_JITTER_FRACTION = 0.2;

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

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Drop any previous socket first. Its handlers are still live otherwise, and
    // a late 'close' from it would schedule a second, parallel reconnect chain
    // for this port — each of which keeps spawning more.
    this.teardownSocket();

    this.log.debug(`[${this.label}] Connecting to ${this.host}:${this.port}`);

    const socket = new Socket();
    this.socket = socket;
    this.buffer = '';

    // Events from a socket we have already replaced must not touch our state.
    const isCurrent = (): boolean => this.socket === socket;

    socket.on('connect', () => {
      if (!isCurrent()) {
        return;
      }
      this.log.info(`[${this.label}] Connected to ${this.host}:${this.port}`);
      this._connected = true;
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      this.emit('connected');
    });

    socket.on('data', (data: Buffer) => {
      if (!isCurrent()) {
        return;
      }
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

    socket.on('close', () => {
      if (!isCurrent()) {
        return;
      }
      this.socket = null;
      this.log.debug(`[${this.label}] Connection closed`);
      const wasConnected = this._connected;
      this._connected = false;
      if (wasConnected) {
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      if (!isCurrent()) {
        return;
      }
      this.log.error(`[${this.label}] Socket error: ${err.message}`);
      // Only emit when somebody is actually listening. An EventEmitter 'error'
      // with no listener is rethrown by Node and takes the whole bridge process
      // down — which is what used to happen on the second network failure, since
      // the one-shot listener that used to be here was consumed by the first.
      // Nothing is lost by swallowing it: a socket error is always followed by
      // 'close', and 'close' drives the reconnect.
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
    });

    socket.on('timeout', () => {
      if (!isCurrent()) {
        return;
      }
      this.log.warn(`[${this.label}] Socket timeout after ${this.idleTimeout / 1000}s of silence`);
      socket.destroy();
    });

    // Detect a peer that has gone away without relying on inbound traffic, so
    // the idle timeout above is not the only liveness check.
    socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY);
    if (this.idleTimeout > 0) {
      socket.setTimeout(this.idleTimeout);
    }

    try {
      socket.connect(this.port, this.host);
    } catch (err) {
      // connect() can throw synchronously when the host is unresolvable or the
      // network stack refuses the call outright. Treat it exactly like an async
      // failure so the backoff keeps running instead of the port dying here.
      this.log.error(`[${this.label}] Connect failed: ${err instanceof Error ? err.message : err}`);
      this.socket = null;
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      this.scheduleReconnect();
    }
  }

  write(data: string): void {
    if (!this._connected || !this.socket) {
      throw new Error(`[${this.label}] Not connected`);
    }
    this.socket.write(data + '\r\n');
  }

  /**
   * Recycle the socket and let the backoff bring it back.
   *
   * For a port that is up at the TCP level but unusable at the protocol level —
   * the C-Gate handshake failed, say — closing it is the only way back into the
   * normal reconnect path, which is the one piece of code that knows how to
   * retry forever.
   */
  reset(): void {
    if (this.destroyed) {
      return;
    }

    const hadSocket = this.socket !== null;
    const wasConnected = this._connected;
    this._connected = false;
    this.teardownSocket();

    if (wasConnected) {
      this.emit('disconnected');
    }
    if (hadSocket || !this.reconnectTimer) {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    this._connected = false;
  }

  private teardownSocket(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = null;
    socket.removeAllListeners();
    // destroy() can surface a pending error, and a socket with no 'error'
    // listener throws it at the process. Keep a sink attached.
    socket.on('error', () => {});
    socket.destroy();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) {
      return;
    }

    // Spread the three ports out a little so they do not all hammer C-Gate in
    // the same millisecond after an outage.
    const jitter = Math.round(this.reconnectDelay * RECONNECT_JITTER_FRACTION * Math.random());
    const delay = this.reconnectDelay + jitter;

    this.log.info(`[${this.label}] Reconnecting in ${Math.round(delay / 100) / 10}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_FACTOR,
      MAX_RECONNECT_DELAY,
    );
  }
}
