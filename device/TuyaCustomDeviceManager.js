const TuyaDevice = require("./TuyaDevice");
const TuyaDeviceManager = require("./TuyaDeviceManager");

class TuyaCustomDeviceManager extends TuyaDeviceManager {
  constructor(api, debug = false) {
    super(api, debug);
    this.api = api;
    this.debug = debug;
    this.mq.version = "2.0";
  }

  async getAssetList(parent_asset_id = -1) {
    return this.api.get(`/v1.0/iot-02/assets/${parent_asset_id}/sub-assets`, {
      page_no: 0,
      page_size: 100,
    });
  }

  async authorizeAssetList(uid, asset_ids = [], authorized_children = false) {
    return this.api.post(`/v1.0/iot-03/users/${uid}/actions/batch-assets-authorized`, {
      asset_ids: asset_ids.join(","),
      authorized_children,
    });
  }

  async getAssetDeviceIDList(assetID) {
    let deviceIDs = [];
    const params = { page_size: 50 };
    while (true) {
      const res = await this.api.get(`/v1.0/iot-02/assets/${assetID}/devices`, params);
      deviceIDs = deviceIDs.concat((res.result.list || []).map((item) => item.device_id));
      params.last_row_key = res.result.last_row_key;
      if (!res.result.has_next) break;
    }
    return deviceIDs;
  }

  async updateDevices(assetIDList) {
    let deviceIDs = [];
    for (const assetID of assetIDList) {
      deviceIDs = deviceIDs.concat(await this.getAssetDeviceIDList(assetID));
    }

    if (deviceIDs.length === 0) return [];

    const res = await this.getDeviceListInfo(deviceIDs);
    const devices = (res.result.devices || []).map((obj) => new TuyaDevice(obj));

    for (const device of devices) {
      device.schema = await this.getDeviceSchema(device.id);
    }

    this.devices = devices;
    return devices;
  }
}

module.exports = TuyaCustomDeviceManager;
