// Load environment variables from .env file
require("dotenv").config();

const http = require("http");
const { spawn, spawnSync } = require("child_process");
const gopher = require("gopherserver.js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Transform } = require("node:stream");
const vm = require("node:vm");
const WebSocket = require("ws").Server;
const YouTube = require("youtubei.js");
const { LRUCache } = require("lru-cache");
const { ProxyManager } = require("./proxy-manager");

const { loadConfig } = require("./config");
const {
  createRadioBroadcaster,
  createRepeater
} = require("./radio-broadcaster");
const {
  createLogger,
  installConsoleErrorHandlers,
  isIgnorableConsoleError
} = require("./logger");

const config = loadConfig(process.env);
installConsoleErrorHandlers();
const logger = createLogger({ level: config.logLevel });

// Phase 3: Initialize Proxy Manager
const proxyManager = new ProxyManager(logger, {
  enabled: process.env.PROXY_ENABLED === "true" || false,
  scrapeInterval: parseInt(process.env.PROXY_SCRAPE_INTERVAL) || 1000 * 60 * 30, // 30 min
  testInterval: parseInt(process.env.PROXY_TEST_INTERVAL) || 1000 * 60 * 5, // 5 min
  testTimeout: parseInt(process.env.PROXY_TEST_TIMEOUT) || 5000,
  maxProxies: parseInt(process.env.PROXY_MAX_PROXIES) || 50,
  minWorkingProxies: parseInt(process.env.PROXY_MIN_WORKING) || 5
});

const nativePlaybackProfiles = [
  {
    backend: "native",
    client: config.playbackClient,
    options: { ...config.playbackFormatOptions }
  },
  {
    backend: "native",
    client: "ANDROID",
    options: { type: "video+audio", format: "mp4", quality: "best" }
  },
  {
    backend: "native",
    client: "ANDROID",
    options: { type: "video+audio", format: "mp4", quality: "360p" }
  },
  {
    backend: "native",
    client: "ANDROID",
    options: { type: "audio", format: "any", quality: "best" }
  },
  {
    backend: "native",
    client: "IOS",
    options: { type: "audio", format: "any", quality: "best" }
  }
];

function detectYtDlpAvailability() {
  try {
    const probe = spawnSync(config.ytDlpPath, ["--version"], {
      stdio: "ignore",
      windowsHide: true
    });

    return !probe.error && probe.status === 0;
  } catch (_err) {
    return false;
  }
}

const ytDlpAvailable = detectYtDlpAvailability();
const DEFAULT_STRICT_BLOCK_KEYWORDS = [
  "live",
  "karaoke",
  "cover",
  "remix",
  "slowed",
  "speed up",
  "sped up"
];
const DEFAULT_STRICT_RULES = {
  refreshFromSeedEvery: 3,
  minDurationSec: 90,
  maxDurationSec: 480,
  allowArtists: [],
  blockArtists: [],
  allowKeywords: [],
  blockKeywords: DEFAULT_STRICT_BLOCK_KEYWORDS,
  dedupeWindowSize: 6
};

const radio = createRadioBroadcaster({
  format: config.radio.format,
  bitrate: config.radio.bitrate,
  acodec: config.radio.codec,
  fadeInMs: config.transition.fadeInMs
});

function evaluatePlayerScript(data, env = {}) {
  const context = vm.createContext({
    ...env,
    URL,
    URLSearchParams,
    console,
    decodeURIComponent,
    encodeURIComponent
  });

  // Expose the sandbox as its own global instead of leaking Node's host global.
  context.globalThis = context;
  context.self = context;

  return new vm.Script(`(function() {\n${data.output}\n})()`).runInContext(context, {
    timeout: 1000
  });
}

YouTube.Platform.load({
  ...YouTube.Platform.shim,
  eval: evaluatePlayerScript
});

function loadRuntimePresets() {
  const presetsPath = path.join(__dirname, "radio-presets.json");

  try {
    const raw = fs.readFileSync(presetsPath, "utf8").trim();
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    logger.warn("Failed to load runtime presets:", err.message);
    return [];
  }
}

const runtimePresets = loadRuntimePresets();

function readSeedUrl() {
  const cliUrl = process.argv.slice(2)[0];
  if (cliUrl) {
    return cliUrl.trim();
  }

  try {
    return fs.readFileSync(config.seedUrlFile, "utf8").trim();
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      logger.warn("Failed to read seed URL file:", err.message);
    }

    return "";
  }
}

function writeSeedUrlValue(url) {
  if (!url) {
    return;
  }

  try {
    fs.writeFileSync(config.seedUrlFile, `${url}`, "utf8");
  } catch (err) {
    logger.warn("Failed to persist seed URL:", err.message);
  }
}

function writeSeedUrl(videoId) {
  if (!videoId) {
    return;
  }

  writeSeedUrlValue(`https://youtu.be/${videoId}`);
}

function getVideoID(value) {
  const parsed = new URL(value);
  if (parsed.hostname === "youtu.be") {
    return parsed.pathname.slice(1);
  }

  if (parsed.searchParams.has("v")) {
    return parsed.searchParams.get("v");
  }

  return parsed.pathname.split("/").filter(Boolean).pop() || null;
}

function getStatusFromError(err) {
  return err?.statusCode || err?.info?.response?.status || null;
}

function serializeError(err) {
  if (!err) {
    return null;
  }

  return {
    message: err.message || String(err),
    code: err.code || null,
    status: getStatusFromError(err),
    name: err.name || "Error"
  };
}

function once(fn) {
  let called = false;

  return (...args) => {
    if (called) {
      return;
    }

    called = true;
    fn(...args);
  };
}

