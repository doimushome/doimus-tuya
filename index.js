const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const debounce = require("debounce");

const TuyaOpenAPI = require("./core/TuyaOpenAPI");
const TuyaCustomDeviceManager = require("./device/TuyaCustomDeviceManager");
const TuyaHomeDeviceManager = require("./device/TuyaHomeDeviceManager");
const TuyaDeviceManager = require("./device/TuyaDeviceManager");
const TuyaP2P = require("./core/TuyaP2P");

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

const CATEGORY_TO_DOIMUS_TYPE = {
  dj: "light",
  dsd: "light",
  xdd: "light",
  fwd: "light",
  dc: "light",
  dd: "light",
  gyd: "light",
  tyndj: "light",
  sxd: "light",
  tgq: "light",
  tgkg: "light",
  dlq: "switch",
  kg: "switch",
  tdq: "switch",
  qjdcz: "switch",
  szjqr: "switch",
  cz: "outlet",
  pc: "outlet",
  wkcz: "outlet",
  wxkg: "switch",
  cjkg: "switch",
  bzyd: "light",
  kt: "switch",
  ktkzq: "switch",
  qtwk: "switch",
  qn: "thermostat",
  kj: "fan",
  xxj: "switch",
  ckmkzq: "switch",
  cl: "blind",
  clkg: "blind",
  mc: "blind",
  wk: "thermostat",
  wkf: "thermostat",
  ggq: "switch",
  sfkzq: "switch",
  jsq: "switch",
  cs: "switch",
  fs: "fan",
  fsd: "fan",
  fskg: "fan",
  yyj: "switch",
  sp: "camera",
  mobilecam: "camera",
  ywbj: "sensor",
  mcs: "sensor",
  zd: "sensor",
  rqbj: "sensor",
  jwbj: "sensor",
  sj: "sensor",
  cobj: "sensor",
  cocgq: "sensor",
  co2bj: "sensor",
  co2cgq: "sensor",
  wsdcg: "sensor",
  ldcg: "sensor",
  ldzd: "sensor",
  tx: "sensor",
  hps: "sensor",
  pir: "sensor",
  mh: "sensor",
  pm: "sensor",
  pm25: "sensor",
  dyl: "sensor",
  sf: "sensor",
  cw: "sensor",
  mk: "lock",
  ms: "lock",
  sgbj: "sensor",
  sos: "sensor",
  doorbell: "doorbell",
  wxml: "doorbell",
  wxky: "switch",
  cwwsq: "switch",
  msp: "switch",
  mal: "sensor",
  hjjcy: "sensor",
};

function applySchemaOverride(device, options) {
  if (!options.deviceOverrides) return;
  const deviceConfig = options.deviceOverrides.find(
    (c) =>
      c.id === device.id ||
      c.id === device.uuid ||
      c.id === device.product_id ||
      c.id === "global",
  );
  if (!deviceConfig || !deviceConfig.schema) return;

  for (const override of deviceConfig.schema) {
    const existing = device.schema.find((s) => s.code === override.code);
    if (!existing) continue;

    if (override.hidden) {
      device.schema = device.schema.filter((s) => s.code !== override.code);
      device.status = device.status.filter((s) => s.code !== override.code);
      continue;
    }

    if (override.newCode) {
      const oldCode = override.code;
      existing.code = override.newCode;
      const statusItem = device.status.find((s) => s.code === oldCode);
      if (statusItem) statusItem.code = override.newCode;
    }

    if (override.type) {
      existing.type = override.type;
    }

    if (override.property) {
      existing.property = { ...existing.property, ...override.property };
    }
  }
}

function tuyaTempToKelvin(tuyaValue, schemaProp) {
  const min = schemaProp?.min ?? 0;
  const max = schemaProp?.max ?? 1000;
  const scale = schemaProp?.scale != null ? Math.pow(10, schemaProp.scale) : 1;
  const tuyaMin = min / scale;
  const tuyaMax = max / scale;
  const t = Math.max(tuyaMin, Math.min(tuyaMax, Number(tuyaValue)));
  const normalized = (t - tuyaMin) / (tuyaMax - tuyaMin);
  return Math.round(2700 + normalized * (6500 - 2700));
}

function kelvinToTuyaTemp(kelvin, schemaProp) {
  const min = schemaProp?.min ?? 0;
  const max = schemaProp?.max ?? 1000;
  const scale = schemaProp?.scale != null ? Math.pow(10, schemaProp.scale) : 1;
  const tuyaMin = min / scale;
  const tuyaMax = max / scale;
  const normalized = (kelvin - 2700) / (6500 - 2700);
  return Math.round(
    tuyaMin + Math.max(0, Math.min(1, normalized)) * (tuyaMax - tuyaMin),
  );
}

function getScale(device, code) {
  const s = device.schema?.find((s) => s.code === code);
  return s?.property?.scale != null ? Math.pow(10, s.property.scale) : 1;
}

