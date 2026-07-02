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
    this._offerBufferTimer = null;
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
    // Build ICE server list from Tuya config. If empty, provide a default
    // STUN server so the camera has at least one ICE server config — Tuya
    // firmware JSON.parses(msg.token) to get ICE servers, and a non-JSON
    // value causes a silent parse error that drops the offer.
    const iceServers = [];
    if (wr.p2p_config && wr.p2p_config.ices && wr.p2p_config.ices.length > 0) {
      for (const ice of wr.p2p_config.ices) {
        const server = { urls: ice.urls };
        if (ice.username) server.username = ice.username;
        if (ice.credential) server.credential = ice.credential;
        iceServers.push(server);
      }
    } else {
      // Tuya returned empty ICE servers — add a default STUN so the
      // camera's WebRTC stack can still attempt NAT traversal and the
      // token field is valid JSON.
      iceServers.push({ urls: "stun:stun.l.google.com:19302" });
      this.log(
        "info",
        "[WebRTC] Tuya returned empty ICE servers — using default Google STUN",
      );
    }

    this.webrtcConfig = {
      auth: wr.auth,
      // Tuya signaling token used in the offer payload. Some devices use
      // dedicated token fields, others accept auth.
      token: wr.token || wr.webrtc_token || wr.p2p_config?.token || wr.auth,
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

      // Subscribe to source topic(s) (camera → client messages).
      // Tuya may return templates like .../{device_id}; resolve placeholders.
      const sourceTopicRaw = source_topic?.ipc;
      const sourceTopicResolved = this._resolveSourceTopic(sourceTopicRaw);
      const subscribeTopics = Array.from(
        new Set([sourceTopicRaw, sourceTopicResolved].filter(Boolean)),
      );
      if (subscribeTopics.length === 0) {
        this.log(
          "warn",
          "[WebRTC] source_topic.ipc is missing from MQTT config",
        );
      }
      for (const topic of subscribeTopics) {
        this.mqttClient.subscribe(topic, (err) => {
          if (err) {
            this.log(
              "error",
              `[WebRTC] Subscribe error (${topic}): ${err.message}`,
            );
          } else {
            this.log("info", `[WebRTC] Subscribed to: ${topic}`);
          }
        });
      }

      // Also subscribe to a wildcard so we catch any camera reply that
      // lands on an unexpected topic. This is debug-only and helps us
      // discover the real reply topic if the camera uses a non-standard path.
      this.mqttClient.subscribe("#", (err) => {
        if (err) {
          this.log(
            "debug",
            `[WebRTC] Wildcard subscribe error: ${err.message}`,
          );
        } else {
          this.log(
            "debug",
            "[WebRTC] Wildcard (#) subscribed for reply discovery",
          );
        }
      });

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

            // Some camera firmwares listen on m/w/{deviceId}, others on
            // {deviceId}/w. Send both to cover more battery camera models
            // (peephole, doorbell, etc.).  The CRC32 wake payload is the
            // same format used by go2rtc and ismartlife.me.
            const wakeTopics = [`m/w/${this._deviceId}`, `${this._deviceId}/w`];
            for (const wt of wakeTopics) {
              this.mqttClient.publish(wt, wakePayload, { qos: 1 }, (err) => {
                if (err) {
                  this.log(
                    "warn",
                    `[WebRTC] Wake-up publish failed to ${wt}: ${err.message}`,
                  );
                } else {
                  this.log(
                    "info",
                    `[WebRTC] Wake-up sent to ${wt} crc=${crc.toString(16)}`,
                  );
                }
              });
            }

            const decryptTopic = `smart/decrypt/in/${this._deviceId}`;
            this.mqttClient.subscribe(decryptTopic, (err) => {
              if (!err)
                this.log("debug", `[WebRTC] Subscribed to: ${decryptTopic}`);
            });

            // Battery cameras need more time to wake their IPC MQTT
            // subsystem after the CRC32 wake message.  go2rtc uses 500ms
            // but our testing shows battery peepholes often need 3s+.
            const WAKE_DELAY_MS = 3000;
            this.log(
              "info",
              `[WebRTC] Waiting ${WAKE_DELAY_MS}ms for camera to wake before sending offer`,
            );
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
            }, WAKE_DELAY_MS);
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

      // Surface a clear timeout when the offer stays buffered too long.
      // This makes "no answer" stalls easier to debug in the UI.
      if (!this._offerBufferTimer) {
        this._offerBufferTimer = setTimeout(() => {
          this._offerBufferTimer = null;
          if (!this._pendingOffer) return;
          const msg =
            "WebRTC offer is still buffered after 12s (IPC MQTT not ready).";
          this.log("warn", `[WebRTC] ${msg}`);
          this._emit("error", new Error(msg));
        }, 12000);
      }
      return;
    }
    this._doSendOffer(sdp, streamType);
  }

  _doSendOffer(sdp, streamType) {
    if (this._offerBufferTimer) {
      clearTimeout(this._offerBufferTimer);
      this._offerBufferTimer = null;
    }

    this.sessionId = uuidv4().replace(/-/g, "");

    // Strip a=extmap lines to stay under Tuya's ~8KB MQTT payload limit.
    // These are optional header extensions the camera doesn't need.
    sdp = sdp.replace(/\r\na=extmap[^\r\n]*/g, "");

    // ICE server config is passed through the auth/token exchange — the
    // camera's WebRTC engine already knows its own ICE config from the
    // Tuya p2p_config handshake.  Including token here can confuse some
    // camera firmware that expects the basic Tuya offer format (no token,
    // no datachannel_enable per Tuya developer docs).  go2rtc includes
    // both and works with many cameras, but battery / sp-category cameras
    // may use stricter parsing.

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

    const payload = JSON.stringify(msg);
    const topic = this._resolveTopic();
    this.log(
      "info",
      `[WebRTC] Publishing offer (session=${this.sessionId}, topic=${topic}, payloadLen=${payload.length}, motoId=${this.webrtcConfig.motoId || "<empty>"}, authLen=${(this.webrtcConfig.auth || "").length})`,
    );
    this._publish(payload);

    // Flush any candidates that were buffered before the offer was sent.
    this._flushCandidates();

    // Battery cameras (peephole, doorbell) can take 10-20s to fully
    // initialise their video subsystem after the CRC32 wake.  Start a
    // generous fallback timer — if the camera doesn't answer, emit
    // "fallback" so the plugin can switch to P2P streaming.
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    const FALLBACK_TIMEOUT = this._needsWake ? 20000 : 15000;
    this._fallbackTimer = setTimeout(() => {
      this.log(
        "info",
        `[WebRTC] No answer within ${FALLBACK_TIMEOUT / 1000}s — emitting fallback`,
      );
      this._emit("fallback", { sessionId: this.sessionId });
    }, FALLBACK_TIMEOUT);
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
    if (this._offerBufferTimer) {
      clearTimeout(this._offerBufferTimer);
      this._offerBufferTimer = null;
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
    // Tuya docs: "use the string after `/av/u/` in the JSON field of
    // result.source_topic.ipc as the value of `from` in the MQTT Header."
    // go2rtc does the same: parts[3] after splitting /av/{uid}/... by /.
    // The camera checks `from` to route its answer — using the full topic
    // path causes the camera to silently drop the offer.
    const raw =
      this.mqttConfig?.source_topic?.ipc || this.mqttConfig?.client_id || "";
    const resolved = this._resolveTemplateTopic(raw);
    const parts = resolved.split("/");
    return parts[parts.length - 1] || resolved;
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

  _resolveTemplateTopic(topic) {
    if (!topic) return "";
    let out = topic;

    const deviceId = this.webrtcConfig?.deviceId || "";
    const motoId = this.webrtcConfig?.motoId || "";

    if (deviceId) {
      if (out.includes("{device_id}")) {
        out = out.replace(/\{device_id\}/g, deviceId);
      }
      if (out.includes("{dev_id}")) {
        out = out.replace(/\{dev_id\}/g, deviceId);
      }
      // Some Tuya templates use bare tokens instead of brace placeholders.
      if (out.includes("/device_id/")) {
        out = out.replace(/\/device_id\//g, `/${deviceId}/`);
      }
      if (out.endsWith("/device_id")) {
        out = out.replace(/\/device_id$/, `/${deviceId}`);
      }
    }

    if (motoId) {
      if (out.includes("{moto_id}")) {
        out = out.replace(/\{moto_id\}/g, motoId);
      }
      if (out.includes("/moto_id/")) {
        out = out.replace(/\/moto_id\//g, `/${motoId}/`);
      }
      if (out.endsWith("/moto_id")) {
        out = out.replace(/\/moto_id$/, `/${motoId}`);
      }
    }

    return out;
  }

  // Resolve the publish topic from sink_topic.ipc.
  _resolveTopic() {
    return this._resolveTemplateTopic(this.mqttConfig?.sink_topic?.ipc || "");
  }

  // Resolve the subscribe topic from source_topic.ipc.
  _resolveSourceTopic(topic) {
    return this._resolveTemplateTopic(
      topic || this.mqttConfig?.source_topic?.ipc || "",
    );
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
      const protocolNum = Number(parsed.protocol);
      if (protocolNum !== WEBRTC_PROTOCOL) {
        this.log(
          "info",
          `[WebRTC] Non-WebRTC message protocol=${parsed.protocol} data=${JSON.stringify(parsed.data || parsed).slice(0, 200)}`,
        );
        return;
      }

      const data = parsed?.data?.header ? parsed.data : parsed?.data?.data;
      if (!data || !data.header) {
        this.log("debug", "[WebRTC] WebRTC payload without header");
        return;
      }

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
