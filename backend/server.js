// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = process.env.BACKEND_PORT || 3000;
const RADIO_API = process.env.RADIO_API || "http://localhost:8080";
const PRESETS_FILE = path.join(__dirname, "..", "radio-presets.json");

const DB_PATH = path.join(__dirname, "db");
const HISTORY_FILE = path.join(DB_PATH, "history.json");
const FAVORITES_FILE = path.join(DB_PATH, "favorites.json");
const SETTINGS_FILE = path.join(DB_PATH, "settings.json");
const CUSTOM_QUEUE_FILE = path.join(DB_PATH, "custom-queue.json");

// Radio process management
let radioProcess = null;
let radioStarting = false;
let radioLogs = [];
const MAX_LOG_LINES = 200;

function ensureDbDir() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(DB_PATH, { recursive: true });
  }
}

ensureDbDir();

// Logging
function addRadioLog(type, message) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, message: message.substring(0, 500) };
  radioLogs.push(entry);
  if (radioLogs.length > MAX_LOG_LINES) {
    radioLogs.shift();
  }
}

// Radio process control
function isRadioRunning() {
  return radioProcess && !radioProcess.killed && !radioStarting;
}

async function checkRadioHealth() {
  try {
    const res = await fetch(`${RADIO_API}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function startRadioProcess() {
  if (radioProcess && !radioProcess.killed) {
    console.log("[Backend] Radio already running (PID:", radioProcess.pid, ")");
    return { success: true, message: "Already running", pid: radioProcess.pid };
  }
  
  if (radioStarting) {
    return { success: false, message: "Radio is starting..." };
  }
  
  radioStarting = true;
  console.log("[Backend] Starting radio server...");
  addRadioLog("info", "Starting radio server...");
  
  try {
    const newProcess = spawn("node", ["index.js"], {
      cwd: path.join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      env: { ...process.env }
    });
    
    newProcess.stdout.on("data", (data) => {
      const msg = data.toString().trim();
      console.log("[Radio]", msg);
      addRadioLog("info", msg);
    });
    
    newProcess.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (!msg.includes("DeprecationWarning")) {
        console.error("[Radio Error]", msg);
        addRadioLog("error", msg);
      }
    });
    
    newProcess.on("close", (code) => {
      console.log(`[Radio] Process exited with code ${code}`);
      addRadioLog("warn", `Process exited with code ${code}`);
      radioProcess = null;
      radioStarting = false;
    });
    
    newProcess.on("error", (err) => {
      console.error("[Radio] Failed to start:", err);
      addRadioLog("error", `Failed to start: ${err.message}`);
      radioProcess = null;
      radioStarting = false;
    });
    
    radioProcess = newProcess;
    
    setTimeout(() => {
      radioStarting = false;
      if (radioProcess && !radioProcess.killed) {
        console.log("[Backend] Radio started successfully (PID:", radioProcess.pid, ")");
        addRadioLog("success", `Radio started (PID: ${radioProcess.pid})`);
      }
    }, 3000);
    
    return { success: true, message: "Starting...", pid: newProcess.pid };
  } catch (err) {
    radioStarting = false;
    console.error("[Backend] Failed to spawn radio:", err);
    addRadioLog("error", `Spawn failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

async function stopRadioProcess() {
  if (!radioProcess || radioProcess.killed) {
    console.log("[Backend] Radio not running");
    return { success: true, message: "Radio not running" };
  }
  
  console.log("[Backend] Stopping radio (PID:", radioProcess.pid, ")...");
  addRadioLog("info", "Stopping radio...");
  
  try {
    // Try graceful shutdown via API
    console.log("[Backend] Sending shutdown request to radio API...");
    await fetch(`${RADIO_API}/shutdown`, { 
      method: "POST",
      signal: AbortSignal.timeout(3000)
    }).catch(() => {});
    
    // Wait for process to exit gracefully
    console.log("[Backend] Waiting for radio to exit...");
    const exited = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 8000);
      if (radioProcess) {
        radioProcess.once("close", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      } else {
        clearTimeout(timeout);
        resolve(true);
      }
    });
    
    if (!exited && radioProcess && !radioProcess.killed) {
      console.log("[Backend] Radio didn't exit gracefully, sending SIGTERM...");
      radioProcess.kill("SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      if (radioProcess && !radioProcess.killed) {
        console.log("[Backend] Force killing radio...");
        radioProcess.kill("SIGKILL");
      }
    }
    
    radioProcess = null;
    console.log("[Backend] Radio stopped successfully");
    addRadioLog("info", "Radio stopped");
    
    // Wait a bit for port to be released
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return { success: true, message: "Stopped" };
  } catch (err) {
    console.error("[Backend] Error stopping radio:", err);
    if (radioProcess && !radioProcess.killed) {
      radioProcess.kill("SIGKILL");
    }
    radioProcess = null;
    return { success: true, message: "Force stopped" };
  }
}

async function restartRadioProcess() {
  console.log("[Backend] Restarting radio...");
  addRadioLog("info", "Restarting radio...");
  
  await stopRadioProcess();
  
  console.log("[Backend] Waiting for port to be released...");
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  return startRadioProcess();
}

// Cache
let presetsCache = { data: null, timestamp: 0 };
let settingsCache = { data: null, timestamp: 0 };
const PRESETS_CACHE_TTL = 30000;
const SETTINGS_CACHE_TTL = 10000;

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

function getPresets(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && presetsCache.data && (now - presetsCache.timestamp) < PRESETS_CACHE_TTL) {
    return presetsCache.data;
  }
  presetsCache = { data: readJsonFile(PRESETS_FILE, []), timestamp: now };
  return presetsCache.data;
}