function getContentType() {
  switch (config.radio.format) {
    case "aac":
      return "audio/aac";
    case "ogg":
      return "audio/ogg";
    case "opus":
      return "audio/ogg";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}

const state = {
  startedAt: Date.now(),
  seedUrl: readSeedUrl(),
  activePreset: process.env.YTRADIO_ACTIVE_PRESET || null,
  activeProfile: process.env.YTRADIO_ACTIVE_PROFILE || null,
  activePresetConfig: null,
  pendingPresetChange: null,
  pendingReplay: null,
  client: null,
  currentTrack: null,
  currentPlayback: null,
  playlist: [],
  tracksSinceAnchor: 0,
  recentTrackIds: [],
  recentArtists: [],
  playInProgress: false,
  nextTrackQueued: false,
  shuttingDown: false,
  consecutiveFailures: 0,
  retryTimer: null,
  trackCache: new Map(),
  wsClients: new Map(),
  httpListeners: new Map(),
  gopherListeners: new Map(),
  nextConnectionId: 1,
  lastPlaybackBackend: null,
  lastPlaybackProfile: null,
  adaptiveQuality: {
    currentQuality: "best",
    successCount: 0,
    failureCount: 0,
    lastAdjustment: Date.now()
  },
  stats: {
    songsStarted: 0,
    songsCompleted: 0,
    songsSkipped: 0,
    retriesScheduled: 0,
    lastError: null,
    lastStartedAt: null
  },
  streamCache: new Map(), // Cache for pre-downloaded streams
  // Phase 2: Intelligent caching
  lruCache: new LRUCache({
    max: 50, // Maximum 50 tracks in memory
    ttl: 1000 * 60 * 30, // 30 minutes TTL
    updateAgeOnGet: true,
    updateAgeOnHas: true
  }),
  diskCachePath: path.join(__dirname, "cache", "tracks"),
  diskCacheMaxSize: 500 * 1024 * 1024, // 500 MB
  diskCacheStats: {
    size: 0,
    files: 0
  },
  // Phase 2: Bandwidth monitoring
  bandwidthMonitor: {
    samples: [],
    maxSamples: 10,
    lastCheck: Date.now()
  },
  // Phase 4A: Seed performance tracking
  seedPerformance: new Map(), // Map<seedUrl, performance>
  seedTrack: null, // Last seed track used
  genreDriftDetected: false
};

function nextConnectionId() {
  const id = state.nextConnectionId;
  state.nextConnectionId += 1;
  return String(id);
}

// ============================================================================
// PHASE 4A: INTELLIGENT SEED MANAGEMENT
// ============================================================================

/**
 * Track seed performance metrics
 */
function trackSeedPerformance(seedUrl, metrics) {
  if (!state.seedPerformance.has(seedUrl)) {
    state.seedPerformance.set(seedUrl, {
      url: seedUrl,
      usageCount: 0,
      successfulTracks: 0,
      skippedTracks: 0,
      playlistSizes: [],
      avgPlaylistSize: 0,
      lastUsed: null,
      score: 100, // Initial score
      genreConsistency: 100
    });
  }

  const perf = state.seedPerformance.get(seedUrl);
  perf.usageCount++;
  perf.successfulTracks += metrics.successful || 0;
  perf.skippedTracks += metrics.skipped || 0;
  perf.lastUsed = Date.now();

  // Track playlist sizes
  if (metrics.playlistSize) {
    perf.playlistSizes.push(metrics.playlistSize);
    if (perf.playlistSizes.length > 10) {
      perf.playlistSizes.shift();
    }
    perf.avgPlaylistSize = perf.playlistSizes.reduce((a, b) => a + b, 0) / perf.playlistSizes.length;
  }

  // Calculate score: success rate (80%) + playlist size bonus (20%)
  const totalTracks = perf.successfulTracks + perf.skippedTracks;
  const successRate = totalTracks > 0 ? perf.successfulTracks / totalTracks : 1;
  const playlistBonus = Math.min(perf.avgPlaylistSize / 20, 1); // Max 20 tracks = 100%

  perf.score = (successRate * 80) + (playlistBonus * 20);

  logger.debug(`Seed performance updated: ${seedUrl.substring(0, 50)}... Score: ${Math.round(perf.score)}`);
}

/**
 * Get seed performance statistics
 */
function getSeedPerformanceStats() {
  const stats = [];

  for (const [url, perf] of state.seedPerformance.entries()) {
    stats.push({
      url: url.substring(0, 60) + "...",
      usageCount: perf.usageCount,
      successRate: perf.successfulTracks + perf.skippedTracks > 0
        ? Math.round((perf.successfulTracks / (perf.successfulTracks + perf.skippedTracks)) * 100)
        : 100,
      avgPlaylistSize: Math.round(perf.avgPlaylistSize * 10) / 10,
      score: Math.round(perf.score),
      lastUsed: perf.lastUsed ? new Date(perf.lastUsed).toISOString() : null
    });
  }

  return stats.sort((a, b) => b.score - a.score);
}

/**
 * Intelligent seed selection based on performance
 */
function pickBestSeed(presetConfig) {
  const seeds = presetConfig.seedUrls || [presetConfig.seedUrl];

  if (seeds.length === 1) {
    return seeds[0];
  }

  // Get performance data for all seeds
  const seedScores = seeds.map(url => {
    const perf = state.seedPerformance.get(url);
    return {
      url,
      score: perf?.score || 100, // Default score for new seeds
      usageCount: perf?.usageCount || 0
    };
  });

  // Sort by score (descending)
  seedScores.sort((a, b) => b.score - a.score);

  // Weighted random selection (80% best, 20% exploration)
  const random = Math.random();

  if (random < 0.8) {
    // 80% chance: pick from top 50% seeds
    const topHalf = seedScores.slice(0, Math.ceil(seedScores.length / 2));
    const totalScore = topHalf.reduce((sum, s) => sum + s.score, 0);
    let randomScore = Math.random() * totalScore;

    for (const seed of topHalf) {
      randomScore -= seed.score;
      if (randomScore <= 0) {
        logger.debug(`Selected seed (intelligent): ${seed.url.substring(0, 50)}... (score: ${Math.round(seed.score)})`);
        return seed.url;
      }
    }

    return topHalf[0].url;
  } else {
    // 20% chance: explore less-used seeds
    const leastUsed = seedScores.sort((a, b) => a.usageCount - b.usageCount)[0];
    logger.debug(`Selected seed (exploration): ${leastUsed.url.substring(0, 50)}... (usage: ${leastUsed.usageCount})`);
    return leastUsed.url;
  }
}

// Note: extractGenreKeywords() and calculateGenreSimilarity() are defined in Phase 4C section

/**
 * Detect genre drift from seed
 */
function detectGenreDrift() {
  if (!state.currentTrack || !state.seedTrack) {
    return false;
  }

  const seedGenre = extractGenreKeywords(state.seedTrack);
  const currentGenre = extractGenreKeywords(state.currentTrack);

  const similarity = calculateGenreSimilarity(seedGenre, currentGenre);

  // If similarity < 30%, consider it drifted
  if (similarity < 0.3) {
    logger.info(`Genre drift detected: seed=${seedGenre.join(", ")} vs current=${currentGenre.join(", ")} (similarity: ${Math.round(similarity * 100)}%)`);
    return true;
  }

  return false;
}

// ============================================================================
// END PHASE 4A
// ============================================================================

// ============================================================================
// PHASE 4B: ENHANCED SEED TYPES & HYBRID PROPAGATION
// ============================================================================

/**
 * Seed types supported
 */
const SEED_TYPES = {
  VIDEO: "video",
  PLAYLIST: "playlist",
  MIX: "mix",
  CHANNEL: "channel"
};

/**
 * Parse seed configuration
 */
function parseSeedConfig(seedConfig) {
  // Legacy format: just a URL string
  if (typeof seedConfig === "string") {
    return {
      type: SEED_TYPES.VIDEO,
      url: seedConfig,
      weight: 100
    };
  }

  // Enhanced format: object with type, url, weight
  return {
    type: seedConfig.type || SEED_TYPES.VIDEO,
    url: seedConfig.url,
    weight: seedConfig.weight || 100
  };
}

/**
 * Extract video ID from URL
 */
function getVideoID(url) {
  if (!url) return null;
  
  // Already an ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
    return url;
  }
  
  // Standard YouTube URL
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Extract playlist ID from URL
 */
function getPlaylistID(url) {
  if (!url) return null;
  
  const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Extract channel ID from URL
 */
function getChannelID(url) {
  if (!url) return null;
  
  // Channel ID format
  const idMatch = url.match(/\/channel\/([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  
  // Username format
  const userMatch = url.match(/\/@([a-zA-Z0-9_-]+)/);
  if (userMatch) return userMatch[1];
  
  return null;
}

/**
 * Get seed track based on seed type
 */
async function getSeedTrackByType(seedConfig) {
  const config = parseSeedConfig(seedConfig);
  
  try {
    switch (config.type) {
      case SEED_TYPES.VIDEO: {
        const videoId = getVideoID(config.url);
        if (!videoId) {
          throw new Error(`Invalid video URL: ${config.url}`);
        }
        logger.debug(`Getting seed from video: ${videoId}`);
        return await getMusicTrack(videoId);
      }

      case SEED_TYPES.PLAYLIST: {
        const playlistId = getPlaylistID(config.url);
        if (!playlistId) {
          throw new Error(`Invalid playlist URL: ${config.url}`);
        }
        logger.debug(`Getting seed from playlist: ${playlistId}`);
        
        const playlist = await state.client.getPlaylist(playlistId);
        let videos = [];
        
        // Try different methods to get videos
        if (typeof playlist.getVideos === "function") {
          videos = await playlist.getVideos();
        } else if (playlist.videos) {
          videos = playlist.videos;
        } else if (playlist.items) {
          videos = playlist.items;
        }
        
        if (!videos || videos.length === 0) {
          throw new Error(`Playlist ${playlistId} has no videos`);
        }
        
        // Pick random video from playlist
        const randomIndex = Math.floor(Math.random() * Math.min(videos.length, 50));
        const video = videos[randomIndex];
        const videoId = video.id || video.video_id || video.key?.videoId;
        
        if (!videoId) {
          throw new Error(`Could not extract video ID from playlist`);
        }
        
        logger.info(`Selected random video from playlist: ${videoId} (${randomIndex + 1}/${videos.length})`);
        return await getMusicTrack(videoId);
      }

      case SEED_TYPES.MIX: {
        // YouTube Mix is essentially a playlist
        const playlistId = getPlaylistID(config.url);
        if (!playlistId) {
          throw new Error(`Invalid mix URL: ${config.url}`);
        }
        logger.debug(`Getting seed from mix: ${playlistId}`);
        
        const mix = await state.client.getPlaylist(playlistId);
        let videos = [];
        
        if (typeof mix.getVideos === "function") {
          videos = await mix.getVideos();
        } else if (mix.videos) {
          videos = mix.videos;
        } else if (mix.items) {
          videos = mix.items;
        }
        
        if (!videos || videos.length === 0) {
          throw new Error(`Mix ${playlistId} has no videos`);
        }
        
        // Pick random video from mix
        const randomIndex = Math.floor(Math.random() * Math.min(videos.length, 50));
        const video = videos[randomIndex];
        const videoId = video.id || video.video_id || video.key?.videoId;
        
        if (!videoId) {
          throw new Error(`Could not extract video ID from mix`);
        }
        
        logger.info(`Selected random video from mix: ${videoId} (${randomIndex + 1}/${videos.length})`);
        return await getMusicTrack(videoId);
      }

      case SEED_TYPES.CHANNEL: {
        const channelId = getChannelID(config.url);
        if (!channelId) {
          throw new Error(`Invalid channel URL: ${config.url}`);
        }
        logger.debug(`Getting seed from channel: ${channelId}`);
        
        const channel = await state.client.getChannel(channelId);
        const uploads = await channel.getVideos();
        
        if (!uploads || uploads.length === 0) {
          throw new Error(`Channel ${channelId} has no videos`);
        }
        
        // Pick from recent uploads (first 20)
        const recentVideos = uploads.slice(0, 20);
        const randomIndex = Math.floor(Math.random() * recentVideos.length);
        const video = recentVideos[randomIndex];
        const videoId = video.id || video.video_id;
        
        if (!videoId) {
          throw new Error(`Could not extract video ID from channel`);
        }
        
        logger.info(`Selected random video from channel: ${videoId} (${randomIndex + 1}/${recentVideos.length})`);
        return await getMusicTrack(videoId);
      }

      default:
        throw new Error(`Unknown seed type: ${config.type}`);
    }
  } catch (err) {
    logger.warn(`Failed to get seed from ${config.type}: ${err.message}`);
    throw err;
  }
}

/**
 * Hybrid propagation: mix seed and recommendation tracks
 */
async function populatePlaylistHybrid(seedRatio = 0.3) {
  const numTracks = 10;
  const numSeedTracks = Math.floor(seedRatio * numTracks);
  const numRecTracks = numTracks - numSeedTracks;
  
  logger.debug(`Hybrid propagation: ${numSeedTracks} from seed, ${numRecTracks} from recommendations`);
  
  const mixed = [];
  
  try {
    // Get recommendations from current track
    if (state.currentTrack && numRecTracks > 0) {
      const upNext = await state.currentTrack.getUpNext();
      const rawItems = Array.isArray(upNext.contents) ? upNext.contents : [];
      const filteredItems = filterPlaylistCandidates(rawItems);
      
      // Take first N recommendation tracks
      mixed.push(...filteredItems.slice(0, numRecTracks));
    }
    
    // Get recommendations from seed
    if (state.seedTrack && numSeedTracks > 0) {
      const upNext = await state.seedTrack.getUpNext();
      const rawItems = Array.isArray(upNext.contents) ? upNext.contents : [];
      const filteredItems = filterPlaylistCandidates(rawItems);
      
      // Take first N seed tracks
      mixed.push(...filteredItems.slice(0, numSeedTracks));
    }
    
    // Shuffle to avoid predictable pattern
    for (let i = mixed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
    }
    
    state.playlist = mixed;
    logger.info(`Hybrid playlist created: ${mixed.length} tracks (${numSeedTracks} seed-based, ${numRecTracks} recommendation-based)`);
    
    // Track seed performance
    if (state.seedUrl) {
      trackSeedPerformance(state.seedUrl, {
        playlistSize: mixed.length
      });
    }
    
    prefetchQueuedTracks();
  } catch (err) {
    logger.warn(`Hybrid propagation failed: ${err.message}, falling back to normal`);
    
    // Fallback to normal propagation
    if (state.currentTrack) {
      await populatePlaylistFromTrack(state.currentTrack, {
        logContext: "hybrid-fallback"
      });
    }
  }
}

// ============================================================================
// END PHASE 4B
// ============================================================================

// ============================================================================
// PHASE 4C: SEED POOL MANAGEMENT & EXTERNAL SOURCE INTEGRATION
// ============================================================================

/**
 * Seed pool state for auto-discovery and management
 */
state.seedPool = {
  active: [],        // Currently used seeds
  discovered: [],    // Discovered from recommendations
  external: [],      // From external sources (Spotify, Charts)
  maxSize: 20,       // Maximum pool size per category
  lastRefresh: null  // Last external source refresh
};

/**
 * External source configurations
 */
const EXTERNAL_SOURCES = {
  YOUTUBE_TRENDING: "youtube-trending",
  YOUTUBE_CHARTS: "youtube-charts",
  SPOTIFY_PLAYLIST: "spotify-playlist"
};

/**
 * Check if a track is high quality (for seed discovery)
 */
function isHighQualityTrack(track) {
  if (!track || !track.basic_info) return false;
  
  // Track must have been played (not skipped immediately)
  const playDuration = state.trackPlayDuration || 0;
  const minPlayDuration = 30; // At least 30 seconds
  
  if (playDuration < minPlayDuration) return false;
  
  // Track should have good metadata
  const hasGoodMetadata = track.basic_info.title && 
                          track.basic_info.author && 
                          track.basic_info.duration > 60;
  
  return hasGoodMetadata;
}

/**
 * Extract genre keywords from track metadata
 */
function extractGenreKeywords(track) {
  if (!track || !track.basic_info) return [];
  
  const text = `${track.basic_info.title} ${track.basic_info.author}`.toLowerCase();
  
  const genreKeywords = [
    "pop", "rock", "jazz", "classical", "electronic", "dance", "edm",
    "hip hop", "rap", "trap", "r&b", "soul", "funk", "disco",
    "house", "techno", "trance", "dubstep", "drum and bass",
    "metal", "punk", "indie", "alternative", "grunge",
    "country", "folk", "blues", "reggae", "ska",
    "latin", "salsa", "bachata", "reggaeton", "kpop",
    "manele", "lautareasca", "populara", "acordeon"
  ];
  
  const found = [];
  for (const keyword of genreKeywords) {
    if (text.includes(keyword)) {
      found.push(keyword);
    }
  }
  
  return found;
}

/**
 * Calculate genre similarity between two tracks (Jaccard similarity)
 */
function calculateGenreSimilarity(genres1, genres2) {
  // If either has no genres, return neutral similarity (50%)
  // This prevents false drift detection when metadata is poor
  if (!genres1 || !genres2 || !genres1.length || !genres2.length) {
    return 0.5; // Neutral - don't trigger drift
  }
  
  const set1 = new Set(genres1);
  const set2 = new Set(genres2);
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  // Avoid division by zero
  if (union.size === 0) return 0.5;
  
  return intersection.size / union.size;
}

/**
 * Discover potential seeds from high-quality tracks
 */
function discoverPotentialSeed(track) {
  if (!isHighQualityTrack(track)) return;
  
  const videoId = track.basic_info.id;
  const seedUrl = `https://youtu.be/${videoId}`;
  
  // Check if already in discovered pool
  const exists = state.seedPool.discovered.find(s => s.url === seedUrl);
  if (exists) {
    // Update score
    exists.score = Math.min(100, exists.score + 5);
    exists.lastSeen = Date.now();
    return;
  }
  
  // Add new seed candidate
  const seedCandidate = {
    url: seedUrl,
    videoId: videoId,
    title: track.basic_info.title,
    author: track.basic_info.author,
    discoveredAt: Date.now(),
    lastSeen: Date.now(),
    source: "recommendation",
    genres: extractGenreKeywords(track),
    score: 50,  // Initial score
    playCount: 0
  };
  
  state.seedPool.discovered.push(seedCandidate);
  logger.info(`Discovered potential seed: ${track.basic_info.title} by ${track.basic_info.author}`);
  
  // Limit pool size
  if (state.seedPool.discovered.length > state.seedPool.maxSize) {
    // Remove lowest scoring seeds
    state.seedPool.discovered.sort((a, b) => b.score - a.score);
    state.seedPool.discovered = state.seedPool.discovered.slice(0, state.seedPool.maxSize);
  }
}

/**
 * Promote discovered seeds to active pool
 */
function promoteDiscoveredSeeds() {
  if (!state.seedPool.discovered.length) return;
  
  // Promote top 3 discovered seeds
  const topSeeds = state.seedPool.discovered
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  
  for (const seed of topSeeds) {
    // Check if already in active pool
    const existsInActive = state.seedPool.active.find(s => s.url === seed.url);
    if (existsInActive) continue;
    
    // Check if already in preset seeds
    const preset = state.activePresetConfig;
    if (preset && preset.seedUrls && preset.seedUrls.includes(seed.url)) continue;
    
    // Promote to active
    state.seedPool.active.push({
      ...seed,
      promotedAt: Date.now()
    });
    
    logger.info(`Promoted discovered seed to active: ${seed.title} (score: ${seed.score})`);
  }
  
  // Limit active pool size
  if (state.seedPool.active.length > state.seedPool.maxSize) {
    state.seedPool.active.sort((a, b) => b.score - a.score);
    state.seedPool.active = state.seedPool.active.slice(0, state.seedPool.maxSize);
  }
}

/**
 * Fetch YouTube trending music videos
 */
async function fetchYouTubeTrending(region = "RO") {
  try {
    logger.info(`Fetching YouTube trending music for region: ${region}`);
    
    // Use yt-dlp to fetch trending
    const { execSync } = require("child_process");
    const command = `yt-dlp --flat-playlist --print "%(id)s|%(title)s|%(uploader)s" "https://www.youtube.com/feed/trending?bp=4gINGgt5dG1hX2NoYXJ0cw%3D%3D"`;
    
    const output = execSync(command, { encoding: "utf8", timeout: 30000 });
    const lines = output.trim().split("\n");
    
    const seeds = [];
    for (const line of lines.slice(0, 10)) {  // Top 10
      const [videoId, title, uploader] = line.split("|");
      if (videoId && title) {
        seeds.push({
          url: `https://youtu.be/${videoId}`,
          videoId: videoId,
          title: title,
          author: uploader || "Unknown",
          source: EXTERNAL_SOURCES.YOUTUBE_TRENDING,
          discoveredAt: Date.now(),
          score: 70,  // Higher initial score for trending
          region: region
        });
      }
    }
    
    logger.info(`Fetched ${seeds.length} trending seeds`);
    return seeds;
  } catch (err) {
    logger.warn(`Failed to fetch YouTube trending: ${err.message}`);
    return [];
  }
}

/**
 * Fetch YouTube Charts (Top Songs)
 */
async function fetchYouTubeCharts(region = "RO") {
  try {
    logger.info(`Fetching YouTube charts for region: ${region}`);
    
    // YouTube Music Charts playlist IDs by region
    const chartPlaylists = {
      "RO": "PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj",  // Romania Top 100
      "US": "PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj",  // US Top 100
      "GLOBAL": "PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj"
    };
    
    const playlistId = chartPlaylists[region] || chartPlaylists["GLOBAL"];
    const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
    
    // Fetch playlist using ytdl-core or yt-dlp
    const { execSync } = require("child_process");
    const command = `yt-dlp --flat-playlist --print "%(id)s|%(title)s|%(uploader)s" "${playlistUrl}"`;
    
    const output = execSync(command, { encoding: "utf8", timeout: 30000 });
    const lines = output.trim().split("\n");
    
    const seeds = [];
    for (const line of lines.slice(0, 20)) {  // Top 20
      const [videoId, title, uploader] = line.split("|");
      if (videoId && title) {
        seeds.push({
          url: `https://youtu.be/${videoId}`,
          videoId: videoId,
          title: title,
          author: uploader || "Unknown",
          source: EXTERNAL_SOURCES.YOUTUBE_CHARTS,
          discoveredAt: Date.now(),
          score: 75,  // Higher score for charts
          region: region
        });
      }
    }
    
    logger.info(`Fetched ${seeds.length} chart seeds`);
    return seeds;
  } catch (err) {
    logger.warn(`Failed to fetch YouTube charts: ${err.message}`);
    return [];
  }
}

/**
 * Convert Spotify track to YouTube search query
 */
function spotifyToYouTubeQuery(spotifyTrack) {
  const artist = spotifyTrack.artists?.[0]?.name || "";
  const title = spotifyTrack.name || "";
  return `${artist} ${title}`.trim();
}

/**
 * Search YouTube for a track
 */
async function searchYouTube(query) {
  try {
    const searchResults = await ytdl.search(query, { limit: 1 });
    if (searchResults && searchResults.length > 0) {
      return searchResults[0];
    }
    return null;
  } catch (err) {
    logger.warn(`YouTube search failed for "${query}": ${err.message}`);
    return null;
  }
}

/**
 * Fetch Spotify playlist and convert to YouTube seeds
 */
async function fetchSpotifyPlaylist(playlistId) {
  try {
    logger.info(`Fetching Spotify playlist: ${playlistId}`);
    
    // Note: This requires Spotify API credentials
    // For now, we'll use a simplified approach with public playlist data
    
    // TODO: Implement Spotify API integration
    // Requires: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env
    
    logger.warn("Spotify integration not yet implemented - requires API credentials");
    return [];
  } catch (err) {
    logger.warn(`Failed to fetch Spotify playlist: ${err.message}`);
    return [];
  }
}

/**
 * Refresh seeds from external sources
 */
async function refreshSeedsFromExternalSources() {
  try {
    logger.info("Refreshing seeds from external sources...");
    
    const newSeeds = [];
    
    // Fetch YouTube trending
    const trendingSeeds = await fetchYouTubeTrending("RO");
    newSeeds.push(...trendingSeeds);
    
    // Fetch YouTube charts
    const chartSeeds = await fetchYouTubeCharts("RO");
    newSeeds.push(...chartSeeds);
    
    // Add to external pool
    for (const seed of newSeeds) {
      // Check if already exists
      const exists = state.seedPool.external.find(s => s.videoId === seed.videoId);
      if (!exists) {
        state.seedPool.external.push(seed);
      }
    }
    
    // Limit external pool size
    if (state.seedPool.external.length > state.seedPool.maxSize * 2) {
      state.seedPool.external.sort((a, b) => b.discoveredAt - a.discoveredAt);
      state.seedPool.external = state.seedPool.external.slice(0, state.seedPool.maxSize * 2);
    }
    
    state.seedPool.lastRefresh = Date.now();
    logger.info(`Refreshed ${newSeeds.length} seeds from external sources (total: ${state.seedPool.external.length})`);
    
    return newSeeds.length;
  } catch (err) {
    logger.error(`Failed to refresh seeds from external sources: ${err.message}`);
    return 0;
  }
}

/**
 * Get seed pool statistics
 */
function getSeedPoolStats() {
  return {
    active: {
      count: state.seedPool.active.length,
      seeds: state.seedPool.active.map(s => ({
        title: s.title,
        author: s.author,
        score: s.score,
        source: s.source,
        promotedAt: s.promotedAt
      }))
    },
    discovered: {
      count: state.seedPool.discovered.length,
      topSeeds: state.seedPool.discovered
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(s => ({
          title: s.title,
          author: s.author,
          score: s.score,
          playCount: s.playCount
        }))
    },
    external: {
      count: state.seedPool.external.length,
      lastRefresh: state.seedPool.lastRefresh,
      sources: {
        trending: state.seedPool.external.filter(s => s.source === EXTERNAL_SOURCES.YOUTUBE_TRENDING).length,
        charts: state.seedPool.external.filter(s => s.source === EXTERNAL_SOURCES.YOUTUBE_CHARTS).length,
        spotify: state.seedPool.external.filter(s => s.source === EXTERNAL_SOURCES.SPOTIFY_PLAYLIST).length
      }
    }
  };
}

/**
 * Schedule periodic seed pool refresh (daily)
 */
function scheduleSeedPoolRefresh() {
  const refreshInterval = 1000 * 60 * 60 * 24; // 24 hours
  
  // Initial refresh after 5 minutes
  setTimeout(() => {
    refreshSeedsFromExternalSources();
  }, 1000 * 60 * 5);
  
  // Periodic refresh
  setInterval(() => {
    refreshSeedsFromExternalSources();
  }, refreshInterval);
  
  logger.info("Scheduled seed pool refresh (every 24 hours)");
}

/**
 * Get seed from pool (active, discovered, or external)
 */
function getSeedFromPool(preset) {
  // Priority: active > external > discovered
  const allSeeds = [
    ...state.seedPool.active,
    ...state.seedPool.external,
    ...state.seedPool.discovered
  ];
  
  if (!allSeeds.length) return null;
  
  // Filter by genre if preset has genre info
  let filteredSeeds = allSeeds;
  if (preset && preset.rules && preset.rules.allowKeywords) {
    const allowedGenres = preset.rules.allowKeywords;
    filteredSeeds = allSeeds.filter(seed => {
      return seed.genres && seed.genres.some(g => allowedGenres.includes(g));
    });
  }
  
  // If no genre match, use all seeds
  if (!filteredSeeds.length) {
    filteredSeeds = allSeeds;
  }
  
  // Weighted random selection based on score
  const totalScore = filteredSeeds.reduce((sum, s) => sum + (s.score || 50), 0);
  let random = Math.random() * totalScore;
  
  for (const seed of filteredSeeds) {
    random -= (seed.score || 50);
    if (random <= 0) {
      return seed;
    }
  }
  
  return filteredSeeds[0];
}

// ============================================================================
// END PHASE 4C
// ============================================================================

// ============================================================================
// PHASE 2: INTELLIGENT CACHING & BANDWIDTH MONITORING
// ============================================================================

/**
 * Initialize disk cache directory
 */
function initDiskCache() {
  if (!fs.existsSync(state.diskCachePath)) {
    fs.mkdirSync(state.diskCachePath, { recursive: true });
    logger.info(`Created disk cache directory: ${state.diskCachePath}`);
  }
  
  // Calculate current cache size
  updateDiskCacheStats();
}

/**
 * Update disk cache statistics
 */
function updateDiskCacheStats() {
  try {
    const files = fs.readdirSync(state.diskCachePath);
    let totalSize = 0;
    
    for (const file of files) {
      const filePath = path.join(state.diskCachePath, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
    }
    
    state.diskCacheStats.size = totalSize;
    state.diskCacheStats.files = files.length;
  } catch (err) {
    logger.warn("Failed to update disk cache stats:", err.message);
  }
}

/**
 * Get disk cache file path for a video ID
 */
function getDiskCachePath(videoId) {
  return path.join(state.diskCachePath, `${videoId}.cache`);
}

/**
 * Check if track exists in disk cache
 */
function hasDiskCache(videoId) {
  const cachePath = getDiskCachePath(videoId);
  return fs.existsSync(cachePath);
}

/**
 * Save stream to disk cache
 */
async function saveToDiskCache(videoId, streamUrl, metadata) {
  try {
    // Check if cache is full
    if (state.diskCacheStats.size >= state.diskCacheMaxSize) {
      await cleanupDiskCache();
    }
    
    const cachePath = getDiskCachePath(videoId);
    const cacheData = {
      videoId,
      streamUrl,
      metadata,
      cachedAt: Date.now()
    };
    
    fs.writeFileSync(cachePath, JSON.stringify(cacheData), "utf8");
    updateDiskCacheStats();
    
    logger.debug(`Saved to disk cache: ${videoId}`);
  } catch (err) {
    logger.warn(`Failed to save to disk cache ${videoId}:`, err.message);
  }
}

/**
 * Load stream from disk cache
 */
function loadFromDiskCache(videoId) {
  try {
    const cachePath = getDiskCachePath(videoId);
    
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    
    const data = fs.readFileSync(cachePath, "utf8");
    const cacheData = JSON.parse(data);
    
    // Check if cache is expired (24 hours)
    const age = Date.now() - cacheData.cachedAt;
    if (age > 1000 * 60 * 60 * 24) {
      fs.unlinkSync(cachePath);
      updateDiskCacheStats();
      return null;
    }
    
    logger.debug(`Loaded from disk cache: ${videoId}`);
    return cacheData;
  } catch (err) {
    logger.warn(`Failed to load from disk cache ${videoId}:`, err.message);
    return null;
  }
}

/**
 * Cleanup old disk cache files (LRU)
 */
async function cleanupDiskCache() {
  try {
    const files = fs.readdirSync(state.diskCachePath);
    const fileStats = [];
    
    for (const file of files) {
      const filePath = path.join(state.diskCachePath, file);
      const stats = fs.statSync(filePath);
      fileStats.push({
        path: filePath,
        atime: stats.atime.getTime(),
        size: stats.size
      });
    }
    
    // Sort by access time (oldest first)
    fileStats.sort((a, b) => a.atime - b.atime);
    
    // Remove oldest 20% of files
    const toRemove = Math.ceil(fileStats.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      fs.unlinkSync(fileStats[i].path);
    }
    
    updateDiskCacheStats();
    logger.info(`Cleaned up ${toRemove} old cache files`);
  } catch (err) {
    logger.warn("Failed to cleanup disk cache:", err.message);
  }
}

/**
 * Record bandwidth sample
 */
function recordBandwidth(bytes, durationMs) {
  if (durationMs <= 0) return;
  
  const speedMbps = (bytes * 8) / (durationMs * 1000);
  state.bandwidthMonitor.samples.push(speedMbps);
  
  if (state.bandwidthMonitor.samples.length > state.bandwidthMonitor.maxSamples) {
    state.bandwidthMonitor.samples.shift();
  }
  
  state.bandwidthMonitor.lastCheck = Date.now();
}

/**
 * Get average bandwidth
 */
function getAverageBandwidth() {
  const samples = state.bandwidthMonitor.samples;
  if (samples.length === 0) return 0;
  
  const sum = samples.reduce((a, b) => a + b, 0);
  return sum / samples.length;
}

/**
 * Get recommended quality based on bandwidth
 */
function getRecommendedQualityByBandwidth() {
  const avgSpeed = getAverageBandwidth();
  
  if (avgSpeed > 5) return "best";      // > 5 Mbps
  if (avgSpeed > 2) return "360p";      // > 2 Mbps
  return "audio-only";                   // < 2 Mbps
}

/**
 * Get cached audio stream (LRU + Disk)
 */
async function getCachedAudioStream(videoId, song) {
  // 1. Check LRU memory cache
  if (state.lruCache.has(videoId)) {
    logger.debug(`LRU cache hit: ${videoId}`);
    return state.lruCache.get(videoId);
  }
  
  // 2. Check disk cache
  const diskCache = loadFromDiskCache(videoId);
  if (diskCache) {
    logger.debug(`Disk cache hit: ${videoId}`);
    
    // Store in LRU for faster access next time
    state.lruCache.set(videoId, diskCache.streamUrl);
    
    return diskCache.streamUrl;
  }
  
  // 3. Fetch from YouTube
  const startTime = Date.now();
  const streamUrl = await getAudioStream(song);
  const duration = Date.now() - startTime;
  
  // Record bandwidth (estimate 5MB per track)
  recordBandwidth(5 * 1024 * 1024, duration);
  
  // 4. Save to caches
  state.lruCache.set(videoId, streamUrl);
  
  // Save to disk cache in background (don't await)
  void saveToDiskCache(videoId, streamUrl, {
    title: song.basic_info?.title,
    author: song.basic_info?.author
  });
  
  return streamUrl;
}

/**
 * Warm cache with upcoming tracks
 */
async function warmCache() {
  const toWarm = Math.min(5, state.playlist.length);
  
  for (let i = 0; i < toWarm; i++) {
    const item = state.playlist[i];
    if (!item?.video_id) continue;
    
    const videoId = item.video_id;
    
    // Skip if already cached
    if (state.lruCache.has(videoId) || hasDiskCache(videoId)) {
      continue;
    }
    
    try {
      const song = await getMusicTrack(videoId);
      if (song.playability_status?.status === "OK") {
        await getCachedAudioStream(videoId, song);
        logger.debug(`Cache warmed: ${videoId}`);
      }
    } catch (err) {
      logger.debug(`Failed to warm cache for ${videoId}:`, err.message);
    }
  }
}

// ============================================================================
// END PHASE 2
// ============================================================================

function getUptimeSeconds() {
  return Math.floor((Date.now() - state.startedAt) / 1000);
}

function getTrackTitle(track) {
  if (!track?.basic_info) {
    return "Starting stream...";
  }

  const author = track.basic_info.author || "Unknown Artist";
  const title = track.basic_info.title || "Unknown Title";
  return `${author} - ${title}`;
}

function normalizeMatchText(value) {
  return `${value || ""}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeMatchText(value))
    .filter(Boolean);
}

function parseDurationString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parts = value.trim().split(":").map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }

  return parts.reduce((total, part) => (total * 60) + part, 0);
}

function getCandidateText(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => getCandidateText(item))
      .filter(Boolean)
      .join(" ")
      .trim();
    return text || null;
  }

  if (typeof value === "object") {
    if (typeof value.text === "string" && value.text.trim()) {
      return value.text.trim();
    }

    if (Array.isArray(value.runs)) {
      const text = value.runs
        .map((run) => typeof run?.text === "string" ? run.text : "")
        .join("")
        .trim();
      return text || null;
    }

    if (typeof value.name === "string" && value.name.trim()) {
      return value.name.trim();
    }
  }

  return null;
}

function getQueueItemTitle(item) {
  return getCandidateText(item?.title) ||
    getCandidateText(item?.headline) ||
    getCandidateText(item?.playlist_item_data?.title) ||
    null;
}

function getQueueItemAuthor(item) {
  return getCandidateText(item?.author) ||
    getCandidateText(item?.artists) ||
    getCandidateText(item?.short_byline_text) ||
    getCandidateText(item?.long_byline_text) ||
    getCandidateText(item?.owner_text) ||
    null;
}

function getQueueItemDurationSeconds(item) {
  const numericCandidates = [
    item?.duration?.seconds,
    item?.duration_seconds,
    item?.length_seconds
  ];

  for (const value of numericCandidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }

  const textCandidates = [
    getCandidateText(item?.duration),
    getCandidateText(item?.length_text)
  ];

  for (const value of textCandidates) {
    const parsed = parseDurationString(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function getQueueItemFingerprint(item) {
  return {
    id: item?.video_id || null,
    title: getQueueItemTitle(item),
    author: getQueueItemAuthor(item),
    durationSeconds: getQueueItemDurationSeconds(item)
  };
}

function getPlaylistItemSummary(item) {
  if (!item) {
    return null;
  }

  const fingerprint = getQueueItemFingerprint(item);
  return {
    id: fingerprint.id,
    title: fingerprint.title,
    author: fingerprint.author
  };
}

function getCurrentTrackTitle() {
  return getTrackTitle(state.currentTrack);
}

function getNowPlayingPayload() {
  const current = state.currentTrack ? {
    id: state.currentTrack.basic_info.id,
    title: state.currentTrack.basic_info.title,
    author: state.currentTrack.basic_info.author,
    album: state.currentTrack.basic_info.album || null,
    url: `https://youtu.be/${state.currentTrack.basic_info.id}`,
    display: getCurrentTrackTitle()
  } : null;

  return {
    current,
    next: getPlaylistItemSummary(state.playlist[0]),
    playing: Boolean(state.currentTrack),
    preset: state.activePreset,
    profile: state.activeProfile,
    station_mode: state.activePresetConfig?.stationMode || "dynamic",
    current_seed_url: state.seedUrl || null,
    pending_preset_change: state.pendingPresetChange,
    updated_at: new Date().toISOString()
  };
}

function getStatsPayload() {
  return {
    uptime_seconds: getUptimeSeconds(),
    started_at: new Date(state.startedAt).toISOString(),
    playing: Boolean(state.currentTrack),
    current: getNowPlayingPayload().current,
    next: getPlaylistItemSummary(state.playlist[0]),
    queue_length: state.playlist.length,
    audio_listener_count: state.httpListeners.size,
    gopher_listener_count: state.gopherListeners.size,
    websocket_client_count: state.wsClients.size,
    track_cache_size: state.trackCache.size,
    consecutive_failures: state.consecutiveFailures,
    songs_started: state.stats.songsStarted,
    songs_completed: state.stats.songsCompleted,
    songs_skipped: state.stats.songsSkipped,
    retries_scheduled: state.stats.retriesScheduled,
    last_started_at: state.stats.lastStartedAt,
    last_error: state.stats.lastError,
    shutting_down: state.shuttingDown,
    yt_dlp_available: ytDlpAvailable,
    playback_backend_mode: config.playbackBackend,
    last_playback_backend: state.lastPlaybackBackend,
    last_playback_profile: state.lastPlaybackProfile,
    playback_client: config.playbackClient,
    playback_format: config.playbackFormatOptions,
    radio: config.radio,
    active_preset: state.activePreset,
    active_profile: state.activeProfile,
    station_mode: state.activePresetConfig?.stationMode || "dynamic",
    current_seed_url: state.seedUrl || null,
    seed_url_count: state.activePresetConfig?.seedUrls?.length || 1,
    tracks_since_anchor: state.tracksSinceAnchor,
    pending_preset_change: state.pendingPresetChange
  };
}

function getPresetSelectionPayload(selection) {
  if (!selection) {
    return null;
  }

  return {
    name: selection.name,
    label: selection.label,
    group: selection.group,
    profile: selection.profile,
    seed_url: selection.seedUrl,
    station_mode: selection.stationMode,
    seed_url_count: selection.seedUrls.length
  };
}

function normalizeStationRules(mode, rules) {
  const source = rules && typeof rules === "object" ? rules : {};
  const defaults = mode === "strict" ? DEFAULT_STRICT_RULES : {};

  return {
    refreshFromSeedEvery: Number.isFinite(Number(source.refreshFromSeedEvery))
      ? Math.max(1, Math.floor(Number(source.refreshFromSeedEvery)))
      : defaults.refreshFromSeedEvery || null,
    minDurationSec: Number.isFinite(Number(source.minDurationSec))
      ? Math.max(0, Math.floor(Number(source.minDurationSec)))
      : defaults.minDurationSec || null,
    maxDurationSec: Number.isFinite(Number(source.maxDurationSec))
      ? Math.max(0, Math.floor(Number(source.maxDurationSec)))
      : defaults.maxDurationSec || null,
    allowArtists: normalizeStringList(source.allowArtists || defaults.allowArtists),
    blockArtists: normalizeStringList(source.blockArtists || defaults.blockArtists),
    allowKeywords: normalizeStringList(source.allowKeywords || defaults.allowKeywords),
    blockKeywords: normalizeStringList(source.blockKeywords || defaults.blockKeywords),
    dedupeWindowSize: Number.isFinite(Number(source.dedupeWindowSize))
      ? Math.max(1, Math.floor(Number(source.dedupeWindowSize)))
      : defaults.dedupeWindowSize || 0
  };
}

function getPresetSeedUrls(preset, profilePreset) {
  const urls = [];

  const appendUrls = (values) => {
    if (!Array.isArray(values)) {
      return;
    }

    values.forEach((value) => {
      if (typeof value === "string" && value.trim()) {
        urls.push(value.trim());
      }
    });
  };

  appendUrls(profilePreset?.seedUrls);
  appendUrls(preset?.seedUrls);

  if (typeof profilePreset?.seedUrl === "string" && profilePreset.seedUrl.trim()) {
    urls.push(profilePreset.seedUrl.trim());
  }

  if (typeof preset?.seedUrl === "string" && preset.seedUrl.trim()) {
    urls.push(preset.seedUrl.trim());
  }

  if (urls.length < 2 && preset?.group) {
    const siblingPresets = runtimePresets.filter((item) => {
      return item?.name !== preset.name && item?.group === preset.group;
    });

    for (const sibling of siblingPresets) {
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

function createPresetRuntimeConfig(selection) {
  return {
    name: selection.name,
    label: selection.label,
    group: selection.group,
    profile: selection.profile,
    stationMode: selection.stationMode,
    seedUrls: [...selection.seedUrls],
    rules: selection.rules,
    nextSeedIndex: selection.nextSeedIndex || 0
  };
}

function pickSeedUrlForPreset(presetConfig, preferredSeedUrl = null) {
  if (!presetConfig?.seedUrls?.length) {
    return preferredSeedUrl || null;
  }

  if (preferredSeedUrl && presetConfig.seedUrls.includes(preferredSeedUrl)) {
    return preferredSeedUrl;
  }

  // Phase 4A: Use intelligent seed selection
  return pickBestSeed(presetConfig);
}

function resetStationRuntimeState() {
  state.tracksSinceAnchor = 0;
  state.recentTrackIds = [];
  state.recentArtists = [];
  state.genreDriftDetected = false;
}

function resolvePresetSelection(presetName, profileName) {
  if (!presetName || typeof presetName !== "string") {
    throw new Error("Preset name is required.");
  }

  const normalizedProfile = profileName === "hq" ? "hq" : "safe";
  const preset = runtimePresets.find((item) => item?.name === presetName);
  if (!preset) {
    throw new Error(`Unknown preset '${presetName}'.`);
  }

  const profilePreset = preset.profiles?.[normalizedProfile] || null;
  const seedUrls = getPresetSeedUrls(preset, profilePreset);
  if (!seedUrls.length) {
    throw new Error(`Preset '${presetName}' does not define a seed URL.`);
  }

  const stationMode = profilePreset?.stationMode ||
    preset.stationMode ||
    "dynamic";
  const rules = normalizeStationRules(
    stationMode,
    Object.assign({}, preset.rules || {}, profilePreset?.rules || {})
  );
  const seedUrl = seedUrls[0];

  return {
    name: preset.name,
    label: preset.label || preset.name,
    group: preset.group || "Other",
    profile: normalizedProfile,
    seedUrl,
    seedUrls,
    stationMode,
    rules,
    nextSeedIndex: seedUrls.length > 1 ? 1 : 0
  };
}

function queuePresetChange(presetName, profileName) {
  const selection = resolvePresetSelection(presetName, profileName || state.activeProfile || "safe");
  state.pendingPresetChange = selection;
  return selection;
}

function applyPendingPresetChange() {
  if (!state.pendingPresetChange) {
    return false;
  }

  const pending = state.pendingPresetChange;
  state.seedUrl = pending.seedUrl;
  state.activePreset = pending.name;
  state.activeProfile = pending.profile;
  state.activePresetConfig = createPresetRuntimeConfig(pending);
  state.pendingPresetChange = null;
  state.pendingReplay = null;
  state.currentPlayback = null;
  state.currentTrack = null;
  state.playlist = [];
  resetStationRuntimeState();
  writeSeedUrlValue(pending.seedUrl);
  logger.info(`Queued preset change applied: ${pending.group} > ${pending.label} > ${pending.profile}`);
  return true;
}

function hydrateActivePresetConfig() {
  if (!state.activePreset) {
    return;
  }

  try {
    const selection = resolvePresetSelection(state.activePreset, state.activeProfile || "safe");
    state.activePresetConfig = createPresetRuntimeConfig(selection);
    if (!state.seedUrl || !selection.seedUrls.includes(state.seedUrl)) {
      state.seedUrl = selection.seedUrl;
    }
  } catch (err) {
    logger.warn(`Failed to hydrate preset ${state.activePreset}:`, err.message);
  }
}

function isLoopbackAddress(address) {
  return address === "::1" ||
    address === "127.0.0.1" ||
    address === "::ffff:127.0.0.1";
}

function cleanupRuntimeStateFile() {
  const stateFile = process.env.YTRADIO_STATE_FILE;
  if (!stateFile) {
    return;
  }

  try {
    fs.unlinkSync(stateFile);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger.debug("Failed to remove runtime state file:", err.message);
    }
  }
}

function getHealthPayload() {
  return {
    ok: Boolean(state.client) && !state.shuttingDown,
    uptime_seconds: getUptimeSeconds(),
    client_ready: Boolean(state.client),
    playing: Boolean(state.currentTrack),
    shutting_down: state.shuttingDown,
    consecutive_failures: state.consecutiveFailures
  };
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Icy-MetaData");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  setCorsHeaders(res);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, payload) {
  res.statusCode = statusCode;
  setCorsHeaders(res);
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 64 * 1024) {
        reject(new Error("Request body too large."));
      }
    });

    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function trimTrackCache() {
  while (state.trackCache.size > config.trackCacheSize) {
    const oldestKey = state.trackCache.keys().next().value;
    state.trackCache.delete(oldestKey);
  }
}

function touchTrackCache(videoId) {
  if (!state.trackCache.has(videoId)) {
    return state.trackCache.get(videoId);
  }

  const entry = state.trackCache.get(videoId);
  state.trackCache.delete(videoId);
  state.trackCache.set(videoId, entry);
  return entry;
}

function getTrackCacheEntry(videoId) {
  if (!state.trackCache.has(videoId)) {
    state.trackCache.set(videoId, {
      musicInfoPromise: null,
      playbackInfoPromises: new Map()
    });
  }

  const entry = touchTrackCache(videoId);
  trimTrackCache();
  return entry;
}

function cacheTrackPromise(videoId, key, factory) {
  const entry = getTrackCacheEntry(videoId);
  if (!entry[key]) {
    const promise = Promise.resolve().then(factory);
    entry[key] = promise;
    promise.catch((err) => {
      if (entry[key] === promise) {
        entry[key] = null;
      }
      logger.warn(`Cached ${key} request failed for ${videoId}:`, err.message);
    });
  }

  return entry[key];
}

function getMusicTrack(videoId) {
  return cacheTrackPromise(videoId, "musicInfoPromise", () => state.client.music.getInfo(videoId));
}

function getPlaybackInfo(videoId, playbackClient) {
  const entry = getTrackCacheEntry(videoId);
  if (!entry.playbackInfoPromises.has(playbackClient)) {
    const promise = Promise.resolve().then(() => state.client.getBasicInfo(videoId, {
      client: playbackClient
    }));

    entry.playbackInfoPromises.set(playbackClient, promise);
    promise.catch((err) => {
      if (entry.playbackInfoPromises.get(playbackClient) === promise) {
        entry.playbackInfoPromises.delete(playbackClient);
      }
      logger.warn(`Cached playback info request failed for ${videoId} (${playbackClient}):`, err.message);
    });
  }

  return entry.playbackInfoPromises.get(playbackClient);
}

function getTrackDurationSeconds(track) {
  const candidates = [
    track?.basic_info?.duration_seconds,
    track?.basic_info?.duration,
    track?.basic_info?.length_seconds,
    track?.duration,
    track?.duration_seconds
  ];

  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }

  return null;
}

function rememberPlayedTrack(song) {
  const dedupeWindowSize = state.activePresetConfig?.rules?.dedupeWindowSize || 0;
  if (dedupeWindowSize < 1 || !song?.basic_info?.id) {
    return;
  }

  const trackId = song.basic_info.id;
  const artist = normalizeMatchText(song.basic_info.author);

  state.recentTrackIds.push(trackId);
  if (artist) {
    state.recentArtists.push(artist);
  }

  if (state.recentTrackIds.length > dedupeWindowSize) {
    state.recentTrackIds = state.recentTrackIds.slice(-dedupeWindowSize);
  }

  if (state.recentArtists.length > dedupeWindowSize) {
    state.recentArtists = state.recentArtists.slice(-dedupeWindowSize);
  }
}

function matchesTextRules(haystack, allowList, blockList) {
  const normalized = normalizeMatchText(haystack);

  if (blockList.length > 0 && blockList.some((entry) => normalized.includes(entry))) {
    return false;
  }

  if (allowList.length > 0) {
    return allowList.some((entry) => normalized.includes(entry));
  }

  return true;
}

function isQueueCandidateAllowed(item, queuedTrackIds, queuedArtists) {
  const presetConfig = state.activePresetConfig;
  if (!presetConfig || presetConfig.stationMode !== "strict") {
    return Boolean(item?.video_id);
  }

  const fingerprint = getQueueItemFingerprint(item);
  if (!fingerprint.id) {
    return false;
  }

  const rules = presetConfig.rules;
  const author = fingerprint.author || "";
  const title = fingerprint.title || "";
  const combinedText = `${author} ${title}`.trim();
  const durationSeconds = fingerprint.durationSeconds;

  if (rules.minDurationSec && durationSeconds !== null && durationSeconds < rules.minDurationSec) {
    return false;
  }

  if (rules.maxDurationSec && durationSeconds !== null && durationSeconds > rules.maxDurationSec) {
    return false;
  }

  if (!matchesTextRules(author, rules.allowArtists, rules.blockArtists)) {
    return false;
  }

  if (!matchesTextRules(combinedText, rules.allowKeywords, rules.blockKeywords)) {
    return false;
  }

  if (state.recentTrackIds.includes(fingerprint.id) || queuedTrackIds.has(fingerprint.id)) {
    return false;
  }

  const normalizedAuthor = normalizeMatchText(author);
  if (normalizedAuthor && (state.recentArtists.includes(normalizedAuthor) || queuedArtists.has(normalizedAuthor))) {
    return false;
  }

  return true;
}

function filterPlaylistCandidates(items) {
  const candidates = Array.isArray(items) ? items : [];
  if (!state.activePresetConfig || state.activePresetConfig.stationMode !== "strict") {
    return candidates.filter((item) => item?.video_id);
  }

  const accepted = [];
  const queuedTrackIds = new Set();
  const queuedArtists = new Set();

  for (const item of candidates) {
    if (!isQueueCandidateAllowed(item, queuedTrackIds, queuedArtists)) {
      continue;
    }

    accepted.push(item);
    const fingerprint = getQueueItemFingerprint(item);
    queuedTrackIds.add(fingerprint.id);

    const normalizedAuthor = normalizeMatchText(fingerprint.author);
    if (normalizedAuthor) {
      queuedArtists.add(normalizedAuthor);
    }
  }

  return accepted;
}

function shouldReanchorFromSeed() {
  const presetConfig = state.activePresetConfig;
  
  // Strict mode: use configured threshold
  if (presetConfig && presetConfig.stationMode === "strict") {
    const threshold = presetConfig.rules.refreshFromSeedEvery;
    if (!threshold) {
      return false;
    }
    return state.tracksSinceAnchor >= threshold;
  }

  // Phase 4A: Adaptive re-anchoring for dynamic mode
  // Re-anchor if exceeded dynamic threshold (default: 15 tracks)
  const dynamicThreshold = 15;
  if (state.tracksSinceAnchor >= dynamicThreshold) {
    logger.info(`Adaptive re-anchoring: exceeded threshold (${state.tracksSinceAnchor}/${dynamicThreshold} tracks)`);
    return true;
  }

  // Re-anchor if genre drift detected
  if (detectGenreDrift()) {
    logger.info("Adaptive re-anchoring: genre drift detected");
    state.genreDriftDetected = true;
    return true;
  }

  return false;
}

async function getSeedTrackForPreset(forceNextSeed = false) {
  const presetConfig = state.activePresetConfig;
  let seedConfig = state.seedUrl;

  if (presetConfig) {
    seedConfig = pickSeedUrlForPreset(presetConfig, forceNextSeed ? null : state.seedUrl);
  }

  if (!seedConfig) {
    throw new Error("No youtube URL provided.");
  }

  // Phase 4B: Support enhanced seed types
  let seedTrack;
  
  // Check if seedConfig is an enhanced seed object
  if (typeof seedConfig === "object" && seedConfig.type) {
    // Enhanced seed with type
    seedTrack = await getSeedTrackByType(seedConfig);
    state.seedUrl = seedConfig.url; // Store URL for tracking
  } else {
    // Legacy: simple URL string
    const seedId = getVideoID(seedConfig);
    if (!seedId) {
      throw new Error("Could not extract a YouTube video id from the configured URL.");
    }
    
    state.seedUrl = seedConfig;
    seedTrack = await getMusicTrack(seedId);
  }
  
  // Phase 4A: Save seed track for genre drift detection
  state.seedTrack = seedTrack;
  
  return seedTrack;
}

function getPlaybackProfiles() {
  const seen = new Set();
  
  // Adaptive quality selection
  const adaptiveQuality = getAdaptiveQuality();
  
  // Build profiles based on adaptive quality with multiple client rotation
  const profiles = [];
  
  if (adaptiveQuality === "best") {
    profiles.push(
      { backend: "native", client: "ANDROID", options: { type: "video+audio", format: "mp4", quality: "best" } },
      { backend: "native", client: "IOS", options: { type: "video+audio", format: "mp4", quality: "best" } },
      { backend: "native", client: "ANDROID", options: { type: "video+audio", format: "mp4", quality: "360p" } },
      { backend: "native", client: "WEB", options: { type: "video+audio", format: "mp4", quality: "360p" } },
      { backend: "native", client: "ANDROID", options: { type: "audio", format: "any", quality: "best" } },
      { backend: "native", client: "IOS", options: { type: "audio", format: "any", quality: "best" } }
    );
  } else if (adaptiveQuality === "360p") {
    profiles.push(
      { backend: "native", client: "ANDROID", options: { type: "video+audio", format: "mp4", quality: "360p" } },
      { backend: "native", client: "IOS", options: { type: "video+audio", format: "mp4", quality: "360p" } },
      { backend: "native", client: "WEB", options: { type: "video+audio", format: "mp4", quality: "360p" } },
      { backend: "native", client: "ANDROID", options: { type: "audio", format: "any", quality: "best" } },
      { backend: "native", client: "IOS", options: { type: "audio", format: "any", quality: "best" } },
      { backend: "native", client: "TVHTML5", options: { type: "audio", format: "any", quality: "best" } }
    );
  } else {
    // audio-only mode - try all client types for maximum reliability
    profiles.push(
      { backend: "native", client: "ANDROID", options: { type: "audio", format: "any", quality: "best" } },
      { backend: "native", client: "IOS", options: { type: "audio", format: "any", quality: "best" } },
      { backend: "native", client: "WEB", options: { type: "audio", format: "any", quality: "best" } },
      { backend: "native", client: "TVHTML5", options: { type: "audio", format: "any", quality: "best" } },
      { backend: "native", client: "ANDROID", options: { type: "video+audio", format: "mp4", quality: "360p" } }
    );
  }
  
  return profiles.filter((profile) => {
    const key = JSON.stringify(profile);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getAdaptiveQuality() {
  const adaptive = state.adaptiveQuality;
  
  // If too many failures, downgrade quality
  if (adaptive.failureCount >= 3) {
    if (adaptive.currentQuality === "best") {
      adaptive.currentQuality = "360p";
      logger.info("Adaptive quality: Downgraded to 360p due to failures");
    } else if (adaptive.currentQuality === "360p") {
      adaptive.currentQuality = "audio-only";
      logger.info("Adaptive quality: Downgraded to audio-only due to failures");
    }
    adaptive.failureCount = 0;
    adaptive.lastAdjustment = Date.now();
  }
  
  // If many successes and enough time passed, try upgrading
  if (adaptive.successCount >= 10 && Date.now() - adaptive.lastAdjustment > 300000) {
    if (adaptive.currentQuality === "audio-only") {
      adaptive.currentQuality = "360p";
      logger.info("Adaptive quality: Upgraded to 360p after sustained success");
    } else if (adaptive.currentQuality === "360p") {
      adaptive.currentQuality = "best";
      logger.info("Adaptive quality: Upgraded to best after sustained success");
    }
    adaptive.successCount = 0;
    adaptive.lastAdjustment = Date.now();
  }
  
  return adaptive.currentQuality;
}

function reportPlaybackSuccess() {
  state.adaptiveQuality.successCount++;
  state.adaptiveQuality.failureCount = Math.max(0, state.adaptiveQuality.failureCount - 1);
}

function reportPlaybackFailure() {
  state.adaptiveQuality.failureCount++;
  state.adaptiveQuality.successCount = 0;
}

function primeTrack(videoId) {
  if (!state.client || !videoId) {
    return;
  }

  void getMusicTrack(videoId).catch(() => {});
  void getPlaybackInfo(videoId, config.playbackClient).catch(() => {});
}

async function predownloadTrack(videoId) {
  if (!videoId || state.streamCache.has(videoId)) {
    return; // Already cached
  }

  try {
    const song = await getMusicTrack(videoId);
    if (song.playability_status?.status !== "OK") {
      return; // Skip unplayable tracks
    }

    const stream = await getAudioStream(song);
    
    // Cache the stream info with timestamp
    state.streamCache.set(videoId, {
      stream,
      song,
      cachedAt: Date.now()
    });
    
    logger.debug(`Pre-downloaded track: ${getTrackTitle(song)}`);
    
    // Clean old cache entries (older than 10 minutes)
    const now = Date.now();
    for (const [id, cached] of state.streamCache.entries()) {
      if (now - cached.cachedAt > 600000) {
        state.streamCache.delete(id);
      }
    }
  } catch (err) {
    logger.debug(`Failed to pre-download ${videoId}:`, err.message);
  }
}

function prefetchQueuedTracks() {
  const prefetchedIds = [];
  for (const item of state.playlist) {
    if (item?.video_id) {
      prefetchedIds.push(item.video_id);
    }

    if (prefetchedIds.length >= config.prefetchCount) {
      break;
    }
  }

  prefetchedIds.forEach((videoId) => primeTrack(videoId));
  
  // Pre-download next 2-3 tracks in background
  const predownloadCount = Math.min(3, prefetchedIds.length);
  for (let i = 0; i < predownloadCount; i++) {
    if (prefetchedIds[i]) {
      void predownloadTrack(prefetchedIds[i]);
    }
  }
}

async function populatePlaylistFromTrack(track, options = {}) {
  const upNext = await track.getUpNext();
  const rawItems = Array.isArray(upNext.contents) ? upNext.contents : [];
  const filteredItems = filterPlaylistCandidates(rawItems);
  const fallbackItems = rawItems.filter((item) => item?.video_id);

  if (options.logContext && state.activePresetConfig?.stationMode === "strict") {
    logger.debug(`Strict filter kept ${filteredItems.length}/${rawItems.length} queue candidates (${options.logContext}).`);
  }

  if (state.activePresetConfig?.stationMode === "strict" && filteredItems.length === 0 && fallbackItems.length > 0) {
    logger.warn(`Strict filtering produced an empty queue for ${options.logContext || "playlist"}. Falling back to unfiltered playable candidates.`);
    state.playlist = fallbackItems;
  } else {
    state.playlist = filteredItems;
  }

  // Phase 4A: Track seed performance when populating from seed
  if (options.logContext && options.logContext.includes("seed") && state.seedUrl) {
    trackSeedPerformance(state.seedUrl, {
      playlistSize: state.playlist.length,
      successful: 0, // Will be updated as tracks play
      skipped: 0
    });
  }

  prefetchQueuedTracks();
}

async function ensureQueueAvailable(options = {}) {
  if (state.playlist.length > 0) {
    return;
  }

  // Check if we're using custom-queue preset
  if (state.activePreset === "custom-queue") {
    await populatePlaylistFromCustomQueue();
    return;
  }

  if (!state.seedUrl) {
    throw new Error("No youtube URL provided.");
  }

  if (!state.currentTrack || options.forceSeed) {
    const seedTrack = await getSeedTrackForPreset(Boolean(options.forceNextSeed));
    await populatePlaylistFromTrack(seedTrack, {
      logContext: options.forceSeed ? "seed-refresh" : "seed-initial"
    });
    if (options.forceSeed) {
      state.tracksSinceAnchor = 0;
    }
    return;
  }

  // Phase 4B: Check if preset uses hybrid propagation
  const useHybrid = state.activePresetConfig?.propagation?.strategy === "hybrid";
  const seedRatio = state.activePresetConfig?.propagation?.seedRatio || 0.3;

  if (useHybrid && state.seedTrack) {
    // Use hybrid propagation
    await populatePlaylistHybrid(seedRatio);
  } else {
    // Normal propagation from current track
    await populatePlaylistFromTrack(state.currentTrack, {
      logContext: "current-track"
    });
  }

  if (state.playlist.length === 0 && state.activePresetConfig?.stationMode === "strict") {
    const seedTrack = await getSeedTrackForPreset(true);
    await populatePlaylistFromTrack(seedTrack, {
      logContext: "seed-fallback"
    });
    state.tracksSinceAnchor = 0;
  }
}

async function populatePlaylistFromCustomQueue() {
  try {
    const customQueuePath = path.join(__dirname, "backend", "db", "custom-queue.json");
    let customQueue = [];
    
    if (fs.existsSync(customQueuePath)) {
      const data = fs.readFileSync(customQueuePath, "utf8").trim();
      if (data) {
        customQueue = JSON.parse(data);
      }
    }
    
    if (!Array.isArray(customQueue) || customQueue.length === 0) {
      logger.warn("Custom queue is empty. Add videos/playlists in the backend.");
      // Fallback to seed URL if custom queue is empty
      if (state.seedUrl) {
        const seedTrack = await getSeedTrackForPreset();
        await populatePlaylistFromTrack(seedTrack, { logContext: "custom-queue-fallback" });
      }
      return;
    }
    
    logger.info(`Loading custom queue with ${customQueue.length} items`);
    
    // Process each item in custom queue
    for (const item of customQueue) {
      try {
        const url = item.url;
        
        if (item.type === "playlist") {
          // Extract playlist ID and get videos from it
          const playlistMatch = url.match(/[?&]list=([^&]+)/);
          if (playlistMatch) {
            const playlistId = playlistMatch[1];
            logger.info(`Loading playlist: ${playlistId}`);
            
            try {
              // Use YouTube client to get playlist
              const playlist = await state.client.getPlaylist(playlistId);
              
              // Get all videos from the playlist
              let videos = [];
              try {
                // Try to get videos - different methods depending on API version
                if (typeof playlist.getVideos === "function") {
                  videos = await playlist.getVideos();
                } else if (playlist.videos) {
                  videos = playlist.videos;
                } else if (playlist.items) {
                  videos = playlist.items;
                }
              } catch (videoErr) {
                logger.warn(`Error getting videos from playlist ${playlistId}:`, videoErr.message);
              }
              
              // Process videos
              if (Array.isArray(videos) && videos.length > 0) {
                let addedCount = 0;
                for (const video of videos) {
                  try {
                    // Extract video ID from different possible structures
                    let videoId = null;
                    if (video.id) {
                      videoId = video.id;
                    } else if (video.video_id) {
                      videoId = video.video_id;
                    } else if (video.key?.videoId) {
                      videoId = video.key.videoId;
                    }
                    
                    if (videoId) {
                      state.playlist.push({
                        video_id: videoId,
                        title: video.title?.text || video.title || "Unknown",
                        author: video.author?.name || video.author || "Unknown"
                      });
                      addedCount++;
                    }
                  } catch (videoProcessErr) {
                    logger.debug(`Skipped video in playlist: ${videoProcessErr.message}`);
                  }
                }
                logger.info(`Added ${addedCount} videos from playlist ${playlistId}`);
              } else {
                logger.warn(`Playlist ${playlistId} has no videos or couldn't be loaded`);
              }
            } catch (err) {
              logger.warn(`Failed to load playlist ${playlistId}:`, err.message);
            }
          } else {
            logger.warn(`Could not extract playlist ID from URL: ${url}`);
          }
        } else {
          // Single video
          const videoId = getVideoID(url);
          if (videoId) {
            try {
              const track = await getMusicTrack(videoId);
              if (track?.basic_info) {
                state.playlist.push({
                  video_id: videoId,
                  title: track.basic_info.title || "Unknown",
                  author: track.basic_info.author || "Unknown"
                });
                logger.info(`Added video: ${track.basic_info.title}`);
              }
            } catch (err) {
              logger.warn(`Failed to load video ${videoId}:`, err.message);
            }
          }
        }
      } catch (err) {
        logger.warn(`Failed to process custom queue item:`, err.message);
      }
    }
    
    logger.info(`Custom queue loaded: ${state.playlist.length} tracks ready`);
    
    if (state.playlist.length === 0) {
      logger.warn("No tracks were loaded from custom queue. Falling back to seed URL.");
      if (state.seedUrl) {
        const seedTrack = await getSeedTrackForPreset();
        await populatePlaylistFromTrack(seedTrack, { logContext: "custom-queue-empty-fallback" });
      }
      return;
    }
    
    // Shuffle the playlist for variety
    if (state.playlist.length > 1) {
      for (let i = state.playlist.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.playlist[i], state.playlist[j]] = [state.playlist[j], state.playlist[i]];
      }
      logger.info("Custom queue shuffled");
    }
    
    prefetchQueuedTracks();
  } catch (err) {
    logger.error("Failed to populate playlist from custom queue:", err.message);
    // Fallback to seed URL
    if (state.seedUrl) {
      const seedTrack = await getSeedTrackForPreset();
      await populatePlaylistFromTrack(seedTrack, { logContext: "custom-queue-error-fallback" });
    }
  }
}

function dequeuePlayableQueueItem() {
  while (state.playlist.length > 0) {
    const item = state.playlist.shift();
    if (item?.video_id) {
      return item;
    }
  }

  return null;
}

function appendQueryParam(rawUrl, key, value) {
  const parsed = new URL(rawUrl);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

async function getNativeAudioSource(song, profile) {
  const playbackInfo = await getPlaybackInfo(song.basic_info.id, profile.client);
  const format = playbackInfo.chooseFormat(profile.options);
  const url = await format.decipher(playbackInfo.actions.session.player);
  state.lastPlaybackBackend = profile.backend;
  state.lastPlaybackProfile = profile;
  return appendQueryParam(url, "cpn", playbackInfo.cpn);
}

async function resolveYtDlpDirectUrl(song) {
  if (!ytDlpAvailable) {
    throw new Error("yt-dlp is not available on PATH.");
  }

  const videoUrl = `https://youtu.be/${song.basic_info.id}`;
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, [
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      "--no-progress",
      "-f",
      config.ytDlpFormat,
      "-g",
      videoUrl
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 16000) {
        stdout = stdout.slice(-16000);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const suffix = stderr.trim() ? ` ${stderr.trim()}` : "";
        reject(new Error(`yt-dlp exited with code ${code}.${suffix}`));
        return;
      }

      const resolvedUrl = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0];

      if (!resolvedUrl) {
        reject(new Error("yt-dlp did not return a playable media URL."));
        return;
      }

      resolve(resolvedUrl);
    });
  });
}

async function getYtDlpAudioSource(song) {
  state.lastPlaybackBackend = "yt-dlp";
  state.lastPlaybackProfile = {
    backend: "yt-dlp",
    format: config.ytDlpFormat
  };

  return resolveYtDlpDirectUrl(song);
}

async function getAudioStream(song, options = {}) {
  const errors = [];
  const forcedBackend = options.forceBackend || null;
  const allowNative = forcedBackend ? forcedBackend === "native" : (
    config.playbackBackend === "auto" || config.playbackBackend === "native"
  );
  const allowYtDlp = forcedBackend ? forcedBackend === "yt-dlp" : (
    config.playbackBackend === "auto" || config.playbackBackend === "yt-dlp"
  );

  if (allowNative) {
    for (const profile of getPlaybackProfiles()) {
      try {
        return await getNativeAudioSource(song, profile);
      } catch (err) {
        errors.push({
          backend: "native",
          profile,
          error: err
        });
        logger.warn(`Native playback profile failed for ${song.basic_info.id}:`, JSON.stringify(profile), err.message);
      }
    }
  }

  if (allowYtDlp) {
    try {
      return await getYtDlpAudioSource(song);
    } catch (err) {
      errors.push({
        backend: "yt-dlp",
        profile: { format: config.ytDlpFormat },
        error: err
      });
      logger.warn(`yt-dlp playback fallback failed for ${song.basic_info.id}:`, err.message);
    }
  }

  const errorSummary = errors.map((entry) => {
    return `${entry.backend}:${JSON.stringify(entry.profile)} => ${entry.error.message}`;
  }).join(" | ");
  throw new Error(`All playback backends failed for ${song.basic_info.id}. ${errorSummary}`);
}

function getRetryDelay(err) {
  const status = getStatusFromError(err);
  if (status === 403 || status === 410) {
    return config.retry.mediaForbiddenDelayMs;
  }

  if (status === 429) {
    return config.retry.rateLimitDelayMs;
  }

  if (status && status >= 500) {
    return config.retry.serverErrorDelayMs;
  }

  return Math.min(
    config.retry.maxDelayMs,
    config.retry.baseDelayMs * Math.max(1, state.consecutiveFailures)
  );
}

function isBenignRadioStreamError(err) {
  const topCode = err?.code || null;
  const causeCode = err?.cause?.code || null;
  const message = typeof err?.message === "string" ? err.message : "";

  if (topCode === "EPIPE" || topCode === "ECONNRESET") {
    return true;
  }

  if (causeCode === "UND_ERR_SOCKET" || causeCode === "UND_ERR_ABORTED") {
    return true;
  }

  if (message === "terminated" || message.includes("fetch failed")) {
    return causeCode === "UND_ERR_SOCKET" || causeCode === "UND_ERR_ABORTED";
  }

  return false;
}

function getCurrentTrackElapsedMs() {
  if (!state.currentPlayback?.startedAt) {
    return null;
  }

  return Math.max(0, Date.now() - state.currentPlayback.startedAt);
}

function buildReplayRequest(err) {
  if (!state.currentTrack || !state.currentPlayback) {
    return null;
  }

  if (config.interruptionReplay.maxAttempts < 1) {
    return null;
  }

  const attempts = state.currentPlayback.attempts || 0;
  if (attempts >= config.interruptionReplay.maxAttempts) {
    return null;
  }

  const elapsedMs = getCurrentTrackElapsedMs();
  if (elapsedMs !== null && elapsedMs > config.interruptionReplay.maxElapsedMs) {
    return null;
  }

  let forceBackend = null;
  if (state.lastPlaybackBackend === "yt-dlp") {
    forceBackend = "yt-dlp";
  } else if (state.lastPlaybackBackend === "native" && ytDlpAvailable) {
    forceBackend = "yt-dlp";
  }

  return {
    videoId: state.currentTrack.basic_info.id,
    attempts: attempts + 1,
    forceBackend,
    elapsedMs,
    error: serializeError(err)
  };
}

function queueNextTrack(reason, options = {}) {
  if (state.shuttingDown || state.nextTrackQueued) {
    return;
  }

  const countCompletion = options.countCompletion !== false;
  state.nextTrackQueued = true;

  if (countCompletion && state.currentTrack) {
    state.stats.songsCompleted += 1;
  }

  logger.debug(`Queueing next track (${reason})`);

  setImmediate(() => {
    state.nextTrackQueued = false;
    if (!state.shuttingDown) {
      void play();
    }
  });
}

function schedulePlayback(delayMs) {
  if (state.shuttingDown) {
    return;
  }

  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
  }

  state.stats.retriesScheduled += 1;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    void play();
  }, delayMs);
}

