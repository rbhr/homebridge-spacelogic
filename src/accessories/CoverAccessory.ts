import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { SpaceLogicPlatform } from '../platform.js';
import type { ScpLightingEvent } from '../cgate/types.js';
import { BaseAccessory } from './BaseAccessory.js';

const DEFAULT_TRAVEL_TIME = 30; // seconds
const TICK_INTERVAL = 500; // ms

export class CoverAccessory extends BaseAccessory {
  private service: Service;
  private currentPosition = 0; // 0=closed, 100=open
  private targetPosition = 0;
  private positionState = 2; // 0=DECREASING, 1=INCREASING, 2=STOPPED
  private movementTimer: ReturnType<typeof setInterval> | null = null;
  private travelTime: number;

  constructor(platform: SpaceLogicPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);

    this.travelTime = this.device.options.travelTime ?? DEFAULT_TRAVEL_TIME;

    this.service = this.getOrAddService(this.platform.Service.WindowCovering);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.getCurrentPosition.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onSet(this.setTargetPosition.bind(this))
      .onGet(this.getTargetPosition.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.getPositionState.bind(this));

    // Restore cached position
    const lastLevel = this.device.lastLevel ?? 0;
    this.currentPosition = this.levelToBrightness(lastLevel);
    this.targetPosition = this.currentPosition;
  }

  handleLightingEvent(event: ScpLightingEvent): void {
    let newTarget: number;
    if (event.action === 'on') {
      newTarget = 100;
    } else if (event.action === 'off') {
      newTarget = 0;
    } else if (event.level !== undefined) {
      newTarget = event.level;
    } else {
      return;
    }

    this.targetPosition = newTarget;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
    this.startMovementSimulation();
  }

  private async setTargetPosition(value: CharacteristicValue): Promise<void> {
    this.targetPosition = value as number;
    const level = this.brightnessToLevel(this.targetPosition);

    try {
      await this.sendRamp(level);
      this.startMovementSimulation();
    } catch (err) {
      this.handleSetError('setTargetPosition', err);
    }
  }

  private getCurrentPosition(): CharacteristicValue {
    return this.currentPosition;
  }

  private getTargetPosition(): CharacteristicValue {
    return this.targetPosition;
  }

  private getPositionState(): CharacteristicValue {
    return this.positionState;
  }

  private startMovementSimulation(): void {
    this.stopMovementSimulation();

    if (this.currentPosition === this.targetPosition) {
      this.positionState = 2; // STOPPED
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, 2);
      return;
    }

    const direction = this.targetPosition > this.currentPosition ? 1 : -1;
    this.positionState = direction > 0 ? 1 : 0; // INCREASING or DECREASING
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

    const stepSize = (100 / this.travelTime) * (TICK_INTERVAL / 1000);

    this.movementTimer = setInterval(() => {
      this.currentPosition += direction * stepSize;

      if ((direction > 0 && this.currentPosition >= this.targetPosition) ||
          (direction < 0 && this.currentPosition <= this.targetPosition)) {
        this.currentPosition = this.targetPosition;
        this.stopMovementSimulation();
        this.positionState = 2; // STOPPED
        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, 2);
      }

      this.currentPosition = Math.max(0, Math.min(100, Math.round(this.currentPosition)));
      this.device.lastLevel = this.brightnessToLevel(this.currentPosition);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.currentPosition);
    }, TICK_INTERVAL);
  }

  private stopMovementSimulation(): void {
    if (this.movementTimer) {
      clearInterval(this.movementTimer);
      this.movementTimer = null;
    }
  }
}
