const { isIRRemoteControl } = require("./TuyaDevice");

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

const toBool = (v) => v === true || v === 1 || v === "true" || v === "1";
const toNum = (v) => Number(v);

// ── Named handler functions (defined once, referenced by multiple codes) ──
const setOn = (s, v) => { s.on = toBool(v); };
const setOnStr = (s, v) => { s.on = v === "1" || toBool(v); };
const setBrightness = (s, v) => {
  s.brightness = Math.min(100, Math.max(0, Math.round((toNum(v) / 1000) * 100)));
  s._brightValue = toNum(v);
};
const setColorTemp = (code) => (s, v, d) => {
  const ts = d.schema?.find((x) => x.code === code);
  s.color_temp = tuyaTempToKelvin(v, ts?.property);
};
const setColour = (s, v) => {
  if (typeof v === "object" && v !== null) {
    if (v.hue !== undefined) s.hue = toNum(v.hue);
    if (v.saturation !== undefined) s.saturation = toNum(v.saturation);
    if (v.value !== undefined) s.brightness = Math.min(100, Math.max(0, Math.round((toNum(v.value) / 1000) * 100)));
    s._colourData = v;
  }
};
const setScene = (s, v) => { s.scene = String(v); };
const setRotationSpeed = (s, v) => { s.rotation_speed = toNum(v); };
const setLocked = (s, v) => { s.locked = v === "locked" || toBool(v); };
const setDoorbell = (s, v) => { s.doorbell = toBool(v); };
const setContact = (s, v) => { s.contact = v === "open" || toBool(v); };
const setTemperature = (s, v) => { s.temperature = toNum(v); };
const setTargetTemp = (s, v) => { s.target_temp = toNum(v); };
const setHumidity = (s, v) => { s.humidity = toNum(v); };
const setMotion = (s, v) => { s.motion = v === true || v === "pir" || v === 1; };
const setSmoke = (s, v) => { s.smoke = toBool(v) || v === "alarm"; };
const setGas = (s, v) => { s.gas = toBool(v) || v === "alarm"; };
const setBattery = (s, v) => { s.battery = toNum(v); };
const setBatteryLow = (s, v) => { s.battery_low = toBool(v) || v === "low" || v === "alarm"; };
const setLeak = (s, v) => { s.leak = toBool(v) || v === "alarm" || v === "leak"; };
const setOccupancy = (s, v) => { s.occupancy = toBool(v) || v === "presence" || v === "occupied" || v === "human"; };
const setOutletInUse = (s, v) => { s.outlet_in_use = toBool(v); };
const setTamper = (s, v) => { s.tamper = toBool(v) || v === "alarm" || v === "tamper" || v === "sos"; };
const setPosition = (s, v) => { s.position = toNum(v); };
const setControl = (s, v) => { s.control = String(v); };
const setHeatingMode = (s, v) => {
  s.mode = String(v);
  if (typeof v === "number" && Number.isFinite(v)) {
    s.heating_mode = toNum(v);
  } else if (typeof v === "string") {
    const n = toNum(v);
    if (!isNaN(n) && v.trim() !== "") { s.heating_mode = n; }
    else { const m = { auto: 3, heat: 1, hot: 1, warm: 1, cool: 2, cold: 2, off: 0 }[v.toLowerCase()]; if (m !== undefined) s.heating_mode = m; }
  }
};
const setHeatingModeNum = (s, v) => { s.mode = String(v); if (typeof v === "number" && Number.isFinite(v)) s.heating_mode = toNum(v); };
const setHeatingState = (s, v) => { s.heating_state = toBool(v) ? 1 : 0; s.heating = toBool(v); };
const setCoolingState = (s, v) => { s.heating_state = toBool(v) ? 2 : 0; s.cooling = toBool(v); };
const setChildLock = (s, v) => { s.child_lock = toBool(v); };
const setLightFallback = (s, v) => { if (s.on === undefined) s.on = toBool(v); };
const setModeStr = (s, v) => { s.mode = String(v); };
const setSuction = (s, v) => { if (s.rotation_speed === undefined) s.rotation_speed = toNum(v); };
const setEnergy = (s, v) => { s.energy = toNum(v); };
const setCurrent = (s, v) => { s.current = toNum(v); };
const setSwing = (s, v) => { s.swing = toBool(v) || v === "true"; };
const setCountdown = (s, v) => { s.countdown = toNum(v); };
const setPm25 = (s, v) => { s.pm25 = toNum(v); };
const setCo2 = (s, v) => { s.co2 = toNum(v); };
const setTvoc = (s, v) => { s.tvoc = toNum(v); };
const setFormaldehyde = (s, v) => { s.formaldehyde = toNum(v); };
const setAirQuality = (s, v) => { s.air_quality = String(v); };
const setAqi = (s, v) => { s.aqi = toNum(v); };
const setUvIndex = (s, v) => { s.uv_index = toNum(v); };
const setIlluminance = (s, v) => { s.illuminance = toNum(v); };
const setNoise = (s, v) => { s.noise = toNum(v); };
const setPressure = (s, v) => { s.pressure = toNum(v); };
const setCalibration = (s, v) => { s.calibration = toBool(v) || v === "true"; };
const setSensitivity = (s, v) => { s.sensitivity = String(v); };
const setKeepTime = (s, v) => { s.keep_time = toNum(v); };
const setEcoMode = (s, v) => { s.eco_mode = toBool(v) || v === "true"; };
const setFrostProtection = (s, v) => { s.frost_protection = toBool(v) || v === "true"; };
const setFloorTemp = (s, v) => { s.floor_temp = toNum(v); };
const setOutdoorTemp = (s, v) => { s.outdoor_temp = toNum(v); };
const setPm1 = (s, v) => { s.pm1 = toNum(v); };
const setPm10 = (s, v) => { s.pm10 = toNum(v); };
const setWindspeed = (s, v) => { s.windspeed = toNum(v); };
const setWindDirection = (s, v) => { s.wind_direction = String(v); };
const setRainfall = (s, v) => { s.rainfall = toNum(v); };
const setSoilMoisture = (s, v) => { s.soil_moisture = toNum(v); };
const setSoilEc = (s, v) => { s.soil_ec = toNum(v); };
const setSoilPh = (s, v) => { s.soil_ph = toNum(v) / 10; };
const setSoilTemperature = (s, v) => { s.soil_temperature = toNum(v); };
const setAnion = (s, v) => { s.anion = toBool(v) || v === "true"; };
const setNightVision = (s, v) => { s.night_vision = toBool(v) || v === "true"; };
const setNightVisionBasic = (s, v) => { s.night_vision = String(v) !== "1" && v !== false; };
const setFloodlight = (s, v) => { s.floodlight = toBool(v) || v === "true"; };
const setSiren = (s, v) => { s.siren = toBool(v) || v === "true"; };
const setRecording = (s, v) => { s.recording = toBool(v) || v === "true"; };
const setSdStatus = (s, v) => { s.sd_status = String(v); };
const setPrivacyMode = (s, v) => { s.privacy_mode = toBool(v) || v === "true"; };
const setPtz = (s, v) => { s.ptz = String(v); };
const setTalkback = (s, v) => { s.talkback = toBool(v) || v === "true"; };
const setScaledCurrent = (code) => (s, v, d) => { s.current = toNum(v) / getScale(d, code); };
const setScaledPower = (code) => (s, v, d) => { s.power = toNum(v) / getScale(d, code); };
const setScaledVoltage = (code) => (s, v, d) => { s.voltage = toNum(v) / getScale(d, code); };

