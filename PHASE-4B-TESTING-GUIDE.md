# Phase 4B Testing Guide

**Date:** April 17, 2026  
**Status:** Ready for Testing  
**Phase:** 4B - Enhanced Seed Types & Hybrid Propagation

---

## ✅ Implementation Status

### Completed:
- [x] Enhanced seed types (VIDEO, PLAYLIST, MIX, CHANNEL)
- [x] Hybrid propagation strategy
- [x] Helper functions for ID extraction
- [x] Backward compatibility maintained
- [x] 6 example presets created
- [x] Syntax verified (no errors)
- [x] Presets loaded successfully (32 total presets)

### Ready for Testing:
- [ ] Playlist seed functionality
- [ ] Mix seed functionality
- [ ] Channel seed functionality
- [ ] Hybrid propagation (30% seed ratio)
- [ ] Hybrid propagation (50% seed ratio)
- [ ] Multi-seed weighted selection

---

## 🎯 New Presets Available

### 1. Enhanced Seed Types

#### `chill-playlist` (Playlist Seed)
- **Group:** Enhanced Seeds
- **Type:** Playlist
- **URL:** https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
- **Test:** Verify tracks are pulled from playlist

#### `lofi-mix` (Mix Seed)
- **Group:** Enhanced Seeds
- **Type:** Mix
- **URL:** https://www.youtube.com/watch?v=jfKfPfyJRdk&list=RDjfKfPfyJRdk
- **Test:** Verify tracks follow YouTube Mix algorithm

#### `vevo-channel` (Channel Seed)
- **Group:** Enhanced Seeds
- **Type:** Channel
- **URL:** https://www.youtube.com/@vevo
- **Test:** Verify tracks are from channel uploads

#### `multi-seed-weighted` (Multi-Seed)
- **Group:** Enhanced Seeds
- **Type:** Multiple seeds with weights
- **Seeds:** 
  - Video (50% weight)
  - Playlist (30% weight)
  - Mix (20% weight)
- **Test:** Verify weighted selection over 20+ tracks

### 2. Hybrid Propagation

#### `hybrid-dance` (30% Seed + 70% Recommendations)
- **Group:** Hybrid Propagation
- **Seed Type:** Playlist
- **Ratio:** 0.3 (30% seed, 70% recommendations)
- **Test:** Track 20 tracks, expect ~6 from seed, ~14 from recommendations

#### `hybrid-rock` (50% Seed + 50% Recommendations)
- **Group:** Hybrid Propagation
- **Seed Type:** Mix
- **Ratio:** 0.5 (50% seed, 50% recommendations)
- **Test:** Track 20 tracks, expect ~10 from seed, ~10 from recommendations

---

## 🧪 Testing Instructions

### Method 1: Via Backend UI (Recommended)
1. Open browser: http://localhost:3000
2. Select one of the new presets from dropdown
3. Click "Change Preset"
4. Monitor tracks as they play
5. Check if tracks match expected seed type

### Method 2: Via Radio API
```bash
# Change to hybrid-dance preset
curl -X POST "http://localhost:8080/preset?name=hybrid-dance&profile=safe"

# Wait a few seconds for preset to load
sleep 5

# Check now playing
curl -s http://localhost:8080/now-playing | jq

# Check queue
curl -s http://localhost:8080/queue | jq
```

### Method 3: Via Backend API
```bash
# Change preset via backend
curl -X POST "http://localhost:3000/api/preset" \
  -H "Content-Type: application/json" \
  -d '{"preset": "hybrid-dance", "profile": "safe"}'

# Check now playing
curl -s http://localhost:3000/api/now-playing | jq
```

---

## 📊 What to Monitor

### For Enhanced Seed Types:

#### Playlist Seed (`chill-playlist`):
- [ ] Tracks are from the specified playlist
- [ ] Random selection from playlist (not sequential)
- [ ] No duplicate tracks in short window
- [ ] Fallback to recommendations if playlist exhausted

#### Mix Seed (`lofi-mix`):
- [ ] Tracks follow YouTube Mix algorithm
- [ ] Good variety and flow
- [ ] Consistent genre/mood
- [ ] No errors fetching mix tracks

