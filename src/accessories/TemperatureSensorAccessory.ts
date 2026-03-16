import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { ScpLightingEvent, ScpMeasurementEvent } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';

export class TemperatureSensorAccessory extends BaseAccessory {
  private service: Service;
  private temperature = 0;

  constructor(platform: SpaceLogicPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);

    this.service = this.getOrAddService(this.platform.Service.TemperatureSensor);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getTemperature.bind(this));
  }

  // Temperature sensors don't respond to lighting events
  handleLightingEvent(_event: ScpLightingEvent): void {
    // No-op for temperature sensors
  }

  override handleMeasurementEvent(event: ScpMeasurementEvent): void {
    // Calculate actual value: value * 10^exponent
    this.temperature = event.value * Math.pow(10, event.exponent);
    this.log.debug(`Temperature update for ${this.device.name}: ${this.temperature}`);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.temperature);
  }

  private getTemperature(): CharacteristicValue {
    return this.temperature;
  }
}