function mapTuyaStatusToDoimusState(device, statusList, options) {
  const state = {};
  const schemaDeviceConfig =
    options && options.deviceOverrides
      ? options.deviceOverrides.find(
          (c) =>
            c.id === device.id ||
            c.id === device.uuid ||
            c.id === device.product_id ||
            c.id === "global",
        )
      : undefined;

  for (const s of statusList || []) {
    let code = s.code;
    let value = s.value;

    if (schemaDeviceConfig && schemaDeviceConfig.schema) {
      const schemaOverride = schemaDeviceConfig.schema.find(
        (o) => o.code === code,
      );
      if (schemaOverride) {
        if (schemaOverride.hidden) continue;
        if (schemaOverride.newCode) code = schemaOverride.newCode;
        if (schemaOverride.onGet) {
          try {
            const fn = new Function(
              "device",
              "value",
              `"use strict"; return (${schemaOverride.onGet})`,
            );
            value = fn(device, value);
          } catch (_) {}
        }
      }
    }

    if (code === "switch" || code === "switch_1") {
      state.on =
        value === true || value === "true" || value === 1 || value === "1";
    } else if (
      code === "bright_value" ||
      code === "bright_value_v2" ||
      code === "bright_value_1"
    ) {
      // Tuya bright_value is 0–1000; normalise to 0–100 for Doimus
      state.brightness = Math.min(
        100,
        Math.max(0, Math.round((Number(value) / 1000) * 100)),
      );
      state._brightValue = Number(value);
    } else if (code === "temp_value" || code === "temp_value_v2") {
      const tempSchema = device.schema?.find((s) => s.code === code);
      state.color_temp = tuyaTempToKelvin(value, tempSchema?.property);
    } else if (code === "colour_data" || code === "colour_data_v2") {
      if (typeof value === "object" && value !== null) {
        if (value.hue !== undefined) state.hue = Number(value.hue);
        if (value.saturation !== undefined)
          state.saturation = Number(value.saturation);
        if (value.value !== undefined) {
          const scaled = Math.round((Number(value.value) / 1000) * 100);
          state.brightness = Math.min(100, Math.max(0, scaled));
        }
        state._colourData = value;
      }
    } else if (code === "fan_speed" || code === "fan_speed_percent") {
      state.rotation_speed = Number(value);
    } else if (code === "wind_speed") {
      state.rotation_speed = Number(value);
    } else if (
      code === "lock_state" ||
      code === "lock_sta" ||
      code === "lock_motor_state"
    ) {
      state.locked =
        value === "locked" || value === true || value === 1 || value === "1";
    } else if (code === "doorbell_state" || code === "doorcontact") {
      state.doorbell = value === true || value === "true" || value === 1;
    } else if (code === "contact_state" || code === "doorcontact_state") {
      state.contact =
        value === "open" || value === true || value === 1 || value === "1";
    } else if (code === "va_temperature") {
      state.temperature = Number(value);
    } else if (code === "va_humidity") {
      state.humidity = Number(value);
    } else if (code === "temp_current" || code === "temperature") {
      state.temperature = Number(value);
    } else if (code === "humidity" || code === "humidity_value") {
      state.humidity = Number(value);
    } else if (code === "temp_set" || code === "target_temp") {
      state.target_temp = Number(value);
    } else if (code === "switch_fan" || code === "fan_switch") {
      if (state.on === undefined) state.on = value === true || value === 1;
    } else if (code === "pir" || code === "motion_sensor") {
      state.motion = value === true || value === "pir" || value === 1;
    } else if (code === "smoke_sensor" || code === "smoke_sensor_status") {
      state.smoke = value === true || value === 1 || value === "alarm";
    } else if (code === "gas_sensor" || code === "co_gas_sensor") {
      state.gas = value === true || value === 1 || value === "alarm";
    } else if (code === "battery_percentage" || code === "battery_state") {
      state.battery = Number(value);
    } else if (code === "battery_value") {
      // Some Tuya sensors/cameras use battery_value (0-100)
      state.battery = Number(value);
    } else if (
      code === "battery_low" ||
      code === "low_battery" ||
      code === "battery_alarm"
    ) {
      state.battery_low =
        value === true || value === 1 || value === "low" || value === "alarm";
    } else if (
      code === "water_sensor" ||
      code === "water_leak" ||
      code === "flood" ||
      code === "ws" ||
      code === "leak"
    ) {
      state.leak =
        value === true || value === 1 || value === "alarm" || value === "leak";
    } else if (
      code === "presence_state" ||
      code === "occupancy" ||
      code === "human"
    ) {
      state.occupancy =
        value === true ||
        value === 1 ||
        value === "presence" ||
        value === "occupied" ||
        value === "human";
    } else if (
      code === "load_status" ||
      code === "outlet_in_use" ||
      code === "usb_state"
    ) {
      state.outlet_in_use = value === true || value === 1 || value === "1";
    } else if (code === "movement_detect_pic" || code === "ipc_human") {
      // Camera PIR/human detection — set motion state for automations.
      // The jpeg itself is captured and sent via sendMjpegFrame separately.
      state.motion = typeof value === "string" && value.length > 0;
    } else if (code === "doorbell_pic") {
      // Doorbell button press — set doorbell state for automations.
      state.doorbell = typeof value === "string" && value.length > 0;
    } else if (
      code === "percent_control" ||
      code === "control_back" ||
      code === "position"
    ) {
      state.position = Number(value);
    } else if (code === "work_state" || code === "mode") {
      state.mode = String(value);
      // Also map numeric mode values to heating_mode where applicable.
      // Tuya thermostats encode mode as 0=off, 1=auto, 2=cool, 3=heat
      // (ordering varies — we detect by checking for known strings first).
      if (typeof value === "number" && Number.isFinite(value)) {
        state.heating_mode = Number(value);
      } else if (typeof value === "string") {
        const modeMap = {
          auto: 3,
          heat: 1,
          hot: 1,
          warm: 1,
          cool: 2,
          cold: 2,
          off: 0,
        };
        const mapped = modeMap[value.toLowerCase()];
        if (mapped !== undefined) {
          state.heating_mode = mapped;
        }
      }
    } else if (code === "work_mode" || code === "hvac_mode") {
      state.mode = String(value);
      if (typeof value === "number" && Number.isFinite(value)) {
        state.heating_mode = Number(value);
      }
    } else if (code === "switch_hvac") {
      // HVAC master switch — maps to on state
      state.on = value === true || value === 1;
    } else if (code === "heat_state" || code === "heater") {
      state.heating_state = value === true || value === 1 ? 1 : 0;
      // Also set heating boolean for direct heating indicator
      state.heating = value === true || value === 1;
    } else if (code === "cool_state" || code === "cooler") {
      state.heating_state = value === true || value === 1 ? 2 : 0;
      state.cooling = value === true || value === 1;
    } else if (code === "child_lock") {
      state.child_lock = value === true || value === 1;
    } else if (code === "light") {
      if (state.on === undefined) state.on = value === true || value === 1;
    } else if (code === "cur_current") {
      state.current = Number(value) / getScale(device, code);
    } else if (code === "cur_power") {
      state.power = Number(value) / getScale(device, code);
    } else if (code === "cur_voltage") {
      state.voltage = Number(value) / getScale(device, code);
    } else if (code === "meter_power" || code === "total_forward_energy") {
      state.energy = Number(value);
    } else if (code === "electricity") {
      state.current = Number(value);
    } else if (code === "percent_state") {
      state.position = Number(value);
    } else if (code === "countdown" || code === "count_down") {
      state.countdown = Number(value);
    }
  }

  if (device.online !== undefined) {
    state.online = device.online;
  }

  return state;
}

