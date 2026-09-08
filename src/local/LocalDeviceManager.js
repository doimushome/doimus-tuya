const {
  isIRControlHub,
  isIRRemoteControl,
} = require('../shared/TuyaDevice');
const TuyaDeviceManager = require('../shared/TuyaDeviceManager');
const TuyaDiscovery = require('./TuyaDiscovery');
const LocalDevice = require('./LocalDevice');

const DEFAULT_DP_MAP = {
  switch_1: 1,
  switch_2: 2,
  switch_3: 3,
  switch_4: 4,
  bright_value: 2,
  bright_value_v2: 22,
  temp_value: 3,
  temp_value_v2: 23,
  work_mode: 2,
  colour_data: 5,
  colour_data_v2: 24,
  switch_led: 1,
  countdown_1: 9,
};

class LocalDeviceManager extends TuyaDeviceManager {
  constructor(localConfig, debug = false, logFn) {
    const stubApi = {
      log: () => {},
      get: async () => ({ success: false }),
      post: async () => ({ success: false }),
    };
    super(stubApi, debug);
    this.localConfig = localConfig || {};
    this.debug = debug;
    this.log = new (require('../shared/Logger').PrefixLogger)(
      logFn || console.log,
      'LocalDeviceManager',
      debug,
    );
    this.discovery = new TuyaDiscovery(this.log, debug);
    this.localDevices = new Map();
    this.discoveredDevices = new Map();
    this._discoveryTimer = null;
    this._discoveryPhaseActive = false;

    this.discovery.on('discover', (result) => this._onDiscovered(result));
  }

  async pullDevices() {
    this.initLocalDevices();
    await this._startDiscoveryPhase();
    this.connectAllDevices();
    this._scheduleRediscovery();
    return this.devices;
  }

  _scheduleRediscovery() {
    const interval = this.localConfig.rediscoverInterval;
    if (!interval || interval <= 0) return;
    this._rediscoveryTimer = setTimeout(() => {
      this.log.info('Rediscovering devices...');
      this.pullDevices();
    }, interval * 1000);
  }

  initLocalDevices() {
    const devices = this.localConfig.devices || [];
    for (const cfg of devices) {
      this._registerDeviceConfig(cfg);
    }
    if (this.localConfig.autoDiscoverDevices !== false) {
      this.discovery.start();
    }
  }

  stopLocalDevices() {
    this.discovery.stop();
    for (const [id, device] of this.localDevices) {
      device.disconnect();
    }
    this.localDevices.clear();
    if (this._discoveryTimer) {
      clearTimeout(this._discoveryTimer);
      this._discoveryTimer = null;
    }
    if (this._rediscoveryTimer) {
      clearTimeout(this._rediscoveryTimer);
      this._rediscoveryTimer = null;
    }
  }

  _registerDeviceConfig(cfg) {
    cfg.id = cfg.tuyaDeviceId || cfg.id;
    cfg.key = cfg.tuyaKey || cfg.key;
    cfg.version = cfg.protocolVersion || cfg.version;
    const existing = this.devices.find((d) => d.id === cfg.id);
    if (existing) return;

    const device = this._buildTuyaDevice(cfg);
    this.devices.push(device);
    this.emit(TuyaDeviceManager.Events.DEVICE_ADD, device);
  }

  _buildTuyaDevice(cfg) {
    const dpMapping = cfg.dpMapping || DEFAULT_DP_MAP;
    const switchCount = cfg.switchCount || 1;
    const schema = cfg.schema || this._buildSyntheticSchema(cfg, dpMapping, switchCount);

    const device = {
      id: cfg.id,
      name: cfg.name || cfg.id,
      local_key: cfg.key,
      ip: cfg.ip,
      version: cfg.version || '3.1',
      online: false,
      category: cfg.category || 'switch',
      product_id: cfg.productId || '',
      schema,
      status: schema.map((s) => ({
        code: s.code,
        value: s.type === 'Boolean' ? false : s.type === 'Integer' ? 0 : '',
      })),
    };
    device.status.sort((a, b) => (a.code > b.code ? 1 : -1));

    return device;
  }

