const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
app.disable("x-powered-by");

const PORT = process.env.BACKEND_PORT || 3000;
const RADIO_API = process.env.RADIO_API || "http://localhost:8080";
const PRESETS_FILE = path.join(__dirname, "..", "radio-presets.json");

const DB_PATH = path.join(__dirname, "db");
const HISTORY_FILE = path.join(DB_PATH, "history.json");
const FAVORITES_FILE = path.join(DB_PATH, "favorites.json");
const SETTINGS_FILE = path.join(DB_PATH, "settings.local.json");
const LEGACY_SETTINGS_FILE = path.join(DB_PATH, "settings.json");
const RADIO_CWD = path.join(__dirname, "..");
const BACKEND_CORS_ORIGIN = process.env.BACKEND_CORS_ORIGIN || "";

let radioProcess = null;

function cloneJsonValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function ensureDbDir() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(DB_PATH, { recursive: true });
  }
}

ensureDbDir();

function generateApiKey() {
  return crypto.randomBytes(24).toString("hex");
}

function createJsonFileStore(filePath, defaultValue) {
  let cache = {
    loaded: false,
    exists: false,
    mtimeMs: null,
    value: cloneJsonValue(defaultValue)
  };

  function setCache(value, exists, mtimeMs = null) {
    cache = {
      loaded: true,
      exists,
      mtimeMs,
      value: cloneJsonValue(value)
    };
  }

  return {
    read(forceRefresh = false) {
      try {
        const stat = fs.statSync(filePath);
        if (!forceRefresh && cache.loaded && cache.exists && cache.mtimeMs === stat.mtimeMs) {
          return cloneJsonValue(cache.value);
        }

        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = raw.trim() ? JSON.parse(raw) : cloneJsonValue(defaultValue);
        setCache(parsed, true, stat.mtimeMs);
        return cloneJsonValue(parsed);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          console.error(`Error reading ${filePath}:`, err.message);
        }

        setCache(defaultValue, false, null);
        return cloneJsonValue(defaultValue);
      }
    },
    write(value) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
        let mtimeMs = null;
        try {
          mtimeMs = fs.statSync(filePath).mtimeMs;
        } catch {
        }

        setCache(value, true, mtimeMs);
        return true;
      } catch (err) {
        console.error(`Error writing ${filePath}:`, err.message);
        return false;
      }
    },
    invalidate() {
      cache.loaded = false;
      cache.exists = false;
      cache.mtimeMs = null;
      cache.value = cloneJsonValue(defaultValue);
    }
  };
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = { ...value };
  if (typeof normalized.apiKey === "string") {
    normalized.apiKey = normalized.apiKey.trim();
  }

  if (!normalized.apiKey) {
    delete normalized.apiKey;
  }

  return normalized;
}

function readSettingsFromDisk() {
  const localSettings = normalizeSettings(readJsonFile(SETTINGS_FILE, {}));
  if (localSettings.apiKey) {
    return localSettings;
  }

  return normalizeSettings(readJsonFile(LEGACY_SETTINGS_FILE, {}));
}

// In-memory cache for presets and settings
let presetsCache = { data: null, timestamp: 0 };
let settingsCache = { data: null, timestamp: 0 };
const PRESETS_CACHE_TTL = 30000;
const SETTINGS_CACHE_TTL = 10000;
const historyStore = createJsonFileStore(HISTORY_FILE, []);
const favoritesStore = createJsonFileStore(FAVORITES_FILE, []);

