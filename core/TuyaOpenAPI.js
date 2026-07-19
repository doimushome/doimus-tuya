const https = require("https");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const retry = require("async-await-retry");
const { PrefixLogger } = require("../util/Logger");

const Endpoints = {
  AMERICA: "https://openapi.tuyaus.com",
  AMERICA_EAST: "https://openapi-ueaz.tuyaus.com",
  CHINA: "https://openapi.tuyacn.com",
  EUROPE: "https://openapi.tuyaeu.com",
  EUROPE_WEST: "https://openapi-weaz.tuyaeu.com",
  INDIA: "https://openapi.tuyain.com",
};

const DEFAULT_ENDPOINTS = {
  [Endpoints.AMERICA]: [
    1, 51, 52, 54, 55, 56, 57, 58, 60, 62, 63, 64, 66, 81, 82, 84, 95, 239, 245,
    246, 500, 502, 591, 593, 594, 595, 597, 598, 670, 672, 674, 675, 677, 678,
    682, 683, 686, 690, 852, 853, 886, 970, 1721, 1787, 1809, 1829, 1849, 4779,
    5999, 35818,
  ],
  [Endpoints.CHINA]: [86],
  [Endpoints.EUROPE]: [
    7, 20, 27, 30, 31, 32, 33, 34, 36, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49,
    61, 65, 90, 92, 93, 94, 212, 213, 216, 218, 220, 221, 222, 223, 224, 225,
    226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 240, 241,
    242, 243, 244, 248, 250, 251, 252, 253, 254, 255, 256, 257, 258, 260, 261,
    262, 263, 264, 265, 266, 267, 268, 269, 291, 297, 298, 299, 350, 351, 352,
    353, 354, 355, 356, 357, 358, 359, 370, 371, 372, 373, 374, 375, 376, 377,
    378, 379, 380, 381, 382, 385, 386, 387, 389, 420, 421, 423, 501, 503, 504,
    505, 506, 507, 508, 509, 590, 592, 596, 673, 676, 679, 680, 681, 685, 687,
    688, 689, 691, 692, 855, 856, 880, 960, 961, 962, 964, 965, 966, 967, 968,
    971, 972, 973, 974, 975, 976, 977, 992, 993, 994, 995, 996, 998, 1242, 1246,
    1264, 1268, 1284, 1340, 1345, 1441, 1473, 1649, 1664, 1670, 1671, 1684,
    1758, 1767, 1784, 1868, 1869, 1876,
  ],
  [Endpoints.INDIA]: [91],
};

const LOGIN_ERROR_MESSAGES = {
  1004: "Please make sure your endpoint, accessId, accessKey is right.",
  1106: "Please make sure your countryCode, username, password, appSchema is correct, and app account is linked with cloud project.",
  1114: "Please make sure your endpoint, accessId, accessKey is right.",
  2401: "Username or password is wrong.",
  2406: "Please make sure you selected the right data center where your app account located, and the app account is linked with cloud project.",
};

const API_NOT_SUBSCRIBED_ERROR = `
API not subscribed. Please go to "Tuya IoT Platform -> Cloud -> Development -> Project -> Service API",
and Authorize the following APIs before using:
- Authorization Token Management
- Device Status Notification
- IoT Core
- Industry Project Client Service (for "Custom" project)
`;

const API_ERROR_MESSAGES = {
  1010: "Token expired. Tuya Cloud doesn't support running multiple instances with same tuya account.",
  28841002:
    "API subscription expired. Please renew the API subscription at Tuya IoT Platform.",
  28841101: API_NOT_SUBSCRIBED_ERROR,
  28841105: API_NOT_SUBSCRIBED_ERROR,
};

