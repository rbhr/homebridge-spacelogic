import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { Characteristic, Service } from 'hap-nodejs';

import { SpaceLogicPlatform } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { FakeCGate, delay } from './helpers/fake-cgate.js';
import { FakeHomebridgeAPI, createFakeLog, writeTempConfig } from './helpers/fake-homebridge.js';

const OVERRIDES = [
  { address: '254/56/1', type: 'dimmer', name: 'Kitchen', enabled: true },
  { address: '254/56/2', type: 'dimmer', name: 'Hallway', enabled: true },
];

interface Harness {
  platform: SpaceLogicPlatform;
  api: FakeHomebridgeAPI;
  log: ReturnType<typeof createFakeLog>;
  start: () => void;
  stop: () => void;
}

function makePlatform(server: FakeCGate): Harness {
  const cgate = {
    host: '127.0.0.1',
    commandPort: server.commandPort,
    eventPort: server.eventPort,
    scpPort: server.scpPort,
    project: 'TESTPROJ',
    network: 254,
  };

  const configPath = writeTempConfig(OVERRIDES, cgate);
  const api = new FakeHomebridgeAPI(configPath);
  const log = createFakeLog();
  const config = {
    platform: PLATFORM_NAME,
    name: 'SpaceLogic',
    cgate,
    groupOverrides: OVERRIDES,
  } as unknown as PlatformConfig;

  const platform = new SpaceLogicPlatform(log, config, api.asAPI());

  return {
    platform,
    api,
    log,
    start: () => api.emit('didFinishLaunching'),
    stop: () => api.emit('shutdown'),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await delay(25);
  }
}

function onValue(accessory: PlatformAccessory, expectMissing = false): boolean {
  const service = (accessory as unknown as FakeAccessoryShape).getService(Service.Lightbulb);
  if (!service) {
    if (expectMissing) {
      return false;
    }
    throw new Error(`No Lightbulb service on ${accessory.displayName}`);
  }
  return service.getCharacteristic(Characteristic.On).value === true;
}

interface FakeAccessoryShape {
  getService(target: unknown): Service | undefined;
}

function findAccessory(api: FakeHomebridgeAPI, name: string): PlatformAccessory {
  const found = api.registered.find((accessory) => accessory.displayName === name);
  assert.ok(found, `expected an accessory named ${name}, saw ${api.registered.map((a) => a.displayName).join(', ')}`);
  return found;
}

/** Node kills the process on an unhandled 'error'; capture it so we can assert instead. */
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

