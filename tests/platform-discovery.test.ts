import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { Characteristic, Service } from 'hap-nodejs';

import { SpaceLogicPlatform } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import type { GroupOverride } from '../src/cgate/types.js';
import { FakeCGate, delay } from './helpers/fake-cgate.js';
import { FakeHomebridgeAPI, createFakeLog, writeTempConfig } from './helpers/fake-homebridge.js';

/**
 * One lighting group and one measurement device, which is the combination the
 * two addressing schemes meet on.
 */
const MIXED_XML = [
  '<Network><TagName>Test Net</TagName><Address>254</Address>',
  '<Application><TagName>Lighting</TagName><Address>56</Address>',
  '<Group><TagName>Kitchen</TagName><Address>1</Address></Group>',
  '</Application>',
  '<Application><TagName>Measurement</TagName><Address>228</Address>',
  '<Group><TagName>Sensor Unit</TagName><Address>22</Address></Group>',
  '</Application></Network>',
].join('');

interface Harness {
  platform: SpaceLogicPlatform;
  api: FakeHomebridgeAPI;
  log: ReturnType<typeof createFakeLog>;
  configPath: string;
  start: () => void;
  stop: () => void;
}

function makePlatform(server: FakeCGate, overrides: unknown[]): Harness {
  const cgate = {
    host: '127.0.0.1',
    commandPort: server.commandPort,
    eventPort: server.eventPort,
    scpPort: server.scpPort,
    project: 'TESTPROJ',
    network: 254,
  };

  const configPath = writeTempConfig(overrides, cgate);
  const api = new FakeHomebridgeAPI(configPath);
  const log = createFakeLog();
  const config = {
    platform: PLATFORM_NAME,
    name: 'SpaceLogic',
    cgate,
    groupOverrides: overrides,
  } as unknown as PlatformConfig;

  const platform = new SpaceLogicPlatform(log, config, api.asAPI());

  return {
    platform,
    api,
    log,
    configPath,
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

function savedOverrides(configPath: string): GroupOverride[] {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const platform = config.platforms.find((p: { platform: string }) => p.platform === PLATFORM_NAME);
  return platform.groupOverrides as GroupOverride[];
}

function serialNumber(accessory: PlatformAccessory): string {
  const shape = accessory as unknown as { getService(target: unknown): Service | undefined };
  const info = shape.getService(Service.AccessoryInformation)!;
  return info.getCharacteristic(Characteristic.SerialNumber).value as string;
}

describe('discovery and group overrides', () => {
  it('does not re-add a measurement device that a channelled override already covers', async () => {
    // The two are keyed differently — the sensor by address *and* channel, the
    // discovered device by address alone — so the device used to look unseen and
    // get appended to config.json as a new disabled group on every fresh install.
    const server = await FakeCGate.create({ xml: MIXED_XML });
    const harness = makePlatform(server, [
      { address: '254/228/22', type: 'temperatureSensor', name: 'Kitchen Temp', channel: 1, enabled: true },
    ]);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length > 0, 15_000, 'the temperature sensor to register');
      // Let the config write for the unconfigured lighting group land.
      await waitFor(
        () => savedOverrides(harness.configPath).some((o) => o.address === '254/56/1'),
        15_000,
        'the new lighting group to be written to config.json',
      );

      const written = savedOverrides(harness.configPath);
      const forSensor = written.filter((o) => o.address === '254/228/22');
      assert.equal(
        forSensor.length,
        1,
        `expected only the configured override for 254/228/22, got ${JSON.stringify(forSensor)}`,
      );
      assert.equal(forSensor[0].channel, 1, 'the surviving override should be the user\'s, channel and all');
    } finally {
      harness.stop();
      await server.stop();
    }
  });

  it('gives a temperature sensor its plain address and routes events by channel', async () => {
    const server = await FakeCGate.create({ xml: MIXED_XML });
    const harness = makePlatform(server, [
      { address: '254/228/22', type: 'temperatureSensor', name: 'Kitchen Temp', channel: 1, enabled: true },
    ]);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length > 0, 15_000, 'the temperature sensor to register');

      const accessory = harness.api.registered[0];
      assert.equal(accessory.displayName, 'Kitchen Temp');
      // The composite handler key must not leak into the accessory's identity.
      assert.equal(serialNumber(accessory), '254/228/22');

      // 215 x 10^-1 = 21.5 degrees.
      server.pushScp('measurement data //TESTPROJ/254/228/22/1 215 -1 0');

      const shape = accessory as unknown as { getService(target: unknown): Service | undefined };
      const sensor = shape.getService(Service.TemperatureSensor)!;
      await waitFor(
        () => sensor.getCharacteristic(Characteristic.CurrentTemperature).value === 21.5,
        10_000,
        'the measurement event to reach the sensor',
      );
    } finally {
      harness.stop();
      await server.stop();
    }
  });

  it('defaults a lighting override with no type to a dimmer', async () => {
    // Dropping these made the group vanish from HomeKit with nothing in the log,
    // which is indistinguishable from it having gone from C-Bus.
    const server = await FakeCGate.create({ xml: MIXED_XML });
    const harness = makePlatform(server, [
      { address: '254/56/1', name: 'Kitchen', enabled: true },
    ]);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length > 0, 15_000, 'the untyped group to register');

      const accessory = harness.api.registered[0];
      assert.equal(accessory.displayName, 'Kitchen');
      const shape = accessory as unknown as { getService(target: unknown): Service | undefined };
      assert.ok(shape.getService(Service.Lightbulb), 'expected a Lightbulb, the dimmer service');
    } finally {
      harness.stop();
      await server.stop();
    }
  });

  it('defaults an untyped measurement address to a temperature sensor', async () => {
    const server = await FakeCGate.create({ xml: MIXED_XML });
    const harness = makePlatform(server, [
      { address: '254/228/22', name: 'Sensor Unit', enabled: true },
    ]);

    try {
      harness.start();
      // No channel, so it registers but can never be updated — and says so.
      await waitFor(
        () => harness.log.lines.some((line) => line.includes('has no "channel"')),
        15_000,
        'the channel-less sensor to be reported',
      );

      const accessory = harness.api.registered[0];
      const shape = accessory as unknown as { getService(target: unknown): Service | undefined };
      assert.ok(shape.getService(Service.TemperatureSensor), 'app 228 should default to a temperature sensor');
    } finally {
      harness.stop();
      await server.stop();
    }
  });

  it('ignores an override with no address at all', async () => {
    const server = await FakeCGate.create({ xml: MIXED_XML });
    const harness = makePlatform(server, [{ name: 'Nowhere', enabled: true }]);

    try {
      harness.start();
      await waitFor(
        () => harness.log.lines.some((line) => line.includes('Ignoring group override with no address')),
        15_000,
        'the addressless override to be reported',
      );
    } finally {
      harness.stop();
      await server.stop();
    }
  });
});
