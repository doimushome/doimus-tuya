# Smart Life battery-peephole wake + streaming — reverse-engineered

Findings from decompiling the **Smart Life 7.10.0** APK (`com.tuya.smart`, "Tuya: Smart Life,
Smart Living") with `jadx`. The camera SDK is **`com.thingclips.smart.camera`** (Tuya's renamed
"thing" IPC/RTC SDK). Obfuscated, but the wake/connect flow is fully recoverable from string
literals + the `LowPowerDeviceManager.kt` logic.

## TL;DR — the missing piece

The official app wakes a battery peephole (`sp`) through a **dedicated low-power wake flow**
(`lowPowerDeviceAwake`), *not* the WebRTC offer and *not* the `wireless_awake` DP. The core
wake command is still a CRC32 MQTT publish, but the app also:

1. Detects the device's wake capability from **product config metas** (`remote_wakeup`,
   `low_power_wakeup`) — not from DPs.
2. Publishes the CRC32 wake to **`m/w/{devId}` only**, **QoS 0**, and **repeats it every 1 s**
   for up to the wake timeout.
3. Polls a cloud API **`m.thing.device.low.power.connect.batch.get`** to detect wake.
4. Falls back to a cloud publish API **`m.thing.device.common.issue`** when the direct MQTT
   publish fails.
5. Uses **P2P** (provider `2`, `IPCThingP2PCamera`) for live view — not WebRTC — and the wake
   runs *before* the P2P `connect()`, so the P2P socket has something to connect to.

## The wake sequence (exact)

Entry point: `InternalThingSmartCameraP2P.connect()` →
`p()` (wake) → `super.connect()` (P2P). `p()`:

```
deviceBean = getDeviceBean(devId)
zLowPowerWake  = deviceBean.isSupportLowPowerWakeUp()          // device capability flag
zRemoteWakeup  = deviceBean.productRefBean.configMetas.containsKey("remote_wakeup")

if (zLowPowerWake || zRemoteWakeup):
    lowPowerDeviceAwake(devId, 0, {
        low_power_trace_id: mClientTid,
        devId,
        productId,
        abilityType: zLowPowerWake ? 1 : 2,
    }, cb)                      // ← THE wake
    return
else:
    sdkProvider = getSdkProvider(deviceBean)
    if sdkProvider == 3:  publishDps("wireless_awake", true)                 // DP fallback
    else /* == 2 */:      publishWirelessWake("m/w/" + devId, BE32(crc32(localKey)))
```

`lowPowerDeviceAwake` (`LowPowerDeviceManager.kt`, obfuscated as `dddbppd`):

```
productRefBean.configMetas:
  if !configMetas.containsKey("low_power_wakeup"):
      # old-style: just fire the MQTT wake once
      publish "m/w/{devId}" = BE32(crc32(localKey))  # QoS 0, retain=false
      return UNSUPPORT
  else:
      # new-style low-power-connect flow
      checkAwakeStatus()                                  # cloud poll
      loop every 1000 ms until timeout (default 10000 ms):
          publish "m/w/{devId}" = BE32(crc32(localKey))   # QoS 0, repeated
      # success detected via MQTT (protocol 1, lowPowerConnect/online) OR
      # checkAwakeStatus returning lowPowerConnect == false
      # if direct MQTT publish errors -> HTTP fallback:
      m.thing.device.common.issue { devId, topic:"m/w/{devId}",
                                    message: base64(BE32(crc32(localKey))) }
```

`justSendAwakeDevice(devId)` (used before any DP command on low-power devices) is just the
single-shot version of the same MQTT publish.

### The wake payload (verified byte-for-byte)

```java
// dpdbqdp.bdpdqbp(String localKey):  CRC-32 (IEEE 802.3), init 0xFFFFFFFF, ~result
// dpdbqdp.bdpdqbp(int crc):          { b0=(crc>>24)&0xFF, b1=(crc>>16)&0xFF, b2=(crc>>8)&0xFF, b3=crc&0xFF }
publish("m/w/" + devId, BE32(crc32(localKey.getBytes("UTF-8"))), qos=0, retain=false)
```

This **matches** doimus-tuya's `WebRTCSignaling.crc32()` + `writeUInt32BE`. The payload is not
the problem. The differences that matter are below.

## API commands the app uses (its internal "SP/ATOP" gateway, NOT the OpenAPI)

