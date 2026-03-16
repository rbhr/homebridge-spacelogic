import type { PlatformAccessory } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { CBusDeviceType } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';
import { DimmerAccessory } from './DimmerAccessory.js';
import { RelayAccessory } from './RelayAccessory.js';
import { SwitchAccessory } from './SwitchAccessory.js';
import { FanAccessory } from './FanAccessory.js';
import { CoverAccessory } from './CoverAccessory.js';
import { MotionSensorAccessory } from './MotionSensorAccessory.js';
import { ContactSensorAccessory } from './ContactSensorAccessory.js';
import { TemperatureSensorAccessory } from './TemperatureSensorAccessory.js';

type AccessoryConstructor = new (platform: SpaceLogicPlatform, accessory: PlatformAccessory) => BaseAccessory;

const ACCESSORY_MAP: Record<CBusDeviceType, AccessoryConstructor> = {
  dimmer: DimmerAccessory,
  relay: RelayAccessory,
  switch: SwitchAccessory,
  fan: FanAccessory,
  cover: CoverAccessory,
  motionSensor: MotionSensorAccessory,
  contactSensor: ContactSensorAccessory,
  temperatureSensor: TemperatureSensorAccessory,
};

export function createAccessory(
  platform: SpaceLogicPlatform,
  accessory: PlatformAccessory,
  deviceType: CBusDeviceType,
): BaseAccessory {
  const Constructor = ACCESSORY_MAP[deviceType];
  if (!Constructor) {
    platform.log.warn(`Unknown device type "${deviceType}", defaulting to dimmer`);
    return new DimmerAccessory(platform, accessory);
  }
  return new Constructor(platform, accessory);
}
