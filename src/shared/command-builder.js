const { kelvinToTuyaTemp } = require("./state-mapper");

function buildCommand(commandSchemas, code, value) {
  const schema = commandSchemas.find((s) => s.code === code);
  if (schema) {
    const { type } = schema;
    const scale =
      schema.property?.scale != null ? Math.pow(10, schema.property.scale) : 1;

    if (type === "Integer" && schema.property?.min !== undefined && schema.property?.max !== undefined) {
      if (typeof value !== "number" || isNaN(value)) return { code, value: null };
      const realMin = schema.property.min / scale;
      const realMax = schema.property.max / scale;
      value = Math.max(realMin, Math.min(realMax, value));
      return { code, value: Math.round(value * scale) };
    }

    if (type === "Enum") {
      return { code, value: String(value) };
    }

    if (type === "Boolean") {
      return { code, value: value === true || value === 1 || value === "true" };
    }

    if (type === "Json") {
      return { code, value: typeof value === "string" ? value : JSON.stringify(value) };
    }

    if (type === "Raw") {
      return { code, value: String(value) };
    }

    if (type === "String") {
      return { code, value: String(value) };
    }
  }
  return { code, value };
}

function sendCommandsDebounced(tuyaDevice, commands, ctx, log) {
  const key = tuyaDevice.id;
  if (!ctx._pendingCommandBatches) ctx._pendingCommandBatches = new Map();

  const existing = ctx._pendingCommandBatches.get(key) || [];
  for (const cmd of commands) {
    const idx = existing.findIndex((e) => e.code === cmd.code);
    if (idx >= 0) existing[idx] = cmd;
    else existing.push(cmd);
  }
  ctx._pendingCommandBatches.set(key, existing);

  // Debounce flush by 50ms: clear any pending timer, then schedule a new one.
  if (!ctx.debounceMap) ctx.debounceMap = new Map();
  if (ctx.debounceMap.has(key)) clearTimeout(ctx.debounceMap.get(key));
  ctx.debounceMap.set(
    key,
    setTimeout(() => {
      ctx.debounceMap.delete(key);
      const batch = ctx._pendingCommandBatches.get(key);
      if (!batch || batch.length === 0) return;
      ctx._pendingCommandBatches.delete(key);
      ctx.deviceManager
        .sendCommands(tuyaDevice.id, batch)
        .catch((e) => log("error", `Command failed for ${tuyaDevice.id}: ${e.message}`));
    }, 50),
  );
}

// Command specs keyed by Doimus command name. Each entry describes how to find
// the target DP code(s) and how to build the value. `match` finds the schema
// entry; `value` transforms the incoming value (defaults to identity).
// `fallback` is an optional DP code used when no schema match is found.
const COMMAND_SPECS = {
  brightness: {
    match: (s) => s.code === "bright_value" || s.code === "bright_value_v2" || s.code === "bright_value_1",
    value: (v) => Math.round((Number(v) / 100) * 1000),
  },
  color_temp: {
    match: (s) => s.code === "temp_value" || s.code === "temp_value_v2",
    value: (v, s) => kelvinToTuyaTemp(v, s.property),
  },
  target_temp: {
    match: (s) => s.code === "temp_set" || s.code === "target_temp",
  },
  heating_mode: {
    match: (s) => s.code === "mode" || s.code === "work_mode" || s.code === "hvac_mode",
  },
  locked: {
    match: (s) => s.code === "lock_state" || s.code === "lock_sta" || s.code === "lock_motor_state",
    value: (v) => v === true,
  },
  child_lock: {
    match: (s) => s.code === "child_lock",
  },
  position: {
    match: (s) => (s.code && s.code.startsWith("percent") && s.code !== "percent_state") || s.code === "position",
    log: true,
  },
  control: {
    match: (s) => s.code === "control" || s.code === "control_back" || s.code === "direction" || s.code === "remote_control" || s.code === "ptz_control",
    value: (v) => String(v),
  },
  rotation_speed: {
    match: (s) => (s.code && s.code.startsWith("fan_speed")) || s.code === "wind_speed" || s.code === "suction" || s.code === "suction_power",
  },
  mode: {
    match: (s) => s.code === "work_state" || s.code === "status" || s.code === "clean_state" || s.code === "robot_state",
    fallback: "work_state",
  },
  swing: {
    match: (s) => s.code === "swing" || s.code === "swing_switch" || s.code === "oscillate",
  },
  anion: {
    match: (s) => s.code === "anion" || s.code === "anion_switch" || s.code === "ionizer",
  },
  eco_mode: {
    match: (s) => s.code === "eco" || s.code === "eco_mode" || s.code === "energy_saving",
  },
  night_vision: {
    match: (s) => s.code === "night_vision" || s.code === "infrared_led" || s.code === "night_mode" || s.code === "basic_nightvision",
    value: (v, s) => (s.code === "basic_nightvision" ? (v ? "2" : "1") : v),
  },
  floodlight: {
    match: (s) => s.code === "floodlight" || s.code === "floodlight_switch" || s.code === "floodlight_state",
  },
  siren: {
    match: (s) => s.code === "siren_state" || s.code === "siren_switch" || s.code === "alarm_state",
  },
  privacy_mode: {
    match: (s) => s.code === "basic_private" || s.code === "basics_private" || s.code === "privacy_mode",
  },
  scene: {
    match: (s) => s.code === "scene_data" || s.code === "scene_data_v2" || s.code === "music_data",
  },
  frost_protection: {
    match: (s) => s.code === "frost_protection" || s.code === "anti_freeze",
  },
  recording: {
    match: (s) => s.code === "record_switch" || s.code === "recording_switch" || s.code === "record_state" || s.code === "ipc_record",
  },
  countdown: {
    match: (s) => s.code === "countdown" || s.code === "count_down",
  },
};

