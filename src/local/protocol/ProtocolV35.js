const { encryptECBNoPad, decryptECBNoPad, encryptGCM, NO_VERSION_HEADER_CMDS, packMessage6699, unpackMessage6699, isFrameComplete, extractFrame, buildKeyExchangeStep1 } = require('./ProtocolUtilities');

class ProtocolV35 {
  constructor() {
    this.sessionKey = null;
  }

  encodeFrame(cmd, data, seqNo, sessionKey, deviceKey) {
    const key = sessionKey || this.sessionKey || deviceKey;
    if (NO_VERSION_HEADER_CMDS.has(cmd)) {
      return packMessage6699(seqNo || 0, cmd, data, key);
    }
    const versionHeader = Buffer.alloc(16);
    versionHeader.write('3.5', 0, 3, 'utf8');
    const plaintext = Buffer.concat([versionHeader, data]);
    return packMessage6699(seqNo || 0, cmd, plaintext, key);
  }

  decodeFrame(frame, deviceKey, sessionKey) {
    const key = sessionKey || this.sessionKey || deviceKey;
    const result = unpackMessage6699(frame, key);
    if (!result) return null;
    if (result.payload === null) return result;
    let payload = result.payload;
    if (!NO_VERSION_HEADER_CMDS.has(result.cmd)) {
      if (payload.length >= 16) {
        const versionStr = payload.subarray(0, 3).toString('utf8');
        if (versionStr === '3.5') {
          payload = payload.subarray(16);
        }
      }
    }
    return { ...result, payload };
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
    const iv = Buffer.from(localNonce.subarray(0, 12));
    const { ciphertext } = encryptGCM(xored, realKey, iv);
    this.sessionKey = ciphertext.subarray(0, 16);
    return this.sessionKey;
  }
}

module.exports = ProtocolV35;
