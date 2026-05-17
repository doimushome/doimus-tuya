class PrefixLogger {
  constructor(logger, prefix, debug = false) {
    this.logger = logger;
    this.prefix = prefix;
    this.debug = debug;
  }

  info(...args) {
    this.logger("info", `[${this.prefix}] ${args[0]}`, ...args.slice(1));
  }

  warn(...args) {
    this.logger("warn", `[${this.prefix}] ${args[0]}`, ...args.slice(1));
  }

  error(...args) {
    this.logger("error", `[${this.prefix}] ${args[0]}`, ...args.slice(1));
  }

  debug(...args) {
    if (this.debug) {
      this.logger("debug", `[${this.prefix}] ${args[0]}`, ...args.slice(1));
    }
  }
}

module.exports = { PrefixLogger };
