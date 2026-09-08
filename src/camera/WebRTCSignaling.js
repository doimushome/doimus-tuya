"use strict";

const mqtt = require("mqtt");
const crypto = require("crypto");
const { redactUrl } = require("../shared/plugin-utils");
const { crc32 } = require("../shared/crc32");

const WEBRTC_PROTOCOL = 302;
const RESOLUTION_PROTOCOL = 312;

// Battery cameras boot 30-90s after the wake and connect to the IPC broker
// long after the first offer was published. Re-publish the offer until the
// camera answers (go2rtc sends once; we retry because the camera wakes late).
const OFFER_RETRY_MS = 5000;
const OFFER_RETRY_TRIES = 20;

// Don't hammer the Smart Life app login after a failure — repeated rejects can
// trip Tuya's security lock (which surfaces as the same "wrong password").
let lastAppLoginFailAt = 0;
const APP_LOGIN_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Tuya WebRTC signaling client — KISS port of go2rtc's pkg/tuya/mqtt.go.
 *
 * Flow (reverse-engineered from the Smart Life app + go2rtc):
 *  1. start(deviceId, localKey):
 *     - GET  /v1.0/users/{uid}/devices/{id}/webrtc-configs  → auth, moto_id,
 *       ICE servers, skill, optional local_key
 *     - POST /v2.0/open-iot-hub/access/config               → IPC MQTT broker
 *     - connect MQTT, subscribe to source_topic.ipc, send CRC32 wake
 *  2. mobile app sends `offer` → publish offer (QoS 1) to sink_topic.ipc
 *  3. camera answers on source topic → emit "answer" to the mobile app
 *
 * Events emitted: "config", "answer", "candidate", "disconnect", "error".
 */

// tuya-ipc-terminal (the tool that streams these battery/doorbell cameras)
// uses a 32-char hex session id — revert from go2rtc's 6-char.
function newSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

class WebRTCSignaling {
  constructor(api, log) {
    this.api = api;
    this.log = log;
    this._listeners = {};
    this.deviceId = "";
    this.localKey = "";
    this.uid = "";
    this.motoId = "";
    this.auth = "";
    this.iceServers = [];
    this.sinkTopic = "";
    this.sourceTopic = "";
    this.from = "";
    this.sessionId = "";
    this.mqtt = null;
    this._answered = false;
    this._offerTimer = null;
    this._pendingOffer = null;
    this._lastOffer = null;
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach((h) => {
      try {
        h(data);
      } catch (e) {
        this.log("error", `[WebRTC] handler error (${event}): ${e.message || e}`);
      }
    });
  }

