const {
  tryDecodeCameraImage,
  parseMotionMetadata,
  extractSnapshotUrlFromStatus,
  downloadImageFromUrl,
  fetchMotionImageFromS3,
  detectImageMime,
} = require("../util/image-utils");

// ── Motion Capture Coordinator ──────────────────────────────────────────
// Replaces the old timer-race approach: multiple MQTT packets per physical
// event (motion DP, initiative_message, movement_detect_pic) are coalesced
// into one coordinated capture with a unique timestamp-based key.

/**
 * Start or extend the motion capture coalescing window for a device.
 *
 * Multiple MQTT packets arrive per physical motion event. This debounce
 * collects them over 1.5s so that processCoalescedMotion() sees all
 * available data (inline image, S3 metadata) in a single attempt.
 * Cancels any pending async capture from a previous event.
 */
function startMotionCoalesce(device, status, doimusID, ctx, dm, api, log) {
  if (!ctx._motionCoalesce) ctx._motionCoalesce = new Map();

  let entry = ctx._motionCoalesce.get(device.id);
  if (entry) {
    // Cancel pending timers from a previous coalesce or async fetch
    clearTimeout(entry.timer);
    clearTimeout(entry.asyncTimer);
    // Merge new status items (avoid duplicates by code)
    for (const s of status) {
      if (!entry.statuses.find((e) => e.code === s.code)) {
        entry.statuses.push(s);
      }
    }
  } else {
    entry = { doimusID, statuses: [...status], timer: null, asyncTimer: null };
    ctx._motionCoalesce.set(device.id, entry);
  }

  log(
    "debug",
    `Motion coalesce ${entry.timer ? "extended" : "started"} for "${device.name}" (${entry.statuses.length} status items)`,
  );

  entry.timer = setTimeout(() => {
    processCoalescedMotion(device.id, ctx, dm, api, log).catch((e) => {
      log(
        "error",
        `processCoalescedMotion failed for "${device.name}": ${e.message}`,
      );
    });
  }, 1500);
}

/**
 * Process one coordinated motion capture attempt.
 *
 * Called once after the coalescing window closes. Generates a unique
 * eventKey, updates state with _capture_id so the backend creates the
 * timeline entry with the correct image_key from the start, then
 * attempts image capture in priority order: inline -> S3 -> REST.
 */
