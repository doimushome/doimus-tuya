/**
 * PrefixLogger creates a logger that is BOTH callable as a function
 * (logger(level, msg)) AND usable as an object with named methods
 * (logger.info(msg), logger.warn(msg), etc.).
 *
 * This dual nature is required because TuyaDeviceManager passes
 * api.log (a PrefixLogger) as the raw `log` argument to another
 * PrefixLogger constructor, and PrefixLogger.info/warn/error call
 * `this.logger(level, msg)` treating the inner logger as a callable.
 */
function PrefixLogger(logger, prefix, debug = false) {
  // The callable form: logger(level, msg, ...args) — used by inner PrefixLogger instances.
  // Supports printf-style %s, %d, %o, %f placeholders with additional arguments.
  const call = (level, msg, ...args) => {
    let formatted = `[${prefix}] ${msg}`;
    if (args.length > 0) {
      let argIdx = 0;
      formatted = formatted.replace(/%[sdfo]/g, () => {
        const val = args[argIdx++];
        return val !== undefined ? String(val) : "";
      });
    }
    if (typeof logger === "function") {
      logger(level, formatted);
    } else if (logger && typeof logger.info === "function") {
      // Inner logger is itself a PrefixLogger (function-object); call via named methods.
      if (level === "debug") {
        logger.debug(formatted);
      } else if (level === "warn") {
        logger.warn(formatted);
      } else if (level === "error") {
        logger.error(formatted);
      } else {
        logger.info(formatted);
      }
    }
  };

  call.info = (...args) => call("info", args[0], ...args.slice(1));
  call.warn = (...args) => call("warn", args[0], ...args.slice(1));
  call.error = (...args) => call("error", args[0], ...args.slice(1));
  call.debug = (...args) => {
    if (debug) call("debug", args[0], ...args.slice(1));
  };
  // Expose internals so nested PrefixLoggers can introspect if needed.
  call.logger = logger;
  call.prefix = prefix;
  call.debug_enabled = debug;

  return call;
}

module.exports = { PrefixLogger };
