import { copyFileSync, existsSync, renameSync, statSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { CONFIG_WRITE_ATTEMPTS, MAX_REMOVAL_FRACTION, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { CGateClient } from './cgate/CGateClient.js';
import type {
  CBusDevice,
  CBusDeviceType,
  CGateConfig,
  DeviceContext,
  GroupOverride,
  ScpEvent,
  ScpLightingEvent,
} from './cgate/types.js';
import { CBUS_MEASUREMENT_APPLICATION } from './cgate/types.js';
import type { BaseAccessory } from './accessories/BaseAccessory.js';
import { createAccessory } from './accessories/AccessoryFactory.js';
import { HttpCommander } from './commander/HttpCommander.js';

/** How long to wait before re-attempting a discovery that failed while C-Gate stayed connected. */
const DISCOVERY_RETRY_DELAY = 60_000;

export class SpaceLogicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly accessoryHandlers: Map<string, BaseAccessory> = new Map();
  private readonly discoveredUUIDs: string[] = [];
  private httpCommander: HttpCommander | null = null;
  private discoveryComplete = false;
  private discoveryInFlight = false;
  private discoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;

  public cgateClient!: CGateClient;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Initializing SpaceLogic platform');

    this.api.on('didFinishLaunching', () => {
      this.bootstrap();
    });

    this.api.on('shutdown', () => {
      this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async bootstrap(): Promise<void> {
    const cgateConfig = this.getCGateConfig();
    if (!cgateConfig) {
      this.log.error('C-Gate configuration is missing or incomplete. Check your config.json.');
      return;
    }

    this.cgateClient = new CGateClient(cgateConfig, this.log);

    this.cgateClient.on('scpEvent', (event: ScpEvent) => this.handleScpEvent(event));

    // Everything downstream hangs off 'ready' rather than off a one-shot connect.
    // C-Gate being unreachable at startup is the same condition as C-Gate going
    // away later, so both are handled by waiting for the next successful
    // handshake instead of giving up on the first failure.
    this.cgateClient.on('ready', () => {
      this.onCGateReady(cgateConfig);
    });
    this.cgateClient.on('disconnected', () => {
      this.log.warn('C-Gate connection lost — accessories will stop responding until it is back. Retrying.');
    });

    // Start HTTP Commander if configured. It comes up regardless of C-Gate's
    // state so the console is available to diagnose an outage, not only after one
    // has cleared.
    const commanderPort = (this.config.commander?.port as number | undefined) ?? 0;
    if (commanderPort > 0) {
      this.httpCommander = new HttpCommander(commanderPort, this.cgateClient, this.log);
      this.httpCommander.start();
    }

    this.cgateClient.connect();
  }

  /**
   * Called on every successful C-Gate handshake, including reconnects.
   *
   * The first one that gets through runs discovery; later ones only resync device
   * state, since re-running discovery on every reconnect would rewrite
   * config.json and re-drive accessory reconciliation for no gain.
   */
  private async onCGateReady(cgateConfig: CGateConfig): Promise<void> {
    if (this.discoveryInFlight) {
      return;
    }
    this.discoveryInFlight = true;

    try {
      if (!this.discoveryComplete) {
        this.log.info('Connected to C-Gate server');
        await this.discoverDevices(cgateConfig);
        this.discoveryComplete = true;
      } else {
        this.log.info('Reconnected to C-Gate server — resynchronising device state');
        await this.refreshDeviceStates();
      }
    } catch (err) {
      const what = this.discoveryComplete ? 'state resynchronisation' : 'device discovery';
      this.log.error(`Failed during ${what}: ${err instanceof Error ? err.message : err}`);

      if (!this.discoveryComplete) {
        // Discovery failed, so we know nothing about what is present. Cached
        // accessories are left registered untouched — removing them would destroy
        // their HomeKit room and automation assignments over a transient fault.
        this.log.warn(`Keeping ${this.accessories.size} cached accessories registered until discovery succeeds.`);
        // A reconnect is not guaranteed to follow: C-Gate can stay happily
        // connected while DBGETXML fails. Without a timer this would be the one
        // path that never retries.
        this.scheduleDiscoveryRetry(cgateConfig);
      }
    } finally {
      this.discoveryInFlight = false;
    }
  }

  private scheduleDiscoveryRetry(cgateConfig: CGateConfig): void {
    if (this.discoveryRetryTimer) {
      return;
    }

    this.log.info(`Retrying discovery in ${DISCOVERY_RETRY_DELAY / 1000}s`);
    this.discoveryRetryTimer = setTimeout(() => {
      this.discoveryRetryTimer = null;
      if (this.discoveryComplete || !this.cgateClient.ready) {
        return;
      }
      this.onCGateReady(cgateConfig);
    }, DISCOVERY_RETRY_DELAY);
  }

  /**
   * Re-read every group's level after a reconnect.
   *
   * SCP events emitted while the socket was down are gone, so HomeKit is showing
   * whatever was true before the outage. Reads that fail are skipped rather than
   * treated as level 0, so a partial resync never switches accessories off in the
   * Home app.
   */
  private async refreshDeviceStates(): Promise<void> {
    // Driven off the handler map rather than the cached-accessory map: handlers
    // exist for accessories created during this run as well as restored ones, and
    // only a handler can actually push a value into HomeKit.
    const targets = [...this.accessoryHandlers.values()]
      .filter((handler) => handler.device && handler.device.type !== 'temperatureSensor');

    let refreshed = 0;
    for (const handler of targets) {
      const device = handler.device;
      const level = await this.cgateClient.tryGetLevel(device.address);
      if (level === null) {
        continue;
      }

      const event: ScpLightingEvent = {
        kind: 'lighting',
        action: 'ramp',
        project: '',
        network: device.network,
        application: device.application,
        group: device.group,
        level: Math.round(level * 100 / 255),
      };
      handler.handleLightingEvent(event);
      refreshed++;
    }

    this.log.info(`Resynchronised ${refreshed} of ${targets.length} accessories after reconnect`);
  }

  private shutdown(): void {
    this.log.info('Shutting down SpaceLogic platform');
    if (this.discoveryRetryTimer) {
      clearTimeout(this.discoveryRetryTimer);
      this.discoveryRetryTimer = null;
    }
    if (this.httpCommander) {
      this.httpCommander.stop();
      this.httpCommander = null;
    }
    if (this.cgateClient) {
      this.cgateClient.disconnect();
    }
  }

  private getCGateConfig(): CGateConfig | null {
    const cgate = this.config.cgate;
    if (!cgate || !cgate.host || !cgate.project) {
      return null;
    }

    return {
      host: cgate.host,
      commandPort: cgate.commandPort ?? 20023,
      eventPort: cgate.eventPort ?? 20024,
      scpPort: cgate.scpPort ?? 20025,
      project: cgate.project,
      network: cgate.network ?? 254,
    };
  }

  private async discoverDevices(cgateConfig: CGateConfig): Promise<void> {
    const devices = await this.cgateClient.discoverDevices();
    // A previous failed pass may have left entries behind; stale UUIDs here would
    // make reconcileRemovals spare accessories that are genuinely gone.
    this.discoveredUUIDs.length = 0;
    const overrides = this.getGroupOverrides();
    const maxAccessories = (this.config.maxAccessories as number | undefined) ?? 0;
    let count = 0;
    const seenAddresses = new Set<string>();
    const newAccessories: PlatformAccessory[] = [];
    const newOverrides: GroupOverride[] = [];

    this.log.info(`Discovery: ${devices.length} devices, ${this.accessories.size} cached, maxAccessories=${maxAccessories || 'unlimited'}`);

    for (const device of devices) {
      if (maxAccessories > 0 && count >= maxAccessories) {
        this.log.info(`Reached maxAccessories limit (${maxAccessories}), skipping remaining devices`);
        break;
      }

      // Skip duplicate addresses (can occur if XML has overlapping entries)
      if (seenAddresses.has(device.addressString)) {
        this.log.warn(`Skipping duplicate address: ${device.addressString} (${device.name})`);
        continue;
      }
      seenAddresses.add(device.addressString);

      const override = overrides.get(device.addressString);

      // Devices without a group override — create a disabled override in config
      if (!override) {
        this.log.info(`New device discovered: ${device.addressString} (${device.name}) — adding as disabled override`);
        newOverrides.push({
          address: device.addressString,
          type: device.address.application === CBUS_MEASUREMENT_APPLICATION ? 'temperatureSensor' : 'dimmer',
          name: device.name,
          enabled: false,
        });
        continue;
      }

      // Skip explicitly disabled devices
      if (override.enabled === false) {
        this.log.debug(`Skipping disabled device: ${device.addressString} (${device.name})`);
        continue;
      }

      const deviceType = this.resolveDeviceType(device, overrides);
      const displayName = this.sanitiseDisplayName(override.name || device.name);

      this.registerDevice(cgateConfig, device, deviceType, displayName, override, newAccessories);
      count++;
      this.fetchInitialLevel(device, deviceType);
    }

    // Register temperature sensor overrides (channel-based, not auto-discovered)
    this.registerTemperatureSensors(cgateConfig, overrides, newAccessories, maxAccessories, count);

    // Persist any newly discovered devices as disabled overrides in config.json
    if (newOverrides.length > 0) {
      this.appendOverridesToConfig(newOverrides);
    }

    // Batch-register all new accessories at once
    if (newAccessories.length > 0) {
      this.log.info(`Registering ${newAccessories.length} new accessories`);
      try {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
      } catch (err) {
        // Homebridge 2.0-beta has a known double-bridge bug where both Server and
        // BridgeService register event handlers for registerPlatformAccessories.
        // The first handler successfully bridges the accessories, but the second
        // handler throws when it tries to bridge them again. Safe to ignore.
        this.log.debug(`registerPlatformAccessories threw (expected in HB 2.0-beta): ${err instanceof Error ? err.message : err}`);
      }

      // Create handlers after registration
      for (const accessory of newAccessories) {
        const device = accessory.context.device as DeviceContext;
        const handler = createAccessory(this, accessory, device.type);
        // Temperature sensors with channels use network/app/device/channel as key
        const handlerKey = device.channel !== undefined
          ? `${device.network}/${device.application}/${device.group}/${device.channel}`
          : device.address;
        this.accessoryHandlers.set(handlerKey, handler);
      }
    }

    // Remove accessories no longer present in C-Bus
    this.reconcileRemovals(devices.length);
  }

  /**
   * Unregister cached accessories that discovery did not see again.
   *
   * Guarded, because removal is unrecoverable: HomeKit discards the accessory's
   * room, custom name, scene and automation assignments, and re-registering the
   * same UUID on a later restart does not restore them. A discovery result that
   * is empty or drastically smaller than the cache is far more likely to mean
   * C-Gate had a bad day (project not loaded, wrong host or project name) than
   * to mean the installation actually shrank, so in that case nothing is
   * removed and the reason is logged instead.
   */
  private reconcileRemovals(discoveredDeviceCount: number): void {
    const cachedCount = this.accessories.size;
    if (cachedCount === 0) {
      return;
    }

    if (discoveredDeviceCount === 0) {
      this.log.warn(
        `Discovery returned no devices but ${cachedCount} accessories are cached — skipping removal. `
        + 'Check the C-Gate host and project name; this is almost never devices actually disappearing.',
      );
      return;
    }

    const stale = [...this.accessories.values()].filter(
      (accessory) => !this.discoveredUUIDs.includes(accessory.UUID),
    );
    if (stale.length === 0) {
      return;
    }

    const limit = Math.max(1, Math.ceil(cachedCount * MAX_REMOVAL_FRACTION));
    if (stale.length > limit && this.config.allowBulkRemoval !== true) {
      this.log.warn(
        `Refusing to remove ${stale.length} of ${cachedCount} cached accessories in one pass (limit ${limit}). `
        + 'Removal destroys HomeKit room, scene and automation assignments, so this needs to be deliberate: '
        + 'set "allowBulkRemoval": true in the platform config to allow it. '
        + `Kept: ${stale.map((accessory) => accessory.displayName).join(', ')}`,
      );
      return;
    }

    for (const accessory of stale) {
      this.log.info('Removing accessory no longer present:', accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(accessory.UUID);
    }
  }

  private registerDevice(
    cgateConfig: CGateConfig,
    device: CBusDevice,
    deviceType: CBusDeviceType,
    displayName: string,
    override: GroupOverride | undefined,
    newAccessories: PlatformAccessory[],
    handlerKey?: string,
    channel?: number,
  ): void {
    const uuidSeed = handlerKey
      ? `cbus:${cgateConfig.project}:${handlerKey}`
      : `cbus:${cgateConfig.project}:${device.addressString}`;
    const uuid = this.api.hap.uuid.generate(uuidSeed);
    const key = handlerKey ?? device.addressString;

    const deviceContext: DeviceContext = {
      address: device.addressString,
      name: displayName,
      type: deviceType,
      network: device.address.network,
      application: device.address.application,
      group: device.address.group,
      channel,
      lastLevel: 0,
      options: override?.options ?? {},
    };

    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      this.log.info('Restoring accessory from cache:', displayName);
      existingAccessory.context.device = deviceContext;
      this.api.updatePlatformAccessories([existingAccessory]);
      const handler = createAccessory(this, existingAccessory, deviceType);
      this.accessoryHandlers.set(key, handler);
    } else {
      this.log.info('Adding new accessory:', displayName);
      const accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.device = deviceContext;
      newAccessories.push(accessory);
      // Also record it here. Until the next restart repopulates this map from the
      // cache, it is otherwise missing everything created this run, which makes
      // the platform's own inventory wrong mid-session.
      this.accessories.set(uuid, accessory);
    }

    this.discoveredUUIDs.push(uuid);
  }

  private registerTemperatureSensors(
    cgateConfig: CGateConfig,
    overrides: Map<string, GroupOverride>,
    newAccessories: PlatformAccessory[],
    maxAccessories: number,
    startCount: number,
  ): void {
    let count = startCount;

    // Find all temperature sensor overrides with channels
    for (const [address, override] of overrides) {
      if (override.type !== 'temperatureSensor' || override.channel === undefined) {
        continue;
      }
      if (override.enabled === false) {
        continue;
      }
      if (maxAccessories > 0 && count >= maxAccessories) {
        this.log.info(`Reached maxAccessories limit (${maxAccessories}), skipping remaining temperature sensors`);
        break;
      }

      const parts = address.split('/');
      const network = parseInt(parts[0], 10);
      const application = parseInt(parts[1], 10);
      const deviceId = parseInt(parts[2], 10);
      const handlerKey = `${network}/${application}/${deviceId}/${override.channel}`;
      const displayName = this.sanitiseDisplayName(override.name || `Temp ${handlerKey}`);

      const device: CBusDevice = {
        address: { network, application, group: deviceId },
        name: override.name || `Temp ${handlerKey}`,
        addressString: address,
      };

      this.registerDevice(cgateConfig, device, 'temperatureSensor', displayName, override, newAccessories, handlerKey, override.channel);
      count++;
    }
  }

  private fetchInitialLevel(device: CBusDevice, deviceType: CBusDeviceType): void {
    if (deviceType === 'temperatureSensor') {
      return;
    }

    this.cgateClient.getLevel(device.addressString).then((level) => {
      const handler = this.accessoryHandlers.get(device.addressString);
      if (handler && level > 0) {
        const syntheticEvent: ScpLightingEvent = {
          kind: 'lighting',
          action: 'ramp',
          project: '',
          network: device.address.network,
          application: device.address.application,
          group: device.address.group,
          level: Math.round(level * 100 / 255),
        };
        handler.handleLightingEvent(syntheticEvent);
      }
    }).catch((err) => {
      this.log.debug(`Failed to get initial level for ${device.addressString}: ${err instanceof Error ? err.message : err}`);
    });
  }

  private handleScpEvent(event: ScpEvent): void {
    if (event.kind === 'lighting') {
      const address = `${event.network}/${event.application}/${event.group}`;
      const handler = this.accessoryHandlers.get(address);
      if (handler) {
        handler.handleLightingEvent(event);
      } else {
        this.log.debug(`SCP event for unknown address: ${address}`);
      }
    } else if (event.kind === 'measurement') {
      // Route to channel-specific handler
      const channelKey = `${event.network}/${event.application}/${event.device}/${event.channel}`;
      const handler = this.accessoryHandlers.get(channelKey);
      if (handler) {
        handler.handleMeasurementEvent(event);
      }
    }
  }

  private resolveDeviceType(device: CBusDevice, overrides: Map<string, GroupOverride>): CBusDeviceType {
    const override = overrides.get(device.addressString);
    if (override) {
      return override.type;
    }

    if (device.address.application === CBUS_MEASUREMENT_APPLICATION) {
      return 'temperatureSensor';
    }
    return 'dimmer';
  }

  private getGroupOverrides(): Map<string, GroupOverride> {
    const map = new Map<string, GroupOverride>();
    const overrides = this.config.groupOverrides as GroupOverride[] | undefined;
    if (!overrides || !Array.isArray(overrides)) {
      return map;
    }
    for (const override of overrides) {
      if (override.address && override.type) {
        // Temperature sensors with channels use address/channel as key for uniqueness
        // but are also stored under their base address for the registerTemperatureSensors method
        if (override.type === 'temperatureSensor' && override.channel !== undefined) {
          map.set(`${override.address}/${override.channel}`, override);
        } else {
          map.set(override.address, override);
        }
      }
    }
    return map;
  }

  /**
   * Append newly discovered groups to config.json as disabled overrides.
   *
   * config.json is shared with the Homebridge UI, which rewrites the whole file
   * on save. A naive read-modify-write can therefore clobber a concurrent UI
   * save (or be clobbered by one), and losing `groupOverrides` makes every group
   * fall into the "no override → disabled" path — i.e. the accessories vanish
   * from the bridge. So: re-read and re-apply if the file moved under us, write
   * via a temp file and rename so a reader never sees a half-written config, and
   * refuse to write anything that does not round-trip.
   */
  private appendOverridesToConfig(newOverrides: GroupOverride[]): void {
    const configPath = this.api.user.configPath();

    for (let attempt = 1; attempt <= CONFIG_WRITE_ATTEMPTS; attempt++) {
      try {
        const statBefore = statSync(configPath);
        const raw = readFileSync(configPath, 'utf-8');
        const serialised = this.buildConfigWithOverrides(raw, newOverrides);
        if (serialised === null) {
          return;
        }

        // Did another writer touch config.json between our read and our write?
        // If so, our in-memory copy is stale — start over from the new content
        // rather than overwriting their changes.
        const statAfter = statSync(configPath);
        if (statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.size !== statBefore.size) {
          this.log.warn(`config.json changed while updating it (attempt ${attempt}/${CONFIG_WRITE_ATTEMPTS}) — re-reading`);
          continue;
        }

        this.writeConfigAtomically(configPath, raw, serialised);
        this.log.info(`Added ${newOverrides.length} new disabled override(s) to config.json`);
        return;
      } catch (err) {
        this.log.error(`Failed to update config.json with new overrides: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    this.log.warn(
      'Gave up updating config.json: it kept changing underneath us (is the Homebridge UI saving?). '
      + 'No overrides were written and nothing was overwritten; they will be added on the next restart.',
    );
  }

  /**
   * Produce the new config.json content, or null if it should not be written.
   * Only our own platform block is touched; the rest of the file is passed
   * through unchanged, including its original indentation.
   */
  private buildConfigWithOverrides(raw: string, newOverrides: GroupOverride[]): string | null {
    const fullConfig = JSON.parse(raw);

    // Find our platform entry
    const platforms = fullConfig.platforms as Record<string, unknown>[] | undefined;
    const ourPlatform = platforms?.find(
      (p) => p.platform === PLATFORM_NAME,
    );

    if (!ourPlatform) {
      this.log.warn('Could not find platform entry in config.json — new overrides not saved');
      return null;
    }

    if (!Array.isArray(ourPlatform.groupOverrides)) {
      ourPlatform.groupOverrides = [];
    }
    const groupOverrides = ourPlatform.groupOverrides as GroupOverride[];

    // Skip anything already present, so a retry after a clobbered write cannot
    // produce duplicate entries.
    const existing = new Set(groupOverrides.map((o) => `${o.address}/${o.channel ?? ''}`));
    const toAdd = newOverrides.filter((o) => !existing.has(`${o.address}/${o.channel ?? ''}`));
    if (toAdd.length === 0) {
      return null;
    }
    groupOverrides.push(...toAdd);

    const serialised = JSON.stringify(fullConfig, null, this.detectIndent(raw));

    // Never write something we cannot read back, and never write a file that
    // lost platforms or accessories along the way.
    const roundTripped = JSON.parse(serialised);
    const platformsOut = roundTripped.platforms as unknown[] | undefined;
    const accessoriesIn = (fullConfig.accessories as unknown[] | undefined)?.length ?? 0;
    const accessoriesOut = (roundTripped.accessories as unknown[] | undefined)?.length ?? 0;
    if ((platformsOut?.length ?? 0) !== (platforms?.length ?? 0) || accessoriesOut !== accessoriesIn) {
      this.log.error('Refusing to write config.json: the rewritten file did not match the original structure');
      return null;
    }

    return serialised;
  }

  /**
   * Write via a temp file in the same directory and rename over the original, so
   * config.json is replaced in one step. A crash or a concurrent reader can only
   * ever see the old file or the new one, never a truncated one. The previous
   * contents are kept alongside as .bak.
   */
  private writeConfigAtomically(configPath: string, previous: string, contents: string): void {
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmpPath, contents, 'utf-8');
      copyFileSync(configPath, `${configPath}.bak`);
      renameSync(tmpPath, configPath);
    } catch (err) {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
      // The original is untouched unless the rename itself failed; either way,
      // surface the previous size so a truncated file is obvious in the log.
      this.log.error(`Atomic config.json write failed (previous content was ${previous.length} bytes)`);
      throw err;
    }
  }

  /** Preserve whatever indentation the file already uses rather than reformatting it. */
  private detectIndent(raw: string): string | number {
    const match = /\n([ \t]+)"/.exec(raw);
    return match ? match[1] : 4;
  }

  private sanitiseDisplayName(name: string): string {
    return name
      .replace(/[[\]():/]/g, '') // Remove brackets, parens, colons, slashes
      .replace(/\s{2,}/g, ' ')  // Collapse multiple spaces
      .trim();
  }
}
