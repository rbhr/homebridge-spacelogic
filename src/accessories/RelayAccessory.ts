import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { ScpLightingEvent } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';

export class RelayAccessory extends BaseAccessory {
  private service: Service;
  private isOn = false;

  constructor(platform: SpaceLogicPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);

    this.service = this.getOrAddService(this.platform.Service.Lightbulb);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.isOn = (this.device.lastLevel ?? 0) > 0;
  }

  handleLightingEvent(event: ScpLightingEvent): void {
    if (event.action === 'on' || (event.level !== undefined && event.level > 0)) {
      this.isOn = true;
    } else {
      this.isOn = false;
    }
    this.device.lastLevel = this.isOn ? 255 : 0;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.isOn);
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    try {
      if (value) {
        await this.sendOn();
      } else {
        await this.sendOff();
      }
      this.isOn = value as boolean;
      this.device.lastLevel = this.isOn ? 255 : 0;
    } catch (err) {
      this.handleSetError('setOn', err);
    }
  }

  private getOn(): CharacteristicValue {
    return this.isOn;
  }
}
