# Phase 4C Testing Guide

**Date:** April 17, 2026  
**Status:** Ready for Testing  
**Phase:** 4C - Seed Pool Management & External Source Integration

---

## ✅ Implementation Status

### Completed:
- [x] 3-tier seed pool system (active, discovered, external)
- [x] Auto-discovery from high-quality tracks
- [x] External source integration (Trending, Charts)
- [x] Periodic refresh scheduling (24 hours)
- [x] Intelligent weighted seed selection
- [x] API endpoints (`/seed-pool`, `/seed-pool-refresh`)
- [x] Backend proxy endpoints
- [x] Syntax verified (no errors)

### Ready for Testing:
- [ ] Auto-discovery functionality
- [ ] External source fetching (Trending, Charts)
- [ ] Periodic refresh (24 hours)
- [ ] Seed promotion to active pool
- [ ] Weighted seed selection
- [ ] Genre filtering

---

## 🧪 Testing Instructions

### Prerequisites:
1. **yt-dlp installed** - Required for external source fetching
   ```bash
   # Check if yt-dlp is installed
   yt-dlp --version
   
   # If not installed:
   # Windows: choco install yt-dlp
   # Linux/Mac: pip install yt-dlp
   ```

2. **Radio running** - Start backend (auto-starts radio)
   ```bash
   node backend/server.js
   ```

---

## 📋 Test Cases

### Test 1: Auto-Discovery from High-Quality Tracks

**Objective:** Verify seeds are discovered from tracks played for 30+ seconds

**Steps:**
1. Start radio with any preset
2. Let 5-10 tracks play for at least 30 seconds each
3. Check seed pool stats:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq
   ```

**Expected Results:**
- `discovered.count` should be > 0
- `discovered.topSeeds` should show discovered tracks
- Each seed should have:
  - `title`, `author`, `score` (around 50)
  - `source: "recommendation"`
  - `playCount` >= 1

**Pass Criteria:**
- At least 3-5 seeds discovered after 10 tracks
- Seeds have correct metadata
- Scores are reasonable (40-60 range)

---

### Test 2: External Source Fetching (YouTube Trending)

**Objective:** Verify YouTube Trending seeds are fetched

**Steps:**
1. Trigger manual refresh:
   ```bash
   curl -X POST http://localhost:8080/seed-pool-refresh
   ```

2. Wait 10-30 seconds for fetching to complete

3. Check seed pool stats:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq '.external'
   ```

**Expected Results:**
- `external.count` should be > 0
- `external.sources.trending` should be around 10
- `external.lastRefresh` should be recent timestamp
- Seeds should have `source: "youtube-trending"`
- Scores should be around 70

**Pass Criteria:**
- At least 5-10 trending seeds fetched
- Seeds have valid YouTube URLs
- Scores are higher than discovered (70 vs 50)

---

### Test 3: External Source Fetching (YouTube Charts)

**Objective:** Verify YouTube Charts seeds are fetched

**Steps:**
1. Check seed pool stats after refresh:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq '.external.sources'
   ```

**Expected Results:**
- `external.sources.charts` should be around 20
- Chart seeds should have `source: "youtube-charts"`
- Scores should be around 75 (highest)

**Pass Criteria:**
- At least 10-20 chart seeds fetched
- Seeds have valid YouTube URLs
- Scores are highest (75)

---

### Test 4: Seed Promotion to Active Pool

**Objective:** Verify top discovered seeds are promoted to active

**Steps:**
1. Let radio play for 30+ minutes
2. Check seed pool stats:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq '.active'
   ```

**Expected Results:**
- `active.count` should be > 0 (up to 3)
- Active seeds should be top-scoring discovered seeds
- Each seed should have `promotedAt` timestamp

**Pass Criteria:**
- Top 3 discovered seeds are promoted
- No duplicates in active pool
- Promotion happens automatically

---

### Test 5: Weighted Seed Selection

**Objective:** Verify seeds are selected based on score

**Steps:**
1. Check seed pool stats to see scores:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq '.discovered.topSeeds'
   ```

2. Monitor radio logs for seed selection messages

**Expected Results:**
- Higher-scoring seeds are selected more frequently
- Lower-scoring seeds are still selected occasionally
- Selection is not purely deterministic

**Pass Criteria:**
- Weighted randomness is evident
- High-scoring seeds appear more often
- Low-scoring seeds still get chances

---

### Test 6: Genre Filtering

**Objective:** Verify genre filtering works with preset rules

**Steps:**
1. Use a preset with `allowKeywords` (e.g., "manele" preset)
2. Let radio play for 20+ tracks
3. Check discovered seeds:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq '.discovered.topSeeds[].genres'
   ```

**Expected Results:**
- Discovered seeds have genre keywords
- Genres match preset's `allowKeywords`
- Genre filtering maintains theme

**Pass Criteria:**
- Seeds have relevant genre keywords
- Genre consistency is maintained
- No off-genre seeds discovered

---

### Test 7: Periodic Refresh (24 Hours)

**Objective:** Verify automatic refresh happens every 24 hours

