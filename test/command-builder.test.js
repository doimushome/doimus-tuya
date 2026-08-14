"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDeviceCommands,
  buildCommand,
} = require("../src/shared/command-builder");

function makeSchema(code, type = "Boolean", props = {}) {
  return { code, type, ...props };
}

function makeDevice(category, schema = [], overrides = {}) {
  return { id: "dev-1", name: "Test", category, schema, ...overrides };
}

test("on=true for switch", () => {
  const device = makeDevice("kg", [makeSchema("switch", "Boolean")]);
  assert.deepEqual(buildDeviceCommands("on", true, device, "doimus-1", () => {}), [
    { code: "switch", value: true },
  ]);
});

test("on=false for switch", () => {
  const device = makeDevice("kg", [makeSchema("switch", "Boolean")]);
  assert.deepEqual(buildDeviceCommands("on", false, device, "doimus-1", () => {}), [
    { code: "switch", value: false },
  ]);
});

test("target_temp for thermostat with scale", () => {
  const device = makeDevice("wk", [
    makeSchema("temp_set", "Integer", { property: { min: 50, max: 300, scale: 1 } }),
  ]);
  assert.deepEqual(buildDeviceCommands("target_temp", 22, device, "doimus-1", () => {}), [
    { code: "temp_set", value: 220 },
  ]);
});

test("target_temp with no scale", () => {
  const device = makeDevice("wk", [makeSchema("temp_set", "Integer")]);
  assert.deepEqual(buildDeviceCommands("target_temp", 22, device, "doimus-1", () => {}), [
    { code: "temp_set", value: 22 },
  ]);
});

test("brightness scales 0-100 to 0-1000", () => {
  const device = makeDevice("dj", [makeSchema("bright_value", "Integer")]);
  assert.deepEqual(buildDeviceCommands("brightness", 75, device, "doimus-1", () => {}), [
    { code: "bright_value", value: 750 },
  ]);
});

test("brightness with bright_value_v2", () => {
  const device = makeDevice("dj", [makeSchema("bright_value_v2", "Integer")]);
  assert.deepEqual(buildDeviceCommands("brightness", 75, device, "doimus-1", () => {}), [
    { code: "bright_value_v2", value: 750 },
  ]);
});

test("position for cover", () => {
  const device = makeDevice("cl", [makeSchema("percent_control", "Integer")]);
  assert.deepEqual(buildDeviceCommands("position", 50, device, "doimus-1", () => {}), [
    { code: "percent_control", value: 50 },
  ]);
});

test("privacy_mode for camera", () => {
  const device = makeDevice("sp", [makeSchema("basic_private", "Boolean")]);
  assert.deepEqual(buildDeviceCommands("privacy_mode", true, device, "doimus-1", () => {}), [
    { code: "basic_private", value: true },
  ]);
});

test("scene for light", () => {
  const device = makeDevice("dj", [makeSchema("scene_data", "String")]);
  assert.deepEqual(buildDeviceCommands("scene", '{"id":3}', device, "doimus-1", () => {}), [
    { code: "scene_data", value: '{"id":3}' },
  ]);
});

test("eco_mode for thermostat", () => {
  const device = makeDevice("wk", [makeSchema("eco", "Boolean")]);
  assert.deepEqual(buildDeviceCommands("eco_mode", true, device, "doimus-1", () => {}), [
    { code: "eco", value: true },
  ]);
});

test("frost_protection with anti_freeze schema", () => {
  const device = makeDevice("wk", [makeSchema("anti_freeze", "Boolean")]);
  assert.deepEqual(
    buildDeviceCommands("frost_protection", true, device, "doimus-1", () => {}),
    [{ code: "anti_freeze", value: true }],
  );
});

test("night_vision", () => {
  const device = makeDevice("sp", [makeSchema("night_vision", "Enum")]);
  assert.deepEqual(buildDeviceCommands("night_vision", "auto", device, "doimus-1", () => {}), [
    { code: "night_vision", value: "auto" },
  ]);
});

test("night_vision — basic_nightvision enum via fallback schema", () => {
  const device = makeDevice("mobilecam", [makeSchema("basic_nightvision", "Enum")]);
  // Battery cameras use "0"=Auto, "1"=Off, "2"=On — map the boolean toggle to
  // On="2" / Off="1" (confirmed against the Tuya app on the video peephole).
  assert.deepEqual(buildDeviceCommands("night_vision", true, device, "doimus-1", () => {}), [
    { code: "basic_nightvision", value: "2" },
  ]);
  assert.deepEqual(buildDeviceCommands("night_vision", false, device, "doimus-1", () => {}), [
    { code: "basic_nightvision", value: "1" },
  ]);
});

