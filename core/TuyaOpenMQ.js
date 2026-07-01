const mqtt = require("mqtt");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const CryptoJS = require("crypto-js");
const { PrefixLogger } = require("../util/Logger");

const GCM_TAG_LENGTH = 16;
const INITIAL_RETRY_DELAY = 2000; // 2 seconds
const MAX_RETRY_DELAY = 120000; // 2 minutes

class TuyaOpenMQ {
  constructor(api, log = console, debug = false) {
    this.api = api;
    this.debug = debug;
    this.version = "1.0";
    this.messageListeners = new Set();
    this.linkId = uuidv4();
    this.consumedQueue = [];
    this.log = new PrefixLogger(log, "TuyaOpenMQ", debug);
    this.running = false;
    this.retryDelay = INITIAL_RETRY_DELAY;
    this._retryTimer = null; // separate timer for retry backoff
    this._expireTimer = null; // separate timer for MQTT credential expiry
    this._connecting = false; // flag to prevent close-handler race during _connect()
    this.config = null;
    this.client = null;
  }

  start() {
    this.running = true;
    this.retryDelay = INITIAL_RETRY_DELAY;
    this.log.info("MQTT start requested, initiating connection...");
    this._connect();
  }

  stop() {
    this.running = false;
    this._clearTimers();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
    this.config = null;
  }