**Steps:**
1. Check initial refresh timestamp:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq '.external.lastRefresh'
   ```

2. Wait 5 minutes (initial refresh should happen)

3. Check timestamp again - should be updated

4. For 24-hour test, check logs after 24 hours

**Expected Results:**
- Initial refresh happens 5 minutes after startup
- `lastRefresh` timestamp updates
- Periodic refresh happens every 24 hours

**Pass Criteria:**
- Initial refresh completes within 5 minutes
- Timestamp updates correctly
- No errors in logs

---

### Test 8: Pool Size Limits

**Objective:** Verify pool size limits are enforced

**Steps:**
1. Let radio play for 2+ hours
2. Check pool sizes:
   ```bash
   curl -s http://localhost:8080/seed-pool | jq '{active: .active.count, discovered: .discovered.count, external: .external.count}'
   ```

**Expected Results:**
- `active.count` <= 20
- `discovered.count` <= 20
- `external.count` <= 40 (2x maxSize)

**Pass Criteria:**
- Pool sizes never exceed limits
- Lowest-scoring seeds are removed when limit reached
- No memory leaks

---

### Test 9: API Endpoints

**Objective:** Verify all API endpoints work correctly

**Steps:**
1. Test GET /seed-pool:
   ```bash
   curl -s http://localhost:8080/seed-pool
   ```

2. Test POST /seed-pool-refresh:
   ```bash
   curl -X POST http://localhost:8080/seed-pool-refresh
   ```

3. Test backend proxies:
   ```bash
   curl -s http://localhost:3000/api/seed-pool
   curl -X POST http://localhost:3000/api/seed-pool-refresh
   ```

**Expected Results:**
- All endpoints return valid JSON
- Status codes are correct (200 for success)
- Backend proxies work correctly

**Pass Criteria:**
- No 500 errors
- JSON is well-formed
- Proxies forward correctly

---

### Test 10: Performance & Stability

**Objective:** Verify system remains stable over extended runtime

**Steps:**
1. Let radio run for 24+ hours
2. Monitor memory usage
3. Check for errors in logs
4. Verify seed pool continues to grow

**Expected Results:**
- No memory leaks
- No crashes or errors
- Seed pool grows steadily
- Performance remains good

**Pass Criteria:**
- Memory usage stable (<500 MB)
- No errors in logs
- Radio plays continuously
- Seed pool functional

---

## 🔍 Debugging

### Check Logs:
```bash
# Radio logs (if running in terminal)
# Look for Phase 4C messages:
# - "Discovered potential seed: ..."
# - "Promoted discovered seed to active: ..."
# - "Refreshing seeds from external sources..."
# - "Fetched X trending seeds"
# - "Fetched X chart seeds"
```

### Check Seed Pool Stats:
```bash
# Full stats
curl -s http://localhost:8080/seed-pool | jq

# Just counts
curl -s http://localhost:8080/seed-pool | jq '{active: .active.count, discovered: .discovered.count, external: .external.count}'

# Top discovered seeds
curl -s http://localhost:8080/seed-pool | jq '.discovered.topSeeds'

# External sources breakdown
curl -s http://localhost:8080/seed-pool | jq '.external.sources'
```

### Common Issues:

#### Issue: No seeds discovered
- **Cause:** Tracks skipped too quickly (<30s)
- **Solution:** Let tracks play for at least 30 seconds

#### Issue: External fetch fails
- **Cause:** yt-dlp not installed or not in PATH
- **Solution:** Install yt-dlp and ensure it's accessible

#### Issue: No trending/chart seeds
- **Cause:** Network issues or YouTube blocking
- **Solution:** Check internet connection, try manual refresh

#### Issue: Pool size exceeds limit
- **Cause:** Bug in pool size management
- **Solution:** Check logs, report issue

---

## 📊 Success Criteria

### Phase 4C is successful if:
1. ✅ Seeds are auto-discovered from high-quality tracks
2. ✅ External sources (Trending, Charts) are fetched
3. ✅ Top seeds are promoted to active pool
4. ✅ Weighted seed selection works
5. ✅ Genre filtering maintains consistency
6. ✅ Periodic refresh happens every 24 hours
7. ✅ Pool size limits are enforced
8. ✅ API endpoints work correctly
9. ✅ System remains stable over 24+ hours
10. ✅ No breaking changes to existing functionality

---

## 🚀 Next Steps After Testing

### If Testing Passes:
1. Monitor seed pool growth over 1 week
2. Analyze seed quality and relevance
3. Optimize scoring algorithm if needed
4. Implement Spotify integration (requires credentials)
5. Consider Phase 5 features

### If Issues Found:
1. Document issues with details
2. Fix critical bugs
3. Re-test affected functionality
4. Update implementation docs

---

## 📝 Testing Checklist

### Basic Functionality:
- [ ] Auto-discovery works (Test 1)
- [ ] YouTube Trending fetch works (Test 2)
- [ ] YouTube Charts fetch works (Test 3)
- [ ] Seed promotion works (Test 4)
- [ ] Weighted selection works (Test 5)
- [ ] Genre filtering works (Test 6)

### Advanced Functionality:
- [ ] Periodic refresh works (Test 7)
- [ ] Pool size limits enforced (Test 8)
- [ ] API endpoints work (Test 9)
- [ ] Performance stable (Test 10)

### Integration:
- [ ] No breaking changes to existing presets
- [ ] Works with Phase 4A (seed performance tracking)
- [ ] Works with Phase 4B (enhanced seed types)
- [ ] Backend proxy endpoints work

---

## 📈 Monitoring Metrics

### Track Over 24 Hours:
- **Discovered seeds:** Should grow to 15-20
- **Active seeds:** Should reach 3
- **External seeds:** Should be 30+ after refresh
- **Total seeds:** 50-60 across all pools

### Quality Metrics:
- **Discovery rate:** 30-50% of played tracks
- **Promotion rate:** Top 3 every few hours
- **External refresh:** 1x per 24 hours
- **Genre consistency:** 80%+ match with preset

---

**Ready to test!** Start with Test 1 (Auto-Discovery) and work through the checklist.

**Estimated Testing Time:** 2-3 hours for basic tests, 24+ hours for full stability test.
