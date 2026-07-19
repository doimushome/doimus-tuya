const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const TuyaOpenAPI = require("./core/TuyaOpenAPI");
const TuyaCustomDeviceManager = require("./device/TuyaCustomDeviceManager");
const TuyaHomeDeviceManager = require("./device/TuyaHomeDeviceManager");
const TuyaDeviceManager = require("./device/TuyaDeviceManager");
const WebRTCSignaling = require("./core/WebRTCSignaling");

const {
  applySchemaOverride,
  mapTuyaStatusToDoimusState,
  determineCapabilities,
  getDoimusType,
} = require("./util/state-mapper");
const {
  buildDeviceCommands,
  sendCommandsDebounced,
} = require("./util/command-builder");
const {
  startP2P,
  stopP2P,
  startStreamAllocation,
  stopStreamAllocation,
} = require("./core/camera-streaming");
const {
  startMotionCoalesce,
} = require("./core/motion-pipeline");

/**
 * Retry an async function with exponential backoff.
 */
async function retryWithBackoff(fn, maxRetries = 4, baseDelayMs = 1000, log) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        if (log)
          log(
            "warn",
            `Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e.message}`,
          );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function createLogger(api, prefix) {
  return (level, msg) => api.log(level, `[${prefix}] ${msg}`);
}

function generateUUID(id) {
  const hash = crypto.createHash("sha256").update(id).digest("hex");
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    "5" + hash.substring(12, 15),
    ((parseInt(hash.substring(15, 17), 16) & 0x3f) | 0x80).toString(16) +
      hash.substring(17, 19),
    hash.substring(19, 31),
  ].join("-");
}


function createPluginInstance() {
  return {
    debounceMap: new Map(),
    lastKnownState: new Map(),
    deviceManager: null,
    doimusDeviceMap: new Map(),
    apiRef: null,
    _wakeWatchers: new Map(),
    _streamFallbackTimers: new Map(), // fallback delay timers for battery cameras
  };
}

function validateConfig(options, log) {
  if (options.deviceOverrides) {
    const idMap = new Map();
    for (const item of options.deviceOverrides) {
      if (idMap.has(item.id)) {
        idMap.get(item.id).push(item);
      } else {
        idMap.set(item.id, [item]);
      }
    }
    for (const [id, items] of idMap.entries()) {
      if (items.length > 1) {
        log(
          "error",
          `"deviceOverrides" conflict: "id" "${id}" must be unique.`,
        );
        return false;
      }
    }

    for (const deviceOverride of options.deviceOverrides) {
      if (!deviceOverride.schema) continue;
      const codeMap = new Map();
      for (const item of deviceOverride.schema) {
        if (codeMap.has(item.code)) {
          codeMap.get(item.code).push(item);
        } else {
          codeMap.set(item.code, [item]);
        }
      }
      for (const [code, items] of codeMap.entries()) {
        if (items.length > 1) {
          log("error", `"schema" conflict: "code" "${code}" must be unique.`);
          return false;
        }
      }
    }

    // Validate schema override types and property ranges
    const VALID_TYPES = ["Boolean", "Integer", "Enum", "String", "Json", "Raw"];
    for (const deviceOverride of options.deviceOverrides) {
      if (!deviceOverride.schema) continue;
      for (const item of deviceOverride.schema) {
        if (item.type && !VALID_TYPES.includes(item.type)) {
          log("error", `Invalid schema type "${item.type}" for code "${item.code}". Valid: ${VALID_TYPES.join(", ")}`);
          return false;
        }
        if (item.property) {
          const p = item.property;
          if (p.min !== undefined && p.max !== undefined && Number(p.min) >= Number(p.max)) {
            log("error", `Invalid property range for code "${item.code}": min (${p.min}) >= max (${p.max})`);
            return false;
          }
        }
      }
    }
  }
  return true;
}

async function initCustomProject(api, options, log) {
  const { endpoint, accessId, accessKey, debug, debugLevel } = options;
  const debugMode =
    debug &&
    ((debugLevel || "").length > 0 ? debugLevel.includes("api") : true);

  const openAPI = new TuyaOpenAPI(
    endpoint,
    accessId,
    accessKey,
    log,
    "en",
    debugMode,
  );
  const dm = new TuyaCustomDeviceManager(openAPI, debugMode);

  log("info", "Get token.");
  let res = await retryWithBackoff(() => openAPI.getToken(), 4, 2000, log);
  if (res.success === false) {
    log("error", `Get token failed. code=${res.code}, msg=${res.msg}`);
    return null;
  }

  const DEFAULT_USER = "doimus";
  log("info", `Search default user "${DEFAULT_USER}"`);
  res = await openAPI.customGetUserInfo(DEFAULT_USER);
  if (res.success === false) {
    log("error", `Search user failed. code=${res.code}, msg=${res.msg}`);
    return null;
  }

  if (!res.result || !res.result.user_name) {
    log("info", `Creating default user "${DEFAULT_USER}".`);
    res = await openAPI.customCreateUser(DEFAULT_USER, DEFAULT_USER);
    if (res.success === false) {
      log(
        "error",
        `Create default user failed. code=${res.code}, msg=${res.msg}`,
      );
      return null;
    }
  }

  const uid = res.result.user_id;
  log("info", "Fetching asset list.");
  res = await dm.getAssetList();
  if (res.success === false) {
    log(
      "error",
      `Fetching asset list failed. code=${res.code}, msg=${res.msg}`,
    );
    return null;
  }

  const assetIDList = (res.result.list || []).map((a) => a.asset_id);
  if (assetIDList.length === 0) {
    log("warn", "Asset list is empty.");
    return null;
  }

  log("info", "Authorize asset list.");
  res = await dm.authorizeAssetList(uid, assetIDList, true);
  if (res.success === false) {
    log(
      "error",
      `Authorize asset list failed. code=${res.code}, msg=${res.msg}`,
    );
    return null;
  }

  log("info", "Logging in with user.");
  res = await openAPI.customLogin(DEFAULT_USER, DEFAULT_USER);
  if (res.success === false) {
    log("error", `Login failed. code=${res.code}, msg=${res.msg}`);
    if (TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]) {
      log("error", TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]);
    }
    return null;
  }

  // Set up automatic re-login when token refresh expires (after ~7 days).
  // Also restarts MQTT after successful re-login so it fetches fresh credentials.
  openAPI.setReloginHandler(async () => {
    log("info", "Re-logging in default user due to token expiry...");
    const result = await openAPI.customLogin(DEFAULT_USER, DEFAULT_USER);
    if (result && result.success) {
      log(
        "info",
        "Re-login successful, restarting MQTT with fresh credentials...",
      );
      try {
        dm.mq.start();
      } catch (mqErr) {
        log("warn", `MQTT restart after re-login failed: ${mqErr.message}`);
      }
    }
    return result;
  });

  log("info", "Starting MQTT connection.");
  dm.mq.start();
  log("info", "Fetching device list.");
  dm.ownerIDs = assetIDList;
  await dm.updateDevices(assetIDList);
  return { dm, uid, debugMode };
}

