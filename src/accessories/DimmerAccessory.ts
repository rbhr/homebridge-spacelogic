import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { ScpLightingEvent } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';

export class DimmerAccessory extends BaseAccessory {
  private service: Service;
  private level = 0; // 0-255
  private lastNonZeroLevel = 255;

  constructor(platform: SpaceLogicPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);

    this.service = this.getOrAddService(this.platform.Service.Lightbulb);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    // Restore cached level
    this.level = this.device.lastLevel ?? 0;
    if (this.level > 0) {
      this.lastNonZeroLevel = this.level;
    }
  }

  handleLightingEvent(event: ScpLightingEvent): void {
    // The event level is already native 0-255, the same units as this.level.
    // Passing it through brightnessToLevel scaled it a second time, so a ramp
    // to 50% came back as 128 -> 326 and HomeKit rejected the 128% brightness
    // that produced, snapping the slider to 100.
    if (event.level !== undefined) {
      this.level = event.level;
    } else if (event.action === 'ramp') {
      // A ramp whose level C-Gate did not report tells us nothing.
      return;
    }

    if (this.level > 0) {
      this.lastNonZeroLevel = this.level;
    }

    this.device.lastLevel = this.level;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.level > 0);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.levelToBrightness(this.level));
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    try {
      if (value) {
        // Turn on to last known brightness
        await this.sendRamp(this.lastNonZeroLevel, this.device.options.rampRate);
        this.level = this.lastNonZeroLevel;
      } else {
        await this.sendOff();
        this.level = 0;
      }
      this.device.lastLevel = this.level;
    } catch (err) {
      this.handleSetError('setOn', err);
    }
  }

  private getOn(): CharacteristicValue {
    return this.level > 0;
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const brightness = value as number;
    const targetLevel = this.brightnessToLevel(brightness);

    try {
      if (targetLevel === 0) {
        await this.sendOff();
      } else {
        await this.sendRamp(targetLevel, this.device.options.rampRate);
      }
      this.level = targetLevel;
      if (targetLevel > 0) {
        this.lastNonZeroLevel = targetLevel;
      }
      this.device.lastLevel = this.level;
    } catch (err) {
      this.handleSetError('setBrightness', err);
    }
  }

  private getBrightness(): CharacteristicValue {
    return this.levelToBrightness(this.level);
  }
}