  _clearTimers() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._expireTimer) {
      clearTimeout(this._expireTimer);
      this._expireTimer = null;
    }
  }

  _scheduleReconnect() {
    if (!this.running) return;
    if (this._retryTimer) return; // already scheduled

    this.log.info(
      "Scheduling MQTT reconnect in %dms (backoff)",
      this.retryDelay,
    );
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      // Exponential backoff with cap
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY);
      this._connect();
    }, this.retryDelay);
  }

  async _connect() {
    if (!this.running) return;

    // Prevent re-entrancy: if a connection attempt is already in progress
    // (e.g. _expireTimer fired while _scheduleReconnect is pending), bail out.
    if (this._connecting) {
      this.log.debug("MQTT _connect skipped: already connecting");
      return;
    }

    // Prevent close-handler race: signal we're in the connect loop
    // so the old client's async close event doesn't trigger _scheduleReconnect.
    this._connecting = true;

    // Clean up previous connection completely (like reference's this.stop())
    this._clearTimers();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
    this.config = null;

    let res;
    try {
      res = await this._getMQConfig("mqtt");
    } catch (err) {
      this.log.error("Get MQTT config error: %s", err.message);
      this._connecting = false;
      this._scheduleReconnect();
      return;
    }

    if (res.success === false) {
      this.log.warn(
        "Get MQTT config failed. code = %s, msg = %s. Will retry.",
        res.code,
        res.msg,
      );
      this._connecting = false;
      this._scheduleReconnect();
      return;
    }

    // Config fetched successfully — reset retry delay
    this.retryDelay = INITIAL_RETRY_DELAY;

    if (!res.result) {
      this.log.error(
        "MQTT config response missing 'result' field: code=%s msg=%s",
        res.code,
        res.msg,
      );
      this._connecting = false;
      this._scheduleReconnect();
      return;
    }

    const { url, client_id, username, password, expire_time, source_topic } =
      res.result;

    if (!url || !client_id || !username || !password) {
      this.log.error(
        "MQTT config missing required fields: url=%s client_id=%s",
        !!url,
        !!client_id,
      );
      this._connecting = false;
      this._scheduleReconnect();
      return;
    }

    if (!source_topic || !source_topic.device) {
      this.log.error("MQTT config missing source_topic.device");
      this._connecting = false;
      this._scheduleReconnect();
      return;
    }

    this.log.info("Connecting to MQTT: %s", url);

    // Store config BEFORE connecting so _onMessage can use it immediately
    this.config = res.result;

    // Disable mqtt.js built-in reconnect — we manage reconnection ourselves
    // via _scheduleReconnect() which fetches fresh credentials before retrying.
    // mqtt.js auto-reconnect with stale credentials causes auth errors that
    // trigger destructive plugin restarts in the Go backend.
    const client = mqtt.connect(url, {
      clientId: client_id,
      username,
      password,
      reconnectPeriod: 0,
    });

    client.on("connect", () => {
      this.log.info("MQTT Connected");
    });

    client.on("error", (error) => {
      this.log.error("MQTT Error: %s", error.message);
      // mqtt.js auto-reconnect is disabled (reconnectPeriod=0). We handle
      // all reconnection via _scheduleReconnect() which fetches fresh
      // MQTT credentials before retrying.
      if (this.running && !this._retryTimer) {
        this.log.info("MQTT error triggered reconnect schedule");
        this._scheduleReconnect();
      }
    });

    client.on("close", () => {
      this.log.info("MQTT Connection closed");
      // Only schedule external reconnect if we're NOT in the middle of
      // _connect()'s own cleanup. When _connecting is true, the close
      // event is from the old client being ended during cleanup — ignore it.
      // Also skip if a retry timer is already armed (prevents duplicates).
      if (this.running && !this._connecting && !this._retryTimer) {
        // Clear the expire timer — we're reconnecting now, so the old
        // credential-expiry schedule is stale.
        if (this._expireTimer) {
          clearTimeout(this._expireTimer);
          this._expireTimer = null;
        }
        this._scheduleReconnect();
      }
    });

    // Capture the config password in the closure so each client instance
    // uses its own credentials for decryption (avoids stale-password issues
    // if the shared this.config changes before a delayed message arrives).
    const _mqPassword = password;
    client.on("message", (topic, payload) => {
      this._onMessage(topic, payload, _mqPassword);
    });

    client.subscribe(source_topic.device, (err) => {
      if (err) {
        this.log.error("MQTT Subscribe error: %s", err.message);
      } else {
        this.log.info("MQTT Subscribed to: %s", source_topic.device);
      }
    });

    this.client = client;

    // Reconnecting is complete — release the guard so close events
    // from this point on can trigger reconnect if needed.
    this._connecting = false;

    // Schedule periodic reconnection before MQTT token expires
    // Stored in _expireTimer (separate from _retryTimer to avoid conflicts)
    this._expireTimer = setTimeout(
      () => {
        this._expireTimer = null;
        this.log.debug("MQTT expire_time reached, reconnecting...");
        this._connect();
      },
      (expire_time - 60) * 1000,
    );
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

  async _onMessage(topic, payload, mqPassword) {
    try {
      const parsed = JSON.parse(payload.toString());
      const { protocol, data, t } = parsed;

      if (!data) {
        this.log.warn("MQTT message has no data field: %s", payload.toString());
        return;
      }

      // Use the closure-captured password (per-client-instance) first,
      // fall back to this.config.password for backward compatibility.
      const password = mqPassword || (this.config ? this.config.password : "");

      const messageData = this._decodeMQMessage(data, password, t);
      if (!messageData) {
        this.log.warn(
          "Message decode returned empty payload for protocol=%s",
          protocol,
        );
        return;
      }

      const message = JSON.parse(messageData);
      const statusCodes = (message.status || []).map((s) => s.code).join(",");
      this.log.info(
        "MQTT: devId=" +
          message.devId +
          " proto=" +
          protocol +
          " codes=[" +
          statusCodes +
          "] " +
          JSON.stringify({ topic, t, status: message.status }),
      );

      this._fixWrongOrderMessage(protocol, message, t);

      for (const listener of this.messageListeners) {
        try {
          listener(topic, protocol, message);
        } catch (listenerErr) {
          this.log.error("MQTT listener error: %s", listenerErr.message);
        }
      }
    } catch (err) {
      this.log.warn(
        "MQTT message processing error: %s\npayload: %s",
        err.message,
        payload.toString().substring(0, 500),
      );
    }
  }

  _fixWrongOrderMessage(protocol, message, t) {
    if (protocol !== 4) return;
    if (!message || !message.status) return;

    const currentPayload = { protocol, message, t };
    const lastPayload = this.consumedQueue[this.consumedQueue.length - 1];

    if (lastPayload && currentPayload.t < lastPayload.t) {
      this.log.debug("Message received with wrong order.");
      this.log.debug(
        "LastMessage: dataId = %s, t = %s",
        lastPayload.message.dataId,
        lastPayload.t,
      );
      this.log.debug("CurrentMessage: dataId = %s, t = %s", message.dataId, t);

      for (const _status of message.status) {
        for (const payload of this.consumedQueue.reverse()) {
          if (message.devId !== payload.message.devId) continue;
          const latestStatus = payload.message.status.find(
            (item) => item.code === _status.code,
          );
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
      let entryT = this.consumedQueue[0].t;
      if (entryT > Math.pow(10, 12)) entryT = entryT / 1000;
      if (Date.now() / 1000 > entryT + 30) {
        this.consumedQueue.shift();
      } else {
        break;
      }
    }
  }

  _decodeMQMessage_1_0(b64msg, password) {
    password = password.substring(8, 24);
    return CryptoJS.AES.decrypt(b64msg, CryptoJS.enc.Utf8.parse(password), {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    }).toString(CryptoJS.enc.Utf8);
  }

  _decodeMQMessage_2_0(data, password, t) {
    const tmpbuffer = Buffer.from(data, "base64");
    const key = password.substring(8, 24);
    const iv_length = tmpbuffer.readUIntBE(0, 4);
    const iv_buffer = tmpbuffer.slice(4, iv_length + 4);
    const data_buffer = tmpbuffer.slice(
      iv_length + 4,
      tmpbuffer.length - GCM_TAG_LENGTH,
    );
    const cipher = crypto.createDecipheriv("aes-128-gcm", key, iv_buffer);
    cipher.setAuthTag(
      tmpbuffer.slice(tmpbuffer.length - GCM_TAG_LENGTH, tmpbuffer.length),
    );
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
