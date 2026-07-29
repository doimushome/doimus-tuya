const WebRTCSignaling = require("../camera/WebRTCSignaling");
const {
  applySchemaOverride,
  mapTuyaStatusToDoimusState,
  determineCapabilities,
  getDoimusType,
} = require("./state-mapper");
const { buildDeviceCommands, sendCommandsDebounced } = require("./command-builder");
const { startP2P, stopP2P, startStreamAllocation, stopStreamAllocation } = require("../camera/camera-streaming");
const { MOTION_DP_PATTERN, generateUUID, computeNeedsWake } = require("./plugin-utils");

async function registerDevicesWithDoimus(api, dm, options, ctx, log) {
  const devices = dm.devices;
  if (!devices || devices.length === 0) {
    log("warn", "No devices found.");
    return;
  }

  log("info", `Registering ${devices.length} Tuya device(s) with Doimus.`);

  for (const device of devices) {
    if (device.isIRControlHub && device.isIRControlHub()) continue;
    applySchemaOverride(device, options);
    const type = getDoimusType(device, options);
    if (type === "hidden") continue;

    const doimusID = generateUUID(device.id);
    const capabilities = determineCapabilities(device);

    for (const item of device.status) {
      if (MOTION_DP_PATTERN.test(item.code)) {
        item.value = "";
      }
    }

    const initialState = mapTuyaStatusToDoimusState(
      device,
      device.status,
      options,
    );

    const tempSetSchema = device.schema.find(
      (s) => s.code === "temp_set" || s.code === "target_temp",
    );
    if (
      tempSetSchema &&
      tempSetSchema.property &&
      tempSetSchema.property.min !== undefined &&
      tempSetSchema.property.max !== undefined
    ) {
      const scale =
        tempSetSchema.property.scale != null
          ? Math.pow(10, tempSetSchema.property.scale)
          : 1;
      initialState.min_target_temp = tempSetSchema.property.min / scale;
      initialState.max_target_temp = tempSetSchema.property.max / scale;
    }

    api.registerDevice({
      id: doimusID,
      name: device.name,
      type: type,
      capabilities: capabilities,
      state: initialState,
    });

    ctx.doimusDeviceMap.set(doimusID, device.id);
    ctx.doimusDeviceMap.set(device.id, doimusID);
    ctx.lastKnownState.set(device.id, initialState);
  }

  log("info", "Device registration complete.");
}

