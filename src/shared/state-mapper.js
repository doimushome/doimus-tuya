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

// Lookup table: status DP code → handler(state, value, device).
// Keeps the per-code mapping data-driven; the loop below just dispatches.
// Codes sharing logic (e.g. bright_value / bright_value_v2) are grouped.
const STATUS_CODE_MAP = {
  // ── switches & power ──
  // "switch" / "switch_N" handled separately (relay_status override logic).
  switch_hvac: (s, v) => {
    s.on = toBool(v);
  },
  switch_go: (s, v) => {
    s.on = toBool(v);
  },
  power: (s, v) => {
    s.on = v === "1" || toBool(v);
  },

  // ── brightness & color ──
  bright_value: (s, v) => {
    s.brightness = Math.min(100, Math.max(0, Math.round((toNum(v) / 1000) * 100)));
    s._brightValue = toNum(v);
  },
  bright_value_v2: (s, v) => {
    s.brightness = Math.min(100, Math.max(0, Math.round((toNum(v) / 1000) * 100)));
    s._brightValue = toNum(v);
  },
  bright_value_1: (s, v) => {
    s.brightness = Math.min(100, Math.max(0, Math.round((toNum(v) / 1000) * 100)));
    s._brightValue = toNum(v);
  },
  temp_value: (s, v, d) => {
    const ts = d.schema?.find((x) => x.code === "temp_value");
    s.color_temp = tuyaTempToKelvin(v, ts?.property);
  },
  temp_value_v2: (s, v, d) => {
    const ts = d.schema?.find((x) => x.code === "temp_value_v2");
    s.color_temp = tuyaTempToKelvin(v, ts?.property);
  },
  colour_data: (s, v) => {
    if (typeof v === "object" && v !== null) {
      if (v.hue !== undefined) s.hue = toNum(v.hue);
      if (v.saturation !== undefined) s.saturation = toNum(v.saturation);
      if (v.value !== undefined) {
        s.brightness = Math.min(100, Math.max(0, Math.round((toNum(v.value) / 1000) * 100)));
      }
      s._colourData = v;
    }
  },
  colour_data_v2: (s, v) => {
    if (typeof v === "object" && v !== null) {
      if (v.hue !== undefined) s.hue = toNum(v.hue);
      if (v.saturation !== undefined) s.saturation = toNum(v.saturation);
      if (v.value !== undefined) {
        s.brightness = Math.min(100, Math.max(0, Math.round((toNum(v.value) / 1000) * 100)));
      }
      s._colourData = v;
    }
  },

  // ── scene & music ──
  scene_data: (s, v) => {
    s.scene = String(v);
  },
  scene_data_v2: (s, v) => {
    s.scene = String(v);
  },
  music_data: (s, v) => {
    s.scene = String(v);
  },

  // ── fan ──
  fan_speed: (s, v) => {
    s.rotation_speed = toNum(v);
  },
  fan_speed_percent: (s, v) => {
    s.rotation_speed = toNum(v);
  },
  wind_speed: (s, v) => {
    s.rotation_speed = toNum(v);
  },

  // ── locks ──
  lock_state: (s, v) => {
    s.locked = v === "locked" || toBool(v);
  },
  lock_sta: (s, v) => {
    s.locked = v === "locked" || toBool(v);
  },
  lock_motor_state: (s, v) => {
    s.locked = v === "locked" || toBool(v);
  },

  // ── doorbell & contact ──
  doorbell_state: (s, v) => {
    s.doorbell = toBool(v);
  },
  doorcontact: (s, v) => {
    s.doorbell = toBool(v);
  },
  contact_state: (s, v) => {
    s.contact = v === "open" || toBool(v);
  },
  doorcontact_state: (s, v) => {
    s.contact = v === "open" || toBool(v);
  },

  // ── temperature ──
  va_temperature: (s, v) => {
    s.temperature = toNum(v);
  },
  temp_current: (s, v) => {
    s.temperature = toNum(v);
  },
  temperature: (s, v) => {
    s.temperature = toNum(v);
  },
  temp_set: (s, v) => {
    s.target_temp = toNum(v);
  },
  target_temp: (s, v) => {
    s.target_temp = toNum(v);
  },

  // ── humidity ──
  va_humidity: (s, v) => {
    s.humidity = toNum(v);
  },
  humidity: (s, v) => {
    s.humidity = toNum(v);
  },
  humidity_value: (s, v) => {
    s.humidity = toNum(v);
  },

  // ── motion ──
  pir: (s, v) => {
    s.motion = v === true || v === "pir" || v === 1;
  },
  motion_sensor: (s, v) => {
    s.motion = v === true || v === "pir" || v === 1;
  },
  motion_detect: (s, v) => {
    s.motion = v === true || v === "pir" || v === 1;
  },

  // ── smoke & gas ──
  smoke_sensor: (s, v) => {
    s.smoke = toBool(v) || v === "alarm";
  },
  smoke_sensor_status: (s, v) => {
    s.smoke = toBool(v) || v === "alarm";
  },
  gas_sensor: (s, v) => {
    s.gas = toBool(v) || v === "alarm";
  },
  co_gas_sensor: (s, v) => {
    s.gas = toBool(v) || v === "alarm";
  },

  // ── battery ──
  battery_percentage: (s, v) => {
    s.battery = toNum(v);
  },
  battery_state: (s, v) => {
    s.battery = toNum(v);
  },
  va_battery: (s, v) => {
    s.battery = toNum(v);
  },
  wireless_electricity: (s, v) => {
    s.battery = toNum(v);
  },
  battery_value: (s, v) => {
    s.battery = toNum(v);
  },
  battery_low: (s, v) => {
    s.battery_low = toBool(v) || v === "low" || v === "alarm";
  },
  low_battery: (s, v) => {
    s.battery_low = toBool(v) || v === "low" || v === "alarm";
  },
  battery_alarm: (s, v) => {
    s.battery_low = toBool(v) || v === "low" || v === "alarm";
  },

  // ── leak ──
  water_sensor: (s, v) => {
    s.leak = toBool(v) || v === "alarm" || v === "leak";
  },
  water_leak: (s, v) => {
    s.leak = toBool(v) || v === "alarm" || v === "leak";
  },
  flood: (s, v) => {
    s.leak = toBool(v) || v === "alarm" || v === "leak";
  },
  ws: (s, v) => {
    s.leak = toBool(v) || v === "alarm" || v === "leak";
  },
  leak: (s, v) => {
    s.leak = toBool(v) || v === "alarm" || v === "leak";
  },

  // ── occupancy ──
  presence_state: (s, v) => {
    s.occupancy = toBool(v) || v === "presence" || v === "occupied" || v === "human";
  },
  occupancy: (s, v) => {
    s.occupancy = toBool(v) || v === "presence" || v === "occupied" || v === "human";
  },
  human: (s, v) => {
    s.occupancy = toBool(v) || v === "presence" || v === "occupied" || v === "human";
  },

  // ── outlet ──
  load_status: (s, v) => {
    s.outlet_in_use = toBool(v);
  },
  outlet_in_use: (s, v) => {
    s.outlet_in_use = toBool(v);
  },
  usb_state: (s, v) => {
    s.outlet_in_use = toBool(v);
  },

  // ── camera / doorbell motion DPs ──
  movement_detect_pic: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },
  ipc_human: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },
  doorbell_active: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },
  motion_switch: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },
  human_detect: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },
  person_detect: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },
  movement_detect: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },
  ipc_motion: (s, v, d) => {
    if (["sp", "mobilecam", "wxml", "doorbell"].includes(d.category) && typeof v === "string" && v.length > 0)
      s.motion = true;
  },

  // ── doorbell pic ──
  doorbell_pic: (s, v) => {
    s.doorbell = typeof v === "string" && v.length > 0;
  },

  // ── tamper ──
  tamper: (s, v) => {
    s.tamper = toBool(v) || v === "alarm" || v === "tamper";
  },
  tamper_state: (s, v) => {
    s.tamper = toBool(v) || v === "alarm" || v === "tamper";
  },
  tamper_alarm: (s, v) => {
    s.tamper = toBool(v) || v === "alarm" || v === "tamper";
  },
  sos: (s, v) => {
    s.tamper = toBool(v) || v === "alarm" || v === "sos";
  },
  sos_state: (s, v) => {
    s.tamper = toBool(v) || v === "alarm" || v === "sos";
  },

  // ── position ──
  percent_control: (s, v) => {
    s.position = toNum(v);
  },
  position: (s, v) => {
    s.position = toNum(v);
  },

  // ── control ──
  control_back: (s, v) => {
    s.control = String(v);
  },
  control: (s, v) => {
    s.control = String(v);
  },

  // ── hvac mode / heating ──
  work_state: (s, v) => {
    s.mode = String(v);
    if (typeof v === "number" && Number.isFinite(v)) {
      s.heating_mode = toNum(v);
    } else if (typeof v === "string") {
      const n = toNum(v);
      if (!isNaN(n) && v.trim() !== "") {
        s.heating_mode = n;
      } else {
        const modeMap = { auto: 3, heat: 1, hot: 1, warm: 1, cool: 2, cold: 2, off: 0 };
        const m = modeMap[v.toLowerCase()];
        if (m !== undefined) s.heating_mode = m;
      }
    }
  },
  mode: (s, v) => {
    s.mode = String(v);
    if (typeof v === "number" && Number.isFinite(v)) {
      s.heating_mode = toNum(v);
    } else if (typeof v === "string") {
      const n = toNum(v);
      if (!isNaN(n) && v.trim() !== "") {
        s.heating_mode = n;
      } else {
        const modeMap = { auto: 3, heat: 1, hot: 1, warm: 1, cool: 2, cold: 2, off: 0 };
        const m = modeMap[v.toLowerCase()];
        if (m !== undefined) s.heating_mode = m;
      }
    }
  },
  work_mode: (s, v) => {
    s.mode = String(v);
    if (typeof v === "number" && Number.isFinite(v)) s.heating_mode = toNum(v);
  },
  hvac_mode: (s, v) => {
    s.mode = String(v);
    if (typeof v === "number" && Number.isFinite(v)) s.heating_mode = toNum(v);
  },
  heat_state: (s, v) => {
    s.heating_state = toBool(v) ? 1 : 0;
    s.heating = toBool(v);
  },
  heater: (s, v) => {
    s.heating_state = toBool(v) ? 1 : 0;
    s.heating = toBool(v);
  },
  cool_state: (s, v) => {
    s.heating_state = toBool(v) ? 2 : 0;
    s.cooling = toBool(v);
  },
  cooler: (s, v) => {
    s.heating_state = toBool(v) ? 2 : 0;
    s.cooling = toBool(v);
  },

  // ── child lock ──
  child_lock: (s, v) => {
    s.child_lock = toBool(v);
  },

  // ── light (fallback on) ──
  light: (s, v) => {
    if (s.on === undefined) s.on = toBool(v);
  },

  // ── direction ──
  direction: (s, v) => {
    s.control = String(v);
  },
  remote_control: (s, v) => {
    s.control = String(v);
  },

  // ── robot / cleaning state ──
  status: (s, v) => {
    s.mode = String(v);
  },
  clean_state: (s, v) => {
    s.mode = String(v);
  },
  robot_state: (s, v) => {
    s.mode = String(v);
  },

  // ── suction ──
  suction: (s, v) => {
    if (s.rotation_speed === undefined) s.rotation_speed = toNum(v);
  },
  suction_power: (s, v) => {
    if (s.rotation_speed === undefined) s.rotation_speed = toNum(v);
  },

  // ── power monitoring ──
  cur_current: (s, v, d) => {
    s.current = toNum(v) / getScale(d, "cur_current");
  },
  cur_power: (s, v, d) => {
    s.power = toNum(v) / getScale(d, "cur_power");
  },
  cur_voltage: (s, v, d) => {
    s.voltage = toNum(v) / getScale(d, "cur_voltage");
  },
  meter_power: (s, v) => {
    s.energy = toNum(v);
  },
  total_forward_energy: (s, v) => {
    s.energy = toNum(v);
  },
  electricity: (s, v) => {
    s.current = toNum(v);
  },

  // ── swing ──
  swing: (s, v) => {
    s.swing = toBool(v) || v === "true";
  },
  swing_switch: (s, v) => {
    s.swing = toBool(v) || v === "true";
  },
  oscillate: (s, v) => {
    s.swing = toBool(v) || v === "true";
  },

  // ── position (read-only) ──
  percent_state: (s, v) => {
    s.position = toNum(v);
  },

  // ── countdown ──
  countdown: (s, v) => {
    s.countdown = toNum(v);
  },
  count_down: (s, v) => {
    s.countdown = toNum(v);
  },

  // ── air quality ──
  pm25: (s, v) => {
    s.pm25 = toNum(v);
  },
  pm25_value: (s, v) => {
    s.pm25 = toNum(v);
  },
  co2: (s, v) => {
    s.co2 = toNum(v);
  },
  co2_value: (s, v) => {
    s.co2 = toNum(v);
  },
  tvoc: (s, v) => {
    s.tvoc = toNum(v);
  },
  tvoc_value: (s, v) => {
    s.tvoc = toNum(v);
  },
  voc_value: (s, v) => {
    s.tvoc = toNum(v);
  },
  ch2o: (s, v) => {
    s.formaldehyde = toNum(v);
  },
  ch2o_value: (s, v) => {
    s.formaldehyde = toNum(v);
  },
  hcho: (s, v) => {
    s.formaldehyde = toNum(v);
  },
  hcho_value: (s, v) => {
    s.formaldehyde = toNum(v);
  },
  formaldehyde: (s, v) => {
    s.formaldehyde = toNum(v);
  },
  air_quality: (s, v) => {
    s.air_quality = String(v);
  },
  air_quality_index: (s, v) => {
    s.air_quality = String(v);
  },
  aqi: (s, v) => {
    s.aqi = toNum(v);
  },
  aqi_value: (s, v) => {
    s.aqi = toNum(v);
  },

  // ── environment ──
  uv_index: (s, v) => {
    s.uv_index = toNum(v);
  },
  uv: (s, v) => {
    s.uv_index = toNum(v);
  },
  uv_current: (s, v) => {
    s.uv_index = toNum(v);
  },
  lux: (s, v) => {
    s.illuminance = toNum(v);
  },
  illuminance: (s, v) => {
    s.illuminance = toNum(v);
  },
  illuminance_value: (s, v) => {
    s.illuminance = toNum(v);
  },
  noise: (s, v) => {
    s.noise = toNum(v);
  },
  noise_value: (s, v) => {
    s.noise = toNum(v);
  },
  decibel: (s, v) => {
    s.noise = toNum(v);
  },
  sound_intensity: (s, v) => {
    s.noise = toNum(v);
  },
  pressure: (s, v) => {
    s.pressure = toNum(v);
  },
  barometric_pressure: (s, v) => {
    s.pressure = toNum(v);
  },
  atm_pressure: (s, v) => {
    s.pressure = toNum(v);
  },

  // ── calibration & sensitivity ──
  calibration: (s, v) => {
    s.calibration = toBool(v) || v === "true";
  },
  sensitivity: (s, v) => {
    s.sensitivity = String(v);
  },
  sensitivity_set: (s, v) => {
    s.sensitivity = String(v);
  },
  keep_time: (s, v) => {
    s.keep_time = toNum(v);
  },
  keep_time_set: (s, v) => {
    s.keep_time = toNum(v);
  },

  // ── eco & frost ──
  eco: (s, v) => {
    s.eco_mode = toBool(v) || v === "true";
  },
  eco_mode: (s, v) => {
    s.eco_mode = toBool(v) || v === "true";
  },
  energy_saving: (s, v) => {
    s.eco_mode = toBool(v) || v === "true";
  },
  frost_protection: (s, v) => {
    s.frost_protection = toBool(v) || v === "true";
  },
  anti_freeze: (s, v) => {
    s.frost_protection = toBool(v) || v === "true";
  },

  // ── floor & outdoor temp ──
  floor_temp: (s, v) => {
    s.floor_temp = toNum(v);
  },
  floor_temperature: (s, v) => {
    s.floor_temp = toNum(v);
  },
  floor_temp_current: (s, v) => {
    s.floor_temp = toNum(v);
  },
  outdoor_temp: (s, v) => {
    s.outdoor_temp = toNum(v);
  },
  outdoor_temperature: (s, v) => {
    s.outdoor_temp = toNum(v);
  },
  outer_temp: (s, v) => {
    s.outdoor_temp = toNum(v);
  },

  // ── particulate ──
  pm1: (s, v) => {
    s.pm1 = toNum(v);
  },
  pm1_value: (s, v) => {
    s.pm1 = toNum(v);
  },
  pm10: (s, v) => {
    s.pm10 = toNum(v);
  },
  pm10_value: (s, v) => {
    s.pm10 = toNum(v);
  },

  // ── wind ──
  windspeed: (s, v) => {
    s.windspeed = toNum(v);
  },
  windspeed_avg: (s, v) => {
    s.windspeed = toNum(v);
  },
  wind_direct: (s, v) => {
    s.wind_direction = String(v);
  },
  wind_direction: (s, v) => {
    s.wind_direction = String(v);
  },

  // ── rain ──
  rain_24h: (s, v) => {
    s.rainfall = toNum(v);
  },
  rain_rate: (s, v) => {
    s.rainfall = toNum(v);
  },
  rainfall: (s, v) => {
    s.rainfall = toNum(v);
  },
  rain_value: (s, v) => {
    s.rainfall = toNum(v);
  },

  // ── soil ──
  soil_humidity: (s, v) => {
    s.soil_moisture = toNum(v);
  },
  soil_humidity_value: (s, v) => {
    s.soil_moisture = toNum(v);
  },
  soil_ec: (s, v) => {
    s.soil_ec = toNum(v);
  },
  soil_ec_value: (s, v) => {
    s.soil_ec = toNum(v);
  },
  soil_ph: (s, v) => {
    s.soil_ph = toNum(v) / 10;
  },
  soil_ph_value: (s, v) => {
    s.soil_ph = toNum(v) / 10;
  },
  soil_temperature: (s, v) => {
    s.soil_temperature = toNum(v);
  },
  soil_temp: (s, v) => {
    s.soil_temperature = toNum(v);
  },

  // ── anion ──
  anion: (s, v) => {
    s.anion = toBool(v) || v === "true";
  },
  anion_switch: (s, v) => {
    s.anion = toBool(v) || v === "true";
  },
  ionizer: (s, v) => {
    s.anion = toBool(v) || v === "true";
  },

  // ── night vision ──
  night_vision: (s, v) => {
    s.night_vision = toBool(v) || v === "true";
  },
  infrared_led: (s, v) => {
    s.night_vision = toBool(v) || v === "true";
  },
  night_mode: (s, v) => {
    s.night_vision = toBool(v) || v === "true";
  },
  basic_nightvision: (s, v) => {
    s.night_vision = String(v) !== "1" && v !== false;
  },

  // ── floodlight ──
  floodlight: (s, v) => {
    s.floodlight = toBool(v) || v === "true";
  },
  floodlight_switch: (s, v) => {
    s.floodlight = toBool(v) || v === "true";
  },
  floodlight_state: (s, v) => {
    s.floodlight = toBool(v) || v === "true";
  },

  // ── siren ──
  siren_state: (s, v) => {
    s.siren = toBool(v) || v === "true";
  },
  siren_switch: (s, v) => {
    s.siren = toBool(v) || v === "true";
  },
  alarm_state: (s, v) => {
    s.siren = toBool(v) || v === "true";
  },

  // ── recording ──
  record_state: (s, v) => {
    s.recording = toBool(v) || v === "true";
  },
  recording_switch: (s, v) => {
    s.recording = toBool(v) || v === "true";
  },
  ipc_record: (s, v) => {
    s.recording = toBool(v) || v === "true";
  },
  record_switch: (s, v) => {
    s.recording = toBool(v) || v === "true";
  },

  // ── sd card ──
  sd_status: (s, v) => {
    s.sd_status = String(v);
  },
  sd_card: (s, v) => {
    s.sd_status = String(v);
  },
  storage: (s, v) => {
    s.sd_status = String(v);
  },
  sd_state: (s, v) => {
    s.sd_status = String(v);
  },

  // ── privacy ──
  basic_private: (s, v) => {
    s.privacy_mode = toBool(v) || v === "true";
  },
  basics_private: (s, v) => {
    s.privacy_mode = toBool(v) || v === "true";
  },
  privacy_mode: (s, v) => {
    s.privacy_mode = toBool(v) || v === "true";
  },

  // ── ptz ──
  ptz_control: (s, v) => {
    s.ptz = String(v);
  },
  cruise: (s, v) => {
    s.ptz = String(v);
  },
  pid_cruise: (s, v) => {
    s.ptz = String(v);
  },

  // ── talkback ──
  talk_switch: (s, v) => {
    s.talkback = toBool(v) || v === "true";
  },
  audio_switch: (s, v) => {
    s.talkback = toBool(v) || v === "true";
  },
  audio_talk: (s, v) => {
    s.talkback = toBool(v) || v === "true";
  },

  // ── IR AC ──
  temp: (s, v) => {
    s.target_temp = toNum(v);
  },
  wind: (s, v) => {
    s.rotation_speed = toNum(v);
  },
};

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