function getSettings(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && settingsCache.data && (now - settingsCache.timestamp) < SETTINGS_CACHE_TTL) {
    return settingsCache.data;
  }
  settingsCache = { data: readJsonFile(SETTINGS_FILE, { apiKey: "ytradio-admin" }), timestamp: now };
  return settingsCache.data;
}

function invalidatePresetsCache() {
  presetsCache = { data: null, timestamp: 0 };
}

function invalidateSettingsCache() {
  settingsCache = { data: null, timestamp: 0 };
}

// Middleware
app.use(cors());
app.use(express.json());

// Auth middleware
function authMiddleware(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const settings = getSettings();
  
  if (!settings.apiKey || apiKey === settings.apiKey) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}

// Static files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// Radio control endpoints
app.get("/api/radio/status", async (req, res) => {
  const running = isRadioRunning();
  const healthy = running ? await checkRadioHealth() : false;
  res.json({
    running,
    healthy,
    pid: radioProcess?.pid || null,
    starting: radioStarting,
    logs: radioLogs.slice(-50)
  });
});

app.post("/api/radio/start", authMiddleware, (req, res) => {
  const result = startRadioProcess();
  res.json(result);
});

app.post("/api/radio/stop", authMiddleware, async (req, res) => {
  const result = await stopRadioProcess();
  res.json(result);
});

app.post("/api/radio/restart", authMiddleware, async (req, res) => {
  const result = await restartRadioProcess();
  res.json(result);
});

app.get("/api/radio/logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(radioLogs.slice(-limit));
});

