#!/usr/bin/env node

/**
 * WebRTC Self-Test Script for Tuya Battery Camera
 *
 * Tests the full WebRTC streaming flow directly against the hub,
 * without needing the mobile app. Uses @roamhq/wrtc for WebRTC.
 *
 * Usage:
 *   HUB=192.168.1.55:8765 JWT="eyJ..." node test/webrtc-self-test.js
 *
 * Environment variables:
 *   HUB      - Hub address (default: 192.168.1.55:8765)
 *   JWT      - JWT auth token (required)
 *   DEVICE   - Doimus device ID (default: a5f8b13f-3100-598e-8e27-0f8ba233022f)
 *   DEBUG    - Set to "full" for raw message dumps
 */

const WebSocket = require("ws");
const wrtc = require("@roamhq/wrtc");

// ── Configuration ──────────────────────────────────────────────────────

const HUB = process.env.HUB || "192.168.1.55:8765";
const JWT = process.env.JWT;
const DEVICE_ID = process.env.DEVICE || "a5f8b13f-3100-598e-8e27-0f8ba233022f";
const DEBUG = process.env.DEBUG === "full";

if (!JWT) {
  console.error("❌ JWT environment variable is required");
  console.error("   HUB=192.168.1.55:8765 JWT=\"eyJ...\" node test/webrtc-self-test.js");
  process.exit(1);
}

// ── State ──────────────────────────────────────────────────────────────

let ws = null;
let pc = null;
let offerSent = false;
let remoteSdpApplied = false;
let startTime = Date.now();
let candidatesSent = 0;
let candidatesReceived = 0;

// ── Logging ────────────────────────────────────────────────────────────

const LOG_PREFIX = "[WebRTC Test]";
function log(level, msg, data) {
  const ts = ((Date.now() - startTime) / 1000).toFixed(1);
  const prefix = `${ts}s ${LOG_PREFIX}`;
  if (level === "error") console.error(`❌ ${prefix} ${msg}`, data || "");
  else if (level === "warn") console.warn(`⚠️  ${prefix} ${msg}`, data || "");
  else if (level === "info") console.log(`ℹ️  ${prefix} ${msg}`, data || "");
  else if (level === "debug") console.log(`  🔍 ${prefix} ${msg}`, data || "");
  else console.log(`  ${prefix} ${msg}`, data || "");
}

// ── WebRTC PeerConnection ─────────────────────────────────────────────

function createPeerConnection() {
  log("info", "Creating WebRTC PeerConnection...");

  const config = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    sdpSemantics: "unified-plan",
  };

  pc = new wrtc.RTCPeerConnection(config);

  // Log all state changes
  pc.oniceconnectionstatechange = () => {
    log("info", `ICE connection state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      log("info", "🎉 WebRTC connected! Camera is streaming!");
    }
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      log("warn", `ICE state: ${pc.iceConnectionState}`);
    }
  };
  pc.onicegatheringstatechange = () => {
    log("debug", `ICE gathering state: ${pc.iceGatheringState}`);
  };
  pc.onsignalingstatechange = () => {
    log("debug", `Signaling state: ${pc.signalingState}`);
  };

  // Handle remote video track
  pc.ontrack = (event) => {
    log("info", `📹 Remote track received: kind=${event.track.kind} id=${event.track.id}`);
    if (event.track.kind === "video") {
      log("info", "🎉 Video track received from camera! Streaming is working!");
    }
  };

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      candidatesSent++;
      const candidateStr = `${event.candidate.sdpMLineIndex} ${event.candidate.sdpMid} ${event.candidate.candidate}`;
      log("debug", `ICE candidate #${candidatesSent}: ${candidateStr.slice(0, 100)}...`);
      sendToPlugin("candidate", { candidate: candidateStr });
    } else {
      log("info", `ICE candidate gathering complete (${candidatesSent} candidates sent)`);
    }
  };

  // Do NOT add a local video track — we want recvonly
  // Add a recvonly video transceiver
  pc.addTransceiver("video", {
    direction: "recvonly",
  });

  log("info", "Video transceiver added (recvonly)");
}

function createOffer() {
  return new Promise((resolve, reject) => {
    log("info", "Creating WebRTC offer...");

    pc.createOffer()
      .then((offer) => {
        log("info", `Offer created (type=${offer.type}, sdp.length=${offer.sdp.length})`);

        // Filter SDP to H264 only (Tuya cameras don't support VP8/VP9)
        const filteredSdp = filterSdpToH264Only(offer.sdp);
        log("info", `Filtered SDP (original=${offer.sdp.length}, filtered=${filteredSdp.length})`);

        if (DEBUG) {
          log("debug", "=== ORIGINAL SDP ===");
          console.log(offer.sdp);
          log("debug", "=== FILTERED SDP ===");
          console.log(filteredSdp);
        }

        return pc.setLocalDescription(new wrtc.RTCSessionDescription({
          type: "offer",
          sdp: filteredSdp,
        })).then(() => resolve(filteredSdp));
      })
      .catch((err) => {
        log("error", `Offer creation failed: ${err.message}`);
        reject(err);
      });
  });
}

