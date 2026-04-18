const { spawn } = require("child_process");
const { PassThrough } = require("node:stream");

function createFfmpegArgs(options, inputFromPipe) {
  const args = [
    "-re",
    "-hide_banner",
    "-loglevel",
    "error"
  ];

  if (inputFromPipe) {
    args.push("-i", "pipe:0");
  } else {
    args.push(
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "2",
      "-i",
      options.input
    );
  }

  args.push("-vn");

  if (options.fadeInMs > 0) {
    args.push("-af", `afade=t=in:st=0:d=${(options.fadeInMs / 1000).toFixed(3)}`);
  }

  args.push(
    "-map",
    "0:a",
    "-map_metadata",
    "-1",
    "-ar",
    String(options.rate),
    "-ac",
    String(options.channels),
    "-b:a",
    `${options.bitrate}k`,
    "-c:a",
    options.acodec,
    "-f",
    options.format,
    "pipe:1"
  );

  return args;
}

class RadioBroadcaster extends PassThrough {
  constructor(options = {}) {
    super();
    this.options = {
      format: options.format || "mp3",
      rate: options.rate || 44100,
      channels: options.channels || 2,
      bitrate: options.bitrate || 192,
      acodec: options.acodec || "mp3",
      fadeInMs: options.fadeInMs || 0,
      ffmpegPath: options.ffmpegPath || "ffmpeg"
    };
    this.current = null;
    this.playing = false;
    this.finish = false;
    this.header = null;
    this.sessionId = 0;
  }

  play(input) {
    this.stop();

    const inputFromPipe = !(typeof input === "string");
    const sessionId = ++this.sessionId;
    const child = spawn(
      this.options.ffmpegPath,
      createFfmpegArgs({
        ...this.options,
        input
      }, inputFromPipe),
      {
        stdio: [inputFromPipe ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    const session = {
      id: sessionId,
      child,
      input: inputFromPipe ? input : null,
      stderr: "",
      stopped: false,
      headerCaptured: false
    };

    this.current = session;
    this.playing = true;
    this.finish = false;

    child.stdout.on("data", (chunk) => {
      if (this.current !== session || session.stopped) {
        return;
      }

      if (!this.header && !session.headerCaptured) {
        this.header = chunk;
      }
      session.headerCaptured = true;
      this.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      session.stderr += chunk.toString();
      if (session.stderr.length > 4000) {
        session.stderr = session.stderr.slice(-4000);
      }
    });

    child.on("error", (err) => {
      if (this.current !== session || session.stopped) {
        return;
      }

      this.playing = false;
      this.current = null;
      this.emit("error", err);
    });

    child.on("close", (code, signal) => {
      if (this.current === session) {
        this.current = null;
      }

      this.playing = false;
      this.finish = true;

      if (session.stopped) {
        return;
      }

      if (code === 0) {
        this.emit("finish");
        return;
      }

      const message = session.stderr.trim();
      const suffix = message ? ` ${message}` : "";
      this.emit("error", new Error(`ffmpeg exited with code ${code}${signal ? ` (signal: ${signal})` : ""}.${suffix}`));
    });

    if (session.input && typeof session.input.pipe === "function") {
      child.stdin.on("error", (err) => {
        if (session.stopped) {
          return;
        }

        if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
          return;
        }

        this.emit("error", err);
      });

      session.input.on("error", (err) => {
        if (session.stopped) {
          return;
        }

        this.emit("error", err);
      });

      session.input.pipe(child.stdin);
    }

    return child;
  }

  stop() {
    if (!this.current) {
      return;
    }

    const session = this.current;
    this.current = null;
    session.stopped = true;
    this.playing = false;

    if (session.input && typeof session.input.unpipe === "function" && session.child.stdin) {
      session.input.unpipe(session.child.stdin);
    }

    if (session.child.stdin && !session.child.stdin.destroyed) {
      session.child.stdin.destroy();
    }

    if (session.input && typeof session.input.destroy === "function" && !session.input.destroyed) {
      session.input.destroy();
    }

    if (!session.child.killed) {
      session.child.kill();
    }
  }

  shutdown() {
    this.stop();
    this.end();
    this.destroy();
  }
}

function createRadioBroadcaster(options = {}) {
  return new RadioBroadcaster(options);
}

function createRepeater(radio) {
  const clients = new Set();

  radio.on("data", (chunk) => {
    clients.forEach((client) => {
      client.write(chunk, (err) => {
        if (err) {
          clients.delete(client);
        }
      });
    });
  });

  return (client) => {
    clients.add(client);
    return () => {
      clients.delete(client);
    };
  };
}

module.exports = {
  createRadioBroadcaster,
  createRepeater
};
