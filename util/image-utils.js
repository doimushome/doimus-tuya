const crypto = require("crypto");
const http = require("http");
const https = require("https");

/**
 * Extracts bucket, file_path, and optional encryption key without
 * performing any network requests.
 */
function parseMotionMetadata(status, log, deviceName) {
  for (const item of status) {
    if (item.code !== "initiative_message") continue;

    // Format 1: numeric keys (e.g. "1680000000000") holding base64 JSON.
    // This is the most common format for newer Tuya camera firmware.
    const metaKey = Object.keys(item).find(
      (k) =>
        /^\d+$/.test(k) && typeof item[k] === "string" && item[k].length > 20,
    );
    if (metaKey) {
      let meta;
      try {
        meta = JSON.parse(
          Buffer.from(item[metaKey], "base64").toString("utf8"),
        );
      } catch (_) {
        log(
          "debug",
          `initiative_message numeric-key metadata parse failed for "${deviceName}"`,
        );
        continue;
      }
      if (!meta.bucket || !meta.files || !meta.files[0] || !meta.files[0][0]) {
        log(
          "debug",
          `initiative_message numeric-key metadata missing bucket/files for "${deviceName}"`,
        );
        continue;
      }
      return {
        bucket: meta.bucket,
        filePath: meta.files[0][0],
        encKey: meta.files[0][1] || null,
      };
    }

    // Format 2: .value is a JSON string with S3 coordinates.
    // Some Tuya firmware versions put S3 metadata directly in the value
    // field instead of under a numeric key.  The value is a JSON object
    // with "bucket" and "files" but no inline "data"/"iv" (so
    // tryDecodeInitiativeMessage would have already skipped it).
    if (typeof item.value === "string" && item.value.length > 0) {
      let meta;
      try {
        meta = JSON.parse(item.value);
      } catch (_) {
        // Not JSON — not S3 metadata.
        continue;
      }
      if (meta.bucket && meta.files && meta.files[0] && meta.files[0][0]) {
        log(
          "debug",
          `initiative_message value-JSON metadata found for "${deviceName}"`,
        );
        return {
          bucket: meta.bucket,
          filePath: meta.files[0][0],
          encKey: meta.files[0][1] || null,
        };
      }
    }

    log(
      "debug",
      `initiative_message without recognisable metadata for "${deviceName}"`,
    );
  }
  return null;
}

function detectImageMime(data) {
  if (!data || data.length < 4) return "application/octet-stream";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    data.length > 12 &&
    data.slice(0, 4).toString("ascii") === "RIFF" &&
    data.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

function extractSnapshotUrlFromStatus(status) {
  for (const item of status || []) {
    if (!item || typeof item.value !== "string" || item.value.length < 8)
      continue;

    const raw = item.value.trim();
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }

    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    } catch (_) {
      // ignore invalid base64
    }
  }
  return null;
}

async function downloadImageFromUrl(url, log, deviceName, depth = 0) {
  if (!url || depth > 2) return null;
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      resolve(null);
      return;
    }

    const client = parsed.protocol === "http:" ? http : https;
    const req = client.get(url, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        const redirect = new URL(res.headers.location, url).toString();
        downloadImageFromUrl(redirect, log, deviceName, depth + 1).then(
          resolve,
        );
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const data = Buffer.concat(chunks);
        const mime = detectImageMime(data);
        if (!mime.startsWith("image/")) {
          log(
            "debug",
            `Snapshot URL payload is not an image for "${deviceName}": mime=${mime} size=${data.length}`,
          );
          resolve(null);
          return;
        }
        resolve({ data, mime });
      });
    });
    req.on("error", () => { clearTimeout(timer); resolve(null); });
    const timer = setTimeout(() => {
      req.destroy();
      resolve(null);
    }, 15000);
  });
}

/**
 * Fetch and decrypt a camera image via Tuya movement-configs API + S3.
 * Network-heavy — call after a delay to let the camera finish uploading.
 */
