const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const MOTION_DP_PATTERN = /motion|movement|doorbell|human|person|pir/i;

// Keys whose values are secrets and must never reach the logs.
const SENSITIVE_KEY = /password|passwd|access_token|refresh_token|token|secret|credential|authorization|auth\b/i;

/**
 * Deep-redact sensitive fields from arbitrary log payloads (headers, bodies,
 * API responses). Returns a structure safe to serialize. Any object key whose
 * name matches SENSITIVE_KEY is replaced with "[REDACTED]".
 */
function redactSecrets(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) =>
      key && SENSITIVE_KEY.test(key) ? "[REDACTED]" : val,
    ),
  );
}

// Redact credentials embedded in URLs (mqtt://user:pass@host, ?token=..., etc).
function redactUrl(url) {
  if (typeof url !== "string") return url;
  try {
    const u = new URL(url);
    if (u.username) u.username = "[REDACTED]";
    if (u.password) u.password = "[REDACTED]";
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) u.searchParams.set(key, "[REDACTED]");
    }
    return u.toString();
  } catch (_) {
    // Not a parseable URL — mask anything that looks like a credential pair.
    return String(url).replace(
      /(:\/\/)[^/@\s]+@/g,
      "$1[REDACTED]:[REDACTED]@",
    );
  }
}

async function retryWithBackoff(fn, maxRetries = 4, baseDelayMs = 1000, log) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        if (log)
          log(
            "warn",
            `Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e.message}`,
          );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function createLogger(api, prefix) {
  return (level, msg) => api.log(level, `[${prefix}] ${msg}`);
}

function generateUUID(id) {
  const hash = crypto.createHash("sha256").update(id).digest("hex");
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    "5" + hash.substring(12, 15),
    ((parseInt(hash.substring(15, 17), 16) & 0x3f) | 0x80).toString(16) +
      hash.substring(17, 19),
    hash.substring(19, 31),
  ].join("-");
}

function validateConfig(options, log) {
  if (options.deviceOverrides) {
    const idMap = new Map();
    for (const item of options.deviceOverrides) {
      if (idMap.has(item.id)) {
        idMap.get(item.id).push(item);
      } else {
        idMap.set(item.id, [item]);
      }
    }
    for (const [id, items] of idMap.entries()) {
      if (items.length > 1) {
        log(
          "error",
          `"deviceOverrides" conflict: "id" "${id}" must be unique.`,
        );
        return false;
      }
    }

    for (const deviceOverride of options.deviceOverrides) {
      if (!deviceOverride.schema) continue;
      const codeMap = new Map();
      for (const item of deviceOverride.schema) {
        if (codeMap.has(item.code)) {
          codeMap.get(item.code).push(item);
        } else {
          codeMap.set(item.code, [item]);
        }
      }
      for (const [code, items] of codeMap.entries()) {
        if (items.length > 1) {
          log("error", `"schema" conflict: "code" "${code}" must be unique.`);
          return false;
        }
      }
    }

    const VALID_TYPES = ["Boolean", "Integer", "Enum", "String", "Json", "Raw"];
    for (const deviceOverride of options.deviceOverrides) {
      if (!deviceOverride.schema) continue;
      for (const item of deviceOverride.schema) {
        if (item.type && !VALID_TYPES.includes(item.type)) {
          log(
            "error",
            `Invalid schema type "${item.type}" for code "${item.code}". Valid: ${VALID_TYPES.join(", ")}`,
          );
          return false;
        }
        if (item.property) {
          const p = item.property;
          if (
            p.min !== undefined &&
            p.max !== undefined &&
            Number(p.min) >= Number(p.max)
          ) {
            log(
              "error",
              `Invalid property range for code "${item.code}": min (${p.min}) >= max (${p.max})`,
            );
            return false;
          }
        }
      }
    }
  }
  return true;
}

function computeNeedsWake(tuyaDevice) {
  const isCamera = ["sp", "mobilecam", "wxml", "doorbell"].includes(
    tuyaDevice.category,
  );
  const batteryCodes =
    tuyaDevice.schema
      ?.filter(
        (s) =>
          s.code === "battery_percentage" ||
          s.code === "battery_state" ||
          s.code === "battery_value" ||
          s.code === "va_battery" ||
          s.code === "wireless_electricity" ||
          s.code === "wireless_powermode" ||
          (s.code && s.code.startsWith("battery")),
      )
      .map((s) => s.code) || [];
  return isCamera && batteryCodes.length > 0;
}

async function persistDeviceList(api, dm, uid, log) {
  try {
    const persistPath = path.join(process.cwd(), "data", "persist");
    if (!fs.existsSync(persistPath)) {
      fs.mkdirSync(persistPath, { recursive: true });
    }
    const file = path.join(persistPath, `TuyaDeviceList.${uid}.json`);
    const devices = dm.devices.map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      product_id: d.product_id,
      online: d.online,
      schema: d.schema,
      status: d.status,
    }));
    fs.writeFileSync(file, JSON.stringify(devices, null, 2));
    log("info", `Device list saved at ${file}`);
  } catch (e) {
    log("debug", `Persist device list failed: ${e.message}`);
  }
}

module.exports = {
  MOTION_DP_PATTERN,
  retryWithBackoff,
  createLogger,
  generateUUID,
  validateConfig,
  computeNeedsWake,
  persistDeviceList,
  redactSecrets,
  redactUrl,
};
