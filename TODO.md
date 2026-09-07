# TODO — doimus-tuya

Pending work for battery camera (`sp` / peephole / doorbell) live streaming.

## v0.11.2 — Wake loop reverse-engineered from Smart Life APK

Decompiled Smart Life 7.10.0 (`com.tuya.smart`) with jadx and traced the battery-peephole
wake + streaming flow. Full analysis in `REVERSE-ENGINEERING.md`. Key finding: the official
app wakes the camera via a dedicated `lowPowerDeviceAwake` flow — a CRC32 MQTT publish to
**`m/w/{devId}` only, repeated every 1s for ~10s**, using the device's canonical `local_key`
— then connects P2P (provider 2, not WebRTC). Implemented:

1. `src/camera/WebRTCSignaling.js` — wake now publishes **only to `m/w/{deviceId}`** (was
   also `{deviceId}/w` and `m/s/{deviceId}`), **QoS 0**, **repeated every 1s for 10s**
   (`_startWakeLoop`/`_stopWakeLoop`). Prefers the device `local_key` over `webrtcConfig.localKey`
   for the CRC32 (the app uses `deviceRespBean.getLocalKey()`).
2. `src/camera/camera-streaming.js` — `startP2P` now waits a boot delay (default 5s) for
   battery cameras so the P2P dial doesn't burn configs against a still-sleeping camera.
3. `src/camera/wake.js` (new) — standalone `wakeBatteryCamera()` for the P2P live-view path.
4. `src/index.js` — `p2p_start` now kicks `wakeBatteryCamera()` in parallel for battery
   cameras (the "Live view" button previously started P2P with no wake).
5. `src/shared/handlers.js` — emits `p2p_fallback` immediately when P2P starts in parallel
   for a battery camera, so the app shows the P2P feed instead of waiting on WebRTC.
6. `doimus-mobile` `LiveViewSheet.kt` — P2P-first for `p2p_start`-capable devices (shows the
   `snapshot_live` P2P feed immediately; WebRTC still tries in the background).
7. `src/camera/WebRTCSignaling.js` — **periodic offer re-send**: battery cameras boot
   30-50s after waking and connect to the IPC broker long after the single offer was
   published (QoS 1 is only queued for an existing persistent session). The offer is now
   re-published every 5s for 100s (`_startOfferRetry`, also re-sends the wake each tick),
   stopping on answer.
8. `src/camera/wake.js` — `cloudWakeBatteryCamera()`: best-effort **cloud-delivered wake**
   mirroring the app's ATOP `m.thing.device.common.issue` (CRC32 payload base64, topic
   `m/w/{devId}`, via `{endpoint}/?a=...&v=1.0&sp=1`) plus a diagnostic
   `m.thing.device.low.power.connect.batch.get` poll. Wired into both the `p2p_start` path
   (index.js) and the WebRTC wake path (handlers.js). Non-fatal (suppressed errors).

### go2rtc cross-check (Aug 14)

- Skill of this camera: `webrtc=51` (bit5 clarity), `lowPower=0`, videos `[streamType 2
  1080p codecType 4=HEVC, streamType 4 640p codecType 2=H264]`. go2rtc **only sends the
  CRC32 wake when `skill.lowPower > 0`** — ours is 0, so the CRC32 wake may not be the
  trigger for this camera; the official app's cloud `lowPowerDeviceAwake` push likely is.
- P2P on port 554 is a **dead end** for this camera: TCP connects (something listens) but
  the tinytuya 55AA framing gets zero response — it's the RTSP/native listener, not the
  LAN protocol. The camera's real transport is the native P2P SDK (provider 2) or WebRTC.
- go2rtc maps Skill streamType `2→mqtt 0` (HD), `4→mqtt 1` (SD); app requests `1` (SD,
  H264) which matches the H264-only offer the iOS app builds. `datachannel_enable=false`
  for H264 is correct.

Still open: the app's `checkAwakeStatus` (`m.thing.device.low.power.connect.batch.get`) and
HTTP wake fallback (`m.thing.device.common.issue`) use the app's internal gateway, not the
OpenAPI — check the Tuya IoT Platform subscription list for OpenAPI equivalents.

