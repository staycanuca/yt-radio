# Phase 2 Monitoring Guide

Quick reference for monitoring Phase 2 intelligent caching and bandwidth features.

## 🔍 Log Patterns to Watch

### LRU Cache

**Cache Hits** (memory access):
```
[DEBUG] LRU cache hit: abc123
```

**What to do:**
- This is the fastest cache (microseconds)
- High frequency = good performance
- Should see this for recently played tracks

### Disk Cache

**Cache Hits** (disk access):
```
[DEBUG] Disk cache hit: abc123
[DEBUG] Loaded from disk cache: abc123
```

**Cache Saves**:
```
[DEBUG] Saved to disk cache: abc123
```

**What to do:**
- Disk hits are slower than LRU but faster than YouTube
- Should see this after restarts
- Saves happen in background (non-blocking)

### Cache Warming

**Warming Activity**:
```
[DEBUG] Cache warmed: abc123
```

**What to do:**
- Indicates proactive caching is working
- Should see 3-5 messages after each track starts
- Reduces wait time for upcoming tracks

### Cache Cleanup

**Cleanup Operations**:
```
[INFO] Cleaned up 25 old cache files
```

**What to do:**
- Normal when disk cache reaches 500 MB
- Removes oldest 20% of files
- If too frequent, increase `diskCacheMaxSize`

### Intelligent Cache Usage

**Using Intelligent Cache**:
```
[INFO] Using intelligent cache for: Artist - Song Title
```

**What to do:**
- Indicates Phase 2 cache was used
- Should be common after warm-up period
- Means YouTube API was not called

## 📊 Performance Indicators

### Excellent Performance
```
✅ LRU cache hit: abc123
✅ Disk cache hit: def456
✅ Cache warmed: ghi789
✅ Using intelligent cache for: Artist - Song
✅ Disk cache initialized: ./cache/tracks
✅ Cache stats: 45 files, 487MB
```

### Good Performance
```
✅ Disk cache hit: abc123
✅ Cache warmed: def456
⚠️ Some YouTube fetches (normal for new tracks)
```

### Needs Attention
```
⚠️ No cache hits (cold start or diverse playlist)
⚠️ Frequent cleanup (cache too small)
❌ Failed to save to disk cache (disk full?)
❌ Failed to load from disk cache (corruption?)
```

## 🛠️ Monitoring Commands

### Check Cache Stats via API

**Radio endpoint**:
```bash
curl http://localhost:8080/cache-stats
```

**Backend endpoint**:
```bash
curl http://localhost:3000/api/stats/cache
```

**Expected response**:
```json
{
  "lruCache": {
    "size": 45,
    "max": 50
  },
  "diskCache": {
    "files": 123,
    "sizeMB": 487.5,
    "maxSizeMB": 500,
    "path": "./cache/tracks"
  },
  "bandwidth": {
    "averageMbps": 4.23,
    "samples": 10,
    "recommendedQuality": "360p"
  },
  "adaptiveQuality": {
    "current": "360p",
    "successCount": 8,
    "failureCount": 0
  }
}
```

### Monitor Cache Directory

**Windows PowerShell**:
```powershell
# Check cache size
Get-ChildItem ./cache/tracks | Measure-Object -Property Length -Sum

# Count cache files
(Get-ChildItem ./cache/tracks).Count

# Watch cache directory
Get-ChildItem ./cache/tracks -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 10
```

**Linux/Mac**:
```bash
# Check cache size
du -sh ./cache/tracks

# Count cache files
ls ./cache/tracks | wc -l

# Watch newest files
ls -lt ./cache/tracks | head -10
```

### Real-time Log Monitoring

**Watch all cache activity**:
```bash
# Windows PowerShell
Get-Content radio.out.log -Wait | Select-String "cache|Cache|bandwidth|Bandwidth"

# Linux/Mac
tail -f radio.out.log | grep -iE "cache|bandwidth"
```

**Watch cache hits only**:
```bash
# Windows PowerShell
Get-Content radio.out.log -Wait | Select-String "cache hit"

# Linux/Mac
tail -f radio.out.log | grep "cache hit"
```

**Watch cache warming**:
```bash
# Windows PowerShell
Get-Content radio.out.log -Wait | Select-String "Cache warmed"

# Linux/Mac
tail -f radio.out.log | grep "Cache warmed"
```

## 📈 Expected Behavior

### Startup (First 5 minutes)
- Disk cache initialized
- Cache stats logged (files and size)
- First few tracks: YouTube fetches (cache misses)
- Cache warming starts after first track
- Tracks 3-5: Cache hits start appearing

### Stable Operation (After 10+ tracks)
- 70-85% cache hit rate
- LRU cache: 40-50 entries
- Disk cache: Growing to ~500 MB
- Cache warming: 3-5 tracks per song
- Bandwidth: Stable average

### After Restart
- Disk cache loaded from disk
- LRU cache empty (rebuilds from disk hits)
- First track: Disk cache hit
- Subsequent tracks: Mix of disk and LRU hits
- Cache warming resumes

### Playlist Repeat
- Very high cache hit rate (>90%)
- Mostly LRU hits (fastest)
- Minimal YouTube API calls
- Instant track transitions

## 🎯 Success Metrics

