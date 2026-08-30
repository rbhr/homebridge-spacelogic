import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { Characteristic, Service } from 'hap-nodejs';

import { SpaceLogicPlatform } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { FakeCGate, delay } from './helpers/fake-cgate.js';
import { FakeHomebridgeAPI, createFakeLog, writeTempConfig } from './helpers/fake-homebridge.js';

/** One group per accessory type that carries a level rather than just on/off. */
const LEVELLED_XML = [
  '<Network><TagName>Test Net</TagName><Address>254</Address>',
  '<Application><TagName>Lighting</TagName><Address>56</Address>',
  '<Group><TagName>Kitchen</TagName><Address>1</Address></Group>',
  '<Group><TagName>Ceiling Fan</TagName><Address>2</Address></Group>',
  '<Group><TagName>Blind</TagName><Address>3</Address></Group>',
  '</Application></Network>',
].join('');

const OVERRIDES = [
  { address: '254/56/1', type: 'dimmer', name: 'Kitchen', enabled: true },
  { address: '254/56/2', type: 'fan', name: 'Ceiling Fan', enabled: true },
  { address: '254/56/3', type: 'cover', name: 'Blind', enabled: true, options: { travelTime: 1 } },
];

interface Harness {
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

  new SpaceLogicPlatform(log, config, api.asAPI());

  return {
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

function findAccessory(api: FakeHomebridgeAPI, name: string): PlatformAccessory {
  const found = api.registered.find((accessory) => accessory.displayName === name);
  assert.ok(found, `expected an accessory named ${name}, saw ${api.registered.map((a) => a.displayName).join(', ')}`);
  return found;
}

function serviceOf(accessory: PlatformAccessory, target: unknown): Service {
  const shape = accessory as unknown as { getService(t: unknown): Service | undefined };
  const service = shape.getService(target);
  assert.ok(service, `no such service on ${accessory.displayName}`);
  return service;
}

function valueOf(service: Service, characteristic: unknown): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return service.getCharacteristic(characteristic as any).value as number;
}

/**
 * C-Gate reports an SCP ramp on the native C-Bus scale, 0-255. Treating that as
 * a percentage and scaling it again turned a 50% ramp into 128 -> 326, so the
 * brightness derived from it came back as 128: over HomeKit's maximum of 100,
 * rejected with a characteristic warning, and the slider snapped to 100 while
 * the light itself sat at 50. Everything that reads event.level is on the hook
 * for the same mistake, so all three levelled accessories are checked here.
 */
describe('SCP level scaling', () => {
  it('takes a ramp event as a native level, not a percentage', async () => {
    const server = await FakeCGate.create({ xml: LEVELLED_XML });
    const harness = makePlatform(server);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length === 3, 30_000, 'discovery');

      const light = serviceOf(findAccessory(harness.api, 'Kitchen'), Service.Lightbulb);

      // 128 is what the plugin itself sends for 50%: round(50 * 255 / 100).
      server.pushScp('lighting ramp //TESTPROJ/254/56/1 128 #sourceunit=8');
      await waitFor(
        () => valueOf(light, Characteristic.Brightness) > 0,
        10_000,
        'the ramp to reach the dimmer',
      );

      assert.equal(valueOf(light, Characteristic.Brightness), 50, 'a ramp to 128/255 is 50% brightness');
      assert.equal(light.getCharacteristic(Characteristic.On).value, true);

      // And the endpoints still land where they should.
      server.pushScp('lighting on //TESTPROJ/254/56/1 #sourceunit=8');
      await waitFor(
        () => valueOf(light, Characteristic.Brightness) === 100,
        10_000,
        'an on event to reach full brightness',
      );

      server.pushScp('lighting off //TESTPROJ/254/56/1 #sourceunit=8');
      await waitFor(
        () => light.getCharacteristic(Characteristic.On).value === false,
        10_000,
        'an off event to switch the dimmer off',
      );
      assert.equal(valueOf(light, Characteristic.Brightness), 0);
    } finally {
      harness.stop();
      await server.stop();
    }
  });

  it('scales a ramp event down for a fan and a cover too', async () => {
    const server = await FakeCGate.create({ xml: LEVELLED_XML });
    const harness = makePlatform(server);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length === 3, 30_000, 'discovery');

      const fan = serviceOf(findAccessory(harness.api, 'Ceiling Fan'), Service.Fanv2);
      const cover = serviceOf(findAccessory(harness.api, 'Blind'), Service.WindowCovering);

      server.pushScp('lighting ramp //TESTPROJ/254/56/2 128 #sourceunit=8');
      server.pushScp('lighting ramp //TESTPROJ/254/56/3 128 #sourceunit=8');

      await waitFor(
        () => valueOf(fan, Characteristic.RotationSpeed) > 0,
        10_000,
        'the ramp to reach the fan',
      );
      assert.equal(valueOf(fan, Characteristic.RotationSpeed), 50);
      assert.equal(valueOf(fan, Characteristic.Active), 1);

      assert.equal(valueOf(cover, Characteristic.TargetPosition), 50);
      // travelTime is 1s, so the simulated travel settles well inside the wait.
      await waitFor(
        () => valueOf(cover, Characteristic.CurrentPosition) === 50,
        10_000,
        'the cover to finish travelling',
      );
    } finally {
      harness.stop();
      await server.stop();
    }
  });

  it('converts the whole level range the same way in both directions', async () => {
    // Asserting only that the result is within HomeKit's range would prove
    // nothing: hap-nodejs clamps an out-of-range update after warning about it,
    // so the bad value reads back as a perfectly legal 100. The exact figure is
    // the only thing that separates a correct conversion from a clamped one.
    const server = await FakeCGate.create({ xml: LEVELLED_XML });
    const harness = makePlatform(server);

    try {
      harness.start();
      await waitFor(() => harness.api.registered.length === 3, 30_000, 'discovery');

      const light = serviceOf(findAccessory(harness.api, 'Kitchen'), Service.Lightbulb);
      const fan = serviceOf(findAccessory(harness.api, 'Ceiling Fan'), Service.Fanv2);

      for (const level of [1, 64, 128, 200, 254, 255]) {
        server.pushScp(`lighting ramp //TESTPROJ/254/56/1 ${level} #sourceunit=8`);
        server.pushScp(`lighting ramp //TESTPROJ/254/56/2 ${level} #sourceunit=8`);
        await delay(50);

        const expected = Math.round(level * 100 / 255);
        assert.equal(valueOf(light, Characteristic.Brightness), expected, `brightness for level ${level}`);
        assert.equal(valueOf(fan, Characteristic.RotationSpeed), expected, `rotation speed for level ${level}`);
      }
    } finally {
      harness.stop();
      await server.stop();
    }
  });
});
