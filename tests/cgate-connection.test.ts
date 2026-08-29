import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CGateConnection } from '../src/cgate/CGateConnection.js';
import { FakeCGate, delay } from './helpers/fake-cgate.js';
import { createFakeLog } from './helpers/fake-homebridge.js';

/**
 * Capture anything thrown at the process rather than letting it kill the run.
 *
 * Node rethrows an EventEmitter 'error' that has no listener, which is exactly
 * how the plugin used to die. Installing a listener here means the test can
 * assert on the crash instead of being killed by it.
 */
function captureUncaught(): { errors: Error[]; restore: () => void } {
  const errors: Error[] = [];
  const existing = process.listeners('uncaughtException');
  for (const listener of existing) {
    process.off('uncaughtException', listener);
  }
  const handler = (err: Error): void => {
    errors.push(err);
  };
  process.on('uncaughtException', handler);

  return {
    errors,
    restore: () => {
      process.off('uncaughtException', handler);
      for (const listener of existing) {
        process.on('uncaughtException', listener);
      }
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await delay(25);
  }
}

describe('CGateConnection', () => {
  let server: FakeCGate;

  before(async () => {
    server = await FakeCGate.create();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.commandConnectionCount = 0;
  });

  it('survives repeated connection failures without throwing at the process', async () => {
    // The regression. connectPort() used to attach its error listener with
    // once(), so the first failure consumed it and the second reached an
    // EventEmitter with no 'error' listener — which Node rethrows, killing the
    // child bridge. Homebridge restarted it, it died the same way, and after
    // five attempts Homebridge stopped restarting it altogether.
    const capture = captureUncaught();
    const log = createFakeLog();
    // Port 1 is reserved and unbindable, so every attempt is refused promptly.
    const conn = new CGateConnection('127.0.0.1', 1, 'CMD', log, 0);

    try {
      conn.connect();
      // Long enough for the initial attempt plus the first backoff retry (~2s),
      // which is the second failure that used to be fatal.
      await delay(3500);

      assert.deepEqual(capture.errors, [], 'a failed reconnect must not reach the process');
      assert.ok(
        log.lines.filter((line) => line.includes('Socket error')).length >= 2,
        `expected at least two logged socket errors, got: ${log.lines.join(' | ')}`,
      );
    } finally {
      conn.disconnect();
      capture.restore();
    }
  });

  it('reconnects after the peer goes away and comes back', async () => {
    const log = createFakeLog();
    const conn = new CGateConnection('127.0.0.1', server.commandPort, 'CMD', log, 0);

    let connects = 0;
    conn.on('connected', () => {
      connects++;
    });

    try {
      conn.connect();
      await waitFor(() => connects === 1);

      server.dropConnections();
      await waitFor(() => connects === 2, 15_000);

      assert.equal(conn.connected, true);
    } finally {
      conn.disconnect();
    }
  });

  it('does not start a second reconnect chain when connect is called repeatedly', async () => {
    // A late 'close' from a socket that had already been replaced used to
    // schedule its own reconnect, and each of those kept spawning more.
    const log = createFakeLog();
    const conn = new CGateConnection('127.0.0.1', server.commandPort, 'CMD', log, 0);

    let connects = 0;
    conn.on('connected', () => {
      connects++;
    });

    try {
      conn.connect();
      conn.connect();
      conn.connect();
      await waitFor(() => connects >= 1);
      await delay(3000);

      assert.equal(connects, 1, 'only the surviving socket should report connected');
      assert.equal(server.commandConnectionCount, 1, 'exactly one connection should reach the server');
    } finally {
      conn.disconnect();
    }
  });

  it('stops reconnecting once disconnected', async () => {
    const log = createFakeLog();
    const conn = new CGateConnection('127.0.0.1', server.commandPort, 'CMD', log, 0);

    conn.connect();
    await waitFor(() => conn.connected);
    conn.disconnect();

    server.commandConnectionCount = 0;
    await delay(3000);

    assert.equal(conn.connected, false);
    assert.equal(server.commandConnectionCount, 0, 'a disconnected port must not come back');
  });

  it('reset() recycles a socket that is connected but unusable', async () => {
    // The way back for a port that is up at the TCP level but wedged at the
    // protocol level — a handshake that failed, say.
    const log = createFakeLog();
    const conn = new CGateConnection('127.0.0.1', server.commandPort, 'CMD', log, 0);

    let connects = 0;
    conn.on('connected', () => {
      connects++;
    });

    try {
      conn.connect();
      await waitFor(() => connects === 1);

      conn.reset();
      assert.equal(conn.connected, false, 'reset drops the connection immediately');

      await waitFor(() => connects === 2, 15_000);
    } finally {
      conn.disconnect();
    }
  });
});
