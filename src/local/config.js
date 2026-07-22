/**
 * @typedef {Object} LocalDeviceConfig
 * @property {string} id - Tuya device ID
 * @property {string} key - Tuya device local key (hex string)
 * @property {string} ip - Device IP address on LAN
 * @property {string} [version] - Protocol version (3.1, 3.3, 3.4, 3.5)
 * @property {string} [name] - Human-readable device name
 * @property {number} [port] - TCP port (default 6668)
 * @property {number} [pingGap] - Seconds between pings (default 9)
 * @property {number} [connectTimeout] - Connect timeout in seconds (default 30)
 */

/**
 * @typedef {Object} LocalConfig
 * @property {LocalDeviceConfig[]} [devices] - Manually configured devices
 * @property {number} [discoverTimeout] - UDP discovery duration in seconds (default 30)
 * @property {boolean} [enabled] - Enable local operation
 */

const DEFAULT_PING_GAP = 9;
const DEFAULT_CONNECT_TIMEOUT = 30;
const DEFAULT_DISCOVER_TIMEOUT = 30;
const DEFAULT_TCP_PORT = 6668;
const MAX_RECONNECT_DELAY = 30000;
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_ATTEMPTS = 10;
const PONG_TIMEOUT_MS = 5000;

module.exports = {
  DEFAULT_PING_GAP,
  DEFAULT_CONNECT_TIMEOUT,
  DEFAULT_DISCOVER_TIMEOUT,
  DEFAULT_TCP_PORT,
  MAX_RECONNECT_DELAY,
  RECONNECT_BASE_DELAY,
  MAX_RECONNECT_ATTEMPTS,
  PONG_TIMEOUT_MS,
};
