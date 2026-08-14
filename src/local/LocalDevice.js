const crypto = require('crypto');
const net = require('net');
const EventEmitter = require('events');
const { PrefixLogger } = require('../shared/Logger');
const { ProtocolFactory } = require('./protocol/ProtocolFactory');
const { hmac, encryptECBNoPad, encryptGCM } = require('./protocol/ProtocolUtilities');
const { ChildPayloadUtility } = require('./protocol/ChildPayloadUtility');

class LocalDevice extends EventEmitter {
  constructor({ id, key, ip, version, name, port, pingGap, connectTimeout, log }) {
    super();
    this.id = id;
    this.key = key;
    this.ip = ip;
    this.version = version || '3.1';
    this.name = name || id;
    this.port = port || 6668;
    this.pingGap = (pingGap || 9) * 1000;
    this.connectTimeout = (connectTimeout || 30) * 1000;

    this.log = new PrefixLogger(log || console.log, `LocalDevice:${this.id}`, false);

    this.protocol = ProtocolFactory.createProtocol(this.version);
    this.socket = null;
    this.sessionKey = null;
    this.tmpLocalKey = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.connecting = false;
    this.pingTimer = null;
    this.pongTimer = null;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.seqNo = 0;
    this.state = {};
    this.children = new Map();
    this._explicitDisconnect = false;
  }

  _nextSeq() {
    if (this.protocol && typeof this.protocol.nextSeq === 'function') {
      return this.protocol.nextSeq();
    }
    return ++this.seqNo;
  }

  connect() {
    if (this.connected || this.connecting) return;
    this._explicitDisconnect = false;
    this.connecting = true;

    this.log.info('Connecting to local device (v%s)', this.version);
    this.socket = net.createConnection({ host: this.ip, port: this.port }, () => {
      this.connecting = false;
      this.reconnectAttempts = 0;
      this._handleConnect();
    });

    this.socket.on('data', (data) => {
      try { this._handleData(data); } catch (e) { this.log.error('Unhandled data error: %s', e.message); }
    });
    this.socket.on('error', (err) => this._handleError(err));
    this.socket.on('close', () => this._handleClose());
    this.socket.on('timeout', () => {
      this.log.warn('Socket timeout');
      this.socket.destroy();
    });

    this.socket.setTimeout(15000);

    this.connectTimer = setTimeout(() => {
      if (this.connecting || (!this.connected && this.socket)) {
        this.log.warn('Connect timeout after %dms', this.connectTimeout);
        this._handleError(new Error('connect timeout'));
      }
    }, this.connectTimeout);
  }

  _majorVersion() {
    return parseFloat(this.version) || 0;
  }

  _handleConnect() {
    const major = this._majorVersion();
    if (major >= 3.4) {
      this.tmpLocalKey = crypto.randomBytes(16);
      const { payload } = this.protocol.buildKeyExchangeStep1
        ? this.protocol.buildKeyExchangeStep1(this.tmpLocalKey, this.key)
        : { payload: encryptECBNoPad(this.tmpLocalKey, this.key) };
      this._sendCommand(3, payload);
      return;
    }

    this.connected = true;
    this.emit('connect');
    this._startPinging();
    this.queryState();
  }

