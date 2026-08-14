const TuyaLocalDeviceManager = require("./local/LocalDeviceManager");
const TuyaHybridDeviceManager = require("./shared/TuyaHybridDeviceManager");
const TuyaDeviceManager = require("./shared/TuyaDeviceManager");
const WebRTCSignaling = require("./camera/WebRTCSignaling");

const {
  applySchemaOverride,
  mapTuyaStatusToDoimusState,
  determineCapabilities,
  getDoimusType,
} = require("./shared/state-mapper");
const {
  buildDeviceCommands,
  sendCommandsDebounced,
} = require("./shared/command-builder");
const {
  startP2P,
  stopP2P,
  startStreamAllocation,
  stopStreamAllocation,
} = require("./camera/camera-streaming");
const { startMotionCoalesce } = require("./camera/motion-pipeline");

const { PluginContext } = require("./shared/PluginContext");
const {
  MOTION_DP_PATTERN,
  createLogger,
  generateUUID,
  validateConfig,
  computeNeedsWake,
  persistDeviceList,
} = require("./shared/plugin-utils");
const { initCustomProject, initHomeProject } = require("./cloud/init-projects");
const {
  registerDevicesWithDoimus,
  buildUiDescriptor,
  handleWebRTCCommand,
  handleIRCommand,
} = require("./shared/handlers");

// Exponential backoff for init/login retries. Prevents hammering the Tuya API
// when the account is in a bad state (1010/1013 token conflicts): each retry
// doubles the delay up to a cap, and success resets the counter.
let initRetryAttempts = 0;
const INIT_RETRY_MIN_MS = 60 * 1000;
const INIT_RETRY_MAX_MS = 5 * 60 * 1000;

function nextInitRetryDelay() {
  return Math.min(
    INIT_RETRY_MIN_MS * Math.pow(2, initRetryAttempts),
    INIT_RETRY_MAX_MS,
  );
}

// Attempts a REST snapshot for a battery camera. The cloud snapshot only
// succeeds while the camera is awake, so retry it right after a wake
// confirmation (or online transition) instead of only on initial discovery.
function scheduleRestSnapshot(device, doimusID, dm, ctx, api, log, delayMs = 4000) {
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
            "debug",
            `Online snapshot returned no image for "${device.name}"`,
          );
        }
      } catch (e) {
        log(
          "debug",
          `Online snapshot failed for "${device.name}": ${e.message || e}`,
        );
      }
    }, delayMs),
  );
}

