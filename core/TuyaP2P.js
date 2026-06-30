"use strict";

/**
 * Tuya P2P Client — Node.js implementation of the Tuya LAN protocol.
 *
 * Connects directly to Tuya cameras/doorbells over TCP on port 554 (or 6668),
 * negotiates a session key, and starts receiving video/audio data.
 *
 * Protocol reference: tinytuya (https://github.com/jasonacox/tinytuya)
 *
 * Message framing:
 *   55AA format (v3.1–3.4): [4B prefix] [4B seqno] [4B cmd] [4B len] [payload] [4B crc] [4B suffix]
 *   6699 format (v3.5+):    [4B prefix] [4B:0] [4B seqno] [4B cmd] [4B len] [enc+iv] [16B tag] [4B suffix]
 */

const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");

// ─── Constants ───────────────────────────────────────────────────────────────

const PREFIX_55AA = 0x000055aa;
const PREFIX_55AA_BIN = Buffer.from("000055aa", "hex");
const SUFFIX_55AA = 0x0000aa55;
const SUFFIX_55AA_BIN = Buffer.from("0000aa55", "hex");

const PREFIX_6699 = 0x00006699;
const PREFIX_6699_BIN = Buffer.from("00006699", "hex");
const SUFFIX_6699 = 0x00009966;
const SUFFIX_6699_BIN = Buffer.from("00009966", "hex");

const PROTOCOL_VERSION_BYTES = { "3.1": "3.1", "3.3": "3.3", "3.4": "3.4", "3.5": "3.5" };
const PROTOCOL_3x_HEADER = Buffer.alloc(12, 0);

// Message commands
const CMD = {
  SESS_KEY_NEG_START: 3,
  SESS_KEY_NEG_RESP: 4,
  SESS_KEY_NEG_FINISH: 5,
  CONTROL: 7,
  STATUS: 8,
  HEART_BEAT: 9,
  DP_QUERY: 0x0a,
  DP_QUERY_NEW: 0x10,
  UPDATEDPS: 0x12,
  LAN_EXT_STREAM: 0x40,
};

const NO_PROTOCOL_HEADER_CMDS = new Set([
  CMD.DP_QUERY, CMD.DP_QUERY_NEW, CMD.UPDATEDPS, CMD.HEART_BEAT,
  CMD.SESS_KEY_NEG_START, CMD.SESS_KEY_NEG_RESP, CMD.SESS_KEY_NEG_FINISH,
  CMD.LAN_EXT_STREAM,
]);

const DEFAULT_PORT = 554;
const LOCAL_NONCE = Buffer.from("0123456789abcdef");

// ─── AES Helper ──────────────────────────────────────────────────────────────

function aesEncryptECB(key, plaintext) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesDecryptECB(key, ciphertext) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEncryptGCM(key, plaintext, iv, aad) {
  const cipher = crypto.createCipheriv("aes-128-gcm", key, iv, { authTagLength: 16 });
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { encrypted, tag: cipher.getAuthTag() };
}