  _handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length > 0) {
      if (!this.protocol.isFrameComplete(this.buffer)) break;
      const result = this.protocol.extractFrame(this.buffer);
      if (!result) break;
      this.buffer = result.remaining;
      this._processFrame(result.frame);
    }
  }

  _processFrame(frame) {
    const decoded = this.protocol.decodeFrame(frame, this.key, this.sessionKey);
    if (!decoded) {
      this.log.debug('Failed to decode frame');
      return;
    }
    this._handleCommand(decoded.cmd, decoded.payload, decoded.seqno, decoded.hmacOk);
  }

  _handleCommand(cmd, payload, seqno, hmacOk) {
    switch (cmd) {
      case 4:
        this._handleKeyExchange(payload, seqno, hmacOk);
        break;
      case 5:
        this.connected = true;
        this.emit('connect');
        this._startPinging();
        this.queryState();
        break;
      case 7:
      case 13:
        this._handleEcho(payload);
        break;
      case 8:
      case 10:
      case 16:
        this._handleStatusUpdate(payload);
        break;
      case 9:
        this._handlePong();
        break;
      default:
        this.log.debug('Unhandled command: %d', cmd);
    }
  }

  _handleKeyExchange(payload, seqno, hmacOk) {
    const major = this._majorVersion();
    if (payload.length < 32 + 16) {
      this.log.warn('Key exchange payload too short');
      return;
    }

    const remoteHmac = payload.subarray(0, 32);
    const remoteKey = payload.subarray(32, 48);

    const expectedHmac = hmac(remoteKey, this.key);
    if (!remoteHmac.equals(expectedHmac)) {
      this.log.warn('Key exchange HMAC mismatch');
      return;
    }

    if (this.protocol.processKeyExchangeStep2) {
      this.sessionKey = this.protocol.processKeyExchangeStep2(
        remoteKey,
        this.tmpLocalKey,
        this.key,
      );
    } else {
      const xored = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) {
        xored[i] = this.tmpLocalKey[i] ^ remoteKey[i];
      }
      if (major >= 3.5) {
        const iv = this.tmpLocalKey.subarray(0, 12);
        const { ciphertext } = encryptGCM(xored, this.key, iv);
        this.sessionKey = ciphertext.subarray(0, 16);
      } else {
        this.sessionKey = encryptECBNoPad(xored, this.key);
      }
    }

    this._sendCommand(5, Buffer.alloc(0));
  }

  _handleEcho(payload) {
    const major = this._majorVersion();
    const cmd = major >= 3.4 ? 13 : 7;
    this._sendCommand(cmd, payload || Buffer.alloc(0));
  }

  _handleStatusUpdate(payload) {
    let str = payload.toString('utf8');
    const braceIdx = str.indexOf('{');
    if (braceIdx > 0) str = str.substring(braceIdx);

    let dps;
    try {
      const obj = JSON.parse(str);
      dps = obj.dps || obj;
    } catch (_) {
      this.log.debug('Failed to parse status payload');
      return;
    }

    this._change(dps);
  }

  _change(dps) {
    const changed = {};
    for (const [key, value] of Object.entries(dps)) {
      const oldValue = this.state[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(value)) {
        changed[key] = value;
      }
    }
    if (Object.keys(changed).length === 0) return;
    Object.assign(this.state, changed);
    this.emit('change', changed, this.state);
  }

  _sendCommand(cmd, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const seqNo = this._nextSeq();
    const frame = this.protocol.encodeFrame(cmd, payload, seqNo, this.sessionKey, this.key);
    this.socket.write(frame, (err) => {
      if (err) this.log.warn('Write error: %s', err.message);
    });
  }

  _startPinging() {
    this._stopPinging();
    this.pingTimer = setInterval(() => {
      if (!this.connected || !this.socket || this.socket.destroyed) {
        this._stopPinging();
        return;
      }
      this._sendCommand(9, Buffer.alloc(0));
      this.pongTimer = setTimeout(() => {
        this.log.warn('Pong timeout');
        this._handleError(new Error('pong timeout'));
      }, 5000);
    }, this.pingGap);
  }

  _stopPinging() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  _handlePong() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  _handleError(err) {
    this.log.warn('Error: %s', err.message);
    this._cleanup();
    this.emit('error', err);
    if (!this._explicitDisconnect) {
      this._scheduleReconnect();
    }
  }

  _handleClose() {
    this.log.info('Connection closed');
    this._cleanup();
    if (!this._explicitDisconnect) {
      this._scheduleReconnect();
    }
  }

  _cleanup() {
    this.connected = false;
    this.connecting = false;
    this._stopPinging();
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) { /* cleanup */ }
      this.socket = null;
    }
    this.buffer = Buffer.alloc(0);
    this.children.clear();
  }

  _scheduleReconnect() {
    if (this._explicitDisconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.min(this.reconnectAttempts, 10));
    this.log.info('Reconnecting in %dms (attempt %d)', delay, this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      if (!this._explicitDisconnect) this.connect();
    }, delay);
  }

  update(dps) {
    const major = this._majorVersion();
    const cmd = major >= 3.4 ? 13 : 7;
    const payload = Buffer.from(JSON.stringify(dps), 'utf8');
    this._sendCommand(cmd, payload);
  }

  queryState() {
    const major = this._majorVersion();
    const cmd = major >= 3.4 ? 16 : 10;
    this._sendCommand(cmd, Buffer.from('{}', 'utf8'));
  }

  updateChild(childId, dps) {
    const payload = ChildPayloadUtility.prepareChildPayload(childId, dps);
    this._sendCommand(13, payload);
  }

  queryStateChild(childId) {
    const payload = ChildPayloadUtility.prepareChildQueryPayload(childId, {});
    this._sendCommand(16, payload);
  }

  disconnect() {
    this._explicitDisconnect = true;
    this._cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sessionKey = null;
    this.tmpLocalKey = null;
    this.reconnectAttempts = 0;
    this.emit('disconnect');
  }
}

module.exports = LocalDevice;
