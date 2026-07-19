const debounce = require("debounce");
const { kelvinToTuyaTemp } = require("./state-mapper");

function buildCommand(commandSchemas, code, value) {
  const schema = commandSchemas.find((s) => s.code === code);
  if (schema) {
    const { type } = schema;
    const scale =
      schema.property?.scale != null ? Math.pow(10, schema.property.scale) : 1;

    if (type === "Integer" && schema.property?.min !== undefined && schema.property?.max !== undefined) {
      const realMin = schema.property.min / scale;
      const realMax = schema.property.max / scale;
      if (typeof value === "number") {
        value = Math.max(realMin, Math.min(realMax, value));
      }
      return { code, value: Math.round(Number(value) * scale) };
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

  const debounced =
    ctx.debounceMap.get(key) ||
    debounce(async () => {
      const batch = ctx._pendingCommandBatches.get(key);
      if (!batch || batch.length === 0) return;
      ctx._pendingCommandBatches.delete(key);
      try {
        await ctx.deviceManager.sendCommands(tuyaDevice.id, batch);
      } catch (e) {
        log("error", `Command failed for ${tuyaDevice.id}: ${e.message}`);
      }
    }, 50);
  ctx.debounceMap.set(key, debounced);
  debounced();
}

function buildDeviceCommands(key, value, tuyaDevice, deviceID, log) {
  const commands = [];

  if (key === "on") {
    const onSchema = tuyaDevice.schema.find(
      (s) => s.code === "switch_1" || s.code === "switch_fan" || s.code === "fan_switch",
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
      const anySwitch = tuyaDevice.schema.find((s) => s.code && s.code.startsWith("switch"));
      if (anySwitch) {
        commands.push({ code: anySwitch.code, value: value === true });
      }
    }
  } else if (key === "brightness") {
    const brightSchema = tuyaDevice.schema.find(
      (s) => s.code === "bright_value" || s.code === "bright_value_v2" || s.code === "bright_value_1",
    );
    if (brightSchema) {
      const tuyaBrightness = Math.round((Number(value) / 100) * 1000);
      commands.push(buildCommand(tuyaDevice.schema, brightSchema.code, tuyaBrightness));
    }
  } else if (key === "color_temp") {
    const tempSchema = tuyaDevice.schema.find((s) => s.code === "temp_value" || s.code === "temp_value_v2");
    if (tempSchema) {
      const tuyaValue = kelvinToTuyaTemp(value, tempSchema.property);
      commands.push({ code: tempSchema.code, value: tuyaValue });
    }
  } else if (key === "hue" || key === "saturation") {
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
  } else if (key === "target_temp") {
    const tempSetSchema = tuyaDevice.schema.find((s) => s.code === "temp_set" || s.code === "target_temp");
    if (tempSetSchema) {
      commands.push(buildCommand(tuyaDevice.schema, tempSetSchema.code, value));
    }
  } else if (key === "heating_mode") {
    const modeSchema = tuyaDevice.schema.find((s) => s.code === "mode" || s.code === "work_mode" || s.code === "hvac_mode");
    if (modeSchema) {
      commands.push(buildCommand(tuyaDevice.schema, modeSchema.code, value));
    }
  } else if (key === "locked") {
    commands.push({ code: "lock_state", value: value === true });
  } else if (key === "child_lock") {
    const childLockSchema = tuyaDevice.schema.find((s) => s.code === "child_lock");
    if (childLockSchema) {
      commands.push(buildCommand(tuyaDevice.schema, childLockSchema.code, value));
    }
  } else if (key === "position") {
    const posSchema = tuyaDevice.schema.find(
      (s) => (s.code && s.code.startsWith("percent") && s.code !== "percent_state") || s.code === "position",
    );
    if (posSchema) {
      const cmd = buildCommand(tuyaDevice.schema, posSchema.code, value);
      log("info", `POSITION command → DP=${posSchema.code} raw=${value} cmd=${JSON.stringify(cmd)}`);
      commands.push(cmd);
    } else {
      log("warn", `No writable position DP found for blind ${deviceID} ` +
        `(schema: [${(tuyaDevice.schema || []).map((s) => s.code).join(", ")}])`);
    }
  } else if (key === "control") {
    const controlSchema = tuyaDevice.schema.find((s) => s.code === "control" || s.code === "control_back");
    if (controlSchema) {
      commands.push({ code: controlSchema.code, value: String(value) });
    }
  } else if (key === "rotation_speed") {
    const speedSchema = tuyaDevice.schema.find(
      (s) => (s.code && s.code.startsWith("fan_speed")) || s.code === "wind_speed",
    );
    if (speedSchema) {
      commands.push(buildCommand(tuyaDevice.schema, speedSchema.code, value));
    }
  } else if (key === "mode") {
    commands.push({ code: "work_state", value: String(value) });
  } else if (key === "countdown") {
    const countdownSchema = tuyaDevice.schema.find((s) => s.code === "countdown" || s.code === "count_down");
    if (countdownSchema) {
      commands.push(buildCommand(tuyaDevice.schema, countdownSchema.code, value));
    }
  }

  return commands;
}

module.exports = {
  sendCommandsDebounced,
  buildDeviceCommands,
};