async function initHomeProject(api, options, log) {
  const {
    accessId,
    accessKey,
    countryCode,
    username,
    password,
    appSchema,
    endpoint,
    debug,
    debugLevel,
  } = options;
  const debugMode =
    debug &&
    ((debugLevel || "").length > 0 ? debugLevel.includes("api") : true);

  const resolvedEndpoint =
    endpoint && endpoint.length > 0
      ? endpoint
      : TuyaOpenAPI.getDefaultEndpoint(countryCode);

  const openAPI = new TuyaOpenAPI(
    resolvedEndpoint,
    accessId,
    accessKey,
    log,
    "en",
    debugMode,
  );
  const dm = new TuyaHomeDeviceManager(openAPI, debugMode);

  log("info", "Logging in to Tuya Cloud.");
  let res = await retryWithBackoff(
    () => openAPI.homeLogin(countryCode, username, password, appSchema),
    4,
    2000,
    log,
  );
  if (res.success === false) {
    log("error", `Login failed. code=${res.code}, msg=${res.msg}`);
    if (TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]) {
      log("error", TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]);
    }
    return null;
  }

  // Set up automatic re-login when token refresh expires.
  // Also restarts MQTT after successful re-login so it fetches fresh credentials.
  openAPI.setReloginHandler(async () => {
    log("info", "Re-logging in to Tuya Cloud due to token expiry...");
    const result = await openAPI.homeLogin(
      countryCode,
      username,
      password,
      appSchema,
    );
    if (result && result.success) {
      log(
        "info",
        "Re-login successful, restarting MQTT with fresh credentials...",
      );
      try {
        dm.mq.start();
      } catch (mqErr) {
        log("warn", `MQTT restart after re-login failed: ${mqErr.message}`);
      }
    }
    return result;
  });

  log("info", "Starting MQTT connection.");
  dm.mq.start();

  log("info", "Fetching home list.");
  res = await dm.getHomeList();
  if (res.success === false) {
    log("error", `Fetching home list failed. code=${res.code}, msg=${res.msg}`);
    return null;
  }

  const homeWhitelist = options.homeWhitelist;
  const homeIDList = [];
  for (const { home_id, name } of res.result || []) {
    log("info", `Got home_id=${home_id}, name=${name}`);
    if (!homeWhitelist || homeWhitelist.includes(home_id)) {
      homeIDList.push(home_id);
    }
  }

  if (homeIDList.length === 0) {
    log("warn", "Home list is empty or no whitelisted homes found.");
    return { dm, uid: openAPI.tokenInfo.uid, debugMode };
  }

  log("info", "Fetching device list.");
  dm.ownerIDs = homeIDList.map((id) => id.toString());
  await dm.updateDevices(homeIDList);

  log("info", "Fetching scenes.");
  for (const homeID of homeIDList) {
    const scenes = await dm.getSceneList(homeID);
    if (scenes.length > 0) {
      dm.devices.push(...scenes);
      log("info", `Got ${scenes.length} scene(s) from home ${homeID}`);
    }
  }

  return { dm, uid: openAPI.tokenInfo.uid, debugMode };
}

async function persistDeviceList(api, dm, uid, log) {
  try {
    const persistPath = path.join(process.cwd(), "data", "persist");
    if (!fs.existsSync(persistPath)) {
      fs.mkdirSync(persistPath, { recursive: true });
    }
    const file = path.join(persistPath, `TuyaDeviceList.${uid}.json`);
    const devices = dm.devices.map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      product_id: d.product_id,
      online: d.online,
      schema: d.schema,
      status: d.status,
    }));
    fs.writeFileSync(file, JSON.stringify(devices, null, 2));
    log("info", `Device list saved at ${file}`);
  } catch (_) {}
}

