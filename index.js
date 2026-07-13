const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const util = require("util");
const debounce = require("debounce");

const TuyaOpenAPI = require("./core/TuyaOpenAPI");
const TuyaCustomDeviceManager = require("./device/TuyaCustomDeviceManager");
const TuyaHomeDeviceManager = require("./device/TuyaHomeDeviceManager");
const TuyaDeviceManager = require("./device/TuyaDeviceManager");
const TuyaP2P = require("./core/TuyaP2P");
const WebRTCSignaling = require("./core/WebRTCSignaling");

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
  // IR control hubs — not registered themselves, sub-devices are
  wnykq: "ir_hub",
  hwktwkq: "ir_hub",
  wsdykq: "ir_hub",
  // IR remote sub-devices
  infrared_ac: "thermostat",
  infrared_tv: "switch",
  infrared_fan: "fan",
  infrared_stb: "switch",
  infrared_diy: "switch",
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

    if (
      code === "switch" ||
      (code != null &&
        code.startsWith("switch_") &&
        !isNaN(Number(code.slice(7))))
    ) {
      // Defer to relay_status if present — it reflects physical relay state,
      // while switch_N is a desired-state cached by Tuya Cloud that may be
      // stale when the device is offline.
      // Matches: switch, switch_1, switch_2, switch_3, etc.
      if (state._relayOverride === undefined) {
        state.on =
          value === true || value === "true" || value === 1 || value === "1";
      }
    } else if (code === "relay_status") {
      // relay_status is authoritative: "power_on" → on=true, "power_off" → on=false.
      // Override any switch_1-derived value and mark the override so switch_1
      // (which may appear later in the status list) doesn't overwrite it.
      state.on = value === "power_on" || value === true || value === 1;
      state._relayOverride = true;
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
    } else if (
      code === "pir" ||
      code === "motion_sensor" ||
      code === "motion_detect"
    ) {
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
    } else if (
      code === "movement_detect_pic" ||
      code === "ipc_human" ||
      code === "doorbell_active" ||
      code === "motion_switch" ||
      code === "human_detect" ||
      code === "person_detect" ||
      code === "movement_detect" ||
      code === "ipc_motion"
    ) {
      // Camera / doorbell: motion, human/person, or doorbell event detection.
      if (
        ["sp", "mobilecam", "wxml", "doorbell"].includes(device.category) &&
        typeof value === "string" &&
        value.length > 0
      ) {
        state.motion = true;
      }
    } else if (
      /motion|movement|doorbell|human|person|pir/i.test(code) &&
      (typeof value === "string" ? value.length > 0 : !!value)
    ) {
      // Generic fallback: any DP code matching motion-related patterns.
      state.motion = true;
    } else if (code === "doorbell_pic") {
      // Doorbell button press (or camera doorbell pic) — set doorbell state.
      state.doorbell = typeof value === "string" && value.length > 0;
    } else if (
      code === "tamper" ||
      code === "tamper_state" ||
      code === "tamper_alarm"
    ) {
      state.tamper =
        value === true ||
        value === 1 ||
        value === "alarm" ||
        value === "tamper";
    } else if (code === "sos" || code === "sos_state") {
      // SOS/panic button — mapped to tamper for alarm notification
      state.tamper =
        value === true || value === 1 || value === "alarm" || value === "sos";
    } else if (code === "percent_control" || code === "position") {
      state.position = Number(value);
    } else if (code === "control_back" || code === "control") {
      // Direction-only DP — don't map to position.
      // Values like "open"/"close"/"stop" are not numeric.
      state.control = String(value);
    } else if (code === "work_state" || code === "mode") {
      state.mode = String(value);
      // Also map numeric mode values to heating_mode where applicable.
      if (typeof value === "number" && Number.isFinite(value)) {
        state.heating_mode = Number(value);
      } else if (typeof value === "string") {
        const numVal = Number(value);
        if (!isNaN(numVal) && value.trim() !== "") {
          // Numeric string (e.g. IR AC mode "0", "1", "2")
          state.heating_mode = numVal;
        } else {
          // Named mode strings
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
    } else if (code === "power") {
      // IR AC power status ("1" = on, "0" = off)
      state.on = value === "1" || value === 1 || value === true;
    } else if (code === "temp") {
      // IR AC target temperature
      state.target_temp = Number(value);
    } else if (code === "wind") {
      // IR AC fan speed
      state.rotation_speed = Number(value);
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

  // ── Offline guard: a device that is offline cannot have active motion. ──
  // When device.online is false, force-reset motion/doorbell immediately
  // without consulting device.status (which retains stale values).
  if (state.online === false) {
    state.motion = false;
    state.doorbell = false;
  }

  // ── Camera / doorbell: auto-reset motion from device.status (full state) ──
  // Known motion/doorbell DPs only appear when a motion event is active.
  // When motion ends, those DPs disappear. We check device.status (the full
  // maintained array) rather than statusList (which may be a partial MQTT
  // update) to reliably detect the absence of motion.
  if (
    ["sp", "mobilecam", "doorbell", "wxml"].includes(device.category) &&
    state.motion === undefined
  ) {
    const fullStatus = device.status || [];
    const motionPattern = /motion|movement|doorbell|human|person|pir/i;
    const hasMotionDP = fullStatus.some(
      (s) =>
        [
          "movement_detect_pic",
          "ipc_human",
          "pir",
          "motion_sensor",
          "motion_detect",
          "doorbell_active",
          "motion_switch",
          "human_detect",
          "person_detect",
          "movement_detect",
          "ipc_motion",
        ].includes(s.code) &&
        (typeof s.value === "string" ? s.value.length > 0 : !!s.value),
    );
    // Generic fallback: iterate all status items and match any unknown DP
    // code that contains motion-related patterns (case-insensitive).
    const hasMotionPattern =
      hasMotionDP ||
      fullStatus.some(
        (s) =>
          motionPattern.test(s.code) &&
          (typeof s.value === "string" ? s.value.length > 0 : !!s.value),
      );
    state.motion = hasMotionPattern;
  }

  // Strip internal keys (prefixed with _) before returning.
  // These are used internally for deduplication and must not leak to Doimus.
  delete state._relayOverride;
  delete state._brightValue;
  delete state._colourData;

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
        device.schema.some((s) => s.code && s.code.startsWith("bright"))
      ) {
        capabilities.add("brightness");
      }
      if (
        device.schema &&
        device.schema.some((s) => s.code && s.code.startsWith("temp_value"))
      ) {
        capabilities.add("color_temp");
      }
      if (
        device.schema &&
        device.schema.some((s) => s.code && s.code.startsWith("colour_data"))
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
            (s.code && s.code.startsWith("fan_speed")) ||
            (s.code && s.code.startsWith("wind_speed")),
        )
      ) {
        capabilities.add("rotation_speed");
      }
      break;
    case "blind":
      // Only add "position" capability for writable position DPs — exclude
      // read-only codes like "percent_state" and direction-only codes like
      // "control_back" (which takes "open"/"close"/"stop", not 0-100).
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code &&
              s.code.startsWith("percent") &&
              s.code !== "percent_state") ||
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
        device.schema.some((s) => s.code && s.code.startsWith("lock"))
      ) {
        capabilities.add("locked");
      }
      break;
    case "thermostat":
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code && s.code.startsWith("temp_set")) ||
            s.code === "target_temp",
        )
      ) {
        capabilities.add("target_temp");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code && s.code.startsWith("temp_current")) ||
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
            (s.code && s.code.startsWith("va_temperature")) ||
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
            (s.code && s.code.startsWith("va_humidity")) ||
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
          (s) =>
            (s.code && s.code.startsWith("battery")) || s.code === "va_battery",
        )
      ) {
        capabilities.add("battery");
      }
      if (
        device.schema &&
        device.schema.some((s) => s.code && s.code.startsWith("smoke"))
      ) {
        capabilities.add("smoke");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code && s.code.startsWith("gas")) || s.code === "co_gas_sensor",
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
          (s) =>
            (s.code && s.code.startsWith("cur_")) || s.code === "electricity",
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
        device.schema.some((s) => s.code && s.code.startsWith("cur_"))
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
      // Video peepholes and wireless doorbells with camera capabilities
      // need p2p_start/p2p_stop for live view streaming.
      capabilities.add("p2p_start");
      capabilities.add("p2p_stop");
      // Wireless doorbells often have battery
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code && s.code.startsWith("battery")) || s.code === "va_battery",
        )
      ) {
        capabilities.add("battery");
      }
      break;
  }

  // IR remote sub-devices — schema is empty, detect capabilities from
  // remote_keys and IR AC status codes instead.
  if (device.isIRRemoteControl && device.isIRRemoteControl()) {
    if (device.category === "infrared_ac") {
      const acCodes = new Set((device.status || []).map((s) => s.code));
      if (acCodes.has("power")) capabilities.add("on");
      if (acCodes.has("temp")) capabilities.add("target_temp");
      if (acCodes.has("mode")) capabilities.add("heating_mode");
      if (acCodes.has("wind")) capabilities.add("rotation_speed");
    }
    // Non-AC IR remotes get just "on" (already added universally).
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
    _wakeWatchers: new Map(),
    _streamFallbackTimers: new Map(), // fallback delay timers for battery cameras
  };
}

