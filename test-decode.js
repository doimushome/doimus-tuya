#!/usr/bin/env node
/**
 * Local test: decode Tuya camera motion image data.
 *
 * Usage: node test-decode.js <device_id> [accessId] [accessKey] [endpoint]
 *
 * Or paste raw DP values directly:
 *   node test-decode.js --raw "base64value" --key "your_local_key"
 */

const crypto = require("crypto");
const https = require("https");

// ── Helpers ──────────────────────────────────────────────────────────

function base64Decode(str) {
  return Buffer.from(str, "base64");
}

function isJPEG(buf) {
  return buf[0] === 0xff && buf[1] === 0xd8;
}

function isPNG(buf) {
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function isUrl(str) {
  return /^https?:\/\//i.test(str);
}

function tryHexDecode(str) {
  // Some devices send hex-encoded binary
  if (/^[0-9a-fA-F]+$/.test(str) && str.length > 20) {
    try {
      const buf = Buffer.from(str, "hex");
      if (isJPEG(buf)) return buf;
      if (isPNG(buf)) return buf;
      console.log(`  hex decode: ${buf.length} bytes, first 4: ${buf.slice(0, 4).toString("hex")} (not JPEG/PNG)`);
    } catch (e) {
      console.log(`  hex decode failed: ${e.message}`);
    }
  }
  return null;
}

function tryBase64UrlDecode(value) {
  // Approach 1: base64 value might be a URL (doorbell_pic on some devices)
  try {
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    if (isUrl(decoded)) {
      return { type: "url", url: decoded };
    }
    console.log(`  base64→utf8: "${decoded.slice(0, 80)}..." (not a URL)`);
  } catch (_) {}
  return null;
}

function tryBase64RawDecode(value) {
  // Approach 2: base64 value is raw encrypted binary
  try {
    const buf = Buffer.from(value, "base64");
    if (isJPEG(buf)) {
      return { type: "plain_jpeg", buffer: buf };
    }
    if (isPNG(buf)) {
      return { type: "plain_png", buffer: buf };
    }
    return { type: "binary_blob", buffer: buf };
  } catch (_) {
    return null;
  }
}

// ── AES Decrypt Approaches ───────────────────────────────────────────

function tryAesECB(encrypted, key, keyLabel) {
  try {
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted;
  } catch (e) {
    console.log(`  AES-128-ECB (key=${keyLabel}): ${e.message}`);
    return null;
  }
}

function tryAesCBC(encrypted, key, iv, keyLabel) {
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted;
  } catch (e) {
    console.log(`  AES-128-CBC (key=${keyLabel}): ${e.message}`);
    return null;
  }
}

function tryAesECB128(encrypted, key, keyLabel) {
  try {
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false); // try without padding too
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted;
  } catch (e) {
    return null;
  }
}

// ── Decode a single DP value ─────────────────────────────────────────