function aesDecryptGCM(key, ciphertext, iv, tag, aad) {
  const decipher = crypto.createDecipheriv("aes-128-gcm", key, iv, { authTagLength: 16 });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── Message Packing / Unpacking ─────────────────────────────────────────────

/**
 * Pack a TuyaMessage into a wire-format Buffer.
 *
 * @param {object} msg  { prefix, seqno, cmd, payload, use6699?, iv?, hmacKey? }
 */
function packMessage(msg) {
  const hmacKey = msg.hmacKey || null;
  const prefix = msg.use6699 ? PREFIX_6699 : PREFIX_55AA;
  let payload = msg.payload;

  if (msg.use6699) {
    // 6699 format with AES-GCM
    if (!hmacKey) throw new Error("6699 messages require hmacKey");
    const iv = msg.iv || crypto.randomBytes(12);
    const headerArea = Buffer.alloc(12); // seqno + cmd + len fields (4+4+4)
    headerArea.writeUInt32BE(msg.seqno, 0);
    headerArea.writeUInt32BE(msg.cmd, 4);
    headerArea.writeUInt32BE(0, 8); // placeholder len, filled below

    const { encrypted, tag } = aesEncryptGCM(hmacKey, payload, iv, headerArea);

    const totalPayloadLen = 12 + encrypted.length + 16; // 12B iv + data + 16B tag
    const header = Buffer.alloc(20);
    header.writeUInt32BE(PREFIX_6699, 0);
    header.writeUInt32BE(0, 4);        // unknown
    header.writeUInt32BE(msg.seqno, 8);
    header.writeUInt32BE(msg.cmd, 12);
    header.writeUInt32BE(totalPayloadLen, 16);

    return Buffer.concat([header, iv, encrypted, tag, SUFFIX_6699_BIN]);
  }

  // 55AA format
  if (hmacKey) {
    // HMAC-SHA256 instead of CRC32
    const header = Buffer.alloc(16);
    header.writeUInt32BE(PREFIX_55AA, 0);
    header.writeUInt32BE(msg.seqno, 4);
    header.writeUInt32BE(msg.cmd, 8);
    const endSize = 32 + 4; // HMAC(32) + suffix(4)
    header.writeUInt32BE(payload.length + endSize, 12);

    const preCRC = Buffer.concat([header, payload]);
    const hmac = crypto.createHmac("sha256", hmacKey).update(preCRC).digest();
    return Buffer.concat([preCRC, hmac, SUFFIX_55AA_BIN]);
  }

  // Plain CRC32
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX_55AA, 0);
  header.writeUInt32BE(msg.seqno, 4);
  header.writeUInt32BE(msg.cmd, 8);
  header.writeUInt32BE(payload.length + 8, 12); // crc(4) + suffix(4)

  const preCRC = Buffer.concat([header, payload]);
  const crc = crc32(preCRC);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([preCRC, crcBuf, SUFFIX_55AA_BIN]);
}

/**
 * Parse binary data into a TuyaMessage.
 * Returns null if more data is needed, or throws on invalid data.
 */
function unpackMessage(data, hmacKey, version) {
  if (data.length < 16) return null; // minimum header

  const prefix = data.readUInt32BE(0);
  let headerLen, endLen, prefixVal, suffixBin;
  let use6699 = false;

  if (prefix === PREFIX_6699) {
    use6699 = true;
    headerLen = 20;
    endLen = 16 + 4; // tag(16) + suffix(4)
    prefixVal = PREFIX_6699;
    suffixBin = SUFFIX_6699_BIN;
  } else if (prefix === PREFIX_55AA) {
    headerLen = 16;
    endLen = hmacKey ? (32 + 4) : (4 + 4); // HMAC(32) or CRC(4) + suffix(4)
    prefixVal = PREFIX_55AA;
    suffixBin = SUFFIX_55AA_BIN;
  } else {
    // Try to find next valid prefix
    throw new Error("Invalid message prefix: " + prefix.toString(16));
  }

  if (data.length < headerLen) return null;

  let seqno, cmd, payloadLen;
  if (use6699) {
    /* unknown = */ data.readUInt32BE(4);
    seqno = data.readUInt32BE(8);
    cmd = data.readUInt32BE(12);
    payloadLen = data.readUInt32BE(16);
  } else {
    seqno = data.readUInt32BE(4);
    cmd = data.readUInt32BE(8);
    payloadLen = data.readUInt32BE(12);
  }

  const totalLen = headerLen + payloadLen;
  if (data.length < totalLen) return null;

  const rawPayload = data.slice(headerLen, totalLen);

  // Verify suffix
  const suffix = data.readUInt32BE(totalLen - 4);
  if (suffix !== (use6699 ? SUFFIX_6699 : SUFFIX_55AA)) {
    throw new Error("Invalid suffix");
  }

  let payload, iv = null, crcGood = true;

  if (use6699) {
    iv = rawPayload.slice(0, 12);
    const tag = rawPayload.slice(rawPayload.length - endLen + 4, rawPayload.length - 4); // before suffix
    const encrypted = rawPayload.slice(12, rawPayload.length - endLen + 4);

    const headerArea = Buffer.alloc(12);
    headerArea.writeUInt32BE(seqno, 0);
    headerArea.writeUInt32BE(cmd, 4);
    headerArea.writeUInt32BE(0, 8);

    try {
      payload = aesDecryptGCM(hmacKey, encrypted, iv, tag, headerArea);
    } catch (e) {
      crcGood = false;
      payload = encrypted; // return raw encrypted if decryption fails
    }
  } else if (hmacKey) {
    const hmac = rawPayload.slice(rawPayload.length - 36, rawPayload.length - 4);
    payload = rawPayload.slice(0, rawPayload.length - 36);
    const preCRC = data.slice(0, totalLen - 36);
    const expected = crypto.createHmac("sha256", hmacKey).update(preCRC).digest();
    crcGood = hmac.equals(expected);
  } else {
    const crc = rawPayload.readUInt32BE(rawPayload.length - 8);
    payload = rawPayload.slice(0, rawPayload.length - 8);
    const preCRC = data.slice(0, totalLen - 8);
    crcGood = crc === crc32(preCRC);
  }

  return { seqno, cmd, payload, crcGood, iv, prefix: prefixVal };
}

