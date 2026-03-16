import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
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

export class SpaceLogicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly accessoryHandlers: Map<string, BaseAccessory> = new Map();
  private readonly discoveredUUIDs: string[] = [];
  private httpCommander: HttpCommander | null = null;

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

    try {
      await this.cgateClient.connect();
      this.log.info('Connected to C-Gate server');
    } catch (err) {
      this.log.error(`Failed to connect to C-Gate: ${err instanceof Error ? err.message : err}`);
      return;
    }

    // Start HTTP Commander if configured
    const commanderPort = (this.config.commander?.port as number | undefined) ?? 0;
    if (commanderPort > 0) {
      this.httpCommander = new HttpCommander(commanderPort, this.cgateClient, this.log);
      this.httpCommander.start();
    }

    try {
      await this.discoverDevices(cgateConfig);
    } catch (err) {
      this.log.error(`Failed during device discovery: ${err instanceof Error ? err.message : err}`);
    }
  }

  private shutdown(): void {
    this.log.info('Shutting down SpaceLogic platform');
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
    const overrides = this.getGroupOverrides();
    const maxAccessories = (this.config.maxAccessories as number | undefined) ?? 0;
    let count = 0;
    const seenAddresses = new Set<string>();
    const newAccessories: PlatformAccessory[] = [];

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

      // Skip explicitly disabled devices
      if (override?.enabled === false) {
        this.log.debug(`Skipping disabled device: ${device.addressString} (${device.name})`);
        continue;
      }

      const deviceType = this.resolveDeviceType(device, overrides);
      const displayName = this.sanitiseDisplayName(override?.name || device.name);

      this.registerDevice(cgateConfig, device, deviceType, displayName, override, newAccessories);
      count++;
      this.fetchInitialLevel(device, deviceType);
    }

    // Register temperature sensor overrides (channel-based, not auto-discovered)
    this.registerTemperatureSensors(cgateConfig, overrides, newAccessories, maxAccessories, count);

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
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredUUIDs.includes(uuid)) {
        this.log.info('Removing accessory no longer present:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
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

  private sanitiseDisplayName(name: string): string {
    return name
      .replace(/[[\]():/]/g, '') // Remove brackets, parens, colons, slashes
      .replace(/\s{2,}/g, ' ')  // Collapse multiple spaces
      .trim();
  }
}