function decodeValue(rawValue, localKey, accessKey) {
  console.log(`\n─── Decoding value (len=${rawValue.length}) ───`);
  console.log(`  preview: "${rawValue.slice(0, 80)}..."`);

  // Stage 1: is it already a URL?
  const urlResult = tryBase64UrlDecode(rawValue);
  if (urlResult) {
    console.log(`  ✅ SUCCESS: value is a base64-encoded URL!`);
    console.log(`  URL: ${urlResult.url}`);
    return { type: "url", url: urlResult.url };
  }

  // Stage 2: is it raw JPEG/PNG (hex or base64)?
  const hexResult = tryHexDecode(rawValue);
  if (hexResult) {
    console.log(`  ✅ SUCCESS: value is hex-encoded ${isPNG(hexResult) ? "PNG" : "JPEG"}!`);
    return { type: "image", buffer: hexResult };
  }

  const rawResult = tryBase64RawDecode(rawValue);
  if (rawResult && rawResult.type === "plain_jpeg") {
    console.log(`  ✅ SUCCESS: value is base64-encoded JPEG!`);
    return { type: "image", buffer: rawResult.buffer };
  }
  if (rawResult && rawResult.type === "plain_png") {
    console.log(`  ✅ SUCCESS: value is base64-encoded PNG!`);
    return { type: "image", buffer: rawResult.buffer };
  }

  // Stage 3: need to decrypt (base64 → binary blob → AES decrypt)
  let encrypted;
  if (rawResult && rawResult.type === "binary_blob") {
    encrypted = rawResult.buffer;
  } else {
    // Try as base64
    try {
      encrypted = Buffer.from(rawValue, "base64");
      if (isJPEG(encrypted)) {
        console.log(`  ✅ SUCCESS: value is base64-encoded JPEG!`);
        return { type: "image", buffer: encrypted };
      }
    } catch (_) {
      console.log("  ❌ Could not parse value as base64");
      return null;
    }
  }

  console.log(`  encrypted blob: ${encrypted.length} bytes, first 4: ${encrypted.slice(0, 4).toString("hex")}`);

  // Try all known key derivations
  const rawKey = Buffer.from(localKey, "utf8");
  const md5Key = crypto.createHash("md5").update(localKey).digest();
  const sha256Key = crypto.createHash("sha256").update(localKey).digest();

  // MG-Sky approach: ACCESS_KEY[8:24] as AES-ECB key (for MQTT event decryption, not image)
  let accessKeySlice = null;
  try {
    accessKeySlice = Buffer.from(accessKey).slice(8, 24);
  } catch (_) {}

  const keyAttempts = [
    { key: rawKey, label: "local_key (raw utf8)" },
    { key: md5Key, label: "MD5(local_key)" },
    { key: sha256Key, label: "SHA256(local_key)" },
  ];
  if (accessKeySlice && accessKeySlice.length === 16) {
    keyAttempts.push({ key: accessKeySlice, label: "ACCESS_KEY[8:24]" });
  }

  // ECB mode (most common for doorbell_pic / movement_detect_pic)
  console.log("\n  Trying AES-128-ECB...");
  for (const { key, label } of keyAttempts) {
    const result = tryAesECB(encrypted, key, label);
    if (result && (isJPEG(result) || isPNG(result))) {
      console.log(`  ✅ SUCCESS: AES-128-ECB with key=${label} → ${isPNG(result) ? "PNG" : "JPEG"} (${result.length} bytes)`);
      return { type: "image", buffer: result };
    }
    if (result) {
      console.log(`    decrypted but not JPEG/PNG: first 4 bytes=${result.slice(0, 4).toString("hex")}`);
    }
  }

  // Try ECB without padding
  console.log("\n  Trying AES-128-ECB (no padding)...");
  for (const { key, label } of keyAttempts) {
    const result = tryAesECB128(encrypted, key, label);
    if (result && (isJPEG(result) || isPNG(result))) {
      console.log(`  ✅ SUCCESS: AES-128-ECB (no padding) with key=${label} → ${isPNG(result) ? "PNG" : "JPEG"} (${result.length} bytes)`);
      return { type: "image", buffer: result };
    }
  }

  // CBC mode with IV from first 16 bytes of encrypted data
  if (encrypted.length > 16) {
    console.log("\n  Trying AES-128-CBC (iv=first 16 bytes)...");
    const iv = encrypted.slice(0, 16);
    const ciphertext = encrypted.slice(16);
    for (const { key, label } of keyAttempts) {
      const result = tryAesCBC(ciphertext, key, iv, label);
      if (result && (isJPEG(result) || isPNG(result))) {
        console.log(`  ✅ SUCCESS: AES-128-CBC with key=${label} → ${isPNG(result) ? "PNG" : "JPEG"} (${result.length} bytes)`);
        return { type: "image", buffer: result };
      }
    }
  }

  console.log("\n  ❌ All decryption attempts failed.");
  return null;
}

// ── Fetch URL to image buffer ────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        console.log(`  Fetched: ${buf.length} bytes, content-type: ${res.headers["content-type"]}`);
        resolve(buf);
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--raw")) {
    // Paste raw value directly
    const rawIdx = args.indexOf("--raw");
    const rawValue = args[rawIdx + 1];
    const keyIdx = args.indexOf("--key");
    const localKey = keyIdx >= 0 ? args[keyIdx + 1] : "";
    const accessKeyIdx = args.indexOf("--accesskey");
    const accessKey = accessKeyIdx >= 0 ? args[accessKeyIdx + 1] : "";

    if (!rawValue) {
      console.log("Usage: node test-decode.js --raw <base64_value> --key <local_key> [--accesskey <access_key>]");
      console.log("\nGet the raw value from the plugin logs:");
      console.log('  grep "Motion DP received" <backend logs>');
      return;
    }

    const result = decodeValue(rawValue, localKey, accessKey);
    if (result && result.type === "url") {
      console.log("\nFetching image from URL...");
      try {
        const buf = await fetchUrl(result.url);
        if (isJPEG(buf) || isPNG(buf)) {
          console.log(`✅ Image downloaded: ${isPNG(buf) ? "PNG" : "JPEG"} ${buf.length} bytes`);

          // Save to file for inspection
          const fs = require("fs");
          const ext = isPNG(buf) ? "png" : "jpg";
          const filename = `test-snapshot-${Date.now()}.${ext}`;
          fs.writeFileSync(filename, buf);
          console.log(`✅ Saved to ${filename}`);
        } else {
          console.log(`⚠️  Downloaded but not a valid image (first 4 bytes: ${buf.slice(0, 4).toString("hex")})`);
        }
      } catch (e) {
        console.log(`❌ Failed to fetch URL: ${e.message}`);
      }
    } else if (result && result.type === "image") {
      const fs = require("fs");
      const ext = isPNG(result.buffer) ? "png" : "jpg";
      const filename = `test-snapshot-${Date.now()}.${ext}`;
      fs.writeFileSync(filename, result.buffer);
      console.log(`✅ Saved decoded image to ${filename}`);
    }
    return;
  }

  // Interactive mode
  console.log("Tuya Camera Image Decode Test");
  console.log("==============================");
  console.log("");
  console.log("Usage:");
  console.log("  node test-decode.js --raw <base64_value> --key <local_key> [--accesskey <access_key>]");
  console.log("");
  console.log("Get the raw value from plugin logs:");
  console.log('  grep "Motion DP received" <backend logs>');
  console.log("");
  console.log("Or paste values interactively:");
}

main().catch(console.error);