function determineCapabilities(device) {
  const doimusType = CATEGORY_TO_DOIMUS_TYPE[device.category] || "switch";
  const capabilities = new Set();

  capabilities.add("on");

  switch (doimusType) {
    case "light":
      if (
        device.schema &&
        device.schema.some((s) => s.code.startsWith("bright"))
      ) {
        capabilities.add("brightness");
      }
      if (
        device.schema &&
        device.schema.some((s) => s.code.startsWith("temp_value"))
      ) {
        capabilities.add("color_temp");
      }
      if (
        device.schema &&
        device.schema.some((s) => s.code.startsWith("colour_data"))
      ) {
        capabilities.add("hue");
        capabilities.add("saturation");
        capabilities.add("brightness");
      }
      break;
    case "fan":
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code.startsWith("fan_speed") || s.code.startsWith("wind_speed"),
        )
      ) {
        capabilities.add("rotation_speed");
      }
      break;
    case "blind":
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code.startsWith("percent") ||
            s.code === "control_back" ||
            s.code === "position",
        )
      ) {
        capabilities.add("position");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "control" || s.code === "control_back",
        )
      ) {
        capabilities.add("control");
      }
      break;
    case "lock":
      if (
        device.schema &&
        device.schema.some((s) => s.code.startsWith("lock"))
      ) {
        capabilities.add("locked");
      }
      break;
    case "thermostat":
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code.startsWith("temp_set") || s.code === "target_temp",
        )
      ) {
        capabilities.add("target_temp");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code.startsWith("temp_current") ||
            s.code === "temperature" ||
            s.code === "va_temperature",
        )
      ) {
        capabilities.add("temperature");
      }
      // HVAC mode control (heat/cool/auto/off)
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "mode" ||
            s.code === "work_mode" ||
            s.code === "hvac_mode" ||
            s.code === "switch_hvac",
        )
      ) {
        capabilities.add("heating_mode");
      }
      // Current heating/cooling state (derived from mode or separate DP)
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "heat_state" ||
            s.code === "heater" ||
            s.code === "cool_state" ||
            s.code === "cooler" ||
            s.code === "work_state",
        )
      ) {
        capabilities.add("heating_state");
      }
      break;
    case "sensor":
      capabilities.delete("on");
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code.startsWith("va_temperature") ||
            s.code === "temperature" ||
            s.code === "temp_current",
        )
      ) {
        capabilities.add("temperature");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code.startsWith("va_humidity") ||
            s.code === "humidity" ||
            s.code === "humidity_value",
        )
      ) {
        capabilities.add("humidity");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "pir" || s.code === "motion_sensor",
        )
      ) {
        capabilities.add("motion");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "contact_state" || s.code === "doorcontact_state",
        )
      ) {
        capabilities.add("contact");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code.startsWith("battery") || s.code === "va_battery",
        )
      ) {
        capabilities.add("battery");
      }
      if (
        device.schema &&
        device.schema.some((s) => s.code.startsWith("smoke"))
      ) {
        capabilities.add("smoke");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code.startsWith("gas") || s.code === "co_gas_sensor",
        )
      ) {
        capabilities.add("gas");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "water_sensor" ||
            s.code === "water_leak" ||
            s.code === "flood" ||
            s.code === "ws" ||
            s.code === "leak",
        )
      ) {
        capabilities.add("leak");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "presence_state" ||
            s.code === "occupancy" ||
            s.code === "human",
        )
      ) {
        capabilities.add("occupancy");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "battery_low" ||
            s.code === "low_battery" ||
            s.code === "battery_alarm",
        )
      ) {
        capabilities.add("battery_low");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "tamper" ||
            s.code === "tamper_state" ||
            s.code === "tamper_alarm" ||
            s.code === "sos" ||
            s.code === "sos_state",
        )
      ) {
        capabilities.add("tamper");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code.startsWith("cur_") || s.code === "electricity",
        )
      ) {
        capabilities.add("current");
        capabilities.add("power");
        capabilities.add("voltage");
        capabilities.add("energy");
      }
      break;
    case "outlet":
    case "switch":
      if (
        device.schema &&
        device.schema.some((s) => s.code.startsWith("cur_"))
      ) {
        if (
          device.schema.some(
            (s) => s.code === "cur_current" || s.code === "electricity",
          )
        ) {
          capabilities.add("current");
        }
        if (device.schema.some((s) => s.code === "cur_power")) {
          capabilities.add("power");
        }
        if (device.schema.some((s) => s.code === "cur_voltage")) {
          capabilities.add("voltage");
        }
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "meter_power" || s.code === "total_forward_energy",
        )
      ) {
        capabilities.add("energy");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "load_status" ||
            s.code === "outlet_in_use" ||
            s.code === "usb_state",
        )
      ) {
        capabilities.add("outlet_in_use");
      }
      break;
    case "camera":
      capabilities.add("on");
      capabilities.add("p2p_start");
      capabilities.add("p2p_stop");
      // mobilecam devices (Magic S1 etc.) have directional control
      if (device.category === "mobilecam") {
        capabilities.add("control");
      }
      // Doorbell button press (for cameras that act as doorbells)
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "movement_detect_pic" ||
            s.code === "doorbell_pic" ||
            s.code === "ipc_human",
        )
      ) {
        capabilities.add("doorbell");
      }
      // Camera PIR / motion detection
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "motion_sensor" ||
            s.code === "pir" ||
            s.code === "motion_detect",
        )
      ) {
        capabilities.add("motion");
      }
      // Battery-powered cameras
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "battery_percentage" ||
            s.code === "battery_state" ||
            s.code === "battery_value",
        )
      ) {
        capabilities.add("battery");
      }
      break;
    case "doorbell":
      capabilities.delete("on");
      capabilities.add("doorbell");
      break;
  }

  if (device.schema) {
    if (
      device.schema.some((s) => s.code === "work_state" || s.code === "mode")
    ) {
      capabilities.add("mode");
    }
    if (device.schema.some((s) => s.code === "child_lock")) {
      capabilities.add("child_lock");
    }
    if (
      device.schema.some(
        (s) => s.code === "countdown" || s.code === "count_down",
      )
    ) {
      capabilities.add("countdown");
    }
  }

  return Array.from(capabilities);
}