module.exports = {
  async start(cfg, api) {
    const ctx = new PluginContext();
    ctx.apiRef = api;
    this._ctx = ctx;
    const options = (cfg && cfg.options) || {};
    const log = createLogger(api, "TuyaPlatform");

    ctx._streamAllocBootDelay = options.streamAllocBootDelay || 30000;

    log("info", "Starting Tuya Platform plugin");

    if (!options.accessId || !options.accessKey) {
      log("error", "Access ID and Access Secret are required.");
      return;
    }

    if (!options.projectType) {
      log("error", "Project type is required.");
      return;
    }

    if (options.projectType === "2") {
      if (!options.countryCode) {
        log("error", "Smart Home: countryCode is required.");
        return;
      }
      if (!options.username) {
        log("error", "Smart Home: username is required.");
        return;
      }
      if (!options.password) {
        log("error", "Smart Home: password is required.");
        return;
      }
    }

    if (!validateConfig(options, log)) {
      log("error", "Configuration validation failed.");
      return;
    }

    const mode = options.mode || "cloud";

    let dm = null;
    let uid = null;
    let debugMode = false;

    try {
      if (mode === "local") {
        const localDM = new TuyaLocalDeviceManager(
          options.local || {},
          options.debugLevel?.includes("local"),
        );
        await localDM.pullDevices();
        dm = localDM;
        uid = "local";
        debugMode = !!(
          options.debug &&
          (options.debugLevel || "").includes("local")
        );
      } else {
        let result = null;
        if (options.projectType === "1") {
          result = await initCustomProject(api, options, log);
        } else if (options.projectType === "2") {
          result = await initHomeProject(api, options, log);
        } else {
          log("error", `Unsupported projectType: ${options.projectType}`);
          return;
        }
        if (!result || !result.dm) {
          initRetryAttempts += 1;
          const delay = nextInitRetryDelay();
          log(
            "error",
            `Failed to initialize Tuya connection. Will retry in ${Math.round(delay / 1000)}s.`,
          );
          ctx._initRetryTimer = setTimeout(
            () => module.exports.start(cfg, api),
            delay,
          );
          return;
        }
        dm = result.dm;
        uid = result.uid;
        debugMode = result.debugMode;

        if (mode === "both") {
          const localConfig = options.local || {};
          const localDM = new TuyaLocalDeviceManager(localConfig, debugMode);
          await localDM.pullDevices();
          for (const cloudDev of dm.devices) {
            const localDev = localDM.getDevice(cloudDev.id);
            if (localDev && cloudDev.local_key) {
              localDev.localKey = cloudDev.local_key;
            }
          }
          localDM.connectAllDevices();
          dm = new TuyaHybridDeviceManager(dm, localDM, debugMode);
        }
      }
    } catch (e) {
      initRetryAttempts += 1;
      const delay = nextInitRetryDelay();
      log(
        "warn",
        `Initialization failed: ${e.message}. Will retry in ${Math.round(delay / 1000)}s.`,
      );
      ctx._initRetryTimer = setTimeout(
        () => module.exports.start(cfg, api),
        delay,
      );
      return;
    }

    initRetryAttempts = 0;
    ctx.deviceManager = dm;

    if (mode !== "local") {
      await dm.updateInfraredRemotes(dm.devices);

      await persistDeviceList(api, dm, uid, log);

      for (const device of dm.devices) {
        if (
          ["sp", "doorbell", "mobilecam", "wxml"].includes(
            device.category,
          ) &&
          !device.local_key
        ) {
          const info = await dm.getDeviceInfo(device.id);
          if (info.success && info.result && info.result.local_key) {
            device.local_key = info.result.local_key;
            log(
              "info",
              `Fetched local_key for camera device "${device.name}"`,
            );
          } else {
            log(
              "warn",
              `No local_key for camera device "${device.name}" (api success=${info.success})`,
            );
          }
        }
      }
    }

    await registerDevicesWithDoimus(api, dm, options, ctx, log);

    if (options.p2pAutoStart) {
      for (const device of dm.devices) {
        if (
          ["sp", "doorbell", "mobilecam", "wxml"].includes(
            device.category,
          ) &&
          device.local_key
        ) {
          const doimusID = ctx.doimusDeviceMap.get(device.id);
          if (doimusID) {
            log("info", `Auto-starting P2P for camera "${device.name}"`);
            startP2P(doimusID, device, ctx, log, api).catch((e) =>
              log("debug", `[WebRTC] P2P start failed: ${e.message}`),
            );
          }
        }
      }
    }

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
      const runEnergyPoll = async () => {
        if (!this._ctx) return;
        // If the API token is dead (e.g. account used elsewhere and re-auth
        // failed), don't hammer the API every poll cycle. Back off until a
        // fresh login restores auth.
        if (dm.api && dm.api.isAuthHealthy && !dm.api.isAuthHealthy()) {
          ctx._energyPollTimer = setTimeout(
            runEnergyPoll,
            Math.max(5000, options.energyPollInterval || 30000),
          );
          return;
        }
        for (const device of energyPollDevices) {
          try {
            const res = await dm.getDeviceInfo(device.id);
            if (!res.success || !res.result) {
              log(
                "debug",
                `Energy poll: ${device.name} → API returned error`,
              );
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

            for (const item of device.status) {
              const match = status.find((s) => s.code === item.code);
              if (match) item.value = match.value;
            }

            const state = mapTuyaStatusToDoimusState(
              device,
              status,
              options,
            );
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
              const lastKnown =
                ctx.lastKnownState.get(device.id) || {};
              const changed = Object.keys(state).some(
                (k) =>
                  JSON.stringify(state[k]) !==
                  JSON.stringify(lastKnown[k]),
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
            log(
              "warn",
              `Energy poll error for ${device.name}: ${e.message}`,
            );
          }
        }
        ctx._energyPollTimer = setTimeout(
          runEnergyPoll,
          Math.max(5000, options.energyPollInterval || 30000),
        );
      };
      ctx._energyPollTimer = setTimeout(
        runEnergyPoll,
        Math.max(5000, options.energyPollInterval || 30000),
      );
    }

    const cameraDevices = dm.devices.filter((d) =>
      ["sp", "mobilecam", "wxml", "doorbell"].includes(d.category),
    );
    if (cameraDevices.length > 0) {
      log(
        "info",
        `Camera snapshot capture is event-driven (MQTT motion triggers). ${cameraDevices.length} camera(s): ${cameraDevices.map((d) => `"${d.name}" (id=${d.id})`).join(", ")}`,
      );
    }
    ctx._snapshotTimer = null;

    api.onCommand(async (deviceID, key, value) => {
      if (key === "webrtc" && value && typeof value === "object") {
        const tuyaDevice = dm.getDevice(
          ctx.doimusDeviceMap.get(deviceID),
        );
        if (!tuyaDevice) return;
        return handleWebRTCCommand(
          deviceID,
          value,
          tuyaDevice,
          ctx,
          dm,
          api,
          log,
        );
      }

      const tuyaID = ctx.doimusDeviceMap.get(deviceID);
      if (!tuyaID) {
        log(
          "warn",
          `onCommand: no Tuya device mapped for doimusID="${deviceID}" (key=${key}). Map has ${ctx.doimusDeviceMap.size} entries.`,
        );
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

        if (
          tuyaDevice.isIRRemoteControl &&
          tuyaDevice.isIRRemoteControl()
        ) {
          return handleIRCommand(
            deviceID,
            key,
            value,
            tuyaDevice,
            ctx,
            dm,
            api,
            log,
          );
        }

        if (
          tuyaDevice.category === "scene" &&
          key === "on" &&
          value === true
        ) {
          const homeID = tuyaDevice.owner_id
            ? Number(tuyaDevice.owner_id)
            : null;
          if (homeID && typeof dm.executeScene === "function") {
            await dm.executeScene(homeID, tuyaDevice.id);
            api.updateDeviceState(deviceID, { on: true });
            ctx.lastKnownState.set(tuyaDevice.id, {
              ...ctx.lastKnownState.get(tuyaDevice.id),
              on: true,
            });
            setTimeout(() => {
              api.updateDeviceState(deviceID, { on: false });
              ctx.lastKnownState.set(tuyaDevice.id, {
                ...ctx.lastKnownState.get(tuyaDevice.id),
                on: false,
              });
            }, 3000);
          }
          return;
        }

        const commands = buildDeviceCommands(
          key,
          value,
          tuyaDevice,
          deviceID,
          log,
        );
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
            // Late wake confirmation — the camera just came awake, so the
            // cloud REST snapshot now has a real chance of succeeding. Retry
            // it instead of dropping the event.
            log(
              "debug",
              `Wake confirmed but no watcher found for "${device.name}" — retrying REST snapshot after late wake`,
            );
            if (
              ["sp", "doorbell", "mobilecam", "wxml"].includes(
                device.category,
              )
            ) {
              scheduleRestSnapshot(
                device,
                doimusID,
                dm,
                ctx,
                api,
                log,
                1500,
              );
            }
          }
        }

        const state = mapTuyaStatusToDoimusState(
          device,
          status,
          options,
        );
        log(
          "info",
          `DEVICE_STATUS_UPDATE: ${device.name} → stateKeys=[${Object.keys(state).join(",")}]`,
        );
        log(
          "debug",
          `DEVICE_STATUS_UPDATE full: ${device.name} → ${JSON.stringify(state).slice(0, 500)}`,
        );
        let motionActivated = false;
        if (Object.keys(state).length > 0) {
          state.online = device.online;
          const lastKnown = ctx.lastKnownState.get(device.id) || {};

          if (!ctx._firstUpdateSeen)
            ctx._firstUpdateSeen = new Set();
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
          motionActivated =
            state.motion === true && !lastKnown.motion;

          if (motionActivated) {
            delete state.motion;
          }

          const changed = Object.keys(state).some(
            (k) =>
              JSON.stringify(state[k]) !==
              JSON.stringify(lastKnown[k]),
          );
          if (changed) {
            api.updateDeviceState(doimusID, state);
          }
          ctx.lastKnownState.set(device.id, {
            ...lastKnown,
            ...state,
            ...(motionActivated ? { motion: true } : {}),
          });

          if (motionActivated) {
            if (!ctx._motionTimers)
              ctx._motionTimers = new Map();
            const existing = ctx._motionTimers.get(device.id);
            if (existing) clearTimeout(existing);
            ctx._motionTimers.set(
              device.id,
              setTimeout(() => {
                const current =
                  ctx.lastKnownState.get(device.id);
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
                  if (Array.isArray(device.status)) {
                    for (const dp of device.status) {
                      if (MOTION_DP_PATTERN.test(dp.code)) {
                        dp.value = "";
                      }
                    }
                  }
                }
                ctx._motionTimers.delete(device.id);
              }, 5000),
            );
          }
          if (state.motion === false && ctx._motionTimers) {
            const pending = ctx._motionTimers.get(device.id);
            if (pending) {
              clearTimeout(pending);
              ctx._motionTimers.delete(device.id);
            }
          }
        }

        const hasMotionSignalInPacket = (status || []).some(
          (s) => {
            if (!s || typeof s.code !== "string") return false;
            const code = s.code;
            const value = s.value;
            const active =
              typeof value === "string"
                ? value.length > 0
                : !!value;
            if (!active) return false;
            return (
              code === "movement_detect_pic" ||
              code === "doorbell_pic" ||
              code === "ipc_human" ||
              code === "initiative_message" ||
              /motion|movement|doorbell|human|person|pir/i.test(
                code,
              )
            );
          },
        );
        const shouldCaptureMotionImage =
          motionActivated ||
          state.motion === true ||
          hasMotionSignalInPacket;

        if (
          ["sp", "doorbell", "mobilecam", "wxml"].includes(
            device.category,
          ) &&
          shouldCaptureMotionImage
        ) {
          startMotionCoalesce(
            device,
            status,
            doimusID,
            ctx,
            dm,
            api,
            log,
          );
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

      if (prevOnline !== undefined && prevOnline !== device.online) {
        log(
          "info",
          `Camera "${device.name}" online transition: ${prevOnline} → ${device.online}`,
        );
      }

      if (device.online === false && Array.isArray(device.status)) {
        for (const dp of device.status) {
          if (MOTION_DP_PATTERN.test(dp.code)) {
            dp.value = "";
          }
        }
      }

      if (
        device.online === true &&
        prevOnline === false &&
        ["sp", "doorbell", "mobilecam", "wxml"].includes(
          device.category,
        ) &&
        device.id
      ) {
        log(
          "info",
          `Camera "${device.name}" came online — scheduling REST snapshot fallback in 4s`,
        );
        scheduleRestSnapshot(device, doimusID, dm, ctx, api, log, 4000);
      }

      api.updateDeviceState(doimusID, state);
      ctx.lastKnownState.set(device.id, {
        ...ctx.lastKnownState.get(device.id),
        ...state,
      });
    });

    dm.on(TuyaDeviceManager.Events.DEVICE_ADD, async (device) => {
      if (device.isIRControlHub && device.isIRControlHub()) return;
      log("info", `New device added: ${device.name}`);
      const options2 = (cfg && cfg.options) || {};
      device.schema = await dm.getDeviceSchema(device.id, device);
      if (
        ["sp", "doorbell", "mobilecam", "wxml"].includes(
          device.category,
        ) &&
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
        initialState.min_target_temp =
          tempSetSchema.property.min / scale;
        initialState.max_target_temp =
          tempSetSchema.property.max / scale;
      }

      api.registerDevice({
        id: doimusID,
        name: device.name,
        type: type,
        capabilities: capabilities,
        state: initialState,
        metadata: buildUiDescriptor(type, capabilities),
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
      if (ctx.deviceManager) {
        if (ctx.deviceManager.mq) {
          try {
            ctx.deviceManager.mq.stop();
          } catch (_) { /* cleanup */ }
        }
        if (ctx.deviceManager.stopLocalDevices) {
          try {
            ctx.deviceManager.stopLocalDevices();
          } catch (_) { /* cleanup */ }
        }
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
          } catch (_) { /* cleanup */ }
        }
        ctx.p2pClients.clear();
      }
      if (ctx._streamAllocProcs) {
        for (const [, proc] of ctx._streamAllocProcs) {
          try {
            proc.kill("SIGTERM");
          } catch (_) { /* cleanup */ }
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
      if (ctx._webrtcClients) {
        for (const [, wr] of ctx._webrtcClients) {
          try {
            wr.close();
          } catch (_) { /* cleanup */ }
        }
        ctx._webrtcClients.clear();
      }
      if (ctx._wakeWatchers) {
        for (const [, watcher] of ctx._wakeWatchers) {
          clearTimeout(watcher.timer);
          clearInterval(watcher.progressInterval);
          if (watcher.resolve) watcher.resolve();
        }
        ctx._wakeWatchers.clear();
      }
      if (ctx._streamFallbackTimers) {
        for (const [, timer] of ctx._streamFallbackTimers) {
          clearTimeout(timer);
        }
        ctx._streamFallbackTimers.clear();
      }
      if (ctx._powerModeChanged) {
        ctx._powerModeChanged.clear();
      }
      if (ctx._firstUpdateSeen) {
        ctx._firstUpdateSeen.clear();
      }
      ctx.apiRef = null;
      this._ctx = null;
    }
  },
};