function sanitizeSeedUrls(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function getPresetSeedUrlsForClient(preset, presets) {
  const urls = [];
  const appendUrls = (values) => {
    sanitizeSeedUrls(values).forEach((value) => urls.push(value));
  };

  appendUrls(preset?.seedUrls);
  if (typeof preset?.seedUrl === "string" && preset.seedUrl.trim()) {
    urls.push(preset.seedUrl.trim());
  }

  if (urls.length < 2 && preset?.group) {
    const siblings = presets.filter((item) => item?.name !== preset.name && item?.group === preset.group);
    for (const sibling of siblings) {
      appendUrls(sibling?.seedUrls);
      if (typeof sibling?.seedUrl === "string" && sibling.seedUrl.trim()) {
        urls.push(sibling.seedUrl.trim());
      }

      if (Array.from(new Set(urls)).length >= 3) {
        break;
      }
    }
  }

  return Array.from(new Set(urls)).slice(0, 3);
}

function summarizePresetRules(rules) {
  if (!rules || typeof rules !== "object") {
    return [];
  }

  const summary = [];

  if (Number.isFinite(Number(rules.refreshFromSeedEvery))) {
    summary.push(`re-anchor ${Math.max(1, Number(rules.refreshFromSeedEvery))} tracks`);
  }

  if (Number.isFinite(Number(rules.minDurationSec)) || Number.isFinite(Number(rules.maxDurationSec))) {
    const min = Number.isFinite(Number(rules.minDurationSec)) ? `${Math.max(0, Number(rules.minDurationSec))}s` : "any";
    const max = Number.isFinite(Number(rules.maxDurationSec)) ? `${Math.max(0, Number(rules.maxDurationSec))}s` : "any";
    summary.push(`duration ${min}-${max}`);
  }

  if (Array.isArray(rules.allowArtists) && rules.allowArtists.length > 0) {
    summary.push(`${rules.allowArtists.length} allowed artists`);
  }

  if (Array.isArray(rules.blockArtists) && rules.blockArtists.length > 0) {
    summary.push(`${rules.blockArtists.length} blocked artists`);
  }

  if (Array.isArray(rules.allowKeywords) && rules.allowKeywords.length > 0) {
    summary.push(`${rules.allowKeywords.length} allow keywords`);
  }

  if (Array.isArray(rules.blockKeywords) && rules.blockKeywords.length > 0) {
    summary.push(`${rules.blockKeywords.length} block keywords`);
  }

  if (Number.isFinite(Number(rules.dedupeWindowSize))) {
    summary.push(`dedupe ${Math.max(1, Number(rules.dedupeWindowSize))}`);
  }

  return summary;
}

function normalizePresetForClient(preset, presets) {
  const seedUrls = getPresetSeedUrlsForClient(preset, presets);
  const stationMode = preset?.stationMode || "dynamic";
  const rules = preset?.rules && typeof preset.rules === "object" ? preset.rules : null;

  return {
    ...preset,
    label: preset?.label || preset?.name || "Unnamed preset",
    group: preset?.group || "Custom",
    description: preset?.description || "",
    seedUrl: preset?.seedUrl || seedUrls[0] || null,
    seedUrls,
    seed_url_count: seedUrls.length,
    stationMode,
    rules,
    rules_summary: summarizePresetRules(rules)
  };
}

function getPresetsForClient(forceRefresh = false) {
  const presets = getPresets(forceRefresh);
  return presets.map((preset) => normalizePresetForClient(preset, presets));
}

function ensureSettings(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && settingsCache.data && (now - settingsCache.timestamp) < SETTINGS_CACHE_TTL) {
    return settingsCache.data;
  }

  const settings = readSettingsFromDisk();
  if (settings.apiKey) {
    settingsCache = { data: settings, timestamp: now };
    return settings;
  }

  const initialized = {
    ...settings,
    apiKey: (process.env.YTRADIO_API_KEY || "").trim() || generateApiKey()
  };

  if (!writeJsonFile(SETTINGS_FILE, initialized)) {
    throw new Error(`Failed to persist backend settings at ${SETTINGS_FILE}`);
  }

  settingsCache = { data: initialized, timestamp: now };
  console.log(`[Backend] Admin API key initialized. X-API-Key: ${initialized.apiKey}`);
  return initialized;
}

function getPresets(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && presetsCache.data && (now - presetsCache.timestamp) < PRESETS_CACHE_TTL) {
    return presetsCache.data;
  }
  presetsCache = { data: readJsonFile(PRESETS_FILE, []), timestamp: now };
  return presetsCache.data;
}

function getSettings(forceRefresh = false) {
  return ensureSettings(forceRefresh);
}

function invalidatePresetsCache() {
  presetsCache = { data: null, timestamp: 0 };
}

function invalidateSettingsCache() {
  settingsCache = { data: null, timestamp: 0 };
}

function getHistory(forceRefresh = false) {
  return historyStore.read(forceRefresh);
}

function setHistory(history) {
  return historyStore.write(history);
}

function getFavorites(forceRefresh = false) {
  return favoritesStore.read(forceRefresh);
}

function setFavorites(favorites) {
  return favoritesStore.write(favorites);
}

function attachRadioProcess(child) {
  radioProcess = child;

  child.stdout.on("data", (data) => {
    const message = data.toString().trim();
    if (message) {
      console.log("[Radio]", message);
    }
  });

  child.stderr.on("data", (data) => {
    const message = data.toString().trim();
    if (message) {
      console.error("[Radio Error]", message);
    }
  });

  child.on("close", (code, signal) => {
    console.log(`[Radio] Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`);
    if (radioProcess === child) {
      radioProcess = null;
    }
  });
}