function createIcyMetadataBlock() {
  const safeTitle = getCurrentTrackTitle()
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
  const payload = Buffer.from(`StreamTitle='${safeTitle}';`, "utf8");
  const maxPayloadBytes = 255 * 16;
  const limitedPayload = payload.subarray(0, maxPayloadBytes);
  const blockCount = Math.ceil(limitedPayload.length / 16);
  const block = Buffer.alloc(1 + blockCount * 16);

  block[0] = blockCount;
  limitedPayload.copy(block, 1);

  return block;
}

class IcyMetadataStream extends Transform {
  constructor(metaInt) {
    super();
    this.metaInt = metaInt;
    this.remaining = metaInt;
  }

  _transform(chunk, _encoding, callback) {
    let offset = 0;

    while (offset < chunk.length) {
      const chunkSize = Math.min(this.remaining, chunk.length - offset);
      this.push(chunk.subarray(offset, offset + chunkSize));
      offset += chunkSize;
      this.remaining -= chunkSize;

      if (this.remaining === 0) {
        this.push(createIcyMetadataBlock());
        this.remaining = this.metaInt;
      }
    }

    callback();
  }
}

function handleApiRequest(req, res, pathname) {
  const apiPaths = new Set(["/health", "/stats", "/now-playing", "/now-playing.txt", "/reload-presets", "/queue", "/skip", "/cache-stats", "/proxy-stats", "/proxy-refresh", "/seed-stats", "/seed-pool", "/seed-pool-refresh"]);
  if (!apiPaths.has(pathname)) {
    return false;
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(res);
    return res.end();
  }

  // Phase 4A: Seed Performance Stats
  if (pathname === "/seed-stats") {
    const stats = getSeedPerformanceStats();
    sendJson(res, 200, {
      seeds: stats,
      currentSeed: state.seedUrl ? state.seedUrl.substring(0, 60) + "..." : null,
      tracksSinceAnchor: state.tracksSinceAnchor,
      genreDriftDetected: state.genreDriftDetected,
      seedTrackGenre: state.seedTrack ? extractGenreKeywords(state.seedTrack) : [],
      currentTrackGenre: state.currentTrack ? extractGenreKeywords(state.currentTrack) : []
    });
    return true;
  }

  // Phase 4C: Seed Pool Stats
  if (pathname === "/seed-pool") {
    const stats = getSeedPoolStats();
    sendJson(res, 200, stats);
    return true;
  }

  // Phase 4C: Seed Pool Refresh
  if (pathname === "/seed-pool-refresh") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    
    // Trigger refresh asynchronously
    refreshSeedsFromExternalSources()
      .then(count => {
        logger.info(`Manual seed pool refresh completed: ${count} new seeds`);
      })
      .catch(err => {
        logger.error(`Manual seed pool refresh failed: ${err.message}`);
      });
    
    sendJson(res, 200, { ok: true, message: "Seed pool refresh started" });
    return true;
  }

  // Phase 3: Proxy Stats
  if (pathname === "/proxy-stats") {
    const stats = proxyManager.getStats();
    sendJson(res, 200, stats);
    return true;
  }

  // Phase 3: Proxy Refresh
  if (pathname === "/proxy-refresh") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    
    if (!proxyManager.config.enabled) {
      sendJson(res, 400, { ok: false, error: "Proxy manager is disabled" });
      return true;
    }
    
    // Trigger refresh in background
    void proxyManager.refresh().then(() => {
      logger.info("Proxy refresh completed");
    });
    
    sendJson(res, 202, { ok: true, message: "Proxy refresh started" });
    return true;
  }

  // Phase 2: Cache and Bandwidth Stats
  if (pathname === "/cache-stats") {
    const avgBandwidth = getAverageBandwidth();
    const recommendedQuality = getRecommendedQualityByBandwidth();
    
    sendJson(res, 200, {
      lruCache: {
        size: state.lruCache.size,
        max: state.lruCache.max,
        hitRate: state.lruCache.size > 0 ? "N/A" : "0%"
      },
      diskCache: {
        files: state.diskCacheStats.files,
        sizeMB: Math.round(state.diskCacheStats.size / 1024 / 1024 * 100) / 100,
        maxSizeMB: Math.round(state.diskCacheMaxSize / 1024 / 1024),
        path: state.diskCachePath
      },
      bandwidth: {
        averageMbps: Math.round(avgBandwidth * 100) / 100,
        samples: state.bandwidthMonitor.samples.length,
        recommendedQuality,
        lastCheck: new Date(state.bandwidthMonitor.lastCheck).toISOString()
      },
      adaptiveQuality: {
        current: state.adaptiveQuality.currentQuality,
        successCount: state.adaptiveQuality.successCount,
        failureCount: state.adaptiveQuality.failureCount
      }
    });
    return true;
  }

  if (pathname === "/reload-presets") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    runtimePresets.length = 0;
    runtimePresets.push(...loadRuntimePresets());
    hydrateActivePresetConfig();
    sendJson(res, 200, { ok: true, count: runtimePresets.length });
    return true;
  }

  if (pathname === "/skip") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    
    if (!state.currentPlayback) {
      sendJson(res, 400, { ok: false, error: "No track is currently playing" });
      return true;
    }
    
    try {
      const currentTitle = getCurrentTrackTitle();
      logger.info(`Skipping track: ${currentTitle}`);
      
      // Terminate current playback
      if (state.currentPlayback && typeof state.currentPlayback.destroy === "function") {
        state.currentPlayback.destroy();
      }
      
      // Update stats
      state.stats.songsSkipped += 1;
      
      // Clear current track to trigger next track
      state.currentPlayback = null;
      
      sendJson(res, 200, { 
        ok: true, 
        message: "Track skipped",
        skipped: currentTitle,
        queueLength: state.playlist.length
      });
      
      // Trigger next track immediately
      setImmediate(() => {
        if (!state.playInProgress) {
          void play();
        }
      });
    } catch (err) {
      logger.error("Failed to skip track:", err.message);
      sendJson(res, 500, { ok: false, error: "Failed to skip track", details: err.message });
    }
    
    return true;
  }

  if (pathname === "/queue") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    
    readJsonBody(req)
      .then(async (body) => {
        const { videoId } = body;
        
        if (!videoId || typeof videoId !== "string") {
          sendJson(res, 400, { ok: false, error: "videoId is required" });
          return;
        }
        
        try {
          // Get track info and add to playlist
          const track = await getMusicTrack(videoId);
          
          if (!track || !track.basic_info) {
            sendJson(res, 404, { ok: false, error: "Track not found" });
            return;
          }
          
          // Create a queue item from the track
          const queueItem = {
            video_id: videoId,
            title: track.basic_info.title,
            author: track.basic_info.author
          };
          
          // Add to the front of the playlist
          state.playlist.unshift(queueItem);
          
          logger.info(`Track added to queue: ${track.basic_info.author} - ${track.basic_info.title}`);
          
          sendJson(res, 200, { 
            ok: true, 
            message: "Track added to queue",
            track: {
              id: videoId,
              title: track.basic_info.title,
              author: track.basic_info.author
            },
            queuePosition: 0,
            queueLength: state.playlist.length
          });
        } catch (err) {
          logger.error("Failed to add track to queue:", err.message);
          sendJson(res, 500, { ok: false, error: "Failed to add track to queue", details: err.message });
        }
      })
      .catch((err) => {
        sendJson(res, 400, { ok: false, error: err.message });
      });
    
    return true;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (pathname === "/health") {
    sendJson(res, state.client && !state.shuttingDown ? 200 : 503, getHealthPayload());
    return true;
  }

  if (pathname === "/stats") {
    sendJson(res, 200, getStatsPayload());
    return true;
  }

  if (pathname === "/now-playing") {
    sendJson(res, 200, getNowPlayingPayload());
    return true;
  }

  sendText(res, 200, `${getCurrentTrackTitle()}\n`);
  return true;
}

