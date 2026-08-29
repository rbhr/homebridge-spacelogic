import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as hapNodeJs from 'hap-nodejs';
import { Characteristic, HapStatusError, Service, uuid } from 'hap-nodejs';

// HAPStatus is declared as a const enum, so it cannot be referenced as a value
// in TypeScript even though hap-nodejs does emit it at runtime. The accessories
// read it off api.hap, so the fake has to carry the real object.
const HAPStatus = (hapNodeJs as unknown as { HAPStatus: Record<string, number> }).HAPStatus;
import type { API, Logging, PlatformAccessory } from 'homebridge';

import { PLATFORM_NAME } from '../../src/settings.js';

/**
 * Enough of Homebridge to run the platform for real.
 *
 * Deliberately backed by the genuine hap-nodejs Service and Characteristic
 * classes rather than stubs: the accessories set real characteristics, and a
 * stub that silently accepted anything would let a broken resync pass.
 */
export class FakePlatformAccessory {
  readonly services: Service[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: Record<string, any> = {};

  constructor(public displayName: string, public UUID: string) {
    this.services.push(new Service.AccessoryInformation());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getService(target: any): Service | undefined {
    if (typeof target === 'string') {
      return this.services.find((service) => service.displayName === target);
    }
    return this.services.find((service) => service.UUID === target.UUID && !service.subtype);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addService(serviceType: any, ...args: any[]): Service {
    const service = serviceType instanceof Service ? serviceType : new serviceType(...args);
    this.services.push(service);
    return service;
  }

  removeService(service: Service): void {
    const index = this.services.indexOf(service);
    if (index !== -1) {
      this.services.splice(index, 1);
    }
  }
}

export class FakeHomebridgeAPI extends EventEmitter {
  readonly hap = { Service, Characteristic, uuid, HapStatusError, HAPStatus };
  readonly platformAccessory = FakePlatformAccessory;
  readonly user: { configPath: () => string };

  readonly registered: PlatformAccessory[] = [];
  readonly unregistered: PlatformAccessory[] = [];
  readonly updated: PlatformAccessory[] = [];

  constructor(public readonly configPath: string) {
    super();
    // Homebridge itself allows many listeners on the API object; the default of
    // 10 would print warnings that look like leaks during longer tests.
    this.setMaxListeners(50);
    this.user = { configPath: () => this.configPath };
  }

  registerPlatformAccessories(_plugin: string, _platform: string, accessories: PlatformAccessory[]): void {
    this.registered.push(...accessories);
  }

  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: PlatformAccessory[]): void {
    this.unregistered.push(...accessories);
  }

  updatePlatformAccessories(accessories: PlatformAccessory[]): void {
    this.updated.push(...accessories);
  }

  asAPI(): API {
    return this as unknown as API;
  }
}

export interface FakeLog extends Logging {
  /** Every line logged, prefixed with its level, for assertions. */
  readonly lines: string[];
}

export function createFakeLog(echo = process.env.TEST_LOG === '1'): FakeLog {
  const lines: string[] = [];

  const record = (level: string) => (message: unknown, ...parameters: unknown[]): void => {
    const text = `${level}: ${String(message)}${parameters.length ? ` ${parameters.map(String).join(' ')}` : ''}`;
    lines.push(text);
    if (echo) {
      process.stderr.write(`${text}\n`);
    }
  };

  const log = record('info') as unknown as FakeLog;
  Object.assign(log, {
    lines,
    prefix: 'test',
    info: record('info'),
    success: record('success'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    log: (level: string, message: unknown, ...parameters: unknown[]) => record(level)(message, ...parameters),
  });
  return log;
}

/**
 * Write a throwaway config.json holding our platform block.
 *
 * The platform appends newly discovered groups to config.json as disabled
 * overrides, so every test needs a real file it is allowed to rewrite.
 */
export function writeTempConfig(overrides: unknown[], cgate: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'spacelogic-test-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    bridge: { name: 'Test', username: 'CC:22:3D:E3:CE:30', port: 51826, pin: '031-45-154' },
    accessories: [],
    platforms: [{ platform: PLATFORM_NAME, name: 'SpaceLogic', cgate, groupOverrides: overrides }],
  }, null, 2));
  return configPath;
}