/**
 * Parse initiative_message metadata from a Tuya MQTT status array.
 * Extracts bucket, file_path, and optional encryption key without
 * performing any network requests.
 */
function parseMotionMetadata(status, log, deviceName) {
  for (const item of status) {
    if (item.code !== "initiative_message") continue;

    // Format 1: numeric keys (e.g. "1680000000000") holding base64 JSON.
    // This is the most common format for newer Tuya camera firmware.
    const metaKey = Object.keys(item).find(
      (k) =>
        /^\d+$/.test(k) && typeof item[k] === "string" && item[k].length > 20,
    );
    if (metaKey) {
      let meta;
      try {
        meta = JSON.parse(
          Buffer.from(item[metaKey], "base64").toString("utf8"),
        );
      } catch (_) {
        log(
          "debug",
          `initiative_message numeric-key metadata parse failed for "${deviceName}"`,
        );
        continue;
      }
      if (!meta.bucket || !meta.files || !meta.files[0] || !meta.files[0][0]) {
        log(
          "debug",
          `initiative_message numeric-key metadata missing bucket/files for "${deviceName}"`,
        );
        continue;
      }
      return {
        bucket: meta.bucket,
        filePath: meta.files[0][0],
        encKey: meta.files[0][1] || null,
      };
    }

    // Format 2: .value is a JSON string with S3 coordinates.
    // Some Tuya firmware versions put S3 metadata directly in the value
    // field instead of under a numeric key.  The value is a JSON object
    // with "bucket" and "files" but no inline "data"/"iv" (so
    // tryDecodeInitiativeMessage would have already skipped it).
    if (typeof item.value === "string" && item.value.length > 0) {
      let meta;
      try {
        meta = JSON.parse(item.value);
      } catch (_) {
        // Not JSON — not S3 metadata.
        continue;
      }
      if (meta.bucket && meta.files && meta.files[0] && meta.files[0][0]) {
        log(
          "debug",
          `initiative_message value-JSON metadata found for "${deviceName}"`,
        );
        return {
          bucket: meta.bucket,
          filePath: meta.files[0][0],
          encKey: meta.files[0][1] || null,
        };
      }
    }

    log(
      "debug",
      `initiative_message without recognisable metadata for "${deviceName}"`,
    );
  }
  return null;
}

function detectImageMime(data) {
  if (!data || data.length < 4) return "application/octet-stream";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    data.length > 12 &&
    data.slice(0, 4).toString("ascii") === "RIFF" &&
    data.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

function extractSnapshotUrlFromStatus(status) {
  for (const item of status || []) {
    if (!item || typeof item.value !== "string" || item.value.length < 8)
      continue;

    const raw = item.value.trim();
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }

    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    } catch (_) {
      // ignore invalid base64
    }
  }
  return null;
}

async function downloadImageFromUrl(url, log, deviceName, depth = 0) {
  if (!url || depth > 2) return null;
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      resolve(null);
      return;
    }

    const client = parsed.protocol === "http:" ? http : https;
    client
      .get(url, (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          res.resume();
          const redirect = new URL(res.headers.location, url).toString();
          downloadImageFromUrl(redirect, log, deviceName, depth + 1).then(
            resolve,
          );
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          const mime = detectImageMime(data);
          if (!mime.startsWith("image/")) {
            log(
              "debug",
              `Snapshot URL payload is not an image for "${deviceName}": mime=${mime} size=${data.length}`,
            );
            resolve(null);
            return;
          }
          resolve({ data, mime });
        });
      })
      .on("error", () => resolve(null));
  });
}

/**
 * Fetch and decrypt a camera image via Tuya movement-configs API + S3.
 * Network-heavy — call after a delay to let the camera finish uploading.
 */
