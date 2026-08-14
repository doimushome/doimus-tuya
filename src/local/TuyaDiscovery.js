const crypto = require('crypto');
const dgram = require('dgram');
const EventEmitter = require('events');
const { PrefixLogger } = require('../shared/Logger');

const UDP_KEY = Buffer.from('6c1ec8e2bb9bb59ab50b0daf649b410a', 'hex');
const GCM_DISCOVERY_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const UDP_PORTS = [6666, 6667, 7000];

const V35_PROBE_PAYLOAD = Buffer.from(
  JSON.stringify({ gwId: '', ip: '' }),
  'utf8',
);

function decryptECBNoPad(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, '');
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function encryptGCM(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

class TuyaDiscovery extends EventEmitter {
  constructor(log, debug = false) {
    super();
    this.log = new PrefixLogger(log, 'TuyaDiscovery', debug);
    this.debug = debug;
    this.sockets = [];
    this.discovered = new Map();
    this._closed = false;
    this._retryTimer = null;
  }

  start() {
    this._closed = false;
    for (const port of UDP_PORTS) {
      this._createSocket(port);
    }
    this._sendV35Probe();
  }

  _createSocket(port) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (msg, rinfo) => {
      this._handleMessage(msg, rinfo);
    });

    socket.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this.log.warn('Port %d in use, retrying in 15s...', port);
        this._retryTimer = setTimeout(() => {
          if (!this._closed) this._createSocket(port);
        }, 15000);
        return;
      }
      this.log.error('Socket error on port %d: %s', port, err.message);
    });

    socket.on('listening', () => {
      this.log.info('Listening on UDP port %d', port);
      socket.setBroadcast(true);
    });

    try {
      socket.bind(port, '0.0.0.0');
    } catch (err) {
      this.log.error('Failed to bind UDP port %d: code=%s msg=%s', port, err.code, err.message);
      if (err.code === 'EADDRINUSE') {
        this._retryTimer = setTimeout(() => {
          if (!this._closed) this._createSocket(port);
        }, 15000);
      }
      return;
    }

    this.sockets.push(socket);
  }

  _handleMessage(msg, rinfo) {
    if (msg.length < 4) return;

    const prefix = msg.readUInt32BE(0);

    if (prefix === 0x000055AA) {
      this._handleV34Message(msg, rinfo);
    } else if (prefix === 0x00006699) {
      this._handleV35Message(msg, rinfo);
    }
  }

  _handleV34Message(msg, rinfo) {
    const suffix = msg.readUInt32BE(msg.length - 4);
    if (suffix !== 0x0000AA55) return;

    let decrypted;
    try {
      decrypted = decryptECBNoPad(msg, UDP_KEY);
    } catch (err) {
      this.log.debug('v3.4 decrypt failed from %s: %s', rinfo.address, err.message);
      return;
    }

    this._processDecrypted(decrypted, rinfo.address, '3.4');
  }

  _handleV35Message(msg, rinfo) {
    const suffix = msg.readUInt32BE(msg.length - 4);
    if (suffix !== 0x00009966) return;

    if (msg.length < 18) return;
    const iv = msg.subarray(18, 30);
    const tag = msg.subarray(msg.length - 20, msg.length - 4);
    const ciphertext = msg.subarray(30, msg.length - 20);

    let decrypted;
    try {
      const decipher = crypto.createDecipheriv('aes-128-gcm', GCM_DISCOVERY_KEY, iv);
      decipher.setAuthTag(tag);
      decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      this.log.debug('v3.5 decrypt failed from %s: %s', rinfo.address, err.message);
      return;
    }

    this._processDecrypted(decrypted, rinfo.address, '3.5');
  }

  _processDecrypted(buf, ip, version) {
    const nullIdx = buf.indexOf(0);
    const jsonStr = nullIdx >= 0 ? buf.toString('utf8', 0, nullIdx) : buf.toString('utf8');
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (_) {
      return;
    }

    if (!data.gwId || !data.ip) return;
    if (data.gwType === 'app') return;

    const key = `${data.gwId}:${data.ip}`;
    if (this.discovered.has(key)) return;
    this.discovered.set(key, { id: data.gwId, ip: data.ip });

    const result = {
      id: data.gwId,
      ip: data.ip,
      version: data.version || version,
    };
    if (data.productKey) result.productKey = data.productKey;
    if (data.gwType) result.gwType = data.gwType;

    this.log.info('Discovered device: id=%s version=%s', result.id, result.version);
    this.emit('discover', result);
  }

  _sendV35Probe() {
    const probeSocket = dgram.createSocket('udp4');
    const iv = crypto.randomBytes(12);
    const encrypted = encryptGCM(V35_PROBE_PAYLOAD, GCM_DISCOVERY_KEY, iv);

    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(0x00006699, 0);
    const unknown = Buffer.alloc(2);
    const seqno = Buffer.alloc(4);
    seqno.writeUInt32BE(1, 0);
    const cmd = Buffer.alloc(4);
    cmd.writeUInt32BE(0x0A, 0);
    const length = Buffer.alloc(4);
    const totalLen = 12 + encrypted.length;
    length.writeUInt32BE(totalLen, 0);

    const header = Buffer.concat([prefix, unknown, seqno, cmd, length]);
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE(0x00009966, 0);

    const packet = Buffer.concat([header, iv, encrypted, suffix]);

    probeSocket.send(packet, 0, packet.length, 7000, '255.255.255.255', (err) => {
      if (err) {
        this.log.debug('v3.5 probe send error: %s', err.message);
      } else {
        this.log.debug('Sent v3.5 discovery probe on port 7000');
      }
      probeSocket.close();
    });
  }

  stop() {
    this._closed = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    for (const socket of this.sockets) {
      try { socket.close(); } catch (_) { /* cleanup */ }
    }
    this.sockets = [];
  }

  end() {
    this.stop();
    this.discovered.clear();
    this.removeAllListeners();
    this.emit('end');
  }
}

module.exports = TuyaDiscovery;
