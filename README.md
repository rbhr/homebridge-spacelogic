<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

<span align="center">

# homebridge-spacelogic

</span>

[![npm](https://img.shields.io/npm/v/homebridge-spacelogic.svg)](https://www.npmjs.com/package/homebridge-spacelogic)
[![npm](https://img.shields.io/npm/dt/homebridge-spacelogic.svg)](https://www.npmjs.com/package/homebridge-spacelogic)
[![License](https://img.shields.io/github/license/rbhr/homebridge-spacelogic)](https://github.com/rbhr/homebridge-spacelogic/blob/latest/LICENSE)

A [Homebridge](https://homebridge.io) dynamic platform plugin for **Clipsal/Schneider Electric C-Bus** lighting and sensor networks, connecting to Apple HomeKit via a [C-Gate](https://www.clipsal.com/products/detail?CatNo=5500CGE) server.

## Features

- **Automatic discovery** of C-Bus groups via C-Gate DBGETXML
- **Real-time status updates** via C-Gate SCP (Status Change Port) — instant feedback when lights are controlled from physical switches
- **8 accessory types** — dimmer, relay, switch, fan, cover/shutter, motion sensor, contact sensor, temperature sensor
- **Group overrides** — customise device type, name, and options per C-Bus group
- **Temperature sensors** — supports C-Bus Measurement Application (app 228) with multi-channel devices
- **HTTP Commander** — optional built-in web console for direct C-Gate command access with real-time event streaming
- **Config UI support** — full settings UI via [homebridge-config-ui-x](https://github.com/homebridge/homebridge-config-ui-x)
- **Homebridge 2.0** compatible (also works with Homebridge v1.8+)
- **Zero external runtime dependencies** beyond `fast-xml-parser` for C-Gate XML parsing

## Requirements

- [Homebridge](https://homebridge.io) v1.8.0 or later (including v2.0 beta)
- Node.js 20, 22, or 24
- A running [C-Gate](https://www.clipsal.com/products/detail?CatNo=5500CGE) server (v2.x or v3.x) accessible on the network
- A configured C-Bus network with a C-Gate project

## Installation

### Via Homebridge Config UI (Recommended)

Search for **homebridge-spacelogic** in the Homebridge Config UI plugin search.

### Via npm

```shell
sudo npm install -g homebridge-spacelogic
```

### From GitHub (Development)

```shell
git clone https://github.com/rbhr/homebridge-spacelogic.git
cd homebridge-spacelogic
npm install
npm run build
sudo npm link
```

## Configuration

### Minimal Config

Add the following to your Homebridge `config.json` under `platforms`:

```json
{
    "name": "SpaceLogic C-Bus",
    "platform": "SpaceLogicPlatform",
    "cgate": {
        "host": "192.168.1.100",
        "project": "HOME",
        "network": 254
    }
}
```

This will connect to C-Gate, discover all groups in the lighting application (app 56), and expose them as dimmable lights in HomeKit.

### Full Config

```json
{
    "name": "SpaceLogic C-Bus",
    "platform": "SpaceLogicPlatform",
    "cgate": {
        "host": "192.168.1.100",
        "commandPort": 20023,
        "eventPort": 20024,
        "scpPort": 20025,
        "project": "HOME",
        "network": 254
    },
    "commander": {
        "port": 8980
    },
    "maxAccessories": 0,
    "groupOverrides": [
        {
            "address": "254/56/1",
            "type": "dimmer",
            "name": "Living Room Downlights",
            "enabled": true,
            "options": {
                "rampRate": 4
            }
        },
        {
            "address": "254/56/20",
            "type": "relay",
            "name": "Garage Light"
        },
        {
            "address": "254/56/50",
            "type": "switch",
            "name": "Garden Irrigation",
            "options": {
                "autoOff": 3600
            }
        },
        {
            "address": "254/56/60",
            "type": "fan",
            "name": "Bedroom Fan"
        },
        {
            "address": "254/56/70",
            "type": "cover",
            "name": "Lounge Blinds",
            "options": {
                "travelTime": 30
            }
        },
        {
            "address": "254/56/80",
            "type": "motionSensor",
            "name": "Front Door Motion"
        },
        {
            "address": "254/56/90",
            "type": "contactSensor",
            "name": "Garage Door"
        },
        {
            "address": "254/228/1",
            "type": "temperatureSensor",
            "name": "Living Room Temperature",
            "channel": 1
        },
        {
            "address": "254/56/100",
            "enabled": false
        }
    ]
}
```

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | `"SpaceLogic C-Bus"` | Platform display name |
| `cgate.host` | string | `"localhost"` | C-Gate server hostname or IP |
| `cgate.commandPort` | integer | `20023` | C-Gate command port |
| `cgate.eventPort` | integer | `20024` | C-Gate event port |
| `cgate.scpPort` | integer | `20025` | C-Gate status change port |
| `cgate.project` | string | *(required)* | C-Gate project name |
| `cgate.network` | integer | `254` | Default C-Bus network number |
| `commander.port` | integer | `0` | HTTP Commander port (0 = disabled) |
| `maxAccessories` | integer | `0` | Limit registered accessories (0 = unlimited) |

### Group Override Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `address` | string | *(required)* | C-Bus address: `network/application/group` (e.g., `254/56/3`) |
| `type` | string | `"dimmer"` | Accessory type (see below) |
| `name` | string | *(auto-discovered)* | Custom display name for HomeKit |
| `enabled` | boolean | `true` | Set `false` to hide from HomeKit |
| `channel` | integer | — | Measurement channel for temperature sensors (app 228) |
| `options` | object | — | Type-specific options (see below) |

## Accessory Types

| Type | HomeKit Service | C-Bus Control | Description |
|------|----------------|---------------|-------------|
| `dimmer` | Lightbulb (On + Brightness) | RAMP | Dimmable light — the default for all discovered groups |
| `relay` | Lightbulb (On only) | ON/OFF | Non-dimmable light or relay |
| `switch` | Switch (On) | ON/OFF | Generic switch with optional auto-off timer |
| `fan` | Fan v2 (Active + Speed) | RAMP | Variable speed fan |
| `cover` | Window Covering (Position) | RAMP | Motorised blind, shutter, or curtain |
| `motionSensor` | Motion Sensor | read-only | C-Bus motion/occupancy sensor |
| `contactSensor` | Contact Sensor | read-only | C-Bus contact/reed sensor |
| `temperatureSensor` | Temperature Sensor | read-only | C-Bus Measurement App (228) temperature reading |

### Type-Specific Options

**Dimmer:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rampRate` | number | `0` | Default ramp duration in seconds |

**Switch:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoOff` | number | `0` | Auto-off timer in seconds (0 = disabled) |

**Cover:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `travelTime` | number | `30` | Time in seconds for full open/close travel |

## Temperature Sensors

C-Bus temperature sensors use the Measurement Application (app 228) with device/channel addressing, rather than the group addressing used by lighting.

To configure a temperature sensor, you need:
- The **device address** in the measurement application (e.g., `254/228/1`)
- The **channel number** for the specific temperature reading

```json
{
    "address": "254/228/22",
    "type": "temperatureSensor",
    "name": "Kitchen Temperature",
    "channel": 1
}
```

A single C-Bus measurement device can have multiple channels (e.g., indoor temp on channel 1, outdoor temp on channel 5). Create separate overrides for each channel you want to expose.

## HTTP Commander

The optional HTTP Commander provides a web-based console for direct C-Gate command access and real-time event monitoring. Enable it by setting `commander.port` to a non-zero value (e.g., `8980`).

### Web Console

Open `http://<homebridge-ip>:<port>/` in your browser for a terminal-style console where you can:

- Type and send any C-Gate command
- See real-time SCP events (lighting changes, measurement data) as they happen
- Monitor event port activity
- Debug C-Bus communication

### HTTP API

**Send a command:**
```
GET /cgate?cmd=<command>
```

Example:
```shell
curl "http://localhost:8980/cgate?cmd=ON%20//HOME/254/56/1"
```

Response:
```json
{
    "status": "ok",
    "command": "ON //HOME/254/56/1",
    "response": "200 OK"
}
```

**Event stream (SSE):**
```
GET /events
```

Returns a Server-Sent Events stream with real-time C-Gate events. Event types: `event` (event port), `scp` (status change port).

```shell
curl -N http://localhost:8980/events
```

## C-Gate Setup Notes

- C-Gate must be accessible from the machine running Homebridge on ports 20023, 20024, and 20025 (or your custom ports)
- The C-Gate project must be configured and started
- If C-Gate is on a different machine, ensure its `access-control` settings allow connections from your Homebridge host
- C-Gate access control is configured in `C-Gate/config/access-control.txt` — add your Homebridge server's IP if needed

## How It Works

1. **Discovery:** On startup, the plugin sends a `DBGETXML` command to C-Gate to retrieve the full project database, then parses the XML to find all groups in the lighting application (app 56)
2. **Registration:** Each discovered group is registered as a HomeKit accessory. Group overrides let you change the device type, rename, or disable individual groups
3. **Control:** When you control an accessory in HomeKit, the plugin sends the corresponding C-Gate command (ON, OFF, RAMP) via the command port (20023)
4. **Real-time updates:** The plugin listens on the SCP port (20025) for state change notifications. When a light is turned on from a physical switch or another controller, HomeKit updates instantly

## Development

```shell
# Clone the repo
git clone https://github.com/rbhr/homebridge-spacelogic.git
cd homebridge-spacelogic

# Install dependencies
npm install

# Build
npm run build

# Link for development
npm link

# Watch mode (auto-rebuild + restart)
npm run watch
```

Configure your development instance in `test/hbConfig/config.json`.

### Versioning

Given a version number `MAJOR`.`MINOR`.`PATCH`:

```shell
# Major (breaking changes)
npm version major

# Minor (new features, backwards compatible)
npm version minor

# Patch (bug fixes)
npm version patch
```

### Publishing

```shell
npm publish
```

To publish a beta:

```shell
npm version prepatch --preid beta
npm publish --tag beta
```

Users install betas with:

```shell
sudo npm install -g homebridge-spacelogic@beta
```

## License

[Apache 2.0](LICENSE)

## Acknowledgements

- [Homebridge](https://homebridge.io) and the [Homebridge Plugin Template](https://github.com/homebridge/homebridge-plugin-template)
- [C-Gate](https://www.clipsal.com/products/detail?CatNo=5500CGE) by Clipsal/Schneider Electric
- [ha-spacelogic](https://github.com/rbhr/ha-spacelogic) Home Assistant custom component (reference implementation)