| App command | Purpose | Params |
|---|---|---|
| `m.thing.device.low.power.connect.batch.get` | checkAwakeStatus (poll) | `devIds` → `LowPowerConnectResult{devId, lowPowerConnect, lastConnectChangeTime}` |
| `m.thing.device.common.issue` | HTTP fallback for the MQTT wake | `devId`, `topic`, `message` (base64 CRC32 bytes) |
| `thing.m.device.dp.publish` | DP publish (wireless_awake fallback) | `devId`, `dps` |
| `thing.m.product.ext.prop.batch.get` | product config metas (`remote_wakeup`/`low_power_wakeup`) | `pids` |

These are the app's internal gateway commands. doimus-tuya speaks the **Tuya OpenAPI**
(`/v1.0/...`), a different surface. The **OpenAPI equivalents** to check on the Tuya IoT
Platform subscription list are under IoT Core / Industry Project Client Service. The closest
OpenAPI action to `common.issue` is a "publish MQTT via cloud" style endpoint; `checkAwakeStatus`
may not exist in the OpenAPI at all — in that case rely on MQTT `online`/`lowPowerConnect`
observation for wake detection instead of the cloud poll.

## Live-view transport: P2P, not WebRTC

`CameraStrategy.getCamera(provider)` maps the peephole `sp` camera to provider `2`
(`IPCThingP2PCamera`) — the encrypted P2P tunnel (this is the "encrypted connection" the user
sees). WebRTC is a separate/parallel path in the SDK (`middleware/*` "chaos" classes), not the
default for this category. The wake (`p()`) runs before the P2P `connect()`, so the app's P2P
dial succeeds once the camera boots.

## Gap vs doimus-tuya today

| # | App behaviour | doimus-tuya today | Impact |
|---|---|---|---|
| 1 | Wake topic = `m/w/{devId}` only | publishes `m/w/`, `{devId}/w`, **`m/s/{devId}`** | `m/s/` is the camera→app command topic; publishing CRC32 there is wrong and may confuse the camera. Drop it. |
| 2 | QoS 0, **repeated every 1 s** up to timeout | QoS 1, sent once (re-send only on `wireless_awake`) | Repeating matters — the camera may miss a single early wake. |
| 3 | Wake driven by `localKey` from `deviceRespBean` (device info) | `webrtcConfig.localKey` (often absent) fallback to schema `local_key` | If the two keys differ, the CRC32 is wrong and the camera ignores the wake. |
| 4 | Wake **before** P2P connect; P2P provider 2 | WebRTC-first; P2P tried as fallback with no wake gating | Wrong transport for `sp`. |
| 5 | Capability from `configMetas` (`remote_wakeup`/`low_power_wakeup`) | derives `needsWake` from battery DPs in schema | Schema DP presence is a weaker signal; the real flag is product config metas. |

## Suggested next steps

1. **Stop publishing to `m/s/{devId}`** (and probably `{devId}/w`) — wake only on `m/w/{devId}`.
2. **Repeat the wake** every 1 s for ~10 s instead of once (QoS 0 is fine, keep the IPC broker).
3. **Verify the localKey** used for CRC32 equals the device's canonical `local_key`
   (`GET /v1.0/devices/{id}` → `result.local_key`), re-fetched, not cached/decoded.
4. **Drive P2P** (provider 2, `TuyaP2P`) as the primary live-view transport for `sp`, with the
   wake running in parallel before the socket dial (the app's exact ordering).
5. Add the OpenAPI-side `checkAwakeStatus` / `common.issue` equivalents if available on the
   project's API subscription list; otherwise detect wake via MQTT `online`/`lowPowerConnect`.

## Source references (decompiled)

- `com/thingclips/smart/camera/biz/impl/InternalThingSmartCameraP2P.java` — wake (`p()`) + connect
- `com/thingclips/sdk/device/dddbppd.java` — `LowPowerDeviceManager.kt` (lowPowerDeviceAwake)
- `com/thingclips/sdk/device/qppddqq.java` — ATOP commands incl. `m.thing.device.common.issue`
- `com/thingclips/sdk/device/dbbpbbb.java` — `m.thing.device.low.power.connect.batch.get`
- `com/thingclips/sdk/device/dpdbqdp.java` — crc32 + intToByteArray
- `com/thingclips/smart/camera/middleware/p2p/CameraStrategy.java` — P2P provider selection
- `com/thingclips/smart/camera/devicecontrol/operate/dp/DpWirelessAwake.java` — DP `wireless_awake`