describe('platform recovery', () => {
  it('reconnects and resynchronises when C-Gate drops mid-run', { timeout: 90_000 }, async () => {
    // Scenario one from the field report: the C-Gate host went away and the
    // child bridge died with an unhandled ECONNREFUSED, restarted, died again,
    // and after five attempts Homebridge stopped restarting it.
    const capture = captureUncaught();
    const server = await FakeCGate.create({ levels: new Map([['254/56/1', 0], ['254/56/2', 0]]) });
    const harness = makePlatform(server);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length === 2, 30_000, 'initial discovery');

      const kitchen = findAccessory(harness.api, 'Kitchen');
      assert.equal(onValue(kitchen), false, 'starts off');

      // The light is switched on while the plugin is blind to it. Those SCP
      // events are gone for good, so only a resync can recover the true state.
      server.options.levels?.set('254/56/1', 255);
      server.dropConnections();

      await waitFor(
        () => harness.log.lines.some((line) => line.includes('Resynchronised')),
        60_000,
        'a resync after reconnect',
      );

      assert.equal(onValue(kitchen), true, 'state missed during the outage must be recovered');
      assert.deepEqual(capture.errors, [], 'an outage must not reach the process');
      assert.equal(harness.api.registered.length, 2, 'reconnecting must not re-register accessories');
    } finally {
      harness.stop();
      await server.stop();
      capture.restore();
    }
  });

  it('discovers when C-Gate appears, having been down at startup', { timeout: 90_000 }, async () => {
    // Scenario two: C-Gate unreachable at startup used to be terminal, because
    // bootstrap() returned on the first failure and nothing ever retried.
    const capture = captureUncaught();
    const server = await FakeCGate.create();
    // Keep the ports, take the server away.
    await server.stop();

    const harness = makePlatform(server);

    try {
      harness.start();
      await delay(3000);
      assert.equal(harness.api.registered.length, 0, 'nothing to discover yet');
      assert.deepEqual(capture.errors, [], 'an absent C-Gate must not crash the bridge');

      await server.start();
      await waitFor(() => harness.api.registered.length === 2, 60_000, 'discovery once C-Gate appears');
      assert.deepEqual(capture.errors, []);
    } finally {
      harness.stop();
      await server.stop();
      capture.restore();
    }
  });

  it('keeps retrying, and eventually discovers, when the project will not load', { timeout: 90_000 }, async () => {
    // Scenario three: the handshake failing left the port TCP-connected but
    // permanently unusable, with the failure logged once and then abandoned.
    const capture = captureUncaught();
    const server = await FakeCGate.create({ projectLoads: false });
    const harness = makePlatform(server);

    try {
      harness.start();
      await waitFor(
        () => server.commands.filter((cmd) => cmd.startsWith('PROJECT USE')).length >= 2,
        30_000,
        'a retried handshake',
      );
      assert.equal(harness.api.registered.length, 0, 'discovery must not run against a project that never loaded');
      assert.ok(
        !server.commands.some((cmd) => cmd.startsWith('DBGETXML')),
        'discovery must not be attempted before the project loads',
      );

      server.options.projectLoads = true;
      await waitFor(() => harness.api.registered.length === 2, 60_000, 'discovery after the project loads');
      assert.deepEqual(capture.errors, []);
    } finally {
      harness.stop();
      await server.stop();
      capture.restore();
    }
  });

  it('never switches an accessory off because a resync read failed', { timeout: 90_000 }, async () => {
    // tryGetLevel returns null rather than 0 for a failed read. Folding the two
    // together would turn every light off in the Home app during a partial resync.
    const server = await FakeCGate.create({ levels: new Map([['254/56/1', 255], ['254/56/2', 255]]) });
    const harness = makePlatform(server);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length === 2, 30_000, 'initial discovery');

      const kitchen = findAccessory(harness.api, 'Kitchen');
      await waitFor(() => onValue(kitchen), 15_000, 'the initial level to be seeded');

      // Now make the read fail rather than return a level.
      server.options.virtualGroups?.add('254/56/1');
      server.dropConnections();

      await waitFor(
        () => harness.log.lines.some((line) => line.includes('Resynchronised')),
        60_000,
        'a resync after reconnect',
      );

      assert.equal(onValue(kitchen), true, 'a failed read must leave the accessory alone');
    } finally {
      harness.stop();
      await server.stop();
    }
  });

  it('runs discovery once and only resynchronises on later reconnects', { timeout: 90_000 }, async () => {
    // Re-running discovery on every reconnect would rewrite config.json and
    // re-drive accessory reconciliation for no gain.
    const server = await FakeCGate.create();
    const harness = makePlatform(server);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length === 2, 30_000, 'initial discovery');
      const discoveries = (): number => server.commands.filter((cmd) => cmd.startsWith('DBGETXML')).length;
      assert.equal(discoveries(), 1);

      server.dropConnections();
      await waitFor(
        () => harness.log.lines.some((line) => line.includes('Resynchronised')),
        60_000,
        'a resync after reconnect',
      );

      assert.equal(discoveries(), 1, 'a reconnect must not re-run discovery');
      assert.equal(harness.api.unregistered.length, 0, 'no accessory should ever be removed here');
    } finally {
      harness.stop();
      await server.stop();
    }
  });
});