class TuyaOpenAPI {
  constructor(
    endpoint,
    accessId,
    accessKey,
    log = console,
    lang = "en",
    debug = false,
  ) {
    this.endpoint = endpoint;
    this.accessId = accessId;
    this.accessKey = accessKey;
    this.lang = lang;
    this.debug = debug;
    this.assetIDArr = [];
    this.deviceArr = [];
    this.tokenInfo = {
      access_token: "",
      refresh_token: "",
      uid: "",
      expire: 0,
    };
    this.log = new PrefixLogger(log, "TuyaOpenAPI", debug);
    // Optional handler for full re-login when token refresh fails.
    // Set via setReloginHandler(). Called with no arguments, must return
    // { success: true/false }.
    this._reloginHandler = null;
    // Per-device cache of the snapshot endpoint that last succeeded.
    // Avoids probing all 8 endpoint patterns on every 30s poll cycle.
    this._snapshotEndpointCache = new Map();
    this._snapshotEndpointCache.maxSize = 50;
  }

  setReloginHandler(handler) {
    this._reloginHandler = handler;
  }

  static getDefaultEndpoint(countryCode) {
    for (const endpoint of Object.keys(DEFAULT_ENDPOINTS)) {
      if (DEFAULT_ENDPOINTS[endpoint].includes(countryCode)) {
        return endpoint;
      }
    }
    return Endpoints.AMERICA;
  }

  isLogin() {
    return this.tokenInfo.access_token.length > 0;
  }

  isTokenExpired() {
    return this.tokenInfo.expire - 60 * 1000 <= new Date().getTime();
  }

  isTokenManagementAPI(path) {
    return path != null && path.startsWith("/v1.0/token");
  }

  async _refreshAccessTokenIfNeed(path) {
    if (!this.isLogin()) return;
    if (!this.isTokenExpired()) return;
    if (this.isTokenManagementAPI(path)) return;
    this.log.debug("Refreshing access_token");
    const res = await this.get(`/v1.0/token/${this.tokenInfo.refresh_token}`);
    if (res.success === false) {
      this.log.error(
        "Refresh access_token failed. code = %s, msg = %s",
        res.code,
        res.msg,
      );
      if (this._reloginHandler) {
        this.log.info("Attempting full re-login...");
        try {
          const loginRes = await this._reloginHandler();
          if (loginRes && loginRes.success) {
            this.log.info("Re-login successful");
            return;
          }
          this.log.error("Re-login failed");
        } catch (loginErr) {
          this.log.error("Re-login error: %s", loginErr.message);
        }
      }
      return;
    }
    const { access_token, refresh_token, uid, expire_time } = res.result;
    this.tokenInfo = {
      access_token,
      refresh_token,
      uid,
      expire: expire_time * 1000 + new Date().getTime(),
    };
  }

  async getToken() {
    const res = await this.get("/v1.0/token", { grant_type: 1 });
    if (res.success) {
      const { access_token, refresh_token, uid, expire_time } = res.result;
      this.tokenInfo = {
        access_token,
        refresh_token,
        uid,
        expire: expire_time * 1000 + new Date().getTime(),
      };
    }
    return res;
  }

  async homeLogin(countryCode, username, password, appSchema) {
    if (this._isSaltedPassword(password)) {
      this.log.info("Login with md5 salted password.");
    } else {
      password = crypto.createHash("md5").update(password).digest("hex");
    }
    this.log.info("Login to: %s", this.endpoint);
    this.tokenInfo = {
      access_token: "",
      refresh_token: "",
      uid: "",
      expire: 0,
    };
    const res = await this.post(
      "/v1.0/iot-01/associated-users/actions/authorized-login",
      {
        country_code: countryCode,
        username,
        password,
        schema: appSchema,
      },
    );
    if (res.success) {
      const { access_token, refresh_token, uid, expire_time, platform_url } =
        res.result;
      this.endpoint = platform_url || this.endpoint;
      this.tokenInfo = {
        access_token,
        refresh_token,
        uid,
        expire: expire_time * 1000 + new Date().getTime(),
      };
    }
    return res;
  }

  async customGetUserInfo(username) {
    return this.get(`/v1.2/iot-02/users/${username}`);
  }

  async customCreateUser(username, password, country_code = 1) {
    return this.post("/v1.0/iot-02/users", {
      username,
      password: crypto.createHash("sha256").update(password).digest("hex"),
      country_code,
    });
  }

