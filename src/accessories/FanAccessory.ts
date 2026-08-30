import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { ScpLightingEvent } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';

export class FanAccessory extends BaseAccessory {
  private service: Service;
  private active = false;
  private speed = 100; // 0-100

  constructor(platform: SpaceLogicPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);

    this.service = this.getOrAddService(this.platform.Service.Fanv2);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setSpeed.bind(this))
      .onGet(this.getSpeed.bind(this));

    const lastLevel = this.device.lastLevel ?? 0;
    this.active = lastLevel > 0;
    this.speed = lastLevel > 0 ? this.levelToBrightness(lastLevel) : 100;
  }

  handleLightingEvent(event: ScpLightingEvent): void {
    if (event.action === 'off' || (event.level !== undefined && event.level === 0)) {
      this.active = false;
    } else {
      this.active = true;
      if (event.level !== undefined && event.level > 0) {
        this.speed = this.levelToBrightness(event.level);
      }
    }
    this.device.lastLevel = this.active ? this.brightnessToLevel(this.speed) : 0;
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.active ? 1 : 0);
    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.speed);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    try {
      if (value) {
        await this.sendRamp(this.brightnessToLevel(this.speed));
        this.active = true;
      } else {
        await this.sendOff();
        this.active = false;
      }
      this.device.lastLevel = this.active ? this.brightnessToLevel(this.speed) : 0;
    } catch (err) {
      this.handleSetError('setActive', err);
    }
  }

  private getActive(): CharacteristicValue {
    return this.active ? 1 : 0;
  }

  private async setSpeed(value: CharacteristicValue): Promise<void> {
    this.speed = value as number;
    const level = this.brightnessToLevel(this.speed);
    try {
      if (level === 0) {
        await this.sendOff();
        this.active = false;
      } else {
        await this.sendRamp(level);
        this.active = true;
      }
      this.device.lastLevel = this.active ? level : 0;
    } catch (err) {
      this.handleSetError('setSpeed', err);
    }
  }

  private getSpeed(): CharacteristicValue {
    return this.speed;
  }
}