function getDoimusType(device, options) {
  let category = device.category;

  const deviceConfig = getDeviceConfig(device, options);
  if (deviceConfig && deviceConfig.category) {
    if (deviceConfig.category === "hidden") return "hidden";
    category = deviceConfig.category;
  }

  return CATEGORY_TO_DOIMUS_TYPE[category] || "switch";
}

function getDeviceConfig(device, options) {
  if (!options.deviceOverrides) return undefined;
  const deviceConfig = options.deviceOverrides.find(
    (c) => c.id === device.id || c.id === device.uuid,
  );
  const productConfig = options.deviceOverrides.find(
    (c) => c.id === device.product_id,
  );
  const globalConfig = options.deviceOverrides.find((c) => c.id === "global");
  return deviceConfig || productConfig || globalConfig;
}

function getDeviceSchemaConfig(device, code, options) {
  const deviceConfig = getDeviceConfig(device, options);
  if (!deviceConfig || !deviceConfig.schema) return undefined;
  const schemaConfig = deviceConfig.schema.find((item) =>
    item.newCode ? item.newCode === code : item.code === code,
  );
  return schemaConfig;
}

function buildCommand(commandSchemas, code, value) {
  const schema = commandSchemas.find((s) => s.code === code);
  if (schema) {
    if (
      schema.property &&
      schema.property.min !== undefined &&
      schema.property.max !== undefined
    ) {
      const scale =
        schema.property.scale != null ? Math.pow(10, schema.property.scale) : 1;
      if (typeof value === "number") {
        const realMin = schema.property.min / scale;
        const realMax = schema.property.max / scale;
        value = Math.max(realMin, Math.min(realMax, value));
      }
      if (schema.type === "Enum") {
        return { code, value: String(value) };
      } else if (schema.type === "Integer") {
        return { code, value: Math.round(Number(value) * scale) };
      } else if (schema.type === "Boolean") {
        return {
          code,
          value: value === true || value === 1 || value === "true",
        };
      }
    }
  }
  return { code, value };
}

