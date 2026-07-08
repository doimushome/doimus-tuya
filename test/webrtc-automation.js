#!/usr/bin/env node

/**
 * WebRTC Automation Test Suite for Tuya Battery Cameras
 *
 * Autonomously iterates through timing strategies and config variants
 * to find a working WebRTC streaming configuration.
 *
 * Key improvements over the browser debug page:
 *   1. Precise timing control — can delay offer by N seconds
 *   2. Plugin log cross-referencing — correlates plugin events with test actions
 *   3. Autonomous retries — walks a matrix of timing × SDP variants
 *   4. Structured output — JSON log for post-hoc analysis
 *   5. Can run headless on the hub itself
 *
 * Usage:
 *   node test/webrtc-automation.js <device-id> [options]
 *
 * Options:
 *   --hub <url>           Hub URL (default: 192.168.1.55:8765)
 *   --jwt <token>         JWT token (or set DOIMUS_JWT env var)
 *   --delay <n>           Seconds to wait before sending offer (default: 45)
 *   --strategy <name>     Timing strategy: fixed|auto|sweep (default: auto)
 *   --max-attempts <n>    Total attempts (default: 10 for sweep, 3 for auto)
 *   --wait-answer <n>     Seconds to wait for answer (default: 30)
 *   --stream-type <n>     1=HD, 2=SD (default: 1)
 *   --no-wrtc             Don't create real WebRTC peer
 *   --verbose             Show all WS messages
 *   --json                Output structured JSON log
 *
 * Timing strategies:
 *   fixed   — Use --delay value, same each attempt
 *   auto    — Wait for wake completion (waking events stop + 5s)
 *   sweep   — Try [0, 10, 20, 30, 45, 60] second delays
 *   custom  — Comma-separated list (e.g. "5,15,30,45,60")
 *
 * Examples:
 *   DOIMUS_JWT="eyJ..." node test/webrtc-automation.js a5f8b13f... --strategy sweep
 *   node test/webrtc-automation.js a5f8b13f... --delay 45 --no-wrtc
 *   node test/webrtc-automation.js a5f8b13f... --strategy custom --delay "0,10,20,30,45"
 */

"use strict";

const WebSocket = require("ws");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  if (i !== -1 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  return null;
}
const DEVICE_ID = args.find((a) => a.startsWith("a") && a.includes("-")) || "";
const HUB = getArg("--hub") || process.env.DOIMUS_HUB || "192.168.1.55:8765";
const JWT = getArg("--jwt") || process.env.DOIMUS_JWT || "";
const STREAM_TYPE = parseInt(getArg("--stream-type") || "1", 10);
const STRATEGY = getArg("--strategy") || "auto";
const WAIT_ANSWER_SEC = parseInt(getArg("--wait-answer") || "30", 10);
const VERBOSE = args.includes("--verbose");
const AS_JSON = args.includes("--json");

// Resolve delays based on strategy
let DELAYS;
let MAX_ATTEMPTS;

switch (STRATEGY) {
  case "fixed":
    DELAYS = [parseInt(getArg("--delay") || "45", 10)];
    MAX_ATTEMPTS = parseInt(getArg("--max-attempts") || "3", 10);
    break;
  case "sweep":
    DELAYS = [0, 10, 20, 30, 45, 60];
    MAX_ATTEMPTS = parseInt(getArg("--max-attempts") || DELAYS.length, 10);
    break;
  case "auto":
    DELAYS = ["auto"];
    MAX_ATTEMPTS = parseInt(getArg("--max-attempts") || "3", 10);
    break;
  default: // custom comma-separated
    DELAYS = (getArg("--delay") || "0,10,20,30,45")
      .split(",")
      .map((s) => (s === "auto" ? "auto" : parseInt(s, 10)));
    MAX_ATTEMPTS = parseInt(getArg("--max-attempts") || DELAYS.length, 10);
}

