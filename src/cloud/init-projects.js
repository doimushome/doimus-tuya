const TuyaOpenAPI = require("../cloud/api/TuyaOpenAPI");
const TuyaCustomDeviceManager = require("../cloud/device/TuyaCustomDeviceManager");
const TuyaHomeDeviceManager = require("../cloud/device/TuyaHomeDeviceManager");
const { retryWithBackoff } = require("../shared/plugin-utils");

async function initCustomProject(api, options, log) {
  const { endpoint, accessId, accessKey, debug, debugLevel } = options;
  const debugMode =
    debug &&
    ((debugLevel || "").length > 0 ? debugLevel.includes("api") : true);

  const openAPI = new TuyaOpenAPI(
    endpoint,
    accessId,
    accessKey,
    log,
    "en",
    debugMode,
  );
  // Forward structured warnings (e.g. missing Service API subscriptions) to
  // the Doimus host so they surface in the mobile app.
  openAPI.setWarningHandler((code, message) => {
    if (api && typeof api.reportWarning === "function") {
      api.reportWarning(code, message);
    }
  });
  const dm = new TuyaCustomDeviceManager(openAPI, debugMode);

  log("info", "Get token.");
  let res = await retryWithBackoff(() => openAPI.getToken(), 4, 2000, log);
  if (res.success === false) {
    log("error", `Get token failed. code=${res.code}, msg=${res.msg}`);
    return null;
  }

  const DEFAULT_USER = "doimus";
  log("info", `Search default user "${DEFAULT_USER}"`);
  res = await openAPI.customGetUserInfo(DEFAULT_USER);
  if (res.success === false) {
    log("error", `Search user failed. code=${res.code}, msg=${res.msg}`);
    return null;
  }

  if (!res.result || !res.result.user_name) {
    log("info", `Creating default user "${DEFAULT_USER}".`);
    res = await openAPI.customCreateUser(DEFAULT_USER, DEFAULT_USER);
    if (res.success === false) {
      log(
        "error",
        `Create default user failed. code=${res.code}, msg=${res.msg}`,
      );
      return null;
    }
  }

  const uid = res.result.user_id;
  log("info", "Fetching asset list.");
  res = await dm.getAssetList();
  if (res.success === false) {
    log(
      "error",
      `Fetching asset list failed. code=${res.code}, msg=${res.msg}`,
    );
    return null;
  }

  const assetIDList = (res.result.list || []).map((a) => a.asset_id);
  if (assetIDList.length === 0) {
    log("warn", "Asset list is empty.");
    return null;
  }

  log("info", "Authorize asset list.");
  res = await dm.authorizeAssetList(uid, assetIDList, true);
  if (res.success === false) {
    log(
      "error",
      `Authorize asset list failed. code=${res.code}, msg=${res.msg}`,
    );
    return null;
  }

  log("info", "Logging in with user.");
  res = await openAPI.customLogin(DEFAULT_USER, DEFAULT_USER);
  if (res.success === false) {
    log("error", `Login failed. code=${res.code}, msg=${res.msg}`);
    if (TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]) {
      log("error", TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]);
    }
    return null;
  }

  let reLoginInFlight = false;
  openAPI.setReloginHandler(async () => {
    if (reLoginInFlight) {
      log("warn", "Re-login already in progress — skipping duplicate");
      return { success: true };
    }
    reLoginInFlight = true;
    log("info", "Re-logging in default user due to token expiry...");
    try {
      const result = await openAPI.customLogin(DEFAULT_USER, DEFAULT_USER);
      if (result && result.success) {
        log(
          "info",
          "Re-login successful, restarting MQTT with fresh credentials...",
        );
        try {
          dm.mq.start();
        } catch (mqErr) {
          log("warn", `MQTT restart after re-login failed: ${mqErr.message}`);
        }
      }
      return result;
    } finally {
      reLoginInFlight = false;
    }
  });

  log("info", "Starting MQTT connection.");
  dm.mq.start();
  log("info", "Fetching device list.");
  dm.ownerIDs = assetIDList;
  await dm.updateDevices(assetIDList);
  return { dm, uid, debugMode };
}