function handleShutdownRequest(req, res, pathname) {
  if (pathname !== "/shutdown") {
    return false;
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(res);
    return res.end();
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: "Shutdown is only allowed from localhost." });
    return true;
  }

  sendJson(res, 202, { ok: true, shutting_down: true });
  setImmediate(() => {
    void shutdown("http-shutdown", 0);
  });
  return true;
}

async function handlePresetRequest(req, res, pathname) {
  if (pathname !== "/preset") {
    return false;
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    setCorsHeaders(res);
    res.end();
    return true;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    sendJson(res, 200, {
      active_preset: state.activePreset,
      active_profile: state.activeProfile,
      pending_preset_change: getPresetSelectionPayload(state.pendingPresetChange),
      available_presets: runtimePresets.map((item) => ({
        name: item.name,
        group: item.group || "Other",
        label: item.label || item.name,
        station_mode: item.stationMode || "dynamic",
        seed_url_count: Array.isArray(item.seedUrls) && item.seedUrls.length > 0 ? item.seedUrls.length : 1
      }))
    });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: "Preset change is only allowed from localhost." });
    return true;
  }

  try {
    const body = await readJsonBody(req);
    const selection = queuePresetChange(body.preset, body.profile);
    sendJson(res, 202, {
      ok: true,
      applied_on: "next_song",
      pending_preset_change: getPresetSelectionPayload(selection)
    });
  } catch (err) {
    sendJson(res, 400, {
      ok: false,
      error: err.message || "Could not queue preset change."
    });
  }

  return true;
}

