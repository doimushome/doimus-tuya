const crypto = require("crypto");
const util = require("util");
const TuyaP2P = require("./TuyaP2P");

async function startP2P(doimusID, tuyaDevice, ctx, log, api) {
  if (!ctx.p2pClients) ctx.p2pClients = new Map();
  if (ctx.p2pClients.has(doimusID)) {
    log("info", `P2P already active for device "${tuyaDevice.name}"`);
    return;
  }

  if (!tuyaDevice.local_key) {
    log(
      "warn",
      `No local_key for device "${tuyaDevice.name}", cannot start P2P`,
    );
    return;
  }

  const ip = tuyaDevice.ip || tuyaDevice.ip_address;
  if (!ip) {
    log("warn", `No IP for device "${tuyaDevice.name}", cannot start P2P`);
    return;
  }
  log(
    "info",
    `[P2P] Device "${tuyaDevice.name}" IP=${ip} localKeyLen=${(tuyaDevice.local_key || "").length} category=${tuyaDevice.category}`,
  );

  // mobilecam / sp / doorbell devices (Magic S1, video peephole, wireless
  // doorbells) may use different protocol versions, port 6668, or different
  // key derivations (raw, MD5, SHA256). Try all plausible combinations.
  const isCamera = ["mobilecam", "sp", "doorbell", "wxml"].includes(
    tuyaDevice.category,
  );
  // v3.1 first: no session-key negotiation → works even with quirky local_key
  // encoding common on battery cameras.  v3.4+ preferred when key is correct.
  const configs = isCamera
    ? [
        [554, 3.1, "md5"],
        [554, 3.1, "raw"],
        [554, 3.1, "sha256"],
        [554, 3.4, "md5"],
        [554, 3.4, "raw"],
        [554, 3.4, "sha256"],
        [554, 3.5, "md5"],
        [554, 3.5, "raw"],
        [554, 3.5, "sha256"],
        [554, 3.3, "md5"],
        [554, 3.3, "raw"],
        [554, 3.3, "sha256"],
        [6668, 3.5, "md5"],
        [6668, 3.5, "raw"],
        [6668, 3.5, "sha256"],
      ]
    : [
        [554, 3.1, "raw"],
        [554, 3.4, "raw"],
      ];

  for (const [port, version, keyType] of configs) {
    // Tuya local_key is a hex string. Derive binary keys for P2P crypto.
    // Use .digest() (binary Buffer) NOT .digest("hex") so TuyaP2P receives
    // a compact 16-byte (MD5) / 32-byte (SHA256) key suitable for AES-128-ECB.
    let localKey;
    if (keyType === "md5") {
      localKey = crypto.createHash("md5").update(tuyaDevice.local_key).digest();
    } else if (keyType === "sha256") {
      localKey = crypto
        .createHash("sha256")
        .update(tuyaDevice.local_key)
        .digest();
    } else {
      // "raw" — pass the hex string; TuyaP2P will decode it.
      localKey = tuyaDevice.local_key;
    }
    log(
      "info",
      `Trying P2P for "${tuyaDevice.name}" (${ip}:${port} v${version} key=${keyType})`,
    );

    const p2p = new TuyaP2P({
      deviceId: tuyaDevice.id,
      ip,
      port,
      localKey,
      version,
      log: {
        info: (m, ...a) => log("info", `[P2P] ${util.format(m, ...a)}`),
        debug: (m, ...a) => log("debug", `[P2P] ${util.format(m, ...a)}`),
        warn: (m, ...a) => log("warn", `[P2P] ${util.format(m, ...a)}`),
        error: (m, ...a) => log("error", `[P2P] ${util.format(m, ...a)}`),
      },
    });

    let succeeded = false;
    p2p.on("frame", (jpeg) => {
      log(
        "debug",
        `P2P frame received for "${tuyaDevice.name}": ${jpeg.length} bytes`,
      );
      api.sendMjpegFrame(doimusID, "main", jpeg);
      // Store as snapshot_live so the mobile app's live preview shows
      // the latest P2P frame without overwriting the motion capture image.
      api.updateDeviceImage(doimusID, "snapshot_live", jpeg, "image/jpeg");
    });

    // ── H264→MJPEG streaming decoder ─────────────────────────────
    // Battery cameras (peephole, doorbell) send H.264 via P2P tunnel
    // but don't support WebRTC or RTSP StreamAllocation.  We spawn a
    // persistent ffmpeg process to convert H.264→MJPEG in real-time
    // and push frames to the mobile app as a live stream.

    p2p._h264StreamBuffer = Buffer.alloc(0);
    p2p._h264FrameCount = 0;
    p2p._h264StreamProc = null;
    p2p._h264RestartTimer = null;

    function spawnH264Decoder() {
      if (p2p._h264StreamProc) {
        try {
          p2p._h264StreamProc.kill();
        } catch (_) {}
        p2p._h264StreamProc = null;
      }

      try {
        const { spawn } = require("child_process");
        const proc = spawn(
          "ffmpeg",
          [
            "-f",
            "h264",
            "-i",
            "pipe:0",
            "-f",
            "image2pipe",
            "-q:v",
            "5",
            "-an",
            "pipe:1",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );

        // Suppress ffmpeg log output
        proc.stderr.on("data", () => {});

        proc.stdout.on("data", (chunk) => {
          p2p._h264StreamBuffer = Buffer.concat([p2p._h264StreamBuffer, chunk]);

          // Extract complete JPEG frames (0xFF 0xD8 … 0xFF 0xD9)
          while (p2p._h264StreamBuffer.length > 1) {
            const startIdx = p2p._h264StreamBuffer.indexOf(
              Buffer.from([0xff, 0xd8]),
            );
            if (startIdx === -1) {
              p2p._h264StreamBuffer = Buffer.alloc(0);
              break;
            }

            let endIdx = -1;
            for (
              let i = startIdx + 2;
              i < p2p._h264StreamBuffer.length - 1;
              i++
            ) {
              if (
                p2p._h264StreamBuffer[i] === 0xff &&
                p2p._h264StreamBuffer[i + 1] === 0xd9
              ) {
                endIdx = i + 2;
                break;
              }
            }
            if (endIdx === -1) break;

            const jpeg = p2p._h264StreamBuffer.slice(startIdx, endIdx);
            p2p._h264FrameCount++;

            api.sendMjpegFrame(doimusID, "main", jpeg);
            api.updateDeviceImage(
              doimusID,
              "snapshot_live",
              jpeg,
              "image/jpeg",
            );

            if (p2p._h264FrameCount % 30 === 0) {
              log(
                "debug",
                `[P2P] ${p2p._h264FrameCount} H264→MJPEG frames sent for "${tuyaDevice.name}"`,
              );
            }

            p2p._h264StreamBuffer = p2p._h264StreamBuffer.slice(endIdx);
          }
        });

        proc.on("error", (err) => {
          log(
            "warn",
            `[P2P] H264 decoder error for "${tuyaDevice.name}": ${err.message}`,
          );
          p2p._h264StreamProc = null;
          // Auto-restart after 1s if still streaming
          if (p2p.streaming && !p2p._h264RestartTimer) {
            p2p._h264RestartTimer = setTimeout(spawnH264Decoder, 1000);
          }
        });

        proc.on("close", (code) => {
          log(
            "debug",
            `[P2P] H264 decoder exited (code=${code}) for "${tuyaDevice.name}"`,
          );
          p2p._h264StreamProc = null;
          // Auto-restart after 1s if still streaming
          if (p2p.streaming && !p2p._h264RestartTimer) {
            p2p._h264RestartTimer = setTimeout(spawnH264Decoder, 1000);
          }
        });

        p2p._h264StreamProc = proc;
        log(
          "info",
          `[P2P] H264→MJPEG decoder started for "${tuyaDevice.name}"`,
        );
      } catch (e) {
        log(
          "debug",
          `[P2P] Failed to spawn H264 decoder for "${tuyaDevice.name}": ${e.message}`,
        );
      }
    }

    // Feed H264 data to the persistent decoder.
    // The h264_nal data already includes the Annex B start code (00 00 00 01).
    p2p.on("h264_nal", (data) => {
      if (!p2p._h264StreamProc) {
        spawnH264Decoder();
      }
      if (p2p._h264StreamProc && p2p._h264StreamProc.stdin.writable) {
        try {
          p2p._h264StreamProc.stdin.write(data);
        } catch (_) {
          // ffmpeg may have crashed — the close handler will restart
        }
      }
    });

    p2p.on("error", (err) => {
      log("error", `P2P error for "${tuyaDevice.name}": ${err.message}`);
      ctx.p2pClients.delete(doimusID);
    });

    p2p.on("close", () => {
      log("info", `P2P connection closed for "${tuyaDevice.name}"`);
      ctx.p2pClients.delete(doimusID);
      // Clean up the persistent H264 decoder
      if (p2p._h264RestartTimer) {
        clearTimeout(p2p._h264RestartTimer);
        p2p._h264RestartTimer = null;
      }
      if (p2p._h264StreamProc) {
        try {
          p2p._h264StreamProc.kill();
        } catch (_) {}
        p2p._h264StreamProc = null;
      }
    });

    p2p.on("streaming", (active) => {
      log(
        "info",
        `P2P streaming ${active ? "started" : "stopped"} for "${tuyaDevice.name}"`,
      );
      // If streaming stops, clean up the decoder to free resources
      if (!active && p2p._h264StreamProc) {
        if (p2p._h264RestartTimer) {
          clearTimeout(p2p._h264RestartTimer);
          p2p._h264RestartTimer = null;
        }
        try {
          p2p._h264StreamProc.kill();
        } catch (_) {}
        p2p._h264StreamProc = null;
      }
    });

    try {
      await p2p.connect();
      await p2p.startVideoStream();
      ctx.p2pClients.set(doimusID, p2p);
      log(
        "info",
        `P2P connected successfully to "${tuyaDevice.name}" (${ip}:${port} v${version})`,
      );
      return; // success — stop trying other configs
    } catch (e) {
      log("warn", `P2P ${ip}:${port} v${version} failed: ${e.message || e}`);
      try {
        p2p.close();
      } catch (_) {}
      // continue to next config
    }
  }

  log("error", `All P2P configs failed for "${tuyaDevice.name}"`);
}

function stopP2P(doimusID, ctx, log) {
  if (!ctx.p2pClients) return;
  const p2p = ctx.p2pClients.get(doimusID);
  if (!p2p) return;
  log("info", `Stopping P2P live view for device ${doimusID}`);
  // Clean up the persistent H264 decoder
  if (p2p._h264RestartTimer) {
    clearTimeout(p2p._h264RestartTimer);
    p2p._h264RestartTimer = null;
  }
  if (p2p._h264StreamProc) {
    try {
      p2p._h264StreamProc.kill();
    } catch (_) {}
    p2p._h264StreamProc = null;
  }
  p2p.close();
  ctx.p2pClients.delete(doimusID);
}

/**
 * Try the Tuya cloud stream allocation API to get an RTSP stream from
 * the camera, then proxy JPEG frames to the mobile app via the existing
 * MJPEG pipeline.
 *
 * This is a fallback when WebRTC and P2P both fail — some battery cameras
 * (especially "sp" category peepholes) respond better to the cloud-initiated
 * RTSP stream allocation than to direct P2P/WebRTC.
 */
const STREAM_TYPES = ["rtsp", "flv", "hls"];

async function startStreamAllocation(doimusID, tuyaDevice, ctx, log, api) {
  if (!tuyaDevice || !tuyaDevice.id || !ctx.deviceManager) return;

  const deviceName = tuyaDevice.name || "unknown";
  const isBatteryCamera = ["sp", "doorbell", "mobilecam", "wxml"].includes(
    tuyaDevice.category,
  );

  // Try stream types in order: rtsp → flv → hls
  let streamUrl = null;
  let streamType = null;
  for (const type of STREAM_TYPES) {
    log("info", `[StreamAlloc] Trying type="${type}" for "${deviceName}"`);
    const result = await tryAllocate(ctx, tuyaDevice.id, type, log, deviceName);
    if (result && result.url) {
      streamUrl = result.url;
      streamType = type;
      log(
        "info",
        `[StreamAlloc] Got URL with type="${type}" for "${deviceName}" (stream_id=${result.streamId})`,
      );
      break;
    }
  }

  if (!streamUrl) {
    log(
      "warn",
      `[StreamAlloc] All stream types failed for "${deviceName}"`,
    );
    return;
  }

  // Clean up any previous stream allocation for this device
  stopStreamAllocation(doimusID, ctx, log);

  // Battery cameras need time to boot after the wake command
  // before they can serve the stream.
  if (isBatteryCamera) {
    const bootDelay = Math.max(5000, ctx._streamAllocBootDelay || 30000);
    log(
      "info",
      `[StreamAlloc] Battery camera "${deviceName}" — waiting ${bootDelay}ms before ffmpeg`,
    );
    await new Promise((r) => setTimeout(r, bootDelay));
  }

  await spawnFfmpeg(doimusID, streamUrl, streamType, deviceName, ctx, log, api);
}

async function tryAllocate(ctx, deviceId, type, log, deviceName) {
  try {
    const params = { type, expire: 120, transport: "tcp" };
    const result = await ctx.deviceManager.api.post(
      `/v1.0/devices/${deviceId}/stream/actions/allocate`,
      params,
    );
    if (result && result.success && result.result && result.result.url) {
      return {
        url: result.result.url,
        streamId: result.result.stream_id || "",
      };
    }
    log(
      "debug",
      `[StreamAlloc] type="${type}" no URL for "${deviceName}" (code=${result?.code} msg=${result?.msg})`,
    );
  } catch (e) {
    log("debug", `[StreamAlloc] type="${type}" failed for "${deviceName}": ${e.message}`);
  }
  return null;
}

async function spawnFfmpeg(doimusID, streamUrl, streamType, deviceName, ctx, log, api) {
  let buffer = Buffer.alloc(0);
  let frameCount = 0;
  let frameTimer = null;

  try {
    const { spawn } = require("child_process");
    const ffmpegArgs =
      streamType === "rtsp"
        ? [
            "-rtsp_transport",
            "tcp",
            "-i",
            streamUrl,
            "-f",
            "mjpeg",
            "-q:v",
            "5",
            "-r",
            "5",
            "pipe:1",
          ]
        : [
            "-i",
            streamUrl,
            "-f",
            "mjpeg",
            "-q:v",
            "5",
            "-r",
            "5",
            "pipe:1",
          ];

    const proc = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stderr.on("data", () => {});

    if (!ctx._streamAllocProcs) ctx._streamAllocProcs = new Map();
    ctx._streamAllocProcs.set(doimusID, proc);

    proc.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length > 1) {
        const startIdx = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (startIdx === -1) {
          buffer = Buffer.alloc(0);
          break;
        }

        let endIdx = -1;
        for (let i = startIdx + 2; i < buffer.length - 1; i++) {
          if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
            endIdx = i + 2;
            break;
          }
        }

        if (endIdx === -1) break;

        const jpeg = buffer.slice(startIdx, endIdx);
        frameCount++;

        api.sendMjpegFrame(doimusID, "main", jpeg);
        api.updateDeviceImage(doimusID, "snapshot_live", jpeg, "image/jpeg");

        if (frameCount % 30 === 0) {
          log(
            "debug",
            `[StreamAlloc] ${frameCount} frames sent for "${deviceName}"`,
          );
        }

        buffer = buffer.slice(endIdx);
      }
    });

    frameTimer = setTimeout(() => {
      if (frameCount === 0) {
        log(
          "warn",
          `[StreamAlloc] No frames within 30s for "${deviceName}" — giving up`,
        );
        stopStreamAllocation(doimusID, ctx, log);
      }
    }, 30000);
    if (frameTimer.unref) frameTimer.unref();

    proc.on("error", (err) => {
      log("warn", `[StreamAlloc] ffmpeg error for "${deviceName}": ${err.message}`);
      stopStreamAllocation(doimusID, ctx, log);
    });

    proc.on("close", (code) => {
      if (frameTimer) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
      if (ctx._streamAllocProcs?.get(doimusID) === proc) {
        ctx._streamAllocProcs.delete(doimusID);
      }
      log(
        "info",
        `[StreamAlloc] ffmpeg exited (code=${code}) for "${deviceName}"`,
      );
    });

    log("info", `[StreamAlloc] Streaming started for "${deviceName}"`);
  } catch (e) {
    log(
      "debug",
      `[StreamAlloc] ffmpeg spawn failed for "${deviceName}": ${e.message}`,
    );
  }
}

/**
 * Stop an active stream allocation ffmpeg process.
 */
function stopStreamAllocation(doimusID, ctx, log) {
  if (!ctx._streamAllocProcs) return;
  const proc = ctx._streamAllocProcs.get(doimusID);
  if (!proc) return;
  log("info", `Stopping stream allocation for device ${doimusID}`);
  try {
    proc.kill("SIGTERM");
  } catch (_) {}
  ctx._streamAllocProcs.delete(doimusID);
}

module.exports = {
  startP2P,
  stopP2P,
  startStreamAllocation,
  stopStreamAllocation,
};
