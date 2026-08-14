"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDoimusType,
  determineCapabilities,
  mapTuyaStatusToDoimusState,
  applySchemaOverride,
  CATEGORY_TO_DOIMUS_TYPE,
} = require("../src/shared/state-mapper");

function makeDevice(category, schema = [], status = [], overrides = {}) {
  return { id: "test-dev", name: "Test", category, schema, status, ...overrides };
}

function makeSchema(code, type, props = {}) {
  return { code, type, ...props };
}

// ── getDoimusType ──

test("getDoimusType — returns type from CATEGORY_TO_DOIMUS_TYPE", () => {
  assert.equal(getDoimusType(makeDevice("kg"), {}), "switch");
});

test("getDoimusType — returns unknown category as switch", () => {
  assert.equal(getDoimusType(makeDevice("nonexistent"), {}), "switch");
});

test("getDoimusType — hidden type from override by uuid", () => {
  const options = {
    deviceOverrides: [{ id: "test-uuid", category: "hidden" }],
  };
  const dev = makeDevice("kg", [], [], { uuid: "test-uuid" });
  assert.equal(getDoimusType(dev, options), "hidden");
});

test("getDoimusType — custom type from override by product_id", () => {
  const options = {
    deviceOverrides: [{ id: "prod-xyz", category: "wk" }],
  };
  const dev = makeDevice("kg", [], [], { product_id: "prod-xyz" });
  assert.equal(getDoimusType(dev, options), "thermostat");
});

// ── CATEGORY_TO_DOIMUS_TYPE sanity ──

test("CATEGORY_TO_DOIMUS_TYPE — all common categories mapped", () => {
  const common = ["kg", "cz", "dj", "cl", "wsdcg", "wk", "ms", "mcs", "ggq", "sp", "doorbell", "mobilecam", "wxml", "kj", "sf", "bjz", "ipc"];
  for (const cat of common) {
    assert.ok(CATEGORY_TO_DOIMUS_TYPE[cat] !== undefined, `Category "${cat}" is missing`);
  }
});

// ── determineCapabilities ──

test("determineCapabilities — switch has on capability", () => {
  const caps = determineCapabilities(makeDevice("kg", [makeSchema("switch", "Boolean")]));
  assert.ok(caps.includes("on"));
});

