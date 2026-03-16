export interface CGateConfig {
  host: string;
  commandPort: number;
  eventPort: number;
  scpPort: number;
  project: string;
  network: number;
}

export interface CBusAddress {
  network: number;
  application: number;
  group: number;
}

export interface CBusDevice {
  address: CBusAddress;
  name: string;
  addressString: string; // "254/56/1"
}

export type CBusDeviceType =
  | 'dimmer'
  | 'relay'
  | 'switch'
  | 'fan'
  | 'cover'
  | 'motionSensor'
  | 'contactSensor'
  | 'temperatureSensor';

export interface GroupOverride {
  address: string;
  type: CBusDeviceType;
  name?: string;
  enabled?: boolean;
  channel?: number;
  options?: GroupOverrideOptions;
}

export interface GroupOverrideOptions {
  travelTime?: number;
  autoOff?: number;
  rampRate?: number;
}

export interface DeviceContext {
  address: string;
  name: string;
  type: CBusDeviceType;
  network: number;
  application: number;
  group: number;
  channel?: number;
  lastLevel: number;
  options: GroupOverrideOptions;
}

export interface ScpLightingEvent {
  kind: 'lighting';
  action: 'on' | 'off' | 'ramp';
  project: string;
  network: number;
  application: number;
  group: number;
  level?: number;
}

export interface ScpMeasurementEvent {
  kind: 'measurement';
  project: string;
  network: number;
  application: number;
  device: number;
  channel: number;
  value: number;
  exponent: number;
  units: number;
}

export type ScpEvent = ScpLightingEvent | ScpMeasurementEvent;

export const CBUS_LIGHTING_APPLICATION = 56;
export const CBUS_MEASUREMENT_APPLICATION = 228;
export const CBUS_LEVEL_MAX = 255;
export const DEFAULT_KEEPALIVE_INTERVAL = 60_000;
export const CMD_BUFFER_LIMIT = 1024 * 1024;
export const COMMAND_TIMEOUT = 10_000;
export const DBGETXML_TIMEOUT = 30_000;
