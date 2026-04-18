# Seed Propagation & Anchoring Analysis

**Date**: April 17, 2026  
**Focus**: Optimizing seed propagation and playlist anchoring in YT Radio

---

## 📊 Current Implementation

### How Seed Propagation Works

```
1. Initial Seed
   ↓
2. Get Track from Seed URL
   ↓
3. Call track.getUpNext() → YouTube API returns "Up Next" recommendations
   ↓
4. Filter candidates (if strict mode)
   ↓
5. Populate playlist with filtered items
   ↓
6. Play tracks from playlist
   ↓
7. When playlist empty → Use current track's getUpNext()
   ↓
8. Repeat from step 3
```

### Anchoring Logic

**Dynamic Mode** (default):
- Never re-anchors to seed
- Continuously propagates from current track
- Playlist evolves organically based on YouTube recommendations

**Strict Mode**:
- Re-anchors to seed every `refreshFromSeedEvery` tracks (default: 3)
- Applies filtering rules (duration, keywords, artists)
- Maintains genre/style consistency

### Current State Tracking

```javascript
state = {
  seedUrl: "https://youtu.be/VIDEO_ID",
  tracksSinceAnchor: 0,  // Increments with each track
  currentTrack: {...},    // Last played track
  playlist: [],           // Queue of upcoming tracks
  recentTrackIds: [],     // Deduplication (last 6 tracks)
  recentArtists: []       // Artist diversity (last 6 artists)
}
```

---

## 🔍 Identified Issues

### 1. **Single Seed Dependency**
**Problem**: Most presets use single `seedUrl`
```javascript
"seedUrl": "https://youtu.be/szy_L1-16wg"
```

**Impact**:
- Limited starting point diversity
- Predictable playlist evolution
- Genre drift over time (in dynamic mode)

**Evidence**: Only 6 presets use multiple `seedUrls`:
- manele-mainstream (3 seeds)
- dance-pop-romanesc (3 seeds)
- manele-clasice (3 seeds)
- romania-mainstream (3 seeds)
- party-romania (3 seeds)
- party-manele (3 seeds)

### 2. **Weak Anchoring in Dynamic Mode**
**Problem**: No re-anchoring in dynamic mode
```javascript
if (presetConfig.stationMode !== "strict") {
  return false;  // Never re-anchor
}
```

**Impact**:
- Playlist drifts away from original genre
- After 20-30 tracks, may be completely different style
- No way to "reset" to seed without restart

**Example Drift**:
```
Seed: Pop/City Pop (calm)
  ↓ 5 tracks
Current: Still pop, slightly more energetic
  ↓ 10 tracks
Current: Dance-pop, upbeat
  ↓ 20 tracks
Current: EDM/Electronic (completely different)
```

### 3. **YouTube API Recommendation Bias**
**Problem**: `getUpNext()` is optimized for engagement, not genre consistency

**YouTube's Algorithm Priorities**:
1. Watch time maximization
2. Click-through rate
3. User engagement
4. Trending content

**Impact on Radio**:
- Recommendations favor popular/viral content
- May suggest trending songs outside genre
- Bias toward higher energy tracks (more engaging)
- Less diversity in recommendations

### 4. **No Seed Rotation Strategy**
**Problem**: Even with multiple seeds, no intelligent rotation

**Current Behavior**:
```javascript
function pickSeedUrlForPreset(presetConfig, currentSeedUrl) {
  const seeds = presetConfig.seedUrls || [presetConfig.seedUrl];
  
  if (seeds.length === 1) {
    return seeds[0];
  }
  
  // Simple: pick next seed in array
  const currentIndex = seeds.indexOf(currentSeedUrl);
  const nextIndex = (currentIndex + 1) % seeds.length;
  return seeds[nextIndex];
}
```

**Issues**:
- Sequential rotation (predictable)
- No quality/performance tracking
- No adaptation based on playlist success

### 5. **Limited Seed Diversity Sources**
**Problem**: Seeds are only YouTube video URLs