// Camera / doorbell motion DPs — identical handler, 8 codes.
const setCameraMotion = (s, v, d) => {
  if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
    s.motion = true;
};

// Helper: assign one handler to many codes.
const assign = (map, codes, handler) => { for (const c of codes) map[c] = handler; };

// Lookup table: status DP code → handler(state, value, device).
const STATUS_CODE_MAP = {};

// ── switches & power ──
STATUS_CODE_MAP.switch_hvac = setOn;
STATUS_CODE_MAP.switch_go = setOn;
STATUS_CODE_MAP.power = setOnStr;

// ── brightness & color ──
assign(STATUS_CODE_MAP, ["bright_value", "bright_value_v2", "bright_value_1"], setBrightness);
STATUS_CODE_MAP.temp_value = setColorTemp("temp_value");
STATUS_CODE_MAP.temp_value_v2 = setColorTemp("temp_value_v2");
assign(STATUS_CODE_MAP, ["colour_data", "colour_data_v2"], setColour);

// ── scene & music ──
assign(STATUS_CODE_MAP, ["scene_data", "scene_data_v2", "music_data"], setScene);

// ── fan ──
assign(STATUS_CODE_MAP, ["fan_speed", "fan_speed_percent", "wind_speed"], setRotationSpeed);

// ── locks ──
assign(STATUS_CODE_MAP, ["lock_state", "lock_sta", "lock_motor_state"], setLocked);