function registerListener(store, writable, connect) {
  const id = nextConnectionId();
  store.set(id, {
    connectedAt: new Date().toISOString()
  });

  return once(() => {
    store.delete(id);
    connect();
    if (typeof writable.destroy === "function" && !writable.destroyed) {
      writable.destroy();
    }
  });
}

const repeater = createRepeater(radio);
const gopherServer = gopher();

gopherServer.on("request", (soc) => {
  if (!soc.url || soc.url === "/") {
    soc.send(`!ytradio server
i\t${os.hostname()}\t${config.gopherPort}
iWelcome to this ytradio livestream server.\t${os.hostname()}\t${config.gopherPort}
sStream here (Or /9/stream)\t/stream\t${os.hostname()}\t${config.gopherPort}
i\t${os.hostname()}\t${config.gopherPort}
iNow Playing: ${getCurrentTrackTitle()}\t${os.hostname()}\t${config.gopherPort}
hThis livestream runs on ytradio project.\tURL:https://github.com/Yonle/ytradio\t${os.hostname()}\t${config.gopherPort}
`);
    return;
  }

  if (soc.url === "/stream") {
    const conn = repeater(soc);
    const cleanup = registerListener(state.gopherListeners, soc, conn);
    soc.on("error", cleanup);
    soc.on("close", cleanup);
  }
});

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname;

  if (handleShutdownRequest(req, res, pathname)) {
    return;
  }

  if (await handlePresetRequest(req, res, pathname)) {
    return;
  }

  if (handleApiRequest(req, res, pathname)) {
    return;
  }

  if (pathname !== "/" && pathname !== "/stream") {
    res.statusCode = 404;
    return res.end("Not found");
  }

  res.setHeader("content-type", getContentType());
  res.setHeader("cache-control", "no-cache, no-store, must-revalidate");

  const wantsIcyMetadata = req.headers["icy-metadata"] === "1";
  if (wantsIcyMetadata) {
    res.setHeader("icy-name", "ytradio");
    res.setHeader("icy-description", "YouTube radio stream");
    res.setHeader("icy-br", String(config.radio.bitrate));
    res.setHeader("icy-metaint", String(config.icyMetaInt));
  }

  if (req.method === "HEAD") {
    return res.end();
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  if (wantsIcyMetadata) {
    const icyStream = new IcyMetadataStream(config.icyMetaInt);
    const conn = repeater(icyStream);
    const cleanup = registerListener(state.httpListeners, icyStream, conn);
    icyStream.pipe(res);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    icyStream.on("error", cleanup);
    return;
  }

  const conn = repeater(res);
  const cleanup = registerListener(state.httpListeners, res, conn);
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
});

