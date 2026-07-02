"use strict";

const mqtt = require("mqtt");
const crypto = require("crypto");
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

/**
 * CRC32 (IEEE 802.3 / zlib) of a string or Buffer.
 * Used for the IPC MQTT low-power wake-up message (go2rtc-compatible).
 */
function crc32(data) {
  if (typeof data === "string") data = Buffer.from(data, "utf8");
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
    // Buffers for offer/candidates that arrive before the MQTT connection
    // is ready (i.e. while getConfigs() is still fetching from Tuya API).
    this._pendingOffer = null;
    this._pendingCandidates = [];
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
        this.log(
          "error",
          `[WebRTC] Event handler error (${event}): ${e.message || e}`,
        );
      }
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
      this.log("debug", `[WebRTC] Device ${deviceId} does not support WebRTC`);
      return null;
    }

    const wr = wrRes.result;
    this.log(
      "info",
      `[WebRTC] Config: moto_id=${wr.moto_id || ""} auth_len=${(wr.auth || "").length} p2p_config=${JSON.stringify(wr.p2p_config || {}).slice(0, 200)}`,
    );
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
  connect(deviceId, localKey, webrtcConfig, needsWake) {
    // Store these for the wake-up message and offer Token field.
    this._deviceId = deviceId;
    this._localKey = localKey;
    this._webrtcConfigFull = webrtcConfig;
    this._needsWake = !!needsWake;

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

      // Low-power battery camera wake-up via IPC MQTT (go2rtc-compatible).
      // The cloud DP (wireless_awake) wakes the cloud link; this CRC32
      // message on the IPC broker activates the WebRTC subsystem.
      // Always send for battery cameras — the skill.lowPower field may be
      // 0 even on battery devices that need IPC-level wake-up.
      if (this._deviceId && this._localKey) {
        try {
          const skill =
            typeof this._webrtcConfigFull?.skill === "string"
              ? JSON.parse(this._webrtcConfigFull.skill)
              : this._webrtcConfigFull?.skill || {};
          const lowPower = skill.lowPower || skill.LowPower || 0;
          this.log(
            "info",
            `[WebRTC] Skill: lowPower=${lowPower} videos=${JSON.stringify(skill.videos || skill.Videos || [])} full=${JSON.stringify(skill).slice(0, 300)}`,
          );
          if (this._needsWake) {
            const crc = crc32(this._localKey);
            const wakePayload = Buffer.alloc(4);
            wakePayload.writeUInt32BE(crc, 0);
            const wakeTopic = `m/w/${this._deviceId}`;
            this.mqttClient.publish(
              wakeTopic,
              wakePayload,
              { qos: 1 },
              (err) => {
                if (err) {
                  this.log(
                    "warn",
                    `[WebRTC] Wake-up publish failed: ${err.message}`,
                  );
                } else {
                  this.log(
                    "info",
                    `[WebRTC] Wake-up sent to ${wakeTopic} crc=${crc.toString(16)}`,
                  );
                }
              },
            );
            const decryptTopic = `smart/decrypt/in/${this._deviceId}`;
            this.mqttClient.subscribe(decryptTopic, (err) => {
              if (!err)
                this.log("debug", `[WebRTC] Subscribed to: ${decryptTopic}`);
            });
            // Give the camera 500ms to process the wake before sending offer
            setTimeout(() => {
              if (this._pendingOffer) {
                const { sdp, streamType } = this._pendingOffer;
                this._pendingOffer = null;
                this.log(
                  "info",
                  "[WebRTC] Flushing buffered offer (after wake)",
                );
                this._doSendOffer(sdp, streamType);
              }
            }, 500);
            return;
          }
        } catch (e) {
          this.log(
            "debug",
            `[WebRTC] Skill parse / wake-up skipped: ${e.message}`,
          );
        }
      }

      // Flush any offer/candidates that arrived before the MQTT connection
      // was established (the mobile app sends them as soon as the peer
      // connection creates them, which races with getConfigs()).
      if (this._pendingOffer) {
        const { sdp, streamType } = this._pendingOffer;
        this._pendingOffer = null;
        this.log("info", "[WebRTC] Flushing buffered offer");
        this._doSendOffer(sdp, streamType);
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
   * Buffers the offer if the MQTT connection is not yet ready.
   */
  sendOffer(sdp, streamType = 1) {
    if (!this.mqttConfig || !this.webrtcConfig || !this.mqttClient) {
      const reason = !this.mqttConfig
        ? "no MQTT config"
        : !this.webrtcConfig
          ? "no WebRTC config"
          : "MQTT client not connected yet";
      this.log("info", `[WebRTC] Buffering offer (${reason})`);
      this._pendingOffer = { sdp, streamType };
      return;
    }
    this._doSendOffer(sdp, streamType);
  }

  _doSendOffer(sdp, streamType) {
    this.sessionId = uuidv4().replace(/-/g, "");

    // Strip a=extmap lines to stay under Tuya's ~8KB MQTT payload limit.
    // These are optional header extensions the camera doesn't need.
    sdp = sdp.replace(/\r\na=extmap[^\r\n]*/g, "");

    const token = this.webrtcConfig?.iceServers
      ? JSON.stringify(this.webrtcConfig.iceServers)
      : "";

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
          token,
        },
      },
    };

    const payload = JSON.stringify(msg);
    const topic = this._resolveTopic();
    this.log(
      "info",
      `[WebRTC] Publishing offer (session=${this.sessionId}, topic=${topic}, payloadLen=${payload.length}, motoId=${this.webrtcConfig.motoId || "<empty>"})`,
    );
    this._publish(payload);

    // Flush any candidates that were buffered before the offer was sent.
    this._flushCandidates();

    // Start a 10s fallback timer — if the camera doesn't answer the
    // offer, emit "fallback" so the plugin can switch to P2P streaming.
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    this._fallbackTimer = setTimeout(() => {
      this.log("info", "[WebRTC] No answer within 10s — emitting fallback");
      this._emit("fallback", { sessionId: this.sessionId });
    }, 10000);
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
   * Buffers candidates if the session is not yet established.
   */
  sendCandidate(candidate) {
    if (!this.mqttConfig || !this.webrtcConfig || !this.sessionId) {
      this._pendingCandidates.push(candidate);
      return;
    }

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

  _flushCandidates() {
    if (this._pendingCandidates.length === 0) return;
    this.log(
      "debug",
      `[WebRTC] Flushing ${this._pendingCandidates.length} buffered candidates`,
    );
    for (const c of this._pendingCandidates) {
      // Re-invoke sendCandidate without the early-return guard.
      // We know configs and sessionId are set at this point.
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
            candidate: c,
          },
        },
      };
      this._publish(JSON.stringify(msg));
    }
    this._pendingCandidates = [];
  }

  disconnect() {
    this.running = false;
    if (this._expireTimer) {
      clearTimeout(this._expireTimer);
      this._expireTimer = null;
    }
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
    this._pendingOffer = null;
    this._pendingCandidates = [];
  }

  // ── Private ──────────────────────────────────────────────────────────

  _getFrom() {
    // The "from" field is the unique client ID from the MQTT config's source_topic
    const src = this.mqttConfig?.source_topic?.ipc || "";
    const prefix = "/av/u/";
    const idx = src.indexOf(prefix);
    return idx >= 0
      ? src.slice(idx + prefix.length)
      : this.mqttConfig?.client_id || "";
  }

  _publish(payload) {
    const topic = this._resolveTopic();
    if (!topic) {
      this.log(
        "error",
        "[WebRTC] Cannot publish: sink_topic.ipc is missing from MQTT config",
      );
      return;
    }
    if (!this.mqttClient) {
      this.log("error", "[WebRTC] Cannot publish: MQTT client not connected");
      return;
    }
    this.mqttClient.publish(topic, payload, (err) => {
      if (err) {
        this.log("error", `[WebRTC] Publish failed: ${err.message || err}`);
      }
    });
  }

  // Resolve the publish topic, replacing {device_id} placeholder with the
  // actual device ID.  The Tuya access-config API returns a template string.
  _resolveTopic() {
    let topic = this.mqttConfig?.sink_topic?.ipc || "";
    if (topic.includes("{device_id}") && this.webrtcConfig?.deviceId) {
      topic = topic.replace("{device_id}", this.webrtcConfig.deviceId);
    }
    return topic;
  }

  _handleMessage(topic, payload) {
    try {
      const raw = payload.toString();
      // Log every received message so we can see if the camera replies at all.
      this.log(
        "info",
        `[WebRTC] MQTT rx topic=${topic} len=${raw.length} preview=${raw.slice(0, 200)}`,
      );
      const parsed = JSON.parse(raw);
      if (parsed.protocol !== WEBRTC_PROTOCOL) {
        this.log(
          "info",
          `[WebRTC] Non-WebRTC message protocol=${parsed.protocol} data=${JSON.stringify(parsed.data || parsed).slice(0, 200)}`,
        );
        return;
      }

      const { data } = parsed;
      if (!data || !data.header) return;

      const { type, sessionid } = data.header;
      this.log(
        "info",
        `[WebRTC] Camera message type=${type} session=${sessionid}`,
      );

      switch (type) {
        case "answer":
          if (this._fallbackTimer) {
            clearTimeout(this._fallbackTimer);
            this._fallbackTimer = null;
          }
          this.log("info", `[WebRTC] Answer received session=${sessionid}`);
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
          this.log("debug", `[WebRTC] Unhandled message type: ${type}`);
      }
    } catch (e) {
      this.log("warn", `[WebRTC] Message parse error: ${e.message}`);
    }
  }
}

module.exports = WebRTCSignaling;