// ── doorbell & contact ──
assign(STATUS_CODE_MAP, ["doorbell_state", "doorcontact"], setDoorbell);
assign(STATUS_CODE_MAP, ["contact_state", "doorcontact_state"], setContact);

// ── temperature ──
assign(STATUS_CODE_MAP, ["va_temperature", "temp_current", "temperature"], setTemperature);
assign(STATUS_CODE_MAP, ["temp_set", "target_temp"], setTargetTemp);

// ── humidity ──
assign(STATUS_CODE_MAP, ["va_humidity", "humidity", "humidity_value"], setHumidity);

// ── motion ──
assign(STATUS_CODE_MAP, ["pir", "motion_sensor", "motion_detect"], setMotion);

// ── smoke & gas ──
assign(STATUS_CODE_MAP, ["smoke_sensor", "smoke_sensor_status"], setSmoke);
assign(STATUS_CODE_MAP, ["gas_sensor", "co_gas_sensor"], setGas);

// ── battery ──
assign(STATUS_CODE_MAP, ["battery_percentage", "battery_state", "va_battery", "wireless_electricity", "battery_value"], setBattery);
assign(STATUS_CODE_MAP, ["battery_low", "low_battery", "battery_alarm"], setBatteryLow);

// ── leak ──
assign(STATUS_CODE_MAP, ["water_sensor", "water_leak", "flood", "ws", "leak"], setLeak);

// ── occupancy ──
assign(STATUS_CODE_MAP, ["presence_state", "occupancy", "human"], setOccupancy);

// ── outlet ──
assign(STATUS_CODE_MAP, ["load_status", "outlet_in_use", "usb_state"], setOutletInUse);

// ── camera / doorbell motion DPs ──
assign(STATUS_CODE_MAP, ["movement_detect_pic", "ipc_human", "doorbell_active", "motion_switch", "human_detect", "person_detect", "movement_detect", "ipc_motion"], setCameraMotion);

// ── doorbell pic ──
STATUS_CODE_MAP.doorbell_pic = (s, v) => { s.doorbell = typeof v === "string" && v.length > 0; };

// ── tamper & sos ──
assign(STATUS_CODE_MAP, ["tamper", "tamper_state", "tamper_alarm", "sos", "sos_state"], setTamper);

// ── position ──
assign(STATUS_CODE_MAP, ["percent_control", "position"], setPosition);

// ── control ──
assign(STATUS_CODE_MAP, ["control_back", "control"], setControl);

// ── hvac mode / heating ──
assign(STATUS_CODE_MAP, ["work_state", "mode"], setHeatingMode);
assign(STATUS_CODE_MAP, ["work_mode", "hvac_mode"], setHeatingModeNum);
assign(STATUS_CODE_MAP, ["heat_state", "heater"], setHeatingState);
assign(STATUS_CODE_MAP, ["cool_state", "cooler"], setCoolingState);

// ── child lock ──
STATUS_CODE_MAP.child_lock = setChildLock;

// ── light (fallback on) ──
STATUS_CODE_MAP.light = setLightFallback;

// ── direction ──
assign(STATUS_CODE_MAP, ["direction", "remote_control"], setControl);

// ── robot / cleaning state ──
assign(STATUS_CODE_MAP, ["status", "clean_state", "robot_state"], setModeStr);

// ── suction ──
assign(STATUS_CODE_MAP, ["suction", "suction_power"], setSuction);