## v0.11.3 — KISS rewrite of the live-view flow (deployed 2026-08-14)

Rewrote `WebRTCSignaling.js` (1225 → ~320 lines) and `handleWebRTCCommand` (~350 → ~70 lines)
to match go2rtc's proven `pkg/tuya` flow exactly:

- `start(deviceId, localKey)` → `webrtc-configs` + `open-iot-hub/access/config` → IPC MQTT
  connect/subscribe → CRC32 wake → emit `config`.
- Offer published **QoS 1**, re-published every 5s for 100s (with wake re-send), until answer.
- **sessionId now 6-char random** (go2rtc) instead of 32-char UUID.
- **Wake QoS 1** (go2rtc) — queued for a sleeping camera's persistent session.
- Deleted: speculative wake DPs (`wireless_powermode=2`, `wireless_awake`), the 30s wake
  watcher + "waking" events, power-save restore on disconnect, P2P/stream-allocation
  parallel starts from the WebRTC path, `p2p_fallback` emit, `setWoken`/`_wakePending*`.
- `handlers.js`/`index.js`: removed dead `_wakeWatchers`, `_powerModeChanged`, unused imports.
- `test/webrtc-signaling.test.js` rewritten for the KISS API (start/offer/round-trip/candidate).

Still open: whether the camera wakes at all (see go2rtc cross-check above). The cloud
`checkAwakeStatus`/`common.issue` ATOP calls are the diagnostic that will tell us next.

## v0.11.1 — WebRTC offer QoS 1 + re-send after wake (deployed 2026-08-14)

### Root cause found in logs

The peephole camera (`bfc467f1cee0e05ea12z5s`) never answered the WebRTC offer in ANY session
(zero `[WebRTC] MQTT rx` messages ever). The offer was being published with **QoS 0** (mqtt.js
default) while the battery camera was still asleep — QoS 0 messages are dropped for offline
subscribers, so the camera never received the offer after it woke ~1s later. There was no retry.

go2rtc (reference implementation) publishes all signaling with **QoS 1**, relying on the IPC
broker's persistent session to deliver the offer once the camera reconnects.

### Fixes

1. **`src/camera/WebRTCSignaling.js`**
   - `_publish()` now sends **QoS 1** (offer, candidates, answer, disconnect all route through it).
   - Track last offer + candidates; `setWoken()` (camera confirmed `wireless_awake=true`)
     schedules a **QoS 1 re-send after 5s boot delay**, reusing the same sessionid. Cancelled
     on answer/disconnect.
   - `_doSendOffer()` also schedules the re-send if the camera already confirmed wake before
     the mobile app produced the offer.
2. **`src/shared/handlers.js`** — wake watcher `resolve()` now calls `wr.setWoken()`.
3. **`src/camera/camera-streaming.js`**
   - `startP2P()` reconnects instead of skipping when the existing P2P session is stale
     (socket closed — battery camera went back to sleep).
   - `tryAllocate()` rejects allocations with an empty `stream_id` (they produce dead URLs;
     ffmpeg exits code 1 immediately) instead of spawning ffmpeg.

### Verify

```bash
docker compose logs --no-color | grep -E "re-sending offer|Publishing offer|MQTT rx|type=answer"
```

Expected when opening live view on the peephole:
1. `Publishing offer ... (QoS 1)` on the first offer
2. `Wake confirmed ... re-sending offer (QoS 1) after 5s boot delay`
3. `[WebRTC] MQTT rx ... type=answer` ← the camera now actually replies
4. Mobile app renders the live feed.

## v0.8.54 — Parallel streaming paths + updated status

### Changes in v0.8.54

1. **Parallel P2P + stream allocation for battery cameras** — Previously, P2P and stream
   allocation were only tried as fallback after WebRTC failed (20-45s delay). Now they
   start immediately alongside WebRTC. This is critical because the stream allocation API
   call (`POST /v1.0/devices/{id}/stream/actions/allocate`) is what triggers the Tuya cloud
   push notification that wakes battery cameras. The camera stays in deep sleep if we only
   send MQTT commands (DPs and IPC CRC32) — it needs the cloud push.