function buildDeviceCommands(key, value, tuyaDevice, deviceID, log) {
  const commands = [];

  // "on" has cascading fallback logic + brightness restore — kept inline.
  if (key === "on") {
    const onSchema = tuyaDevice.schema.find(
      (s) => s.code === "switch_1" || s.code === "switch_fan" || s.code === "fan_switch" || s.code === "switch_go",
    );
    if (onSchema) {
      commands.push({ code: onSchema.code, value: value === true });
    } else if (tuyaDevice.schema.some((s) => s.code === "switch")) {
      commands.push({ code: "switch", value: value === true });
    } else if (tuyaDevice.schema.some((s) => s.code === "light")) {
      commands.push({ code: "light", value: value === true });
      if (value === true) {
        const brightSchema = tuyaDevice.schema.find(
          (s) => s.code === "bright_value" || s.code === "bright_value_v2" || s.code === "bright_value_1",
        );
        if (brightSchema) {
          const currentBright = tuyaDevice.status.find((s) => s.code === brightSchema.code);
          if (currentBright && currentBright.value !== undefined) {
            commands.push(buildCommand(tuyaDevice.schema, brightSchema.code, currentBright.value));
          }
        }
      }
    } else if (tuyaDevice.schema.some((s) => s.code === "switch_led")) {
      commands.push({ code: "switch_led", value: value === true });
    } else {
      const anySwitch = tuyaDevice.schema.find((s) => s.code && s.code.startsWith("switch") && s.mode !== "ro");
      if (anySwitch) {
        commands.push({ code: anySwitch.code, value: value === true });
      }
    }
    return commands;
  }

  // "hue" / "saturation" merge into the colour_data object — kept inline.
  if (key === "hue" || key === "saturation") {
    const colourSchema = tuyaDevice.schema.find((s) => s.code === "colour_data" || s.code === "colour_data_v2");
    if (colourSchema) {
      const currentColour = (tuyaDevice.status || []).find((s) => s.code === colourSchema.code);
      let colourData = { hue: 0, saturation: 0, value: 1000 };
      if (currentColour && typeof currentColour.value === "object") {
        colourData = { ...colourData, ...currentColour.value };
      }
      if (key === "hue") colourData.hue = Number(value);
      if (key === "saturation") colourData.saturation = Number(value);
      commands.push({ code: colourSchema.code, value: colourData });
    }
    return commands;
  }

  const spec = COMMAND_SPECS[key];
  if (!spec) return commands;

  const schema = tuyaDevice.schema.find((s) => spec.match(s));
  if (schema) {
    const val = spec.value ? spec.value(value, schema) : value;
    const cmd = buildCommand(tuyaDevice.schema, schema.code, val);
    if (spec.log) {
      log("info", `${key.toUpperCase()} command → DP=${schema.code} raw=${value} cmd=${JSON.stringify(cmd)}`);
    }
    commands.push(cmd);
  } else if (spec.fallback) {
    commands.push(buildCommand(tuyaDevice.schema, spec.fallback, value));
  } else if (spec.log) {
    log("warn", `No writable ${key} DP found for device ${deviceID} ` +
      `(schema: [${(tuyaDevice.schema || []).map((s) => s.code).join(", ")}])`);
  }

  return commands;
}

module.exports = {
  sendCommandsDebounced,
  buildCommand,
  buildDeviceCommands,
};