  async customLogin(username, password) {
    this.tokenInfo = {
      access_token: "",
      refresh_token: "",
      uid: "",
      expire: 0,
    };
    const res = await this.post("/v1.0/iot-03/users/login", {
      username,
      password: crypto.createHash("sha256").update(password).digest("hex"),
    });
    if (res.success) {
      const { access_token, refresh_token, uid, expire } = res.result;
      this.tokenInfo = {
        access_token,
        refresh_token,
        uid,
        expire: expire * 1000 + new Date().getTime(),
      };
    }
    return res;
  }

  // opts.suppressErrorLog: when true, API errors are logged at debug instead of
  // warn. Use for speculative calls where failure is expected (e.g. probing
  // multiple snapshot endpoint patterns in getCameraSnapshot).
  async request(method, path, params, body, opts) {
    const suppressErrorLog = !!(opts && opts.suppressErrorLog);
    await this._refreshAccessTokenIfNeed(path);

    const res = await this._doRequest(method, path, params, body, opts);

    // Auto-recover from token expired/invalid (Tuya error code 1010).
    // This typically happens when the server-side token expires before our
    // local expiry timestamp — the old token is rejected but _refreshAccessTokenIfNeed
    // skipped because isTokenExpired() returned false.
    if (
      res &&
      res.success === false &&
      res.code === 1010 &&
      !this.isTokenManagementAPI(path)
    ) {
      this.log.warn(
        "Token rejected by server (code=1010), forcing re-auth and retrying once...",
      );
      // Force-invalidate the local token so _refreshAccessTokenIfNeed
      // picks it up and triggers the full refresh → re-login flow.
      this.tokenInfo.expire = 0;
      this.tokenInfo.access_token = "";
      await this._refreshAccessTokenIfNeed(path);
      if (this.isLogin()) {
        this.log.info("Re-auth successful, retrying original request");
        return this._doRequest(method, path, params, body, opts);
      }
      this.log.error("Re-auth failed after server token rejection");
    }

    this.log.debug(
      "Response:\npath = %s\ndata = %s",
      path,
      JSON.stringify(res, null, 2),
    );

    if (res) {
      if (res.success !== true && API_ERROR_MESSAGES[res.code]) {
        this.log.error(API_ERROR_MESSAGES[res.code]);
      }
      if (res.success !== true) {
        if (suppressErrorLog) {
          this.log.debug(
            "API error: path=%s code=%s msg=%s",
            path,
            res.code,
            res.msg,
          );
        } else {
          this.log.warn(
            "API error: path=%s code=%s msg=%s",
            path,
            res.code,
            res.msg,
          );
        }
      }
    }
    return res;
  }

