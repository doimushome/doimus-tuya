"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TuyaOpenAPI = require("../src/cloud/api/TuyaOpenAPI.js");

const noopLog = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

function makeApi({ expired = false, refreshFails = true } = {}) {
  const api = new TuyaOpenAPI(
    "https://openapi.tuyaeu.com",
    "test-access-id",
    "test-access-key",
    noopLog,
    "en",
    false,
  );
  api.tokenInfo = {
    access_token: "at",
    refresh_token: "rt",
    uid: "uid",
    expire: expired ? Date.now() - 1000 : Date.now() + 60 * 60 * 1000,
  };
  if (refreshFails) {
    api.get = async () => ({
      success: false,
      code: 1010,
      msg: "token is expired",
    });
  }
  return api;
}

// ---------------------------------------------------------------------------
// Re-login cooldown: two full re-logins back-to-back must NOT both mint a
// fresh token — each re-login invalidates any competing session on the same
// Tuya account (e.g. the official app), causing a token ping-pong.
// ---------------------------------------------------------------------------

test("_tryRelogin honors the cooldown and marks auth broken while skipped", async () => {
  const api = makeApi();
  let reloginCalls = 0;
  api.setReloginHandler(async () => {
    reloginCalls++;
    return { success: true };
  });

  const first = await api._tryRelogin();
  assert.equal(first, true, "first re-login should succeed");
  assert.equal(reloginCalls, 1);
  assert.equal(api.isAuthHealthy(), true, "auth healthy after successful re-login");

  // Immediately retry — must be short-circuited by the cooldown.
  const second = await api._tryRelogin();
  assert.equal(second, false, "second re-login must be skipped by cooldown");
  assert.equal(reloginCalls, 1, "no second re-login should fire");
  assert.equal(
    api.isAuthHealthy(),
    false,
    "skipping re-login should mark auth broken so callers back off",
  );
});

// ---------------------------------------------------------------------------
// _refreshAccessTokenIfNeed returns false when refresh fails AND re-login
// fails — callers must NOT retry the original request with a dead token.
// ---------------------------------------------------------------------------

test("_refreshAccessTokenIfNeed returns false when refresh and re-login both fail", async () => {
  const api = makeApi({ expired: true });
  let reloginCalls = 0;
  api.setReloginHandler(async () => {
    reloginCalls++;
    return { success: false }; // re-login also fails
  });

  const ok = await api._refreshAccessTokenIfNeed("/v1.0/devices/xyz");
  assert.equal(ok, false, "must signal the token is dead");
  assert.equal(reloginCalls, 1);
  assert.equal(api.isAuthHealthy(), false, "auth marked broken");
});

// ---------------------------------------------------------------------------
// A failed full login (homeLogin/customLogin) must NOT wipe the existing token.
// homeLogin() clears tokenInfo before POSTing so the login request is signed
// without an access_token; if that login fails and the token stays empty,
// isLogin() returns false and _refreshAccessTokenIfNeed() short-circuits —
// permanently blocking re-auth until a plugin restart.
// ---------------------------------------------------------------------------

test("homeLogin failure preserves the previous token so re-login can retry", async () => {
  const api = makeApi(); // access_token "at", refresh_token "rt"
  api.post = async () => ({
    success: false,
    code: 1013,
    msg: "request time is invalid",
  });

  const res = await api.homeLogin(44, "user", "pass", "tuyaSmart");
  assert.equal(res.success, false);
  assert.equal(api.isLogin(), true, "token must be preserved after failed login");
  assert.equal(api.tokenInfo.access_token, "at");
  assert.equal(api.tokenInfo.refresh_token, "rt");
});

test("customLogin failure preserves the previous token so re-login can retry", async () => {
  const api = makeApi();
  api.post = async () => ({
    success: false,
    code: 1013,
    msg: "request time is invalid",
  });

  const res = await api.customLogin("doimus", "doimus");
  assert.equal(res.success, false);
  assert.equal(api.isLogin(), true, "token must be preserved after failed login");
  assert.equal(api.tokenInfo.access_token, "at");
  assert.equal(api.tokenInfo.refresh_token, "rt");
});

// ---------------------------------------------------------------------------
// Successful re-login restores auth health (was previously left false, which
// permanently degraded energy polling and snapshot capture after a conflict).
// ---------------------------------------------------------------------------

test("_refreshAccessTokenIfNeed returns true and restores auth after successful re-login", async () => {
  const api = makeApi({ expired: true });
  api._setAuthBroken(); // simulate a previously failed recovery
  assert.equal(api.isAuthHealthy(), false);
  api.setReloginHandler(async () => ({ success: true }));

  const ok = await api._refreshAccessTokenIfNeed("/v1.0/devices/xyz");
  assert.equal(ok, true, "re-login success must signal the token is usable");
  assert.equal(api.isAuthHealthy(), true, "auth health must be restored");
});

// ---------------------------------------------------------------------------
// tuya_api_not_subscribed warning: must NOT fire for speculative (suppressed)
// calls like the camera snapshot probe, and when it does fire the message must
// name the right API (Camera Service / IoT Video Live Stream) for camera paths.
// ---------------------------------------------------------------------------

function makeProbeApi() {
  const api = makeApi(); // fresh, non-expired token
  // Stub the actual HTTP so we can return a "not subscribed" response.
  api._doRequest = async () => ({
    success: false,
    code: 28841101,
    msg: "No permissions. This API is not subscribed.",
  });
  const warnings = [];
  api.setWarningHandler((code, message) => {
    warnings.push({ code, message });
  });
  return { api, warnings };
}

test("suppressed (speculative) snapshot probe does not raise tuya_api_not_subscribed", async () => {
  const { api, warnings } = makeProbeApi();
  await api.request(
    "post",
    "/v1.0/cameras/bfc467f1cee0e05ea12z5s/actions/capture",
    null,
    {},
    { suppressErrorLog: true },
  );
  assert.equal(warnings.length, 0, "speculative probe must not raise a warning");
});

test("real camera/stream call names Camera Service in the not-subscribed warning", async () => {
  const { api, warnings } = makeProbeApi();
  await api.request(
    "post",
    "/v1.0/devices/bfc467f1cee0e05ea12z5s/stream/actions/allocate",
    null,
    { type: "rtsp" },
    {},
  );
  assert.equal(warnings.length, 1, "real call must raise the warning");
  assert.equal(warnings[0].code, "tuya_api_not_subscribed");
  assert.match(warnings[0].message, /Camera Service/);
});

test("real non-camera call names the generic required APIs", async () => {
  const { api, warnings } = makeProbeApi();
  await api.request("get", "/v1.0/devices/abc123", null, null, {});
  assert.equal(warnings.length, 1, "real call must raise the warning");
  assert.match(warnings[0].message, /Authorization Token Management/);
  assert.doesNotMatch(warnings[0].message, /Camera Service/);
});