// Reload presets endpoint
app.post("/api/reload-presets", async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/reload-presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await radioRes.json();
    invalidatePresetsCache();
    res.status(radioRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Seed URL management (BEFORE proxy)
app.get("/api/seed", (req, res) => {
  const seedFile = path.join(__dirname, "..", "yturl.txt");
  try {
    const seedUrl = fs.existsSync(seedFile) ? fs.readFileSync(seedFile, "utf8").trim() : "";
    res.json({ seedUrl });
  } catch (err) {
    res.status(500).json({ error: "Failed to read seed URL" });
  }
});

app.post("/api/seed", authMiddleware, (req, res) => {
  const { seedUrl } = req.body;
  const seedFile = path.join(__dirname, "..", "yturl.txt");
  
  if (!seedUrl || !seedUrl.trim()) {
    return res.status(400).json({ error: "Seed URL is required" });
  }
  
  // Validate YouTube URL
  const url = seedUrl.trim();
  if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }
  
  try {
    fs.writeFileSync(seedFile, url, "utf8");
    addRadioLog("info", `Seed URL updated: ${url}`);
    res.json({ ok: true, seedUrl: url });
  } catch (err) {
    res.status(500).json({ error: "Failed to save seed URL" });
  }
});

// Presets management
app.get("/api/presets", (req, res) => {
  res.json(getPresets());
});

app.post("/api/presets", authMiddleware, (req, res) => {
  const { name, label, group, description, seedUrl, seedUrls, profiles, stationMode, rules } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }
  
  // Validate that we have at least one seed URL
  const hasSeedUrl = seedUrl || (Array.isArray(seedUrls) && seedUrls.length > 0);
  if (!hasSeedUrl) {
    return res.status(400).json({ error: "At least one seed URL is required" });
  }
  
  const presets = getPresets(true);
  const existingIndex = presets.findIndex(p => p.name === name);
  
  // Build the preset object
  const newPreset = {
    name,
    label: label || name,
    group: group || "Custom",
    description: description || ""
  };
  
  // Handle seed URLs
  if (Array.isArray(seedUrls) && seedUrls.length > 0) {
    newPreset.seedUrls = seedUrls;
    newPreset.seedUrl = seedUrls[0]; // First one as primary
  } else if (seedUrl) {
    newPreset.seedUrl = seedUrl;
  }
  
  // Preserve or set profiles
  if (profiles) {
    newPreset.profiles = profiles;
  } else if (existingIndex >= 0 && presets[existingIndex].profiles) {
    newPreset.profiles = presets[existingIndex].profiles;
  } else {
    newPreset.profiles = {
      safe: { settings: { radioBitrate: 192, playbackBackend: "native", playbackClient: "ANDROID", playbackType: "video+audio", playbackFormat: "mp4", playbackQuality: "360p" } },
      hq: { settings: { radioBitrate: 320, playbackBackend: "auto", playbackClient: "ANDROID", playbackType: "video+audio", playbackFormat: "mp4", playbackQuality: "best" } }
    };
  }
  
  // Preserve or set stationMode
  if (stationMode) {
    newPreset.stationMode = stationMode;
  } else if (existingIndex >= 0 && presets[existingIndex].stationMode) {
    newPreset.stationMode = presets[existingIndex].stationMode;
  }
  
  // Preserve or set rules
  if (rules) {
    newPreset.rules = rules;
  } else if (existingIndex >= 0 && presets[existingIndex].rules) {
    newPreset.rules = presets[existingIndex].rules;
  }
  
  if (existingIndex >= 0) {
    presets[existingIndex] = newPreset;
  } else {
    presets.push(newPreset);
  }
  
  if (writeJsonFile(PRESETS_FILE, presets)) {
    invalidatePresetsCache();
    res.json({ ok: true, preset: newPreset });
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

app.post("/api/presets/:name/activate", authMiddleware, async (req, res) => {
  const { name } = req.params;
  const { profile } = req.body;
  const presets = getPresets();
  const preset = presets.find(p => p.name === name);
  
  if (!preset) {
    return res.status(404).json({ error: "Preset not found" });
  }
  
  try {
    const radioRes = await fetch(`${RADIO_API}/preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: name, profile: profile || "safe" })
    });
    
    if (!radioRes.ok) {
      const err = await radioRes.json();
      return res.status(radioRes.status).json(err);
    }
    
    const result = await radioRes.json();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Failed to communicate with radio API", details: err.message });
  }
});

// Settings
app.get("/api/settings", (req, res) => {
  const settings = getSettings();
  res.json({ apiKey: settings.apiKey ? "***" : null });
});

app.post("/api/settings", (req, res) => {
  const { apiKey } = req.body;
  let settings = {};
  
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const content = fs.readFileSync(SETTINGS_FILE, "utf8").trim();
      if (content) settings = JSON.parse(content);
    } catch (e) {}
  }
  
  if (apiKey) {
    settings.apiKey = apiKey;
    settings._hasCustomKey = true;
  }
  
  if (writeJsonFile(SETTINGS_FILE, settings)) {
    invalidateSettingsCache();
    res.json({ ok: true });
  } else {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

app.post("/api/settings/reset", (req, res) => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      fs.unlinkSync(SETTINGS_FILE);
    }
    invalidateSettingsCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to reset settings" });
  }
});

// History
app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const history = readJsonFile(HISTORY_FILE, []);
  res.json(history.slice(-limit));
});

app.post("/api/history", authMiddleware, (req, res) => {
  const { track } = req.body;
  if (!track) {
    return res.status(400).json({ error: "Track required" });
  }
  
  const history = readJsonFile(HISTORY_FILE, []);
  history.push({ ...track, playedAt: new Date().toISOString() });
  const trimmed = history.slice(-500);
  writeJsonFile(HISTORY_FILE, trimmed);
  res.json({ ok: true });
});

app.delete("/api/history", authMiddleware, (req, res) => {
  writeJsonFile(HISTORY_FILE, []);
  res.json({ ok: true });
});

// Favorites
app.get("/api/favorites", (req, res) => {
  const favorites = readJsonFile(FAVORITES_FILE, []);
  res.json(favorites);
});

app.post("/api/favorites", authMiddleware, (req, res) => {
  const { track } = req.body;
  if (!track || !track.id) {
    return res.status(400).json({ error: "Track with ID required" });
  }
  
  const favorites = readJsonFile(FAVORITES_FILE, []);
  if (!favorites.find(f => f.id === track.id)) {
    favorites.push({ ...track, addedAt: new Date().toISOString() });
    writeJsonFile(FAVORITES_FILE, favorites);
  }
  res.json({ ok: true });
});

app.delete("/api/favorites/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  let favorites = readJsonFile(FAVORITES_FILE, []);
  favorites = favorites.filter(f => f.id !== id);
  writeJsonFile(FAVORITES_FILE, favorites);
  res.json({ ok: true });
});

// Stats
app.get("/api/stats/extended", async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/stats`);
    const radioStats = await radioRes.json();
    
    const history = readJsonFile(HISTORY_FILE, []);
    const favorites = readJsonFile(FAVORITES_FILE, []);
    
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

// Phase 2: Cache and Bandwidth Stats
app.get("/api/stats/cache", async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/cache-stats`);
    const cacheStats = await radioRes.json();
    
    res.json(cacheStats);
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Phase 3: Proxy Stats
app.get("/api/stats/proxy", async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/proxy-stats`);
    const proxyStats = await radioRes.json();
    
    res.json(proxyStats);
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Phase 3: Proxy Refresh
app.post("/api/proxy/refresh", authMiddleware, async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/proxy-refresh`, {
      method: "POST"
    });
    const result = await radioRes.json();
    
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Phase 4A: Seed Performance Stats
app.get("/api/stats/seed", async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/seed-stats`);
    const seedStats = await radioRes.json();
    
    res.json(seedStats);
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Phase 4C: Seed Pool Stats
app.get("/api/seed-pool", async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/seed-pool`);
    const poolStats = await radioRes.json();
    
    res.json(poolStats);
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Phase 4C: Seed Pool Refresh
app.post("/api/seed-pool-refresh", authMiddleware, async (req, res) => {
  try {
    const radioRes = await fetch(`${RADIO_API}/seed-pool-refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const result = await radioRes.json();
    
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Radio API unavailable", details: err.message });
  }
});

// Health
app.get("/api/health", async (req, res) => {
  const radioRunning = isRadioRunning();
  const radioHealthy = radioRunning ? await checkRadioHealth() : false;
  
  res.json({
    backend: "ok",
    radio: {
      running: radioRunning,
      healthy: radioHealthy,
      pid: radioProcess?.pid || null
    }
  });

});

// Custom Queue Management
app.get("/api/custom-queue", (req, res) => {
  const queue = readJsonFile(CUSTOM_QUEUE_FILE, []);
  res.json(queue);
});

app.post("/api/custom-queue", authMiddleware, (req, res) => {
  const { url, type } = req.body;
  
  if (!url || !url.trim()) {
    return res.status(400).json({ error: "URL is required" });
  }
  
  const trimmedUrl = url.trim();
  
  // Validate YouTube URL
  if (!trimmedUrl.includes("youtube.com") && !trimmedUrl.includes("youtu.be")) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }
  
  const queue = readJsonFile(CUSTOM_QUEUE_FILE, []);
  
  const newItem = {
    id: Date.now().toString(),
    url: trimmedUrl,
    type: type || "video", // "video" or "playlist"
    addedAt: new Date().toISOString()
  };
  
  queue.push(newItem);
  
  if (writeJsonFile(CUSTOM_QUEUE_FILE, queue)) {
    addRadioLog("info", `Added to custom queue: ${trimmedUrl}`);
    res.json({ ok: true, item: newItem, queueLength: queue.length });
  } else {
    res.status(500).json({ error: "Failed to save to custom queue" });
  }
});

app.delete("/api/custom-queue/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  let queue = readJsonFile(CUSTOM_QUEUE_FILE, []);
  const initialLength = queue.length;
  queue = queue.filter(item => item.id !== id);
  
  if (queue.length === initialLength) {
    return res.status(404).json({ error: "Item not found" });
  }
  
  if (writeJsonFile(CUSTOM_QUEUE_FILE, queue)) {
    addRadioLog("info", `Removed from custom queue: ${id}`);
    res.json({ ok: true, queueLength: queue.length });
  } else {
    res.status(500).json({ error: "Failed to update custom queue" });
  }
});

app.delete("/api/custom-queue", authMiddleware, (req, res) => {
  if (writeJsonFile(CUSTOM_QUEUE_FILE, [])) {
    addRadioLog("info", "Custom queue cleared");
    res.json({ ok: true });
  } else {
    res.status(500).json({ error: "Failed to clear custom queue" });
  }
});

// Debug endpoint to check custom queue status
app.get("/api/custom-queue/debug", (req, res) => {
  const queue = readJsonFile(CUSTOM_QUEUE_FILE, []);
  const stats = {
    totalItems: queue.length,
    videos: queue.filter(item => item.type === "video").length,
    playlists: queue.filter(item => item.type === "playlist").length,
    items: queue.map(item => ({
      id: item.id,
      type: item.type,
      url: item.url,
      addedAt: item.addedAt
    }))
  };
  res.json(stats);
});

// Proxy to radio API (MUST BE LAST - catches all /api/radio/*)
app.use("/api/radio", createProxyMiddleware({
  target: RADIO_API,
  changeOrigin: true,
  pathRewrite: { "^/api/radio": "" }
}));

// Start server
app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🎵 YT Radio Backend - Control Panel`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n📡 Backend Server:`);
  console.log(`   URL:        http://localhost:${PORT}`);
  console.log(`   Dashboard:  http://localhost:${PORT}`);
  console.log(`   API:        http://localhost:${PORT}/api`);
  console.log(`\n🎵 Radio Server (auto-starting):`);
  console.log(`   Stream:     http://localhost:8080`);
  console.log(`   Stream:     http://localhost:8080/stream`);
  console.log(`   Gopher:     gopher://localhost:8081`);
  console.log(`   WebSocket:  ws://localhost:8080`);
  console.log(`\n📊 API Endpoints:`);
  console.log(`   Health:     GET  /api/health`);
  console.log(`   Stats:      GET  /api/stats/extended`);
  console.log(`   Now Play:   GET  /api/radio/now-playing`);
  console.log(`   Presets:    GET  /api/presets`);
  console.log(`   Control:    POST /api/radio/{start|stop|restart}`);
  console.log(`   Status:     GET  /api/radio/status`);
  console.log(`   Logs:       GET  /api/radio/logs`);
  console.log(`\n${"=".repeat(60)}\n`);
  
  // Auto-start radio after 2 seconds
  setTimeout(() => {
    console.log("[Backend] Auto-starting radio...");
    startRadioProcess();
  }, 2000);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[Backend] Received SIGINT, shutting down gracefully...");
  await stopRadioProcess();
  console.log("[Backend] Shutdown complete");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[Backend] Received SIGTERM, shutting down gracefully...");
  await stopRadioProcess();
  console.log("[Backend] Shutdown complete");
  process.exit(0);
});