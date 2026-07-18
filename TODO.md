# TODO — doimus-tuya

Pending work for battery camera (`sp` / peephole / doorbell) live streaming.

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

### 3. Self-test script needs validation

- `test/webrtc-self-test.js` updated to handle both hub message formats but never validated end-to-end
- Run: `HUB=localhost:8765 JWT="..." DEVICE_ID="..." node test/webrtc-self-test.js`

### 4. Runner command buffering (doimus-embed)

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

# 2. Run self-test
HUB=localhost:8765 JWT="eyJ..." node test/webrtc-self-test.js

# 3. Check docker logs for parallel start
docker compose logs --no-color | grep -E "WebRTC|wake|StreamAlloc|P2P|parallel" | grep -v "Energy poll" | tail -50
```
