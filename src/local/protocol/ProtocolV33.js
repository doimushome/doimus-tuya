const { encryptECB, decryptECB, NO_VERSION_HEADER_CMDS, packMessage55AA, unpackMessage55AA, isFrameComplete, extractFrame } = require('./ProtocolUtilities');

class ProtocolV33 {
  encodeFrame(cmd, data, seqNo, sessionKey, deviceKey) {
    const encrypted = encryptECB(data, deviceKey);
    let payload;
    if (NO_VERSION_HEADER_CMDS.has(cmd)) {
      payload = encrypted;
    } else {
      const versionHeader = Buffer.alloc(16);
      versionHeader.write('3.3', 0, 3, 'utf8');
      payload = Buffer.concat([versionHeader, encrypted]);
    }
    return packMessage55AA(seqNo || 0, cmd, payload, null);
  }

  decodeFrame(frame, deviceKey, sessionKey) {
    const result = unpackMessage55AA(frame, null, true);
    if (!result) return null;
    let encrypted = result.payload;
    if (!NO_VERSION_HEADER_CMDS.has(result.cmd)) {
      if (result.payload.length < 16) return null;
      const versionStr = result.payload.subarray(0, 3).toString('utf8');
      if (versionStr !== '3.3') return null;
      encrypted = result.payload.subarray(16);
    }
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

module.exports = ProtocolV33;
