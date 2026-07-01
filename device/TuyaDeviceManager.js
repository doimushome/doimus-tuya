const EventEmitter = require("events");
const TuyaOpenMQ = require("../core/TuyaOpenMQ");
const { PrefixLogger } = require("../util/Logger");
const TuyaDevice = require("./TuyaDevice");

const Events = {
  DEVICE_ADD: "DEVICE_ADD",
  DEVICE_INFO_UPDATE: "DEVICE_INFO_UPDATE",
  DEVICE_STATUS_UPDATE: "DEVICE_STATUS_UPDATE",
  DEVICE_DELETE: "DEVICE_DELETE",
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
    this.mq = new TuyaOpenMQ(api, this.log, debug);
    this.mq.addMessageListener(this.onMQTTMessage.bind(this));
  }

  getDevice(deviceID) {
    return Array.from(this.devices).find((device) => device.id === deviceID);
  }

  async updateDevices(ownerIDs) {
    return [];
  }

  async updateDevice(deviceID) {
    const res = await this.getDeviceInfo(deviceID);
    if (!res.success) return null;
    const device = new TuyaDevice(res.result);
    device.schema = await this.getDeviceSchema(deviceID);
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

  async getDeviceListInfo(deviceIDs = []) {
    return this.api.get("/v1.0/devices", { device_ids: deviceIDs.join(",") });
  }

  async getDeviceSchema(deviceID) {
    const res = await this.api.get(`/v1.0/devices/${deviceID}/specifications`);
    if (res.success === false) {
      this.log.warn(
        "Get device specification failed. devId = %s, code = %s, msg = %s",
        deviceID,
        res.code,
        res.msg,
      );
      return [];
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
      } catch (_) {}
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
    const irDevices = allDevices.filter((device) => device.isIRControlHub());
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
            if (
              [
                "movement_detect_pic",
                "doorbell_pic",
                "ipc_human",
                "pir",
                "motion_sensor",
                "motion_detect",
              ].includes(item.code)
            ) {
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
