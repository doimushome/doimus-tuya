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
