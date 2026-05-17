const TuyaDevice = require("./TuyaDevice");
const TuyaDeviceManager = require("./TuyaDeviceManager");

class TuyaHomeDeviceManager extends TuyaDeviceManager {
  async getHomeList() {
    return this.api.get(`/v1.0/users/${this.api.tokenInfo.uid}/homes`);
  }

  async getHomeDeviceList(homeID) {
    return this.api.get(`/v1.0/homes/${homeID}/devices`);
  }

  async updateDevices(homeIDList) {
    let devices = [];
    for (const homeID of homeIDList) {
      const res = await this.getHomeDeviceList(homeID);
      devices = devices.concat((res.result || []).map((obj) => new TuyaDevice(obj)));
    }

    if (devices.length === 0) return [];

    for (const device of devices) {
      device.schema = await this.getDeviceSchema(device.id);
    }

    this.devices = devices;
    return devices;
  }

  async getSceneList(homeID) {
    const res = await this.api.get(`/v1.1/homes/${homeID}/scenes`);
    if (res.success === false) {
      this.log.warn("Get scene list failed. homeId = %d, code = %s, msg = %s", homeID, res.code, res.msg);
      return [];
    }

    const scenes = [];
    for (const { scene_id, name, enabled, status } of res.result || []) {
      if (enabled !== true || status !== "1") continue;
      scenes.push(new TuyaDevice({
        id: scene_id,
        uuid: scene_id,
        name,
        owner_id: homeID.toString(),
        product_id: "scene",
        category: "scene",
        schema: [],
        status: [],
        online: true,
      }));
    }
    return scenes;
  }

  async executeScene(homeID, sceneID) {
    return this.api.post(`/v1.0/homes/${homeID}/scenes/${sceneID}/trigger`);
  }
}

module.exports = TuyaHomeDeviceManager;
