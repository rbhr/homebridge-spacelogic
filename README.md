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

> **New to the plugin?** Nothing appears in HomeKit after the first start — that is by
> design. Read [First Run](#first-run) before you go looking for a fault.

## Features

- **Automatic discovery** of C-Bus groups via C-Gate DBGETXML
- **Opt-in devices** — discovered groups are written into your config disabled, so you pick what reaches HomeKit instead of getting every group in the project
- **Real-time status updates** via C-Gate SCP (Status Change Port) — instant feedback when lights are controlled from physical switches
- **8 accessory types** — dimmer, relay, switch, fan, cover/shutter, motion sensor, contact sensor, temperature sensor
- **Group overrides** — customise device type, name, and options per C-Bus group
- **Temperature sensors** — supports C-Bus Measurement Application (app 228) with multi-channel devices
- **Outage recovery** — reconnects with backoff and resynchronises state when C-Gate or the network goes away, rather than dying and needing a manual restart
- **Safe by default** — a failed or suspiciously empty discovery never deletes your HomeKit accessories (see [Accessory Removal Safety](#accessory-removal-safety))
- **HTTP Commander** — optional built-in web console for direct C-Gate command access with real-time event streaming
- **Config UI support** — full settings UI via [homebridge-config-ui-x](https://github.com/homebridge/homebridge-config-ui-x)
- **Homebridge 2.0** compatible (also works with Homebridge v1.8+)
- **One runtime dependency** — `fast-xml-parser`, for the C-Gate project database

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
        "project": "HOME"
    }
}
```

`host` and `project` are the only required settings. This connects to C-Gate and discovers
every named group in your project — but it does not expose any of them yet. See below.

## First Run

**The first start registers no accessories. This is intentional.**

A C-Bus project usually contains far more groups than you want in the Home app, and HomeKit
caps a single bridge at 150 accessories. So instead of exposing everything it finds, the
plugin turns discovery into a checklist for you to tick:

1. **Start Homebridge.** The plugin connects to C-Gate, runs `DBGETXML`, and finds every
   named group in the lighting (56) and measurement (228) applications. The log shows one
   line per group:

   ```
   New device discovered: 254/56/1 (Kitchen Downlights) — adding as disabled override
   ```

2. **It writes them into `config.json`**, each as a *disabled* `groupOverrides` entry:

   ```json
   { "address": "254/56/1", "type": "dimmer", "name": "Kitchen Downlights", "enabled": false }
   ```

   Nothing else in the file is touched, and the previous contents are kept as
   `config.json.bak`.

3. **Enable the ones you want.** In the Homebridge Config UI, open the plugin settings and
   tick **Enabled** on each group you want in HomeKit — the addresses and names are already
   filled in for you. Change **Device Type** at the same time if the group is a relay, fan,
   cover or sensor rather than a dimmer.

4. **Restart Homebridge.** The enabled groups appear in the Home app.

Groups added to your C-Bus project later get appended as new disabled overrides on the next
restart, so the same tick-and-restart applies. Entries already in the file are never
duplicated and never re-enabled behind your back.

> **`type` is required on every override.** An entry without a `type` is ignored entirely —
> including its `enabled: true` — and the group will not appear in HomeKit. The overrides the
> plugin writes for you always include one; keep it if you hand-edit.

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
        "project": "HOME"
    },
    "commander": {
        "port": 8980
    },
    "maxAccessories": 0,
    "allowBulkRemoval": false,
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
            "name": "Garage Light",
            "enabled": true
        },
        {
            "address": "254/56/50",
            "type": "switch",
            "name": "Garden Irrigation",
            "enabled": true,
            "options": {
                "autoOff": 3600
            }
        },
        {
            "address": "254/56/60",
            "type": "fan",
            "name": "Bedroom Fan",
            "enabled": true
        },
        {
            "address": "254/56/70",
            "type": "cover",
            "name": "Lounge Blinds",
            "enabled": true,
            "options": {
                "travelTime": 30
            }
        },
        {
            "address": "254/56/80",
            "type": "motionSensor",
            "name": "Front Door Motion",
            "enabled": true
        },
        {
            "address": "254/56/90",
            "type": "contactSensor",
            "name": "Garage Door",
            "enabled": true
        },
        {
            "address": "254/228/1",
            "type": "temperatureSensor",
            "name": "Living Room Temperature",
            "channel": 1,
            "enabled": true
        },
        {
            "address": "254/56/100",
            "type": "dimmer",
            "name": "Spare Circuit",
            "enabled": false
        }
    ]
}
```

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | `"SpaceLogic C-Bus"` | Platform display name |
| `cgate.host` | string | *(required)* | C-Gate server hostname or IP |
| `cgate.project` | string | *(required)* | C-Gate project name |
| `cgate.commandPort` | integer | `20023` | C-Gate command port |
| `cgate.eventPort` | integer | `20024` | C-Gate event port |
| `cgate.scpPort` | integer | `20025` | C-Gate status change port |
| `cgate.network` | integer | `254` | Reserved. Networks come from the discovered address or from the override's own `network/application/group`, so changing this has no effect today |
| `commander.port` | integer | `0` | HTTP Commander port (0 = disabled, see [HTTP Commander](#http-commander)) |
| `maxAccessories` | integer | `0` | Limit registered accessories (0 = unlimited). Debugging aid |
| `allowBulkRemoval` | boolean | `false` | Allow one discovery pass to remove more than 20% of your accessories (see [Accessory Removal Safety](#accessory-removal-safety)) |

If `cgate.host` or `cgate.project` is missing the platform logs an error and stops; nothing
is discovered and nothing is removed.

### Group Override Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `address` | string | *(required)* | C-Bus address: `network/application/group` (e.g., `254/56/3`) |
| `type` | string | *(required)* | Accessory type (see [Accessory Types](#accessory-types)). An override without one is ignored |
| `name` | string | *(auto-discovered)* | Custom display name for HomeKit |
| `enabled` | boolean | `true` | `false` hides the group from HomeKit. Auto-created overrides start as `false` |
| `channel` | integer | — | Measurement channel, required for temperature sensors (app 228) |
| `options` | object | — | Type-specific options (see [below](#type-specific-options)) |

Display names are sanitised for HomeKit: `[`, `]`, `(`, `)`, `:` and `/` are stripped and
runs of spaces collapsed. A C-Bus tag of `Kitchen (Downlights)` becomes `Kitchen Downlights`.

## What Gets Discovered

Discovery reads the project database over `DBGETXML` and keeps only what it can meaningfully
expose. A group is skipped — and so never written to your config — when:

- it is outside the **lighting (56)** and **measurement (228)** applications;
- its group address is **0 or 255** (master/broadcast);
- its tag name is blank or a placeholder: `<unused>`, `unused`, `untitled`, `Group 12`,
  `group_12`.

Duplicate addresses in the XML are logged once and ignored.

Groups with no physical unit behind them ("virtual" groups) answer `GET ... level` with a
`401`. The plugin notices, marks them, and stops polling them; they still track SCP events
normally.

## Accessory Types

| Type | HomeKit Service | C-Bus Control | Description |
|------|----------------|---------------|-------------|
| `dimmer` | Lightbulb (On + Brightness) | RAMP | Dimmable light — the default for a newly discovered lighting group |
| `relay` | Lightbulb (On only) | ON/OFF | Non-dimmable light or relay |
| `switch` | Switch (On) | ON/OFF | Generic switch with optional auto-off timer |
| `fan` | Fan v2 (Active + Speed) | RAMP | Variable speed fan |
| `cover` | Window Covering (Position) | RAMP | Motorised blind, shutter, or curtain |
| `motionSensor` | Motion Sensor | read-only | C-Bus motion/occupancy sensor |
| `contactSensor` | Contact Sensor | read-only | C-Bus contact/reed sensor |
| `temperatureSensor` | Temperature Sensor | read-only | C-Bus Measurement App (228) temperature reading |

C-Bus levels (0–255) and HomeKit percentages (0–100) are converted for you. Turning a dimmer
on from HomeKit restores its last non-zero brightness rather than jumping to 100%.

The sensor types read whatever the group reports: a lighting group at level > 0 means motion
detected, or contact *open*. They are driven by SCP events and cannot be controlled from the
Home app.

### Type-Specific Options

**Dimmer:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rampRate` | number | `0` | Ramp duration in seconds for on/brightness changes. `0` sends a plain `RAMP` with no rate |

**Switch:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoOff` | number | `0` | Auto-off timer in seconds (0 = disabled). The timer lives in the plugin, so it does not survive a Homebridge restart |

**Cover:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `travelTime` | number | `30` | Time in seconds for full open/close travel |

C-Bus reports a cover's commanded level, not where the blind physically is, so the plugin
animates `CurrentPosition` from `travelTime` to give the Home app something sensible to show
while the blind moves. Set it to your blind's real travel time; it affects only the on-screen
animation, never the C-Bus command.

## Temperature Sensors

C-Bus temperature sensors use the Measurement Application (app 228) with device/channel
addressing, rather than the group addressing used by lighting. They are the one type that
cannot be set up by ticking **Enabled** alone — you have to supply the channel.

To configure a temperature sensor, you need:
- The **device address** in the measurement application (e.g., `254/228/1`)
- The **channel number** for the specific temperature reading

```json
{
    "address": "254/228/22",
    "type": "temperatureSensor",
    "name": "Kitchen Temperature",
    "channel": 1,
    "enabled": true
}
```

A single C-Bus measurement device can have multiple channels (e.g., indoor temp on channel 1,
outdoor temp on channel 5). Create a separate override for each channel you want to expose;
they share one address and are told apart by `channel`.

Readings arrive only as C-Gate `measurement data` events on the SCP port — there is no
equivalent of `GET level` to poll — so a newly added sensor shows `0°C` until the device next
reports. Most report every few minutes.

A measurement device that already has a channelled override is left alone by discovery — it
will not be re-added as a separate disabled entry. An override of type `temperatureSensor`
with no `channel` still registers, but nothing can ever update it, so the log warns and the
reading stays at 0.

If you upgraded from 1.0.4 or earlier you may have a leftover
`{"address": "254/228/22", "type": "temperatureSensor", "enabled": false}` sitting beside your
real sensor, added by the old behaviour. It is inert; delete it whenever convenient.

## HTTP Commander

The optional HTTP Commander provides a web-based console for direct C-Gate command access and
real-time event monitoring. Enable it by setting `commander.port` to a non-zero value (e.g.,
`8980`). It starts even when C-Gate is unreachable, so you can use it to diagnose an outage.

> **Security:** the Commander has no authentication, accepts any C-Gate command, sends
> `Access-Control-Allow-Origin: *`, and listens on **every** interface — not just localhost,
> despite what the startup log line says. Anyone who can reach the port can operate your
> lighting. Leave it disabled (`0`) in normal use, and never expose the port to the internet.

### Web Console

Open `http://<homebridge-ip>:<port>/` (or `/console`) in your browser for a terminal-style
console where you can:

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

Errors return the same shape with `"status": "error"` and an `error` field: `400` for a
missing `cmd`, `503` when C-Gate is not connected, `500` when the command itself fails or
times out.

**Event stream (SSE):**
```
GET /events
```

Returns a Server-Sent Events stream with real-time C-Gate events. Event types: `event` (event
port), `scp` (status change port). A keepalive comment is sent every 30 seconds.

```shell
curl -N http://localhost:8980/events
```

## C-Gate Setup Notes

- C-Gate must be accessible from the machine running Homebridge on ports 20023, 20024, and 20025 (or your custom ports)
- The C-Gate project must be configured and started
- If C-Gate is on a different machine, ensure its `access-control` settings allow connections from your Homebridge host
- C-Gate access control is configured in `C-Gate/config/access-control.txt` — add your Homebridge server's IP if needed

## How It Works

1. **Discovery:** On the first successful connection the plugin sends `PROJECT USE` and
   `PROJECT START`, then `DBGETXML` to retrieve the project database, and parses it for
   groups in the lighting (56) and measurement (228) applications
2. **Registration:** Groups you have enabled via a group override are registered as HomeKit
   accessories; groups it has not seen before are appended to `config.json` disabled
3. **Control:** Controlling an accessory in HomeKit sends the corresponding C-Gate command
   (`ON`, `OFF`, `RAMP`) on the command port (20023)
4. **Real-time updates:** The plugin listens on the SCP port (20025) for state changes. When a
   light is switched from a wall plate or another controller, HomeKit updates instantly

### When C-Gate Goes Away

C-Gate being unreachable at startup and C-Gate disappearing an hour later are the same code
path, and neither takes the bridge down:

- The connection layer retries each of the three ports independently, backing off from 2s by
  doubling to a 60s ceiling, with jitter so the ports do not all retry in lockstep
- Accessories stay registered and simply stop responding while the link is down
- Every successful reconnect resynchronises accessory state by re-reading each group's level.
  A read that fails is skipped rather than treated as "off", so a partial resync never
  switches your lights off in the Home app
- Discovery runs once, on the first successful handshake. If it fails while C-Gate stays
  connected — a project that has not finished loading, say — it retries every 60 seconds

## Accessory Removal Safety

Unregistering a HomeKit accessory is destructive and irreversible. HomeKit binds room
assignments, custom names, scenes and automations to the accessory instance in the
bridge — not to the plugin's UUID. Once an accessory is removed, re-registering it
later with the same UUID comes back as a brand-new accessory with none of that
metadata. Historically a single failed `DBGETXML` (C-Gate reachable but the project
not yet loaded, e.g. right after changing `cgate.host`) was enough to wipe every
accessory in the bridge.

The plugin now treats "I can't see any devices" as a fault, not as "the devices are
gone":

- **Discovery failures abort the pass.** If `PROJECT USE`/`PROJECT START` fails, the
  client is not ready, `DBGETXML` returns nothing, or the project XML fails to parse,
  discovery throws. Cached accessories are left registered untouched and the plugin
  retries.
- **An empty result never removes anything.** If discovery returns zero devices while
  accessories are cached, removal is skipped and a warning is logged.
- **Bulk removal requires opt-in.** A single pass will not remove more than 20% of the
  cached accessories. If you really are decommissioning a lot of groups, set
  `"allowBulkRemoval": true`, restart, then set it back to `false`.

If a restart logs `Refusing to remove N of M cached accessories`, check `cgate.host`
and `cgate.project` before reaching for `allowBulkRemoval` — a typo in either looks
exactly like a mass deletion.

### config.json writes

Newly discovered groups are appended to `config.json` as disabled overrides, which
means the plugin shares the file with the Homebridge UI. Losing `groupOverrides` to a
clobbered write has the same visible effect as the failure above — every group falls
into the "no override → disabled" path and the accessories disappear — so the write is
defensive:

- Only the plugin's own platform block is modified; everything else passes through
  untouched, including the file's existing indentation.
- If `config.json` changes between the read and the write (a UI save landing at the
  same moment), the plugin re-reads and re-applies rather than overwriting. After
  three collisions it gives up without writing and tries again on the next restart.
- The write goes to a temp file and is renamed over the original, so a crash or a
  concurrent reader sees either the old file or the new one, never a truncated one.
  The previous contents are kept as `config.json.bak`.
- Overrides that are already present are skipped, so a retry cannot create duplicates,
  and a rewrite that loses platforms or accessories is refused outright.

## Troubleshooting

**No accessories in HomeKit after installing.** Expected on a first run — discovered groups
are written to `config.json` disabled. See [First Run](#first-run).

**A group is enabled but still missing.** Check the override has a `type` — one without it is
ignored, and the log says `Ignoring group override`. Then check `maxAccessories` is not capping
the list, and look for `Skipping duplicate address` or a placeholder name in
[What Gets Discovered](#what-gets-discovered).

**`Failed during device discovery` in the log.** C-Gate answered but the project database
could not be read. Usually a wrong `project`, or C-Gate still loading. The plugin keeps your
accessories and retries every 60 seconds — no action needed beyond fixing the name.

**`Refusing to remove N of M cached accessories`.** A safety net, not a failure. Check
`cgate.host` and `cgate.project` first; only set `allowBulkRemoval` if you really did
decommission that many groups.

**Accessories show as "No Response".** The C-Gate link is down. The log shows
`C-Gate connection lost` and the plugin reconnects on its own; check the C-Gate host, the
three ports, and `access-control.txt`.

**A temperature sensor reads 0°C.** It has not reported yet, or `channel` is missing or wrong.
A missing one is logged as `has no "channel" — it will register but never report a reading`.
To find the right value, enable the [HTTP Commander](#http-commander) and watch `/events` for
`measurement data` lines, which carry the device and channel numbers actually being broadcast.

**`Commander port N is already in use`.** Another process has the port; pick a different one.
The rest of the plugin is unaffected.

**Levels look right in C-Bus but wrong in the Home app.** Brightness is rounded through
0–255 ↔ 0–100 conversion, so 1% steps will not always round-trip exactly.

## Development

```shell
# Clone the repo
git clone https://github.com/rbhr/homebridge-spacelogic.git
cd homebridge-spacelogic

# Install dependencies
npm install

# Build
npm run build

# Lint
npm run lint

# Test
npm test

# Link for development
npm link

# Watch mode (auto-rebuild + restart)
npm run watch
```

Configure your development instance in `test/hbConfig/config.json` (used by `npm run watch`;
unrelated to the test suite).

### Tests

`npm test` compiles `src` and `tests` together and runs the recovery suite with the Node
built-in test runner. The tests drive a real TCP fake C-Gate on all three ports rather than a
mock, because every bug they exist to catch is a socket lifecycle bug — so the suite takes
about 30 seconds, most of it waiting out genuine reconnect backoff. See
[`tests/README.md`](tests/README.md) for the helpers and how to check a test is load-bearing.

CI runs lint, build and tests on Node 20, 22 and 24 for every push and pull request.

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

`prepublishOnly` runs lint, build and the test suite, so a publish fails rather than shipping
a broken build.

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