function isRadioProcessRunning() {
  return Boolean(radioProcess && !radioProcess.killed && radioProcess.exitCode === null);
}

async function isRadioApiAvailable() {
  try {
    const response = await callRadioApi("/health", {
      timeoutMs: 2500
    });
    return response.ok;
  } catch (_err) {
    return false;
  }
}

function startRadioProcess() {
  if (isRadioProcessRunning()) {
    return { ok: true, alreadyRunning: true, child: radioProcess };
  }

  try {
    const child = spawn(process.execPath, ["index.js"], {
      cwd: RADIO_CWD,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      env: process.env
    });

    attachRadioProcess(child);
    return { ok: true, alreadyRunning: false, child };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function ensureRadioStarted() {
  if (await isRadioApiAvailable()) {
    console.log("[Backend] Radio API already available, skipping auto-start.");
    return;
  }

  console.log("[Backend] Starting radio server...");
  const result = startRadioProcess();
  if (!result.ok) {
    console.error("[Backend] Failed to start radio server:", result.error.message);
  }
}

function stopManagedRadioProcess() {
  if (!isRadioProcessRunning()) {
    return;
  }

  try {
    radioProcess.kill();
  } catch (_err) {
  }
}

function readJsonFile(filePath, defaultValue = []) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf8");
      return data.trim() ? JSON.parse(data) : defaultValue;
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
  }
  return defaultValue;
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err.message);
    return false;
  }
}

function createTimeoutSignal(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortSignal?.timeout !== "function") {
    return undefined;
  }

  return AbortSignal.timeout(timeoutMs);
}

async function callRadioApi(pathname, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };
  let body = options.body;

  if (body !== undefined && typeof body !== "string") {
    body = JSON.stringify(body);
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const response = await fetch(new URL(pathname, RADIO_API), {
    method,
    headers,
    body,
    signal: createTimeoutSignal(options.timeoutMs || 5000)
  });

  const raw = await response.text();
  let payload = null;

  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
    raw,
    response
  };
}

if (BACKEND_CORS_ORIGIN) {
  app.use(cors({ origin: BACKEND_CORS_ORIGIN }));
}
app.use(express.json({ limit: "64kb" }));

