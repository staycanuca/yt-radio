# Phase 1 Monitoring Guide

Quick reference for monitoring Phase 1 features in production.

## 🔍 Log Patterns to Watch

### Adaptive Quality

**Quality Downgrades** (indicates network issues):
```
Adaptive quality: Downgraded to 360p due to failures
Adaptive quality: Downgraded to audio-only due to failures
```

**Quality Upgrades** (indicates stable connection):
```
Adaptive quality: Upgraded to 360p after sustained success
Adaptive quality: Upgraded to best after sustained success
```

**What to do:**
- Downgrades are normal during poor connectivity
- If stuck at audio-only, check network/YouTube access
- Upgrades should happen after ~10 successful tracks

### Client Rotation

**Client Attempts** (shows rotation in action):
```
Native playback profile failed for [videoId]: {"backend":"native","client":"ANDROID",...}
Native playback profile failed for [videoId]: {"backend":"native","client":"IOS",...}
Native playback profile failed for [videoId]: {"backend":"native","client":"WEB",...}
```

**What to do:**
- Multiple client attempts are normal
- If all clients fail, video may be geo-restricted
- ANDROID usually succeeds first (most reliable)

### Pre-download Cache

**Cache Operations**:
```
Pre-downloaded track: [Artist] - [Title]
Using pre-downloaded stream for: [Artist] - [Title]
```

**What to do:**
- "Pre-downloaded" = background caching working
- "Using pre-downloaded" = cache hit (instant transition)
- No cache messages = tracks loading on-demand (slower)

## 📊 Performance Indicators

### Good Performance
```
✅ Adaptive quality: Upgraded to best after sustained success
✅ Using pre-downloaded stream for: [track]
✅ Up next: [track]
✅ Radio is now playing: [track]
```

### Issues Detected
```
⚠️ Adaptive quality: Downgraded to audio-only due to failures
⚠️ Native playback profile failed (multiple times)
⚠️ All playback backends failed for [videoId]
❌ Playback error: [error]
```

## 🛠️ Monitoring Commands

### Real-time Log Monitoring

**Watch all Phase 1 activity:**
```bash
# Windows PowerShell
Get-Content radio.out.log -Wait | Select-String "Adaptive|Pre-downloaded|Using pre-downloaded|playback profile failed"

# Linux/Mac
tail -f radio.out.log | grep -E "Adaptive|Pre-downloaded|Using pre-downloaded|playback profile failed"
```

**Watch quality changes only:**
```bash
# Windows PowerShell
Get-Content radio.out.log -Wait | Select-String "Adaptive quality"

# Linux/Mac
tail -f radio.out.log | grep "Adaptive quality"
```

**Watch cache hits:**
```bash
# Windows PowerShell
Get-Content radio.out.log -Wait | Select-String "Using pre-downloaded"

# Linux/Mac
tail -f radio.out.log | grep "Using pre-downloaded"
```

### Statistics Analysis

**Count quality adjustments:**
```bash
# Windows PowerShell
(Get-Content radio.out.log | Select-String "Adaptive quality").Count

# Linux/Mac
grep -c "Adaptive quality" radio.out.log
```

**Count cache hits:**
```bash
# Windows PowerShell
(Get-Content radio.out.log | Select-String "Using pre-downloaded").Count

# Linux/Mac
grep -c "Using pre-downloaded" radio.out.log
```

**Count client rotation attempts:**
```bash
# Windows PowerShell
(Get-Content radio.out.log | Select-String "playback profile failed").Count

# Linux/Mac
grep -c "playback profile failed" radio.out.log
```

## 📈 Expected Behavior

### Startup (First 5 minutes)
- Quality starts at "best"
- No cache hits (cache is empty)
- Some client rotation attempts (normal)

### Stable Operation (After 10+ tracks)
- Quality should stabilize (best or 360p)
- 60-80% cache hit rate
- Minimal client rotation (first client succeeds)

### Network Issues
- Quality downgrades to audio-only
- More client rotation attempts
- Cache still helps with transitions

### Recovery
- After 10 successful tracks, quality upgrades
- Cache hit rate improves
- Client rotation decreases

## 🎯 Success Metrics

### Excellent Performance
- Quality: "best" or "360p"
- Cache hit rate: >70%
- Client rotation: <2 attempts per track
- Track transitions: <1 second

### Good Performance
- Quality: "360p" or "audio-only"
- Cache hit rate: >50%
- Client rotation: <3 attempts per track
- Track transitions: <2 seconds

### Needs Attention
- Quality: stuck at "audio-only" for >30 minutes
- Cache hit rate: <30%
- Client rotation: >5 attempts per track
- Track transitions: >5 seconds

## 🔧 Troubleshooting

### Low Cache Hit Rate

**Possible causes:**
- Playlist too diverse (cache expires before use)
- Tracks failing playability check
- Cache cleanup too aggressive

**Solutions:**
- Check for "Pre-downloaded track" messages
- Verify tracks are playable (status === "OK")
- Increase cache timeout (currently 10 minutes)

### Frequent Quality Downgrades

**Possible causes:**
- Network instability
- YouTube rate limiting
- ISP throttling

**Solutions:**
- Check internet connection
- Wait for rate limit to clear
- Consider proxy rotation (Phase 2)

### All Clients Failing

**Possible causes:**
- Video geo-restricted
- Video removed/private
- YouTube API issues

**Solutions:**
- Skip to next track
- Try different preset
- Check YouTube accessibility

## 📝 Log Examples

### Perfect Scenario
```
[INFO] Adaptive quality: Upgraded to best after sustained success
[INFO] Pre-downloaded track: Artist - Song Title
[INFO] Using pre-downloaded stream for: Artist - Song Title
[INFO] Radio is now playing: Artist - Song Title
[INFO] Up next: Next Artist - Next Song
```

### Recovery Scenario
```
[WARN] Native playback profile failed for abc123: {"backend":"native","client":"ANDROID",...}
[WARN] Native playback profile failed for abc123: {"backend":"native","client":"IOS",...}
[INFO] Radio is now playing: Artist - Song Title (succeeded with IOS client)
[INFO] Adaptive quality: Downgraded to 360p due to failures
[INFO] Pre-downloaded track: Next Artist - Next Song
```

### Issue Scenario
```
[ERROR] Playback error: All playback backends failed for abc123
[INFO] Adaptive quality: Downgraded to audio-only due to failures
[WARN] Skipping "Song Title" because playability status is UNPLAYABLE
[INFO] Radio is now playing: Next Artist - Next Song (audio-only)
```

---

**Quick Check**: If you see "Using pre-downloaded stream" messages and quality stays at "best" or "360p", Phase 1 is working perfectly! 🎉