  /**
   * Fetch configs, connect the IPC MQTT broker, send the CRC32 wake, and
   * emit "config" so the mobile app can create its offer.
   *
   * Prefers the Smart Life app flow (app login → /api/jarvis/mqtt broker) —
   * the camera's WebRTC/IPC subsystem listens on the app's broker, not the
   * OpenAPI open-iot-hub one. Falls back to the OpenAPI flow when the plugin
   * has no app credentials (accessId/accessKey-only projects).
   */
  async start(deviceId, localKey, options) {
    this.deviceId = deviceId;
    this.localKey = localKey || "";
    this.uid = this.api.tokenInfo && this.api.tokenInfo.uid;
    this.options = options || {};
    if (!this.uid && !this.options.username) {
      throw new Error("No UID available");
    }

    const hasAppCreds =
      (this.options.appUsername || this.options.username) &&
      (this.options.appPassword || this.options.password);
    if (hasAppCreds && Date.now() - lastAppLoginFailAt > APP_LOGIN_COOLDOWN_MS) {
      const ok = await this._startAppFlow(deviceId);
      if (ok) return;
      lastAppLoginFailAt = Date.now();
      this.log("warn", "[WebRTC] App flow unavailable — falling back to OpenAPI flow");
    }

    if (!this.uid) {
      throw new Error("No UID — Tuya token expired or account in use elsewhere");
    }

    // 1. WebRTC config (auth token, moto_id, ICE servers, skill).
    const wr = await this.api.get(
      `/v1.0/users/${this.uid}/devices/${deviceId}/webrtc-configs`,
    );
    if (!wr.success || !wr.result || !wr.result.supports_webrtc) {
      throw new Error("WebRTC not supported by this device");
    }
    const r = wr.result;
    this.motoId = r.moto_id || "";
    this.auth = r.auth || "";
    // The device's canonical local_key is preferred for the CRC32 wake; the
    // WebRTC config may also carry one (often absent on battery cameras).
    this.localKey = r.local_key || this.localKey;
    this.iceServers = this._normalizeIces(r.p2p_config && r.p2p_config.ices);

    // 2. IPC MQTT config (fresh link_id per connection).
    const mq = await this.api.post("/v2.0/open-iot-hub/access/config", {
      uid: this.uid,
      unique_id: crypto.randomUUID(),
      link_type: "mqtt",
      topics: "ipc",
    });
    if (!mq.success || !mq.result) {
      throw new Error(`IPC MQTT config failed (code=${mq.code} msg=${mq.msg})`);
    }
    const c = mq.result;
    this.sinkTopic = this._resolve(c.sink_topic && c.sink_topic.ipc);
    this.sourceTopic = this._resolve(c.source_topic && c.source_topic.ipc);
    // `from` = the string after /av/u/ (parts[3]) — Tuya docs + go2rtc.
    this.from =
      this.sourceTopic.split("/")[3] || this.sourceTopic.split("/").pop();

    // 3. Connect IPC MQTT.
    this.mqtt = mqtt.connect(c.url, {
      clientId: c.client_id,
      username: c.username,
      password: c.password,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });
    this.mqtt.on("connect", () => this._onMqttConnect());
    this.mqtt.on("message", (topic, payload) => this._onMessage(payload));
    this.mqtt.on("error", (err) => this._emit("error", err));

    this.log(
      "info",
      `[WebRTC] OpenAPI IPC MQTT ${redactUrl(c.url)} moto=${this.motoId || "<empty>"} authLen=${(this.auth || "").length} localKey=${this.localKey ? "yes" : "no"} ice=${this.iceServers.length}`,
    );
    this._emit("config", {
      iceServers: this.iceServers,
      auth: this.auth,
      motoId: this.motoId,
      deviceId,
    });
  }

  _normalizeIces(ices) {
    // Normalise urls to arrays — the camera JSON.parses msg.token.
    const out = (ices || []).map((ice) => ({
      urls: Array.isArray(ice.urls) ? ice.urls : [ice.urls],
      ...(ice.username ? { username: ice.username } : {}),
      ...(ice.credential ? { credential: ice.credential } : {}),
    }));
    if (out.length === 0) out.push({ urls: ["stun:stun.l.google.com:19302"] });
    return out;
  }

