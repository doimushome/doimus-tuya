/**
 * PrefixLogger — a simple callable logger that prefixes messages before
 * forwarding to the underlying logger (api.log function or an object with
 * named methods like console).
 *
 * Supports printf-style %s, %d, %o, %f placeholders with additional arguments.
 * Usable both as a function (logger(level, msg, ...args)) and with named
 * methods (logger.info(msg), logger.warn(msg), etc.).
 */
function PrefixLogger(logger, prefix, debug = false) {
  const call = (level, msg, ...args) => {
    let formatted = `[${prefix}] ${msg}`;
    if (args.length > 0) {
      let argIdx = 0;
      formatted = formatted.replace(/%[sdfo%]/g, (match) => {
        if (match === "%%") return "%";
        const val = args[argIdx++];
        return val !== undefined ? String(val) : "";
      });
    }
    if (typeof logger === "function") {
      logger(level, formatted);
    } else if (level === "debug") {
      logger.debug(formatted);
    } else if (level === "warn") {
      logger.warn(formatted);
    } else if (level === "error") {
      logger.error(formatted);
    } else {
      logger.info(formatted);
    }
  };

  call.info = (...args) => call("info", args[0], ...args.slice(1));
  call.warn = (...args) => call("warn", args[0], ...args.slice(1));
  call.error = (...args) => call("error", args[0], ...args.slice(1));
  call.debug = (...args) => {
    if (debug) call("debug", args[0], ...args.slice(1));
  };

  return call;
}

module.exports = { PrefixLogger };
