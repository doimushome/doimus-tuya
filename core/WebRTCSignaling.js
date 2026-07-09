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
    // Battery camera wake tracking: when true, the offer is buffered until
    // setWoken() is called (after the camera reports wireless_awake=true).
    this._woken = false;
    this._wakePendingOffer = null;
    this._wakePendingCandidates = [];
    this._wakeFlushTimer = null;
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
      for (let i = 0; i < wr.p2p_config.ices.length; i++) {
        const ice = wr.p2p_config.ices[i];
        // Skip credential-only entries without urls — they produce
        // malformed {"credential":"..."} objects that crash the
        // camera's ICE server JSON parser. Credential data for TURN
        // servers is typically embedded in the TURN entry itself.
        if (!ice.urls) {
          this.log("debug", `[WebRTC] Skipping ICE entry ${i} (no urls)`);
          continue;
        }
        // go2rtc serializes the ICE token using pion's ICEServer struct,
        // which marshals `urls` as a JSON array: ["stun:..."].  Tuya camera
        // firmware JSON.parses(msg.token) and expects `urls` to be an array
        // (not a bare string).  String urls cause the camera to reject the
        // offer with a WebRTC disconnect ~10s after publication.
        const urls = Array.isArray(ice.urls) ? ice.urls : [ice.urls];
        const server = { urls };
        if (ice.username) server.username = ice.username;
        if (ice.credential) server.credential = ice.credential;
        iceServers.push(server);
      }
    } else {
      // Tuya returned empty ICE servers — add a default STUN so the
      // camera's WebRTC stack can still attempt NAT traversal and the
      // token field is valid JSON.
      iceServers.push({ urls: ["stun:stun.l.google.com:19302"] });
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

            // Send the offer immediately, not after a 35s delay.  go2rtc
            // sends the CRC32 wake and the WebRTC offer back-to-back with
            // no waiting, and battery cameras respond within 5-10s.  Our
            // camera sends an internal WebRTC disconnect ~10s after the
            // session starts if no offer arrives — so any delay >10s
            // guarantees failure.
            if (this._pendingOffer) {
              const { sdp, streamType } = this._pendingOffer;
              this._pendingOffer = null;
              this.log(
                "info",
                "[WebRTC] Battery camera — sending offer immediately after CRC32 wake",
              );
              this._doSendOffer(sdp, streamType);
            } else {
              this.log(
                "info",
                "[WebRTC] Battery camera — CRC32 wake sent, awaiting offer from mobile",
              );
            }

            // Safety net: if the mobile app's offer arrives very late
            // (>30s), flush it via setWoken().  This is longer than the
            // camera's 10s session timeout, but prevents a permanently
            // stuck session if the mobile app takes unusually long.
            if (!this._wakeFlushTimer) {
              this._wakeFlushTimer = setTimeout(() => {
                this._wakeFlushTimer = null;
                if (!this._woken) {
                  this.log(
                    "info",
                    "[WebRTC] Proactive wake flush — sending buffered offer (safety net)",
                  );
                  this.setWoken();
                }
              }, 30000);
            }
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
    // Send the offer as soon as it arrives, even for battery cameras.
    // The CRC32 wake (sent on IPC MQTT connect) is sufficient to wake
    // the camera's WebRTC subsystem — go2rtc sends both the wake and
    // the offer back-to-back with no delay, and battery cameras respond
    // within 5-10s.  Buffering the offer until a wake confirmation that
    // never arrives (this camera model never sends wireless_awake=true)
    // caused the camera's internal 10s session timeout to fire before
    // the offer was published.
    //
    // If MQTT isn't connected yet, buffer in _pendingOffer (flushed
    // in the MQTT connect handler).
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

    // Detect codec from SDP for the datachannel_enable field.
    // HEVC (H.265) requires datachannel_enable=true per Tuya spec.
    // See go2rtc: DatachannelEnable = isHEVC
    const isHEVC = /a=rtpmap:\d+\s+(H265|HEVC)\/90000/i.test(sdp);

    // ── Offer message fields ────────────────────────────────────────
    // Tuya camera WebRTC stacks expect these fields in the offer msg:
    //   - auth:        Session auth token from Tuya config
    //   - token:       ICE server list from p2p_config.ices.  Some
    //     camera firmware parse this to configure their ICE agent.
    //     go2rtc always includes it and it's required for battery-
    //     powered sp/doorbell cameras whose stack validates the
    //     full offer structure.
    //   - datachannel_enable: true for HEVC, false for H264.
    //     Must be present per Tuya WebRTC spec.
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
          // ICE server list as raw JSON array — Tuya camera firmware
          // parses msg.token directly.  go2rtc sends token as a raw
          // JSON array (json.RawMessage), not a string.  Each entry
          // must have at minimum a "urls" field.
          token: this.webrtcConfig.iceServers,
          datachannel_enable: isHEVC,
        },
      },
    };

    const payload = JSON.stringify(msg);
    const topic = this._resolveTopic();
    this.log(
      "info",
      `[WebRTC] Publishing offer (session=${this.sessionId}, topic=${topic}, payloadLen=${payload.length}, motoId=${this.webrtcConfig.motoId || "<empty>"}, authLen=${(this.webrtcConfig.auth || "").length})`,
    );
    this.log(
      "debug",
      `[WebRTC] Offer SDP preview (first 600 chars): ${(sdp || "").slice(0, 600).replace(/\n/g, "\\n")}`,
    );
    this.log(
      "debug",
      `[WebRTC] Offer token: ${JSON.stringify(this.webrtcConfig.iceServers).length > 300 ? JSON.stringify(this.webrtcConfig.iceServers).slice(0, 300) + "..." : JSON.stringify(this.webrtcConfig.iceServers)}`,
    );
    this._publish(payload);

    // Flush any candidates that were buffered before the offer was sent.
    this._flushCandidates();

    // Battery cameras (peephole, doorbell) can take 30-50s to fully
    // initialise their video subsystem after the wake commands.
    // Start a generous fallback timer — if the camera doesn't answer,
    // emit "fallback" so the plugin can switch to StreamAllocation.
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    // Battery cameras (peephole, doorbell) can take 80-90s to fully
    // initialise their video subsystem. Use a generous timeout.
    const FALLBACK_TIMEOUT = this._needsWake ? 120000 : 15000;
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
    // Candidates that arrive before a sessionId is established are
    // buffered in _pendingCandidates and flushed after the offer is
    // sent.  We don't separately buffer for battery camera wake — the
    // IPC MQTT broker handles delivery once the camera is reachable.
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

  /**
   * Called when the camera confirms wake (wireless_awake=true received
   * via cloud MQTT). Flushes any buffered offer and candidates.
   */
  setWoken() {
    if (this._woken) return;
    this._woken = true;
    // Cancel the proactive wake flush timer since we're waking up now
    if (this._wakeFlushTimer) {
      clearTimeout(this._wakeFlushTimer);
      this._wakeFlushTimer = null;
    }
    this.log(
      "info",
      "[WebRTC] Camera wake confirmed — flushing buffered offer",
    );

    // Flush wake-buffered offer
    if (this._wakePendingOffer) {
      const { sdp, streamType } = this._wakePendingOffer;
      this._wakePendingOffer = null;
      this._doSendOffer(sdp, streamType);
    }

    // Flush wake-buffered candidates
    if (this._wakePendingCandidates.length > 0) {
      this.log(
        "info",
        `[WebRTC] Flushing ${this._wakePendingCandidates.length} wake-buffered candidates`,
      );
      for (const c of this._wakePendingCandidates) {
        this.sendCandidate(c);
      }
      this._wakePendingCandidates = [];
    }
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
    if (this._wakeFlushTimer) {
      clearTimeout(this._wakeFlushTimer);
      this._wakeFlushTimer = null;
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
    this._wakePendingOffer = null;
    this._wakePendingCandidates = [];
    this._woken = false;
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

        // ── Protocol 4: Tuya DP status update ────────────────────────
        // Battery cameras (sp, doorbell) may report wireless_awake=true
        // via the IPC MQTT channel on the smart/decrypt/in/{deviceId}
        // topic before it arrives on cloud MQTT. If we detect wake
        // confirmation here, we can speed up the offer flush.
        if (protocolNum === 4) {
          this._checkWakeInProtocol4(parsed);
        }
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

  /**
   * Check a protocol-4 (DP status) message for wireless_awake=true.
   * Tuya IPC MQTT may deliver this before the cloud MQTT path, allowing
   * us to resolve the wake watcher and flush the WebRTC offer earlier.
   *
   * Handles both Tuya formats:
   *   - dps object:  { dps: { "149": true, ... } }
   *   - status array: { status: [{ code: "wireless_awake", value: true }] }
   */
  _checkWakeInProtocol4(parsed) {
    try {
      const data = parsed.data || parsed;
      let awake = false;

      // Format 1: dps object (Tuya DP IDs as keys)
      // DP 149 = wireless_awake
      const dps = data.dps;
      if (dps && typeof dps === "object") {
        const val = dps["149"];
        if (val === true || val === "true" || val === 1 || val === "1") {
          awake = true;
        }
      }

      // Format 2: status array with code/value pairs
      const status = data.status;
      if (!awake && Array.isArray(status)) {
        for (const s of status) {
          if (
            s.code === "wireless_awake" &&
            (s.value === true || s.value === "true")
          ) {
            awake = true;
            break;
          }
        }
      }

      // Format 3: flattened dps in the root object (some Tuya firmware)
      if (!awake && data["149"] !== undefined) {
        const val = data["149"];
        if (val === true || val === "true" || val === 1 || val === "1") {
          awake = true;
        }
      }

      if (awake) {
        this.log(
          "info",
          "[WebRTC] IPC MQTT protocol-4 wake confirmation detected — calling setWoken() early",
        );
        this.setWoken();
      }
    } catch (e) {
      this.log("debug", `[WebRTC] Protocol-4 wake check error: ${e.message}`);
    }
  }
}

module.exports = WebRTCSignaling;