  /**
   * Smart Life app flow (tuya-ipc-terminal): app login → /api/jarvis/mqtt →
   * wss://{MobileMqttsUrl}/mqtt with web_{msid} → /api/jarvis/config for the
   * WebRTC config. Returns true on success.
   */
  async _startAppFlow(deviceId) {
    try {
      const { appLogin, appMqttConfig, appWebrtcConfig } = require("../cloud/appapi");
      // Separate Smart Life app credentials let the user provide the real app
      // password when it differs from the OpenAPI project credentials.
      const username = this.options.appUsername || this.options.username;
      const password = this.options.appPassword || this.options.password;
      const countryCode =
        this.options.appCountryCode != null
          ? this.options.appCountryCode
          : this.options.countryCode;
      const session = await appLogin(
        username,
        password,
        countryCode,
        this.options.appHost || this.api.endpoint,
        this.log,
      );
      const mq = await appMqttConfig(session);
      const wr = await appWebrtcConfig(session, deviceId);
      const r = wr.result;

      this.motoId = r.motoId || r.moto_id || "";
      this.auth = r.auth || "";
      this.localKey = r.localKey || r.local_key || this.localKey;
      this.iceServers = this._normalizeIces(r.p2pConfig && r.p2pConfig.ices);

      const domain = (session.result && session.result.domain) || {};
      const msid = mq.msid;
      const url = `wss://${domain.MobileMqttsUrl || mq.host}/mqtt`;
      this.sinkTopic = `/av/moto/${this.motoId}/u/${deviceId}`;
      this.sourceTopic = `/av/u/${msid}`;
      this.from = msid;

      this.mqtt = mqtt.connect(url, {
        clientId: `web_${msid}`,
        username: `web_${msid}`,
        password: mq.password,
        keepalive: 30,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
      });
      this.mqtt.on("connect", () => this._onMqttConnect());
      this.mqtt.on("message", (topic, payload) => this._onMessage(payload));
      this.mqtt.on("error", (err) => this._emit("error", err));

      this.log(
        "info",
        `[WebRTC] App flow: broker=${redactUrl(url)} msid=${msid} moto=${this.motoId || "<empty>"} authLen=${(this.auth || "").length} localKey=${this.localKey ? "yes" : "no"} ice=${this.iceServers.length}`,
      );
      this._emit("config", {
        iceServers: this.iceServers,
        auth: this.auth,
        motoId: this.motoId,
        deviceId,
      });
      return true;
    } catch (e) {
      this.log("debug", `[WebRTC] App flow failed: ${e.message || e}`);
      return false;
    }
  }

  _resolve(topic) {
    if (!topic) return "";
    return topic
      .replace("{device_id}", this.deviceId)
      .replace("{dev_id}", this.deviceId)
      .replace("{moto_id}", this.motoId)
      .replace("{uid}", this.uid || "")
      .replace("moto_id", this.motoId);
  }

  _onMqttConnect() {
    this.log("info", "[WebRTC] IPC MQTT connected");
    if (this.sourceTopic) {
      this.mqtt.subscribe(this.sourceTopic, (err) => {
        if (err) this.log("warn", `[WebRTC] subscribe ${this.sourceTopic}: ${err.message}`);
        else this.log("info", `[WebRTC] Subscribed to: ${this.sourceTopic}`);
      });
    }
    // Battery camera wake — CRC32(local_key) → m/w/{devId} (QoS 1, go2rtc).
    this._sendWake();
    // Offer that arrived while we were still connecting.
    if (this._pendingOffer) {
      const o = this._pendingOffer;
      this._pendingOffer = null;
      this.sendOffer(o.sdp, o.streamType);
    }
  }

  _sendWake() {
    if (!this.localKey || !this.mqtt || !this.mqtt.connected) return;
    const crc = crc32(this.localKey);
    const p = Buffer.alloc(4);
    p.writeUInt32BE(crc, 0);
    const topic = `m/w/${this.deviceId}`;
    this.mqtt.publish(topic, p, { qos: 1 }, (err) => {
      if (err) this.log("warn", `[WebRTC] wake publish to ${topic}: ${err.message || err}`);
    });
    this.log("info", `[WebRTC] Wake sent to ${topic} crc=${crc.toString(16)}`);
  }

  sendOffer(sdp, streamType = 1) {
    // Strip a=extmap lines to stay under Tuya's ~8KB MQTT payload limit.
    sdp = sdp.replace(/\r\na=extmap[^\r\n]*/g, "");
    if (!this.mqtt || !this.mqtt.connected || !this.sinkTopic) {
      this._pendingOffer = { sdp, streamType };
      return;
    }
    this.sessionId = this.sessionId || newSessionId();
    this._answered = false;
    this._lastOffer = { sdp, streamType };
    this._publishOffer(sdp, streamType);
    this.log(
      "info",
      `[WebRTC] Offer published session=${this.sessionId} topic=${this.sinkTopic}`,
    );

    // Battery cameras connect to the IPC broker 30-90s after waking — keep
    // re-publishing (with the wake) until the camera answers.
    clearInterval(this._offerTimer);
    let tries = 0;
    this._offerTimer = setInterval(() => {
      if (this._answered || ++tries >= OFFER_RETRY_TRIES) {
        clearInterval(this._offerTimer);
        return;
      }
      this._sendWake();
      this.log("info", "[WebRTC] Re-sending offer (camera still booting)...");
      this._publishOffer(sdp, streamType);
    }, OFFER_RETRY_MS);
  }

