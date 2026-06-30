"use strict";

const mqtt = require("mqtt");
const { v4: uuidv4 } = require("uuid");

/**
 * Tuya WebRTC Signaling Client
 *
 * Connects to Tuya's IPC MQTT broker and manages WebRTC SDP exchange between
 * the mobile app (via the Doimus backend) and a Tuya camera/doorbell.
 *
 * Flow:
 *  1. Fetch WebRTC configs (ICE servers, auth token) and IPC MQTT configs
 *  2. Connect to IPC MQTT broker
 *  3. Mobile app sends "start" → plugin creates SDP offer, sends to camera via MQTT
 *  4. Camera responds with SDP answer → plugin relays to mobile app
 *  5. ICE candidates exchanged bidirectionally
 *  6. WebRTC P2P connection established between mobile and camera
 *
 * Events emitted:
 *   "config"        — { iceServers, auth, motoId, deviceId }
 *   "offer"         — { sdp, sessionId }
 *   "answer"        — { sdp, sessionId }
 *   "candidate"     — { candidate, sessionId }
 *   "disconnect"    — { sessionId }
 *   "error"         — Error
 */

const WEBRTC_PROTOCOL = 302;

class WebRTCSignaling {
  constructor(api, log) {
    this.api = api;
    this.log = log;
    this.linkId = uuidv4();
    this.mqttClient = null;
    this.mqttConfig = null;
    this.webrtcConfig = null;
    this.sessionId = null;
    this.running = false;
    this._listeners = {};
    this._expireTimer = null;
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach((h) => {
      try { h(data); } catch (_) {}
    });
  }

  /**
   * Fetch WebRTC and IPC MQTT configs from Tuya API.
   * Returns { iceServers, auth, motoId } or null if WebRTC not supported.
   */
  async getConfigs(deviceId) {
    const uid = this.api.tokenInfo.uid;
    if (!uid) {
      this.log("warn", "[WebRTC] No UID available — cannot fetch configs");
      return null;
    }

    // 1. Get WebRTC configs (ICE servers, auth token)
    const wrRes = await this.api.get(
      `/v1.0/users/${uid}/devices/${deviceId}/webrtc-configs`,
    );
    if (!wrRes.success || !wrRes.result || !wrRes.result.supports_webrtc) {
      this.log(
        "debug",
        `[WebRTC] Device ${deviceId} does not support WebRTC`,
      );
      return null;
    }

    const wr = wrRes.result;
    const iceServers = [];
    if (wr.p2p_config && wr.p2p_config.ices) {
      for (const ice of wr.p2p_config.ices) {
        const server = { urls: ice.urls };
        if (ice.username) server.username = ice.username;
        if (ice.credential) server.credential = ice.credential;
        iceServers.push(server);
      }
    }

    this.webrtcConfig = {
      auth: wr.auth,
      motoId: wr.moto_id || "",
      iceServers,
      deviceId,
      supportsWebrtc: true,
    };

    // 2. Get IPC MQTT configs
    const mqRes = await this.api.post("/v1.0/iot-03/open-hub/access-config", {
      uid,
      link_id: this.linkId,
      link_type: "mqtt",
      topics: "ipc",
      msg_encrypted_version: "1.0",
    });

    if (!mqRes.success || !mqRes.result) {
      this.log(
        "warn",
        `[WebRTC] Failed to get IPC MQTT configs: code=${mqRes.code} msg=${mqRes.msg}`,
      );
      return null;
    }

    this.mqttConfig = mqRes.result;

    this._emit("config", {
      iceServers: this.webrtcConfig.iceServers,
      auth: this.webrtcConfig.auth,
      motoId: this.webrtcConfig.motoId,
      deviceId,
    });

    return this.webrtcConfig;
  }

