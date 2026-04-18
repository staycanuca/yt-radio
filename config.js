function readPositiveInt(env, key, fallback) {
  const value = Number(env[key]);
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  return fallback;
}

function readNonNegativeInt(env, key, fallback) {
  const value = Number(env[key]);
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  return fallback;
}

function readString(env, key, fallback) {
  const value = env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return fallback;
}

function loadConfig(env = process.env) {
  const radioFormat = readString(env, "RADIO_FORMAT", "mp3");

  return {
    geolocation: readString(env, "GEOLOCATION", "US"),
    httpPort: readPositiveInt(env, "PORT", 8080),
    gopherPort: readPositiveInt(env, "GOPHER_PORT", 8081),
    seedUrlFile: readString(env, "YT_URL_FILE", "yturl.txt"),
    logLevel: readString(env, "LOG_LEVEL", "info").toLowerCase(),
    corsOrigin: readString(env, "CORS_ORIGIN", "*"),
    playbackBackend: readString(env, "PLAYBACK_BACKEND", "auto").toLowerCase(),
    playbackClient: readString(env, "PLAYBACK_CLIENT", "ANDROID"),
    playbackFormatOptions: {
      type: readString(env, "PLAYBACK_TYPE", "video+audio"),
      format: readString(env, "PLAYBACK_FORMAT", "mp4"),
      quality: readString(env, "PLAYBACK_QUALITY", "best")
    },
    ytDlpPath: readString(env, "YT_DLP_PATH", "yt-dlp"),
    ytDlpFormat: readString(env, "YT_DLP_FORMAT", "bestaudio/best"),
    radio: {
      format: radioFormat,
      bitrate: readPositiveInt(env, "RADIO_BITRATE", 256),
      codec: readString(env, "RADIO_CODEC", radioFormat === "mp3" ? "mp3" : radioFormat)
    },
    icyMetaInt: readPositiveInt(env, "ICY_METAINT", 16384),
    trackCacheSize: readPositiveInt(env, "TRACK_CACHE_SIZE", 8),
    prefetchCount: readPositiveInt(env, "TRACK_PREFETCH_COUNT", 2),
    retry: {
      baseDelayMs: readPositiveInt(env, "RETRY_BASE_MS", 1000),
      maxDelayMs: readPositiveInt(env, "RETRY_MAX_MS", 5000),
      rateLimitDelayMs: readPositiveInt(env, "RETRY_RATE_LIMIT_MS", 10000),
      mediaForbiddenDelayMs: readPositiveInt(env, "RETRY_FORBIDDEN_MS", 750),
      serverErrorDelayMs: readPositiveInt(env, "RETRY_SERVER_ERROR_MS", 3000)
    },
    transition: {
      fadeInMs: readNonNegativeInt(env, "TRACK_FADE_IN_MS", 350)
    },
    interruptionReplay: {
      maxAttempts: readNonNegativeInt(env, "TRACK_REPLAY_MAX_ATTEMPTS", 1),
      maxElapsedMs: readPositiveInt(env, "TRACK_REPLAY_MAX_ELAPSED_MS", 90000),
      retryDelayMs: readNonNegativeInt(env, "TRACK_REPLAY_DELAY_MS", 150)
    }
  };
}

module.exports = {
  loadConfig
};