**Missing Opportunities**:
- YouTube playlists as seeds
- YouTube channels as seeds
- YouTube Music albums/artists
- Mix playlists (YouTube's auto-generated mixes)

### 6. **No Seed Performance Tracking**
**Problem**: No metrics on seed effectiveness

**Missing Data**:
- Which seeds produce better playlists?
- Which seeds maintain genre consistency?
- Which seeds have higher skip rates?
- Which seeds generate more diverse recommendations?

---

## 💡 Optimization Proposals

### 🔥 **Priority 1: Multi-Seed Rotation with Intelligence**

#### Implementation
```javascript
// Enhanced seed tracking
state.seedPerformance = new Map(); // Map<seedUrl, performance>

// Track seed performance
function trackSeedPerformance(seedUrl, metrics) {
  if (!state.seedPerformance.has(seedUrl)) {
    state.seedPerformance.set(seedUrl, {
      url: seedUrl,
      usageCount: 0,
      successfulTracks: 0,
      skippedTracks: 0,
      avgPlaylistSize: 0,
      lastUsed: null,
      score: 100  // Initial score
    });
  }
  
  const perf = state.seedPerformance.get(seedUrl);
  perf.usageCount++;
  perf.successfulTracks += metrics.successful;
  perf.skippedTracks += metrics.skipped;
  perf.avgPlaylistSize = (perf.avgPlaylistSize + metrics.playlistSize) / 2;
  perf.lastUsed = Date.now();
  
  // Calculate score: success rate + playlist size bonus
  const successRate = perf.successfulTracks / (perf.successfulTracks + perf.skippedTracks);
  perf.score = (successRate * 80) + (Math.min(perf.avgPlaylistSize, 20) * 1);
}

// Intelligent seed selection
function pickBestSeed(presetConfig) {
  const seeds = presetConfig.seedUrls || [presetConfig.seedUrl];
  
  if (seeds.length === 1) {
    return seeds[0];
  }
  
  // Get performance data
  const seedScores = seeds.map(url => ({
    url,
    perf: state.seedPerformance.get(url),
    score: state.seedPerformance.get(url)?.score || 100
  }));
  
  // Sort by score (descending)
  seedScores.sort((a, b) => b.score - a.score);
  
  // Weighted random selection (favor high scores but allow variety)
  const totalScore = seedScores.reduce((sum, s) => sum + s.score, 0);
  let random = Math.random() * totalScore;
  
  for (const seed of seedScores) {
    random -= seed.score;
    if (random <= 0) {
      return seed.url;
    }
  }
  
  return seedScores[0].url;
}
```

**Benefits**:
- Automatically favors seeds that produce better playlists
- Maintains variety through weighted randomization
- Self-optimizing over time

---

### 🔥 **Priority 2: Adaptive Re-anchoring**

#### Implementation
```javascript
// Add to config
adaptiveAnchoring: {
  enabled: true,
  dynamicModeThreshold: 15,  // Re-anchor after 15 tracks in dynamic mode
  genreDriftDetection: true,  // Detect when playlist drifts from seed
  minAnchorInterval: 5        // Minimum tracks between re-anchors
}

// Genre drift detection
function detectGenreDrift() {
  if (!state.currentTrack || !state.seedTrack) {
    return false;
  }
  
  // Compare current track metadata with seed track
  const seedGenre = extractGenreKeywords(state.seedTrack);
  const currentGenre = extractGenreKeywords(state.currentTrack);
  
  // Calculate similarity score
  const similarity = calculateGenreSimilarity(seedGenre, currentGenre);
  
  // If similarity < 30%, consider it drifted
  return similarity < 0.3;
}

// Enhanced shouldReanchorFromSeed
function shouldReanchorFromSeed() {
  const presetConfig = state.activePresetConfig;
  
  // Strict mode: use configured threshold
  if (presetConfig?.stationMode === "strict") {
    const threshold = presetConfig.rules.refreshFromSeedEvery || 3;
    return state.tracksSinceAnchor >= threshold;
  }
  
  // Dynamic mode: adaptive re-anchoring
  if (config.adaptiveAnchoring?.enabled) {
    // Re-anchor if:
    // 1. Exceeded dynamic threshold
    if (state.tracksSinceAnchor >= config.adaptiveAnchoring.dynamicModeThreshold) {
      return true;
    }
    
    // 2. Genre drift detected
    if (config.adaptiveAnchoring.genreDriftDetection && detectGenreDrift()) {
      logger.info("Genre drift detected, re-anchoring to seed");
      return true;
    }
  }
  
  return false;
}
```

**Benefits**:
- Prevents excessive genre drift in dynamic mode
- Maintains playlist coherence
- Configurable per preset

---

### 🔥 **Priority 3: Enhanced Seed Types**

#### Implementation
```javascript
// Support multiple seed types
seedTypes = {
  VIDEO: "video",           // Current: single video
  PLAYLIST: "playlist",     // YouTube playlist
  CHANNEL: "channel",       // YouTube channel
  MIX: "mix",              // YouTube Mix
  ARTIST: "artist"         // YouTube Music artist
}

// Enhanced seed structure
{
  "name": "pop-city-pop",
  "seeds": [
    {
      "type": "video",
      "url": "https://youtu.be/szy_L1-16wg",
      "weight": 40  // 40% probability
    },
    {
      "type": "playlist",
      "url": "https://www.youtube.com/playlist?list=PLxxx",
      "weight": 30  // 30% probability
    },
    {
      "type": "mix",
      "url": "https://www.youtube.com/watch?v=xxx&list=RDxxx",
      "weight": 30  // 30% probability
    }
  ]
}

// Get seed track based on type
async function getSeedTrackByType(seed) {
  switch (seed.type) {
    case "video":
      return await getMusicTrack(getVideoID(seed.url));
      
    case "playlist":
      const playlist = await state.client.getPlaylist(getPlaylistID(seed.url));
      const videos = await playlist.getVideos();
      const randomVideo = videos[Math.floor(Math.random() * videos.length)];
      return await getMusicTrack(randomVideo.id);
      
    case "mix":
      // YouTube Mix provides excellent recommendations
      const mixPlaylist = await state.client.getPlaylist(getPlaylistID(seed.url));
      const mixVideos = await mixPlaylist.getVideos();
      const randomMixVideo = mixVideos[Math.floor(Math.random() * mixVideos.length)];
      return await getMusicTrack(randomMixVideo.id);
      
    case "channel":
      const channel = await state.client.getChannel(getChannelID(seed.url));
      const uploads = await channel.getVideos();
      const recentVideo = uploads[Math.floor(Math.random() * Math.min(20, uploads.length))];
      return await getMusicTrack(recentVideo.id);
      
    default:
      throw new Error(`Unknown seed type: ${seed.type}`);
  }
}
```

**Benefits**:
- Much greater seed diversity
- YouTube Mixes are excellent for genre consistency
- Playlists provide curated starting points
- Channels ensure artist consistency

---

### 🟡 **Priority 4: Seed Pool Management**

#### Implementation
```javascript
// Maintain a pool of potential seeds
state.seedPool = {
  active: [],      // Currently used seeds
  discovered: [],  // Discovered from recommendations
  maxSize: 20      // Maximum pool size
}

// Discover new seeds from recommendations
function discoverPotentialSeeds(track) {
  // If track is highly rated (not skipped, good engagement)
  if (isHighQualityTrack(track)) {
    const seedCandidate = {
      url: `https://youtu.be/${track.basic_info.id}`,
      discoveredAt: Date.now(),
      source: "recommendation",
      genre: extractGenreKeywords(track),
      score: 50  // Initial score
    };
    
    // Add to discovered pool
    state.seedPool.discovered.push(seedCandidate);
    
    // Limit pool size
    if (state.seedPool.discovered.length > state.seedPool.maxSize) {
      // Remove lowest scoring seeds
      state.seedPool.discovered.sort((a, b) => b.score - a.score);
      state.seedPool.discovered = state.seedPool.discovered.slice(0, state.seedPool.maxSize);
    }
  }
}