// Optional: real WebRTC library for genuine SDP offers
let wrtc = null;
try {
  wrtc = require("@roamhq/wrtc");
} catch {
  try {
    wrtc = require("wrtc");
  } catch {
    // No wrtc — offers will be signaling-only placeholders
  }
}
const USE_WRTC = wrtc && !args.includes("--no-wrtc");

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════

let ws = null;
let pc = null;
let webrtcConfig = null;
let candidateBuffer = [];
let pluginLogs = []; // All plugin_log events during session
let signalingLogs = []; // WebRTC signaling events
let sessionEvents = []; // Structured event log
let isCleanedUp = false;
let eventListeners = {};
let currentAttempt = 0;
let currentDelay = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════════════════════

function log(level, msg) {
  const ts = new Date().toISOString();
  const short = ts.slice(11, 19);
  const prefix =
    {
      info: " •",
      warn: " ⚠",
      error: " ✗",
      success: " ✓",
      debug: " …",
      plugin: " ▌",
    }[level] || "   ";
  const line = `${short} ${prefix} ${msg}`;
  console.log(line);
  sessionEvents.push({
    ts,
    level,
    msg,
    attempt: currentAttempt,
    delay: currentDelay,
  });
}

function saveLog() {
  const filename = `webrtc-auto-${Date.now()}.json`;
  const output = {
    deviceId: DEVICE_ID,
    hub: HUB,
    wrtc: USE_WRTC,
    strategy: STRATEGY,
    startTime: sessionEvents[0]?.ts,
    endTime: new Date().toISOString(),
    attempts: currentAttempt,
    events: sessionEvents,
    pluginLogs,
    signalingLogs,
  };
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  log("info", `Log saved to ${filename}`);

  // Also save a human-readable version
  const txt = `webrtc-auto-${Date.now()}.log`;
  const lines = sessionEvents
    .map((e) => `${e.ts.slice(11, 19)} [${e.level.padEnd(7)}] ${e.msg}`)
    .join("\n");
  fs.writeFileSync(txt, lines + "\n");
  log("info", `Human log saved to ${txt}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebSocket
// ═══════════════════════════════════════════════════════════════════════════════

function wsConnect() {
  return new Promise((resolve, reject) => {
    const url = `ws://${HUB}/ws?token=${encodeURIComponent(JWT)}`;
    log("info", `Connecting to ${url} ...`);

    ws = new WebSocket(url);
    ws.on("open", () => {
      log("success", "WS connected");
      resolve();
    });
    ws.on("error", (err) => {
      log("error", `WS error: ${err.message}`);
      // Don't reject here — let the caller handle via close/timeout
    });
    ws.on("close", (code, reason) => {
      log(
        "warn",
        `WS closed (code=${code}${reason ? ` reason=${reason}` : ""})`,
      );
    });
    ws.on("message", handleWSMessage);
  });
}

function wsSend(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("error", "WS not connected, can't send");
    return false;
  }
  const label = msg.data?.action || msg.data?.event || msg.type || "?";
  if (VERBOSE) log("debug", `tx: ${label}`);
  ws.send(JSON.stringify(msg));
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Event System
// ═══════════════════════════════════════════════════════════════════════════════

function on(event, fn) {
  if (!eventListeners[event]) eventListeners[event] = [];
  eventListeners[event].push(fn);
}

function waitForEvent(event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (eventListeners[event]) {
        eventListeners[event] = [];
      }
      reject(new Error(`Timeout waiting for "${event}" (${timeoutMs}ms)`));
    }, timeoutMs);

    const handler = (data) => {
      clearTimeout(timer);
      // Remove this specific handler
      if (eventListeners[event]) {
        const idx = eventListeners[event].indexOf(handler);
        if (idx >= 0) eventListeners[event].splice(idx, 1);
      }
      resolve(data);
    };
    on(event, handler);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// WS Message Handler — Cross-references plugin_log with signaling events
// ═══════════════════════════════════════════════════════════════════════════════

