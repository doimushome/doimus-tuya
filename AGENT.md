# AGENT.md

This file provides guidance to coding agents working on the doimus-tuya plugin.

## Project Overview

**doimus-tuya** is a Doimus native plugin for Tuya / Smart Life cloud devices. It bridges
Tuya's cloud APIs (HTTP + MQTT) into the Doimus plugin sandbox protocol, exposing 76+
device categories as Doimus devices.

## Repository Structure

- `index.js` — Plugin entry point; all device management, MQTT, motion/snapshot handling
- `core/` — Tuya OpenAPI client, MQTT client, device management
- `device/` — Device category handlers (lights, switches, cameras, doorbells, etc.)
- `util/` — Utilities (DP parsing, HMAC, etc.)
- `test/` — Tests (WebRTC signaling)
- `config.schema.json` — Plugin configuration schema (rendered in app wizard)

## Key Commands

```bash
# Run WebRTC tests
npm run test:webrtc

# Lint (if configured)
npm run lint
```

## Architecture

- **Entry point**: `index.js` — exports `createPluginInstance()` which returns the Doimus plugin API
- **Communication**: JSON stdio protocol via `api.registerDevice`, `api.updateDeviceState`, `api.onCommand`
- **MQTT**: Real-time device updates via Tuya's MQTT with AES decryption (`core/tuya-mqtt.js`)
- **REST API**: Tuya OpenAPI for device control, status queries, snapshots (`core/tuya-client.js`)
- **Camera handling**: WebRTC live view, motion snapshots via S3/Inline/REST fallback, snapshot_latest

## Camera Motion & Image Pipeline

### Motion detection flow (`index.js` ~L2870–3120)

1. Tuya MQTT delivers `DEVICE_STATUS_UPDATE` with `movement_detect_pic`, `doorbell_pic`, or similar
2. Edge detection: `motionActivated = state.motion === true && !lastKnown.motion`
3. Motion auto-reset timer starts (if configured) — resets `motion` to `false` after N seconds
4. Image capture is attempted in priority order:
   - **Inline**: `tryDecodeCameraImage()` — image data directly in the status update
   - **S3 metadata**: `scheduleMotionImageFetch()` — async S3 fetch (10s timeout)
   - **REST fallback**: `dm.api.getCameraSnapshot()` — Tuya API snapshot (4s timeout)
5. Image stored via `api.updateDeviceImage(deviceId, "motion_N", jpeg)`
6. Timeline linked via `api.onMotionImageStored(deviceId, "motion_N")`

### Sequence number management (`index.js` ~L3000–3006)

The `_motionSeq` counter is pre-assigned at motion-detection time (not at image-arrival time)
to ensure chronological ordering even when async paths complete out of order:

```js
if (!ctx._motionSeq) ctx._motionSeq = new Map();
const motionSeq = (ctx._motionSeq.get(device.id) || 0) + 1;
ctx._motionSeq.set(device.id, motionSeq);
```

This was fixed in v0.8.26 — older versions incremented seq inside async callbacks, causing
cross-assignment when a later event's inline decode finished before an earlier event's S3 fetch.

### Known timer management patterns

Motion image fetch uses multiple timeout-based fallbacks. Key maps:

| Timer Map | Location | clearTimeout on replace? |
|---|---|---|
| `_motionTimers` | L2927 | ✅ Yes |
| `_motionFetchTimers` | L1337 | ✅ Yes (fixed) |
| `_snapshotFallbackTimers` (motion) | L3099 | ✅ Yes (fixed) |
| `_snapshotFallbackTimers` (online) | L3188 | ✅ Yes |

All timer maps now properly cancel pending timers before replacing them.
This prevents stale callbacks from calling `delete(device.id)` on the
replacement's entry in the Map.

## Debugging

### Checking plugin logs

Plugin logs appear in the backend's Docker logs. Filter by plugin name:

```bash
# Tail all logs
docker compose logs -f

# Filter for Tuya plugin lines
docker compose logs -f | grep "tuya" | grep "DEBUG"

# Filter for motion-specific events
docker compose logs -f | grep -E "(motion|snapshot|motion_N|image key)"
```

### Key log patterns (set log level to DEGUB in plugin config)

| Log line | What it means |
|---|---|
| `"tuya:deviceStatusUpdate"` | Raw MQTT status received |
| `"motion activated: true"` | Motion edge detected |
| `"Starting motion auto-reset timer"` | Timer started to clear motion after N seconds |
| `"Scheduling motion image fetch"` | S3 fetch scheduled (10s delay) |
| `"REST snapshot fallback captured"` | REST API snapshot captured (4s delay) |
| `"update image key"` | Image stored in Doimus ImageStore |
| `"set timeline image key"` | Backend linked image to timeline entry |
| `"tryDecodeCameraImage"` | Trying inline image decode |
| `"Another motion while S3 fetch pending"` | New motion before previous S3 fetch completed |
| `"cleaning up device"` | Device removed from internal state |

### Testing motion capture flow

To verify motion image capture end-to-end without waiting for real motion:

1. Trigger a test event via Tuya API or physically trigger the camera's motion detection
2. Watch logs for the sequence: edge detection → image capture attempt → image stored → timeline key set
3. Check the timeline via API:
   ```bash
   curl -s "http://<hub-ip>:8765/api/v1/devices/<id>/timeline" \
     -H "Authorization: Bearer $JWT" | jq '[.data[] | select(.state_key=="motion" and .new_value=="true") | {id, image_key, changed_at}]'
   ```

### Common issues

| Symptom | Likely cause | Fix/check |
|---|---|---|
| All timeline entries show same image | Seq not pre-assigned (pre-v0.8.26) or `ActivityScreen` fallback to `snapshot_latest` | Update plugin; check raw API `image_key` values |
| Newest entry has no image | Image arrived before timeline entry was committed; or no matching entry with `image_key=""` | Check logs for "set timeline image key" error; retry within 1s |
| Images missing but logs show capture | ImageStore evicted (memory pressure) or image key index mismatch | Check `GET /devices/<id>/images` API |
| Timer fires with wrong image | Orphaned S3/REST fallback timer from earlier event | Fixed in v0.8.27 — all timer maps now clearTimeout before replacing |
| No images at all | Tuya API permissions missing (`IoT Video Live Stream`, `Camera Service`) | Check Tuya IoT Platform API subscriptions |

### Cross-referencing with backend

When debugging image issues, always cross-check:
1. **API timeline** → what `image_key` values does the backend report?
2. **ImageStore** → what image keys exist in memory?
3. **SQLite** → what's stored in `device_state_timeline`?
4. **Logs** → did `SetTimelineImageKey` succeed or return `sql.ErrNoRows`?

See `doimus-embed/AGENT.md` → **Cross-Checking Data: Timeline & Images** for detailed SQL queries and API commands.