async function registerDevicesWithDoimus(api, dm, options, ctx, log) {
  const devices = dm.devices;
  if (!devices || devices.length === 0) {
    log("warn", "No devices found.");
    return;
  }

  log("info", `Registering ${devices.length} Tuya device(s) with Doimus.`);

  for (const device of devices) {
    // Skip IR control hubs — they are bridges for sub-devices (remotes).
    if (device.isIRControlHub && device.isIRControlHub()) continue;
    applySchemaOverride(device, options);
    const type = getDoimusType(device, options);
    if (type === "hidden") continue;

    const doimusID = generateUUID(device.id);
    const capabilities = determineCapabilities(device);

    // Permanently clear all motion/doorbell-related transient DP values
    // so the initial state starts clean.  Match using the same regex
    // pattern that mapTuyaStatusToDoimusState uses in its generic
    // fallback — this catches both known codes (movement_detect_pic, etc.)
    // and device-specific codes (motion_alert, iot_motion, etc.) that
    // aren't in any hardcoded list.
    const motionPattern = /motion|movement|doorbell|human|person|pir/i;
    for (const item of device.status) {
      if (motionPattern.test(item.code)) {
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

// ── Domain-specific command handlers (extracted from onCommand) ──

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
              log("info", `[WebRTC] Battery camera delay elapsed — starting fallback streaming for "${tuyaDevice.name}"`);
              if (ctx._webrtcClients.has(deviceID)) {
                const staleP2P = ctx.p2pClients?.get(deviceID);
                if (staleP2P) {
                  log("info", `[WebRTC] Closing stale P2P for "${tuyaDevice.name}" before fresh reconnect`);
                  staleP2P.close();
                  ctx.p2pClients.delete(deviceID);
                }
                startP2P(deviceID, tuyaDevice, ctx, log, api);
                startStreamAllocation(deviceID, tuyaDevice, ctx, log, api)
                  .catch((e) => log("debug", `[StreamAlloc] Failed: ${e.message}`));
              }
            }, BATTERY_DELAY_MS);
            ctx._streamFallbackTimers.set(deviceID, timer);
          } else {
            startP2P(deviceID, tuyaDevice, ctx, log, api);
            startStreamAllocation(deviceID, tuyaDevice, ctx, log, api)
              .catch((e) => log("debug", `[StreamAlloc] Failed: ${e.message}`));
          }
        }
      });
      wr.on("error", (err) => {
        api.sendWebrtcSignaling(deviceID, { event: "error", message: err.message });
      });
      wr.on("fallback", () => {
        const needsWake = computeNeedsWake(tuyaDevice);
        if (needsWake) {
          log("info", `[WebRTC] WebRTC timed out for battery camera "${tuyaDevice.name}" — fallback streaming already scheduled by disconnect handler`);
          api.sendWebrtcSignaling(deviceID, { event: "p2p_fallback" });
          return;
        }
        log("info", `[WebRTC] WebRTC timed out, trying cloud stream allocation for "${tuyaDevice.name}"`);
        api.sendWebrtcSignaling(deviceID, { event: "p2p_fallback" });
        const p2pCloudRelay = tuyaDevice.category === "sp" || tuyaDevice.category === "doorbell";
        if (!p2pCloudRelay) {
          startP2P(deviceID, tuyaDevice, ctx, log, api);
        }
        startStreamAllocation(deviceID, tuyaDevice, ctx, log, api)
          .catch((e) => log("debug", `[StreamAlloc] Failed: ${e.message}`));
      });

      const isCamera = ["sp", "mobilecam", "wxml", "doorbell"].includes(tuyaDevice.category);
      const batteryCodes = tuyaDevice.schema
        ?.filter((s) =>
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
      log("info", `[WebRTC] Camera check: category=${tuyaDevice.category} isCamera=${isCamera} hasBattery=${hasBattery} batteryCodes=[${batteryCodes.join(",")}] online=${tuyaDevice.online} needsWake=${needsWake}`);

      if (needsWake) {
        log("info", `[WebRTC] Camera "${tuyaDevice.name}" is battery-powered, sending wake-up...`);

        const wakeDpCodes = ["wireless_powermode", "wireless_awake", "cruise", "basic_awake", "video_call"];
        const schemaWakeDps = tuyaDevice.schema?.filter((s) =>
          wakeDpCodes.includes(s.code) && s.mode === "rw" || s.mode === "wo",
        ) || [];
        const wakeDps = schemaWakeDps.map((s) => ({
          code: s.code,
          value: s.code === "wireless_powermode" ? 2 : true,
        }));
        if (wakeDps.length === 0) {
          wakeDps.push({ code: "wireless_powermode", value: 2 });
        }

        log("info", `[WebRTC] Sending ${wakeDps.length} wake DP(s): [${wakeDps.map((d) => `${d.code}=${d.value}`).join(", ")}]`);
        for (const dp of wakeDps) {
          dm.sendCommands(tuyaDevice.id, [{ code: dp.code, value: dp.value }]).then(
            () => log("info", `[WebRTC] Wake-up sent (dp=${dp.code}=${dp.value})`),
            (e) => log("debug", `[WebRTC] Wake-up (dp=${dp.code}) send failed: ${e.message || e}`),
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
          log("info", `[WebRTC] Still waiting for "${tuyaDevice.name}" to wake... (${elapsed}s elapsed)`);
          api.sendWebrtcSignaling(deviceID, {
            event: "waking",
            message: `Camera is waking up... (${elapsed}s)`,
            elapsed,
          });
        }, 10000);

        const wakeTimer = setTimeout(() => {
          clearInterval(progressInterval);
          ctx._wakeWatchers.delete(tuyaDevice.id);
          log("warn", `[WebRTC] Wake timeout (${WAKE_TIMEOUT_MS / 1000}s) for "${tuyaDevice.name}" — flushing offer anyway`);
        }, WAKE_TIMEOUT_MS);
        ctx._wakeWatchers.set(tuyaDevice.id, {
          resolve: () => {
            clearInterval(progressInterval);
            clearTimeout(wakeTimer);
            ctx._wakeWatchers.delete(tuyaDevice.id);
            log("info", `[WebRTC] Camera "${tuyaDevice.name}" wake confirmed — offer already sent via IPC MQTT`);
          },
          timer: wakeTimer,
          progressInterval,
        });
      }

      log("info", `[WebRTC] Fetching configs for Tuya device ${tuyaDevice.id}`);
      const configs = await wr.getConfigs(tuyaDevice.id);

      if (configs) {
        log("info", `[WebRTC] Configs fetched, connecting to IPC MQTT`);
        wr.connect(tuyaDevice.id, tuyaDevice.local_key, configs, needsWake);

        if (needsWake) {
          log("info", `[WebRTC] Battery camera — starting P2P + stream allocation in parallel for "${tuyaDevice.name}"`);
          startP2P(deviceID, tuyaDevice, ctx, log, api);
          startStreamAllocation(deviceID, tuyaDevice, ctx, log, api)
            .catch((e) => log("debug", `[StreamAlloc] Failed: ${e.message}`));
        }
      } else {
        log("warn", `[WebRTC] WebRTC not supported for device ${tuyaDevice.id}`);
        api.sendWebrtcSignaling(deviceID, { event: "error", message: "WebRTC not supported by this device" });
        ctx._webrtcClients.delete(deviceID);
      }
    } catch (e) {
      log("error", `[WebRTC] Start failed: ${e.message || e}`);
      api.sendWebrtcSignaling(deviceID, { event: "error", message: `WebRTC start failed: ${e.message || e}` });
      if (ctx._webrtcClients) ctx._webrtcClients.delete(deviceID);
    }
    return;
  }

  const wr = ctx._webrtcClients.get(deviceID);
  if (!wr) {
    api.sendWebrtcSignaling(deviceID, { event: "error", message: "No active WebRTC session — call 'start' first" });
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
        log("info", `WebRTC disconnected — cleaned up wake watcher for device ${deviceID}`);
      }
      if (ctx._powerModeChanged?.has(tuyaId)) {
        const td = dm.getDevice(tuyaId);
        if (td) {
          dm.sendCommands(tuyaId, [{ code: "wireless_powermode", value: 0 }]).then(
            () => log("info", `WebRTC disconnected — restored power-save mode for "${td.name}"`),
            (e) => log("debug", `[WebRTC] Restore power mode failed: ${e.message || e}`),
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
      log("info", `Stream disconnected — cleaned up fallback timer for device ${deviceID}`);
    }
  }
}