const wss = new WebSocket({ server });

wss.on("connection", (ws, req) => {
  const id = nextConnectionId();
  state.wsClients.set(id, ws);
  if (state.currentTrack) {
    ws.send(getCurrentTrackTitle());
  }

  const cleanup = once(() => {
    state.wsClients.delete(id);
  });

  req.on("close", cleanup);
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

wss.on("error", (err) => {
  logger.error("WebSocket server error:", err);
});

function broadcastNowPlaying() {
  const message = getCurrentTrackTitle();
  logger.info("-- Now Playing:", message);
  state.wsClients.forEach((ws, id) => {
    if (ws.readyState !== 1) {
      state.wsClients.delete(id);
      return;
    }

    ws.send(message, (err) => {
      if (err) {
        state.wsClients.delete(id);
      }
    });
  });
}

function handleListenError(name, port, err) {
  if (err && err.code === "EADDRINUSE") {
    logger.error(`${name} port ${port} is already in use.`);
    logger.error(`PowerShell example: $env:${name === "HTTP" ? "PORT" : "GOPHER_PORT"}=${port + 1000}; npm start`);
  } else {
    logger.error(`${name} server error:`, err);
  }

  void shutdown(`listen-error:${name}`, 1);
}

server.on("error", (err) => handleListenError("HTTP", config.httpPort, err));
server.on("clientError", (err, socket) => {
  logger.warn("HTTP client error:", err.message);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
gopherServer.on("error", (err) => handleListenError("Gopher", config.gopherPort, err));

function stopRadioProcess() {
  radio.stop();
}

function closeServer(target, name) {
  return new Promise((resolve) => {
    if (!target || typeof target.close !== "function") {
      return resolve();
    }

    target.close((err) => {
      if (err) {
        logger.warn(`Failed to close ${name}:`, err.message);
      }
      resolve();
    });
  });
}

async function shutdown(reason, exitCode = 0) {
  if (state.shuttingDown) {
    return;
  }

  state.shuttingDown = true;
  logger.info(`Shutting down (${reason})...`);

  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  state.wsClients.forEach((ws) => {
    try {
      ws.close();
    } catch (err) {
      logger.debug("Failed to close websocket client:", err.message);
    }
  });

  stopRadioProcess();
  radio.shutdown();
  
  // Phase 3: Shutdown proxy manager
  proxyManager.shutdown();

  await Promise.all([
    closeServer(wss, "websocket server"),
    closeServer(server, "http server"),
    closeServer(gopherServer, "gopher server")
  ]);

  cleanupRuntimeStateFile();
  process.exit(exitCode);
}

async function launch() {
  hydrateActivePresetConfig();

  // Phase 4: Auto-select first preset if no seed URL is provided (fresh install)
  if (!state.seedUrl || state.seedUrl.length < 1) {
    logger.warn("No seed URL found. Attempting to auto-select first preset...");
    
    // Try to load presets and select the first one
    const presets = loadRuntimePresets();
    if (presets && presets.length > 0) {
      const firstPreset = presets[0];
      logger.info(`Auto-selecting first preset: ${firstPreset.name} (${firstPreset.label})`);
      
      // Apply the first preset
      state.pendingPresetChange = {
        name: firstPreset.name,
        profile: "safe"  // Use safe profile by default
      };
      
      applyPendingPresetChange();
      
      if (!state.seedUrl) {
        logger.error("Failed to auto-select preset. No seed URL available. Aborting.");
        return process.exit(1);
      }
    } else {
      logger.error("No youtube URL provided and no presets available. Aborting.");
      logger.error("Please either:");
      logger.error("  1. Create a yturl.txt file with a YouTube URL");
      logger.error("  2. Add presets to radio-presets.json");
      logger.error("  3. Use the backend UI to select a preset");
      return process.exit(1);
    }
  }

  // Phase 2: Initialize disk cache
  initDiskCache();
  logger.info("Disk cache initialized:", state.diskCachePath);
  logger.info("Cache stats:", `${state.diskCacheStats.files} files, ${Math.round(state.diskCacheStats.size / 1024 / 1024)}MB`);

  // Phase 4C: Schedule seed pool refresh
  scheduleSeedPoolRefresh();

  logger.info("Radio is now listening on port", config.httpPort);
  logger.info("Gopher server is now listening on port", config.gopherPort);
  logger.info("Radio output bitrate is set to", config.radio.bitrate, "kbps");
  logger.info("Playback mode is", config.playbackBackend);
  logger.info("Playback client is", config.playbackClient);
  logger.info("yt-dlp available:", ytDlpAvailable);
  logger.info("ICY metadata interval is set to", config.icyMetaInt, "bytes");

  await play();
}

async function play() {
  if (state.shuttingDown || state.playInProgress) {
    return;
  }

  state.playInProgress = true;
  let retryDelay = null;

  try {
    applyPendingPresetChange();

    let replayRequest = state.pendingReplay;
    if (replayRequest) {
      state.pendingReplay = null;
      if (!state.currentTrack || state.currentTrack.basic_info?.id !== replayRequest.videoId) {
        logger.warn(`Discarding stale replay request for ${replayRequest.videoId}.`);
        replayRequest = null;
      }
    }

    if (!replayRequest && shouldReanchorFromSeed()) {
      state.playlist = [];
      await ensureQueueAvailable({
        forceSeed: true,
        forceNextSeed: true
      });
    } else if (!replayRequest) {
      await ensureQueueAvailable();
    }

    const queueItem = replayRequest || dequeuePlayableQueueItem();
    if (!queueItem) {
      throw new Error("Playlist is empty and no playable item was found.");
    }

    const videoId = queueItem.videoId || queueItem.video_id;
    let song, stream;
    
    // Phase 2: Check intelligent cache (LRU + Disk) first
    const cachedStream = await getCachedAudioStream(videoId, null).catch(() => null);
    
    // Check if we have a pre-downloaded stream in Phase 1 cache
    const cached = state.streamCache.get(videoId);
    if (cached && !replayRequest) {
      logger.info(`Using pre-downloaded stream for: ${getTrackTitle(cached.song)}`);
      song = cached.song;
      stream = cached.stream;
      state.streamCache.delete(videoId); // Remove from cache after use
    } else if (cachedStream && !replayRequest) {
      // Phase 2: Use intelligent cache
      song = await getMusicTrack(videoId);
      if (song.playability_status?.status !== "OK") {
        state.stats.songsSkipped += 1;
        logger.warn(`Skipping "${song.basic_info?.title || videoId}" because playability status is ${song.playability_status?.status || "UNKNOWN"}.`);
        
        // Phase 4A: Track skipped for seed performance
        if (state.seedUrl) {
          trackSeedPerformance(state.seedUrl, {
            successful: 0,
            skipped: 1
          });
        }
        
        retryDelay = 0;
        return;
      }
      stream = cachedStream;
      logger.info(`Using intelligent cache for: ${getTrackTitle(song)}`);
    } else {
      // Normal flow: fetch track and stream
      song = await getMusicTrack(videoId);
      if (song.playability_status?.status !== "OK") {
        state.stats.songsSkipped += 1;
        logger.warn(`Skipping "${song.basic_info?.title || videoId}" because playability status is ${song.playability_status?.status || "UNKNOWN"}.`);
        
        // Phase 4A: Track skipped for seed performance
        if (state.seedUrl) {
          trackSeedPerformance(state.seedUrl, {
            successful: 0,
            skipped: 1
          });
        }
        
        retryDelay = 0;
        return;
      }

      // Phase 2: Use intelligent cache for fetching
      stream = await getCachedAudioStream(videoId, song);
    }
    
    radio.play(stream);

    const previousTrackId = state.currentTrack?.basic_info?.id || null;
    state.currentTrack = song;
    state.currentPlayback = {
      videoId: song.basic_info.id,
      startedAt: Date.now(),
      attempts: queueItem.attempts || 0,
      forceBackend: queueItem.forceBackend || null
    };
    state.consecutiveFailures = 0;
    state.stats.lastStartedAt = new Date().toISOString();
    state.stats.lastError = null;
    
    // Report successful playback for adaptive quality
    reportPlaybackSuccess();

    if (!replayRequest) {
      state.stats.songsStarted += 1;
      state.tracksSinceAnchor += 1;
      rememberPlayedTrack(song);
      writeSeedUrl(song.basic_info.id);
      
      // Phase 4A: Track successful playback for seed performance
      if (state.seedUrl) {
        trackSeedPerformance(state.seedUrl, {
          successful: 1,
          skipped: 0
        });
      }
      
      // Phase 4C: Discover potential seeds from high-quality tracks
      state.trackPlayDuration = 0; // Reset play duration
      discoverPotentialSeed(song);
    }

    if (!replayRequest || previousTrackId !== song.basic_info.id) {
      broadcastNowPlaying();
    } else {
      logger.info(`Retrying track "${getTrackTitle(song)}" (attempt ${queueItem.attempts}/${config.interruptionReplay.maxAttempts}) using ${queueItem.forceBackend || config.playbackBackend}.`);
    }

    if (!replayRequest && state.playlist.length === 0) {
      await ensureQueueAvailable();
    }

    if (state.playlist[0]) {
      const next = getPlaylistItemSummary(state.playlist[0]);
      logger.info("Up next:", `${next.author || "Unknown Artist"} - ${next.title || "Unknown Title"}`);
    }

    prefetchQueuedTracks();
    
    // Phase 2: Warm cache with upcoming tracks
    void warmCache();
  } catch (err) {
    state.consecutiveFailures += 1;
    state.stats.lastError = serializeError(err);
    retryDelay = getRetryDelay(err);
    logger.error("Playback error:", err);
    
    // Report playback failure for adaptive quality
    reportPlaybackFailure();
  } finally {
    state.playInProgress = false;
  }

  if (retryDelay !== null) {
    schedulePlayback(retryDelay);
  }
}

radio.on("finish", () => {
  state.currentPlayback = null;
  queueNextTrack("finish");
});

radio.on("error", (err) => {
  if (isBenignRadioStreamError(err)) {
    const replayRequest = buildReplayRequest(err);
    if (replayRequest) {
      const durationSeconds = getTrackDurationSeconds(state.currentTrack);
      const elapsedLabel = replayRequest.elapsedMs === null ? "unknown" : `${Math.round(replayRequest.elapsedMs / 1000)}s`;
      const durationLabel = durationSeconds ? `${durationSeconds}s` : "unknown";
      logger.warn(`Radio stream interrupted for "${getCurrentTrackTitle()}" after ${elapsedLabel}/${durationLabel}. Retrying current track (attempt ${replayRequest.attempts}/${config.interruptionReplay.maxAttempts}) using ${replayRequest.forceBackend || config.playbackBackend}.`);
      state.stats.lastError = serializeError(err);
      state.currentPlayback = null;
      state.pendingReplay = replayRequest;
      stopRadioProcess();
      schedulePlayback(config.interruptionReplay.retryDelayMs);
      return;
    }

    logger.warn("Radio stream ended with benign transport error and the track will be skipped:", err.message);
    state.stats.lastError = serializeError(err);
    state.currentPlayback = null;
    state.stats.songsSkipped += 1;
    stopRadioProcess();
    queueNextTrack("benign-stream-error", { countCompletion: false });
    return;
  }

  state.currentPlayback = null;
  state.stats.lastError = serializeError(err);
  logger.error("Radio pipeline error:", err);
  schedulePlayback(config.retry.baseDelayMs);
});

process.on("SIGINT", () => {
  void shutdown("SIGINT", 0);
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM", 0);
});

process.on("uncaughtException", (err) => {
  if (isIgnorableConsoleError(err)) {
    if (state.shuttingDown) {
      process.exit(0);
      return;
    }

    return;
  }

  state.stats.lastError = serializeError(err);
  logger.error("Uncaught exception:", err);
  void shutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (reason) => {
  if (isIgnorableConsoleError(reason)) {
    return;
  }

  state.stats.lastError = serializeError(reason);
  logger.error("Unhandled rejection:", reason);
});

YouTube.Innertube.create({ location: config.geolocation }).then(async (instance) => {
  state.client = instance;
  
  // Phase 3: Initialize proxy manager
  if (proxyManager.config.enabled) {
    await proxyManager.initialize();
  }
  
  server.listen(config.httpPort, () => {
    void launch();
  });
  gopherServer.listen(config.gopherPort);
}).catch((err) => {
  logger.error("Failed to initialize YouTube client:", err);
  process.exit(1);
});
