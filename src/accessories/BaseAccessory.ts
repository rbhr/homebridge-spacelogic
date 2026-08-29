import type {
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { DeviceContext, ScpLightingEvent, ScpMeasurementEvent } from '../cgate/types.js';

export abstract class BaseAccessory {
  /** Public so the platform can resynchronise handlers after a reconnect. */
  public readonly device: DeviceContext;
  protected readonly log: Logging;

  constructor(
    protected readonly platform: SpaceLogicPlatform,
    protected readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as DeviceContext;
    this.log = platform.log;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Clipsal/Schneider Electric')
      .setCharacteristic(this.platform.Characteristic.Model, `C-Bus ${this.device.type}`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.address);
  }

  abstract handleLightingEvent(event: ScpLightingEvent): void;

  handleMeasurementEvent(_event: ScpMeasurementEvent): void {
    // Override in TemperatureSensorAccessory
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected getOrAddService(serviceType: any, name?: string, subtype?: string): Service {
    if (subtype) {
      return this.accessory.getService(name ?? serviceType.name)
        || this.accessory.addService(serviceType, name, subtype);
    }
    return this.accessory.getService(serviceType)
      || this.accessory.addService(serviceType);
  }

  protected async sendOn(): Promise<void> {
    await this.platform.cgateClient.turnOn(this.device.address);
  }

  protected async sendOff(): Promise<void> {
    await this.platform.cgateClient.turnOff(this.device.address);
  }

  protected async sendRamp(level: number, rateSeconds?: number): Promise<void> {
    await this.platform.cgateClient.ramp(this.device.address, level, rateSeconds);
  }

  protected handleSetError(context: string, err: unknown): never {
    this.log.error(`${context}: ${err instanceof Error ? err.message : err}`);
    throw new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  protected brightnessToLevel(brightness: number): number {
    return Math.round(brightness * 255 / 100);
  }

  protected levelToBrightness(level: number): number {
    return Math.round(level * 100 / 255);
  }
}
