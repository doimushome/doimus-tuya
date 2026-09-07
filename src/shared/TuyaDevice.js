class TuyaDevice {
  constructor(obj) {
    Object.assign(this, obj);
    this.status.sort((a, b) => (a.code > b.code ? 1 : -1));
  }

  isVirtualDevice() {
    return this.id != null && this.id.startsWith("vdevo");
  }

  isIRControlHub() {
    return ["wnykq", "hwktwkq", "wsdykq"].includes(this.category);
  }

  isIRRemoteControl() {
    return this.remote_keys !== undefined;
  }
}

module.exports = TuyaDevice;