/**
 * Filter SDP to keep only H264 video codecs.
 * Tuya cameras reject offers containing VP8/VP9/AV1.
 */
function filterSdpToH264Only(sdp) {
  const lines = sdp.split("\r\n");
  const h264Payloads = new Set();
  const payloadTypeToCodec = {};
  let inVideoSection = false;

  // First pass: identify H264 payload types
  for (const line of lines) {
    if (line.startsWith("m=video")) inVideoSection = true;
    else if (line.startsWith("m=") && !line.startsWith("m=video")) inVideoSection = false;

    if (inVideoSection && line.startsWith("a=rtpmap:")) {
      const stripped = line.slice("a=rtpmap:".length);
      const parts = stripped.split(" ");
      if (parts.length >= 2) {
        const pt = parts[0];
        const codecPart = parts[1].split("/")[0];
        payloadTypeToCodec[pt] = codecPart;
        if (codecPart.toUpperCase() === "H264") h264Payloads.add(pt);
      }
    }
  }

  if (h264Payloads.size === 0) {
    log("warn", "No H264 codecs found in SDP — sending unfiltered");
    return sdp;
  }

  // Second pass: build filtered SDP
  const result = [];
  inVideoSection = false;

  for (const line of lines) {
    if (line.startsWith("m=video")) {
      inVideoSection = true;
      const parts = line.split(" ");
      if (parts.length >= 4) {
        const keep = parts.slice(3).filter((p) => h264Payloads.has(p));
        if (keep.length > 0) {
          result.push(`m=video ${parts[1]} ${parts[2]} ${keep.join(" ")}`);
          log("debug", `Filtered m=video to ${keep.length} H264 payload(s): [${keep.join(",")}]`);
        } else {
          result.push(line);
        }
      } else {
        result.push(line);
      }
      continue;
    } else if (line.startsWith("m=")) {
      inVideoSection = false;
      result.push(line);
      continue;
    }

    if (inVideoSection) {
      const trimmed = line.trim();
      if (!trimmed) { result.push(line); continue; }

      // Check if this line references a specific payload type
      const pt = extractPayloadType(line);
      if (pt !== null) {
        if (h264Payloads.has(pt)) result.push(line);
        // else skip: non-H264 codec line
      } else {
        result.push(line); // keep non-payload-specific lines (ssrc, etc.)
      }
    } else {
      result.push(line);
    }
  }

  return result.join("\r\n");
}

function extractPayloadType(line) {
  if (line.startsWith("a=rtpmap:") || line.startsWith("a=fmtp:") || line.startsWith("a=rtcp-fb:")) {
    const afterPrefix = line.startsWith("a=rtpmap:") ? line.slice("a=rtpmap:".length)
      : line.startsWith("a=fmtp:") ? line.slice("a=fmtp:".length)
      : line.slice("a=rtcp-fb:".length);
    const pt = afterPrefix.match(/^\d+/);
    return pt ? pt[0] : null;
  }
  return null;
}

// ── WebSocket to Hub ───────────────────────────────────────────────────