async function handleWebRTCCommand(deviceID, value, tuyaDevice, ctx, dm, api, log) {
  if (!ctx._webrtcClients) ctx._webrtcClients = new Map();

  if (value.action === "start") {
    log(
      "info",
      `[WebRTC] START command received for deviceID=${deviceID} tuyaID=${tuyaDevice.id} name="${tuyaDevice.name}" category=${tuyaDevice.category}`,
    );
    try {
      const existing = ctx._webrtcClients.get(deviceID);
      if (existing) {
        log("info", "[WebRTC] Disconnecting previous session before restart");
        existing.disconnect();
        ctx._webrtcClients.delete(deviceID);
      }

      const wr = new WebRTCSignaling(dm.api, log);
      ctx._webrtcClients.set(deviceID, wr);

      wr.on("config", (cfg) => {
        api.sendWebrtcSignaling(deviceID, { event: "config", ...cfg });
      });
      wr.on("answer", (data) => {
        api.sendWebrtcSignaling(deviceID, { event: "answer", ...data });
        if (typeof wr.sendResolution === "function") {
          wr.sendResolution(0);
        }
      });
      wr.on("candidate", (data) => {
        api.sendWebrtcSignaling(deviceID, { event: "candidate", ...data });
      });
      wr.on("disconnect", (data) => {
        const needsWake = computeNeedsWake(tuyaDevice);
        const BATTERY_DELAY_MS = needsWake ? 20000 : 0;
        log(
          "info",
          `[WebRTC] Camera disconnected session=${data.sessionId}${needsWake ? ` — waiting ${BATTERY_DELAY_MS / 1000}s for battery camera to wake before fallback` : " — trying cloud stream allocation"}`,
        );
        api.sendWebrtcSignaling(deviceID, { event: "disconnect", ...data });
        if (ctx._webrtcClients.has(deviceID)) {
          if (BATTERY_DELAY_MS > 0) {
            const prev = ctx._streamFallbackTimers.get(deviceID);
            if (prev) clearTimeout(prev);
            const timer = setTimeout(() => {
              ctx._streamFallbackTimers.delete(deviceID);
              log(
                "info",
                `[WebRTC] Battery camera delay elapsed — starting fallback streaming for "${tuyaDevice.name}"`,
              );
              if (ctx._webrtcClients.has(deviceID)) {
                const staleP2P = ctx.p2pClients?.get(deviceID);
                if (staleP2P) {
                  log(
                    "info",
                    `[WebRTC] Closing stale P2P for "${tuyaDevice.name}" before fresh reconnect`,
                  );
                  staleP2P.close();
                  ctx.p2pClients.delete(deviceID);
                }
                startP2P(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
                  log("debug", `[WebRTC] P2P start failed: ${e.message}`),
                );
                startStreamAllocation(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
                  log("debug", `[StreamAlloc] Failed: ${e.message}`),
                );
              }
            }, BATTERY_DELAY_MS);
            ctx._streamFallbackTimers.set(deviceID, timer);
          } else {
            startP2P(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
              log("debug", `[WebRTC] P2P start failed: ${e.message}`),
            );
            startStreamAllocation(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
              log("debug", `[StreamAlloc] Failed: ${e.message}`),
            );
          }
        }
      });
      wr.on("error", (err) => {
        api.sendWebrtcSignaling(deviceID, {
          event: "error",
          message: err.message,
        });
      });
      wr.on("fallback", () => {
        const needsWake = computeNeedsWake(tuyaDevice);
        if (needsWake) {
          log(
            "info",
            `[WebRTC] WebRTC timed out for battery camera "${tuyaDevice.name}" — fallback streaming already scheduled by disconnect handler`,
          );
          api.sendWebrtcSignaling(deviceID, { event: "p2p_fallback" });
          return;
        }
        log(
          "info",
          `[WebRTC] WebRTC timed out, trying cloud stream allocation for "${tuyaDevice.name}"`,
        );
        api.sendWebrtcSignaling(deviceID, { event: "p2p_fallback" });
        const p2pCloudRelay =
          tuyaDevice.category === "sp" || tuyaDevice.category === "doorbell";
        if (!p2pCloudRelay) {
          startP2P(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
            log("debug", `[WebRTC] P2P start failed: ${e.message}`),
          );
        }
        startStreamAllocation(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
          log("debug", `[StreamAlloc] Failed: ${e.message}`),
        );
      });

      const isCamera = ["sp", "mobilecam", "wxml", "doorbell"].includes(
        tuyaDevice.category,
      );
      const batteryCodes =
        tuyaDevice.schema
          ?.filter(
            (s) =>
              s.code === "battery_percentage" ||
              s.code === "battery_state" ||
              s.code === "battery_value" ||
              s.code === "va_battery" ||
              s.code === "wireless_electricity" ||
              s.code === "wireless_powermode" ||
              (s.code && s.code.startsWith("battery")),
          )
          .map((s) => s.code) || [];
      const hasBattery = batteryCodes.length > 0;
      const needsWake = isCamera && hasBattery;
      log(
        "info",
        `[WebRTC] Camera check: category=${tuyaDevice.category} isCamera=${isCamera} hasBattery=${hasBattery} batteryCodes=[${batteryCodes.join(",")}] online=${tuyaDevice.online} needsWake=${needsWake}`,
      );

      if (needsWake) {
        log(
          "info",
          `[WebRTC] Camera "${tuyaDevice.name}" is battery-powered, sending wake-up...`,
        );

        const wakeDpCodes = [
          "wireless_powermode",
          "wireless_awake",
          "cruise",
          "basic_awake",
          "video_call",
        ];
        const schemaWakeDps =
          tuyaDevice.schema?.filter(
            (s) =>
              wakeDpCodes.includes(s.code) &&
              (s.mode === "rw" || s.mode === "wo"),
          ) || [];
        const wakeDps = schemaWakeDps.map((s) => ({
          code: s.code,
          value: s.code === "wireless_powermode" ? 2 : true,
        }));
        if (wakeDps.length === 0) {
          wakeDps.push({ code: "wireless_powermode", value: 2 });
        }

        log(
          "info",
          `[WebRTC] Sending ${wakeDps.length} wake DP(s): [${wakeDps.map((d) => `${d.code}=${d.value}`).join(", ")}]`,
        );
        for (const dp of wakeDps) {
          dm.sendCommands(tuyaDevice.id, [
            { code: dp.code, value: dp.value },
          ]).then(
            () =>
              log(
                "info",
                `[WebRTC] Wake-up sent (dp=${dp.code}=${dp.value})`,
              ),
            (e) =>
              log(
                "debug",
                `[WebRTC] Wake-up (dp=${dp.code}) send failed: ${e.message || e}`,
              ),
          );
        }

        ctx._powerModeChanged = ctx._powerModeChanged || new Set();
        ctx._powerModeChanged.add(tuyaDevice.id);

        const WAKE_TIMEOUT_MS = 30000;
        const wakeStartTime = Date.now();
        api.sendWebrtcSignaling(deviceID, {
          event: "waking",
          message: "Camera is waking up... (up to 30s)",
          elapsed: 0,
        });

        const progressInterval = setInterval(() => {
          const elapsed = Math.round((Date.now() - wakeStartTime) / 1000);
          log(
            "info",
            `[WebRTC] Still waiting for "${tuyaDevice.name}" to wake... (${elapsed}s elapsed)`,
          );
          api.sendWebrtcSignaling(deviceID, {
            event: "waking",
            message: `Camera is waking up... (${elapsed}s)`,
            elapsed,
          });
        }, 10000);

        const wakeTimer = setTimeout(() => {
          clearInterval(progressInterval);
          ctx._wakeWatchers.delete(tuyaDevice.id);
          log(
            "warn",
            `[WebRTC] Wake timeout (${WAKE_TIMEOUT_MS / 1000}s) for "${tuyaDevice.name}" — flushing offer anyway`,
          );
        }, WAKE_TIMEOUT_MS);
        ctx._wakeWatchers.set(tuyaDevice.id, {
          resolve: () => {
            clearInterval(progressInterval);
            clearTimeout(wakeTimer);
            ctx._wakeWatchers.delete(tuyaDevice.id);
            log(
              "info",
              `[WebRTC] Camera "${tuyaDevice.name}" wake confirmed — offer already sent via IPC MQTT`,
            );
          },
          timer: wakeTimer,
          progressInterval,
        });
      }

      log(
        "info",
        `[WebRTC] Fetching configs for Tuya device ${tuyaDevice.id}`,
      );
      const configs = await wr.getConfigs(tuyaDevice.id);

      if (configs) {
        log("info", `[WebRTC] Configs fetched, connecting to IPC MQTT`);
        wr.connect(tuyaDevice.id, tuyaDevice.local_key, configs, needsWake);

        if (needsWake) {
          log(
            "info",
            `[WebRTC] Battery camera — starting P2P + stream allocation in parallel for "${tuyaDevice.name}"`,
          );
          startP2P(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
            log("debug", `[WebRTC] P2P start failed: ${e.message}`),
          );
          startStreamAllocation(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
            log("debug", `[StreamAlloc] Failed: ${e.message}`),
          );
        }
      } else {
        log(
          "warn",
          `[WebRTC] WebRTC not supported for device ${tuyaDevice.id}`,
        );
        api.sendWebrtcSignaling(deviceID, {
          event: "error",
          message: "WebRTC not supported by this device",
        });
        ctx._webrtcClients.delete(deviceID);
      }
    } catch (e) {
      log("error", `[WebRTC] Start failed: ${e.message || e}`);
      api.sendWebrtcSignaling(deviceID, {
        event: "error",
        message: `WebRTC start failed: ${e.message || e}`,
      });
      if (ctx._webrtcClients) ctx._webrtcClients.delete(deviceID);
    }
    return;
  }

  const wr = ctx._webrtcClients.get(deviceID);
  if (!wr) {
    api.sendWebrtcSignaling(deviceID, {
      event: "error",
      message: "No active WebRTC session — call 'start' first",
    });
    return;
  }

  if (value.event === "offer") {
    wr.sendOffer(value.sdp, value.stream_type);
  } else if (value.event === "answer") {
    wr.sendAnswer(value.sdp);
  } else if (value.event === "candidate") {
    wr.sendCandidate(value.candidate);
  } else if (value.event === "disconnect") {
    wr.sendDisconnect();
    wr.disconnect();
    ctx._webrtcClients.delete(deviceID);
    const tuyaId = ctx.doimusDeviceMap.get(deviceID);
    if (tuyaId) {
      const existing = ctx._wakeWatchers.get(tuyaId);
      if (existing) {
        clearTimeout(existing.timer);
        if (existing.progressInterval) clearInterval(existing.progressInterval);
        ctx._wakeWatchers.delete(tuyaId);
        log(
          "info",
          `WebRTC disconnected — cleaned up wake watcher for device ${deviceID}`,
        );
      }
      if (ctx._powerModeChanged?.has(tuyaId)) {
        const td = dm.getDevice(tuyaId);
        if (td) {
          dm.sendCommands(tuyaId, [
            { code: "wireless_powermode", value: 0 },
          ]).then(
            () =>
              log(
                "info",
                `WebRTC disconnected — restored power-save mode for "${td.name}"`,
              ),
            (e) =>
              log(
                "debug",
                `[WebRTC] Restore power mode failed: ${e.message || e}`,
              ),
          );
        }
        ctx._powerModeChanged.delete(tuyaId);
      }
    }
    stopStreamAllocation(deviceID, ctx, log);
    const fallbackTimer = ctx._streamFallbackTimers.get(deviceID);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      ctx._streamFallbackTimers.delete(deviceID);
      log(
        "info",
        `Stream disconnected — cleaned up fallback timer for device ${deviceID}`,
      );
    }
  }
}