// ── power monitoring ──
STATUS_CODE_MAP.cur_current = setScaledCurrent("cur_current");
STATUS_CODE_MAP.cur_power = setScaledPower("cur_power");
STATUS_CODE_MAP.cur_voltage = setScaledVoltage("cur_voltage");
assign(STATUS_CODE_MAP, ["meter_power", "total_forward_energy"], setEnergy);
STATUS_CODE_MAP.electricity = setCurrent;

// ── swing ──
assign(STATUS_CODE_MAP, ["swing", "swing_switch", "oscillate"], setSwing);

// ── position (read-only) ──
STATUS_CODE_MAP.percent_state = setPosition;

// ── countdown ──
assign(STATUS_CODE_MAP, ["countdown", "count_down"], setCountdown);

// ── air quality ──
assign(STATUS_CODE_MAP, ["pm25", "pm25_value"], setPm25);
assign(STATUS_CODE_MAP, ["co2", "co2_value"], setCo2);
assign(STATUS_CODE_MAP, ["tvoc", "tvoc_value", "voc_value"], setTvoc);
assign(STATUS_CODE_MAP, ["ch2o", "ch2o_value", "hcho", "hcho_value", "formaldehyde"], setFormaldehyde);
assign(STATUS_CODE_MAP, ["air_quality", "air_quality_index"], setAirQuality);
assign(STATUS_CODE_MAP, ["aqi", "aqi_value"], setAqi);

// ── environment ──
assign(STATUS_CODE_MAP, ["uv_index", "uv", "uv_current"], setUvIndex);
assign(STATUS_CODE_MAP, ["lux", "illuminance", "illuminance_value"], setIlluminance);
assign(STATUS_CODE_MAP, ["noise", "noise_value", "decibel", "sound_intensity"], setNoise);
assign(STATUS_CODE_MAP, ["pressure", "barometric_pressure", "atm_pressure"], setPressure);

// ── calibration & sensitivity ──
STATUS_CODE_MAP.calibration = setCalibration;
assign(STATUS_CODE_MAP, ["sensitivity", "sensitivity_set"], setSensitivity);
assign(STATUS_CODE_MAP, ["keep_time", "keep_time_set"], setKeepTime);

// ── eco & frost ──
assign(STATUS_CODE_MAP, ["eco", "eco_mode", "energy_saving"], setEcoMode);
assign(STATUS_CODE_MAP, ["frost_protection", "anti_freeze"], setFrostProtection);

// ── floor & outdoor temp ──
assign(STATUS_CODE_MAP, ["floor_temp", "floor_temperature", "floor_temp_current"], setFloorTemp);
assign(STATUS_CODE_MAP, ["outdoor_temp", "outdoor_temperature", "outer_temp"], setOutdoorTemp);

// ── particulate ──
assign(STATUS_CODE_MAP, ["pm1", "pm1_value"], setPm1);
assign(STATUS_CODE_MAP, ["pm10", "pm10_value"], setPm10);

// ── wind ──
assign(STATUS_CODE_MAP, ["windspeed", "windspeed_avg"], setWindspeed);
assign(STATUS_CODE_MAP, ["wind_direct", "wind_direction"], setWindDirection);

// ── rain ──
assign(STATUS_CODE_MAP, ["rain_24h", "rain_rate", "rainfall", "rain_value"], setRainfall);

// ── soil ──
assign(STATUS_CODE_MAP, ["soil_humidity", "soil_humidity_value"], setSoilMoisture);
assign(STATUS_CODE_MAP, ["soil_ec", "soil_ec_value"], setSoilEc);
assign(STATUS_CODE_MAP, ["soil_ph", "soil_ph_value"], setSoilPh);
assign(STATUS_CODE_MAP, ["soil_temperature", "soil_temp"], setSoilTemperature);

// ── anion ──
assign(STATUS_CODE_MAP, ["anion", "anion_switch", "ionizer"], setAnion);

// ── night vision ──
assign(STATUS_CODE_MAP, ["night_vision", "infrared_led", "night_mode"], setNightVision);
STATUS_CODE_MAP.basic_nightvision = setNightVisionBasic;

// ── floodlight ──
assign(STATUS_CODE_MAP, ["floodlight", "floodlight_switch", "floodlight_state"], setFloodlight);