function createPluginInstance() {
  return {
    debounceMap: new Map(),
    lastKnownState: new Map(),
    deviceManager: null,
    doimusDeviceMap: new Map(),
    apiRef: null,
  };
}

/**
 * Decrypt a camera image from Tuya MQTT status codes.
 *
 * Handles two formats:
 * 1. initiative_message — JSON with hex-encoded AES-128-CBC data (v4.0)
 * 2. movement_detect_pic / doorbell_pic — base64 AES-128-ECB data
 *
 * Returns a JPEG Buffer or null.
 */
function tryDecodeCameraImage(device, status, log) {
  const localKey = device.local_key;
  if (!localKey) return null;

  for (const item of status) {
    if (typeof item.value !== "string" || item.value.length === 0) continue;

    const jpeg =
      tryDecodeInitiativeMessage(item, localKey) ||
      tryDecodeDoorbellPic(item, localKey);

    if (jpeg) {
      log(
        "info",
        `Camera image captured: device="${device.name}" code=${item.code} size=${jpeg.length}B`,
      );
      return jpeg;
    }
  }
  return null;
}

function tryDecodeInitiativeMessage(item, localKey) {
  if (item.code !== "initiative_message") return null;
  try {
    const msg = JSON.parse(item.value);
    if (!msg.files || msg.files.length === 0) return null;

    const key = Buffer.from(localKey, "utf8");
    for (const file of msg.files) {
      if (!file.data || !file.iv) continue;
      try {
        const encrypted = Buffer.from(file.data, "hex");
        const iv = Buffer.from(file.iv, "hex");
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        if (decrypted[0] === 0xff && decrypted[1] === 0xd8) {
          return decrypted;
        }
      } catch (_) {
        // try next file or key derivation
      }
    }
  } catch (_) {
    // not valid JSON
  }
  return null;
}

function tryDecodeDoorbellPic(item, localKey) {
  if (!["movement_detect_pic", "doorbell_pic", "ipc_human"].includes(item.code))
    return null;
  try {
    const encrypted = Buffer.from(item.value, "base64");
    // Try raw local_key, then MD5(local_key) — Tuya cameras vary
    const rawKey = Buffer.from(localKey, "utf8");
    const md5Key = crypto.createHash("md5").update(localKey).digest();
    for (const key of [rawKey, md5Key]) {
      try {
        const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
        decipher.setAutoPadding(true);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        if (decrypted[0] === 0xff && decrypted[1] === 0xd8) {
          return decrypted;
        }
      } catch (_) {
        // try next key
      }
    }
  } catch (_) {
    // not valid base64
  }
  return null;
}

