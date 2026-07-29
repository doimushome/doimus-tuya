"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateUUID,
  validateConfig,
  computeNeedsWake,
} = require("../src/shared/plugin-utils");

test("generateUUID — deterministic from same id", () => {
  const a = generateUUID("dev-123");
  const b = generateUUID("dev-123");
  assert.equal(a, b);
});

test("generateUUID — different ids produce different uuids", () => {
  const a = generateUUID("dev-123");
  const b = generateUUID("dev-456");
  assert.notEqual(a, b);
});

test("generateUUID — valid UUID format", () => {
  const uuid = generateUUID("test-device");
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("vacuumConfig — null/empty options passes", () => {
  assert.ok(validateConfig({}, () => {}));
  assert.ok(validateConfig({ deviceOverrides: [] }, () => {}));
});

test("validateConfig — duplicate id fails", () => {
  const log = [];
  const result = validateConfig(
    {
      deviceOverrides: [
        { id: "dup", name: "a", schema: [] },
        { id: "dup", name: "b", schema: [] },
      ],
    },
    (level, msg) => log.push({ level, msg }),
  );
  assert.equal(result, false);
  assert.ok(log.some((l) => l.msg.includes("conflict")));
});

test("validateConfig — duplicate schema code fails", () => {
  const log = [];
  const result = validateConfig(
    {
      deviceOverrides: [
        {
          id: "device1",
          schema: [
            { code: "switch", type: "Boolean" },
            { code: "switch", type: "Boolean" },
          ],
        },
      ],
    },
    (level, msg) => log.push({ level, msg }),
  );
  assert.equal(result, false);
  assert.ok(log.some((l) => l.msg.includes("code")));
});

test("validateConfig — invalid type fails", () => {
  const log = [];
  const result = validateConfig(
    {
      deviceOverrides: [
        {
          id: "device1",
          schema: [{ code: "test", type: "InvalidType" }],
        },
      ],
    },
    (level, msg) => log.push({ level, msg }),
  );
  assert.equal(result, false);
  assert.ok(log.some((l) => l.msg.includes("InvalidType")));
});

test("validateConfig — min >= max range fails", () => {
  const log = [];
  const result = validateConfig(
    {
      deviceOverrides: [
        {
          id: "device1",
          schema: [
            {
              code: "temp",
              type: "Integer",
              property: { min: 30, max: 20, scale: 1 },
            },
          ],
        },
      ],
    },
    (level, msg) => log.push({ level, msg }),
  );
  assert.equal(result, false);
  assert.ok(log.some((l) => l.msg.includes("Invalid property range")));
});

test("validateConfig — valid schema passes", () => {
  const log = [];
  const result = validateConfig(
    {
      deviceOverrides: [
        {
          id: "device1",
          schema: [
            { code: "switch", type: "Boolean" },
            { code: "bright_value", type: "Integer", property: { min: 0, max: 100, scale: 0 } },
          ],
        },
      ],
    },
    (level, msg) => log.push({ level, msg }),
  );
  assert.equal(result, true);
  assert.equal(log.length, 0);
});

test("computeNeedsWake — battery camera returns true", () => {
  const device = {
    category: "sp",
    schema: [{ code: "battery_percentage" }],
  };
  assert.equal(computeNeedsWake(device), true);
});

test("computeNeedsWake — wired camera returns false", () => {
  const device = {
    category: "sp",
    schema: [{ code: "switch" }],
  };
  assert.equal(computeNeedsWake(device), false);
});

test("computeNeedsWake — non-camera with battery returns false", () => {
  const device = {
    category: "switch",
    schema: [{ code: "battery_percentage" }],
  };
  assert.equal(computeNeedsWake(device), false);
});

test("computeNeedsWake — null schema returns false", () => {
  const device = { category: "sp", schema: null };
  assert.equal(computeNeedsWake(device), false);
});

test("computeNeedsWake — va_battery counts", () => {
  const device = {
    category: "sp",
    schema: [{ code: "va_battery" }],
  };
  assert.equal(computeNeedsWake(device), true);
});

test("computeNeedsWake — wireless_electricity counts", () => {
  const device = {
    category: "doorbell",
    schema: [{ code: "wireless_electricity" }],
  };
  assert.equal(computeNeedsWake(device), true);
});

test("computeNeedsWake — wireless_powermode counts", () => {
  const device = {
    category: "mobilecam",
    schema: [{ code: "wireless_powermode" }],
  };
  assert.equal(computeNeedsWake(device), true);
});
