const EventEmitter = require("events");
const TuyaOpenMQ = require("../cloud/api/TuyaOpenMQ");
const { PrefixLogger } = require("./Logger");
const { isIRControlHub, isIRRemoteControl } = require("./TuyaDevice");

const Events = {
  DEVICE_ADD: "DEVICE_ADD",
  DEVICE_INFO_UPDATE: "DEVICE_INFO_UPDATE",
  DEVICE_STATUS_UPDATE: "DEVICE_STATUS_UPDATE",
  DEVICE_DELETE: "DEVICE_DELETE",
};

// Category fallback DPs used when the Tuya specifications API refuses a device
// (e.g. code=2009 "not support this device", common on mobilecam cameras such
// as the Magic S1). These follow the standard Tuya DP conventions so the
// device still gets meaningful capabilities and command targets without specs.
const CATEGORY_FALLBACK_SCHEMAS = {
  mobilecam: [
    { code: "basic_led", type: "Boolean" },
    { code: "basic_indicator", type: "Boolean" },
    { code: "basic_private", type: "Boolean" },
    { code: "basic_flip", type: "Enum" },
    { code: "basic_nightvision", type: "Enum" },
    { code: "basic_osd", type: "Boolean" },
    { code: "basic_lock", type: "Boolean" },
    { code: "basic_motion", type: "Boolean" },
    { code: "motion_tracking", type: "Boolean" },
    { code: "record_switch", type: "Boolean" },
    { code: "ptz_control", type: "Enum" },
    { code: "ipc_work_mode", type: "Enum" },
    { code: "basic_device_volume", type: "Integer", property: { min: 0, max: 100, scale: 0 } },
  ],
  sp: [
    { code: "basic_indicator", type: "Boolean" },
    { code: "basic_private", type: "Boolean" },
    { code: "basic_flip", type: "Enum" },
    { code: "basic_nightvision", type: "Enum" },
    { code: "basic_osd", type: "Boolean" },
    { code: "basic_device_volume", type: "Integer", property: { min: 0, max: 100, scale: 0 } },
    { code: "pir_switch", type: "Boolean" },
    { code: "motion_record", type: "Boolean" },
    { code: "record_switch", type: "Boolean" },
    { code: "record_mode", type: "Enum" },
    { code: "record_loop", type: "Enum" },
    { code: "ipc_work_mode", type: "Enum" },
    { code: "humanoid_filter", type: "Boolean" },
  ],
  doorbell: [
    { code: "basic_indicator", type: "Boolean" },
    { code: "basic_private", type: "Boolean" },
    { code: "basic_flip", type: "Enum" },
    { code: "basic_nightvision", type: "Enum" },
    { code: "basic_osd", type: "Boolean" },
    { code: "basic_device_volume", type: "Integer", property: { min: 0, max: 100, scale: 0 } },
    { code: "pir_switch", type: "Boolean" },
    { code: "motion_record", type: "Boolean" },
    { code: "record_switch", type: "Boolean" },
    { code: "ipc_work_mode", type: "Enum" },
  ],
  wxml: [
    { code: "basic_indicator", type: "Boolean" },
    { code: "basic_private", type: "Boolean" },
    { code: "basic_nightvision", type: "Enum" },
    { code: "basic_osd", type: "Boolean" },
    { code: "pir_switch", type: "Boolean" },
    { code: "record_switch", type: "Boolean" },
  ],
  ipc: [
    { code: "basic_led", type: "Boolean" },
    { code: "basic_private", type: "Boolean" },
    { code: "basic_flip", type: "Enum" },
    { code: "basic_nightvision", type: "Enum" },
    { code: "basic_osd", type: "Boolean" },
    { code: "basic_lock", type: "Boolean" },
    { code: "basic_motion", type: "Boolean" },
    { code: "motion_tracking", type: "Boolean" },
    { code: "record_switch", type: "Boolean" },
    { code: "ptz_control", type: "Enum" },
    { code: "ipc_work_mode", type: "Enum" },
    { code: "basic_device_volume", type: "Integer", property: { min: 0, max: 100, scale: 0 } },
  ],
};