### 1. Battery camera (`sp`) never wakes up

**Camera**: Video peephole, category `sp`, Tuya ID `bfc467f1cee0e05ea12z5s`

**Symptoms**:
- Camera LED stays off when Doimus tries to start streaming
- Official Tuya app turns LED on in <30s and streams successfully
- All streaming paths fail: WebRTC (no answer), P2P (socket timeout), stream allocation (ffmpeg exits code 1, no frames)

**What we know**:
- `ipc_work_mode` DP returns `code=2008` → **not supported** by this camera
- `wireless_awake` DP returns `code=2008` → **not supported** by this camera
- `wireless_powermode=2` is the only working cloud DP
- `hasLocalKey=false` from WebRTC config API → using device schema `local_key` (16 chars) for CRC32 wake
- `skill.lowPower=0` → go2rtc would skip CRC32 wake entirely
- CRC32 wake sent to `m/w/`, `/w`, and `m/s/` topics — camera never responds
- Stream allocation API returns a URL but `stream_id=""` and ffmpeg exits code 1
- P2P to `81.56.65.193:554` fails with socket timeout (camera asleep, port closed)

**Key insight (most likely root cause)**:
The Tuya cloud push notification that wakes battery cameras is triggered by the stream
allocation API call — not by MQTT DP commands or IPC MQTT CRC32 wake. The official Tuya
app calls this API immediately. Our code was calling it only after WebRTC disconnect
(20s delay) or after the 60s fallback timeout. **v0.8.54 fixes this by starting stream
allocation immediately in parallel with WebRTC.**

**Next steps if still not working**:
1. Check docker logs after v0.8.54 for "starting P2P + stream allocation in parallel" message
2. Verify the stream allocation API returns a real stream_id and valid RTSP URL
3. The camera may wake 30-60s after the stream allocation call (its polling interval)
   — wait longer before declaring failure
4. Check if `type: "flv"` or `type: "hls"` works instead of `type: "rtsp"` for this camera
5. Try fresh `local_key` from device info API (not cached) for CRC32:
   `GET /v1.0/devices/{id}` and use `result.local_key`
6. Review go2rtc source for any additional stream allocation parameters:
   - `pkg/tuya/cloud_api.go`: checks response for `stream_id` and `url`
   - Uses same `POST /v1.0/devices/{id}/stream/actions/allocate`
   - May pass additional `media_quality` or `type` values

### 2. stream allocation returns empty `stream_id`

- API `POST /v1.0/devices/{id}/stream/actions/allocate` with `{type:"rtsp", expire:120, transport:"tcp"}` returns a URL but `stream_id=""`
- The URL might work without a stream_id (go2rtc doesn't require it)
- ffmpeg exits with code 1 after 30s — likely because camera isn't awake
- **To test**: After enabling parallel start, wait 60s before spawning ffmpeg (camera needs time to boot)

### 3. Runner command buffering (doimus-embed)

- `backend/internal/plugin/shim/runner-native.js` updated to buffer `webrtc_command` until handler registered
- Requires backend rebuild (`docker compose build backend && docker compose restart backend`)

## Resources to investigate

- [go2rtc Tuya source](https://github.com/AlexxIT/go2rtc) (`pkg/tuya/mqtt.go`, `pkg/tuya/cloud_api.go`)
- [tuya-ipc-terminal](https://github.com/seydx/tuya-ipc-terminal) — Go CLI for Tuya camera streaming
- [Tuya battery camera docs](https://developer.tuya.com/en/docs/iot-device-dev/battery_camera)
- [Tuya RTC SDK](https://github.com/tuya/tuya-rtc-camera-sdk-android)
- [hass-expose-camera-stream-source](https://github.com/felipecrs/hass-expose-camera-stream-source)
- [Tuya IPC terminal analysis](https://github.com/seydx/tuya-ipc-terminal) — may reveal correct start sequence for battery cams

## Repro

```bash
# 1. Get JWT from hub logs
make pin  # or extract from docker logs

# 2. Check docker logs for parallel start
docker compose logs --no-color | grep -E "WebRTC|wake|StreamAlloc|P2P|parallel" | grep -v "Energy poll" | tail -50
```