  _buildSyntheticSchema(device, dpMapping, switchCount) {
    const schema = [];

    const codeToDp = {};
    const dpToCode = {};
    for (const [code, dp] of Object.entries(dpMapping)) {
      codeToDp[code] = dp;
      dpToCode[dp] = code;
    }

    if (dpMapping.switch_1 || dpMapping.switch_led) {
      const switchCode = dpMapping.switch_led ? 'switch_led' : 'switch_1';
      schema.push({
        code: switchCode,
        mode: 'rw',
        type: 'Boolean',
        property: {},
      });
    }

    for (let i = 2; i <= switchCount; i++) {
      const code = `switch_${i}`;
      if (dpMapping[code]) {
        schema.push({
          code,
          mode: 'rw',
          type: 'Boolean',
          property: {},
        });
      }
    }

    if (dpMapping.bright_value || dpMapping.bright_value_v2) {
      const code = dpMapping.bright_value_v2 ? 'bright_value_v2' : 'bright_value';
      schema.push({
        code,
        mode: 'rw',
        type: 'Integer',
        property: { min: 0, max: 1000, scale: 0 },
      });
    }

    if (dpMapping.temp_value || dpMapping.temp_value_v2) {
      const code = dpMapping.temp_value_v2 ? 'temp_value_v2' : 'temp_value';
      schema.push({
        code,
        mode: 'rw',
        type: 'Integer',
        property: { min: 0, max: 1000, scale: 0 },
      });
    }

    if (dpMapping.work_mode) {
      schema.push({
        code: 'work_mode',
        mode: 'rw',
        type: 'Enum',
        property: { range: ['white', 'colour', 'scene', 'music'] },
      });
    }

    if (dpMapping.colour_data || dpMapping.colour_data_v2) {
      const code = dpMapping.colour_data_v2 ? 'colour_data_v2' : 'colour_data';
      schema.push({
        code,
        mode: 'rw',
        type: 'Json',
        property: {},
      });
    }

    if (dpMapping.countdown_1) {
      schema.push({
        code: 'countdown_1',
        mode: 'rw',
        type: 'Integer',
        property: { min: 0, max: 86400, scale: 0 },
      });
    }

    schema.sort((a, b) => a.code > b.code ? 1 : -1);
    return schema;
  }

  _createConnection(deviceID) {
    const device = this.getDevice(deviceID);
    if (!device) return null;

    if (this.localDevices.has(deviceID)) {
      return this.localDevices.get(deviceID);
    }

    const localDevice = new LocalDevice({
      id: device.id,
      key: device.local_key ? Buffer.from(device.local_key, 'hex') : Buffer.alloc(0),
      ip: device.ip,
      version: device.version || '3.1',
      name: device.name,
      log: this.log,
    });

    localDevice.on('connect', () => {
      device.online = true;
      this.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device, { online: true });
    });

    localDevice.on('disconnect', () => {
      device.online = false;
      this.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device, { online: false });
    });

    localDevice.on('change', (changed) => {
      const status = [];
      for (const [key, value] of Object.entries(changed)) {
        status.push({ code: key, value });
        const statusItem = device.status.find((s) => s.code === key);
        if (statusItem) {
          statusItem.value = value;
        } else {
          device.status.push({ code: key, value });
        }
      }
      this.emit(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, device, status);
    });

    localDevice.on('error', (err) => {
      this.log.warn('Local device error %s: %s', deviceID, err.message);
    });

    this.localDevices.set(deviceID, localDevice);
    localDevice.connect();
    return localDevice;
  }

  _onDiscovered(result) {
    const key = `${result.id}:${result.ip}`;
    if (this.discoveredDevices.has(key)) return;
    this.discoveredDevices.set(key, result);

    const existing = this.getDevice(result.id);
    if (existing) {
      existing.ip = result.ip;
      existing.version = result.version;
      return;
    }

    const cfg = {
      id: result.id,
      ip: result.ip,
      version: result.version || '3.1',
      name: result.id,
      key: '',
    };
    this._registerDeviceConfig(cfg);
  }

  _startDiscoveryPhase() {
    return new Promise((resolve) => {
      const timeout = (this.localConfig.discoverTimeout || 30) * 1000;
      this._discoveryPhaseActive = true;
      this._discoveryTimer = setTimeout(() => {
        this._discoveryPhaseActive = false;
        resolve();
      }, timeout);
    });
  }

  connectAllDevices() {
    for (const device of this.devices) {
      if (device.local_key && device.ip) {
        this._createConnection(device.id);
      }
    }
  }

  async sendCommands(deviceID, commands) {
    const device = this.getDevice(deviceID);
    if (!device) {
      this.log.warn('sendCommands: unknown device %s', deviceID);
      return;
    }

    const localDevice = this.localDevices.get(deviceID);
    if (!localDevice || !localDevice.connected) {
      this.log.warn('sendCommands: %s not connected', deviceID);
      return;
    }

    const dpMap = this._getDpMap(device);
    const dpUpdates = {};

    for (const cmd of commands) {
      const dp = dpMap[cmd.code];
      if (dp != null) {
        dpUpdates[dp] = cmd.value;
      }
    }

    if (Object.keys(dpUpdates).length > 0) {
      localDevice.update(dpUpdates);
    }
  }

  getDevice(deviceID) {
    return Array.from(this.devices).find((d) => d.id === deviceID);
  }

  getDeviceConfig(device) {
    const configs = this.localConfig.devices || [];
    return configs.find((c) => c.id === device.id);
  }

  _getDpMap(device) {
    const config = this.getDeviceConfig(device);
    if (config && config.dpMapping) {
      return config.dpMapping;
    }
    return DEFAULT_DP_MAP;
  }
}

module.exports = LocalDeviceManager;