const TuyaMQTTProtocol = {
  DEVICE_STATUS_UPDATE: 4,
  DEVICE_INFO_UPDATE: 20,
};

class TuyaDeviceManager extends EventEmitter {
  constructor(api, debug = false) {
    super();
    this.api = api;
    this.debug = debug;
    this.ownerIDs = [];
    this.devices = [];
    const log = this.api.log;
    this.log = new PrefixLogger(log, "TuyaDeviceManager", debug);
    this.mq = new TuyaOpenMQ(api, this.log, debug, api.forceIPv4 || false);
    this.mq.addMessageListener(this.onMQTTMessage.bind(this));
  }

  getDevice(deviceID) {
    return Array.from(this.devices).find((device) => device.id === deviceID);
  }

  async updateDevice(deviceID) {
    const res = await this.getDeviceInfo(deviceID);
    if (!res.success) return null;
    const device = Object.assign({}, res.result);
    device.status.sort((a, b) => (a.code > b.code ? 1 : -1));
    device.schema = await this.getDeviceSchema(deviceID, device);
    const oldDevice = this.getDevice(deviceID);
    if (oldDevice) {
      this.devices.splice(this.devices.indexOf(oldDevice), 1);
    }
    this.devices.push(device);
    return device;
  }

  async getDeviceInfo(deviceID) {
    return this.api.get(`/v1.0/devices/${deviceID}`);
  }

  async getDeviceSchema(deviceID, device = null) {
    // suppressErrorLog: failure is expected for devices that refuse the specs
    // API — getDeviceSchema logs at debug and builds a fallback schema itself.
    const res = await this.api.get(`/v1.0/devices/${deviceID}/specifications`, null, {
      suppressErrorLog: true,
    });
    if (res.success === false) {
      // Expected for devices that refuse the specifications API (e.g. Magic S1).
      // The fallback schema is the designed path — log at debug to avoid noise.
      this.log.debug(
        "Get device specification failed. devId = %s, code = %s, msg = %s",
        deviceID,
        res.code,
        res.msg,
      );
      return this.buildFallbackSchema(device);
    }

    const schemas = new Map();
    for (const { code, type, values } of [
      ...(res.result.status || []),
      ...(res.result.functions || []),
    ]) {
      if (schemas[code]) continue;

      const read =
        (res.result.status || []).find((s) => s.code === code) !== undefined;
      const write =
        (res.result.functions || []).find((s) => s.code === code) !== undefined;
      let mode = "rw";
      if (read && write) mode = "rw";
      else if (read && !write) mode = "ro";
      else if (!read && write) mode = "wo";

      try {
        const property = JSON.parse(values);
        schemas[code] = { code, mode, type, property };
      } catch (_) { /* invalid property JSON — skip */ }
    }

    return Object.values(schemas).sort((a, b) => (a.code > b.code ? 1 : -1));
  }

  // buildFallbackSchema produces a best-effort schema for devices whose
  // specifications endpoint is unavailable. Read-only entries are derived from
  // the DPs the device actually reports; known-writable codes come from the
  // category table above. Duplicates keep the most useful (rw) mode.
  buildFallbackSchema(device) {
    if (!device) return [];

    const schemas = new Map();
    const categoryDefaults = CATEGORY_FALLBACK_SCHEMAS[device.category] || [];

    for (const dp of categoryDefaults) {
      schemas[dp.code] = { code: dp.code, mode: "rw", type: dp.type, property: dp.property || {} };
    }

    for (const s of device.status || []) {
      if (schemas[s.code]) continue;
      const type = typeof s.value === "number" ? "Integer" : typeof s.value === "boolean" ? "Boolean" : "String";
      schemas[s.code] = { code: s.code, mode: "ro", type, property: {} };
    }

    return Object.values(schemas).sort((a, b) => (a.code > b.code ? 1 : -1));
  }