async function handleIRCommand(deviceID, key, value, tuyaDevice, ctx, dm, api, log) {
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
    await dm.sendInfraredACCommands(tuyaDevice.parent_id, tuyaDevice.id, cur.power, cur.mode, cur.temp, cur.wind);
    const newState = {};
    if (cur.power !== undefined) newState.on = cur.power === 1;
    if (cur.temp !== undefined) newState.target_temp = cur.temp;
    if (cur.mode !== undefined) newState.heating_mode = cur.mode;
    if (cur.wind !== undefined) newState.rotation_speed = cur.wind;
    api.updateDeviceState(deviceID, newState);
    ctx.lastKnownState.set(tuyaDevice.id, { ...ctx.lastKnownState.get(tuyaDevice.id), ...newState });
  } else {
    const keyList = tuyaDevice.remote_keys && tuyaDevice.remote_keys.key_list;
    if (keyList && key === "on") {
      const powerKey = keyList.find((k) => k.key === "power" || /power/i.test(k.key_name || ""));
      if (powerKey) {
        await dm.sendInfraredCommands(tuyaDevice.parent_id, tuyaDevice.id, 5, 0, powerKey.key, powerKey.key_id);
        api.updateDeviceState(deviceID, { on: value === true });
        ctx.lastKnownState.set(tuyaDevice.id, { ...ctx.lastKnownState.get(tuyaDevice.id), on: value === true });
      }
    }
  }
}

function computeNeedsWake(tuyaDevice) {
  const isCamera = ["sp", "mobilecam", "wxml", "doorbell"].includes(tuyaDevice.category);
  const batteryCodes = tuyaDevice.schema
    ?.filter((s) =>
      s.code === "battery_percentage" ||
      s.code === "battery_state" ||
      s.code === "battery_value" ||
      s.code === "va_battery" ||
      s.code === "wireless_electricity" ||
      s.code === "wireless_powermode" ||
      (s.code && s.code.startsWith("battery")),
    )
    .map((s) => s.code) || [];
  return isCamera && batteryCodes.length > 0;
}