test("determineCapabilities — mobilecam camera capabilities from fallback schema", () => {
  const device = makeDevice("mobilecam", [
    makeSchema("basic_private", "Boolean"),
    makeSchema("basic_nightvision", "Enum"),
    makeSchema("record_switch", "Boolean"),
    makeSchema("ptz_control", "Enum"),
    makeSchema("movement_detect_pic", "String"),
    makeSchema("battery_percentage", "Integer"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("camera") === false); // sanity: type is separate
  assert.ok(caps.includes("on"));
  assert.ok(caps.includes("p2p_start"));
  assert.ok(caps.includes("p2p_stop"));
  assert.ok(caps.includes("control"));
  assert.ok(caps.includes("recording"));
  assert.ok(caps.includes("night_vision"));
  assert.ok(caps.includes("privacy_mode"));
  assert.ok(caps.includes("doorbell"));
  assert.ok(caps.includes("battery"));
});

test("mapTuyaStatusToDoimusState — basic_nightvision enum maps to night_vision", () => {
  const device = makeDevice("mobilecam", [
    makeSchema("basic_nightvision", "Enum"),
  ]);
  // Battery peephole/doorbell cameras use "0"=Auto, "1"=Off, "2"=On
  // (confirmed against the Tuya app on the video peephole: current value "1"
  // shows as Off).
  const off = mapTuyaStatusToDoimusState(device, [{ code: "basic_nightvision", value: "1" }], {});
  assert.equal(off.night_vision, false);
  const on = mapTuyaStatusToDoimusState(device, [{ code: "basic_nightvision", value: "2" }], {});
  assert.equal(on.night_vision, true);
  const auto = mapTuyaStatusToDoimusState(device, [{ code: "basic_nightvision", value: "0" }], {});
  assert.equal(auto.night_vision, true, "auto mode keeps night vision active");
});

test("determineCapabilities — light capabilities", () => {
  const device = makeDevice("dj", [
    makeSchema("switch_led", "Boolean"),
    makeSchema("bright_value", "Integer"),
    makeSchema("colour_data", "Json"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("on"));
  assert.ok(caps.includes("brightness"));
  assert.ok(caps.includes("hue"));
});

test("determineCapabilities — light scene/music", () => {
  const device = makeDevice("dj", [
    makeSchema("switch_led", "Boolean"),
    makeSchema("scene_data", "Json"),
    makeSchema("music_data", "Json"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("scene"));
});

test("determineCapabilities — cover capabilities", () => {
  const device = makeDevice("cl", [
    makeSchema("percent_control", "Integer"),
    makeSchema("control", "Enum"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("position"));
  assert.ok(caps.includes("control"));
});

test("determineCapabilities — blind excludes percent_state from position", () => {
  const device = makeDevice("cl", [
    makeSchema("percent_state", "Integer"),
    makeSchema("control_back", "Enum"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(!caps.includes("position"));
  assert.ok(caps.includes("control"));
});

test("determineCapabilities — thermostat capabilities", () => {
  const device = makeDevice("wk", [
    makeSchema("switch", "Boolean"),
    makeSchema("temp_set", "Integer", { property: { min: 50, max: 300, scale: 1 } }),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("on"));
  assert.ok(caps.includes("target_temp"));
});

test("determineCapabilities — fan with swing", () => {
  const device = makeDevice("fs", [
    makeSchema("switch", "Boolean"),
    makeSchema("swing", "Enum"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("swing"));
});

test("determineCapabilities — lock capabilities", () => {
  const device = makeDevice("ms", [
    makeSchema("lock_state", "Enum"),
    makeSchema("battery_state", "Enum"),
    makeSchema("contact_state", "Enum"),
    makeSchema("tamper_state", "Enum"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("locked"));
  assert.ok(caps.includes("battery"));
  assert.ok(caps.includes("contact"));
  assert.ok(caps.includes("tamper"));
});

test("determineCapabilities — sensor capabilities", () => {
  const device = makeDevice("wsdcg", [
    makeSchema("va_temperature", "Integer"),
    makeSchema("va_humidity", "Integer"),
    makeSchema("sensitivity", "Enum"),
    makeSchema("keep_time", "Integer"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("temperature"));
  assert.ok(caps.includes("humidity"));
});

test("determineCapabilities — camera capabilities", () => {
  const device = makeDevice("sp", [
    makeSchema("basic_private", "Boolean"),
    makeSchema("night_vision", "Enum"),
    makeSchema("floodlight", "Enum"),
    makeSchema("siren_switch", "Boolean"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("privacy_mode"));
  assert.ok(caps.includes("night_vision"));
  assert.ok(caps.includes("floodlight"));
  assert.ok(caps.includes("siren"));
  assert.ok(caps.includes("video"), "cameras must always advertise video");
});

test("determineCapabilities — doorbell recording and sd", () => {
  const device = makeDevice("doorbell", [
    makeSchema("record_switch", "Boolean"),
    makeSchema("sd_status", "Enum"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("doorbell"));
  assert.ok(caps.includes("video"), "doorbell with camera codes must advertise video");
});

test("determineCapabilities — audio-only doorbell has no video", () => {
  const device = makeDevice("doorbell", [
    makeSchema("doorbell", "Boolean"),
    makeSchema("unlock", "Boolean"),
    makeSchema("battery_state", "Enum"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("doorbell"));
  assert.ok(!caps.includes("video"), "camera-less doorbell must not advertise video");
});

test("determineCapabilities — air quality sensors", () => {
  const device = makeDevice("pm25", [
    makeSchema("pm25_value", "Integer"),
    makeSchema("co2_value", "Integer"),
    makeSchema("tvoc_value", "Integer"),
    makeSchema("hcho", "Integer"),
    makeSchema("air_quality", "Integer"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("pm25"));
  assert.ok(caps.includes("co2"));
  assert.ok(caps.includes("tvoc"));
  assert.ok(caps.includes("formaldehyde"));
  assert.ok(caps.includes("air_quality"));
});

test("determineCapabilities — weather station", () => {
  const device = makeDevice("wsdcg", [
    makeSchema("temp_current", "Integer"),
    makeSchema("humidity_value", "Integer"),
    makeSchema("windspeed", "Integer"),
    makeSchema("wind_direction", "Integer"),
    makeSchema("rainfall", "Integer"),
    makeSchema("pm10_value", "Integer"),
    makeSchema("pm1_value", "Integer"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("windspeed"));
  assert.ok(caps.includes("rainfall"));
  assert.ok(caps.includes("pm10"));
  assert.ok(caps.includes("pm1"));
});

test("determineCapabilities — soil sensor", () => {
  const device = makeDevice("wsdcg", [
    makeSchema("soil_humidity", "Integer"),
    makeSchema("soil_temperature", "Integer"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("soil_moisture"));
  assert.ok(caps.includes("soil_temperature"));
});

test("determineCapabilities — PM1/PM10 capabilities on wsdcg", () => {
  const device = makeDevice("wsdcg", [
    makeSchema("pm1_value", "Integer"),
    makeSchema("pm10_value", "Integer"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("pm1"));
  assert.ok(caps.includes("pm10"));
});

// ── mapTuyaStatusToDoimusState ──

test("switch on/off", () => {
  const device = makeDevice("kg", [makeSchema("switch", "Boolean")], [
    { code: "switch", value: true },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).on, true);
});

test("temperature — va_temperature raw value", () => {
  const device = makeDevice("wsdcg", [makeSchema("va_temperature", "Integer")], [
    { code: "va_temperature", value: 255 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).temperature, 255);
});

test("humidity — raw value", () => {
  const device = makeDevice("wsdcg", [makeSchema("va_humidity", "Integer")], [
    { code: "va_humidity", value: 520 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).humidity, 520);
});

test("current temperature", () => {
  const device = makeDevice("wkz", [makeSchema("temp_current", "Integer")], [
    { code: "temp_current", value: 250 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).temperature, 250);
});

test("brightness — normalized from 0-1000 to 0-100", () => {
  const device = makeDevice("dj", [makeSchema("bright_value", "Integer")], [
    { code: "bright_value", value: 500 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).brightness, 50);
});

test("colour_data maps hue/sat/brightness", () => {
  const device = makeDevice("dj", [], [
    { code: "colour_data", value: { hue: 120, saturation: 500, value: 800 } },
  ]);
  const state = mapTuyaStatusToDoimusState(device, device.status, {});
  assert.equal(state.hue, 120);
  assert.equal(state.saturation, 500);
  assert.equal(state.brightness, 80);
});

test("scene_data", () => {
  const device = makeDevice("dj", [], [
    { code: "scene_data_v2", value: '{"id":3}' },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).scene, '{"id":3}');
});

test("lock_state → locked boolean", () => {
  const device = makeDevice("ms", [], [
    { code: "lock_state", value: "locked" },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).locked, true);
});

test("battery percentage", () => {
  const device = makeDevice("ms", [], [
    { code: "battery_percentage", value: 80 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).battery, 80);
});

test("contact_state open → contact boolean true", () => {
  const device = makeDevice("mcs", [], [
    { code: "contact_state", value: "open" },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).contact, true);
});

test("motion detection from movement_detect_pic", () => {
  const device = makeDevice("sp", [], [
    { code: "movement_detect_pic", value: "http://..." },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).motion, true);
});

test("motion false when no motion DP present", () => {
  const device = makeDevice("sp", [], [{ code: "switch", value: true }]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).motion, false);
});

test("motion from stale device.status even when statusList empty", () => {
  const device = makeDevice("doorbell", [], [{ code: "switch", value: true }]);
  device.status.push({ code: "pir", value: true });
  assert.equal(mapTuyaStatusToDoimusState(device, [], {}).motion, true);
});

test("cover position", () => {
  const device = makeDevice("cl", [], [
    { code: "percent_control", value: 50 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).position, 50);
});

test("thermostat eco mode", () => {
  const device = makeDevice("wkz", [], [{ code: "eco", value: true }]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).eco_mode, true);
});

test("frost protection", () => {
  const device = makeDevice("wkz", [], [{ code: "anti_freeze", value: true }]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).frost_protection, true);
});

test("floor_temp → floor_temp state", () => {
  const device = makeDevice("wkz", [], [
    { code: "floor_temp", value: 280 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).floor_temp, 280);
});

test("outdoor_temp → outdoor_temp state", () => {
  const device = makeDevice("wkz", [], [
    { code: "outer_temp", value: -50 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).outdoor_temp, -50);
});

test("fan speed", () => {
  const device = makeDevice("fs", [], [
    { code: "fan_speed_percent", value: 75 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).rotation_speed, 75);
});

test("wind_speed → rotation_speed", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "wind_speed", value: 15 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).rotation_speed, 15);
});

test("swing on", () => {
  const device = makeDevice("fs", [], [{ code: "swing", value: true }]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).swing, true);
});

test("anion on", () => {
  const device = makeDevice("fs", [], [{ code: "anion", value: true }]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).anion, true);
});

test("night_vision boolean", () => {
  const device = makeDevice("sp", [], [
    { code: "night_vision", value: true },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).night_vision, true);
});

test("floodlight boolean", () => {
  const device = makeDevice("sp", [], [
    { code: "floodlight", value: true },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).floodlight, true);
});

test("siren on", () => {
  const device = makeDevice("doorbell", [], [
    { code: "siren_switch", value: true },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).siren, true);
});

test("privacy mode", () => {
  const device = makeDevice("sp", [], [
    { code: "basic_private", value: true },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).privacy_mode, true);
});

test("recording — record_switch", () => {
  const device = makeDevice("sp", [], [
    { code: "record_switch", value: true },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).recording, true);
});

test("SD status", () => {
  const device = makeDevice("sp", [], [
    { code: "sd_status", value: "normal" },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).sd_status, "normal");
});

test("pm25", () => {
  const device = makeDevice("pm2.5", [], [
    { code: "pm25_value", value: 35 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).pm25, 35);
});

test("co2", () => {
  const device = makeDevice("co2_detect", [], [
    { code: "co2_value", value: 800 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).co2, 800);
});

test("tvoc", () => {
  const device = makeDevice("voc_detect", [], [
    { code: "tvoc_value", value: 0.5 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).tvoc, 0.5);
});

test("formaldehyde via hcho_value", () => {
  const device = makeDevice("hcho_detect", [], [
    { code: "hcho_value", value: 0.03 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).formaldehyde, 0.03);
});

test("aqi via aqi_value", () => {
  const device = makeDevice("aqi_detect", [], [
    { code: "aqi_value", value: 50 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).aqi, 50);
});

test("wind speed as rotation_speed", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "wind_speed", value: 15 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).rotation_speed, 15);
});

test("rainfall via rain_value", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "rain_value", value: 10 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).rainfall, 10);
});

test("soil moisture", () => {
  const device = makeDevice("cg", [], [
    { code: "soil_humidity", value: 60 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).soil_moisture, 60);
});

test("soil EC", () => {
  const device = makeDevice("cg", [], [
    { code: "soil_ec", value: 500 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).soil_ec, 500);
});

test("soil pH", () => {
  const device = makeDevice("cg", [], [
    { code: "soil_ph", value: 70 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).soil_ph, 7);
});

test("UV index via uv_current", () => {
  const device = makeDevice("cg", [], [
    { code: "uv_current", value: 5 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).uv_index, 5);
});

test("pressure", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "pressure", value: 1013 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).pressure, 1013);
});

test("noise via noise_value", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "noise_value", value: 45 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).noise, 45);
});

test("illuminance", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "illuminance_value", value: 300 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).illuminance, 300);
});

test("sensitivity mapping", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "sensitivity", value: "medium" },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).sensitivity, "medium");
});

test("keep_time mapping", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "keep_time", value: 30 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).keep_time, 30);
});

test("calibration", () => {
  const device = makeDevice("blind", [], [
    { code: "calibration", value: true },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).calibration, true);
});

test("electrical monitoring — current raw (mA)", () => {
  const device = makeDevice("kg", [
    makeSchema("cur_current", "Integer", { property: { scale: 0 } }),
    makeSchema("cur_power", "Integer"),
    makeSchema("cur_voltage", "Integer", { property: { scale: 1 } }),
  ], [
    { code: "cur_current", value: 500 },
    { code: "cur_power", value: 60 },
    { code: "cur_voltage", value: 2200 },
  ]);
  const state = mapTuyaStatusToDoimusState(device, device.status, {});
  assert.equal(state.current, 500);
  assert.equal(state.power, 60);
  assert.equal(state.voltage, 220);
});

test("energy", () => {
  const device = makeDevice("kg", [], [
    { code: "total_forward_energy", value: 1000 },
  ]);
  assert.equal(mapTuyaStatusToDoimusState(device, device.status, {}).energy, 1000);
});

test("PM1/PM10 sensors", () => {
  const device = makeDevice("wsdcg", [], [
    { code: "pm1_value", value: 10 },
    { code: "pm10_value", value: 25 },
  ]);
  const state = mapTuyaStatusToDoimusState(device, device.status, {});
  assert.equal(state.pm1, 10);
  assert.equal(state.pm10, 25);
});

test("internal keys stripped", () => {
  const device = makeDevice("kg", [], [
    { code: "switch", value: true },
  ]);
  const state = mapTuyaStatusToDoimusState(device, device.status, {});
  assert.equal(Object.keys(state).some((k) => k.startsWith("_")), false);
});

test("empty status list returns empty state", () => {
  const device = makeDevice("kg", [], []);
  assert.equal(Object.keys(mapTuyaStatusToDoimusState(device, [], {})).length, 0);
});

test("null status doesn't crash", () => {
  const device = makeDevice("kg", [], []);
  const state = mapTuyaStatusToDoimusState(device, null, {});
  assert.ok(state !== undefined);
});

test("applySchemaOverride — renames schema code via newCode", () => {
  const device = makeDevice("kg",
    [makeSchema("switch", "Boolean")],
    [{ code: "switch", value: false }],
  );
  const options = {
    deviceOverrides: [
      { id: "test-dev", schema: [{ code: "switch", newCode: "switch_override" }] },
    ],
  };
  applySchemaOverride(device, options);
  assert.equal(device.schema[0].code, "switch_override");
  assert.equal(device.status[0].code, "switch_override");
});

// ── buildUiDescriptor + determineCapabilities integration ──
// buildUiDescriptor receives the array returned by determineCapabilities and
// must not assume a Set (regression for "capabilities.has is not a function").

test("buildUiDescriptor accepts the array from determineCapabilities", () => {
  const { buildUiDescriptor } = require("../src/shared/handlers");
  const device = makeDevice("sp", [
    makeSchema("night_vision", "Enum"),
    makeSchema("record_switch", "Boolean"),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(Array.isArray(caps), "determineCapabilities returns an array");
  assert.ok(caps.includes("video"));
  const descriptor = buildUiDescriptor("camera", caps);
  assert.ok(descriptor, "descriptor should be built without throwing");
  const rows = descriptor.ui.sections[0].rows;
  assert.ok(
    rows.some((r) => r.key === "p2p_start"),
    "camera descriptor includes the live-view button",
  );
});

test("buildUiDescriptor — blind emits position slider + control segment", () => {
  const { buildUiDescriptor } = require("../src/shared/handlers");
  const device = makeDevice("clkg", [
    makeSchema("control", "Enum", { property: { range: ["open", "stop", "close"] } }),
    makeSchema("percent_control", "Integer", { property: { min: 0, max: 100, scale: 0 } }),
  ]);
  const caps = determineCapabilities(device);
  assert.ok(caps.includes("position"), "blind exposes position capability");
  assert.ok(caps.includes("control"), "blind exposes control capability");
  const descriptor = buildUiDescriptor("blind", caps);
  assert.ok(descriptor, "blind descriptor should be built");
  const rows = descriptor.ui.sections[0].rows;
  assert.ok(
    rows.some((r) => r.type === "slider" && r.key === "position"),
    "blind descriptor includes a position slider",
  );
  const control = rows.find((r) => r.type === "segment" && r.key === "control");
  assert.ok(control, "blind descriptor includes a control segment");
  assert.deepEqual(
    control.options.map((o) => o.value),
    ["open", "stop", "close"],
    "control segment offers open/stop/close",
  );
});

test("buildUiDescriptor — position-only blind drives open/close via position DP", () => {
  const { buildUiDescriptor } = require("../src/shared/handlers");
  const device = makeDevice("clkg", [
    makeSchema("percent_control", "Integer", { property: { min: 0, max: 100, scale: 0 } }),
  ]);
  const caps = determineCapabilities(device);
  const descriptor = buildUiDescriptor("blind", caps);
  assert.ok(descriptor, "blind descriptor should be built");
  const rows = descriptor.ui.sections[0].rows;
  assert.ok(
    rows.some((r) => r.type === "segment" && r.key === "position"),
    "position-only blind gets open/close segment on position",
  );
});