### Excellent Performance
- **LRU Hit Rate**: >60%
- **Disk Hit Rate**: >20%
- **Combined Hit Rate**: >80%
- **Cache Warming**: 3-5 tracks per song
- **Bandwidth Average**: Stable (±1 Mbps)
- **Disk Cache Size**: 400-500 MB (near max)

### Good Performance
- **LRU Hit Rate**: >40%
- **Disk Hit Rate**: >15%
- **Combined Hit Rate**: >60%
- **Cache Warming**: 2-4 tracks per song
- **Bandwidth Average**: Stable (±2 Mbps)
- **Disk Cache Size**: 200-400 MB

### Needs Attention
- **Combined Hit Rate**: <40%
- **Cache Warming**: <2 tracks per song
- **Bandwidth Average**: Unstable (>3 Mbps variance)
- **Disk Cache**: Not growing or frequent cleanup
- **Errors**: Cache save/load failures

## 🔧 Troubleshooting

### Low Cache Hit Rate

**Symptoms**:
- Most tracks fetched from YouTube
- Few cache hit messages

**Possible Causes**:
- Playlist too diverse (no repeats)
- Cache size too small
- Cache warming not working

**Solutions**:
```javascript
// Increase LRU cache size (in index.js)
lruCache: new LRUCache({
  max: 100,  // Increase from 50
  ttl: 1000 * 60 * 60  // Increase to 1 hour
})

// Increase disk cache size
diskCacheMaxSize: 1000 * 1024 * 1024  // 1 GB

// Increase cache warming count (in warmCache())
const toWarm = Math.min(10, state.playlist.length);  // Warm 10 tracks
```

### Disk Cache Not Growing

**Symptoms**:
- Disk cache stays small
- No "Saved to disk cache" messages

**Possible Causes**:
- Tracks not playable (status !== "OK")
- Disk write errors
- Cache directory permissions

**Solutions**:
- Check logs for save errors
- Verify `./cache/tracks/` directory exists
- Check disk space
- Verify write permissions

### Frequent Cache Cleanup

**Symptoms**:
- "Cleaned up X old cache files" every few minutes
- Cache size always at max

**Possible Causes**:
- Max size too small for usage
- Many unique tracks played
- Cleanup too aggressive

**Solutions**:
```javascript
// Increase max size
diskCacheMaxSize: 1000 * 1024 * 1024  // 1 GB

// Adjust cleanup percentage (in cleanupDiskCache())
const toRemove = Math.ceil(fileStats.length * 0.1);  // Remove 10% instead of 20%
```

### Bandwidth Monitoring Inaccurate

**Symptoms**:
- Recommended quality doesn't match reality
- Average bandwidth seems wrong

**Possible Causes**:
- Not enough samples yet
- Byte estimation inaccurate
- Network conditions changed rapidly

**Solutions**:
- Wait for 10 samples to accumulate
- Adjust byte estimation in `getCachedAudioStream()`:
```javascript
// More accurate estimation based on quality
const estimatedBytes = adaptiveQuality === "best" ? 8 * 1024 * 1024 : 
                       adaptiveQuality === "360p" ? 5 * 1024 * 1024 : 
                       3 * 1024 * 1024;
recordBandwidth(estimatedBytes, duration);
```

### Cache Corruption

**Symptoms**:
- "Failed to load from disk cache" errors
- Tracks skip unexpectedly
- JSON parse errors

**Solutions**:
```bash
# Clear disk cache
rm -rf ./cache/tracks/*

# Or on Windows
Remove-Item ./cache/tracks/* -Recurse -Force

# Restart radio - cache will rebuild
```

## 📝 Log Examples

### Perfect Scenario
```
[INFO] Disk cache initialized: ./cache/tracks
[INFO] Cache stats: 123 files, 487MB
[INFO] Radio is now playing: Artist - Song Title
[DEBUG] LRU cache hit: abc123
[DEBUG] Cache warmed: def456
[DEBUG] Cache warmed: ghi789
[DEBUG] Cache warmed: jkl012
[INFO] Using intelligent cache for: Next Artist - Next Song
```

### Cold Start Scenario
```
[INFO] Disk cache initialized: ./cache/tracks
[INFO] Cache stats: 0 files, 0MB
[INFO] Radio is now playing: Artist - Song Title
[DEBUG] Saved to disk cache: abc123
[DEBUG] Cache warmed: def456
[DEBUG] Cache warmed: ghi789
[INFO] Radio is now playing: Next Artist - Next Song
[DEBUG] Disk cache hit: def456
```

### After Restart Scenario
```
[INFO] Disk cache initialized: ./cache/tracks
[INFO] Cache stats: 123 files, 487MB
[INFO] Radio is now playing: Artist - Song Title
[DEBUG] Disk cache hit: abc123
[DEBUG] Loaded from disk cache: abc123
[INFO] Using intelligent cache for: Artist - Song Title
[DEBUG] Cache warmed: def456
```

### Cache Cleanup Scenario
```
[INFO] Disk cache stats: 250 files, 498MB
[DEBUG] Saved to disk cache: xyz789
[INFO] Cleaned up 50 old cache files
[INFO] Cache stats: 200 files, 398MB
```

---

**Quick Check**: If you see frequent "cache hit" messages and cache stats show 70%+ hit rate, Phase 2 is working perfectly! 🎉

**Performance Tip**: For best results, let the cache warm up for 15-20 tracks before evaluating performance.

**Bandwidth Tip**: Check `/cache-stats` endpoint to see recommended quality based on your network speed.