// ── siren ──
assign(STATUS_CODE_MAP, ["siren_state", "siren_switch", "alarm_state"], setSiren);

// ── recording ──
assign(STATUS_CODE_MAP, ["record_state", "recording_switch", "ipc_record", "record_switch"], setRecording);

// ── sd card ──
assign(STATUS_CODE_MAP, ["sd_status", "sd_card", "storage", "sd_state"], setSdStatus);

// ── privacy ──
assign(STATUS_CODE_MAP, ["basic_private", "basics_private", "privacy_mode"], setPrivacyMode);

// ── ptz ──
assign(STATUS_CODE_MAP, ["ptz_control", "cruise", "pid_cruise"], setPtz);

// ── talkback ──
assign(STATUS_CODE_MAP, ["talk_switch", "audio_switch", "audio_talk"], setTalkback);

// ── IR AC ──
STATUS_CODE_MAP.temp = setTargetTemp;
STATUS_CODE_MAP.wind = setRotationSpeed;

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

    // ── switch / switch_N (with relay_status override) ──
    if (
      code === "switch" ||
      (code != null &&
        code.startsWith("switch_") &&
        !isNaN(Number(code.slice(7))))
    ) {
      // Defer to relay_status if present — it reflects physical relay state,
      // while switch_N is a desired-state cached by Tuya Cloud that may be
      // stale when the device is offline.
      if (state._relayOverride === undefined) {
        state.on = toBool(value);
      }
      continue;
    }
    if (code === "relay_status") {
      // relay_status is authoritative: "power_on" → on=true, "power_off" → on=false.
      // Override any switch_1-derived value and mark the override so switch_1
      // (which may appear later in the status list) doesn't overwrite it.
      state.on = value === "power_on" || toBool(value);
      state._relayOverride = true;
      continue;
    }
    // ── switch_fan / fan_switch (fallback on) ──
    if (code === "switch_fan" || code === "fan_switch") {
      if (state.on === undefined) state.on = value === true || value === 1;
      continue;
    }

    // ── data-driven dispatch via lookup table ──
    const handler = STATUS_CODE_MAP[code];
    if (handler) {
      handler(state, value, device);
      continue;
    }

    // ── generic motion fallback ──
    if (
      MOTION_DP_PATTERN.test(code) &&
      (typeof value === "string" ? value.length > 0 : !!value)
    ) {
      state.motion = true;
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

// Base capabilities applied unconditionally per Doimus type.
const CAPABILITY_BASE = {
  light: ["on"],
  fan: ["on"],
  blind: ["on"],
  lock: ["on"],
  thermostat: ["on"],
  sensor: [],
  outlet: ["on"],
  switch: ["on"],
  camera: ["on", "p2p_start", "p2p_stop", "video"],
  doorbell: ["doorbell", "p2p_start", "p2p_stop"],
};

// Conditional capabilities per Doimus type. Each entry: { caps, test }.
// `caps` is a string or array of capability names; `test(schema)` returns
// whether the capability applies. Evaluated in order.
const CAPABILITY_MATRIX = {
  light: [
    { caps: "brightness", test: (s) => s.some((c) => c.code && c.code.startsWith("bright")) },
    { caps: "color_temp", test: (s) => s.some((c) => c.code && c.code.startsWith("temp_value")) },
    { caps: ["hue", "saturation", "brightness"], test: (s) => s.some((c) => c.code && c.code.startsWith("colour_data")) },
    { caps: "scene", test: (s) => s.some((c) => c.code === "scene_data" || c.code === "scene_data_v2" || c.code === "music_data") },
  ],
  fan: [
    { caps: "rotation_speed", test: (s) => s.some((c) => (c.code && c.code.startsWith("fan_speed")) || (c.code && c.code.startsWith("wind_speed")) || c.code === "suction" || c.code === "suction_power") },
    { caps: "swing", test: (s) => s.some((c) => c.code === "swing" || c.code === "swing_switch" || c.code === "oscillate") },
    { caps: "anion", test: (s) => s.some((c) => c.code === "anion" || c.code === "anion_switch" || c.code === "ionizer") },
  ],
  blind: [
    { caps: "position", test: (s) => s.some((c) => (c.code && c.code.startsWith("percent") && c.code !== "percent_state") || c.code === "position") },
    { caps: "control", test: (s) => s.some((c) => c.code === "control" || c.code === "control_back") },
  ],
  lock: [
    { caps: "locked", test: (s) => s.some((c) => c.code && c.code.startsWith("lock")) },
    { caps: "battery", test: (s) => s.some((c) => (c.code && c.code.startsWith("battery")) || c.code === "va_battery") },
    { caps: "battery_low", test: (s) => s.some((c) => c.code === "battery_low" || c.code === "low_battery" || c.code === "battery_alarm") },
    { caps: "contact", test: (s) => s.some((c) => c.code === "contact_state" || c.code === "doorcontact_state") },
    { caps: "tamper", test: (s) => s.some((c) => c.code === "tamper" || c.code === "tamper_state" || c.code === "tamper_alarm") },
  ],
  thermostat: [
    { caps: "target_temp", test: (s) => s.some((c) => (c.code && c.code.startsWith("temp_set")) || c.code === "target_temp") },
    { caps: "temperature", test: (s) => s.some((c) => (c.code && c.code.startsWith("temp_current")) || c.code === "temperature" || c.code === "va_temperature") },
    { caps: "heating_mode", test: (s) => s.some((c) => c.code === "mode" || c.code === "work_mode" || c.code === "hvac_mode" || c.code === "switch_hvac") },
    { caps: "heating_state", test: (s) => s.some((c) => c.code === "heat_state" || c.code === "heater" || c.code === "cool_state" || c.code === "cooler" || c.code === "work_state") },
    { caps: "humidity", test: (s) => s.some((c) => (c.code && c.code.startsWith("va_humidity")) || c.code === "humidity" || c.code === "humidity_value" || c.code === "humidity_current") },
    { caps: "eco_mode", test: (s) => s.some((c) => c.code === "eco" || c.code === "eco_mode" || c.code === "energy_saving") },
    { caps: "frost_protection", test: (s) => s.some((c) => c.code === "frost_protection" || c.code === "anti_freeze") },
  ],
  sensor: [
    { caps: "temperature", test: (s) => s.some((c) => (c.code && c.code.startsWith("va_temperature")) || c.code === "temperature" || c.code === "temp_current") },
    { caps: "humidity", test: (s) => s.some((c) => (c.code && c.code.startsWith("va_humidity")) || c.code === "humidity" || c.code === "humidity_value") },
    { caps: "motion", test: (s) => s.some((c) => c.code === "pir" || c.code === "motion_sensor") },
    { caps: "contact", test: (s) => s.some((c) => c.code === "contact_state" || c.code === "doorcontact_state") },
    { caps: "battery", test: (s) => s.some((c) => (c.code && c.code.startsWith("battery")) || c.code === "va_battery") },
    { caps: "smoke", test: (s) => s.some((c) => c.code && c.code.startsWith("smoke")) },
    { caps: "gas", test: (s) => s.some((c) => (c.code && c.code.startsWith("gas")) || c.code === "co_gas_sensor") },
    { caps: "leak", test: (s) => s.some((c) => c.code === "water_sensor" || c.code === "water_leak" || c.code === "flood" || c.code === "ws" || c.code === "leak") },
    { caps: "occupancy", test: (s) => s.some((c) => c.code === "presence_state" || c.code === "occupancy" || c.code === "human") },
    { caps: "battery_low", test: (s) => s.some((c) => c.code === "battery_low" || c.code === "low_battery" || c.code === "battery_alarm") },
    { caps: "tamper", test: (s) => s.some((c) => c.code === "tamper" || c.code === "tamper_state" || c.code === "tamper_alarm" || c.code === "sos" || c.code === "sos_state") },
    { caps: "current", test: (s) => s.some((c) => c.code === "cur_current" || c.code === "electricity") },
    { caps: "power", test: (s) => s.some((c) => c.code === "cur_power") },
    { caps: "voltage", test: (s) => s.some((c) => c.code === "cur_voltage") },
    { caps: "energy", test: (s) => s.some((c) => (c.code && c.code.startsWith("cur_")) || c.code === "electricity" || c.code === "meter_power" || c.code === "total_forward_energy") },
    { caps: "pm25", test: (s) => s.some((c) => c.code === "pm25" || c.code === "pm25_value") },
    { caps: "co2", test: (s) => s.some((c) => c.code === "co2" || c.code === "co2_value") },
    { caps: "tvoc", test: (s) => s.some((c) => c.code && (c.code.startsWith("tvoc") || c.code.startsWith("voc"))) },
    { caps: "formaldehyde", test: (s) => s.some((c) => c.code === "ch2o" || c.code === "ch2o_value" || c.code === "hcho" || c.code === "formaldehyde") },
    { caps: "air_quality", test: (s) => s.some((c) => c.code === "air_quality" || c.code === "air_quality_index") },
    { caps: "uv_index", test: (s) => s.some((c) => c.code === "uv_index" || c.code === "uv") },
    { caps: "illuminance", test: (s) => s.some((c) => c.code === "lux" || (c.code && c.code.startsWith("illuminance"))) },
    { caps: "noise", test: (s) => s.some((c) => c.code === "noise" || c.code === "decibel" || c.code === "sound_intensity") },
    { caps: "pressure", test: (s) => s.some((c) => c.code === "pressure" || c.code === "barometric_pressure" || c.code === "atm_pressure") },
    { caps: "pm1", test: (s) => s.some((c) => c.code === "pm1" || c.code === "pm1_value") },
    { caps: "pm10", test: (s) => s.some((c) => c.code === "pm10" || c.code === "pm10_value") },
    { caps: "windspeed", test: (s) => s.some((c) => c.code === "windspeed" || c.code === "windspeed_avg" || c.code === "wind_level") },
    { caps: "wind_direction", test: (s) => s.some((c) => c.code === "wind_direct" || c.code === "wind_direction") },
    { caps: "rainfall", test: (s) => s.some((c) => c.code === "rain_24h" || c.code === "rain_rate" || c.code === "rainfall") },
    { caps: "soil_moisture", test: (s) => s.some((c) => c.code === "soil_humidity" || c.code === "soil_humidity_value") },
    { caps: "soil_temperature", test: (s) => s.some((c) => c.code === "soil_temperature" || c.code === "soil_temp") },
  ],
  outlet: [
    { caps: "current", test: (s) => s.some((c) => c.code === "cur_current" || c.code === "electricity") },
    { caps: "power", test: (s) => s.some((c) => c.code === "cur_power") },
    { caps: "voltage", test: (s) => s.some((c) => c.code === "cur_voltage") },
    { caps: "energy", test: (s) => s.some((c) => c.code === "meter_power" || c.code === "total_forward_energy") },
    { caps: "outlet_in_use", test: (s) => s.some((c) => c.code === "load_status" || c.code === "outlet_in_use" || c.code === "usb_state") },
    { caps: "mode", test: (s) => s.some((c) => c.code === "work_state" || c.code === "mode" || c.code === "status" || c.code === "clean_state" || c.code === "robot_state") },
    { caps: "motion", test: (s) => s.some((c) => c.code === "motion_sensor" || c.code === "pir" || c.code === "motion_detect" || c.code === "movement_detect_pic") },
    { caps: "battery", test: (s) => s.some((c) => (c.code && c.code.startsWith("battery")) || c.code === "va_battery") },
    { caps: "night_vision", test: (s) => s.some((c) => c.code === "night_vision" || c.code === "infrared_led" || c.code === "night_mode") },
    { caps: "floodlight", test: (s) => s.some((c) => c.code === "floodlight" || c.code === "floodlight_switch" || c.code === "floodlight_state") },
    { caps: "siren", test: (s) => s.some((c) => c.code === "siren_state" || c.code === "siren_switch" || c.code === "alarm_state") },
  ],
  switch: [
    { caps: "current", test: (s) => s.some((c) => c.code === "cur_current" || c.code === "electricity") },
    { caps: "power", test: (s) => s.some((c) => c.code === "cur_power") },
    { caps: "voltage", test: (s) => s.some((c) => c.code === "cur_voltage") },
    { caps: "energy", test: (s) => s.some((c) => c.code === "meter_power" || c.code === "total_forward_energy") },
    { caps: "outlet_in_use", test: (s) => s.some((c) => c.code === "load_status" || c.code === "outlet_in_use" || c.code === "usb_state") },
    { caps: "mode", test: (s) => s.some((c) => c.code === "work_state" || c.code === "mode" || c.code === "status" || c.code === "clean_state" || c.code === "robot_state") },
    { caps: "motion", test: (s) => s.some((c) => c.code === "motion_sensor" || c.code === "pir" || c.code === "motion_detect" || c.code === "movement_detect_pic") },
    { caps: "battery", test: (s) => s.some((c) => (c.code && c.code.startsWith("battery")) || c.code === "va_battery") },
    { caps: "night_vision", test: (s) => s.some((c) => c.code === "night_vision" || c.code === "infrared_led" || c.code === "night_mode") },
    { caps: "floodlight", test: (s) => s.some((c) => c.code === "floodlight" || c.code === "floodlight_switch" || c.code === "floodlight_state") },
    { caps: "siren", test: (s) => s.some((c) => c.code === "siren_state" || c.code === "siren_switch" || c.code === "alarm_state") },
  ],
  camera: [
    { caps: "doorbell", test: (s) => s.some((c) => c.code === "movement_detect_pic" || c.code === "doorbell_pic" || c.code === "ipc_human") },
    { caps: "motion", test: (s) => s.some((c) => c.code === "motion_sensor" || c.code === "pir" || c.code === "motion_detect") },
    { caps: "battery", test: (s) => s.some((c) => c.code === "battery_percentage" || c.code === "battery_state" || c.code === "battery_value") },
    { caps: "night_vision", test: (s) => s.some((c) => c.code === "night_vision" || c.code === "infrared_led" || c.code === "night_mode" || c.code === "basic_nightvision") },
    { caps: "recording", test: (s) => s.some((c) => c.code === "record_switch" || c.code === "recording_switch" || c.code === "record_state" || c.code === "ipc_record" || c.code === "motion_record") },
    { caps: "floodlight", test: (s) => s.some((c) => c.code === "floodlight" || c.code === "floodlight_switch" || c.code === "floodlight_state") },
    { caps: "siren", test: (s) => s.some((c) => c.code === "siren_state" || c.code === "siren_switch" || c.code === "alarm_state") },
    { caps: "privacy_mode", test: (s) => s.some((c) => c.code === "basic_private" || c.code === "basics_private" || c.code === "privacy_mode") },
  ],
  doorbell: [
    { caps: "video", test: (s) => s.some((c) =>
      [
        "movement_detect_pic", "doorbell_pic", "floodlight", "floodlight_switch",
        "floodlight_state", "siren_state", "siren_switch", "alarm_state",
        "basic_private", "basics_private", "privacy_mode", "night_vision",
        "infrared_led", "night_mode", "basic_nightvision", "record_switch",
        "recording_switch", "record_state", "ipc_record", "motion_record",
        "ipc_human", "ipc_motion",
      ].includes(c.code)) },
    { caps: "motion", test: (s) => s.some((c) => c.code === "motion_sensor" || c.code === "pir" || c.code === "motion_detect" || c.code === "movement_detect_pic") },
    { caps: "battery", test: (s) => s.some((c) => (c.code && c.code.startsWith("battery")) || c.code === "va_battery") },
  ],
};

function determineCapabilities(device) {
  const doimusType = CATEGORY_TO_DOIMUS_TYPE[device.category] || "switch";
  const capabilities = new Set();

  // Base capabilities for this type.
  for (const cap of CAPABILITY_BASE[doimusType] || []) {
    capabilities.add(cap);
  }

  // mobilecam devices (Magic S1 etc.) have directional control.
  if (doimusType === "camera" && device.category === "mobilecam") {
    capabilities.add("control");
  }

  // Conditional capabilities from the matrix.
  const schema = device.schema;
  if (schema) {
    for (const { caps, test } of CAPABILITY_MATRIX[doimusType] || []) {
      if (test(schema)) {
        for (const cap of [].concat(caps)) {
          capabilities.add(cap);
        }
      }
    }
  }

  // IR remote sub-devices — schema is empty, detect capabilities from
  // remote_keys and IR AC status codes instead.
  if (isIRRemoteControl(device)) {
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