async function handleIRCommand(
  deviceID,
  key,
  value,
  tuyaDevice,
  ctx,
  dm,
  api,
  log,
) {
  if (tuyaDevice.category === "infrared_ac") {
    const cur = {};
    for (const s of tuyaDevice.status || []) {
      if (s.code === "power") cur.power = Number(s.value);
      if (s.code === "mode") cur.mode = Number(s.value);
      if (s.code === "temp") cur.temp = Number(s.value);
      if (s.code === "wind") cur.wind = Number(s.value);
    }
    if (key === "on") cur.power = value === true ? 1 : 0;
    if (key === "target_temp") cur.temp = Number(value);
    if (key === "heating_mode") cur.mode = Number(value);
    if (key === "rotation_speed") cur.wind = Number(value);
    await dm.sendInfraredACCommands(
      tuyaDevice.parent_id,
      tuyaDevice.id,
      cur.power,
      cur.mode,
      cur.temp,
      cur.wind,
    );
    const newState = {};
    if (cur.power !== undefined) newState.on = cur.power === 1;
    if (cur.temp !== undefined) newState.target_temp = cur.temp;
    if (cur.mode !== undefined) newState.heating_mode = cur.mode;
    if (cur.wind !== undefined) newState.rotation_speed = cur.wind;
    api.updateDeviceState(deviceID, newState);
    ctx.lastKnownState.set(tuyaDevice.id, {
      ...ctx.lastKnownState.get(tuyaDevice.id),
      ...newState,
    });
  } else {
    const keyList = tuyaDevice.remote_keys && tuyaDevice.remote_keys.key_list;
    if (keyList && key === "on") {
      const powerKey = keyList.find(
        (k) => k.key === "power" || /power/i.test(k.key_name || ""),
      );
      if (powerKey) {
        await dm.sendInfraredCommands(
          tuyaDevice.parent_id,
          tuyaDevice.id,
          5,
          0,
          powerKey.key,
          powerKey.key_id,
        );
        api.updateDeviceState(deviceID, { on: value === true });
        ctx.lastKnownState.set(tuyaDevice.id, {
          ...ctx.lastKnownState.get(tuyaDevice.id),
          on: value === true,
        });
      }
    }
  }
}

module.exports = {
  registerDevicesWithDoimus,
  handleWebRTCCommand,
  handleIRCommand,
};
