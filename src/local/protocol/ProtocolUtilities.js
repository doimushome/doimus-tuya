const crypto = require('crypto');

const PREFIX_55AA = 0x000055AA;
const SUFFIX_55AA = 0x0000AA55;
const PREFIX_6699 = 0x00006699;
const SUFFIX_6699 = 0x00009966;

const HEADER_SIZE_55AA = 16;
const HEADER_SIZE_6699 = 18;

const NO_VERSION_HEADER_CMDS = new Set([3, 4, 5, 9, 0x0a, 0x10, 0x12, 0x40]);

function hmac(data, key) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function pkcs7Pad(data, blockSize) {
  const pad = blockSize - (data.length % blockSize);
  const buf = Buffer.alloc(data.length + pad);
  data.copy(buf);
  buf.fill(pad, data.length);
  return buf;
}

function pkcs7Unpad(data) {
  const pad = data[data.length - 1];
  if (pad > 0 && pad <= 16) {
    return data.subarray(0, data.length - pad);
  }
  return data;
}

function encryptECB(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
  const padded = pkcs7Pad(data, 16);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function decryptECB(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, '');
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return pkcs7Unpad(decrypted);
}

function encryptECBNoPad(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function decryptECBNoPad(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, '');
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function encryptGCM(data, key, iv, aad) {
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  if (aad) {
    cipher.setAAD(aad, { plaintextLength: data.length });
  }
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, authTag };
}

function decryptGCM(ciphertext, key, iv, authTag, aad) {
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
  decipher.setAuthTag(authTag);
  if (aad) {
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
  }
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

let crc32Table = null;

function makeCRC32Table() {
  crc32Table = Buffer.alloc(1024);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table.writeUInt32LE(c >>> 0, n * 4);
  }
}

function getCRC32(buf) {
  if (!crc32Table) {
    makeCRC32Table();
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table.readUInt32LE(((crc ^ buf[i]) & 0xff) * 4) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function packMessage55AA(seqno, cmd, payload, hmacKey) {
  const checksumLen = hmacKey ? 32 : 4;
  const length = payload.length + checksumLen + 4;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX_55AA, 0);
  header.writeUInt32BE(seqno, 4);
  header.writeUInt32BE(cmd, 8);
  header.writeUInt32BE(length, 12);
  const body = Buffer.concat([header, payload]);
  let checksum;
  if (hmacKey) {
    checksum = hmac(body, hmacKey);
  } else {
    const crcVal = getCRC32(body);
    checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crcVal, 0);
  }
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(SUFFIX_55AA, 0);
  return Buffer.concat([body, checksum, suffix]);
}

function unpackMessage55AA(data, hmacKey, noRetcode) {
  if (data.length < 16) return null;
  const prefix = data.readUInt32BE(0);
  if (prefix !== PREFIX_55AA) return null;
  const seqno = data.readUInt32BE(4);
  const cmd = data.readUInt32BE(8);
  const payloadLen = data.readUInt32BE(12);
  const checksumLen = hmacKey ? 32 : 4;
  const totalLen = 16 + payloadLen;
  if (data.length < totalLen) return null;
  const rawPayload = data.subarray(16, totalLen - checksumLen - 4);
  const body = data.subarray(0, 16 + rawPayload.length);
  const storedChecksum = data.subarray(totalLen - checksumLen - 4, totalLen - 4);
  let hmacOk = true;
  if (hmacKey) {
    const expectedHmac = hmac(body, hmacKey);
    hmacOk = storedChecksum.equals(expectedHmac);
  } else {
    const expectedCrc = getCRC32(body);
    const storedCrc = storedChecksum.readUInt32BE(0);
    hmacOk = expectedCrc === storedCrc;
  }
  const suffix = data.readUInt32BE(totalLen - 4);
  if (suffix !== SUFFIX_55AA) return null;
  let retcode = 0;
  let payload = rawPayload;
  if (!noRetcode && rawPayload.length >= 4) {
    retcode = rawPayload.readUInt32BE(0);
    payload = rawPayload.subarray(4);
  }
  return { seqno, cmd, retcode, payload, hmacOk };
}

