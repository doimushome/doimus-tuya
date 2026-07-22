const { encryptECB, decryptECB, encryptECBNoPad, decryptECBNoPad, NO_VERSION_HEADER_CMDS, packMessage55AA, unpackMessage55AA, isFrameComplete, extractFrame, buildKeyExchangeStep1 } = require('./ProtocolUtilities');

class ProtocolV34 {
  constructor() {
    this.sessionKey = null;
  }

  encodeFrame(cmd, data, seqNo, sessionKey, deviceKey) {
    const key = sessionKey || this.sessionKey || deviceKey;
    const encrypted = encryptECB(data, key);
    let payload;
    if (NO_VERSION_HEADER_CMDS.has(cmd)) {
      payload = encrypted;
    } else {
      const versionHeader = Buffer.alloc(16);
      versionHeader.write('3.4', 0, 3, 'utf8');
      payload = Buffer.concat([versionHeader, encrypted]);
    }
    return packMessage55AA(seqNo || 0, cmd, payload, key);
  }

  decodeFrame(frame, deviceKey, sessionKey) {
    const key = sessionKey || this.sessionKey || deviceKey;
    const result = unpackMessage55AA(frame, key, true);
    if (!result) return null;
    let encrypted = result.payload;
    if (!NO_VERSION_HEADER_CMDS.has(result.cmd)) {
      if (result.payload.length < 16) return null;
      const versionStr = result.payload.subarray(0, 3).toString('utf8');
      if (versionStr !== '3.4') return null;
      encrypted = result.payload.subarray(16);
    }
    try {
      const decrypted = decryptECB(encrypted, key);
      return { ...result, payload: decrypted };
    } catch (_) {
      return null;
    }
  }

  isFrameComplete(buffer) {
    return isFrameComplete(buffer);
  }

  extractFrame(buffer) {
    return extractFrame(buffer);
  }

  buildKeyExchangeStep1(localNonce, deviceKey) {
    return buildKeyExchangeStep1(localNonce, deviceKey);
  }

  processKeyExchangeStep2(step2Payload, localNonce, realKey) {
    const remoteNonce = decryptECBNoPad(step2Payload, realKey);
    const xored = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      xored[i] = localNonce[i] ^ remoteNonce[i];
    }
    this.sessionKey = encryptECBNoPad(xored, realKey);
    return this.sessionKey;
  }
}

module.exports = ProtocolV34;
