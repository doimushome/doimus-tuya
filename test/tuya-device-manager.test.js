"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TuyaDeviceManager = require("../src/shared/TuyaDeviceManager");

const noopLogger = {
  log() {},
  info() {},
  warn() {},
  debug() {},
  error() {},
};

function makeManager(specResponse) {
  const api = {
    log: noopLogger,
    get: async () => specResponse,
  };
  return new TuyaDeviceManager(api, false);
}

function makeDevice(category, status = []) {
  return { id: "dev-1", name: "Test", category, status, online: true };
}

test("getDeviceSchema — returns specs when API succeeds", async () => {
  const dm = makeManager({
    success: true,
    result: {
      status: [
        { code: "switch_1", type: "Boolean", values: "{}" },
        { code: "cur_current", type: "Integer", values: '{"min":0,"max":25000,"scale":3}' },
      ],
      functions: [{ code: "switch_1", type: "Boolean", values: "{}" }],
    },
  });
  const schema = await dm.getDeviceSchema("dev-1", makeDevice("cz"));
  assert.deepEqual(
    schema.map((s) => [s.code, s.mode]),
    [
      ["cur_current", "ro"],
      ["switch_1", "rw"],
    ],
  );
});

test("getDeviceSchema — falls back to category schema when specs unsupported (code 2009)", async () => {
  const dm = makeManager({ success: false, code: 2009, msg: "not support this device" });
  const schema = await dm.getDeviceSchema(
    "dev-1",
    makeDevice("mobilecam", [{ code: "motion_detect", value: true }]),
  );
  const codes = new Map(schema.map((s) => [s.code, s.mode]));

  // Category-known writable DPs are present as rw.
  assert.equal(codes.get("basic_private"), "rw");
  assert.equal(codes.get("record_switch"), "rw");
  assert.equal(codes.get("ptz_control"), "rw");
  assert.equal(codes.get("basic_nightvision"), "rw");

  // Status-derived DPs are present as ro.
  assert.equal(codes.get("motion_detect"), "ro");
});

test("getDeviceSchema — fallback with no device returns empty", async () => {
  const dm = makeManager({ success: false, code: 2009, msg: "not support this device" });
  const schema = await dm.getDeviceSchema("dev-1", null);
  assert.deepEqual(schema, []);
});