async function processCoalescedMotion(tuyaID, ctx, dm, api, log) {
  const device = dm.getDevice(tuyaID);
  if (!device) {
    log("warn", `processCoalescedMotion: device ${tuyaID} not found`);
    return;
  }

  const entry = ctx._motionCoalesce && ctx._motionCoalesce.get(tuyaID);
  if (!entry) return; // cancelled or already processed

  const { doimusID, statuses } = entry;
  const eventKey = "motion_" + Date.now();

  log(
    "info",
    `Processing coalesced motion for "${device.name}" — eventKey=${eventKey} (${statuses.length} coalesced status items)`,
  );

  // ── Helper: send the state update that creates the timeline entry ──
  // Pulled into a function so both the inline path (after image store)
  // and the async path (S3/REST) can call it at the right time.
  const sendMotionStateUpdate = () => {
    // Update state with _capture_id so the backend creates the timeline
    // entry WITH the correct image_key. The backend strips _capture_id
    // from device state — it never persists as a real state key.
    api.updateDeviceState(doimusID, {
      motion: true,
      _capture_id: eventKey,
    });

    // Sync lastKnownState so the auto-reset timer detects motion is true.
    ctx.lastKnownState.set(tuyaID, {
      ...(ctx.lastKnownState.get(tuyaID) || {}),
      motion: true,
    });

    // ── Motion auto-reset timer ──────────────────────────────────────
    // processCoalescedMotion is the sole sender of motion:true.
    // Ensure the auto-reset timer is active so motion:false is sent
    // even if the coalesce window extended past the original edge-
    // detection timer (which is only set on the false→true transition
    // and is NOT extended by subsequent MQTT packets).
    // Without this, motion gets stuck as true when:
    //   t=0: motion edge → timer set for t=5, coalesce for t=1.5
    //   t=3: another MQTT → coalesce extended to t=4.5 (timer not extended)
    //   t=4: another MQTT → coalesce extended to t=5.5
    //   t=5: auto-reset fires → motion:false + timer entry deleted
    //   t=5.5: processCoalescedMotion → motion:true → STUCK (no timer)
    if (!ctx._motionTimers) ctx._motionTimers = new Map();
    const existing = ctx._motionTimers.get(tuyaID);
    if (existing) clearTimeout(existing);
    ctx._motionTimers.set(
      tuyaID,
      setTimeout(() => {
        const current = ctx.lastKnownState.get(tuyaID);
        if (current && current.motion === true) {
          log(
            "info",
            `Motion auto-reset for "${device.name}" (from coalesce, 5s timeout)`,
          );
          const resetState = { motion: false };
          api.updateDeviceState(doimusID, resetState);
          ctx.lastKnownState.set(tuyaID, {
            ...current,
            ...resetState,
          });
          if (Array.isArray(device.status)) {
            const motionPattern = /motion|movement|doorbell|human|person|pir/i;
            for (const dp of device.status) {
              if (motionPattern.test(dp.code)) {
                dp.value = "";
              }
            }
          }
        }
        ctx._motionTimers.delete(tuyaID);
      }, 5000),
    );
  };

  // ── Step 1: Try to capture the image BEFORE creating the timeline entry ──
  // This eliminates the race where the mobile fetches the timeline entry
  // before the image is stored, causing a stale404 to be cached.
  // For inline decode (synchronous), the image is available immediately.
  // For DP URL download (async but fast), the image is available soon after.

  // 1a. Try inline image decode (movement_detect_pic / doorbell_pic DPs).
  let imageData = tryDecodeCameraImage(device, statuses, log);
  let imageMime = imageData ? detectImageMime(imageData) : null;

  // 1b. Try DP URL (some doorbells embed a URL in a DP value).
  if (!imageData) {
    const directUrl = extractSnapshotUrlFromStatus(statuses);
    if (directUrl) {
      const downloaded = await downloadImageFromUrl(
        directUrl,
        log,
        device.name,
      );
      if (downloaded && downloaded.data) {
        imageData = downloaded.data;
        imageMime = downloaded.mime || detectImageMime(imageData);
        log(
          "info",
          `Motion image fetched from DP URL for "${device.name}": mime=${imageMime} size=${imageData.length}B`,
        );
      }
    }
  }

  // ── Inline/DP image captured — store FIRST, then create timeline entry ──
  if (imageData) {
    storeMotionImage(
      doimusID,
      eventKey,
      imageData,
      imageMime || "image/jpeg",
      api,
      log,
      device,
    );
    // Now that the image is in ImageStore, create the timeline entry.
    // The mobile will find the image immediately — no 404 gap.
    sendMotionStateUpdate();
    ctx._motionCoalesce.delete(tuyaID);
    return;
  }

  // ── No inline image — create timeline entry first, then async fetch ──
  // For S3/REST, the image won't be available for 8-10 seconds.
  // Create the timeline entry now so the event appears in the timeline,
  // and the mobile falls back to snapshot_latest until the image arrives.
  // The FrameUpdated WS event (from storeMotionImage) will trigger a
  // re-fetch once the image is stored.
  sendMotionStateUpdate();

  // 2. No inline image — check for S3 metadata (initiative_message).
  const metadata = parseMotionMetadata(statuses, log, device.name);
  if (metadata) {
    log(
      "info",
      `Scheduling S3 fetch for "${device.name}" in 10s (eventKey=${eventKey})`,
    );
    entry.asyncTimer = setTimeout(async () => {
      entry.asyncTimer = null;
      try {
        const jpeg = await fetchMotionImageFromS3(
          device,
          metadata,
          dm,
          ctx,
          log,
        );
        if (jpeg) {
          storeMotionImage(
            doimusID,
            eventKey,
            jpeg,
            "image/jpeg",
            api,
            log,
            device,
          );
        } else {
          log(
            "warn",
            `S3 fetch returned no image for "${device.name}" (eventKey=${eventKey})`,
          );
        }
      } catch (e) {
        log("warn", `S3 fetch failed for "${device.name}": ${e.message}`);
      }
      ctx._motionCoalesce && ctx._motionCoalesce.delete(tuyaID);
    }, 10000);
    return;
  }

  // 5. No inline, no S3 — fall back to REST snapshot API.
  log(
    "info",
    `Scheduling REST snapshot fallback for "${device.name}" in 8s (eventKey=${eventKey})`,
  );
  entry.asyncTimer = setTimeout(async () => {
    entry.asyncTimer = null;
    try {
      const jpeg = await dm.api.getCameraSnapshot(device.id);
      if (jpeg) {
        storeMotionImage(
          doimusID,
          eventKey,
          jpeg,
          "image/jpeg",
          api,
          log,
          device,
        );
      } else {
        log(
          "warn",
          `REST snapshot returned no image for "${device.name}" (eventKey=${eventKey})`,
        );
      }
    } catch (e) {
      log("warn", `REST snapshot failed for "${device.name}": ${e.message}`);
    }
    ctx._motionCoalesce && ctx._motionCoalesce.delete(tuyaID);
  }, 8000);
}

/**
 * Store a captured motion image under both the unique eventKey and
 * snapshot_latest. Also pushes to MJPEG stream if JPEG.
 */
function storeMotionImage(
  doimusID,
  eventKey,
  imageData,
  mime,
  api,
  log,
  device,
) {
  if (mime === "image/jpeg") {
    api.sendMjpegFrame(doimusID, "main", imageData);
  }
  api.updateDeviceImage(doimusID, eventKey, imageData, mime);
  api.updateDeviceImage(doimusID, "snapshot_latest", imageData, mime);
  log(
    "info",
    `Motion image stored for "${device.name}": key=${eventKey} size=${imageData.length}B`,
  );
}

module.exports = {
  startMotionCoalesce,
};
