const MOTION_DP_PATTERN = /motion|movement|doorbell|human|person|pir/i;

const CATEGORY_TO_DOIMUS_TYPE = {
  dj: "light",
  dsd: "light",
  xdd: "light",
  fwd: "light",
  fwl: "light",
  hxd: "light",
  mbd: "light",
  tyd: "light",
  dc: "outlet",
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
  sd: "switch",
  szjqr: "switch",
  cz: "outlet",
  pc: "outlet",
  wkcz: "outlet",
  wxkg: "switch",
  cjkg: "switch",
  bzyd: "light",
  kt: "thermostat",
  ktkzq: "thermostat",
  qtwk: "switch",
  qn: "thermostat",
  kj: "fan",
  xxj: "switch",
  ckmkzq: "switch",
  cl: "blind",
  clkg: "blind",
  jdcljqr: "blind",
  mc: "blind",
  wk: "thermostat",
  wkf: "thermostat",
  bgl: "thermostat",
  ntq: "thermostat",
  rs: "thermostat",
  znrb: "thermostat",
  ggq: "switch",
  sfkzq: "switch",
  jsq: "fan",
  cs: "fan",
  yyj: "fan",
  fs: "fan",
  fsd: "fan",
  ks: "fan",
  fskg: "fan",
  bh: "switch",
  kfj: "switch",
  cwysj: "switch",
  ykq: "switch",
  sp: "camera",
  mobilecam: "camera",
  dghsxq: "camera",
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
  voc: "sensor",
  ylcg: "sensor",
  jqbj: "sensor",
  zndb: "sensor",
  qxj: "sensor",
  mk: "lock",
  ms: "lock",
  gyms: "lock",
  hotelms: "lock",
  jtmsbh: "lock",
  jtmspro: "lock",
  ms_category: "lock",
  photolock: "lock",
  videolock: "lock",
  sgbj: "sensor",
  sos: "sensor",
  doorbell: "doorbell",
  wxml: "doorbell",
  wxky: "sensor",
  cwwsq: "switch",
  msp: "sensor",
  mal: "sensor",
  hjjcy: "sensor",
  aqcz: "sensor",
  dgnbj: "sensor",
  szjcy: "sensor",
  swtz: "sensor",
  ywcgq: "sensor",
  znsb: "sensor",
  zwjcy: "sensor",
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
  infrared_box: "switch",
  infrared_light: "switch",
  infrared_amplifier: "switch",
  infrared_projector: "switch",
  infrared_waterheater: "switch",
  infrared_airpurifier: "switch",
  infrared_humidifier: "switch",
  bjz: "sensor",
  ipc: "camera",
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
        if (schemaOverride.onGet && typeof schemaOverride.onGet === 'string') {
          try {
            const safeGetters = {
              "device.status": () => device.status,
              "device.value": () => device.value,
              "Number(value)": () => Number(value),
              "String(value)": () => String(value),
              "Boolean(value)": () => Boolean(value),
            };
            if (schemaOverride.onGet in safeGetters) {
              value = safeGetters[schemaOverride.onGet]();
            }
          } catch (_) { /* onGet expression error — skip */ }
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
    } else if (code === "scene_data" || code === "scene_data_v2") {
      state.scene = String(value);
    } else if (code === "music_data") {
      state.scene = String(value);
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
    } else if (
      code === "battery_percentage" ||
      code === "battery_state" ||
      code === "va_battery"
    ) {
      state.battery = Number(value);
    } else if (code === "wireless_electricity") {
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
      MOTION_DP_PATTERN.test(code) &&
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
    } else if (code === "switch_go") {
      state.on = value === true || value === 1;
    } else if (
      code === "direction" ||
      code === "remote_control"
    ) {
      state.control = String(value);
    } else if (
      code === "status" ||
      code === "clean_state" ||
      code === "robot_state"
    ) {
      state.mode = String(value);
    } else if (
      code === "suction" ||
      code === "suction_power"
    ) {
      if (state.rotation_speed === undefined) {
        state.rotation_speed = Number(value);
      }
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
    } else if (
      code === "swing" ||
      code === "swing_switch" ||
      code === "oscillate"
    ) {
      state.swing = value === true || value === 1 || value === "true";
    } else if (code === "percent_state") {
      state.position = Number(value);
    } else if (code === "countdown" || code === "count_down") {
      state.countdown = Number(value);
    } else if (code === "pm25" || code === "pm25_value") {
      state.pm25 = Number(value);
    } else if (code === "co2" || code === "co2_value") {
      state.co2 = Number(value);
    } else if (
      code === "tvoc" ||
      code === "tvoc_value" ||
      code === "voc_value"
    ) {
      state.tvoc = Number(value);
    } else if (
      code === "ch2o" ||
      code === "ch2o_value" ||
      code === "hcho" ||
      code === "hcho_value" ||
      code === "formaldehyde"
    ) {
      state.formaldehyde = Number(value);
    } else if (code === "air_quality" || code === "air_quality_index") {
      state.air_quality = String(value);
    } else if (
      code === "aqi" || code === "aqi_value"
    ) {
      state.aqi = Number(value);
    } else if (code === "uv_index" || code === "uv" || code === "uv_current") {
      state.uv_index = Number(value);
    } else if (
      code === "lux" ||
      code === "illuminance" ||
      code === "illuminance_value"
    ) {
      state.illuminance = Number(value);
    } else if (
      code === "noise" ||
      code === "noise_value" ||
      code === "decibel" ||
      code === "sound_intensity"
    ) {
      state.noise = Number(value);
    } else if (
      code === "pressure" ||
      code === "barometric_pressure" ||
      code === "atm_pressure"
    ) {
      state.pressure = Number(value);
    } else if (code === "calibration") {
      state.calibration = value === true || value === 1 || value === "true";
    } else if (code === "sensitivity" || code === "sensitivity_set") {
      state.sensitivity = String(value);
    } else if (code === "keep_time" || code === "keep_time_set") {
      state.keep_time = Number(value);
    } else if (code === "eco" || code === "eco_mode" || code === "energy_saving") {
      state.eco_mode = value === true || value === 1 || value === "true";
    } else if (code === "frost_protection" || code === "anti_freeze") {
      state.frost_protection = value === true || value === 1 || value === "true";
    } else if (
      code === "floor_temp" ||
      code === "floor_temperature" ||
      code === "floor_temp_current"
    ) {
      state.floor_temp = Number(value);
    } else if (code === "outdoor_temp" || code === "outdoor_temperature" || code === "outer_temp") {
      state.outdoor_temp = Number(value);
    } else if (code === "pm1" || code === "pm1_value") {
      state.pm1 = Number(value);
    } else if (code === "pm10" || code === "pm10_value") {
      state.pm10 = Number(value);
    } else if (
      code === "windspeed" ||
      code === "windspeed_avg"
    ) {
      state.windspeed = Number(value);
    } else if (code === "wind_direct" || code === "wind_direction") {
      state.wind_direction = String(value);
    } else if (
      code === "rain_24h" ||
      code === "rain_rate" ||
      code === "rainfall" ||
      code === "rain_value"
    ) {
      state.rainfall = Number(value);
    } else if (code === "soil_humidity" || code === "soil_humidity_value") {
      state.soil_moisture = Number(value);
    } else if (code === "soil_ec" || code === "soil_ec_value") {
      state.soil_ec = Number(value);
    } else if (code === "soil_ph" || code === "soil_ph_value") {
      state.soil_ph = Number(value) / 10;
    } else if (
      code === "soil_temperature" ||
      code === "soil_temp"
    ) {
      state.soil_temperature = Number(value);
    } else if (
      code === "anion" ||
      code === "anion_switch" ||
      code === "ionizer"
    ) {
      state.anion = value === true || value === 1 || value === "true";
    } else if (
      code === "night_vision" ||
      code === "infrared_led" ||
      code === "night_mode"
    ) {
      state.night_vision = value === true || value === 1 || value === "true";
    } else if (code === "basic_nightvision") {
      // Battery peephole/doorbell cameras (category sp) use a reversed enum
      // compared to wired IPC cameras: "0"=Auto, "1"=Off, "2"=On. Confirmed on
      // the video peephole: value "1" shows as Off in the Tuya app.
      // Auto keeps night vision active, so only "1" maps to off.
      state.night_vision = String(value) !== "1" && value !== false;
    } else if (
      code === "floodlight" ||
      code === "floodlight_switch" ||
      code === "floodlight_state"
    ) {
      state.floodlight = value === true || value === 1 || value === "true";
    } else if (
      code === "siren_state" ||
      code === "siren_switch" ||
      code === "alarm_state"
    ) {
      state.siren = value === true || value === 1 || value === "true";
    } else if (
      code === "record_state" ||
      code === "recording_switch" ||
      code === "ipc_record" ||
      code === "record_switch"
    ) {
      state.recording = value === true || value === 1 || value === "true";
    } else if (
      code === "sd_status" ||
      code === "sd_card" ||
      code === "storage" ||
      code === "sd_state"
    ) {
      state.sd_status = String(value);
    } else if (
      code === "basic_private" ||
      code === "basics_private" ||
      code === "privacy_mode"
    ) {
      state.privacy_mode = value === true || value === 1 || value === "true";
    } else if (
      code === "ptz_control" ||
      code === "cruise" ||
      code === "pid_cruise"
    ) {
      state.ptz = String(value);
    } else if (
      code === "talk_switch" ||
      code === "audio_switch" ||
      code === "audio_talk"
    ) {
      state.talkback = value === true || value === 1 || value === "true";
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
    const motionPattern = MOTION_DP_PATTERN;
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
  for (const key of Object.keys(state)) {
    if (key.startsWith("_")) delete state[key];
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
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "scene_data" || s.code === "scene_data_v2" || s.code === "music_data",
        )
      ) {
        capabilities.add("scene");
      }
      break;
    case "fan":
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code && s.code.startsWith("fan_speed")) ||
            (s.code && s.code.startsWith("wind_speed")) ||
            s.code === "suction" ||
            s.code === "suction_power",
        )
      ) {
        capabilities.add("rotation_speed");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "swing" ||
            s.code === "swing_switch" ||
            s.code === "oscillate",
        )
      ) {
        capabilities.add("swing");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "anion" ||
            s.code === "anion_switch" ||
            s.code === "ionizer",
        )
      ) {
        capabilities.add("anion");
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
          (s) => s.code === "contact_state" || s.code === "doorcontact_state",
        )
      ) {
        capabilities.add("contact");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "tamper" ||
            s.code === "tamper_state" ||
            s.code === "tamper_alarm",
        )
      ) {
        capabilities.add("tamper");
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
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code && s.code.startsWith("va_humidity")) ||
            s.code === "humidity" ||
            s.code === "humidity_value" ||
            s.code === "humidity_current",
        )
      ) {
        capabilities.add("humidity");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "eco" || s.code === "eco_mode" || s.code === "energy_saving",
        )
      ) {
        capabilities.add("eco_mode");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "frost_protection" || s.code === "anti_freeze",
        )
      ) {
        capabilities.add("frost_protection");
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
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "pm25" || s.code === "pm25_value",
        )
      ) {
        capabilities.add("pm25");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "co2" || s.code === "co2_value",
        )
      ) {
        capabilities.add("co2");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            (s.code && (s.code.startsWith("tvoc") || s.code.startsWith("voc"))),
        )
      ) {
        capabilities.add("tvoc");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "ch2o" ||
            s.code === "ch2o_value" ||
            s.code === "hcho" ||
            s.code === "formaldehyde",
        )
      ) {
        capabilities.add("formaldehyde");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "air_quality" || s.code === "air_quality_index",
        )
      ) {
        capabilities.add("air_quality");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "uv_index" || s.code === "uv",
        )
      ) {
        capabilities.add("uv_index");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "lux" ||
            (s.code && s.code.startsWith("illuminance")),
        )
      ) {
        capabilities.add("illuminance");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "noise" ||
            s.code === "decibel" ||
            s.code === "sound_intensity",
        )
      ) {
        capabilities.add("noise");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "pressure" ||
            s.code === "barometric_pressure" ||
            s.code === "atm_pressure",
        )
      ) {
        capabilities.add("pressure");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "pm1" || s.code === "pm1_value",
        )
      ) {
        capabilities.add("pm1");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "pm10" || s.code === "pm10_value",
        )
      ) {
        capabilities.add("pm10");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "windspeed" ||
            s.code === "windspeed_avg" ||
            s.code === "wind_level",
        )
      ) {
        capabilities.add("windspeed");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) => s.code === "wind_direct" || s.code === "wind_direction",
        )
      ) {
        capabilities.add("wind_direction");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "rain_24h" ||
            s.code === "rain_rate" ||
            s.code === "rainfall",
        )
      ) {
        capabilities.add("rainfall");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "soil_humidity" ||
            s.code === "soil_humidity_value",
        )
      ) {
        capabilities.add("soil_moisture");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "soil_temperature" ||
            s.code === "soil_temp",
        )
      ) {
        capabilities.add("soil_temperature");
      }
      break;
    case "outlet":
    case "switch":
      if (
        device.schema &&
        device.schema.some(
          (s) => (s.code && s.code.startsWith("cur_")) || s.code === "electricity",
        )
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
      // Robot/rover: mode, control (directional), battery capabilities
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "work_state" ||
            s.code === "mode" ||
            s.code === "status" ||
            s.code === "clean_state" ||
            s.code === "robot_state",
        )
      ) {
        capabilities.add("mode");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "motion_sensor" ||
            s.code === "pir" ||
            s.code === "motion_detect" ||
            s.code === "movement_detect_pic",
        )
      ) {
        capabilities.add("motion");
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
        device.schema.some(
          (s) =>
            s.code === "night_vision" ||
            s.code === "infrared_led" ||
            s.code === "night_mode",
        )
      ) {
        capabilities.add("night_vision");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "floodlight" ||
            s.code === "floodlight_switch" ||
            s.code === "floodlight_state",
        )
      ) {
        capabilities.add("floodlight");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "siren_state" ||
            s.code === "siren_switch" ||
            s.code === "alarm_state",
        )
      ) {
        capabilities.add("siren");
      }
      break;
    case "camera":
      capabilities.add("on");
      capabilities.add("p2p_start");
      capabilities.add("p2p_stop");
      // Cameras always have a video sensor — the mobile app uses this to decide
      // whether to show the snapshot square / live-view UI for a camera/doorbell
      // device (camera-less doorbells omit it).
      capabilities.add("video");
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
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "night_vision" ||
            s.code === "infrared_led" ||
            s.code === "night_mode" ||
            s.code === "basic_nightvision",
        )
      ) {
        capabilities.add("night_vision");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "record_switch" ||
            s.code === "recording_switch" ||
            s.code === "record_state" ||
            s.code === "ipc_record" ||
            s.code === "motion_record",
        )
      ) {
        capabilities.add("recording");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "floodlight" ||
            s.code === "floodlight_switch" ||
            s.code === "floodlight_state",
        )
      ) {
        capabilities.add("floodlight");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "siren_state" ||
            s.code === "siren_switch" ||
            s.code === "alarm_state",
        )
      ) {
        capabilities.add("siren");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "basic_private" ||
            s.code === "basics_private" ||
            s.code === "privacy_mode",
        )
      ) {
        capabilities.add("privacy_mode");
      }
      break;
    case "doorbell":
      capabilities.delete("on");
      capabilities.add("doorbell");
      capabilities.add("p2p_start");
      capabilities.add("p2p_stop");
      // A doorbell only has a camera when its schema exposes camera codes
      // (picture DPs, night vision, floodlight, recording, privacy, IPC…).
      // Audio-only intercoms omit them — the mobile app then hides the camera
      // UI, so we must not advertise "video" for those.
      if (
        device.schema &&
        device.schema.some((s) =>
          [
            "movement_detect_pic",
            "doorbell_pic",
            "floodlight",
            "floodlight_switch",
            "floodlight_state",
            "siren_state",
            "siren_switch",
            "alarm_state",
            "basic_private",
            "basics_private",
            "privacy_mode",
            "night_vision",
            "infrared_led",
            "night_mode",
            "basic_nightvision",
            "record_switch",
            "recording_switch",
            "record_state",
            "ipc_record",
            "motion_record",
            "ipc_human",
            "ipc_motion",
          ].includes(s.code),
        )
      ) {
        capabilities.add("video");
      }
      if (
        device.schema &&
        device.schema.some(
          (s) =>
            s.code === "motion_sensor" ||
            s.code === "pir" ||
            s.code === "motion_detect" ||
            s.code === "movement_detect_pic",
        )
      ) {
        capabilities.add("motion");
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

module.exports = {
  applySchemaOverride,
  kelvinToTuyaTemp,
  mapTuyaStatusToDoimusState,
  determineCapabilities,
  getDoimusType,
  CATEGORY_TO_DOIMUS_TYPE,
};
