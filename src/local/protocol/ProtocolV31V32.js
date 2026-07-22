const { encryptECB, decryptECB, packMessage55AA, unpackMessage55AA, isFrameComplete, extractFrame } = require('./ProtocolUtilities');

class ProtocolV31V32 {
  constructor(version) {
    this.version = version;
  }

  encodeFrame(cmd, data, seqNo, sessionKey, deviceKey) {
    let payload = data;
    if (this.version === '3.2') {
      const encrypted = encryptECB(data, deviceKey);
      const versionHeader = Buffer.alloc(16);
      versionHeader.write('3.2', 0, 3, 'utf8');
      payload = Buffer.concat([versionHeader, encrypted]);
    }
    return packMessage55AA(seqNo || 0, cmd, payload, null);
  }

  decodeFrame(frame, deviceKey, sessionKey) {
    const result = unpackMessage55AA(frame, null, true);
    if (!result) return null;
    if (this.version === '3.1') {
      return result;
    }
    if (result.payload.length < 16) return null;
    const versionStr = result.payload.subarray(0, 3).toString('utf8');
    if (versionStr !== '3.2') return null;
    const encrypted = result.payload.subarray(16);
    try {
      const decrypted = decryptECB(encrypted, deviceKey);
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
}

module.exports = ProtocolV31V32;
