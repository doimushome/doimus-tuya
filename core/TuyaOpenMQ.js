const mqtt = require("mqtt");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const CryptoJS = require("crypto-js");
const { PrefixLogger } = require("../util/Logger");

const GCM_TAG_LENGTH = 16;

class TuyaOpenMQ {
  constructor(api, log = console, debug = false) {
    this.api = api;
    this.log = log;
    this.debug = debug;
    this.version = "1.0";
    this.messageListeners = new Set();
    this.linkId = uuidv4();
    this.consumedQueue = [];
    this.log = new PrefixLogger(log, "TuyaOpenMQ", debug);
  }

  start() {
    this._connect();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end();
    }
  }

  async _connect() {
    this.stop();
    const res = await this._getMQConfig("mqtt");
    if (res.success === false) {
      this.log.warn("Get MQTT config failed. code = %s, msg = %s", res.code, res.msg);
      return;
    }

    const { url, client_id, username, password, expire_time, source_topic } = res.result;
    this.log.debug("Connecting to:", url);

    const client = mqtt.connect(url, { clientId: client_id, username, password });
    client.on("connect", this._onConnect.bind(this));
    client.on("error", this._onError.bind(this));
    client.on("end", this._onEnd.bind(this));
    client.on("message", this._onMessage.bind(this));
    client.subscribe(source_topic.device);

    this.client = client;
    this.config = res.result;
    this.timer = setTimeout(this._connect.bind(this), (expire_time - 60) * 1000);
  }

  async _getMQConfig(linkType) {
    return this.api.post("/v1.0/iot-03/open-hub/access-config", {
      uid: this.api.tokenInfo.uid,
      link_id: this.linkId,
      link_type: linkType,
      topics: "device",
      msg_encrypted_version: this.version,
    });
  }

  _onConnect() {
    this.log.debug("Connected");
  }

  _onError(error) {
    this.log.error("Error:", error);
  }

  _onEnd() {
    this.log.debug("End");
  }

  async _onMessage(topic, payload) {
    const { protocol, data, t } = JSON.parse(payload.toString());
    const messageData = this._decodeMQMessage(data, this.config.password, t);
    if (!messageData) {
      this.log.warn("Message decode failed:", payload.toString());
      return;
    }

    const message = JSON.parse(messageData);
    this.log.debug(
      "onMessage:\ntopic = %s\nprotocol = %s\nmessage = %s\nt = %s",
      topic,
      protocol,
      JSON.stringify(message, null, 2),
      t
    );

    this._fixWrongOrderMessage(protocol, message, t);

    for (const listener of this.messageListeners) {
      listener(topic, protocol, message);
    }
  }

  _fixWrongOrderMessage(protocol, message, t) {
    if (protocol !== 4) return;
    const currentPayload = { protocol, message, t };
    const lastPayload = this.consumedQueue[this.consumedQueue.length - 1];

    if (lastPayload && currentPayload.t < lastPayload.t) {
      this.log.debug("Message received with wrong order.");
      this.log.debug("LastMessage: dataId = %s, t = %s", lastPayload.message.dataId, lastPayload.t);
      this.log.debug("CurrentMessage: dataId = %s, t = %s", message.dataId, t);

      for (const _status of message.status) {
        for (const payload of this.consumedQueue.reverse()) {
          if (message.devId !== payload.message.devId) continue;
          const latestStatus = payload.message.status.find((item) => item.code === _status.code);
          if (latestStatus && latestStatus.value !== _status.value) {
            this.log.debug("Override status %o => %o", latestStatus, _status);
            _status.value = latestStatus.value;
            _status.t = latestStatus.t;
          }
          break;
        }
      }
      return;
    }

    this.consumedQueue.push(currentPayload);
    while (this.consumedQueue.length > 0) {
      let t = this.consumedQueue[0].t;
      if (t > Math.pow(10, 12)) t = t / 1000;
      if (Date.now() / 1000 > t + 30) {
        this.consumedQueue.shift();
      } else {
        break;
      }
    }
  }

  _decodeMQMessage_1_0(b64msg, password) {
    password = password.substring(8, 24);
    return CryptoJS.AES.decrypt(
      b64msg,
      CryptoJS.enc.Utf8.parse(password),
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    ).toString(CryptoJS.enc.Utf8);
  }

  _decodeMQMessage_2_0(data, password, t) {
    const tmpbuffer = Buffer.from(data, "base64");
    const key = password.substring(8, 24);
    const iv_length = tmpbuffer.readUIntBE(0, 4);
    const iv_buffer = tmpbuffer.slice(4, iv_length + 4);
    const data_buffer = tmpbuffer.slice(iv_length + 4, tmpbuffer.length - GCM_TAG_LENGTH);
    const cipher = crypto.createDecipheriv("aes-128-gcm", key, iv_buffer);
    cipher.setAuthTag(tmpbuffer.slice(tmpbuffer.length - GCM_TAG_LENGTH, tmpbuffer.length));
    const buf = Buffer.allocUnsafe(6);
    buf.writeUIntBE(t, 0, 6);
    cipher.setAAD(buf);
    return cipher.update(data_buffer).toString("utf8");
  }

  _decodeMQMessage(data, password, t) {
    if (this.version === "2.0") {
      return this._decodeMQMessage_2_0(data, password, t);
    }
    return this._decodeMQMessage_1_0(data, password);
  }

  addMessageListener(listener) {
    this.messageListeners.add(listener);
  }

  removeMessageListener(listener) {
    this.messageListeners.delete(listener);
  }
}

module.exports = TuyaOpenMQ;
