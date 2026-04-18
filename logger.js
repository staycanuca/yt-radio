const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const IGNORED_CONSOLE_ERROR_CODES = new Set([
  "EPIPE",
  "EOF",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END"
]);

const INSTALLED_HANDLER = Symbol("ytradioConsoleHandlerInstalled");

function isIgnorableConsoleError(err) {
  if (!err) {
    return false;
  }

  if (IGNORED_CONSOLE_ERROR_CODES.has(err.code)) {
    return true;
  }

  return err.syscall === "write" && typeof err.message === "string" && (
    err.message.includes("write EOF") ||
    err.message.includes("write after end")
  );
}

function installConsoleErrorHandlers() {
  [process.stdout, process.stderr].forEach((stream) => {
    if (!stream || typeof stream.on !== "function" || stream[INSTALLED_HANDLER]) {
      return;
    }

    stream[INSTALLED_HANDLER] = true;
    stream.on("error", (err) => {
      if (isIgnorableConsoleError(err)) {
        return;
      }
    });
  });
}

function createLogger(options = {}) {
  const level = Object.hasOwn(LEVELS, options.level) ? options.level : "info";
  const threshold = LEVELS[level];

  function write(method, logLevel, args) {
    if (LEVELS[logLevel] > threshold) {
      return;
    }

    const prefix = `[${new Date().toISOString()}] ${logLevel.toUpperCase()}`;

    try {
      console[method](prefix, ...args);
    } catch (err) {
      if (!isIgnorableConsoleError(err)) {
        throw err;
      }
    }
  }

  return {
    error(...args) {
      write("error", "error", args);
    },
    warn(...args) {
      write("warn", "warn", args);
    },
    info(...args) {
      write("log", "info", args);
    },
    debug(...args) {
      write("log", "debug", args);
    }
  };
}

module.exports = {
  createLogger,
  installConsoleErrorHandlers,
  isIgnorableConsoleError
};
