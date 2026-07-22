const TuyaDeviceManager = require("./TuyaDeviceManager");

const LOCAL_FIRST_CATEGORIES = new Set([
  "switch", "outlet", "light", "fan", "blind", "lock",
  "sensor", "thermostat",
]);

class TuyaHybridDeviceManager extends TuyaDeviceManager {
  constructor(cloudDM, localDM, debugMode = false) {
    super(cloudDM.api, debugMode);
    this.cloudDM = cloudDM;
    this.localDM = localDM;
    this._forwardEvents(cloudDM);
    this._forwardEvents(localDM);
  }

  _forwardEvents(dm) {
    for (const evt of Object.values(TuyaDeviceManager.Events)) {
      dm.on(evt, (...args) => this.emit(evt, ...args));
    }
  }

  get devices() {
    const seen = new Set();
    const merged = [];
    for (const device of this.localDM.devices) {
      merged.push(device);
      seen.add(device.id);
    }
    for (const device of this.cloudDM.devices) {
      if (!seen.has(device.id)) {
        merged.push(device);
        seen.add(device.id);
      }
    }
    return merged;
  }

  async pullDevices() {
    await Promise.all([
      this.cloudDM.pullDevices(),
      this.localDM.pullDevices(),
    ]);
    this._enrichLocalFromCloud();
    return this.devices;
  }

  _enrichLocalFromCloud() {
    for (const cloudDev of this.cloudDM.devices) {
      const localDev = this.localDM.getDevice(cloudDev.id);
      if (localDev && cloudDev.local_key) {
        if (!localDev.localKey) {
          localDev.localKey = cloudDev.local_key;
        }
        if (!localDev.localVersion && cloudDev.local_version) {
          localDev.localVersion = cloudDev.local_version;
        }
      }
    }
  }

  getDevice(deviceID) {
    return this.localDM.getDevice(deviceID) || this.cloudDM.getDevice(deviceID);
  }

  async sendCommands(deviceID, commands) {
    const localDev = this.localDM.getDevice(deviceID);
    const isLocal = localDev && localDev.online;
    if (isLocal) {
      try {
        return await this.localDM.sendCommands(deviceID, commands);
      } catch (e) {
        this.log.warn(`Local command failed for ${deviceID}, falling back to cloud: ${e.message}`);
      }
    }
    return this.cloudDM.sendCommands(deviceID, commands);
  }

  stop() {
    this.cloudDM.stop();
    if (this.localDM.stopLocalDevices) {
      this.localDM.stopLocalDevices();
    }
  }
}

module.exports = TuyaHybridDeviceManager;
