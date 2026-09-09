// CRC-32 (IEEE 802.3) — delegates to Node's built-in zlib.crc32 (Node ≥22).
const zlib = require("zlib");

function crc32(data) {
  if (typeof data === "string") data = Buffer.from(data, "utf8");
  return zlib.crc32(data);
}

module.exports = { crc32 };