#### Channel Seed (`vevo-channel`):
- [ ] Tracks are from channel uploads
- [ ] Recent uploads prioritized
- [ ] Good variety from channel
- [ ] No errors fetching channel tracks

#### Multi-Seed Weighted (`multi-seed-weighted`):
- [ ] Tracks come from all 3 seed sources
- [ ] Distribution roughly matches weights (50/30/20)
- [ ] Smooth transitions between sources
- [ ] No errors in seed selection

### For Hybrid Propagation:

#### Hybrid Dance (30% seed):
- [ ] ~30% of tracks from playlist seed
- [ ] ~70% of tracks from YouTube recommendations
- [ ] Good genre consistency
- [ ] Smooth transitions between seed and recommendations
- [ ] No excessive genre drift

#### Hybrid Rock (50% seed):
- [ ] ~50% of tracks from mix seed
- [ ] ~50% of tracks from YouTube recommendations
- [ ] Balanced discovery and familiarity
- [ ] Good variety without losing theme

---

## 🔍 Debugging

### Check Logs:
```bash
# Radio logs (if running in terminal)
# Look for Phase 4B related messages:
# - "Using enhanced seed type: playlist"
# - "Hybrid propagation: using seed (30%)"
# - "Hybrid propagation: using recommendations (70%)"
```

### Check Seed Stats:
```bash
# Via radio API
curl -s http://localhost:8080/seed-stats | jq

# Via backend API
curl -s http://localhost:3000/api/stats/seed | jq
```

### Common Issues:

#### Issue: Preset doesn't load
- **Solution:** Check if preset name is correct
- **Solution:** Reload presets: `curl -X POST http://localhost:8080/reload-presets`

#### Issue: Tracks not from seed
- **Solution:** Check if seed URL is valid
- **Solution:** Check logs for seed fetch errors
- **Solution:** Verify seed type detection

#### Issue: Hybrid ratio not working
- **Solution:** Check if `propagationStrategy: "hybrid"` is set
- **Solution:** Check if `hybridSeedRatio` is configured
- **Solution:** Track more tracks (ratio is probabilistic)

---

## 📈 Success Criteria

### Phase 4B is successful if:
1. ✅ All 6 new presets load without errors
2. ✅ Playlist seeds pull tracks from playlists
3. ✅ Mix seeds follow YouTube Mix algorithm
4. ✅ Channel seeds pull from channel uploads
5. ✅ Multi-seed weighted selection works
6. ✅ Hybrid propagation maintains configured ratio
7. ✅ No breaking changes to existing presets
8. ✅ Backward compatibility maintained

---

## 🚀 Next Steps After Testing

### If Testing Passes:
1. Update README.md with Phase 4B features
2. Create user documentation for enhanced seeds
3. Add configuration examples to docs
4. Consider Phase 4C (Advanced features)

### If Issues Found:
1. Document issues in GitHub/tracking system
2. Fix critical bugs
3. Re-test affected functionality
4. Update implementation docs

---

## 📝 Testing Checklist

### Basic Functionality:
- [ ] All 6 new presets appear in preset list
- [ ] Presets can be selected and activated
- [ ] Tracks play without errors
- [ ] Queue populates correctly

### Enhanced Seed Types:
- [ ] Playlist seed works (`chill-playlist`)
- [ ] Mix seed works (`lofi-mix`)
- [ ] Channel seed works (`vevo-channel`)
- [ ] Multi-seed weighted works (`multi-seed-weighted`)

### Hybrid Propagation:
- [ ] 30% seed ratio works (`hybrid-dance`)
- [ ] 50% seed ratio works (`hybrid-rock`)
- [ ] Ratio is maintained over 20+ tracks
- [ ] Genre consistency maintained

### Backward Compatibility:
- [ ] Existing presets still work (test 3-5 random presets)
- [ ] Legacy `seedUrl` format works
- [ ] Legacy `seedUrls` array format works
- [ ] No API breaking changes

### Performance:
- [ ] Preset loading time acceptable (<5s)
- [ ] Track fetching time acceptable (<3s)
- [ ] No memory leaks over 1 hour
- [ ] CPU usage reasonable

---

**Ready to test!** Start with `hybrid-dance` preset for a quick validation of hybrid propagation.