function connectHub() {
  return new Promise((resolve, reject) => {
    const url = `ws://${HUB}/ws`;
    log("info", `Connecting to hub: ${url}`);

    ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${JWT}` },
    });

    ws.on("open", () => {
      log("info", "✅ Connected to hub WebSocket");
      resolve();
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleHubMessage(msg);
      } catch (e) {
        log("error", `Failed to parse hub message: ${e.message}`);
      }
    });

    ws.on("error", (err) => {
      log("error", `WebSocket error: ${err.message}`);
      reject(err);
    });

    ws.on("close", () => {
      log("info", "WebSocket closed");
    });

    // Timeout
    setTimeout(() => reject(new Error("WebSocket connection timeout")), 10000);
  });
}

function handleHubMessage(msg) {
  // Hub broadcasts webrtc_signaling in two possible formats:
  // Old format: { "type": "webrtc_signaling", "data": {"event": "config", ...}, "device_id": "...", "plugin_id": "..." }
  // The data field wraps the actual event payload.
  if (msg.type === "webrtc_signaling" && msg.device_id === DEVICE_ID) {
    // The hub relays the plugin's sendWebrtcSignaling() output directly.
    // The plugin sends: { "type": "webrtc_signaling", "device_id": "...", "webrtc_signaling": { event, ... } }
    // The hub broadcasts: { "type": "webrtc_signaling", "device_id": "...", "data": { event, ... } }
    const data = msg.data || msg.webrtc_signaling || {};
    const event = data.event;

    log("info", `📨 Hub signaling event: ${event}`, JSON.stringify(data).slice(0, 200));

    switch (event) {
      case "config":
        log("info", `📋 WebRTC config received! ICE servers: ${JSON.stringify(data.iceServers).slice(0, 100)}`);
        log("info", "Starting WebRTC peer connection...");
        createPeerConnection();
        createOffer().then((sdp) => {
          log("info", "Sending offer to plugin via hub...");
          sendToPlugin("offer", { sdp, stream_type: 1 });
        }).catch((err) => {
          log("error", `Failed to create offer: ${err.message}`);
        });
        break;

      case "answer":
        log("info", `📥 Answer received! sdp.length=${(data.sdp || "").length}`);
        if (pc && !remoteSdpApplied) {
          remoteSdpApplied = true;
          const answer = new wrtc.RTCSessionDescription({
            type: "answer",
            sdp: data.sdp,
          });
          pc.setRemoteDescription(answer)
            .then(() => log("info", "✅ Remote description set (answer applied)"))
            .catch((err) => log("error", `setRemoteDescription failed: ${err.message}`));
        }
        break;

      case "candidate":
        candidatesReceived++;
        const c = data.candidate;
        log("debug", `📥 ICE candidate #${candidatesReceived}: ${(c || "").slice(0, 80)}`);
        if (pc && c) {
          const parts = c.split(" ", 3);
          if (parts.length >= 3) {
            const candidate = new wrtc.RTCIceCandidate({
              sdpMLineIndex: parseInt(parts[0]),
              sdpMid: parts[1],
              candidate: parts[2],
            });
            pc.addIceCandidate(candidate)
              .catch((err) => log("error", `addIceCandidate failed: ${err.message}`));
          }
        }
        break;

      case "disconnect":
        log("warn", `📥 Camera disconnected (session ended)`);
        break;

      case "p2p_fallback":
        log("warn", `📥 P2P fallback triggered — WebRTC didn't connect`);
        break;

      case "waking":
        log("info", `📥 Camera waking... (${data.elapsed || 0}s elapsed)`);
        break;

      case "error":
        log("error", `📥 Hub error: ${data.message}`);
        break;

      default:
        log("debug", `📥 Unhandled event: ${event}`);
    }
  }
}

/**
 * Send a webrtc_command with event field (for offer/answer/candidate/disconnect).
 */
function sendToPlugin(event, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("error", "WebSocket not connected, cannot send message");
    return;
  }

  const msg = JSON.stringify({
    type: "webrtc_signaling",
    device_id: DEVICE_ID,
    data: { event, ...extra },
  });

  log("debug", `📤 Sending to hub: ${event}`, Object.keys(extra).join(","));
  ws.send(msg);
}

/**
 * Send a webrtc_command with action field (for start only).
 * The plugin handler checks value.action === "start".
 */
function sendToPluginRaw(action, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("error", "WebSocket not connected, cannot send message");
    return;
  }

  const msg = JSON.stringify({
    type: "webrtc_signaling",
    device_id: DEVICE_ID,
    data: { action, ...extra },
  });

  log("debug", `📤 Sending to hub: action=${action}`);
  ws.send(msg);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  log("info", "=".repeat(60));
  log("info", "Tuya Battery Camera WebRTC Self-Test");
  log("info", `Hub: ${HUB}`);
  log("info", `Device: ${DEVICE_ID}`);
  log("info", "=".repeat(60));

  try {
    // 1. Connect to hub
    await connectHub();

    // 2. Wait a moment, then start the WebRTC session
    await new Promise((r) => setTimeout(r, 1000));

    // 3. Send start command
    log("info", "Sending START command to plugin...");
    // The plugin handler checks value.action === "start", NOT value.event
    sendToPluginRaw("start");

    // 4. Wait for the session to play out
    // Watch for 120s then disconnect
    await new Promise((r) => setTimeout(r, 120000));

    // 5. Cleanup
    log("info", "Test timeout reached, disconnecting...");
    if (pc) {
      pc.close();
      pc = null;
    }
    sendToPlugin("disconnect");
    if (ws) ws.close();

    log("info", "Test complete");
    process.exit(0);
  } catch (err) {
    log("error", `Test failed: ${err.message}`);
    if (pc) pc.close();
    if (ws) ws.close();
    process.exit(1);
  }
}

// Handle cleanup on Ctrl+C
process.on("SIGINT", () => {
  log("info", "\nInterrupted, cleaning up...");
  if (pc) pc.close();
  sendToPlugin("disconnect");
  if (ws) ws.close();
  process.exit(0);
});

main();
