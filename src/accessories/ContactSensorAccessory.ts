import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { ScpLightingEvent } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';

export class ContactSensorAccessory extends BaseAccessory {
  private service: Service;
  private contactDetected = true; // true = CONTACT_DETECTED (closed)

  constructor(platform: SpaceLogicPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);

    this.service = this.getOrAddService(this.platform.Service.ContactSensor);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.getContactState.bind(this));

    this.contactDetected = (this.device.lastLevel ?? 0) === 0;
  }

  handleLightingEvent(event: ScpLightingEvent): void {
    // C-Bus: on/level>0 = open (no contact), off/level=0 = closed (contact detected)
    const isOpen = event.action === 'on' || (event.level !== undefined && event.level > 0);
    this.contactDetected = !isOpen;
    this.device.lastLevel = isOpen ? 255 : 0;

    // HomeKit: 0 = CONTACT_DETECTED, 1 = CONTACT_NOT_DETECTED
    this.service.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      this.contactDetected ? 0 : 1,
    );
  }

  private getContactState(): CharacteristicValue {
    return this.contactDetected ? 0 : 1;
  }
}