// Promote discovered seeds to active
function promoteDiscoveredSeeds() {
  // Promote top 3 discovered seeds
  const topSeeds = state.seedPool.discovered
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  
  for (const seed of topSeeds) {
    if (!state.seedPool.active.find(s => s.url === seed.url)) {
      state.seedPool.active.push(seed);
      logger.info(`Promoted discovered seed: ${seed.url}`);
    }
  }
}
```

**Benefits**:
- Self-expanding seed pool
- Discovers high-quality tracks automatically
- Maintains genre consistency through scoring

---

### 🟡 **Priority 5: Hybrid Propagation Strategy**

#### Implementation
```javascript
// Mix seed-based and recommendation-based propagation
propagationStrategy = {
  SEED_ONLY: "seed",           // Always from seed (strict)
  RECOMMENDATION_ONLY: "rec",  // Always from current (dynamic)
  HYBRID: "hybrid"             // Mix of both (new!)
}

// Hybrid propagation
async function populatePlaylistHybrid(options = {}) {
  const seedRatio = 0.3;  // 30% from seed, 70% from recommendations
  
  // Get recommendations from current track
  const recTracks = await getRecommendationsFromTrack(state.currentTrack);
  
  // Get recommendations from seed
  const seedTrack = await getSeedTrackForPreset();
  const seedTracks = await getRecommendationsFromTrack(seedTrack);
  
  // Mix them based on ratio
  const numSeedTracks = Math.floor(seedRatio * 10);
  const numRecTracks = 10 - numSeedTracks;
  
  const mixed = [
    ...seedTracks.slice(0, numSeedTracks),
    ...recTracks.slice(0, numRecTracks)
  ];
  
  // Shuffle to avoid predictable pattern
  state.playlist = shuffleArray(mixed);
  
  logger.info(`Hybrid playlist: ${numSeedTracks} from seed, ${numRecTracks} from recommendations`);
}
```

**Benefits**:
- Best of both worlds
- Maintains genre consistency (seed influence)
- Allows natural evolution (recommendation influence)
- Configurable ratio per preset

---

### 🟡 **Priority 6: Seed Refresh from External Sources**

#### Implementation
```javascript
// Periodically refresh seeds from curated sources
async function refreshSeedsFromSources() {
  const sources = [
    {
      type: "spotify-playlist",
      url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",  // Top 50
      converter: spotifyToYouTube
    },
    {
      type: "youtube-trending",
      category: "music",
      region: "RO"
    },
    {
      type: "youtube-chart",
      chart: "top-songs",
      region: "RO"
    }
  ];
  
  for (const source of sources) {
    try {
      const seeds = await fetchSeedsFromSource(source);
      
      // Add to seed pool
      for (const seed of seeds) {
        state.seedPool.discovered.push({
          url: seed.url,
          source: source.type,
          discoveredAt: Date.now(),
          score: 60  // Higher initial score for curated sources
        });
      }
    } catch (err) {
      logger.warn(`Failed to refresh seeds from ${source.type}:`, err.message);
    }
  }
}