  /**
   * Connect to the IPC MQTT broker for WebRTC signaling.
   */
  connect() {
    if (!this.mqttConfig) {
      this.log("warn", "[WebRTC] No MQTT config — call getConfigs() first");
      return;
    }

    if (this.mqttClient) {
      this.disconnect();
    }

    this.running = true;

    const { url, client_id, username, password, source_topic, expire_time } =
      this.mqttConfig;

    this.log(
      "info",
      `[WebRTC] Connecting to IPC MQTT: ${url} client_id=${client_id}`,
    );

    this.mqttClient = mqtt.connect(url, {
      clientId: client_id,
      username,
      password,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    this.mqttClient.on("connect", () => {
      this.log("info", "[WebRTC] IPC MQTT connected");

      // Subscribe to the source topic (camera → client messages)
      const topic = source_topic?.ipc;
      if (topic) {
        this.mqttClient.subscribe(topic, (err) => {
          if (err) {
            this.log("error", `[WebRTC] Subscribe error: ${err.message}`);
          } else {
            this.log("info", `[WebRTC] Subscribed to: ${topic}`);
          }
        });
      }
    });

    this.mqttClient.on("message", (topic, payload) => {
      this._handleMessage(topic, payload);
    });

    this.mqttClient.on("error", (err) => {
      this.log("error", `[WebRTC] MQTT error: ${err.message}`);
      this._emit("error", err);
    });

    this.mqttClient.on("close", () => {
      this.log("info", "[WebRTC] IPC MQTT disconnected");
      if (this.running) {
        // mqtt.js auto-reconnects; just emit for UI awareness
      }
    });

    // Reconnect before token expires
    const ttl = ((expire_time || 7200) - 120) * 1000;
    this._expireTimer = setTimeout(() => {
      this.log("debug", "[WebRTC] Token expiry — reconnecting");
      this.disconnect();
      this.connect();
    }, ttl);
  }

  /**
   * Send a WebRTC offer to the camera via MQTT.
   */
  sendOffer(sdp, streamType = 1) {
    if (!this.mqttConfig || !this.webrtcConfig) return;
    this.sessionId = uuidv4().replace(/-/g, "");

    const msg = {
      protocol: WEBRTC_PROTOCOL,
      pv: "2.2",
      t: Math.floor(Date.now() / 1000),
      data: {
        header: {
          from: this._getFrom(),
          to: this.webrtcConfig.deviceId,
          sessionid: this.sessionId,
          moto_id: this.webrtcConfig.motoId,
          type: "offer",
        },
        msg: {
          mode: "webrtc",
          sdp,
          stream_type: streamType,
          auth: this.webrtcConfig.auth,
        },
      },
    };

    this._publish(JSON.stringify(msg));
    this.log("info", `[WebRTC] Offer sent session=${this.sessionId}`);
  }

  /**
   * Send a WebRTC answer to the camera via MQTT.
   */
  sendAnswer(sdp) {
    if (!this.mqttConfig || !this.webrtcConfig || !this.sessionId) return;

    const msg = {
      protocol: WEBRTC_PROTOCOL,
      pv: "2.2",
      t: Math.floor(Date.now() / 1000),
      data: {
        header: {
          from: this._getFrom(),
          to: this.webrtcConfig.deviceId,
          sessionid: this.sessionId,
          moto_id: this.webrtcConfig.motoId,
          type: "answer",
        },
        msg: {
          mode: "webrtc",
          sdp,
        },
      },
    };

    this._publish(JSON.stringify(msg));
    this.log("info", `[WebRTC] Answer sent session=${this.sessionId}`);
  }

  /**
   * Send an ICE candidate to the camera via MQTT.
   */
  sendCandidate(candidate) {
    if (!this.mqttConfig || !this.webrtcConfig || !this.sessionId) return;

    const msg = {
      protocol: WEBRTC_PROTOCOL,
      pv: "2.2",
      t: Math.floor(Date.now() / 1000),
      data: {
        header: {
          from: this._getFrom(),
          to: this.webrtcConfig.deviceId,
          sessionid: this.sessionId,
          moto_id: this.webrtcConfig.motoId,
          type: "candidate",
        },
        msg: {
          mode: "webrtc",
          candidate,
        },
      },
    };

    this._publish(JSON.stringify(msg));
  }

  /**
   * Send a disconnect message.
   */
  sendDisconnect() {
    if (!this.mqttConfig || !this.webrtcConfig || !this.sessionId) return;

    const msg = {
      protocol: WEBRTC_PROTOCOL,
      pv: "2.2",
      t: Math.floor(Date.now() / 1000),
      data: {
        header: {
          from: this._getFrom(),
          to: this.webrtcConfig.deviceId,
          sessionid: this.sessionId,
          moto_id: this.webrtcConfig.motoId,
          type: "disconnect",
        },
        msg: { mode: "webrtc" },
      },
    };

    this._publish(JSON.stringify(msg));
    this.log("info", `[WebRTC] Disconnect sent session=${this.sessionId}`);
    this.sessionId = null;
  }

  disconnect() {
    this.running = false;
    if (this._expireTimer) {
      clearTimeout(this._expireTimer);
      this._expireTimer = null;
    }
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  _getFrom() {
    // The "from" field is the unique client ID from the MQTT config's source_topic
    const src = this.mqttConfig?.source_topic?.ipc || "";
    const prefix = "/av/u/";
    const idx = src.indexOf(prefix);
    return idx >= 0 ? src.slice(idx + prefix.length) : this.mqttConfig?.client_id || "";
  }

  _publish(payload) {
    const topic = this.mqttConfig?.sink_topic?.ipc;
    if (!topic || !this.mqttClient) return;
    this.mqttClient.publish(topic, payload);
  }

  _handleMessage(topic, payload) {
    try {
      const parsed = JSON.parse(payload.toString());
      if (parsed.protocol !== WEBRTC_PROTOCOL) return;

      const { data } = parsed;
      if (!data || !data.header) return;

      const { type, sessionid } = data.header;

      switch (type) {
        case "answer":
          this.log(
            "info",
            `[WebRTC] Answer received session=${sessionid}`,
          );
          this._emit("answer", {
            sdp: data.msg?.sdp,
            sessionId: sessionid,
          });
          break;

        case "candidate":
          this._emit("candidate", {
            candidate: data.msg?.candidate,
            sessionId: sessionid,
          });
          break;

        case "disconnect":
          this.log(
            "info",
            `[WebRTC] Disconnect received from camera session=${sessionid}`,
          );
          this._emit("disconnect", { sessionId: sessionid });
          break;

        default:
          this.log(
            "debug",
            `[WebRTC] Unhandled message type: ${type}`,
          );
      }
    } catch (e) {
      this.log("warn", `[WebRTC] Message parse error: ${e.message}`);
    }
  }
}

module.exports = WebRTCSignaling;
