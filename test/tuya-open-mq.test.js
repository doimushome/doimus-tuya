"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const CryptoJS = require("crypto-js");

const TuyaOpenMQ = require("../src/cloud/api/TuyaOpenMQ");
const { PrefixLogger } = require("../src/shared/Logger");

// MQTT password captured from the open-hub access-config response.
const TEST_PASSWORD = "8c22cadbe8b2e069d2fe7a88623db49d";
// A real protocol-4 message the server encrypted as v1.0 (AES-ECB) even though
// the client requested msg_encrypted_version 2.0.
const V1_MESSAGE =
  "1LnE23+gaeA7WdvNhTNVgKUvDuauvZCqXs6077Ph1VR3Yb6TcyHjmpigDI2kGl4QwwGRzwEyPnhy3rAPPcLxY8ZX9lmmsCyunEq9FVm5NHWDNax5tZivg1x4BjsFFnI2RRTqSYCb/lAbasqvfVMRCltm0NgrtlLXyis2y5qdFf0Tv9v2fViNOJj9zAj/9Y7i";
const V1_T = 1786542314;

function makeLogger() {
  return new PrefixLogger({ info() {}, warn() {}, error() {}, debug() {} }, "Test");
}

function encodeV2Message(plaintext, password, t) {
  const key = Buffer.from(password.substring(8, 24));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
  const buf = Buffer.allocUnsafe(6);
  buf.writeUIntBE(t, 0, 6);
  cipher.setAAD(buf);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ivLen = Buffer.allocUnsafe(4);
  ivLen.writeUIntBE(iv.length, 0, 4);
  return Buffer.concat([ivLen, iv, encrypted, tag]).toString("base64");
}

test("_decodeMQMessage — decodes v1.0 (ECB) message when version is 2.0", () => {
  const mq = new TuyaOpenMQ({}, makeLogger(), false);
  mq.version = "2.0";
  const decoded = mq._decodeMQMessage(V1_MESSAGE, TEST_PASSWORD, V1_T);
  assert.ok(decoded, "expected a decoded string");
  const msg = JSON.parse(decoded);
  assert.equal(msg.devId, "bf22ea98909abfaf19vaf1");
  assert.ok(Array.isArray(msg.status));
});

test("_decodeMQMessage — decodes v2.0 (GCM) message when version is 2.0", () => {
  const plaintext = JSON.stringify({
    devId: "test-dev",
    status: [{ code: "switch_1", value: true, t: V1_T }],
  });
  const encoded = encodeV2Message(plaintext, TEST_PASSWORD, V1_T);
  const mq = new TuyaOpenMQ({}, makeLogger(), false);
  mq.version = "2.0";
  const decoded = mq._decodeMQMessage(encoded, TEST_PASSWORD, V1_T);
  assert.ok(decoded, "expected a decoded string");
  assert.deepEqual(JSON.parse(decoded), JSON.parse(plaintext));
});

test("_decodeMQMessage — decodes v1.0 (ECB) message when version is 1.0", () => {
  const mq = new TuyaOpenMQ({}, makeLogger(), false);
  mq.version = "1.0";
  const decoded = mq._decodeMQMessage(V1_MESSAGE, TEST_PASSWORD, V1_T);
  assert.ok(decoded, "expected a decoded string");
  const msg = JSON.parse(decoded);
  assert.equal(msg.devId, "bf22ea98909abfaf19vaf1");
});

test("_decodeMQMessage — returns null for garbage data", () => {
  const mq = new TuyaOpenMQ({}, makeLogger(), false);
  mq.version = "2.0";
  const garbage = Buffer.from("this is definitely not encrypted").toString("base64");
  assert.equal(mq._decodeMQMessage(garbage, TEST_PASSWORD, V1_T), null);
});

test("_decodeMQMessage_1_0 — throws-free, matches CryptoJS ECB reference", () => {
  const key = TEST_PASSWORD.substring(8, 24);
  const reference = CryptoJS.AES.decrypt(
    V1_MESSAGE,
    CryptoJS.enc.Utf8.parse(key),
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
  ).toString(CryptoJS.enc.Utf8);
  const mq = new TuyaOpenMQ({}, makeLogger(), false);
  assert.equal(mq._decodeMQMessage_1_0(V1_MESSAGE, TEST_PASSWORD), reference);
});
