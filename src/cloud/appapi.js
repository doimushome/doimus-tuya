"use strict";

const crypto = require("crypto");
const https = require("https");

// The camera's WebRTC/IPC subsystem listens on the app's MQTT broker
// (ismartlife.me), not the OpenAPI's open-iot-hub broker. tuya-ipc-terminal
// streams these battery/doorbell cameras by logging into the app and using
// /api/jarvis/mqtt + /api/jarvis/config. This module replicates that.
//
// Region → app host (derived from the OpenAPI endpoint; override with
// options.appHost).
const REGION_HOSTS = [
  { key: "tuyaus", host: "protect-us.ismartlife.me" },
  { key: "tuyaeu", host: "protect-eu.ismartlife.me" },
  { key: "tuyacn", host: "protect.ismartlife.me" },
];

function appHostFor(endpoint) {
  const e = (endpoint || "").toLowerCase();
  for (const r of REGION_HOSTS) if (e.includes(r.key)) return r.host;
  return "protect-eu.ismartlife.me";
}

// Minimal cookie jar (name=value pairs from Set-Cookie, sent back as Cookie).
function extractCookies(setCookieHeaders) {
  if (!setCookieHeaders) return [];
  return setCookieHeaders
    .map((h) => (h || "").split(";")[0])
    .filter(Boolean);
}

function requestJson(host, path, body, cookies) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "{}";
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "*/*",
      Origin: `https://${host}`,
      Referer: `https://${host}/login`,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (cookies && cookies.length) headers.Cookie = cookies.join("; ");
    const req = https.request({ host, method: "POST", path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const merged = cookies
          ? cookies.concat(extractCookies(res.headers["set-cookie"]))
          : extractCookies(res.headers["set-cookie"]);
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (_) {
          parsed = null;
        }
        resolve({
          ok: res.statusCode === 200,
          status: res.statusCode,
          body: parsed,
          raw: data,
          cookies: merged,
        });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function encryptPassword(password, pbKey) {
  // The plugin config may hold the password pre-hashed as a 32-hex MD5
  // ("salted" — the OpenAPI authorized-login accepts it as-is). Detect that
  // and don't re-hash, otherwise the app login gets MD5(MD5).
  let md5;
  if (/^[0-9a-f]{32}$/i.test(password)) {
    md5 = password;
  } else {
    md5 = crypto.createHash("md5").update(password).digest("hex");
  }
  const pem = `-----BEGIN PUBLIC KEY-----\n${pbKey}\n-----END PUBLIC KEY-----`;
  const enc = crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(md5, "utf8"),
  );
  return enc.toString("hex");
}

/**
 * Log into the Smart Life app (the same account as the plugin's Smart Home
 * project) and return { host, cookies, sid, domain }.
 */
async function appLogin(username, password, countryCode, endpoint, log) {
  const host = appHostFor(endpoint);
  countryCode = String(countryCode == null ? "" : countryCode);

  // Diagnostic (never log the full username/password).
  if (log) {
    log(
      "info",
      `[App] login host=${host} username=${maskUsername(username)} countryCode=${countryCode} passwordIs32Hex=${/^[0-9a-f]{32}$/i.test(password)}`,
    );
  }

  const tok = await requestJson(host, "/api/login/token", {
    countryCode,
    username,
    isUid: false,
  });
  if (!tok.ok || !tok.body || !tok.body.success) {
    throw new Error(`app login/token failed (${tok.status}): ${(tok.raw || "").slice(0, 120)}`);
  }
  const pbKey = tok.body.result.pbKey;
  const token = tok.body.result.token;

  const passwd = encryptPassword(password, pbKey);
  const isEmail = /@/.test(username);
  const loginBody = {
    countryCode,
    passwd,
    token,
    ifencrypt: 1,
    options: '{"group":1}',
  };
  if (isEmail) loginBody.email = username;
  else loginBody.mobile = username;

  const login = await requestJson(
    host,
    isEmail ? "/api/private/email/login" : "/api/private/phone/login",
    loginBody,
  );
  if (!login.ok || !login.body || !login.body.success) {
    throw new Error(
      `app login failed (${login.status}): ${(login.body && (login.body.errorMsg || login.body.msg)) || (login.raw || "").slice(0, 120)}`,
    );
  }
  return { host, cookies: login.cookies, result: login.body.result };
}

function maskUsername(username) {
  const s = String(username || "");
  if (s.length <= 4) return "****";
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    return `${u.slice(0, 2)}***@${d}`;
  }
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

/** /api/jarvis/mqtt → { msid, password }. */
async function appMqttConfig(session) {
  const r = await requestJson(session.host, "/api/jarvis/mqtt", {}, session.cookies);
  if (!r.ok || !r.body || !r.body.success) {
    throw new Error(`app jarvis/mqtt failed (${r.status})`);
  }
  return { host: session.host, cookies: session.cookies, ...r.body.result };
}

/** /api/jarvis/config → the WebRTC config (auth, moto_id, ices, skill, local_key). */
async function appWebrtcConfig(session, deviceId) {
  const r = await requestJson(
    session.host,
    "/api/jarvis/config",
    { devId: deviceId, clientTraceId: crypto.randomBytes(8).toString("hex") },
    session.cookies,
  );
  if (!r.ok || !r.body || !r.body.success) {
    throw new Error(`app jarvis/config failed (${r.status})`);
  }
  return { host: session.host, cookies: session.cookies, result: r.body.result };
}

module.exports = { appHostFor, appLogin, appMqttConfig, appWebrtcConfig };