function handleWSMessage(raw) {
  try {
    const m = JSON.parse(raw.toString());

    // ── Plugin log — capture EVERYTHING for cross-referencing ──────
    if (m.event === "plugin_log") {
      const data = m.data || {};
      // Backend uses "line" key (not "message") for the log text
      const msg = data.message || data.line || "";

      // Always capture all plugin logs for cross-reference
      pluginLogs.push({
        ts: new Date().toISOString(),
        attempt: currentAttempt,
        delay: currentDelay,
        message: msg,
      });

      // Show logs related to WebRTC/streaming/wake
      const relevant =
        /webrtc|stream|p2p|wake|offer|answer|disconnect|camera|pending|buffer/i.test(
          msg,
        );
      if (VERBOSE || relevant) {
        const trimmed = msg.length > 250 ? msg.slice(0, 250) + "..." : msg;
        log("plugin", `${trimmed}`);
      }
      return;
    }

    // ── System stats — skip unless verbose ─────────────────────────
    if (m.event === "system_stats") {
      if (VERBOSE)
        log("debug", `[system] ${JSON.stringify(m.data).slice(0, 100)}`);
      return;
    }

    // ── Device updated — skip ─────────────────────────────────────
    if (m.event === "device_updated") {
      if (VERBOSE) log("debug", "[device_updated]");
      return;
    }

    // ── WebRTC signaling ──────────────────────────────────────────
    if (m.event !== "webrtc_signaling") {
      if (VERBOSE) log("debug", `rx: ${m.event}`);
      return;
    }

    const d = m.data || {};
    // The backend wraps signaling data: { plugin_id, device_id, data: { event: ... } }
    // Extract the inner data payload for event handling.
    const innerData = d.data || d;
    const ev = innerData.event || d.event;
    signalingLogs.push({ ts: new Date().toISOString(), event: ev, data: d });

    if (VERBOSE) log("debug", `signal: ${ev}`);

    // Use innerData for event payload, fall back to outer data
    const payload = innerData.event ? innerData : d;

    // Fire registered listeners (persistent — not one-shot)
    const listeners = eventListeners[ev];
    if (listeners) {
      listeners.forEach((fn) => fn(payload));
    }

    // Handle events
    switch (ev) {
      case "config":
        webrtcConfig = payload;
        log(
          "success",
          `Config: ${(payload.iceServers || []).length} ICE, motoId=${payload.motoId}, authLen=${(payload.auth || "").length}`,
        );
        break;

      case "answer":
        log("success", `✓ ANSWER RECEIVED! len=${(payload.sdp || "").length}`);
        if (
          pc &&
          payload.sdp &&
          typeof pc.setRemoteDescription === "function"
        ) {
          pc.setRemoteDescription({ type: "answer", sdp: payload.sdp })
            .then(() => log("success", "Remote description set"))
            .catch((e) => log("error", `setRemoteDescription: ${e.message}`));
        }
        break;

      case "candidate":
        if (
          pc &&
          payload.candidate &&
          typeof pc.addIceCandidate === "function"
        ) {
          const parts = payload.candidate.split(" ");
          if (parts.length >= 3) {
            const candidate = {
              sdpMLineIndex: parseInt(parts[0], 10),
              sdpMid: parts[1],
              candidate: parts.slice(2).join(" "),
            };
            pc.addIceCandidate(candidate).catch(() => {});
          }
        }
        break;

      case "disconnect":
        log(
          "warn",
          `Camera disconnected (session=${payload.sessionId || "?"})`,
        );
        break;

      case "p2p_fallback":
        log("warn", "P2P fallback triggered (no WebRTC answer within timeout)");
        break;

      case "error":
        log("error", `Plugin error: ${payload.message}`);
        break;

      case "waking":
        log(
          "info",
          `Camera waking... ${payload.elapsed ? `(${payload.elapsed}s)` : ""}`,
        );
        break;
    }
  } catch (e) {
    log("error", `Parse error: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebRTC Peer
// ═══════════════════════════════════════════════════════════════════════════════

function createPeer() {
  return new Promise((resolve, reject) => {
    if (!webrtcConfig || !webrtcConfig.iceServers) {
      reject(
        new Error("No config — call start() and wait for config event first"),
      );
      return;
    }

    const iceServers = webrtcConfig.iceServers.map((s) => ({
      urls: s.urls || s,
      username: s.username || undefined,
      credential: s.credential || undefined,
    }));

    if (USE_WRTC) {
      // ── Real WebRTC peer ────────────────────────────────────────
      pc = new wrtc.RTCPeerConnection({ iceServers });

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          log("debug", "ICE gathering complete");
          resolve();
          return;
        }
        const c = ev.candidate;
        wsSend({
          type: "webrtc_signaling",
          device_id: DEVICE_ID,
          data: {
            event: "candidate",
            candidate: `${c.sdpMLineIndex} ${c.sdpMid} ${c.candidate}`,
          },
        });
      };

      pc.ontrack = (ev) => {
        log("success", `Track received! kind=${ev.track?.kind || "?"}`);
        if (ev.streams && ev.streams[0]) {
          log("success", "✓ CAMERA IS STREAMING VIDEO!");
        }
      };

      pc.oniceconnectionstatechange = () => {
        log("debug", `ICE state: ${pc.iceConnectionState}`);
        if (
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
        ) {
          log("success", "ICE connected!");
        }
      };

      pc.onconnectionstatechange = () => {
        log("debug", `Connection state: ${pc.connectionState}`);
      };

      pc.addTransceiver("video", { direction: "recvonly" });

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          log(
            "success",
            `Offer created (len=${pc.localDescription.sdp.length})`,
          );
        })
        .catch((e) => {
          log("error", `Offer creation: ${e.message}`);
          reject(e);
        });

      // Timeout: resolve after 5s even if ICE gathering incomplete
      setTimeout(() => {
        if (pc && pc.localDescription) {
          resolve();
        } else {
          reject(new Error("ICE gathering timeout (5s)"));
        }
      }, 5000);
    } else {
      // ── Signaling-only mode ─────────────────────────────────────
      log("info", "No wrtc — using signaling-only mode");
      pc = new EventEmitter();
      resolve();
    }
  });
}

function sendOffer(sdp, streamType) {
  const type = streamType || STREAM_TYPE;
  log("info", `Sending offer (stream_type=${type}, len=${sdp.length})`);
  if (VERBOSE)
    log("debug", `SDP preview: ${sdp.slice(0, 300).replace(/\n/g, "\\n")}`);

  wsSend({
    type: "webrtc_signaling",
    device_id: DEVICE_ID,
    data: {
      event: "offer",
      sdp,
      stream_type: type,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hub Commands
// ═══════════════════════════════════════════════════════════════════════════════

function startStream() {
  log("info", "Sending START");
  wsSend({
    type: "webrtc_signaling",
    device_id: DEVICE_ID,
    data: { action: "start" },
  });
}

function stopStream() {
  log("info", "Sending STOP (disconnect)");
  wsSend({
    type: "webrtc_signaling",
    device_id: DEVICE_ID,
    data: { event: "disconnect" },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SDP Generation
// ═══════════════════════════════════════════════════════════════════════════════

function createPlaceholderSdp() {
  const ufrag = "doimus" + Math.random().toString(36).slice(2, 8);
  const pwd = Math.random().toString(36).slice(2, 18);

  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=DoimusTest",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=ice-lite",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
    "a=setup:actpass",
    "a=mid:0",
    "a=recvonly",
    "a=rtcp-mux",
    "a=rtpmap:96 H264/90000",
    "a=rtcp-fb:96 transport-cc",
    "a=fmtp:96 packetization-mode=1;profile-level-id=42e01f",
    "a=rtpmap:97 H264/90000",
    "a=fmtp:97 packetization-mode=0;profile-level-id=42e01f",
    "a=rtpmap:98 H265/90000",
    "a=rtpmap:99 VP8/90000",
    `a=ssrc:123456789 cname:{${Math.random().toString(36).slice(2, 18)}}`,
    "",
  ].join("\r\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Plugin Log Cross-Reference
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract key events from plugin logs for correlation with test actions.
 * Returns an array of { ts, type, detail } objects.
 */
function crossReferencePluginLogs() {
  const keyEvents = [];

  for (const entry of pluginLogs) {
    const msg = entry.message;

    // Capture key plugin events with their timestamps
    if (
      msg.includes("[WebRTC]") ||
      msg.includes("[P2P]") ||
      msg.includes("[StreamAlloc]")
    ) {
      let type = "webrtc";
      if (msg.includes("[P2P]")) type = "p2p";
      if (msg.includes("[StreamAlloc]")) type = "stream_alloc";

      let detail = "other";
      if (msg.includes("Publishing offer")) detail = "offer_published";
      else if (
        msg.includes("buffering offer") ||
        msg.includes("buffered until wake")
      )
        detail = "offer_buffered";
      else if (msg.includes("Wake-up sent")) detail = "wake_sent";
      else if (msg.includes("Camera wake confirmed")) detail = "wake_confirmed";
      else if (msg.includes("Wake timeout")) detail = "wake_timeout";
      else if (msg.includes("Answer received")) detail = "answer_received";
      else if (msg.includes("Disconnect received"))
        detail = "disconnect_received";
      else if (msg.includes("IPC MQTT connected")) detail = "mqtt_connected";
      else if (msg.includes("CRC32 wake sent")) detail = "crc32_wake_sent";
      else if (msg.includes("P2P connected")) detail = "p2p_connected";
      else if (msg.includes("Trying LAN_EXT_STREAM")) detail = "p2p_stream_try";
      else if (msg.includes("No stream start response"))
        detail = "p2p_no_response";
      else if (msg.includes("No frames received")) detail = "no_frames";
      else if (msg.includes("ffmpeg exited")) detail = "ffmpeg_exit";

      keyEvents.push({ ts: entry.ts, type, detail, msg: msg.slice(0, 200) });
    }
  }

  return keyEvents;
}

function printTimeline(keyEvents) {
  if (keyEvents.length === 0) {
    console.log("  (no plugin events captured)");
    return;
  }

  const start = new Date(keyEvents[0].ts).getTime();
  for (const event of keyEvents) {
    const elapsed = ((new Date(event.ts).getTime() - start) / 1000).toFixed(1);
    const icon =
      {
        offer_published: "📤",
        offer_buffered: "📦",
        wake_sent: "⏰",
        wake_confirmed: "✅",
        wake_timeout: "⌛",
        answer_received: "📥",
        disconnect_received: "🔌",
        mqtt_connected: "🔗",
        crc32_wake_sent: "⚡",
        p2p_connected: "🔀",
        no_frames: "❌",
        ffmpeg_exit: "💀",
      }[event.detail] || "•";
    console.log(
      `  T+${elapsed.padStart(5)}s ${icon} [${event.type}] ${event.detail}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════════

function cleanup() {
  if (isCleanedUp) return;
  isCleanedUp = true;
  if (pc && typeof pc.close === "function") {
    try {
      pc.close();
    } catch {}
  }
  pc = null;
  webrtcConfig = null;
  candidateBuffer = [];
  eventListeners = {};
}

// ═══════════════════════════════════════════════════════════════════════════════
// Single Attempt
// ═══════════════════════════════════════════════════════════════════════════════

async function runAttempt(delay, attemptNum) {
  currentAttempt = attemptNum;
  currentDelay = delay;
  isCleanedUp = false;
  signalingLogs = [];
  eventListeners = {};
  let pluginLogBefore = pluginLogs.length;

  const delayLabel = delay === "auto" ? "auto" : `${delay}s`;
  log("info", "");
  log("info", `── Attempt ${attemptNum} — delay: ${delayLabel} ──`);

  // 1. Connect
  await wsConnect();

  // 2. Pre-register event listeners BEFORE sending START to avoid race
  const configPromise = waitForEvent("config", 20000);
  let lastWaking = Date.now();
  on("waking", () => {
    lastWaking = Date.now();
  });

  // 3. Start stream
  startStream();

  // 4. Wait for config
  log("info", "Waiting for config...");
  await configPromise;
  log("success", "Config received");

  // 5. Wait for camera to wake (if delay > 0)
  if (delay === "auto") {
    // Auto-detect: wait for wake completion.
    // Watch "waking" events — when they stop, camera should be ready.
    log("info", "Auto-wait mode: tracking camera wake progress...");

    // Wait up to 70s for wake, with 5s of silence after last waking event
    let wokeSilent = false;
    for (let i = 0; i < 140; i++) {
      await sleep(500);
      if (Date.now() - lastWaking >= 5000) {
        wokeSilent = true;
        break;
      }
    }
    if (wokeSilent) {
      log("success", `Camera wake silence detected — sending offer`);
    } else {
      log("warn", `Wake timeout (70s) — sending offer anyway`);
    }
  } else if (delay > 0) {
    log("info", `Waiting ${delay}s for camera to wake...`);
    const steps = Math.ceil(delay / 5);
    for (let i = 0; i < steps; i++) {
      await sleep(5000);
      const elapsed = (i + 1) * 5;
      const remaining = delay - elapsed;
      if (remaining > 0) {
        log("debug", `  waiting... T+${elapsed}s (${remaining}s remaining)`);
      }
    }
    log("success", `Delay ${delay}s complete`);
  } else {
    log("info", "No delay — sending offer immediately");
  }

  // 6. Create peer + send offer
  if (USE_WRTC) {
    try {
      await createPeer();
      if (pc && pc.localDescription) {
        sendOffer(pc.localDescription.sdp, STREAM_TYPE);
      } else {
        // Fall back to placeholder
        log(
          "warn",
          "wrtc peer didn't produce local description — using placeholder",
        );
        sendOffer(createPlaceholderSdp(), STREAM_TYPE);
      }
    } catch (e) {
      log("warn", `wrtc createPeer failed: ${e.message} — using placeholder`);
      sendOffer(createPlaceholderSdp(), STREAM_TYPE);
    }
  } else {
    sendOffer(createPlaceholderSdp(), STREAM_TYPE);
  }

  // 6. Wait for answer/disconnect/fallback
  log("info", `Waiting for camera response (${WAIT_ANSWER_SEC}s)...`);
  const timeoutMs = WAIT_ANSWER_SEC * 1000;

  let result;
  try {
    result = await Promise.race([
      waitForEvent("answer", timeoutMs).then(() => "answer"),
      waitForEvent("disconnect", timeoutMs).then(() => "disconnect"),
      waitForEvent("p2p_fallback", timeoutMs).then(() => "p2p_fallback"),
    ]);
  } catch (e) {
    result = "timeout";
  }

  // 7. Collect plugin logs from this attempt
  const newPluginLogs = pluginLogs.slice(pluginLogBefore);
  const keyEvents =
    newPluginLogs.length > 0
      ? crossReferencePluginLogs().filter(
          (e) =>
            new Date(e.ts) >= new Date(pluginLogs[pluginLogBefore]?.ts || 0),
        )
      : [];

  log("info", "");
  log("info", `── Plugin Log Timeline (${delayLabel}) ──`);
  if (keyEvents.length === 0 && newPluginLogs.length > 0) {
    log(
      "info",
      `  (${newPluginLogs.length} log lines, none matched key events)`,
    );
    if (VERBOSE) {
      for (const entry of newPluginLogs.slice(-20)) {
        log("debug", `  ${entry.message.slice(0, 180)}`);
      }
    }
  } else {
    printTimeline(keyEvents);
  }
  log("info", "");

  // 8. Result
  log("info", `Result: ${result}`);
  if (result === "answer") {
    log("success", "✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓");
    log("success", "✓  CAMERA ANSWERED! STREAMING CONFIGURATION FOUND!  ✓");
    log("success", "✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓");
    return "answer";
  } else if (result === "timeout") {
    log("warn", "No response within timeout — camera may not be reachable");
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Loop
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  // ── Help ─────────────────────────────────────────────────────────
  if (args.includes("--help") || args.includes("-h") || !DEVICE_ID) {
    console.log(`
Usage: node test/webrtc-automation.js <device-id> [options]

Device: ${DEVICE_ID || "(missing — provide a device ID)"}
Hub:    ${HUB}

Options:
  --hub <url>           Hub WebSocket URL (default: ${HUB})
  --jwt <token>         JWT token (or DOIMUS_JWT env var)
  --strategy <name>     Timing strategy: fixed|auto|sweep|custom (default: ${STRATEGY})
  --delay <n|list>      Delay before offer (for fixed/custom strategy)
  --max-attempts <n>    Max test attempts (default: ${MAX_ATTEMPTS})
  --wait-answer <n>     Seconds to wait for answer (default: ${WAIT_ANSWER_SEC})
  --stream-type <n>     1=HD, 2=SD (default: ${STREAM_TYPE})
  --no-wrtc             Don't create real WebRTC peer
  --verbose             Show all WS messages
  --help, -h            Show this help

Strategies:
  fixed   Use --delay value, same each attempt
  auto    Wait for wake completion (waking events stop + 5s)
  sweep   Try [0, 10, 20, 30, 45, 60] second delays
  custom  Comma-separated list via --delay (e.g. "5,15,30,45,60")
`);
    process.exit(DEVICE_ID ? 0 : 1);
  }

  if (!JWT) {
    console.error(
      "ERROR: No JWT provided. Set DOIMUS_JWT env var or use --jwt",
    );
    process.exit(1);
  }

  // ── Banner ───────────────────────────────────────────────────────
  log("info", "══════════════════════════════════════════════════════════");
  log("info", `  WebRTC Automation — ${DEVICE_ID}`);
  log("info", `  Hub: ${HUB}`);
  log("info", `  Strategy: ${STRATEGY}`);
  log(
    "info",
    `  Delays: ${DELAYS.map((d) => (d === "auto" ? "auto" : `${d}s`)).join(", ")}`,
  );
  log("info", `  Max attempts: ${MAX_ATTEMPTS}`);
  log("info", `  wrtc: ${USE_WRTC ? "yes" : "no (placeholder SDP)"}`);
  log("info", `  Wait for answer: ${WAIT_ANSWER_SEC}s`);
  log("info", "══════════════════════════════════════════════════════════");

  // ── Test Loop ────────────────────────────────────────────────────
  let attempt = 0;
  let finalResult = null;

  for (const delay of DELAYS) {
    if (finalResult === "answer") break;

    for (let i = 0; i < Math.ceil(MAX_ATTEMPTS / DELAYS.length); i++) {
      if (finalResult === "answer") break;
      attempt++;

      try {
        finalResult = await runAttempt(delay, attempt);
      } catch (e) {
        log("error", `Attempt ${attempt} failed: ${e.message}`);
      } finally {
        // Cleanup
        try {
          stopStream();
          await sleep(2000);
        } catch {}
        if (ws) {
          try {
            ws.close();
          } catch {}
          ws = null;
        }
        cleanup();
        // Cool down between attempts (15s to let camera settle)
        if (finalResult !== "answer" && attempt < MAX_ATTEMPTS) {
          log("info", "Cooling down 15s before next attempt...");
          await sleep(15000);
        }
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  log("info", "");
  log("info", "══════════════════════════════════════════════════════════");
  log("info", "  SUMMARY");
  log("info", "══════════════════════════════════════════════════════════");

  if (finalResult === "answer") {
    log("success", "  ✓ WORKING! Camera answered WebRTC offer.");
    log("success", `  Configuration: delay=${currentDelay}s, wrtc=${USE_WRTC}`);
  } else {
    log("warn", "  ✗ Camera did not answer WebRTC. All strategies exhausted.");
    log("info", "  Last plugin log entries:");
    const recent = pluginLogs
      .filter((e) =>
        /disconnect|wake|offer|no.*frame|ffmpeg|P2P connect/i.test(e.message),
      )
      .slice(-10);
    for (const entry of recent) {
      log(
        "info",
        `    ${entry.ts.slice(11, 19)} ${entry.message.slice(0, 200)}`,
      );
    }
  }
  log("info", "");

  saveLog();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════════

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