// ─── P2P Live View ───────────────────────────────────────────────────────────

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

  // mobilecam devices (Magic S1) may use port 6668, need different protocol
  // versions, or require the MD5-hashed local_key instead of the raw key.
  const configs =
    tuyaDevice.category === "mobilecam"
      ? [
          [554, 3.5, "md5"],
          [554, 3.5, "raw"],
          [554, 3.1, "md5"],
          [554, 3.1, "raw"],
          [554, 3.3, "md5"],
          [554, 3.3, "raw"],
          [6668, 3.5, "md5"],
          [6668, 3.5, "raw"],
        ]
      : [[554, 3.4, "raw"]];

  for (const [port, version, keyType] of configs) {
    const localKey =
      keyType === "md5"
        ? crypto.createHash("md5").update(tuyaDevice.local_key).digest("hex")
        : tuyaDevice.local_key;
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
        info: (m) => log("info", `[P2P] ${m}`),
        debug: (m) => log("debug", `[P2P] ${m}`),
        warn: (m) => log("warn", `[P2P] ${m}`),
        error: (m) => log("error", `[P2P] ${m}`),
      },
    });

    let succeeded = false;
    p2p.on("frame", (jpeg) => {
      log(
        "debug",
        `P2P frame received for "${tuyaDevice.name}": ${jpeg.length} bytes`,
      );
      api.sendMjpegFrame(doimusID, "main", jpeg);
    });

    p2p.on("error", (err) => {
      log("error", `P2P error for "${tuyaDevice.name}": ${err.message}`);
      ctx.p2pClients.delete(doimusID);
    });

    p2p.on("close", () => {
      log("info", `P2P connection closed for "${tuyaDevice.name}"`);
      ctx.p2pClients.delete(doimusID);
    });

    p2p.on("streaming", (active) => {
      log(
        "info",
        `P2P streaming ${active ? "started" : "stopped"} for "${tuyaDevice.name}"`,
      );
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
  p2p.close();
  ctx.p2pClients.delete(doimusID);
}

// Module-level reference to the current plugin context so stop() can access it.
let _ctx = null;

function sendCommandsDebounced(tuyaDevice, commands, ctx, log) {
  const key = tuyaDevice.id;
  const debounced =
    ctx.debounceMap.get(key) ||
    debounce(async (cmds) => {
      try {
        await ctx.deviceManager.sendCommands(tuyaDevice.id, cmds);
      } catch (e) {
        log("error", `Command failed for ${tuyaDevice.id}: ${e.message}`);
        if (ctx.lastKnownState.has(tuyaDevice.id)) {
          const prevState = ctx.lastKnownState.get(tuyaDevice.id);
          const doimusID = ctx.doimusDeviceMap.get(tuyaDevice.id);
          if (doimusID && ctx.apiRef) {
            ctx.apiRef.updateDeviceState(doimusID, prevState);
          }
        }
      }
    }, 50);
  ctx.debounceMap.set(key, debounced);
  debounced(commands);
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
  openAPI.setReloginHandler(async () => {
    log("info", "Re-logging in default user due to token expiry...");
    return await openAPI.customLogin(DEFAULT_USER, DEFAULT_USER);
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
  openAPI.setReloginHandler(async () => {
    log("info", "Re-logging in to Tuya Cloud due to token expiry...");
    return await openAPI.homeLogin(countryCode, username, password, appSchema);
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
    applySchemaOverride(device, options);
    const type = getDoimusType(device, options);
    if (type === "hidden") continue;

    const doimusID = generateUUID(device.id);
    const capabilities = determineCapabilities(device);
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

module.exports = {
  async start(cfg, api) {
    const ctx = createPluginInstance();
    ctx.apiRef = api;
    _ctx = ctx;
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

    await persistDeviceList(api, dm, uid, log);
    await registerDevicesWithDoimus(api, dm, options, ctx, log);

    // Fetch local_key for camera/doorbell devices (needed for image decryption).
    // The bulk device list API omits local_key — must fetch per-device.
    for (const device of dm.devices) {
      if (
        ["sp", "doorbell", "mobilecam"].includes(device.category) &&
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
          ["sp", "doorbell", "mobilecam"].includes(device.category) &&
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
      }, 30000);
      if (ctx._energyPollTimer.unref) ctx._energyPollTimer.unref();
    }

    // Periodic MJPEG snapshot for camera devices
    let snapshotTimer = null;
    if (result.dm) {
      const cameraDevices = result.dm.devices.filter((d) =>
        ["sp", "mobilecam"].includes(d.category),
      );
      if (cameraDevices.length > 0) {
        log(
          "info",
          `Starting MJPEG snapshot polling for ${cameraDevices.length} camera(s)`,
        );
        let firstSnapshotLogged = false;
        let snapshotOK = 0;
        let snapshotErr = 0;
        // Track per-device consecutive snapshot errors to suppress noise
        const _snapshotConsecutiveFails = new Map();
        snapshotTimer = setInterval(async () => {
          for (const device of cameraDevices) {
            try {
              const frame = await result.dm.api.getCameraSnapshot(device.id);
              if (frame) {
                const doimusID = ctx.doimusDeviceMap.get(device.id);
                if (doimusID) {
                  api.sendMjpegFrame(doimusID, "main", frame);
                  snapshotOK++;
                  if (!firstSnapshotLogged) {
                    log(
                      "info",
                      `First REST snapshot OK: device="${device.name}" doimusID="${doimusID}" size=${frame.length}B`,
                    );
                    firstSnapshotLogged = true;
                  }
                } else {
                  log(
                    "warn",
                    `Snapshot skipped: no Doimus device ID for Tuya device "${device.name}" (id=${device.id})`,
                  );
                }
              } else {
                snapshotErr++;
                const fails =
                  (_snapshotConsecutiveFails.get(device.id) || 0) + 1;
                _snapshotConsecutiveFails.set(device.id, fails);
                // Only log every 10th failure or the first one
                if (fails <= 1 || fails % 10 === 0) {
                  log(
                    fails <= 1 ? "debug" : "info",
                    `REST snapshot unavailable for device "${device.name}" (id=${device.id}, fail #${fails})`,
                  );
                }
              }
            } catch (e) {
              snapshotErr++;
              const fails = (_snapshotConsecutiveFails.get(device.id) || 0) + 1;
              _snapshotConsecutiveFails.set(device.id, fails);
              if (fails <= 1 || fails % 10 === 0) {
                log(
                  "warn",
                  `Snapshot failed for device "${device.name}" (id=${device.id}, fail #${fails}): ${e.message || e}`,
                );
              }
            }
          }
          // Periodic summary every 10 cycles (~5 min)
          const cycle = Math.floor(
            (snapshotOK + snapshotErr) / (cameraDevices.length || 1),
          );
          if (
            cycle > 0 &&
            cycle % 10 === 0 &&
            (snapshotOK > 0 || snapshotErr > 0)
          ) {
            log(
              "info",
              `Snapshot summary (${cycle} cycles): ${snapshotOK} ok, ${snapshotErr} failed`,
            );
          }
        }, 30000);
        if (snapshotTimer.unref) snapshotTimer.unref();
      }
    }
    ctx._snapshotTimer = snapshotTimer;

    api.onCommand(async (deviceID, key, value) => {
      const tuyaID = ctx.doimusDeviceMap.get(deviceID);
      if (!tuyaID) return;
      try {
        const tuyaDevice = dm.getDevice(tuyaID);
        if (!tuyaDevice) return;

        let commands = [];

        if (key === "on") {
          const onSchema = tuyaDevice.schema.find(
            (s) =>
              s.code === "switch_1" ||
              s.code === "switch_fan" ||
              s.code === "fan_switch",
          );
          if (onSchema) {
            commands.push({ code: onSchema.code, value: value === true });
          } else if (tuyaDevice.schema.some((s) => s.code === "switch")) {
            commands.push({ code: "switch", value: value === true });
          } else if (tuyaDevice.schema.some((s) => s.code === "light")) {
            commands.push({ code: "light", value: value === true });
            if (value === true) {
              const brightSchema = tuyaDevice.schema.find(
                (s) =>
                  s.code === "bright_value" ||
                  s.code === "bright_value_v2" ||
                  s.code === "bright_value_1",
              );
              if (brightSchema) {
                const currentBright = tuyaDevice.status.find(
                  (s) => s.code === brightSchema.code,
                );
                if (currentBright && currentBright.value !== undefined) {
                  commands.push(
                    buildCommand(
                      tuyaDevice.schema,
                      brightSchema.code,
                      currentBright.value,
                    ),
                  );
                }
              }
            }
          } else if (tuyaDevice.schema.some((s) => s.code === "switch_led")) {
            commands.push({ code: "switch_led", value: value === true });
          } else {
            const anySwitch = tuyaDevice.schema.find((s) =>
              s.code.startsWith("switch"),
            );
            if (anySwitch) {
              commands.push({ code: anySwitch.code, value: value === true });
            }
          }
        } else if (key === "brightness") {
          const brightSchema = tuyaDevice.schema.find(
            (s) =>
              s.code === "bright_value" ||
              s.code === "bright_value_v2" ||
              s.code === "bright_value_1",
          );
          if (brightSchema) {
            // Convert Doimus 0–100 back to Tuya 0–1000 range before sending
            const tuyaBrightness = Math.round((Number(value) / 100) * 1000);
            commands.push(
              buildCommand(
                tuyaDevice.schema,
                brightSchema.code,
                tuyaBrightness,
              ),
            );
          }
        } else if (key === "color_temp") {
          const tempSchema = tuyaDevice.schema.find(
            (s) => s.code === "temp_value" || s.code === "temp_value_v2",
          );
          if (tempSchema) {
            const tuyaValue = kelvinToTuyaTemp(value, tempSchema.property);
            commands.push({ code: tempSchema.code, value: tuyaValue });
          }
        } else if (key === "hue" || key === "saturation") {
          const colourSchema = tuyaDevice.schema.find(
            (s) => s.code === "colour_data" || s.code === "colour_data_v2",
          );
          if (colourSchema) {
            const currentState = tuyaDevice.status;
            const currentColour = currentState.find(
              (s) => s.code === colourSchema.code,
            );
            let colourData = { hue: 0, saturation: 0, value: 1000 };
            if (currentColour && typeof currentColour.value === "object") {
              colourData = { ...colourData, ...currentColour.value };
            }
            if (key === "hue") colourData.hue = Number(value);
            if (key === "saturation") colourData.saturation = Number(value);
            commands.push({ code: colourSchema.code, value: colourData });
          }
        } else if (key === "target_temp") {
          const tempSetSchema = tuyaDevice.schema.find(
            (s) => s.code === "temp_set" || s.code === "target_temp",
          );
          if (tempSetSchema) {
            commands.push(
              buildCommand(tuyaDevice.schema, tempSetSchema.code, value),
            );
          }
        } else if (key === "heating_mode") {
          // Send numeric heating mode (0=off, 1=heat, 2=cool, 3=auto) to
          // the Tuya mode/work_mode/hvac_mode DP. Value is a Doimus int.
          const modeSchema = tuyaDevice.schema.find(
            (s) =>
              s.code === "mode" ||
              s.code === "work_mode" ||
              s.code === "hvac_mode",
          );
          if (modeSchema) {
            // If the schema property defines a range (Enum), send the value
            // as-is. Tuya expects the raw integer for numeric mode codes.
            commands.push(
              buildCommand(tuyaDevice.schema, modeSchema.code, value),
            );
          }
        } else if (key === "locked") {
          commands.push({ code: "lock_state", value: value === true });
        } else if (key === "child_lock") {
          const childLockSchema = tuyaDevice.schema.find(
            (s) => s.code === "child_lock",
          );
          if (childLockSchema) {
            commands.push(
              buildCommand(tuyaDevice.schema, childLockSchema.code, value),
            );
          }
        } else if (key === "position") {
          const posSchema = tuyaDevice.schema.find(
            (s) =>
              s.code === "percent_control" ||
              s.code === "control_back" ||
              s.code === "position",
          );
          if (posSchema) {
            commands.push(
              buildCommand(tuyaDevice.schema, posSchema.code, value),
            );
          }
        } else if (key === "control") {
          const controlSchema = tuyaDevice.schema.find(
            (s) => s.code === "control" || s.code === "control_back",
          );
          if (controlSchema) {
            commands.push({ code: controlSchema.code, value: String(value) });
          }
        } else if (key === "rotation_speed") {
          const speedSchema = tuyaDevice.schema.find(
            (s) => s.code.startsWith("fan_speed") || s.code === "wind_speed",
          );
          if (speedSchema) {
            commands.push(
              buildCommand(tuyaDevice.schema, speedSchema.code, value),
            );
          }
        } else if (key === "mode") {
          commands.push({ code: "work_state", value: String(value) });
        } else if (key === "countdown") {
          const countdownSchema = tuyaDevice.schema.find(
            (s) => s.code === "countdown" || s.code === "count_down",
          );
          if (countdownSchema) {
            commands.push(
              buildCommand(tuyaDevice.schema, countdownSchema.code, value),
            );
          }
        } else if (key === "p2p_start") {
          await startP2P(deviceID, tuyaDevice, ctx, log, api);
          return;
        } else if (key === "p2p_stop") {
          stopP2P(deviceID, ctx, log);
          return;
        }

        if (commands.length > 0) {
          sendCommandsDebounced(tuyaDevice, commands, ctx, log);
        }
      } catch (e) {
        log("error", `Command handler error: ${e.message}`);
      }
    });

    dm.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, (device, status) => {
      const doimusID = ctx.doimusDeviceMap.get(device.id);
      if (!doimusID) {
        log(
          "warn",
          `DEVICE_STATUS_UPDATE: no doimusID for device ${device.id}`,
        );
        return;
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
      if (Object.keys(state).length > 0) {
        state.online = device.online;
        api.updateDeviceState(doimusID, state);
        ctx.lastKnownState.set(device.id, {
          ...ctx.lastKnownState.get(device.id),
          ...state,
        });
      }

      // Camera / doorbell / mobilecam image capture from MQTT
      if (["sp", "doorbell", "mobilecam"].includes(device.category)) {
        const jpeg = tryDecodeCameraImage(device, status, log);
        if (jpeg) {
          api.sendMjpegFrame(doimusID, "main", jpeg);
        }
      }
    });

    dm.on(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, (device, info) => {
      const doimusID = ctx.doimusDeviceMap.get(device.id);
      if (!doimusID) return;
      const state = { online: device.online };
      if (info && info.name) {
        log("info", `Device renamed: ${device.name}`);
      }
      api.updateDeviceState(doimusID, state);
      ctx.lastKnownState.set(device.id, {
        ...ctx.lastKnownState.get(device.id),
        ...state,
      });
    });

    dm.on(TuyaDeviceManager.Events.DEVICE_ADD, async (device) => {
      log("info", `New device added: ${device.name}`);
      const options2 = (cfg && cfg.options) || {};
      device.schema = await dm.getDeviceSchema(device.id);
      // Fetch local_key for camera/doorbell/mobilecam devices (needed for image decryption)
      if (
        ["sp", "doorbell", "mobilecam"].includes(device.category) &&
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
      `Energy polling: ${energyPollDevices.length} device(s) monitored, MJPEG snapshot: ${(snapshotTimer !== null).toString()}`,
    );
  },

  async setConfig(cfg) {
    const api = _ctx ? _ctx.apiRef : null;
    if (!api) return;
    this.stop();
    await this.start(cfg, api);
  },

  stop() {
    if (_ctx) {
      if (_ctx._energyPollTimer) {
        clearInterval(_ctx._energyPollTimer);
        _ctx._energyPollTimer = null;
      }
      if (_ctx._snapshotTimer) {
        clearInterval(_ctx._snapshotTimer);
        _ctx._snapshotTimer = null;
      }
      if (_ctx._initRetryTimer) {
        clearTimeout(_ctx._initRetryTimer);
        _ctx._initRetryTimer = null;
      }
      if (_ctx.deviceManager && _ctx.deviceManager.mq) {
        try {
          _ctx.deviceManager.mq.stop();
        } catch (_) {}
      }
      for (const [, debounced] of _ctx.debounceMap.entries()) {
        debounced.clear();
      }
      _ctx.debounceMap.clear();
      _ctx.lastKnownState.clear();
      _ctx.deviceManager = null;
      _ctx.doimusDeviceMap.clear();
      // Close all active P2P connections
      if (_ctx.p2pClients) {
        for (const [id, p2p] of _ctx.p2pClients) {
          try {
            p2p.close();
          } catch (_) {}
        }
        _ctx.p2pClients.clear();
      }
      _ctx.apiRef = null;
      _ctx = null;
    }
  },
};
