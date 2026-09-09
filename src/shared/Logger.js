/**
 * PrefixLogger — prefixes messages before forwarding to the underlying logger.
 * Usable both as a function (logger(level, msg)) and with named methods
 * (logger.info(msg), logger.warn(msg), etc.).
 */
function PrefixLogger(logger, prefix, debug = false) {
  const format = (msg) => `[${prefix}] ${msg}`;
  const call = (level, msg) => {
    if (typeof logger === "function") {
      logger(level, format(msg));
    } else if (level === "debug") {
      logger.debug(format(msg));
    } else if (level === "warn") {
      logger.warn(format(msg));
    } else if (level === "error") {
      logger.error(format(msg));
    } else {
      logger.info(format(msg));
    }
  };

  call.info = (msg) => call("info", msg);
  call.warn = (msg) => call("warn", msg);
  call.error = (msg) => call("error", msg);
  call.debug = (msg) => {
    if (debug) call("debug", msg);
  };

  return call;
}

module.exports = { PrefixLogger };
