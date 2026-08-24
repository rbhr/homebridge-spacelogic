export const PLATFORM_NAME = 'SpaceLogicPlatform';
export const PLUGIN_NAME = 'homebridge-spacelogic';

/**
 * Maximum fraction of the cached accessories that a single discovery pass may
 * remove without explicit opt-in. Removal is unrecoverable: HomeKit discards the
 * accessory's room, name, scene and automation assignments, and re-registering
 * the same UUID later does not bring them back.
 */
export const MAX_REMOVAL_FRACTION = 0.2;

/**
 * How many times to re-read, re-apply and re-attempt a config.json update when
 * another writer (typically the Homebridge UI) touches the file underneath us.
 */
export const CONFIG_WRITE_ATTEMPTS = 3;
