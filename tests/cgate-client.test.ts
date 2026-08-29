import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CGateClient } from '../src/cgate/CGateClient.js';
import type { CGateConfig } from '../src/cgate/types.js';
import { FakeCGate, delay } from './helpers/fake-cgate.js';
import { createFakeLog } from './helpers/fake-homebridge.js';

function configFor(server: FakeCGate): CGateConfig {
  return {
    host: '127.0.0.1',
    commandPort: server.commandPort,
    eventPort: server.eventPort,
    scpPort: server.scpPort,
    project: 'TESTPROJ',
    network: 254,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await delay(25);
  }
}

describe('CGateClient', () => {
  it('becomes ready and re-subscribes the event port after a reconnect', async () => {
    // The event port needs its EVENT subscription re-sent on every connect. If
    // it were only sent once, a reconnected plugin would look healthy while
    // silently receiving nothing.
    const server = await FakeCGate.create();
    const client = new CGateClient(configFor(server), createFakeLog());

    try {
      client.connect();
      await waitFor(() => client.ready, 15_000, 'client ready');
      await waitFor(() => server.eventPortLines.length === 1, 15_000, 'event subscription');
      assert.equal(server.eventPortLines[0], 'EVENT e5s1c1');

      server.dropConnections();
      await waitFor(() => client.ready === false, 15_000, 'client to notice the drop');
      await waitFor(() => client.ready, 20_000, 'client ready again');

      await waitFor(() => server.eventPortLines.length === 2, 15_000, 're-subscription');
      assert.deepEqual(server.eventPortLines, ['EVENT e5s1c1', 'EVENT e5s1c1']);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('keeps retrying the handshake when the project will not load', async () => {
    // A wrong project name leaves the socket connected but the port unusable.
    // Nothing else would drive a retry, and without a separate backoff the
    // retry would run as fast as the socket reconnects and flood the log.
    const server = await FakeCGate.create({ projectLoads: false });
    const client = new CGateClient(configFor(server), createFakeLog());

    const attempts = (): number => server.commands.filter((cmd) => cmd.startsWith('PROJECT USE')).length;

    try {
      client.connect();
      await waitFor(() => attempts() >= 2, 25_000, 'a second handshake attempt');
      assert.equal(client.ready, false, 'a failed handshake must not report ready');

      // Recovery must not need a restart: fix the project and it comes up.
      server.options.projectLoads = true;
      await waitFor(() => client.ready, 30_000, 'client to recover');
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('backs the handshake retry off rather than hammering it', async () => {
    const server = await FakeCGate.create({ projectLoads: false });
    const client = new CGateClient(configFor(server), createFakeLog());

    try {
      client.connect();
      await delay(8000);
      const attempts = server.commands.filter((cmd) => cmd.startsWith('PROJECT USE')).length;
      // Socket backoff resets on every TCP connect, so without the separate
      // handshake backoff this would retry roughly twice a second.
      assert.ok(attempts <= 4, `expected a backed-off retry, saw ${attempts} attempts in 8s`);
      assert.ok(attempts >= 2, `expected retries to continue, saw ${attempts}`);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('tryGetLevel separates a real zero from a failed read', async () => {
    // getLevel folds both onto 0. Using it to resynchronise would switch every
    // light off in HomeKit the moment a read failed.
    const server = await FakeCGate.create({
      levels: new Map([['254/56/1', 0], ['254/56/2', 255]]),
      virtualGroups: new Set(['254/56/9']),
    });
    const client = new CGateClient(configFor(server), createFakeLog());

    try {
      client.connect();
      await waitFor(() => client.ready, 15_000, 'client ready');

      assert.equal(await client.tryGetLevel('254/56/1'), 0, 'a group at zero reads as 0');
      assert.equal(await client.tryGetLevel('254/56/2'), 255);
      assert.equal(await client.tryGetLevel('254/56/9'), null, 'a failed read is null, not 0');

      // getLevel, still used for the initial seed, keeps its old behaviour.
      assert.equal(await client.getLevel('254/56/2'), 255);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('fails queued commands promptly during an outage', async () => {
    // Queued commands used to sit until their own 10s timeout, so a HomeKit
    // request made during an outage hung instead of erroring.
    const server = await FakeCGate.create();
    const client = new CGateClient(configFor(server), createFakeLog());

    try {
      client.connect();
      await waitFor(() => client.ready, 15_000, 'client ready');

      await server.stop();
      await waitFor(() => client.ready === false, 15_000, 'client to notice the outage');

      const started = Date.now();
      const results = await Promise.allSettled([
        client.turnOn('254/56/1'),
        client.turnOff('254/56/2'),
        client.ramp('254/56/3', 128),
      ]);
      const elapsed = Date.now() - started;

      assert.ok(results.every((r) => r.status === 'rejected'), 'commands must fail while C-Gate is away');
      assert.ok(elapsed < 3000, `expected prompt failure, took ${elapsed}ms`);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('reports discovery as a failure rather than an empty device list', async () => {
    // An empty list is indistinguishable from "every device was deleted" by the
    // time it reaches the platform, which would remove every accessory.
    const server = await FakeCGate.create({ xml: '' });
    const client = new CGateClient(configFor(server), createFakeLog());

    try {
      client.connect();
      await waitFor(() => client.ready, 15_000, 'client ready');
      await assert.rejects(() => client.discoverDevices());
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });

  it('parses discovered groups and drops the placeholders', async () => {
    const server = await FakeCGate.create();
    const client = new CGateClient(configFor(server), createFakeLog());

    try {
      client.connect();
      await waitFor(() => client.ready, 15_000, 'client ready');

      const devices = await client.discoverDevices();
      assert.deepEqual(
        devices.map((d) => d.addressString).sort(),
        ['254/56/1', '254/56/2'],
        'group 0, group 255 and <Unused> must be skipped',
      );
      assert.deepEqual(devices.map((d) => d.name).sort(), ['Hallway', 'Kitchen']);
    } finally {
      await client.disconnect();
      await server.stop();
    }
  });
});