  async _doRequest(method, path, params, body, opts) {
    const suppressErrorLog = !!(opts && opts.suppressErrorLog);
    const now = new Date().getTime();
    const nonce = uuidv4();
    const accessToken = this.tokenInfo.access_token || "";
    const stringToSign = this._getStringToSign(method, path, params, body);

    const headers = {
      t: `${now}`,
      client_id: this.accessId,
      nonce,
      "Signature-Headers": "client_id",
      sign: this._getSign(
        this.accessId,
        this.accessKey,
        this.isTokenManagementAPI(path) ? "" : this.tokenInfo.access_token,
        now,
        nonce,
        stringToSign,
      ),
      sign_method: "HMAC-SHA256",
      access_token: accessToken,
      lang: this.lang,
      dev_lang: "javascript",
      dev_channel: "doimus",
      devVersion: "1.7.0-beta.58",
    };

    this.log.debug(
      "Request:\nmethod = %s\nendpoint = %s\npath = %s\nquery = %s\nheaders = %s\nbody = %s",
      method,
      this.endpoint,
      path,
      JSON.stringify(params, null, 2),
      JSON.stringify(headers, null, 2),
      JSON.stringify(body, null, 2),
    );

    if (params) {
      path += "?" + new URLSearchParams(params).toString();
    }

    return await retry(
      () =>
        new Promise((resolve, reject) => {
          const req = https.request(
            { host: new URL(this.endpoint).host, method, headers, path },
            (res) => {
              res.setEncoding("utf8");
              let rawData = "";
              res.on("data", (chunk) => {
                rawData += chunk;
              });
              res.on("end", () => {
                if (res.statusCode !== 200) {
                  if (suppressErrorLog) {
                    this.log.debug(
                      "Status: %d %s for %s",
                      res.statusCode,
                      res.statusMessage,
                      path,
                    );
                  } else {
                    this.log.warn(
                      "Status: %d %s for %s",
                      res.statusCode,
                      res.statusMessage,
                      path,
                    );
                  }
                  // Try to parse the response body even for errors
                  try {
                    resolve(JSON.parse(rawData));
                  } catch (_) {
                    resolve({
                      success: false,
                      code: res.statusCode,
                      msg: res.statusMessage,
                    });
                  }
                  return;
                }
                try {
                  resolve(JSON.parse(rawData));
                } catch (parseErr) {
                  reject(
                    new Error(`Invalid JSON response: ${parseErr.message}`),
                  );
                }
              });
            },
          );
          // Add timeout to prevent hanging requests
          req.setTimeout(30000, () => {
            req.destroy(new Error("Request timeout after 30s"));
          });
          if (body) req.write(JSON.stringify(body));
          req.on("error", (e) => {
            this.log.error(
              "Network error for %s: %s. Retrying...",
              path,
              e.message,
            );
            reject(e);
          });
          req.end();
        }),
      undefined,
      {
        retriesMax: 10,
        interval: 100,
        exponential: true,
        factor: 2,
        jitter: 100,
      },
    );
  }

  async get(path, params, opts) {
    return this.request("get", path, params, null, opts);
  }

  async post(path, params, opts) {
    return this.request("post", path, null, params, opts);
  }

  async delete(path, params) {
    return this.request("delete", path, params, null);
  }

  _getSign(
    accessId,
    accessKey,
    accessToken = "",
    timestamp = 0,
    nonce,
    stringToSign,
  ) {
    const message = [
      accessId,
      accessToken,
      timestamp,
      nonce,
      stringToSign,
    ].join("");
    return crypto
      .createHmac("SHA256", accessKey)
      .update(message)
      .digest("hex")
      .toUpperCase();
  }

  _getStringToSign(method, path, params, body) {
    const httpMethod = method.toUpperCase();
    const bodyStream = body ? JSON.stringify(body) : "";
    const contentSHA256 = crypto
      .createHash("sha256")
      .update(bodyStream)
      .digest("hex");
    const headers = `client_id:${this.accessId}\n`;
    const url = this._getSignUrl(path, params);
    return [httpMethod, contentSHA256, headers, url].join("\n");
  }

  _getSignUrl(path, params) {
    if (!params) return path;
    const sortedKeys = Object.keys(params).sort();
    const kv = [];
    for (const key of sortedKeys) {
      if (params[key] !== null && params[key] !== undefined) {
        kv.push(`${key}=${params[key]}`);
      }
    }
    return `${path}?${kv.join("&")}`;
  }

  _isSaltedPassword(password) {
    return Buffer.from(password, "hex").length === 16;
  }