module.exports = {
  async start(cfg, api) {
    const ctx = createPluginInstance();
    ctx.apiRef = api;
    this._ctx = ctx;
    const options = (cfg && cfg.options) || {};
    const log = createLogger(api, "TuyaPlatform");

    log("info", "Starting Tuya Platform plugin");

    if (!options.accessId || !options.accessKey) {
      log("error", "Access ID and Access Secret are required.");
      return;
    }

    if (!options.projectType) {
      log("error", "Project type is required.");
      return;
    }

    if (!validateConfig(options, log)) {
      log("error", "Configuration validation failed.");
      return;
    }

    let result = null;
    try {
      if (options.projectType === "1") {
        result = await initCustomProject(api, options, log);
      } else if (options.projectType === "2") {
        result = await initHomeProject(api, options, log);
      } else {
        log("error", `Unsupported projectType: ${options.projectType}`);
        return;
      }
    } catch (e) {
      log("warn", `Initialization failed: ${e.message}. Will retry in 60s.`);
      ctx._initRetryTimer = setTimeout(() => start(cfg, api), 60000);
      return;
    }

    if (!result || !result.dm) {
      log("error", "Failed to initialize Tuya connection. Will retry in 60s.");
      ctx._initRetryTimer = setTimeout(() => start(cfg, api), 60000);
      return;
    }

    const { dm, uid, debugMode } = result;
    ctx.deviceManager = dm;

    // Populate IR remote sub-devices (keys, AC status, etc.) before registration.
    await dm.updateInfraredRemotes(dm.devices);

    await persistDeviceList(api, dm, uid, log);
    await registerDevicesWithDoimus(api, dm, options, ctx, log);

    // Fetch local_key for camera/doorbell devices (needed for image decryption).
    // The bulk device list API omits local_key — must fetch per-device.
    for (const device of dm.devices) {
      if (
        ["sp", "doorbell", "mobilecam", "wxml"].includes(device.category) &&
        !device.local_key
      ) {
        const info = await dm.getDeviceInfo(device.id);
        if (info.success && info.result && info.result.local_key) {
          device.local_key = info.result.local_key;
          log("info", `Fetched local_key for camera device "${device.name}"`);
        } else {
          log(
            "warn",
            `No local_key for camera device "${device.name}" (api success=${info.success})`,
          );
        }
      }
    }

    // Auto-start P2P for camera devices (opt-in via config.p2pAutoStart for testing)
    if (options.p2pAutoStart) {
      for (const device of dm.devices) {
        if (
          ["sp", "doorbell", "mobilecam", "wxml"].includes(device.category) &&
          device.local_key
        ) {
          const doimusID = ctx.doimusDeviceMap.get(device.id);
          if (doimusID) {
            log("info", `Auto-starting P2P for camera "${device.name}"`);
            startP2P(doimusID, device, ctx, log, api);
          }
        }
      }
    }

    // Periodic REST API polling for energy monitoring devices
    // Tuya's MQTT often doesn't push cur_current, cur_power, cur_voltage
    // updates reliably, so we poll the REST API to catch changes.
    const energyPollDevices = dm.devices.filter(
      (device) =>
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "cur_current" ||
            s.code === "cur_power" ||
            s.code === "cur_voltage" ||
            s.code === "meter_power" ||
            s.code === "total_forward_energy" ||
            s.code === "electricity",
        ),
    );

    // Log device schemas at startup for debugging
    if (debugMode) {
      for (const device of dm.devices) {
        log(
          "debug",
          `Device schema: ${device.name} (${device.id}, category=${device.category}) → codes=[${(device.schema || []).map((s) => `${s.code}(${s.type})`).join(", ")}]`,
        );
      }
    }
    if (energyPollDevices.length > 0) {
      log(
        "info",
        `Starting energy monitoring polling for ${energyPollDevices.length} device(s): ${energyPollDevices.map((d) => d.name).join(", ")}`,
      );
      ctx._energyPollTimer = setInterval(async () => {
        for (const device of energyPollDevices) {
          try {
            const res = await dm.getDeviceInfo(device.id);
            if (!res.success || !res.result) {
              log("debug", `Energy poll: ${device.name} → API returned error`);
              continue;
            }
            const status = res.result.status || [];
            const doimusID = ctx.doimusDeviceMap.get(device.id);
            if (!doimusID) {
              log(
                "warn",
                `Energy poll: no doimusID for ${device.name} (${device.id})`,
              );
              continue;
            }

            // Update device status so MQTT-only updates stay in sync
            for (const item of device.status) {
              const match = status.find((s) => s.code === item.code);
              if (match) item.value = match.value;
            }

            const state = mapTuyaStatusToDoimusState(device, status, options);
            log(
              "debug",
              `Energy poll: ${device.name} → API status returned codes=[${status.map((s) => `${s.code}=${s.value}`).join(",")}]`,
            );
            log(
              "debug",
              `Energy poll: ${device.name} → mapped stateKeys=[${Object.keys(state).join(",")}]`,
            );
            if (Object.keys(state).length > 0) {
              state.online = res.result.online ?? device.online;
              // Only push update if values actually changed
              const lastKnown = ctx.lastKnownState.get(device.id) || {};
              const changed = Object.keys(state).some(
                (k) =>
                  JSON.stringify(state[k]) !== JSON.stringify(lastKnown[k]),
              );
              log(
                "debug",
                `Energy poll: ${device.name} → changed=${changed} state=${JSON.stringify(state)}`,
              );
              if (changed) {
                api.updateDeviceState(doimusID, state);
                ctx.lastKnownState.set(device.id, {
                  ...lastKnown,
                  ...state,
                });
              }
            }
          } catch (e) {
            log("warn", `Energy poll error for ${device.name}: ${e.message}`);
          }
        }
      }, Math.max(5000, options.energyPollInterval || 30000));
      if (ctx._energyPollTimer.unref) ctx._energyPollTimer.unref();
    }

    // Snapshots are captured on-demand when MQTT motion events arrive
    // (startMotionCoalesce → processCoalescedMotion tries inline/S3/REST).
    // Periodic REST polling is disabled — Tuya cameras don't reliably
    // serve snapshots on a timer, and constant polling drowns out real
    // motion events with noise.
    if (result.dm) {
      const cameraDevices = result.dm.devices.filter((d) =>
        ["sp", "mobilecam", "wxml", "doorbell"].includes(d.category),
      );
      if (cameraDevices.length > 0) {
        log(
          "info",
          `Camera snapshot capture is event-driven (MQTT motion triggers). ${cameraDevices.length} camera(s): ${cameraDevices.map((d) => `"${d.name}" (id=${d.id})`).join(", ")}`,
        );
      }
    }
    ctx._snapshotTimer = null;

    api.onCommand(async (deviceID, key, value) => {
      if (key === "webrtc" && value && typeof value === "object") {
        const tuyaDevice = dm.getDevice(ctx.doimusDeviceMap.get(deviceID));
        if (!tuyaDevice) return;
        return handleWebRTCCommand(deviceID, value, tuyaDevice, ctx, dm, api, log);
      }

      const tuyaID = ctx.doimusDeviceMap.get(deviceID);
      if (!tuyaID) {
        log("warn", `onCommand: no Tuya device mapped for doimusID="${deviceID}" (key=${key}). Map has ${ctx.doimusDeviceMap.size} entries.`);
        return;
      }
      try {
        const tuyaDevice = dm.getDevice(tuyaID);
        if (!tuyaDevice) return;

        if (key === "p2p_start") {
          return startP2P(deviceID, tuyaDevice, ctx, log, api);
        }
        if (key === "p2p_stop") {
          stopP2P(deviceID, ctx, log);
          stopStreamAllocation(deviceID, ctx, log);
          return;
        }

        if (tuyaDevice.isIRRemoteControl && tuyaDevice.isIRRemoteControl()) {
          return handleIRCommand(deviceID, key, value, tuyaDevice, ctx, dm, api, log);
        }

        if (tuyaDevice.category === "scene" && key === "on" && value === true) {
          const homeID = tuyaDevice.owner_id ? Number(tuyaDevice.owner_id) : null;
          if (homeID && typeof dm.executeScene === "function") {
            await dm.executeScene(homeID, tuyaDevice.id);
            api.updateDeviceState(deviceID, { on: true });
            ctx.lastKnownState.set(tuyaDevice.id, { ...ctx.lastKnownState.get(tuyaDevice.id), on: true });
            setTimeout(() => {
              api.updateDeviceState(deviceID, { on: false });
              ctx.lastKnownState.set(tuyaDevice.id, { ...ctx.lastKnownState.get(tuyaDevice.id), on: false });
            }, 3000);
          }
          return;
        }

        const commands = buildDeviceCommands(key, value, tuyaDevice, deviceID, log);
        if (commands.length > 0) {
          sendCommandsDebounced(tuyaDevice, commands, ctx, log);
        }
      } catch (e) {
        log("error", `Command handler error: ${e.message}`);
      }
    });

    dm.on(
      TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE,
      async (device, status) => {
        const doimusID = ctx.doimusDeviceMap.get(device.id);
        if (!doimusID) {
          log(
            "warn",
            `DEVICE_STATUS_UPDATE: no doimusID for device ${device.id}`,
          );
          return;
        }
        // ── Wake confirmation check ──────────────────────────────────
        // Battery-powered cameras (sp, doorbell) send wireless_awake: true
        // via MQTT ~30-45s after receiving the wake DP. Resolve any pending
        // wake watcher so the WebRTC/P2P flow knows the camera is powered on.
        const hasWakeConfirm = (status || []).some(
          (s) =>
            s.code === "wireless_awake" &&
            (s.value === true || s.value === "true"),
        );
        if (hasWakeConfirm) {
          log(
            "info",
            `Wake confirmed for "${device.name}" — wireless_awake=true`,
          );
          const watcher = ctx._wakeWatchers.get(device.id);
          if (watcher) {
            log(
              "info",
              `Wake watcher resolved for "${device.name}" — calling setWoken()`,
            );
            if (typeof watcher.resolve === "function") {
              watcher.resolve();
            }
          } else {
            log(
              "warn",
              `Wake confirmed but no watcher found for "${device.name}" — wireless_awake arrived too late or stale`,
            );
          }
        }

        const state = mapTuyaStatusToDoimusState(device, status, options);
        log(
          "info",
          `DEVICE_STATUS_UPDATE: ${device.name} → stateKeys=[${Object.keys(state).join(",")}]`,
        );
        log(
          "debug",
          `DEVICE_STATUS_UPDATE full: ${device.name} → ${JSON.stringify(state)}`,
        );
        let motionActivated = false;
        if (Object.keys(state).length > 0) {
          state.online = device.online;
          const lastKnown = ctx.lastKnownState.get(device.id) || {};
          // ── Startup grace period ────────────────────────────────────
          // On the first MQTT update after registration, the Tuya broker
          // may replay cached motion DP values from before the camera
          // went to sleep.  Suppress the motion=true push so the mobile
          // app doesn't flash a stale motion event.  The auto-reset timer
          // will still fire and clear device.status, keeping things clean
          // for subsequent updates.
          if (!ctx._firstUpdateSeen) ctx._firstUpdateSeen = new Set();
          const isFirst = !ctx._firstUpdateSeen.has(device.id);
          if (isFirst && state.motion === true) {
            log(
              "info",
              `DEVICE_STATUS_UPDATE: ${device.name} → suppressing initial motion=true (grace period)`,
            );
            delete state.motion;
          }
          if (isFirst) {
            ctx._firstUpdateSeen.add(device.id);
          }
          // Motion activation edge (false/nil -> true) for this update.
          motionActivated = state.motion === true && !lastKnown.motion;

          // ── Critical: suppress motion:true from this initial state push ──
          // The coalesce handler (processCoalescedMotion) is the sole sender
          // of motion:true. It includes _capture_id so the backend can set
          // image_key on the timeline entry from the start.  Without this
          // suppression, the state update below creates a timeline entry
          // WITHOUT image_key, and the subsequent processCoalescedMotion
          // update (true→true) is a no-op — so _capture_id is wasted.
          if (motionActivated) {
            delete state.motion;
          }

          // Only push update if values actually changed — prevents MQTT
          // heartbeats from overwriting recently-commanded state (e.g. blind
          // position set to 100 by the app, then a heartbeat arrives with the
          // old percent_control=0 and reverts it back).
          const changed = Object.keys(state).some(
            (k) => JSON.stringify(state[k]) !== JSON.stringify(lastKnown[k]),
          );
          if (changed) {
            api.updateDeviceState(doimusID, state);
          }
          // Always update lastKnown for edge detection, auto-reset timer, and
          // subsequent MQTT dedup — even when we suppressed motion from the push.
          ctx.lastKnownState.set(device.id, {
            ...lastKnown,
            ...state,
            ...(motionActivated ? { motion: true } : {}),
          });

          // ── Motion auto-reset timer (camera / doorbell / sensor) ──
          // When motion fires, schedule a 5-second reset. If the device
          // clears the motion DP on its own via MQTT before the timer fires,
          // the timer is harmless (it checks lastKnownState first).
          if (motionActivated) {
            if (!ctx._motionTimers) ctx._motionTimers = new Map();
            const existing = ctx._motionTimers.get(device.id);
            if (existing) clearTimeout(existing);
            ctx._motionTimers.set(
              device.id,
              setTimeout(() => {
                const current = ctx.lastKnownState.get(device.id);
                // Only reset if motion is still true — device may have
                // already cleared it via MQTT.
                if (current && current.motion === true) {
                  log(
                    "info",
                    `Motion auto-reset for "${device.name}" (5s timeout)`,
                  );
                  const resetState = { motion: false };
                  api.updateDeviceState(doimusID, resetState);
                  ctx.lastKnownState.set(device.id, {
                    ...current,
                    ...resetState,
                  });
                  // Clear transient motion DPs in device.status so the
                  // next heartbeat doesn't re-trigger motion=true from
                  // stale DP values (especially for battery cameras that
                  // sleep after a motion event and never send the clearing
                  // MQTT update).
                  if (Array.isArray(device.status)) {
                    const motionPattern =
                      /motion|movement|doorbell|human|person|pir/i;
                    for (const dp of device.status) {
                      if (motionPattern.test(dp.code)) {
                        dp.value = "";
                      }
                    }
                  }
                }
                ctx._motionTimers.delete(device.id);
              }, 5000),
            );
          }
          // If motion cleared before timer fires, cancel the pending reset.
          if (state.motion === false && ctx._motionTimers) {
            const pending = ctx._motionTimers.get(device.id);
            if (pending) {
              clearTimeout(pending);
              ctx._motionTimers.delete(device.id);
            }
          }
        }

        // ── Motion image capture (coalesced) ──────────────────────────────────
        // Multiple MQTT packets arrive per physical motion event (motion DP,
        // initiative_message, movement_detect_pic). Coalesce them over a short
        // debounce window so one event = one capture = one unique image key.
        // The old approach used competing S3 / REST timers with complex
        // cancellation logic — this single coordinator replaces all of that.
        const hasMotionSignalInPacket = (status || []).some((s) => {
          if (!s || typeof s.code !== "string") return false;
          const code = s.code;
          const value = s.value;
          const active = typeof value === "string" ? value.length > 0 : !!value;
          if (!active) return false;
          return (
            code === "movement_detect_pic" ||
            code === "doorbell_pic" ||
            code === "ipc_human" ||
            code === "initiative_message" ||
            /motion|movement|doorbell|human|person|pir/i.test(code)
          );
        });
        const shouldCaptureMotionImage =
          motionActivated || state.motion === true || hasMotionSignalInPacket;

        if (
          ["sp", "doorbell", "mobilecam", "wxml"].includes(device.category) &&
          shouldCaptureMotionImage
        ) {
          startMotionCoalesce(device, status, doimusID, ctx, dm, api, log);
        }
      },
    );

    dm.on(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, (device, info) => {
      const doimusID = ctx.doimusDeviceMap.get(device.id);
      if (!doimusID) return;

      const prevOnline = ctx.lastKnownState.get(device.id)?.online;
      const state = { online: device.online };

      if (info && info.name) {
        log("info", `Device renamed: ${device.name}`);
      }

      // Log online transitions for debugging
      if (prevOnline !== undefined && prevOnline !== device.online) {
        log(
          "info",
          `Camera "${device.name}" online transition: ${prevOnline} → ${device.online}`,
        );
      }

      // When a device goes offline, clear transient motion/doorbell DPs
      // in device.status so that when it comes back online it starts
      // with a clean state.
      if (device.online === false && Array.isArray(device.status)) {
        const motionPattern = /motion|movement|doorbell|human|person|pir/i;
        for (const dp of device.status) {
          if (motionPattern.test(dp.code)) {
            dp.value = "";
          }
        }
      }

      // When a battery camera comes online, it was woken by PIR/doorbell.
      // Try to capture a snapshot while the device is reachable.
      if (
        device.online === true &&
        prevOnline === false &&
        ["sp", "doorbell", "mobilecam", "wxml"].includes(device.category) &&
        device.id
      ) {
        log(
          "info",
          `Camera "${device.name}" came online — scheduling REST snapshot fallback in 4s`,
        );
        if (!ctx._onlineSnapshotTimers) ctx._onlineSnapshotTimers = new Map();
        const pending = ctx._onlineSnapshotTimers.get(device.id);
        if (pending) clearTimeout(pending);
        ctx._onlineSnapshotTimers.set(
          device.id,
          setTimeout(async () => {
            ctx._onlineSnapshotTimers.delete(device.id);
            try {
              const jpeg = await dm.api.getCameraSnapshot(device.id);
              if (jpeg) {
                api.sendMjpegFrame(doimusID, "main", jpeg);
                api.updateDeviceImage(
                  doimusID,
                  "snapshot_latest",
                  jpeg,
                  "image/jpeg",
                );
                log(
                  "info",
                  `Online snapshot captured for "${device.name}" size=${jpeg.length}B`,
                );
              } else {
                log(
                  "warn",
                  `Online snapshot returned no image for "${device.name}"`,
                );
              }
            } catch (e) {
              log(
                "warn",
                `Online snapshot failed for "${device.name}": ${e.message || e}`,
              );
            }
          }, 4000),
        );
      }

      api.updateDeviceState(doimusID, state);
      ctx.lastKnownState.set(device.id, {
        ...ctx.lastKnownState.get(device.id),
        ...state,
      });
    });

    dm.on(TuyaDeviceManager.Events.DEVICE_ADD, async (device) => {
      // Skip IR control hubs — they are bridges for sub-devices (remotes).
      if (device.isIRControlHub && device.isIRControlHub()) return;
      log("info", `New device added: ${device.name}`);
      const options2 = (cfg && cfg.options) || {};
      device.schema = await dm.getDeviceSchema(device.id);
      // Fetch local_key for camera/doorbell/mobilecam devices (needed for image decryption)
      if (
        ["sp", "doorbell", "mobilecam", "wxml"].includes(device.category) &&
        !device.local_key
      ) {
        const info = await dm.getDeviceInfo(device.id);
        if (info.success && info.result && info.result.local_key) {
          device.local_key = info.result.local_key;
          log(
            "info",
            `Fetched local_key for new camera device "${device.name}"`,
          );
        }
      }
      applySchemaOverride(device, options2);
      dm.devices.push(device);

      const type = getDoimusType(device, options2);
      if (type === "hidden") return;

      const doimusID = generateUUID(device.id);
      const capabilities = determineCapabilities(device);
      const initialState = mapTuyaStatusToDoimusState(
        device,
        device.status,
        options2,
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
    });

    dm.on(TuyaDeviceManager.Events.DEVICE_DELETE, (deviceID) => {
      const doimusID = ctx.doimusDeviceMap.get(deviceID);
      if (!doimusID) return;
      log("info", `Device removed: ${deviceID}`);
      ctx.doimusDeviceMap.delete(doimusID);
      ctx.doimusDeviceMap.delete(deviceID);
      ctx.lastKnownState.delete(deviceID);
    });

    log("info", "Tuya Platform plugin ready.");
    log(
      "info",
      `Energy polling: ${energyPollDevices.length} device(s) monitored, MJPEG snapshot: event-driven`,
    );
  },

  async setConfig(cfg) {
    const api = this._ctx ? this._ctx.apiRef : null;
    if (!api) return;
    this.stop();
    await this.start(cfg, api);
  },

  stop() {
    const ctx = this._ctx;
    if (ctx) {
      if (ctx._energyPollTimer) {
        clearInterval(ctx._energyPollTimer);
        ctx._energyPollTimer = null;
      }
      if (ctx._snapshotTimer) {
        clearInterval(ctx._snapshotTimer);
        ctx._snapshotTimer = null;
      }
      if (ctx._initRetryTimer) {
        clearTimeout(ctx._initRetryTimer);
        ctx._initRetryTimer = null;
      }
      if (ctx.deviceManager && ctx.deviceManager.mq) {
        try {
          ctx.deviceManager.mq.stop();
        } catch (_) {}
      }
      for (const [, debounced] of ctx.debounceMap.entries()) {
        debounced.clear();
      }
      ctx.debounceMap.clear();
      ctx.lastKnownState.clear();
      ctx.deviceManager = null;
      ctx.doimusDeviceMap.clear();
      if (ctx.p2pClients) {
        for (const [id, p2p] of ctx.p2pClients) {
          try {
            p2p.close();
          } catch (_) {}
        }
        ctx.p2pClients.clear();
      }
      if (ctx._streamAllocProcs) {
        for (const [, proc] of ctx._streamAllocProcs) {
          try {
            proc.kill("SIGTERM");
          } catch (_) {}
        }
        ctx._streamAllocProcs.clear();
      }
      if (ctx._motionTimers) {
        for (const [, timer] of ctx._motionTimers) {
          clearTimeout(timer);
        }
        ctx._motionTimers.clear();
      }
      if (ctx._motionCoalesce) {
        for (const [, entry] of ctx._motionCoalesce) {
          clearTimeout(entry.timer);
          clearTimeout(entry.asyncTimer);
        }
        ctx._motionCoalesce.clear();
      }
      if (ctx._onlineSnapshotTimers) {
        for (const [, timer] of ctx._onlineSnapshotTimers) {
          clearTimeout(timer);
        }
        ctx._onlineSnapshotTimers.clear();
      }
      if (ctx._pendingCommandBatches) {
        ctx._pendingCommandBatches.clear();
      }
      ctx.apiRef = null;
      this._ctx = null;
    }
  },
};
