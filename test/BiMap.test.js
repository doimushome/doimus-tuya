"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BiMap } = require("../src/shared/BiMap");

test("set/get — forward and reverse lookup", () => {
  const m = new BiMap();
  m.set("a", 1);
  assert.equal(m.get("a"), 1);
  assert.equal(m.get(1), "a");
});

test("set — overwrite cleans up old reverse mapping", () => {
  const m = new BiMap();
  m.set("a", 1);
  m.set("a", 2);
  assert.equal(m.get("a"), 2);
  assert.equal(m.get(2), "a");
  assert.equal(m.get(1), undefined);
});

test("set — overwrite reverse cleans up old forward mapping", () => {
  const m = new BiMap();
  m.set("a", 1);
  m.set("b", 1);
  assert.equal(m.get("b"), 1);
  assert.equal(m.get(1), "b");
  assert.equal(m.get("a"), undefined);
});

test("set — bidirectional entries via two calls", () => {
  const m = new BiMap();
  m.set("x", "y");
  m.set("y", "x");
  assert.equal(m.get("x"), "y");
  assert.equal(m.get("y"), "x");
});

test("delete — removes both directions", () => {
  const m = new BiMap();
  m.set("a", 1);
  m.delete("a");
  assert.equal(m.get("a"), undefined);
  assert.equal(m.get(1), undefined);
});

test("delete — reverse key", () => {
  const m = new BiMap();
  m.set("a", 1);
  m.delete(1);
  assert.equal(m.get("a"), undefined);
  assert.equal(m.get(1), undefined);
});

test("has — works for both directions", () => {
  const m = new BiMap();
  m.set("a", 1);
  assert.ok(m.has("a"));
  assert.ok(m.has(1));
  assert.ok(!m.has("b"));
});

test("size — returns forward map size", () => {
  const m = new BiMap();
  assert.equal(m.size, 0);
  m.set("a", 1);
  assert.equal(m.size, 1);
  m.set("b", 2);
  assert.equal(m.size, 2);
  m.delete("a");
  assert.equal(m.size, 1);
});

test("clear — empties all entries", () => {
  const m = new BiMap();
  m.set("a", 1);
  m.set("b", 2);
  m.clear();
  assert.equal(m.size, 0);
  assert.equal(m.get("a"), undefined);
  assert.equal(m.get(1), undefined);
  assert.equal(m.get("b"), undefined);
  assert.equal(m.get(2), undefined);
});

test("keys / values — iterate forward entries", () => {
  const m = new BiMap();
  m.set("a", 1);
  m.set("b", 2);
  assert.deepEqual([...m.keys()], ["a", "b"]);
  assert.deepEqual([...m.values()], [1, 2]);
});

test("get — returns undefined for missing key", () => {
  const m = new BiMap();
  assert.equal(m.get("nonexistent"), undefined);
});

test("multiple entries — independent", () => {
  const m = new BiMap();
  m.set("a", 1);
  m.set("b", 2);
  m.set("c", 3);
  assert.equal(m.get("a"), 1);
  assert.equal(m.get(2), "b");
  assert.equal(m.get("c"), 3);
  assert.equal(m.size, 3);
});