  async getCameraSnapshot(deviceId) {
    // Try cached endpoint first (avoids probing all 8 patterns every 30s).
    const cached = this._snapshotEndpointCache.get(deviceId);
    if (cached) {
      const { method, path, body } = cached;
      const res =
        method === "get"
          ? await this.get(path, null, { suppressErrorLog: true })
          : await this.request("post", path, null, body, {
              suppressErrorLog: true,
            });
      const cachedUrl =
        typeof res.result === "string" ? res.result : res.result?.url;
      if (res.success && cachedUrl) {
        return this._fetchSnapshotImage(cachedUrl);
      }
      // Cached endpoint stopped working — evict and fall through to full probe.
      this.log.debug(
        "Cached snapshot endpoint failed (method=%s path=%s): code=%s msg=%s — re-probing",
        method,
        path,
        res.code,
        res.msg,
      );
      this._snapshotEndpointCache.delete(deviceId);
    }

    // Full probe: try multiple snapshot API endpoint patterns — different
    // device models and API versions use different paths, HTTP methods, and
    // body formats.
    const endpoints = [
      // Camera-specific capture endpoint (used by IPC/doorbell/peephole, e.g.
      // sp-category devices). Confirmed working via Node-RED reference.
      {
        method: "post",
        path: `/v1.0/cameras/${deviceId}/actions/capture`,
        body: {},
      },
      // Standard IoT Core — some devices need a body parameter
      {
        method: "post",
        path: `/v1.0/devices/${deviceId}/snapshot`,
        body: null,
      },
      {
        method: "post",
        path: `/v1.0/devices/${deviceId}/snapshot`,
        body: { snapshot_channel: 0 },
      },
      {
        method: "post",
        path: `/v1.0/devices/${deviceId}/snapshot`,
        body: { type: 0 },
      },
      { method: "get", path: `/v1.0/devices/${deviceId}/snapshot`, body: null },
      // Industry project (iot-03)
      {
        method: "post",
        path: `/v1.0/iot-03/devices/${deviceId}/snapshot`,
        body: null,
      },
      {
        method: "post",
        path: `/v1.0/iot-03/devices/${deviceId}/snapshot`,
        body: { snapshot_channel: 0 },
      },
      {
        method: "get",
        path: `/v1.0/iot-03/devices/${deviceId}/snapshot`,
        body: null,
      },
      // Alternative API versions
      {
        method: "post",
        path: `/v1.1/devices/${deviceId}/snapshot`,
        body: null,
      },
    ];

    // Suppress error logging in request() — failures are expected when probing
    // multiple endpoint patterns. getCameraSnapshot() handles all logging
    // itself at the appropriate level.
    for (const { method, path, body } of endpoints) {
      let res;
      if (method === "get") {
        res = await this.get(path, null, { suppressErrorLog: true });
      } else {
        res = await this.request("post", path, null, body, {
          suppressErrorLog: true,
        });
      }
      // result may be a plain URL string (cameras/actions/capture) or {url: "..."}
      const snapshotUrl =
        typeof res.result === "string" ? res.result : res.result?.url;
      if (res.success && snapshotUrl) {
        // Cache the winning endpoint so subsequent polls skip the probe.
        if (this._snapshotEndpointCache.size >= this._snapshotEndpointCache.maxSize) {
          const firstKey = this._snapshotEndpointCache.keys().next().value;
          this._snapshotEndpointCache.delete(firstKey);
        }
        this._snapshotEndpointCache.set(deviceId, { method, path, body });
        this.log.info(
          "Snapshot URL obtained (method=%s path=%s, cached): %s",
          method,
          path,
          snapshotUrl,
        );
        return this._fetchSnapshotImage(snapshotUrl);
      }
      if (!res.success) {
        this.log.debug(
          "Snapshot attempt failed (method=%s path=%s): code=%s msg=%s",
          method,
          path,
          res.code,
          res.msg,
        );
      } else {
        this.log.debug(
          "Snapshot success but no URL (method=%s path=%s): result=%s",
          method,
          path,
          JSON.stringify(res.result),
        );
      }
    }

    this.log.warn("All snapshot endpoints exhausted for device %s", deviceId);
    return null;
  }

  // Downloads the image from a snapshot URL. Extracted as a helper so both
  // the cached and full-probe paths can reuse the same download logic.
  _fetchSnapshotImage(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        req.destroy(new Error(`Snapshot fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const req = https.get(url, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
        r.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

TuyaOpenAPI.Endpoints = Endpoints;
TuyaOpenAPI.LOGIN_ERROR_MESSAGES = LOGIN_ERROR_MESSAGES;

module.exports = TuyaOpenAPI;