// Root route and static files FIRST
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// Direct route for reload-presets (bypass proxy issues)
app.post("/api/reload-presets", authMiddleware, async (req, res) => {
  try {
    const result = await callRadioApi("/reload-presets", {
      method: "POST"
    });
    res.status(result.status).json(result.payload || { ok: result.ok });
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

app.post("/api/radio/preset", authMiddleware, async (req, res) => {
  const { preset, profile } = req.body || {};
  if (!preset) {
    return res.status(400).json({ error: "Preset required" });
  }

  try {
    const result = await callRadioApi("/preset", {
      method: "POST",
      body: { preset, profile: profile || "safe" }
    });
    res.status(result.status).json(result.payload || { ok: result.ok });
  } catch (err) {
    res.status(502).json({ error: "Failed to communicate with radio API", details: err.message });
  }
});

const SAFE_RADIO_PROXY_PATHS = new Set([
  "/health",
  "/stats",
  "/now-playing",
  "/now-playing.txt",
  "/preset"
]);

function radioProxyGuard(req, res, next) {
  const pathname = req.path || "/";
  const localControlPaths = new Set([
    "/start",
    "/stop",
    "/restart"
  ]);

  if (localControlPaths.has(pathname)) {
    return next();
  }

  if (!SAFE_RADIO_PROXY_PATHS.has(pathname)) {
    return res.status(404).json({ error: "Unknown radio API path" });
  }

  if ((pathname === "/preset" && req.method !== "GET" && req.method !== "HEAD") ||
      (pathname !== "/preset" && req.method !== "GET" && req.method !== "HEAD")) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  next();
}

// Proxy to radio API (after static files)
app.use("/api/radio", radioProxyGuard, createProxyMiddleware({
  target: RADIO_API,
  changeOrigin: true,
  pathRewrite: { "^/api/radio": "" }
}));

// Auth middleware
function authMiddleware(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const settings = getSettings();
  
  if (typeof apiKey === "string" && apiKey === settings.apiKey) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}

// Presets management endpoints
app.get("/api/presets", (req, res) => {
  res.json(getPresetsForClient());
});

app.post("/api/presets", authMiddleware, (req, res) => {
  const {
    name,
    label,
    group,
    description,
    seedUrl,
    seedUrls,
    stationMode,
    rules,
    profiles
  } = req.body;
  
  if (!name || !seedUrl) {
    return res.status(400).json({ error: "Name and seedUrl are required" });
  }
  
  const presets = getPresets(true); // Force refresh from disk
  
  const existingIndex = presets.findIndex(p => p.name === name);
  const newPreset = {
    name,
    label: label || name,
    group: group || "Custom",
    description: description || "",
    seedUrl,
    ...(sanitizeSeedUrls(seedUrls).length > 0 ? { seedUrls: sanitizeSeedUrls(seedUrls) } : {}),
    ...(typeof stationMode === "string" && stationMode.trim() ? { stationMode: stationMode.trim() } : {}),
    ...(rules && typeof rules === "object" && !Array.isArray(rules) ? { rules } : {}),
    profiles: profiles || {
      safe: { settings: { radioBitrate: 192, playbackBackend: "native", playbackClient: "ANDROID", playbackType: "video+audio", playbackFormat: "mp4", playbackQuality: "360p" } },
      hq: { settings: { radioBitrate: 320, playbackBackend: "auto", playbackClient: "ANDROID", playbackType: "video+audio", playbackFormat: "mp4", playbackQuality: "best" } }
    }
  };
  
  if (existingIndex >= 0) {
    presets[existingIndex] = newPreset;
  } else {
    presets.push(newPreset);
  }
  
  if (writeJsonFile(PRESETS_FILE, presets)) {
    invalidatePresetsCache();
    res.json({ ok: true, preset: normalizePresetForClient(newPreset, presets) });
  } else {
    res.status(500).json({ error: "Failed to save preset" });
  }
});

app.delete("/api/presets/:name", authMiddleware, (req, res) => {
  const { name } = req.params;
  const presets = getPresets(true);
  const initialLength = presets.length;
  const filtered = presets.filter(p => p.name !== name);
  
  if (filtered.length === initialLength) {
    return res.status(404).json({ error: "Preset not found" });
  }
  
  if (writeJsonFile(PRESETS_FILE, filtered)) {
    invalidatePresetsCache();
    res.json({ ok: true });
  } else {
    res.status(500).json({ error: "Failed to save presets" });
  }
});

// Quick preset switch endpoint
app.post("/api/presets/:name/activate", authMiddleware, async (req, res) => {
  const { name } = req.params;
  const { profile } = req.body;
  const presets = getPresets();
  const preset = presets.find(p => p.name === name);
  
  if (!preset) {
    return res.status(404).json({ error: "Preset not found" });
  }
  
  try {
    const result = await callRadioApi("/preset", {
      method: "POST",
      body: { preset: name, profile: profile || "safe" }
    });

    return res.status(result.status).json(result.payload || { ok: result.ok });
  } catch (err) {
    res.status(502).json({ error: "Failed to communicate with radio API", details: err.message });
  }
});

// Settings endpoints
app.get("/api/settings", authMiddleware, (req, res) => {
  const settings = getSettings();
  res.json({ apiKey: settings.apiKey ? "***" : null });
});

app.post("/api/settings", authMiddleware, (req, res) => {
  const { apiKey } = req.body;
  const nextApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!nextApiKey) {
    return res.status(400).json({ error: "apiKey is required" });
  }

  const settings = {
    ...getSettings(true),
    apiKey: nextApiKey,
    _hasCustomKey: true
  };

  if (writeJsonFile(SETTINGS_FILE, settings)) {
    invalidateSettingsCache();
    res.json({ ok: true });
  } else {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

app.post("/api/settings/reset", authMiddleware, (req, res) => {
  const settings = {
    ...getSettings(true),
    apiKey: generateApiKey(),
    _hasCustomKey: false
  };

  if (writeJsonFile(SETTINGS_FILE, settings)) {
    invalidateSettingsCache();
    res.json({ ok: true, apiKey: settings.apiKey });
  } else {
    res.status(500).json({ error: "Failed to reset settings" });
  }
});

// Check if first run
app.get("/api/settings/status", (req, res) => {
  const settings = getSettings();
  res.json({ isFirstRun: false, configured: Boolean(settings.apiKey) });
});

// History endpoints
app.get("/api/history", (req, res) => {
  const limit = Math.max(1, Math.min(parseInteger(req.query.limit, 50), 500));
  const history = getHistory();
  res.json(history.slice(-limit));
});

app.post("/api/history", authMiddleware, (req, res) => {
  const { track } = req.body;
  if (!track) {
    return res.status(400).json({ error: "Track required" });
  }
  
  const history = getHistory(true);
  history.push({ ...track, playedAt: new Date().toISOString() });
  
  // Keep only last 500 entries
  const trimmed = history.slice(-500);
  setHistory(trimmed);
  res.json({ ok: true });
});

app.delete("/api/history", authMiddleware, (req, res) => {
  setHistory([]);
  res.json({ ok: true });
});

// Favorites endpoints
app.get("/api/favorites", (req, res) => {
  const favorites = getFavorites();
  res.json(favorites);
});

app.post("/api/favorites", authMiddleware, (req, res) => {
  const { track } = req.body;
  if (!track || !track.id) {
    return res.status(400).json({ error: "Track with ID required" });
  }
  
  const favorites = getFavorites(true);
  
  if (!favorites.find(f => f.id === track.id)) {
    favorites.push({ ...track, addedAt: new Date().toISOString() });
    setFavorites(favorites);
  }
  
  res.json({ ok: true });
});

app.delete("/api/favorites/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  let favorites = getFavorites(true);
  favorites = favorites.filter(f => f.id !== id);
  setFavorites(favorites);
  res.json({ ok: true });
});

// Stats aggregation
app.get("/api/stats/extended", async (req, res) => {
  try {
    const radioResult = await callRadioApi("/stats");
    const radioStats = radioResult.payload || {};
    const history = getHistory();
    const favorites = getFavorites();
    
    // Calculate additional stats
    const artistCounts = {};
    history.forEach(track => {
      if (track.author) {
        artistCounts[track.author] = (artistCounts[track.author] || 0) + 1;
      }
    });
    
    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([artist, count]) => ({ artist, plays: count }));
    
    res.json({
      radio: radioStats,
      history: {
        totalPlayed: history.length,
        uniqueTracks: new Set(history.map(h => h.id)).size,
        topArtists
      },
      favorites: {
        count: favorites.length
      }
    });
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const radioResult = await callRadioApi("/health", {
      timeoutMs: 3000
    });
    const radioHealth = radioResult.payload || { ok: radioResult.ok };
    res.json({ backend: "ok", radio: radioHealth, radioRunning: isRadioProcessRunning() || radioHealth.ok === true });
  } catch (err) {
    res.status(502).json({ backend: "ok", radio: { ok: false, error: err.message }, radioRunning: isRadioProcessRunning() });
  }
});

// Radio control endpoints
app.post("/api/radio/start", authMiddleware, async (req, res) => {
  if (await isRadioApiAvailable()) {
    return res.json({ ok: true, message: "Radio already running" });
  }

  const result = startRadioProcess();
  if (!result.ok) {
    return res.status(500).json({ error: "Failed to start radio", details: result.error.message });
  }

  res.json({ ok: true, message: result.alreadyRunning ? "Radio already running" : "Radio starting..." });
});

app.post("/api/radio/stop", authMiddleware, async (req, res) => {
  try {
    const result = await callRadioApi("/shutdown", {
      method: "POST",
      timeoutMs: 3000
    });
    if (!result.ok) {
      throw new Error(result.raw || `Radio API returned ${result.status}`);
    }
    res.json({ ok: true, message: "Radio stopping..." });
  } catch (err) {
    if (isRadioProcessRunning()) {
      stopManagedRadioProcess();
      return res.json({ ok: true, message: "Managed radio process stopped by fallback." });
    }

    res.status(502).json({ error: "Failed to stop radio", details: err.message });
  }
});

app.post("/api/radio/restart", authMiddleware, async (req, res) => {
  try {
    const result = await callRadioApi("/shutdown", {
      method: "POST",
      timeoutMs: 3000
    });
    if (!result.ok) {
      throw new Error(result.raw || `Radio API returned ${result.status}`);
    }
    setTimeout(() => {
      const result = startRadioProcess();
      if (!result.ok) {
        console.error("[Backend] Failed to restart radio:", result.error.message);
      }
    }, 2000);
    res.json({ ok: true, message: "Radio restarting..." });
  } catch (err) {
    const result = startRadioProcess();
    if (!result.ok) {
      return res.status(502).json({ error: "Failed to restart radio", details: err.message });
    }

    res.json({ ok: true, message: "Radio was unreachable, started a new process instead." });
  }
});

app.listen(PORT, () => {
  getSettings();
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Radio API proxy: ${RADIO_API}`);
  if (BACKEND_CORS_ORIGIN) {
    console.log(`Backend CORS origin: ${BACKEND_CORS_ORIGIN}`);
  } else {
    console.log("Backend CORS origin: disabled");
  }
  void ensureRadioStarted();
});

process.on("SIGINT", () => {
  stopManagedRadioProcess();
});

process.on("SIGTERM", () => {
  stopManagedRadioProcess();
});