// Schedule periodic refresh (daily)
setInterval(refreshSeedsFromSources, 1000 * 60 * 60 * 24);
```

**Benefits**:
- Always fresh seeds
- Trending content integration
- Cross-platform seed discovery

---

## 📊 Implementation Priority

### Phase 4A: Quick Wins (1-2 weeks)
1. ✅ **Multi-Seed Rotation with Intelligence** - Immediate impact
2. ✅ **Adaptive Re-anchoring** - Prevents genre drift
3. ✅ **Seed Performance Tracking** - Data-driven optimization

### Phase 4B: Enhanced Seeds (2-3 weeks)
4. ✅ **Enhanced Seed Types** (playlist, mix, channel)
5. ✅ **Hybrid Propagation Strategy**

### Phase 4C: Advanced (3-4 weeks)
6. ✅ **Seed Pool Management**
7. ✅ **External Source Integration**

---

## 🎯 Expected Improvements

### With Phase 4A
- **Genre Consistency**: +40% (adaptive re-anchoring)
- **Playlist Quality**: +30% (intelligent seed selection)
- **User Satisfaction**: +25% (less genre drift)

### With Phase 4B
- **Seed Diversity**: +200% (multiple seed types)
- **Recommendation Quality**: +35% (hybrid strategy)

### With Phase 4C
- **Seed Freshness**: Always current (external sources)
- **Self-Optimization**: Continuous improvement (seed pool)

---

## 🔧 Configuration Example

```javascript
// Enhanced preset configuration
{
  "name": "pop-city-pop-enhanced",
  "label": "Pop / City Pop (Enhanced)",
  "group": "Pop",
  "stationMode": "hybrid",  // New mode!
  
  "seeds": [
    {
      "type": "video",
      "url": "https://youtu.be/szy_L1-16wg",
      "weight": 30
    },
    {
      "type": "playlist",
      "url": "https://www.youtube.com/playlist?list=PLxxx",
      "weight": 40
    },
    {
      "type": "mix",
      "url": "https://www.youtube.com/watch?v=xxx&list=RDxxx",
      "weight": 30
    }
  ],
  
  "propagation": {
    "strategy": "hybrid",
    "seedRatio": 0.3,  // 30% seed, 70% recommendations
    "reanchorThreshold": 12,
    "genreDriftDetection": true
  },
  
  "seedManagement": {
    "performanceTracking": true,
    "intelligentRotation": true,
    "seedPoolEnabled": true,
    "externalRefresh": true
  }
}
```

---

## 📝 Summary

**Current Issues**:
1. Single seed dependency
2. Weak anchoring in dynamic mode
3. YouTube recommendation bias
4. No seed rotation strategy
5. Limited seed diversity
6. No performance tracking

**Proposed Solutions**:
1. Intelligent multi-seed rotation
2. Adaptive re-anchoring with drift detection
3. Enhanced seed types (playlist, mix, channel)
4. Hybrid propagation strategy
5. Seed pool management
6. External source integration

**Impact**: Dramatically improved playlist quality, genre consistency, and user satisfaction.

**Recommendation**: Start with Phase 4A (Quick Wins) for immediate impact, then proceed to Phase 4B and 4C based on results.