  _publishOffer(sdp, streamType) {
    this._publish(
      "offer",
      {
        mode: "webrtc",
        sdp,
        stream_type: streamType,
        auth: this.auth,
        token: this.iceServers,
        // tuya-ipc-terminal always sends replay:{is_replay:0} — the camera
        // firmware may reject an offer without it.
        replay: { is_replay: 0 },
        // HEVC requires the camera to send via the DataChannel.
        datachannel_enable: /a=rtpmap:\d+\s+(H265|HEVC)\/90000/i.test(sdp),
      },
      WEBRTC_PROTOCOL,
    );
  }

  sendCandidate(candidate) {
    if (!this.sessionId) return;
    this._publish("candidate", { mode: "webrtc", candidate }, WEBRTC_PROTOCOL);
  }

  // Protocol 312 resolution command — sent after the answer when the camera
  // supports clarity switching (go2rtc does the same).
  sendResolution(resolution = 0) {
    if (!this.sessionId) return;
    // tuya-ipc-terminal: protocol 312 with {mode, cmdValue}.
    this._publish(
      "resolution",
      { mode: "webrtc", cmdValue: resolution },
      RESOLUTION_PROTOCOL,
    );
  }

  sendDisconnect() {
    if (this.sessionId) {
      this._publish("disconnect", { mode: "webrtc" }, WEBRTC_PROTOCOL);
    }
  }

  _publish(type, msg, protocol) {
    if (!this.mqtt || !this.mqtt.connected || !this.sinkTopic) return;
    const payload = JSON.stringify({
      protocol,
      pv: "2.2",
      // tuya-ipc-terminal uses epoch milliseconds; the camera may compare t.
      t: Date.now(),
      data: {
        header: {
          type,
          from: this.from,
          to: this.deviceId,
          sessionid: this.sessionId,
          moto_id: this.motoId,
          tid: "",
          seq: 0,
          rtx: 0,
        },
        msg,
      },
    });
    this.mqtt.publish(this.sinkTopic, payload, { qos: 1 }, (err) => {
      if (err) this.log("error", `[WebRTC] publish ${type} failed: ${err.message || err}`);
    });
  }

  _onMessage(payload) {
    let m;
    try {
      m = JSON.parse(payload.toString());
    } catch (_) {
      return;
    }
    // Accept both flat (go2rtc) and nested (protocol-as-string) envelopes.
    const data = (m.data && m.data.data) || m.data || m;
    const h = data.header;
    if (!h || !h.type) return;
    this.log("info", `[WebRTC] MQTT rx type=${h.type} session=${h.sessionid || ""}`);
    switch (h.type) {
      case "answer":
        this._answered = true;
        clearInterval(this._offerTimer);
        this._emit("answer", { sdp: data.msg && data.msg.sdp, sessionId: h.sessionid });
        break;
      case "candidate":
        // tuya-ipc-terminal: camera candidates start with "a=" and end with
        // "\r" — trim them so the browser WebRTC accepts them.
        this._emit("candidate", {
          candidate: (data.msg && data.msg.candidate || "")
            .replace(/^a=/, "")
            .replace(/\r$/, ""),
          sessionId: h.sessionid,
        });
        break;
      case "disconnect":
        this._emit("disconnect", { sessionId: h.sessionid });
        break;
    }
  }

  disconnect() {
    try {
      this.sendDisconnect();
    } catch (_) {}
    clearInterval(this._offerTimer);
    if (this.mqtt) {
      try {
        this.mqtt.end(true);
      } catch (_) {}
      this.mqtt = null;
    }
    this.sessionId = null;
  }
}

module.exports = WebRTCSignaling;