test("control — mobilecam falls back to ptz_control", () => {
  const device = makeDevice("mobilecam", [makeSchema("ptz_control", "Enum")]);
  assert.deepEqual(buildDeviceCommands("control", "left", device, "doimus-1", () => {}), [
    { code: "ptz_control", value: "left" },
  ]);
});

test("floodlight", () => {
  const device = makeDevice("doorbell", [makeSchema("floodlight", "Enum")]);
  assert.deepEqual(buildDeviceCommands("floodlight", "on", device, "doimus-1", () => {}), [
    { code: "floodlight", value: "on" },
  ]);
});

test("siren", () => {
  const device = makeDevice("doorbell", [makeSchema("siren_switch", "Boolean")]);
  assert.deepEqual(buildDeviceCommands("siren", true, device, "doimus-1", () => {}), [
    { code: "siren_switch", value: true },
  ]);
});

test("recording with record_switch schema", () => {
  const device = makeDevice("sp", [makeSchema("record_switch", "Boolean")]);
  assert.deepEqual(
    buildDeviceCommands("recording", true, device, "doimus-1", () => {}),
    [{ code: "record_switch", value: true }],
  );
});

test("mode for vacuum", () => {
  const device = makeDevice("sz", [makeSchema("work_state", "Enum")]);
  assert.deepEqual(buildDeviceCommands("mode", "clean", device, "doimus-1", () => {}), [
    { code: "work_state", value: "clean" },
  ]);
});

test("locked sends lock_state", () => {
  const device = makeDevice("ms", [makeSchema("lock_state", "Enum")]);
  const cmds = buildDeviceCommands("locked", true, device, "doimus-1", () => {});
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].code, "lock_state");
});

test("unknown key returns empty", () => {
  const device = makeDevice("kg", [makeSchema("switch", "Boolean")]);
  assert.deepEqual(buildDeviceCommands("nonexistent", true, device, "doimus-1", () => {}), []);
});

test("anion for fan", () => {
  const device = makeDevice("fs", [makeSchema("anion", "Boolean")]);
  assert.deepEqual(buildDeviceCommands("anion", true, device, "doimus-1", () => {}), [
    { code: "anion", value: true },
  ]);
});

test("countdown command", () => {
  const device = makeDevice("kg", [makeSchema("countdown", "Integer")]);
  assert.deepEqual(buildDeviceCommands("countdown", 3600, device, "doimus-1", () => {}), [
    { code: "countdown", value: 3600 },
  ]);
});

test("swing for fan", () => {
  const device = makeDevice("fs", [makeSchema("swing", "Enum")]);
  const cmds = buildDeviceCommands("swing", true, device, "doimus-1", () => {});
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].code, "swing");
});

// ── buildCommand ──

test("buildCommand Boolean", () => {
  assert.deepEqual(buildCommand([makeSchema("switch", "Boolean")], "switch", true), {
    code: "switch", value: true,
  });
});

test("buildCommand Integer with scale clamps to range", () => {
  const schema = [makeSchema("temp_set", "Integer", { property: { min: 0, max: 500, scale: 1 } })];
  // scale=1 → realMin=0, realMax=50, so value 25 → 25*10=250
  assert.deepEqual(buildCommand(schema, "temp_set", 25), {
    code: "temp_set", value: 250,
  });
});

test("buildCommand Enum", () => {
  const schema = [makeSchema("mode", "Enum", { property: { range: ["white", "color", "scene"] } })];
  assert.deepEqual(buildCommand(schema, "mode", "color"), { code: "mode", value: "color" });
});

test("buildCommand String", () => {
  const schema = [makeSchema("scene_data", "String")];
  assert.deepEqual(buildCommand(schema, "scene_data", "test"), { code: "scene_data", value: "test" });
});

test("buildCommand Raw", () => {
  const schema = [makeSchema("raw_data", "Raw")];
  assert.deepEqual(buildCommand(schema, "raw_data", "abc123"), { code: "raw_data", value: "abc123" });
});

test("buildCommand no schema match", () => {
  assert.deepEqual(buildCommand([], "switch", true), { code: "switch", value: true });
});