async function initHomeProject(api, options, log) {
  const {
    accessId,
    accessKey,
    countryCode,
    username,
    password,
    appSchema,
    endpoint,
    debug,
    debugLevel,
  } = options;
  const debugMode =
    debug &&
    ((debugLevel || "").length > 0 ? debugLevel.includes("api") : true);

  const resolvedEndpoint =
    endpoint && endpoint.length > 0
      ? endpoint
      : TuyaOpenAPI.getDefaultEndpoint(countryCode);

  const openAPI = new TuyaOpenAPI(
    resolvedEndpoint,
    accessId,
    accessKey,
    log,
    "en",
    debugMode,
  );
  // Forward structured warnings (e.g. missing Service API subscriptions) to
  // the Doimus host so they surface in the mobile app.
  openAPI.setWarningHandler((code, message) => {
    if (api && typeof api.reportWarning === "function") {
      api.reportWarning(code, message);
    }
  });
  const dm = new TuyaHomeDeviceManager(openAPI, debugMode);

  log("info", "Logging in to Tuya Cloud.");
  let res = await retryWithBackoff(
    () => openAPI.homeLogin(countryCode, username, password, appSchema),
    4,
    2000,
    log,
  );
  if (res.success === false) {
    log("error", `Login failed. code=${res.code}, msg=${res.msg}`);
    if (TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]) {
      log("error", TuyaOpenAPI.LOGIN_ERROR_MESSAGES[res.code]);
    }
    return null;
  }

  let reLoginInFlight = false;
  openAPI.setReloginHandler(async () => {
    if (reLoginInFlight) {
      log("warn", "Re-login already in progress — skipping duplicate");
      return { success: true };
    }
    reLoginInFlight = true;
    log("info", "Re-logging in to Tuya Cloud due to token expiry...");
    try {
      const result = await openAPI.homeLogin(
        countryCode,
        username,
        password,
        appSchema,
      );
      if (result && result.success) {
        log(
          "info",
          "Re-login successful, restarting MQTT with fresh credentials...",
        );
        try {
          dm.mq.start();
        } catch (mqErr) {
          log("warn", `MQTT restart after re-login failed: ${mqErr.message}`);
        }
      }
      return result;
    } finally {
      reLoginInFlight = false;
    }
  });

  log("info", "Starting MQTT connection.");
  dm.mq.start();

  log("info", "Fetching home list.");
  res = await dm.getHomeList();
  if (res.success === false) {
    log("error", `Fetching home list failed. code=${res.code}, msg=${res.msg}`);
    return null;
  }

  const homeWhitelist = options.homeWhitelist;
  const homeIDList = [];
  for (const { home_id, name } of res.result || []) {
    log("info", `Got home_id=${home_id}, name=${name}`);
    if (!homeWhitelist || homeWhitelist.includes(home_id)) {
      homeIDList.push(home_id);
    }
  }

  if (homeIDList.length === 0) {
    log("warn", "Home list is empty or no whitelisted homes found.");
    return { dm, uid: openAPI.tokenInfo.uid, debugMode };
  }

  log("info", "Fetching device list.");
  dm.ownerIDs = homeIDList.map((id) => id.toString());
  await dm.updateDevices(homeIDList);

  log("info", "Fetching scenes.");
  for (const homeID of homeIDList) {
    const scenes = await dm.getSceneList(homeID);
    if (scenes.length > 0) {
      dm.devices.push(...scenes);
      log("info", `Got ${scenes.length} scene(s) from home ${homeID}`);
    }
  }

  return { dm, uid: openAPI.tokenInfo.uid, debugMode };
}

module.exports = { initCustomProject, initHomeProject };