async function fetchMotionImageFromS3(device, metadata, dm, ctx, log) {
  const { bucket, filePath, encKey } = metadata;

  log(
    "info",
    `Fetching motion image: device="${device.name}" bucket=${bucket} file=${filePath}`,
  );

  // Step 1: Get S3 presigned URL from Tuya movement-configs API
  const configRes = await dm.api.get(
    `/v1.0/devices/${device.id}/movement-configs`,
    { bucket, file_path: filePath },
  );

  if (!configRes.success || !configRes.result) {
    log(
      "warn",
      `Movement-configs API failed for "${device.name}": code=${configRes.code} msg=${configRes.msg}`,
    );
    return null;
  }

  // Result may be a string (URL) or an object with url property.
  const s3Url =
    typeof configRes.result === "string"
      ? configRes.result
      : configRes.result.url;

  if (!s3Url) {
    log(
      "warn",
      `Movement-configs returned no URL for "${device.name}": ${JSON.stringify(configRes.result)}`,
    );
    return null;
  }

  // Step 2: Download from S3 presigned URL
  try {
    const raw = await new Promise((resolve, reject) => {
      https
        .get(s3Url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`S3 status ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        })
        .on("error", reject);
    });

    // Plain JPEG (no encryption).
    if (raw[0] === 0xff && raw[1] === 0xd8) {
      log(
        "info",
        `Motion image fetched: device="${device.name}" size=${raw.length}B`,
      );
      return raw;
    }

    // Encrypted blob: [4 bytes version LE][16 bytes IV][N bytes header][ciphertext]
    // Different Tuya camera models use different header sizes.  Find the
    // largest header offset that leaves a 16-byte-aligned ciphertext.
    if (encKey && raw.length > 68) {
      const iv = raw.slice(4, 20);
      const aesKey = Buffer.from(encKey, "utf8");

      // Header sizes to try (4+16+header): MG-Sky=64, our guess=68, others.
      // Cache the first working offset per device to skip probing on subsequent events.
      if (!ctx._snapshotOffsetCache) ctx._snapshotOffsetCache = new Map();
      if (ctx._snapshotOffsetCache.size > 100) ctx._snapshotOffsetCache.clear();
      const cachedOffset = ctx._snapshotOffsetCache.get(device.id);
      const offsets =
        cachedOffset != null ? [cachedOffset] : [64, 68, 72, 60, 56, 76, 80];
      let success = false;

      for (const offset of offsets) {
        const ciphertext = raw.slice(offset);
        if (ciphertext.length % 16 !== 0) continue;

        try {
          const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
          decipher.setAutoPadding(true);
          const jpeg = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ]);

          if (jpeg[0] === 0xff && jpeg[1] === 0xd8) {
            ctx._snapshotOffsetCache.set(device.id, offset);
            log(
              "info",
              `Motion image decrypted: device="${device.name}" size=${jpeg.length}B offset=${offset}`,
            );
            return jpeg;
          }
        } catch (_) {
          // Try next offset.
        }
      }

      if (!success) {
        log(
          "debug",
          `AES decrypt failed for "${device.name}": tried offsets=${offsets.join(",")} totalLen=${raw.length}`,
        );
      }
    } else {
      log(
        "debug",
        `S3 response not JPEG (no encKey) for "${device.name}": magic=${raw.slice(0, 4).toString("hex")}`,
      );
    }
  } catch (e) {
    log("warn", `S3 fetch failed for "${device.name}": ${e.message}`);
  }
  return null;
}

/**
 * Attempt to decode an inline camera image from device status.
 *
 * Handles two formats:
 * 1. initiative_message — JSON with hex-encoded AES-128-CBC data (v4.0)
 * 2. movement_detect_pic / doorbell_pic — base64 AES-128-ECB data
 *
 * Returns a JPEG Buffer or null.
 */
function tryDecodeCameraImage(device, status, log) {
  const localKey = device.local_key;
  if (!localKey) {
    if (log)
      log(
        "debug",
        `Camera image decode skipped: no local_key for "${device.name}"`,
      );
    return null;
  }

  // First pass: try initiative_message (only one item will match)
  const imItem = status.find((s) => s.code === "initiative_message" && typeof s.value === "string" && s.value.length > 0);
  if (imItem) {
    const jpeg = tryDecodeInitiativeMessage(imItem, localKey, log);
    if (jpeg) return jpeg;
  }

  // Second pass: try movement_detect_pic / doorbell_pic / ipc_human
  for (const item of status) {
    if (typeof item.value !== "string" || item.value.length === 0) continue;
    const jpeg = tryDecodeDoorbellPic(item, localKey, log);
    if (jpeg) {
      log(
        "info",
        `Camera image captured: device="${device.name}" code=${item.code} size=${jpeg.length}B`,
      );
      return jpeg;
    }
  }

  if (log) {
    const codes = status
      .filter((s) => typeof s.value === "string" && s.value.length > 0)
      .map((s) => s.code);
    if (codes.length > 0) {
      log(
        "debug",
        `Camera image decode: no JPEG extracted from codes=[${codes.join(",")}] for "${device.name}"`,
      );
    }
  }
  return null;
}

function tryDecodeInitiativeMessage(item, localKey, log) {
  if (item.code !== "initiative_message") return null;
  try {
    const msg = JSON.parse(item.value);
    if (!msg.files || msg.files.length === 0) return null;

    // Try raw local_key, MD5(local_key), SHA256(local_key) — Tuya
    // initiative_message encryption varies by firmware version.
    const rawKey = Buffer.from(localKey, "hex");
    const md5Key = crypto.createHash("md5").update(localKey).digest();
    const sha256Key = crypto.createHash("sha256").update(localKey).digest();
    const keyLabels = ["raw", "md5", "sha256"];

    for (const file of msg.files) {
      if (!file.data || !file.iv) continue;
      try {
        const encrypted = Buffer.from(file.data, "hex");
        const iv = Buffer.from(file.iv, "hex");

        let keyIdx = 0;
        for (const key of [rawKey, md5Key, sha256Key]) {
          const label = keyLabels[keyIdx++];
          try {
            const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
            decipher.setAutoPadding(true);
            const decrypted = Buffer.concat([
              decipher.update(encrypted),
              decipher.final(),
            ]);
            if (decrypted[0] === 0xff && decrypted[1] === 0xd8) {
              if (log) {
                log(
                  "info",
                  `Initiative message decoded OK: key=${label} keyLen=${localKey.length} size=${decrypted.length}B`,
                );
              }
              return decrypted;
            }
            if (log) {
              log(
                "debug",
                `Initiative message decode: key=${label} decrypted but no JPEG magic (first 4 bytes: ${decrypted.slice(0, 4).toString("hex")})`,
              );
            }
          } catch (e) {
            if (log) {
              log(
                "debug",
                `Initiative message decrypt failed: key=${label} error=${e.message}`,
              );
            }
          }
        }
      } catch (_) {
        // file.data or file.iv not valid hex
      }
    }
  } catch (_) {
    // not valid JSON
  }
  return null;
}

function tryDecodeDoorbellPic(item, localKey, log) {
  if (!["movement_detect_pic", "doorbell_pic", "ipc_human"].includes(item.code))
    return null;
  try {
    const encrypted = Buffer.from(item.value, "base64");
    // Try raw local_key, MD5(local_key), SHA256(local_key) — Tuya cameras vary.
    // Some video peephole / doorbell models use SHA256 key derivation.
    const rawKey = Buffer.from(localKey, "hex");
    const md5Key = crypto.createHash("md5").update(localKey).digest();
    const sha256Key = crypto.createHash("sha256").update(localKey).digest();
    const keyLabels = ["raw", "md5", "sha256"];
    let keyIdx = 0;
    for (const key of [rawKey, md5Key, sha256Key]) {
      const label = keyLabels[keyIdx++];
      try {
        const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
        decipher.setAutoPadding(true);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        if (decrypted[0] === 0xff && decrypted[1] === 0xd8) {
          if (log) {
            log(
              "info",
              `Doorbell pic decoded OK: code=${item.code} key=${label} keyLen=${localKey.length} size=${decrypted.length}B`,
            );
          }
          return decrypted;
        }
        if (log) {
          log(
            "debug",
            `Doorbell pic decode: code=${item.code} key=${label} decrypted but no JPEG magic (first 4 bytes: ${decrypted.slice(0, 4).toString("hex")})`,
          );
        }
      } catch (e) {
        if (log) {
          log(
            "debug",
            `Doorbell pic decrypt failed: code=${item.code} key=${label} error=${e.message}`,
          );
        }
      }
    }
    if (log) {
      log(
        "info",
        `Doorbell pic decode: ALL keys failed for code=${item.code} dataLen=${encrypted.length} localKeyLen=${localKey.length}`,
      );
    }
  } catch (_) {
    // not valid base64
  }
  return null;
}

module.exports = {
  parseMotionMetadata,
  detectImageMime,
  extractSnapshotUrlFromStatus,
  downloadImageFromUrl,
  fetchMotionImageFromS3,
  tryDecodeCameraImage,
  tryDecodeInitiativeMessage,
  tryDecodeDoorbellPic,
};
