const WebRTCSignaling = require("../camera/WebRTCSignaling");
const {
  applySchemaOverride,
  mapTuyaStatusToDoimusState,
  determineCapabilities,
  getDoimusType,
} = require("./state-mapper");
const { buildDeviceCommands, sendCommandsDebounced } = require("./command-builder");
const { startStreamAllocation } = require("../camera/camera-streaming");
const { cloudWakeBatteryCamera } = require("../camera/wake");
const { MOTION_DP_PATTERN, generateUUID } = require("./plugin-utils");

// Declarative UI descriptor — rendered generically by the mobile app.
// Built from the registered capabilities so each device only surfaces rows
// it can actually serve. Returns undefined for devices whose built-in UI
// (lights, plain switches, simple sensors) is already a good fit.
function buildUiDescriptor(type, capabilities) {
  // capabilities arrives as an array (from determineCapabilities); accept a
  // Set too for robustness.
  const has = (key) =>
    capabilities instanceof Set
      ? capabilities.has(key)
      : (capabilities || []).includes(key);
  const rows = [];
  let title = "Device";

  switch (type) {
    case "thermostat":
      title = "Thermostat";
      if (has("on")) rows.push({ type: "toggle", key: "on", label: "On/Off" });
      if (has("target_temp")) {
        rows.push({
          type: "stepper",
          key: "target_temp",
          label: "Target temperature",
          min_key: "min_target_temp",
          max_key: "max_target_temp",
          step: 0.5,
          unit: "celsius",
        });
      }
      if (has("temperature")) {
        rows.push({
          type: "value",
          key: "temperature",
          label: "Current temperature",
          unit: "celsius",
        });
      }
      if (has("humidity")) {
        rows.push({
          type: "value",
          key: "humidity",
          label: "Humidity",
          format: "percent",
        });
      }
      if (has("heating_mode")) {
        rows.push({
          type: "segment",
          key: "heating_mode",
          label: "Mode",
          options: [
            { value: 0, label: "Off" },
            { value: 1, label: "Heat" },
            { value: 2, label: "Cool" },
            { value: 3, label: "Auto" },
          ],
        });
      }
      if (has("eco_mode")) rows.push({ type: "toggle", key: "eco_mode", label: "Eco" });
      if (has("frost_protection")) {
        rows.push({ type: "toggle", key: "frost_protection", label: "Frost protection" });
      }
      if (has("child_lock")) rows.push({ type: "toggle", key: "child_lock", label: "Child lock" });
      break;

    case "fan":
      title = "Fan";
      if (has("on")) rows.push({ type: "toggle", key: "on", label: "On/Off" });
      if (has("rotation_speed")) {
        rows.push({
          type: "slider",
          key: "rotation_speed",
          label: "Fan speed",
          min: 0,
          max: 100,
          step: 10,
          unit: "%",
        });
      }
      if (has("swing")) rows.push({ type: "toggle", key: "swing", label: "Swing" });
      if (has("anion")) rows.push({ type: "toggle", key: "anion", label: "Ionizer" });
      break;

    case "blind":
      title = "Blind";
      if (has("position")) {
        rows.push({
          type: "slider",
          key: "position",
          label: "Position",
          min: 0,
          max: 100,
          step: 1,
          unit: "%",
        });
      }
      if (has("control")) {
        rows.push({
          type: "segment",
          key: "control",
          label: "Control",
          options: [
            { value: "open", label: "Open" },
            { value: "stop", label: "Stop" },
            { value: "close", label: "Close" },
          ],
        });
      } else if (has("position")) {
        // Position-only blinds: drive open/close through the position DP.
        rows.push({
          type: "segment",
          key: "position",
          label: "Control",
          options: [
            { value: 100, label: "Open" },
            { value: 0, label: "Close" },
          ],
        });
      }
      break;

    case "camera":
    case "doorbell":
      title = "Camera";
      rows.push({ type: "button", key: "p2p_start", label: "Live view" });
      if (has("privacy_mode")) rows.push({ type: "toggle", key: "privacy_mode", label: "Privacy mode" });
      if (has("night_vision")) rows.push({ type: "toggle", key: "night_vision", label: "Night vision" });
      if (has("floodlight")) rows.push({ type: "toggle", key: "floodlight", label: "Floodlight" });
      if (has("siren")) rows.push({ type: "toggle", key: "siren", label: "Siren" });
      if (has("recording")) rows.push({ type: "toggle", key: "recording", label: "Recording" });
      break;

    case "outlet":
    case "switch":
      if (has("power") || has("voltage") || has("current") || has("energy")) {
        title = "Energy";
        if (has("on")) rows.push({ type: "toggle", key: "on", label: "On/Off" });
        if (has("power")) rows.push({ type: "value", key: "power", label: "Power", unit: "W" });
        if (has("voltage")) rows.push({ type: "value", key: "voltage", label: "Voltage", unit: "V" });
        if (has("current")) rows.push({ type: "value", key: "current", label: "Current", unit: "A" });
        if (has("energy")) rows.push({ type: "value", key: "energy", label: "Energy", unit: "kWh" });
      }
      break;

    case "sensor": {
      const extras = [
        ["pm25", "PM2.5", "µg/m³"],
        ["pm10", "PM10", "µg/m³"],
        ["pm1", "PM1", "µg/m³"],
        ["co2", "CO₂", "ppm"],
        ["tvoc", "TVOC", "ppb"],
        ["formaldehyde", "Formaldehyde", "mg/m³"],
        ["air_quality", "Air quality", ""],
        ["uv_index", "UV index", ""],
        ["illuminance", "Illuminance", "lux"],
        ["noise", "Noise", "dB"],
        ["pressure", "Pressure", "hPa"],
        ["windspeed", "Wind speed", "m/s"],
        ["wind_direction", "Wind direction", ""],
        ["rainfall", "Rainfall", "mm"],
        ["soil_moisture", "Soil moisture", "%"],
        ["soil_temperature", "Soil temperature", "°C"],
      ].filter(([key]) => has(key));

      if (extras.length > 0) {
        title = "Air quality";
        if (has("temperature")) {
          rows.push({ type: "value", key: "temperature", label: "Temperature", unit: "celsius" });
        }
        if (has("humidity")) {
          rows.push({ type: "value", key: "humidity", label: "Humidity", format: "percent" });
        }
        for (const [key, label, unit] of extras) {
          rows.push({ type: "value", key, label, unit });
        }
      }
      break;
    }
  }

  if (rows.length === 0) return undefined;
  return { ui: { sections: [{ title, rows }] } };
}

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
      metadata: buildUiDescriptor(type, capabilities),
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
      `[WebRTC] START device="${tuyaDevice.name}" id=${tuyaDevice.id} category=${tuyaDevice.category} online=${tuyaDevice.online} ip=${tuyaDevice.ip || tuyaDevice.ip_address || "?"} localKeyLen=${(tuyaDevice.local_key || "").length}`,
    );
    const existing = ctx._webrtcClients.get(deviceID);
    if (existing) {
      try {
        existing.disconnect();
      } catch (_) {}
      ctx._webrtcClients.delete(deviceID);
    }

    const wr = new WebRTCSignaling(dm.api, log);
    ctx._webrtcClients.set(deviceID, wr);

    // Supplement the MQTT wake with the app's cloud-delivered wake (best-effort).
    cloudWakeBatteryCamera(tuyaDevice, ctx, log).catch((e) =>
      log("debug", `[WebRTC] cloud wake failed: ${e.message || e}`),
    );

    // The stream-allocation API call is what triggers the cloud push that
    // actually wakes battery cameras (per the Smart Life app analysis). Fire it
    // in parallel — if the camera is a battery peephole, this is the wake.
    if (
      ["sp", "doorbell", "mobilecam", "wxml"].includes(tuyaDevice.category)
    ) {
      startStreamAllocation(deviceID, tuyaDevice, ctx, log, api).catch((e) =>
        log("debug", `[StreamAlloc] Failed: ${e.message || e}`),
      );
    }

    wr.on("config", (cfg) => {
      api.sendWebrtcSignaling(deviceID, { event: "config", ...cfg });
    });
    wr.on("answer", (d) => {
      api.sendWebrtcSignaling(deviceID, { event: "answer", ...d });
      try {
        wr.sendResolution(0);
      } catch (_) {}
    });
    wr.on("candidate", (d) => {
      api.sendWebrtcSignaling(deviceID, { event: "candidate", ...d });
    });
    wr.on("disconnect", (d) => {
      api.sendWebrtcSignaling(deviceID, { event: "disconnect", ...d });
    });
    wr.on("error", (e) => {
      api.sendWebrtcSignaling(deviceID, {
        event: "error",
        message: e.message || String(e),
      });
    });

    try {
      await wr.start(tuyaDevice.id, tuyaDevice.local_key, ctx._options);
    } catch (e) {
      log("warn", `[WebRTC] Start failed: ${e.message || e}`);
      api.sendWebrtcSignaling(deviceID, {
        event: "error",
        message: e.message || "WebRTC start failed",
      });
      ctx._webrtcClients.delete(deviceID);
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
  } else if (value.event === "candidate") {
    wr.sendCandidate(value.candidate);
  } else if (value.event === "disconnect") {
    wr.sendDisconnect();
    wr.disconnect();
    ctx._webrtcClients.delete(deviceID);
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
  buildUiDescriptor,
  handleWebRTCCommand,
  handleIRCommand,
};