  async getInfraredRemotes(infraredID) {
    return this.api.get(`/v2.0/infrareds/${infraredID}/remotes`);
  }

  async getInfraredKeys(infraredID, remoteID) {
    return this.api.get(
      `/v2.0/infrareds/${infraredID}/remotes/${remoteID}/keys`,
    );
  }

  async getInfraredACStatus(infraredID, remoteID) {
    return this.api.get(
      `/v2.0/infrareds/${infraredID}/remotes/${remoteID}/ac/status`,
    );
  }

  async getInfraredDIYKeys(infraredID, remoteID) {
    return this.api.get(
      `/v2.0/infrareds/${infraredID}/remotes/${remoteID}/learning-codes`,
    );
  }

  async updateInfraredRemotes(allDevices) {
    const irDevices = allDevices.filter((device) => isIRControlHub(device));
    for (const irDevice of irDevices) {
      const res = await this.getInfraredRemotes(irDevice.id);
      if (!res.success) {
        this.log.warn(
          "Get infrared remotes failed. deviceId = %d, code = %s, msg = %s",
          irDevice.id,
          res.code,
          res.msg,
        );
        continue;
      }

      for (const { category_id, remote_id } of res.result) {
        const subDevice = allDevices.find((d) => d.id === remote_id);
        if (!subDevice) continue;

        subDevice.parent_id = irDevice.id;
        subDevice.schema = [];

        const keysRes = await this.getInfraredKeys(irDevice.id, subDevice.id);
        if (!keysRes.success) {
          this.log.warn(
            "Get infrared remote keys failed. deviceId = %d, code = %s, msg = %s",
            subDevice.id,
            keysRes.code,
            keysRes.msg,
          );
          continue;
        }
        subDevice.remote_keys = keysRes.result;

        if (subDevice.category === "infrared_ac") {
          const acRes = await this.getInfraredACStatus(
            irDevice.id,
            subDevice.id,
          );
          if (acRes.success) {
            subDevice.status = Object.entries(acRes.result).map(
              ([key, value]) => ({ code: key, value }),
            );
          }
        } else if (category_id === 999) {
          const diyRes = await this.getInfraredDIYKeys(
            irDevice.id,
            subDevice.id,
          );
          if (diyRes.success && subDevice.remote_keys) {
            for (const key of subDevice.remote_keys.key_list || []) {
              const item = (diyRes.result || []).find(
                (i) => i.id === key.key_id && i.key === key.key,
              );
              if (item) key.learning_code = item.code;
            }
          }
        }
      }
    }
  }

  async sendInfraredCommands(
    infraredID,
    remoteID,
    category_id,
    remote_index,
    key,
    key_id,
  ) {
    return this.api.post(
      `/v2.0/infrareds/${infraredID}/remotes/${remoteID}/raw/command`,
      {
        category_id,
        remote_index,
        key,
        key_id,
      },
    );
  }

  async sendInfraredACCommands(infraredID, remoteID, power, mode, temp, wind) {
    const commands = power === 1 ? { power, mode, temp, wind } : { power };
    return this.api.post(
      `/v2.0/infrareds/${infraredID}/air-conditioners/${remoteID}/scenes/command`,
      commands,
    );
  }

  async sendInfraredDIYCommands(infraredID, remoteID, code) {
    return this.api.post(
      `/v2.0/infrareds/${infraredID}/remotes/${remoteID}/learning-codes`,
      { code },
    );
  }

  async getLockTemporaryKey(deviceID) {
    const res = await this.api.post(
      `/v1.0/smart-lock/devices/${deviceID}/password-ticket`,
    );
    if (res.success === false) {
      this.log.warn(
        "Get Temporary Pass failed. devID = %s, code = %s, msg = %s",
        deviceID,
        res.code,
        res.msg,
      );
    }
    return res;
  }