function packMessage6699(seqno, cmd, plaintext, hmacKey) {
  const ivStr = String(Math.floor(Date.now() / 100)).slice(0, 12).padStart(12, '0');
  const iv = Buffer.from(ivStr, 'utf8');
  const length = 12 + plaintext.length + 16 + 4;
  const header = Buffer.alloc(18);
  header.writeUInt32BE(PREFIX_6699, 0);
  header.writeUInt16BE(0, 4);
  header.writeUInt32BE(seqno, 6);
  header.writeUInt32BE(cmd, 10);
  header.writeUInt32BE(length, 14);
  const aad = header.subarray(4, 18);
  const { ciphertext, authTag } = encryptGCM(plaintext, hmacKey, iv, aad);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(SUFFIX_6699, 0);
  return Buffer.concat([header, iv, ciphertext, authTag, suffix]);
}

function unpackMessage6699(data, hmacKey) {
  if (data.length < HEADER_SIZE_6699) return null;
  const prefix = data.readUInt32BE(0);
  if (prefix !== PREFIX_6699) return null;
  const seqno = data.readUInt32BE(6);
  const cmd = data.readUInt32BE(10);
  const totalLen = data.readUInt32BE(14);
  if (data.length < 18 + totalLen) return null;
  const fullLen = 18 + totalLen;
  const iv = data.subarray(18, 30);
  const tag = data.subarray(fullLen - 4 - 16, fullLen - 4);
  const ciphertext = data.subarray(30, fullLen - 4 - 16);
  const aad = data.subarray(4, 18);
  let payload;
  try {
    payload = decryptGCM(ciphertext, hmacKey, iv, tag, aad);
  } catch (_) {
    return { seqno, cmd, payload: null, hmacOk: false };
  }
  if (payload.length >= 4 && payload.readUInt32BE(0) === 0) {
    payload = payload.subarray(4);
  }
  const suffix = data.readUInt32BE(fullLen - 4);
  return { seqno, cmd, payload, hmacOk: suffix === SUFFIX_6699 };
}

function isFrameComplete(buffer) {
  if (buffer.length < 4) return false;
  const prefix = buffer.readUInt32BE(0);
  if (prefix === PREFIX_55AA) {
    if (buffer.length < 16) return false;
    const payloadLen = buffer.readUInt32BE(12);
    return buffer.length >= 16 + payloadLen;
  }
  if (prefix === PREFIX_6699) {
    if (buffer.length < 18) return false;
    const payloadLen = buffer.readUInt32BE(14);
    return buffer.length >= 18 + payloadLen;
  }
  return false;
}

function extractFrame(buffer) {
  for (let i = 0; i < buffer.length - 3; i++) {
    const possiblePrefix = buffer.readUInt32BE(i);
    if (possiblePrefix === PREFIX_55AA || possiblePrefix === PREFIX_6699) {
      const remaining = buffer.subarray(i);
      if (isFrameComplete(remaining)) {
        let frameLen;
        if (possiblePrefix === PREFIX_55AA) {
          const payloadLen = remaining.readUInt32BE(12);
          frameLen = 16 + payloadLen;
        } else {
          const payloadLen = remaining.readUInt32BE(14);
          frameLen = 18 + payloadLen;
        }
        return {
          frame: remaining.subarray(0, frameLen),
          remaining: buffer.subarray(i + frameLen),
        };
      }
      return null;
    }
  }
  return null;
}



function buildKeyExchangeStep1(localNonce, deviceKey) {
  if (!localNonce) localNonce = crypto.randomBytes(16);
  return { localNonce, payload: encryptECBNoPad(localNonce, deviceKey) };
}

module.exports = {
  PREFIX_55AA,
  SUFFIX_55AA,
  PREFIX_6699,
  SUFFIX_6699,
  HEADER_SIZE_55AA,
  HEADER_SIZE_6699,
  NO_VERSION_HEADER_CMDS,
  hmac,
  encryptECB,
  decryptECB,
  encryptECBNoPad,
  decryptECBNoPad,
  encryptGCM,
  decryptGCM,
  getCRC32,
  packMessage55AA,
  unpackMessage55AA,
  packMessage6699,
  unpackMessage6699,
  isFrameComplete,
  extractFrame,
  buildKeyExchangeStep1,
};