async function fetchMotionImageFromS3(device, metadata, dm, ctx, log) {
  const { bucket, filePath, encKey } = metadata;

  log(
    "info",
    `Fetching motion image: device="${device.name}" bucket=${bucket} file=${filePath}`,
  );

  // Step 1: Get S3 presigned URL from Tuya movement-configs API
  const configRes = await dm.api.get(
    `/v1.0/devices/${device.id}/movement-configs`,
    { bucket, file_path: filePath },
  );

  if (!configRes.success || !configRes.result) {
    log(
      "warn",
      `Movement-configs API failed for "${device.name}": code=${configRes.code} msg=${configRes.msg}`,
    );
    return null;
  }

  // Result may be a string (URL) or an object with url property.
  const s3Url =
    typeof configRes.result === "string"
      ? configRes.result
      : configRes.result.url;

  if (!s3Url) {
    log(
      "warn",
      `Movement-configs returned no URL for "${device.name}": ${JSON.stringify(configRes.result)}`,
    );
    return null;
  }

  // Step 2: Download from S3 presigned URL
  try {
    const raw = await new Promise((resolve, reject) => {
      https
        .get(s3Url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`S3 status ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        })
        .on("error", reject);
    });

    // Plain JPEG (no encryption).
    if (raw[0] === 0xff && raw[1] === 0xd8) {
      log(
        "info",
        `Motion image fetched: device="${device.name}" size=${raw.length}B`,
      );
      return raw;
    }

    // Encrypted blob: [4 bytes version LE][16 bytes IV][N bytes header][ciphertext]
    // Different Tuya camera models use different header sizes.  Find the
    // largest header offset that leaves a 16-byte-aligned ciphertext.
    if (encKey && raw.length > 68) {
      const iv = raw.slice(4, 20);
      const aesKey = Buffer.from(encKey, "utf8");

      // Header sizes to try (4+16+header): MG-Sky=64, our guess=68, others.
      // Cache the first working offset per device to skip probing on subsequent events.
      if (!ctx._snapshotOffsetCache) ctx._snapshotOffsetCache = new Map();
      const cachedOffset = ctx._snapshotOffsetCache.get(device.id);
      const offsets =
        cachedOffset != null ? [cachedOffset] : [64, 68, 72, 60, 56, 76, 80];
      let success = false;

      for (const offset of offsets) {
        const ciphertext = raw.slice(offset);
        if (ciphertext.length % 16 !== 0) continue;

        try {
          const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
          decipher.setAutoPadding(true);
          const jpeg = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ]);

          if (jpeg[0] === 0xff && jpeg[1] === 0xd8) {
            ctx._snapshotOffsetCache.set(device.id, offset);
            log(
              "info",
              `Motion image decrypted: device="${device.name}" size=${jpeg.length}B offset=${offset}`,
            );
            return jpeg;
          }
        } catch (_) {
          // Try next offset.
        }
      }

      if (!success) {
        log(
          "debug",
          `AES decrypt failed for "${device.name}": tried offsets=${offsets.join(",")} totalLen=${raw.length}`,
        );
      }
    } else {
      log(
        "debug",
        `S3 response not JPEG (no encKey) for "${device.name}": magic=${raw.slice(0, 4).toString("hex")}`,
      );
    }
  } catch (e) {
    log("warn", `S3 fetch failed for "${device.name}": ${e.message}`);
  }
  return null;
}

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

  // 1. Update state immediately with _capture_id so the backend creates
  //    the timeline entry WITH the correct image_key from the start.
  //    The backend strips _capture_id from device state — it never
  //    persists as a real state key.
  api.updateDeviceState(doimusID, {
    motion: true,
    _capture_id: eventKey,
  });

  // ── Sync lastKnownState ───────────────────────────────────────────
  // Keep the plugin's internal lastKnownState in sync with the backend
  // so the auto-reset timer can correctly detect motion is still true.
  // If a previous edge-detection timer already reset lastKnownState to
  // false, the timer below would never fire — leaving motion stuck.
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

  // 2. Try inline image decode (movement_detect_pic / doorbell_pic DPs).
  let imageData = tryDecodeCameraImage(device, statuses, log);
  let imageMime = imageData ? detectImageMime(imageData) : null;

  // 3. Try DP URL (some doorbells embed a URL in a DP value).
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
    ctx._motionCoalesce.delete(tuyaID);
    return;
  }

  // 4. No inline image — check for S3 metadata (initiative_message).
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
  if (!localKey) {
    if (log)
      log(
        "debug",
        `Camera image decode skipped: no local_key for "${device.name}"`,
      );
    return null;
  }

  for (const item of status) {
    if (typeof item.value !== "string" || item.value.length === 0) continue;

    const jpeg =
      tryDecodeInitiativeMessage(item, localKey, log) ||
      tryDecodeDoorbellPic(item, localKey, log);

    if (jpeg) {
      log(
        "info",
        `Camera image captured: device="${device.name}" code=${item.code} size=${jpeg.length}B`,
      );
      return jpeg;
    }
  }
  if (log) {
    const codes = status
      .filter((s) => typeof s.value === "string" && s.value.length > 0)
      .map((s) => s.code);
    if (codes.length > 0) {
      log(
        "debug",
        `Camera image decode: no JPEG extracted from codes=[${codes.join(",")}] for "${device.name}"`,
      );
    }
  }
  return null;
}

function tryDecodeInitiativeMessage(item, localKey, log) {
  if (item.code !== "initiative_message") return null;
  try {
    const msg = JSON.parse(item.value);
    if (!msg.files || msg.files.length === 0) return null;

    // Try raw local_key, MD5(local_key), SHA256(local_key) — Tuya
    // initiative_message encryption varies by firmware version.
    const rawKey = Buffer.from(localKey, "hex");
    const md5Key = crypto.createHash("md5").update(localKey).digest();
    const sha256Key = crypto.createHash("sha256").update(localKey).digest();
    const keyLabels = ["raw", "md5", "sha256"];

    for (const file of msg.files) {
      if (!file.data || !file.iv) continue;
      try {
        const encrypted = Buffer.from(file.data, "hex");
        const iv = Buffer.from(file.iv, "hex");

        let keyIdx = 0;
        for (const key of [rawKey, md5Key, sha256Key]) {
          const label = keyLabels[keyIdx++];
          try {
            const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
            decipher.setAutoPadding(true);
            const decrypted = Buffer.concat([
              decipher.update(encrypted),
              decipher.final(),
            ]);
            if (decrypted[0] === 0xff && decrypted[1] === 0xd8) {
              if (log) {
                log(
                  "info",
                  `Initiative message decoded OK: key=${label} keyLen=${localKey.length} size=${decrypted.length}B`,
                );
              }
              return decrypted;
            }
            if (log) {
              log(
                "debug",
                `Initiative message decode: key=${label} decrypted but no JPEG magic (first 4 bytes: ${decrypted.slice(0, 4).toString("hex")})`,
              );
            }
          } catch (e) {
            if (log) {
              log(
                "debug",
                `Initiative message decrypt failed: key=${label} error=${e.message}`,
              );
            }
          }
        }
      } catch (_) {
        // file.data or file.iv not valid hex
      }
    }
  } catch (_) {
    // not valid JSON
  }
  return null;
}

function tryDecodeDoorbellPic(item, localKey, log) {
  if (!["movement_detect_pic", "doorbell_pic", "ipc_human"].includes(item.code))
    return null;
  try {
    const encrypted = Buffer.from(item.value, "base64");
    // Try raw local_key, MD5(local_key), SHA256(local_key) — Tuya cameras vary.
    // Some video peephole / doorbell models use SHA256 key derivation.
    const rawKey = Buffer.from(localKey, "hex");
    const md5Key = crypto.createHash("md5").update(localKey).digest();
    const sha256Key = crypto.createHash("sha256").update(localKey).digest();
    const keyLabels = ["raw", "md5", "sha256"];
    let keyIdx = 0;
    for (const key of [rawKey, md5Key, sha256Key]) {
      const label = keyLabels[keyIdx++];
      try {
        const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
        decipher.setAutoPadding(true);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        if (decrypted[0] === 0xff && decrypted[1] === 0xd8) {
          if (log) {
            log(
              "info",
              `Doorbell pic decoded OK: code=${item.code} key=${label} keyLen=${localKey.length} size=${decrypted.length}B`,
            );
          }
          return decrypted;
        }
        if (log) {
          log(
            "debug",
            `Doorbell pic decode: code=${item.code} key=${label} decrypted but no JPEG magic (first 4 bytes: ${decrypted.slice(0, 4).toString("hex")})`,
          );
        }
      } catch (e) {
        if (log) {
          log(
            "debug",
            `Doorbell pic decrypt failed: code=${item.code} key=${label} error=${e.message}`,
          );
        }
      }
    }
    if (log) {
      log(
        "info",
        `Doorbell pic decode: ALL keys failed for code=${item.code} dataLen=${encrypted.length} localKeyLen=${localKey.length}`,
      );
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
  log(
    "info",
    `[P2P] Device "${tuyaDevice.name}" IP=${ip} localKeyLen=${(tuyaDevice.local_key || "").length} category=${tuyaDevice.category}`,
  );

  // mobilecam / sp / doorbell devices (Magic S1, video peephole, wireless
  // doorbells) may use different protocol versions, port 6668, or different
  // key derivations (raw, MD5, SHA256). Try all plausible combinations.
  const isCamera = ["mobilecam", "sp", "doorbell", "wxml"].includes(
    tuyaDevice.category,
  );
  // v3.1 first: no session-key negotiation → works even with quirky local_key
  // encoding common on battery cameras.  v3.4+ preferred when key is correct.
  const configs = isCamera
    ? [
        [554, 3.1, "md5"],
        [554, 3.1, "raw"],
        [554, 3.1, "sha256"],
        [554, 3.4, "md5"],
        [554, 3.4, "raw"],
        [554, 3.4, "sha256"],
        [554, 3.5, "md5"],
        [554, 3.5, "raw"],
        [554, 3.5, "sha256"],
        [554, 3.3, "md5"],
        [554, 3.3, "raw"],
        [554, 3.3, "sha256"],
        [6668, 3.5, "md5"],
        [6668, 3.5, "raw"],
        [6668, 3.5, "sha256"],
      ]
    : [
        [554, 3.1, "raw"],
        [554, 3.4, "raw"],
      ];

  for (const [port, version, keyType] of configs) {
    // Tuya local_key is a hex string. Derive binary keys for P2P crypto.
    // Use .digest() (binary Buffer) NOT .digest("hex") so TuyaP2P receives
    // a compact 16-byte (MD5) / 32-byte (SHA256) key suitable for AES-128-ECB.
    let localKey;
    if (keyType === "md5") {
      localKey = crypto.createHash("md5").update(tuyaDevice.local_key).digest();
    } else if (keyType === "sha256") {
      localKey = crypto
        .createHash("sha256")
        .update(tuyaDevice.local_key)
        .digest();
    } else {
      // "raw" — pass the hex string; TuyaP2P will decode it.
      localKey = tuyaDevice.local_key;
    }
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
        info: (m, ...a) => log("info", `[P2P] ${util.format(m, ...a)}`),
        debug: (m, ...a) => log("debug", `[P2P] ${util.format(m, ...a)}`),
        warn: (m, ...a) => log("warn", `[P2P] ${util.format(m, ...a)}`),
        error: (m, ...a) => log("error", `[P2P] ${util.format(m, ...a)}`),
      },
    });

    let succeeded = false;
    p2p.on("frame", (jpeg) => {
      log(
        "debug",
        `P2P frame received for "${tuyaDevice.name}": ${jpeg.length} bytes`,
      );
      api.sendMjpegFrame(doimusID, "main", jpeg);
      // Store as snapshot_live so the mobile app's live preview shows
      // the latest P2P frame without overwriting the motion capture image.
      api.updateDeviceImage(doimusID, "snapshot_live", jpeg, "image/jpeg");
    });

    // When the camera sends H.264 (not MJPEG), decode it to JPEG via ffmpeg.
    // Accumulate H.264 NAL units and periodically spawn ffmpeg to extract a
    // keyframe.  A single NAL unit is not enough — we need a full GOP.
    let h264Buffer = [];
    let ffmpegRunning = false;

    p2p.on("h264_nal", (data) => {
      h264Buffer.push(
        Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), data]),
      );

      if (ffmpegRunning) return;
      if (h264Buffer.length < 5) return;

      ffmpegRunning = true;
      const input = Buffer.concat(h264Buffer);
      h264Buffer = [];

      try {
        const { spawn } = require("child_process");
        const proc = spawn(
          "ffmpeg",
          [
            "-i",
            "pipe:0",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-q:v",
            "10",
            "-vframes",
            "1",
            "pipe:1",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );

        proc.stderr.on("data", () => {});

        const chunks = [];
        proc.stdout.on("data", (c) => chunks.push(c));
        proc.stdout.on("end", () => {
          const jpeg = Buffer.concat(chunks);
          if (jpeg[0] === 0xff && jpeg[1] === 0xd8) {
            api.sendMjpegFrame(doimusID, "main", jpeg);
            api.updateDeviceImage(
              doimusID,
              "snapshot_live",
              jpeg,
              "image/jpeg",
            );
          }
          ffmpegRunning = false;
        });

        proc.on("error", () => {
          ffmpegRunning = false;
        });
        proc.on("close", () => {
          ffmpegRunning = false;
        });

        proc.stdin.write(input);
        proc.stdin.end();
      } catch (_) {
        ffmpegRunning = false;
      }
    });

    // ── Continuous H264→MJPEG streaming decoder ────────────────────
    // Battery cameras (peephole, doorbell) send H.264 via P2P tunnel
    // but don't support WebRTC or RTSP StreamAllocation.  We spawn a
    // persistent ffmpeg process to convert H.264→MJPEG in real-time
    // and push frames to the mobile app as a live stream.
    //
    // The decoder is started lazily when the first h264_nal arrives.

    p2p._h264StreamBuffer = Buffer.alloc(0);
    p2p._h264FrameCount = 0;
    p2p._h264StreamProc = null;
    p2p._h264RestartTimer = null;

    function spawnH264Decoder() {
      if (p2p._h264StreamProc) {
        try {
          p2p._h264StreamProc.kill();
        } catch (_) {}
        p2p._h264StreamProc = null;
      }

      try {
        const { spawn } = require("child_process");
        const proc = spawn(
          "ffmpeg",
          [
            "-f",
            "h264",
            "-i",
            "pipe:0",
            "-f",
            "image2pipe",
            "-q:v",
            "5",
            "-an",
            "pipe:1",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );

        // Suppress ffmpeg log output
        proc.stderr.on("data", () => {});

        proc.stdout.on("data", (chunk) => {
          p2p._h264StreamBuffer = Buffer.concat([p2p._h264StreamBuffer, chunk]);

          // Extract complete JPEG frames (0xFF 0xD8 … 0xFF 0xD9)
          while (p2p._h264StreamBuffer.length > 1) {
            const startIdx = p2p._h264StreamBuffer.indexOf(
              Buffer.from([0xff, 0xd8]),
            );
            if (startIdx === -1) {
              p2p._h264StreamBuffer = Buffer.alloc(0);
              break;
            }

            let endIdx = -1;
            for (
              let i = startIdx + 2;
              i < p2p._h264StreamBuffer.length - 1;
              i++
            ) {
              if (
                p2p._h264StreamBuffer[i] === 0xff &&
                p2p._h264StreamBuffer[i + 1] === 0xd9
              ) {
                endIdx = i + 2;
                break;
              }
            }
            if (endIdx === -1) break;

            const jpeg = p2p._h264StreamBuffer.slice(startIdx, endIdx);
            p2p._h264FrameCount++;

            api.sendMjpegFrame(doimusID, "main", jpeg);
            api.updateDeviceImage(
              doimusID,
              "snapshot_live",
              jpeg,
              "image/jpeg",
            );

            if (p2p._h264FrameCount % 30 === 0) {
              log(
                "debug",
                `[P2P] ${p2p._h264FrameCount} H264→MJPEG frames sent for "${tuyaDevice.name}"`,
              );
            }

            p2p._h264StreamBuffer = p2p._h264StreamBuffer.slice(endIdx);
          }
        });

        proc.on("error", (err) => {
          log(
            "warn",
            `[P2P] H264 decoder error for "${tuyaDevice.name}": ${err.message}`,
          );
          p2p._h264StreamProc = null;
          // Auto-restart after 1s if still streaming
          if (p2p.streaming && !p2p._h264RestartTimer) {
            p2p._h264RestartTimer = setTimeout(spawnH264Decoder, 1000);
          }
        });

        proc.on("close", (code) => {
          log(
            "debug",
            `[P2P] H264 decoder exited (code=${code}) for "${tuyaDevice.name}"`,
          );
          p2p._h264StreamProc = null;
          // Auto-restart after 1s if still streaming
          if (p2p.streaming && !p2p._h264RestartTimer) {
            p2p._h264RestartTimer = setTimeout(spawnH264Decoder, 1000);
          }
        });

        p2p._h264StreamProc = proc;
        log(
          "info",
          `[P2P] H264→MJPEG decoder started for "${tuyaDevice.name}"`,
        );
      } catch (e) {
        log(
          "debug",
          `[P2P] Failed to spawn H264 decoder for "${tuyaDevice.name}": ${e.message}`,
        );
      }
    }

    // ── Feed H264 data to the persistent decoder for live streaming ──
    // This runs in addition to the snapshot extraction above.
    // The h264_nal data already includes the Annex B start code (00 00 00 01).
    p2p.on("h264_nal_stream", (data) => {
      if (!p2p._h264StreamProc) {
        spawnH264Decoder();
      }
      if (p2p._h264StreamProc && p2p._h264StreamProc.stdin.writable) {
        try {
          p2p._h264StreamProc.stdin.write(data);
        } catch (_) {
          // ffmpeg may have crashed — the close handler will restart
        }
      }
    });

    // Forward original h264_nal to both the snapshot handler and the
    // streaming decoder by re-emitting on a secondary event.
    // The snapshot handler is already registered on "h264_nal" above.
    // We add a new listener that forwards to "h264_nal_stream".
    const origH264Handler = p2p.listeners("h264_nal").pop();
    p2p.removeListener("h264_nal", origH264Handler);
    p2p.on("h264_nal", (data) => {
      origH264Handler(data);
      p2p.emit("h264_nal_stream", data);
    });

    p2p.on("error", (err) => {
      log("error", `P2P error for "${tuyaDevice.name}": ${err.message}`);
      ctx.p2pClients.delete(doimusID);
    });

    p2p.on("close", () => {
      log("info", `P2P connection closed for "${tuyaDevice.name}"`);
      ctx.p2pClients.delete(doimusID);
      // Clean up the persistent H264 decoder
      if (p2p._h264RestartTimer) {
        clearTimeout(p2p._h264RestartTimer);
        p2p._h264RestartTimer = null;
      }
      if (p2p._h264StreamProc) {
        try {
          p2p._h264StreamProc.kill();
        } catch (_) {}
        p2p._h264StreamProc = null;
      }
    });

    p2p.on("streaming", (active) => {
      log(
        "info",
        `P2P streaming ${active ? "started" : "stopped"} for "${tuyaDevice.name}"`,
      );
      // If streaming stops, clean up the decoder to free resources
      if (!active && p2p._h264StreamProc) {
        if (p2p._h264RestartTimer) {
          clearTimeout(p2p._h264RestartTimer);
          p2p._h264RestartTimer = null;
        }
        try {
          p2p._h264StreamProc.kill();
        } catch (_) {}
        p2p._h264StreamProc = null;
      }
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
  // Clean up the persistent H264 decoder
  if (p2p._h264RestartTimer) {
    clearTimeout(p2p._h264RestartTimer);
    p2p._h264RestartTimer = null;
  }
  if (p2p._h264StreamProc) {
    try {
      p2p._h264StreamProc.kill();
    } catch (_) {}
    p2p._h264StreamProc = null;
  }
  p2p.close();
  ctx.p2pClients.delete(doimusID);
}

/**
 * Try the Tuya cloud stream allocation API to get an RTSP stream from
 * the camera, then proxy JPEG frames to the mobile app via the existing
 * MJPEG pipeline.
 *
 * This is a fallback when WebRTC and P2P both fail — some battery cameras
 * (especially "sp" category peepholes) respond better to the cloud-initiated
 * RTSP stream allocation than to direct P2P/WebRTC.
 */
async function startStreamAllocation(doimusID, tuyaDevice, ctx, log, api) {
  if (!tuyaDevice || !tuyaDevice.id || !ctx.deviceManager) return;

  const deviceName = tuyaDevice.name || "unknown";
  log("info", `[StreamAlloc] Trying stream allocation for "${deviceName}"`);

  // Call the Tuya stream allocation API
  let result;
  try {
    result = await ctx.deviceManager.api.post(
      `/v1.0/devices/${tuyaDevice.id}/stream/actions/allocate`,
      { type: "rtsp" },
    );
  } catch (e) {
    log(
      "debug",
      `[StreamAlloc] API call failed for "${deviceName}": ${e.message}`,
    );
    return;
  }

  if (!result || !result.success || !result.result || !result.result.url) {
    log(
      "debug",
      `[StreamAlloc] API returned no stream URL for "${deviceName}" (code=${result?.code} msg=${result?.msg})`,
    );
    return;
  }

  const streamUrl = result.result.url;
  const streamId = result.result.stream_id || "";
  log(
    "info",
    `[StreamAlloc] Got stream URL for "${deviceName}" (stream_id=${streamId})`,
  );

  // Clean up any previous stream allocation for this device
  stopStreamAllocation(doimusID, ctx, log);

  // Spawn ffmpeg to connect to the RTSP stream and extract JPEG frames.
  // The RTSP URL from Tuya typically requires TCP transport.
  let buffer = Buffer.alloc(0);
  let frameCount = 0;
  let frameTimer = null;

  try {
    const { spawn } = require("child_process");
    const proc = spawn(
      "ffmpeg",
      [
        "-rtsp_transport",
        "tcp",
        "-i",
        streamUrl,
        "-f",
        "mjpeg",
        "-q:v",
        "5",
        "-r",
        "5",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    // Suppress ffmpeg log output
    proc.stderr.on("data", () => {});

    if (!ctx._streamAllocProcs) ctx._streamAllocProcs = new Map();
    ctx._streamAllocProcs.set(doimusID, proc);

    proc.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Extract complete JPEG frames (marked by FF D8 ... FF D9)
      while (buffer.length > 1) {
        const startIdx = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (startIdx === -1) {
          buffer = Buffer.alloc(0);
          break;
        }

        // Find end of JPEG (0xFF 0xD9)
        let endIdx = -1;
        for (let i = startIdx + 2; i < buffer.length - 1; i++) {
          if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
            endIdx = i + 2;
            break;
          }
        }

        if (endIdx === -1) break; // incomplete frame, wait for more data

        const jpeg = buffer.slice(startIdx, endIdx);
        frameCount++;

        api.sendMjpegFrame(doimusID, "main", jpeg);
        api.updateDeviceImage(doimusID, "snapshot_live", jpeg, "image/jpeg");

        if (frameCount % 30 === 0) {
          log(
            "debug",
            `[StreamAlloc] ${frameCount} frames sent for "${deviceName}"`,
          );
        }

        buffer = buffer.slice(endIdx);
      }
    });

    // Timeout: if no frames within 15s, clean up
    frameTimer = setTimeout(() => {
      if (frameCount === 0) {
        log(
          "warn",
          `[StreamAlloc] No frames received within 15s for "${deviceName}" — giving up`,
        );
        stopStreamAllocation(doimusID, ctx, log);
      }
    }, 15000);
    if (frameTimer.unref) frameTimer.unref();

    proc.on("error", (err) => {
      log(
        "warn",
        `[StreamAlloc] ffmpeg error for "${deviceName}": ${err.message}`,
      );
      stopStreamAllocation(doimusID, ctx, log);
    });

    proc.on("close", (code) => {
      if (frameTimer) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
      if (ctx._streamAllocProcs?.get(doimusID) === proc) {
        ctx._streamAllocProcs.delete(doimusID);
      }
      log(
        "info",
        `[StreamAlloc] ffmpeg exited (code=${code}) for "${deviceName}"`,
      );
    });

    log("info", `[StreamAlloc] Streaming started for "${deviceName}"`);
  } catch (e) {
    log(
      "debug",
      `[StreamAlloc] ffmpeg spawn failed for "${deviceName}": ${e.message}`,
    );
  }
}

/**
 * Stop an active stream allocation ffmpeg process.
 */
function stopStreamAllocation(doimusID, ctx, log) {
  if (!ctx._streamAllocProcs) return;
  const proc = ctx._streamAllocProcs.get(doimusID);
  if (!proc) return;
  log("info", `Stopping stream allocation for device ${doimusID}`);
  try {
    proc.kill("SIGTERM");
  } catch (_) {}
  ctx._streamAllocProcs.delete(doimusID);
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
        // Command failed — log but do NOT push stale lastKnownState back
        // to the backend. The backend already updated the device state
        // (optimistically) before forwarding the command to us. Pushing
        // old state here would race with and overwrite that update.
        // The next MQTT status message from the device will correct any
        // drift naturally.
        log("error", `Command failed for ${tuyaDevice.id}: ${e.message}`);
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
      }, 30000);
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
      // ── WebRTC signaling relay ────────────────────────────────────
      if (key === "webrtc" && value && typeof value === "object") {
        const tuyaDevice = dm.getDevice(ctx.doimusDeviceMap.get(deviceID));
        if (!tuyaDevice) return;
        if (!ctx._webrtcClients) ctx._webrtcClients = new Map();
        let wr = ctx._webrtcClients.get(deviceID);

        if (value.action === "start") {
          log(
            "info",
            `[WebRTC] START command received for deviceID=${deviceID} tuyaID=${tuyaDevice.id} name="${tuyaDevice.name}" category=${tuyaDevice.category}`,
          );
          try {
            // Disconnect any existing session before creating a new one.
            const existing = ctx._webrtcClients.get(deviceID);
            if (existing) {
              log(
                "info",
                "[WebRTC] Disconnecting previous session before restart",
              );
              existing.disconnect();
              ctx._webrtcClients.delete(deviceID);
            }

            wr = new WebRTCSignaling(dm.api, log);
            ctx._webrtcClients.set(deviceID, wr);

            wr.on("config", (cfg) => {
              api.sendWebrtcSignaling(deviceID, { event: "config", ...cfg });
            });
            wr.on("answer", (data) => {
              api.sendWebrtcSignaling(deviceID, { event: "answer", ...data });
              // Send resolution command to start video encoding.
              // Tuya cameras wait for protocol 312 (type=resolution) after
              // answering the WebRTC offer. Without it, the camera sends a
              // disconnect ~10s later. This matches go2rtc's behavior.
              if (typeof wr.sendResolution === "function") {
                wr.sendResolution(0);
              }
            });
            wr.on("candidate", (data) => {
              api.sendWebrtcSignaling(deviceID, {
                event: "candidate",
                ...data,
              });
            });
            wr.on("disconnect", (data) => {
              // Battery-powered cameras (sp, doorbell) need ~40s to
              // fully boot from deep sleep after wake commands are sent.
              // WebRTC will fail (camera sends disconnect at ~T+10s)
              // because the video subsystem isn't ready yet.
              // Instead of immediately trying P2P/StreamAllocation
              // (which also fails), wait for the camera to finish
              // booting before attempting fallback streaming.
              const BATTERY_DELAY_MS = needsWake ? 45000 : 0;
              log(
                "info",
                `[WebRTC] Camera disconnected session=${data.sessionId}${needsWake ? ` — waiting ${BATTERY_DELAY_MS / 1000}s for battery camera to wake before fallback` : " — trying cloud stream allocation"}`,
              );
              api.sendWebrtcSignaling(deviceID, {
                event: "disconnect",
                ...data,
              });
              if (ctx._webrtcClients.has(deviceID)) {
                if (BATTERY_DELAY_MS > 0) {
                  // Cancel any previous pending fallback timer for this device
                  const prev = ctx._streamFallbackTimers.get(deviceID);
                  if (prev) clearTimeout(prev);
                  const timer = setTimeout(() => {
                    ctx._streamFallbackTimers.delete(deviceID);
                    log(
                      "info",
                      `[WebRTC] Battery camera delay elapsed — starting fallback streaming for "${tuyaDevice.name}"`,
                    );
                    if (ctx._webrtcClients.has(deviceID)) {
                      // Battery cameras may have a stale P2P connection
                      // from an earlier attempt when the camera was still
                      // asleep (deep sleep = no response to stream commands).
                      // Close it so we establish a fresh session now that
                      // the camera should be awake and responsive.
                      const staleP2P = ctx.p2pClients?.get(deviceID);
                      if (staleP2P) {
                        log(
                          "info",
                          `[WebRTC] Closing stale P2P for "${tuyaDevice.name}" before fresh reconnect`,
                        );
                        staleP2P.close();
                        ctx.p2pClients.delete(deviceID);
                      }
                      startP2P(deviceID, tuyaDevice, ctx, log, api);
                      startStreamAllocation(
                        deviceID,
                        tuyaDevice,
                        ctx,
                        log,
                        api,
                      ).catch((e) =>
                        log("debug", `[StreamAlloc] Failed: ${e.message}`),
                      );
                    }
                  }, BATTERY_DELAY_MS);
                  ctx._streamFallbackTimers.set(deviceID, timer);
                } else {
                  // Non-battery camera: try P2P/StreamAllocation immediately
                  startP2P(deviceID, tuyaDevice, ctx, log, api);
                  startStreamAllocation(
                    deviceID,
                    tuyaDevice,
                    ctx,
                    log,
                    api,
                  ).catch((e) =>
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
              // Battery cameras: the fallback timer fires when WebRTC
              // gets no answer (60s for battery cameras). This means
              // the camera hasn't responded at all — P2P/StreamAllocation
              // would also fail because the camera isn't ready. The
              // disconnect handler (fires at T+10) already scheduled
              // the fallback streaming after a 45s delay, so this is
              // mostly a safety net. For non-battery cameras, fire
              // immediately.
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
                tuyaDevice.category === "sp" ||
                tuyaDevice.category === "doorbell";
              if (!p2pCloudRelay) {
                startP2P(deviceID, tuyaDevice, ctx, log, api);
              }
              startStreamAllocation(deviceID, tuyaDevice, ctx, log, api).catch(
                (e) => log("debug", `[StreamAlloc] Failed: ${e.message}`),
              );
            });

            // Battery-powered cameras (peephole, doorbell) sleep to
            // conserve power and will not connect to the IPC MQTT broker
            // until woken.  Two-phase wake-up:
            //  1. Try a direct Tuya cloud command (cruise/basic_awake/video_call)
            //  2. getConfigs() calls the access-config API which also triggers
            //     a cloud push to the camera.
            // After both, poll for the camera to report online.
            //
            // Always wake battery cameras proactively — the cached online
            // status from the last MQTT heartbeat may be stale (the camera
            // enters low-power sleep between events).  The wake command is a
            // cheap cloud push the camera ignores if already awake.
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
            // Always wake battery cameras — even if they appear online now,
            // they may have entered low-power sleep since the last MQTT heartbeat.
            const needsWake = isCamera && hasBattery;
            log(
              "info",
              `[WebRTC] Camera check: category=${tuyaDevice.category} isCamera=${isCamera} hasBattery=${hasBattery} batteryCodes=[${batteryCodes.join(",")}] online=${tuyaDevice.online} needsWake=${needsWake}`,
            );

            // ── Battery camera wake (two-phase) ────────────────────
            // Phase 1: Send wake DP via cloud API (fire-and-forget, don't block)
            //          + start background wake watcher for wireless_awake=true
            // Phase 2: Immediately get configs + connect IPC MQTT (sends CRC32)
            //          The offer is buffered in WebRTCSignaling until
            //          setWoken() is called after wake confirmation.
            if (needsWake) {
              log(
                "info",
                `[WebRTC] Camera "${tuyaDevice.name}" is battery-powered, sending wake-up...`,
              );

              // ── Phase 1a: Send cloud DP wakes ───────────────────
              // Tuya battery cameras (peephole, doorbell) need their
              // video subsystem activated before WebRTC streaming can
              // work.  The CRC32 IPC MQTT wake only activates the
              // network module — the camera sensor/encoder stays in
              // deep sleep until performance mode is enabled.
              //
              // The official Tuya app always sends ipc_work_mode=1
              // (performance mode) before starting a video stream.
              // This is what turns on the camera's LED.  We must do
              // the same, even if ipc_work_mode is not in the device
              // schema — many battery cameras accept this command
              // despite not advertising it.
              //
              // Strategy: Send BOTH schema-matched wake DPs AND
              // always-send DPs (ipc_work_mode, wireless_powermode)
              // to maximise compatibility across camera models.

              // Always-send DPs: activate video subsystem regardless
              // of what the schema lists.
              const alwaysSendWakeDps = [
                // ipc_work_mode: 0=power saving, 1=performance.
                // Must be integer, not string — Tuya API rejects type mismatches.
                { code: "ipc_work_mode", value: 1 },
                // wireless_powermode: 0=power saving, 1=standard, 2=performance.
                // Some battery cameras need performance mode (2) to activate
                // the video encoder — standard mode (1) keeps it in sleep.
                { code: "wireless_powermode", value: 2 },
              ];

              // Schema-matched wake DPs (legacy logic).
              const wakeDpCodes = [
                "ipc_work_mode",
                "cruise",
                "basic_awake",
                "video_call",
                "wireless_awake",
              ];
              const schemaWakeDps =
                tuyaDevice.schema?.filter((s) =>
                  wakeDpCodes.includes(s.code),
                ) || [];

              // Merge: always-send wins over schema-matched.
              const wakeDpsMap = new Map();
              for (const dp of alwaysSendWakeDps) {
                wakeDpsMap.set(dp.code, dp);
              }
              for (const dp of schemaWakeDps) {
                if (!wakeDpsMap.has(dp.code)) {
                  const value = dp.code === "ipc_work_mode" ? 1 : true;
                  wakeDpsMap.set(dp.code, { code: dp.code, value });
                }
              }
              const wakeDps = Array.from(wakeDpsMap.values());

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

              // Track so we restore ipc_work_mode to "0" on disconnect.
              ctx._powerModeChanged = ctx._powerModeChanged || new Set();
              ctx._powerModeChanged.add(tuyaDevice.id);

              // ── Phase 1b: Background wake watcher (non-blocking) ──
              // Monitor cloud MQTT for wireless_awake=true from camera.
              // When confirmed, call wr.setWoken() to flush buffered offer.
              const WAKE_TIMEOUT_MS = 120000;

              // Send initial "waking" event so the mobile app can show
              // a "Camera is waking up..." status immediately.
              const wakeStartTime = Date.now();
              api.sendWebrtcSignaling(deviceID, {
                event: "waking",
                message: "Camera is waking up... (up to 120s)",
                elapsed: 0,
              });

              // Periodic progress logging and mobile app updates every 15s
              // so both the logs and the UI show the camera is coming.
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
              }, 15000);

              const wakeTimer = setTimeout(() => {
                clearInterval(progressInterval);
                ctx._wakeWatchers.delete(tuyaDevice.id);
                log(
                  "warn",
                  `[WebRTC] Wake timeout (${WAKE_TIMEOUT_MS / 1000}s) for "${tuyaDevice.name}" — flushing offer anyway (camera may wake later)`,
                );
                // Even if the camera didn't confirm wake, flush the
                // buffered offer as a fallback. The camera may have
                // woken up but we missed the MQTT message.
                if (wr && typeof wr.setWoken === "function") {
                  wr.setWoken();
                }
              }, WAKE_TIMEOUT_MS);
              ctx._wakeWatchers.set(tuyaDevice.id, {
                resolve: () => {
                  clearInterval(progressInterval);
                  clearTimeout(wakeTimer);
                  ctx._wakeWatchers.delete(tuyaDevice.id);
                  log(
                    "info",
                    `[WebRTC] Camera "${tuyaDevice.name}" wake confirmed — flushing WebRTC offer`,
                  );
                  // Tell WebRTCSignaling the camera is awake so it
                  // flushes the buffered offer to the IPC MQTT broker.
                  if (wr && typeof wr.setWoken === "function") {
                    wr.setWoken();
                  }
                },
                timer: wakeTimer,
                progressInterval,
              });
            }

            // ── Phase 1c: Wait for video subsystem to activate ──────
            // The cloud DP commands (ipc_work_mode=1) need time to
            // reach the camera and activate the video subsystem.
            // Without this delay, the camera receives the WebRTC
            // offer before the encoder is ready and responds with a
            // disconnect ~10s later.  Only applies to battery cameras.
            if (needsWake) {
              const WAKE_SETTLE_MS = 5000;
              log(
                "info",
                `[WebRTC] Waiting ${WAKE_SETTLE_MS / 1000}s for camera video subsystem to activate...`,
              );
              await new Promise((resolve) =>
                setTimeout(resolve, WAKE_SETTLE_MS),
              );
            }

            // ── Phase 2: Get configs + connect IPC MQTT ─────────────
            log(
              "info",
              `[WebRTC] Fetching configs for Tuya device ${tuyaDevice.id}`,
            );
            const configs = await wr.getConfigs(tuyaDevice.id);

            if (configs) {
              log("info", `[WebRTC] Configs fetched, connecting to IPC MQTT`);
              wr.connect(
                tuyaDevice.id,
                tuyaDevice.local_key,
                configs,
                needsWake,
              );
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
          // Clean up wake watcher if still pending
          const tuyaId = ctx.doimusDeviceMap.get(deviceID);
          if (tuyaId) {
            const existing = ctx._wakeWatchers.get(tuyaId);
            if (existing) {
              clearTimeout(existing.timer);
              if (existing.progressInterval)
                clearInterval(existing.progressInterval);
              ctx._wakeWatchers.delete(tuyaId);
              log(
                "info",
                `WebRTC disconnected — cleaned up wake watcher for device ${deviceID}`,
              );
            }

            // Restore ipc_work_mode to "0" (power-save) so the
            // battery camera doesn't stay in performance mode indefinitely.
            if (ctx._powerModeChanged?.has(tuyaId)) {
              const tuyaDevice = dm.getDevice(tuyaId);
              if (tuyaDevice) {
                dm.sendCommands(tuyaId, [
                  { code: "ipc_work_mode", value: 0 },
                  { code: "wireless_powermode", value: 0 },
                ]).then(
                  () => log("info", `WebRTC disconnected — restored power-save mode for "${tuyaDevice.name}"`),
                  (e) => log("debug", `[WebRTC] Restore power mode failed: ${e.message || e}`),
                );
              }
              ctx._powerModeChanged.delete(tuyaId);
            }
          }
          // Clean up any active stream allocation
          stopStreamAllocation(deviceID, ctx, log);
          // Clean up pending fallback timer for battery cameras
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
        return;
      }

      const tuyaID = ctx.doimusDeviceMap.get(deviceID);
      if (!tuyaID) {
        log(
          "warn",
          `onCommand: no Tuya device mapped for doimusID="${deviceID}" ` +
            `(key=${key}). Map has ${ctx.doimusDeviceMap.size} entries.`,
        );
        return;
      }
      try {
        const tuyaDevice = dm.getDevice(tuyaID);
        if (!tuyaDevice) return;

        // ── IR remote sub-devices ───────────────────────────────────────────
        if (tuyaDevice.isIRRemoteControl && tuyaDevice.isIRRemoteControl()) {
          if (tuyaDevice.category === "infrared_ac") {
            // Build complete AC command state from current status + delta.
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
            // Optimistically update state so UI reflects change immediately.
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
            // Non-AC IR remote — find the power key and send it.
            const keyList =
              tuyaDevice.remote_keys && tuyaDevice.remote_keys.key_list;
            if (keyList && key === "on") {
              const powerKey = keyList.find(
                (k) => k.key === "power" || /power/i.test(k.key_name || ""),
              );
              if (powerKey) {
                await dm.sendInfraredCommands(
                  tuyaDevice.parent_id,
                  tuyaDevice.id,
                  5, // category_id for generic IR
                  0, // remote_index
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
          return; // IR command handled — skip normal flow.
        }

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
            const anySwitch = tuyaDevice.schema.find(
              (s) => s.code && s.code.startsWith("switch"),
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
          // Match writable position DPs (percent_control, percent, position).
          // Exclude read-only codes ("percent_state") and direction-only
          // codes ("control_back" — takes "open"/"close"/"stop", not 0-100).
          const posSchema = tuyaDevice.schema.find(
            (s) =>
              (s.code &&
                s.code.startsWith("percent") &&
                s.code !== "percent_state") ||
              s.code === "position",
          );
          if (posSchema) {
            const cmd = buildCommand(tuyaDevice.schema, posSchema.code, value);
            log(
              "info",
              `POSITION command → DP=${posSchema.code} raw=${value} cmd=${JSON.stringify(cmd)}`,
            );
            commands.push(cmd);
          } else {
            log(
              "warn",
              `No writable position DP found for blind ${deviceID} ` +
                `(schema: [${(tuyaDevice.schema || []).map((s) => s.code).join(", ")}])`,
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
            (s) =>
              (s.code && s.code.startsWith("fan_speed")) ||
              s.code === "wind_speed",
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
          stopStreamAllocation(deviceID, ctx, log);
          return;
        }

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
      // Close all active stream allocation ffmpeg processes
      if (_ctx._streamAllocProcs) {
        for (const [, proc] of _ctx._streamAllocProcs) {
          try {
            proc.kill("SIGTERM");
          } catch (_) {}
        }
        _ctx._streamAllocProcs.clear();
      }
      // Clear motion auto-reset timers
      if (_ctx._motionTimers) {
        for (const [, timer] of _ctx._motionTimers) {
          clearTimeout(timer);
        }
        _ctx._motionTimers.clear();
      }
      // Clear motion coalesce timers (debounce + async S3/REST)
      if (_ctx._motionCoalesce) {
        for (const [, entry] of _ctx._motionCoalesce) {
          clearTimeout(entry.timer);
          clearTimeout(entry.asyncTimer);
        }
        _ctx._motionCoalesce.clear();
      }
      // Clear online snapshot timers
      if (_ctx._onlineSnapshotTimers) {
        for (const [, timer] of _ctx._onlineSnapshotTimers) {
          clearTimeout(timer);
        }
        _ctx._onlineSnapshotTimers.clear();
      }
      _ctx.apiRef = null;
      _ctx = null;
    }
  },
};