  async sendLockCommands(deviceID, ticketID, open) {
    return this.api.post(
      `/v1.0/smart-lock/devices/${deviceID}/password-free/door-operate`,
      {
        device_id: deviceID,
        ticket_id: ticketID,
        open,
      },
    );
  }

  async sendCommands(deviceID, commands) {
    const res = await this.api.post(`/v1.0/devices/${deviceID}/commands`, {
      commands,
    });
    return res.result;
  }

  async onMQTTMessage(topic, protocol, message) {
    switch (protocol) {
      case TuyaMQTTProtocol.DEVICE_STATUS_UPDATE: {
        const { devId, status } = message;
        const device = this.getDevice(devId);
        if (!device) {
          this.log.warn(
            "MQTT status update for unknown device: devId=%s (not yet fetched?)",
            devId,
          );
          return;
        }
        for (const item of device.status) {
          const _item = status.find((s) => s.code === item.code);
          if (!_item) {
            // Clear transient camera/doorbell DPs that are absent from this
            // update. These DPs only appear when an event is active; when
            // absent, the event has ended but device.status retains the old
            // value indefinitely, causing perpetual motion/doorbell state.
            const motionPattern = /motion|movement|doorbell|human|person|pir/i;
            if (motionPattern.test(item.code)) {
              item.value = "";
            }
            continue;
          }
          item.value = _item.value;
        }
        // Add new DPs from the MQTT update that aren't yet in device.status
        // (e.g. initiative_message, or movement_detect_pic arriving for the
        // first time on a doorbell device whose initial status snapshot didn't
        // include it). Without this, transient DPs never enter device.status
        // and the auto-reset motion logic in mapTuyaStatusToDoimusState can't
        // detect them.
        for (const newItem of status) {
          if (!device.status.some((s) => s.code === newItem.code)) {
            device.status.push({ code: newItem.code, value: newItem.value });
          }
        }
        this.log.debug("MQTT status update: devId=%s status=%o", devId, status);
        this.emit(Events.DEVICE_STATUS_UPDATE, device, status);
        break;
      }
      case TuyaMQTTProtocol.DEVICE_INFO_UPDATE: {
        const { bizCode, bizData, devId } = message;
        if (bizCode === "bindUser") {
          const { ownerId } = bizData;
          if (!this.ownerIDs.includes(ownerId)) {
            this.log.warn(
              "Update devId = %s not included in your ownerIDs. Skip.",
              devId,
            );
            return;
          }
          await new Promise((r) => setTimeout(r, 10000));
          if (!this.mq.running) return; // plugin stopped during delay
          const device = await this.updateDevice(devId);
          if (!device) return;
          this.mq.start();
          this.emit(Events.DEVICE_ADD, device);
        } else if (bizCode === "nameUpdate") {
          const device = this.getDevice(devId);
          if (!device) return;
          device.name = bizData.name;
          this.emit(Events.DEVICE_INFO_UPDATE, device, bizData);
        } else if (bizCode === "online" || bizCode === "offline") {
          const device = this.getDevice(devId);
          if (!device) return;
          device.online = bizCode === "online";
          this.emit(Events.DEVICE_INFO_UPDATE, device, bizData);
        } else if (bizCode === "delete") {
          const { ownerId } = bizData;
          if (!this.ownerIDs.includes(ownerId)) return;
          const device = this.getDevice(devId);
          if (!device) return;
          this.devices.splice(this.devices.indexOf(device), 1);
          this.emit(Events.DEVICE_DELETE, devId);
        }
        break;
      }
      default:
        this.log.warn(
          "Unhandled mqtt message: protocol = %s, message = %o",
          protocol,
          message,
        );
        break;
    }
  }
}

TuyaDeviceManager.Events = Events;
module.exports = TuyaDeviceManager;
