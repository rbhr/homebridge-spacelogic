import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { ScpLightingEvent } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';

export class MotionSensorAccessory extends BaseAccessory {
  private service: Service;
  private motionDetected = false;

  constructor(platform: SpaceLogicPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);

    this.service = this.getOrAddService(this.platform.Service.MotionSensor);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.MotionDetected)
      .onGet(this.getMotionDetected.bind(this));

    this.motionDetected = (this.device.lastLevel ?? 0) > 0;
  }

  handleLightingEvent(event: ScpLightingEvent): void {
    this.motionDetected = event.action === 'on' || (event.level !== undefined && event.level > 0);
    this.device.lastLevel = this.motionDetected ? 255 : 0;
    this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, this.motionDetected);
  }

  private getMotionDetected(): CharacteristicValue {
    return this.motionDetected;
  }
}
