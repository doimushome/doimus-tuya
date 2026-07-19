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

module.exports = {
  CATEGORY_TO_DOIMUS_TYPE,
  applySchemaOverride,
  tuyaTempToKelvin,
  kelvinToTuyaTemp,
  getScale,
  mapTuyaStatusToDoimusState,
  determineCapabilities,
  getDoimusType,
  getDeviceConfig,
  getDeviceSchemaConfig,
};
