# doimus-tuya-platform

Doimus native plugin for Tuya / Smart Life cloud devices. Port of [`@0x5e/homebridge-tuya-platform`](https://github.com/0x5e/homebridge-tuya-platform) v1.7.0-beta.58.

Supports 76+ device categories: lights, switches, outlets, sensors, fans, thermostats, locks, blinds, cameras, doorbells, IR remote controls, scenes, and power meters.

## Features

- Tuya Cloud API integration (both **Custom** and **Smart Home** project types)
- Real-time device updates via MQTT with AES decryption
- Device override configs — remap DP codes, transform values, hide devices/schemas
- Power meter monitoring — current (A), power (W), voltage (V), energy (kWh)
- Command debouncing to avoid Tuya API rate limits
- Config validation with duplicate detection
- Device list persistence for debugging
- Scene support (Tap-to-Run)

## Supported Device Categories

| Type | Categories |
|------|-----------|
| Light | `dj`, `dsd`, `xdd`, `fwd`, `dc`, `dd`, `gyd`, `tyndj`, `sxd`, `tgq`, `tgkg`, `bzyd` |
| Switch | `dlq`, `kg`, `tdq`, `qjdcz`, `szjqr`, `wxkg`, `cjkg`, `wxky`, `cwwsq`, `msp`, `xxj`, `yyj`, `ckmkzq`, `ggq`, `sfkzq`, `jsq`, `cs`, `qtwk` |
| Outlet | `cz`, `pc`, `wkcz` |
| Sensor | `ywbj`, `mcs`, `zd`, `rqbj`, `jwbj`, `sj`, `cobj`, `cocgq`, `co2bj`, `co2cgq`, `wsdcg`, `ldcg`, `ldzd`, `tx`, `hps`, `pir`, `mh`, `pm`, `pm25`, `dyl`, `sf`, `cw`, `sgbj`, `sos`, `mal`, `hjjcy` |
| Fan | `fs`, `fsd`, `fskg`, `kj` |
| Thermostat | `wk`, `wkf`, `qn` |
| Lock | `mk`, `ms` |
| Blind | `cl`, `clkg`, `mc` |
| Camera | `sp` |
| Doorbell | `doorbell`, `wxml` |

See [SUPPORTED_DEVICES.md](https://github.com/0x5e/homebridge-tuya-platform/blob/main/SUPPORTED_DEVICES.md) from the upstream project for the full list.

## Configuration

Before configuring, create a project at [Tuya IoT Platform](https://iot.tuya.com):

1. Create a cloud development project
2. Link your Tuya/Smart Life app account
3. Subscribe to required APIs on the Tuya IoT Platform (**Cloud → Development → Your Project → Service API**):

| API Service | Required for |
|---|---|
| **Authorization Token Management** | All projects (authentication) |
| **Device Status Notification** | All projects (MQTT real-time updates) |
| **IoT Core** | All projects (device listing, control, specifications) |
| **Industry Project Client Service** | Custom projects only (`projectType: 1`) |
| **Smart Home Scene Linkage** | Scene/Tap-to-Run support |
| **IoT Video Live Stream** | Camera live view (WebRTC), doorbell snapshots |
| **Camera Service** | Camera snapshot capture (`POST /v1.0/cameras/.../actions/capture`) |
| **IR Control Hub Open Service** | Infrared remote control devices |
| **Smart Lock Open Service** | Smart lock devices |

### Required Fields (Smart Home)

```
options.projectType: 2
options.accessId: <from Tuya IoT Platform>
options.accessKey: <from Tuya IoT Platform>
options.countryCode: <numeric country code>
options.username: <Tuya app account email>
options.password: <Tuya app account password>
options.appSchema: "tuyaSmart" or "smartlife"
```

### Required Fields (Custom)

```
options.projectType: 1
options.endpoint: <API endpoint URL>
options.accessId: <from Tuya IoT Platform>
options.accessKey: <from Tuya IoT Platform>
```

### Device Overrides

See [ADVANCED_OPTIONS.md](https://github.com/0x5e/homebridge-tuya-platform/blob/main/ADVANCED_OPTIONS.md) from the upstream project for device override configuration (remap DP codes, transform values, hide devices, etc.).

## Credits

This plugin is a Doimus-native port of [`@0x5e/homebridge-tuya-platform`](https://github.com/0x5e/homebridge-tuya-platform) v1.7.0-beta.58 by [0x5e](https://github.com/0x5e), which is itself a fork of the official [homebridge-tuya-platform](https://github.com/tuya/homebridge-tuya-platform) by Tuya.

The core API client (TuyaOpenAPI, TuyaOpenMQ) and device management layer are adapted from the upstream TypeScript source. The Homebridge accessory layer has been replaced with the Doimus native plugin API (`api.registerDevice`, `api.updateDeviceState`, `api.onCommand`).

- Upstream: https://github.com/0x5e/homebridge-tuya-platform
- Doimus: https://doimus.app
- Original Tuya plugin: https://github.com/tuya/homebridge-tuya-platform

## License

MIT