// ─── CRC32 ───────────────────────────────────────────────────────────────────

const CRC32_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[i] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── TuyaP2P Client ──────────────────────────────────────────────────────────

class TuyaP2P extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.deviceId   - Tuya device ID
   * @param {string} opts.ip         - Camera IP address
   * @param {number} opts.port       - TCP port (default 554)
   * @param {string} opts.localKey   - Device local_key (16 bytes)
   * @param {number} opts.version    - Protocol version (3.1, 3.3, 3.4, 3.5)
   * @param {object} opts.log        - Logger with info/debug/warn/error
   */
  constructor(opts) {
    super();
    this.deviceId = opts.deviceId;
    this.ip = opts.ip;
    this.port = opts.port || DEFAULT_PORT;
    this.realLocalKey = Buffer.from(opts.localKey || "", "utf8");
    this.version = opts.version || 3.4;
    this.log = opts.log || { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

    // Session state
    this.localKey = this.realLocalKey;
    this.localNonce = LOCAL_NONCE;
    this.remoteNonce = Buffer.alloc(0);
    this.seqno = 1;
    this.socket = null;
    this.recvBuf = Buffer.alloc(0);
    this.streaming = false;
    this.use6699 = this.version >= 3.5;
    this.hmacKey = this.version >= 3.4 ? this.localKey : null;

    // Video reassembly buffer
    this.videoBuf = Buffer.alloc(0);
  }

  // ─── Connection ──────────────────────────────────────────────────────────

  async connect() {
    return new Promise((resolve, reject) => {
      this.log.info(`[P2P] Connecting to ${this.ip}:${this.port}...`);

      this.socket = new net.Socket();
      this.socket.setNoDelay(true);
      this.socket.setTimeout(10000);

      this.socket.connect(this.port, this.ip, () => {
        this.log.info(`[P2P] TCP connected to ${this.ip}:${this.port}`);
        this.socket.setTimeout(0); // disable timeout after connect
        this._negotiateSession()
          .then(() => resolve(true))
          .catch(reject);
      });

      this.socket.on("data", (chunk) => this._onData(chunk));
      this.socket.on("error", (err) => {
        this.log.error(`[P2P] Socket error: ${err.message}`);
        this.emit("error", err);
      });
      this.socket.on("close", () => {
        this.log.info("[P2P] Socket closed");
        this.streaming = false;
        this.emit("close");
      });
      this.socket.on("timeout", () => {
        this.log.warn("[P2P] Socket timeout");
        this.socket.destroy();
        reject(new Error("Connection timeout"));
      });
    });
  }

  close() {
    this.streaming = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // ─── Session Key Negotiation (v3.4+) ─────────────────────────────────────

  async _negotiateSession() {
    if (this.version < 3.4) {
      this.log.debug("[P2P] Protocol < 3.4, skipping session key negotiation");
      return;
    }

    this.log.info("[P2P] Starting session key negotiation...");
    this.localKey = this.realLocalKey;

    // Step 1: send local nonce
    const step1 = this._buildMessage(CMD.SESS_KEY_NEG_START, this.localNonce);
    this.socket.write(step1);

    // Step 2: receive remote nonce + HMAC
    const rkey = await this._receiveOne(5000);
    if (!rkey || rkey.cmd !== CMD.SESS_KEY_NEG_RESP) {
      throw new Error("Session key negotiation failed at step 2: " + (rkey ? `cmd=${rkey.cmd}` : "no response"));
    }

    let payload = rkey.payload;
    if (this.version === 3.4) {
      // In 3.4 the step2 payload is encrypted with the real local key
      payload = aesDecryptECB(this.realLocalKey, payload);
    }

    if (payload.length < 48) {
      throw new Error("Session key negotiation step 2 payload too short: " + payload.length);
    }

    this.remoteNonce = payload.slice(0, 16);
    const hmacCheck = crypto.createHmac("sha256", this.localKey).update(this.localNonce).digest();

    if (!hmacCheck.equals(payload.slice(16, 48))) {
      throw new Error("Session key negotiation step 2 HMAC mismatch");
    }

    // Step 3: send HMAC of remote nonce
    const rkeyHmac = crypto.createHmac("sha256", this.localKey).update(this.remoteNonce).digest();
    const step3 = this._buildMessage(CMD.SESS_KEY_NEG_FINISH, rkeyHmac);
    this.socket.write(step3);

    // Compute session key: XOR local_nonce ^ remote_nonce, then encrypt
    const xored = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) xored[i] = this.localNonce[i] ^ this.remoteNonce[i];

    if (this.version === 3.4) {
      this.localKey = aesEncryptECB(this.realLocalKey, xored);
    } else {
      // v3.5: use local_nonce as IV for GCM
      const iv = this.localNonce.slice(0, 12);
      const { encrypted } = aesEncryptGCM(this.realLocalKey, xored, iv);
      this.localKey = encrypted.slice(12, 28);
    }

    this.hmacKey = this.localKey;
    this.use6699 = this.version >= 3.5;
    this.log.info("[P2P] Session key negotiated successfully");
  }

  // ─── Message I/O ─────────────────────────────────────────────────────────

  _buildMessage(cmd, payload, extra) {
    const msg = {
      prefix: this.use6699 ? PREFIX_6699 : PREFIX_55AA,
      seqno: this.seqno++,
      cmd,
      payload,
      use6699: this.use6699,
      hmacKey: this.hmacKey,
      iv: extra && extra.iv ? extra.iv : undefined,
    };
    return packMessage(msg);
  }

  _onData(chunk) {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    // Emit raw data for streaming mode
    if (this.streaming) {
      this._processStreamData();
      return;
    }
    // In non-streaming mode, messages are processed by _receiveOne
    this.emit("data");
  }

  _receiveOne(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);

      const onData = () => {
        try {
          const msg = unpackMessage(this.recvBuf, this.hmacKey, this.version);
          if (msg) {
            // Remove this message from recv buffer
            const consumed = this._consumedLength(msg);
            this.recvBuf = this.recvBuf.slice(consumed);
            cleanup();
            resolve(msg);
          }
        } catch (e) {
          // Not enough data or corrupt — wait for more
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("data", onData);
      };

      // Try immediately in case data is already buffered
      onData();
      if (!timer._destroyed) {
        this.on("data", onData);
      }
    });
  }

  _consumedLength(msg) {
    if (msg.prefix === PREFIX_6699) {
      return 20 + this.recvBuf.readUInt32BE(16);
    }
    return 16 + this.recvBuf.readUInt32BE(12);
  }

  async sendCommand(cmd, payload) {
    const msg = this._buildMessage(cmd, payload);
    this.socket.write(msg);
    return this._receiveOne(5000);
  }

  // ─── Video Stream ────────────────────────────────────────────────────────

  /**
   * Start the video stream from the camera.
   * Sends LAN_EXT_STREAM command to initiate streaming.
   */
  async startVideoStream() {
    this.log.info("[P2P] Starting video stream...");

    // Try to start video. The exact sub-command varies by device.
    // Common formats for LAN_EXT_STREAM payload:
    //   {"reqType": "stream_start", "data": {}}
    //   {"reqType": "video_start", "data": {"quality": "HD"}}
    const payload = JSON.stringify({ reqType: "stream_start", data: {} });
    const response = await this.sendCommand(CMD.LAN_EXT_STREAM, Buffer.from(payload, "utf8"));

    if (response) {
      this.log.info(`[P2P] Stream start response: ${response.payload.toString("utf8")}`);
    }

    this.streaming = true;
    this.videoBuf = Buffer.alloc(0);
    this.emit("streaming", true);
  }

  stopVideoStream() {
    this.streaming = false;
    this.videoBuf = Buffer.alloc(0);
    this.emit("streaming", false);
  }

  /**
   * Process buffered data for video frames when in streaming mode.
   * The camera sends video data as raw binary over the TCP connection.
   * Each frame may have a header with length/size info, or frames may
   * be delimited by specific byte sequences.
   */
  _processStreamData() {
    // Different camera models use different container formats.
    // Common patterns:
    // 1. Raw H.264 NAL units (00 00 00 01 delimited)
    // 2. Tuya's proprietary frame format: [4B frame_len] [4B timestamp] [4B flags] ... [JPEG/H264 data]
    // 3. MJPEG frames delimited by FF D8 ... FF D9

    // Try to extract frames using NAL unit delimiter pattern
    while (this.streaming && this.recvBuf.length > 0) {
      // Look for JPEG SOI marker (FF D8) — some cameras send MJPEG directly
      const soiIdx = this.recvBuf.indexOf(0xffd8);
      if (soiIdx >= 0) {
        // Search for EOI (FF D9) after SOI
        const eoiIdx = this.recvBuf.indexOf(0xffd9, soiIdx + 2);
        if (eoiIdx >= 0) {
          const frame = this.recvBuf.slice(soiIdx, eoiIdx + 2);
          this.recvBuf = this.recvBuf.slice(eoiIdx + 2);
          this.emit("frame", frame);
          continue;
        }
      }

      // Look for NAL unit start (00 00 00 01) — H.264
      const nalIdx = this.recvBuf.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
      if (nalIdx >= 0 && nalIdx !== this._lastNalIdx) {
        this._lastNalIdx = nalIdx;
        // H.264 detected — for now just pass the raw data through
        // Future: we can convert H.264 keyframes to JPEG using ffmpeg or similar
        this.emit("h264_nal", this.recvBuf.slice(nalIdx));
        this.recvBuf = this.recvBuf.slice(this.recvBuf.length);
        break;
      }

      // No complete frame found — wait for more data
      break;
    }

    // Prevent buffer from growing unboundedly
    if (this.recvBuf.length > 5 * 1024 * 1024) {
      this.log.warn("[P2P] Video buffer exceeded 5MB, flushing");
      this.recvBuf = Buffer.alloc(0);
    }
  }
}

TuyaP2P.CMD = CMD;
module.exports = TuyaP2P;
