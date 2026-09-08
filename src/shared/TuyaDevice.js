function isIRControlHub(device) {
  return ["wnykq", "hwktwkq", "wsdykq"].includes(device.category);
}

function isIRRemoteControl(device) {
  return device.remote_keys !== undefined;
}

module.exports = { isIRControlHub, isIRRemoteControl };
