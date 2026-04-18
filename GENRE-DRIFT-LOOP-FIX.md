# Genre Drift Infinite Loop Fix

**Date:** April 17, 2026  
**Issue:** Radio stuck in infinite loop playing same track  
**Status:** ✅ FIXED

---

## 🐛 Problem

Radio was stuck in an infinite loop, replaying the same track repeatedly:

```
[Radio] INFO Genre drift detected: seed= vs current= (similarity: 0%)
[Radio] INFO Adaptive re-anchoring: genre drift detected
[Radio] INFO -- Now Playing: Vasile Pandelescu - Suparat am fost de mic
[Radio] INFO Genre drift detected: seed= vs current= (similarity: 0%)
[Radio] INFO Adaptive re-anchoring: genre drift detected
[Radio] INFO -- Now Playing: Vasile Pandelescu - Suparat am fost de mic
... (repeats infinitely)
```

---

## 🔍 Root Cause

### Issue 1: Duplicate Functions

Two versions of `calculateGenreSimilarity()` existed:

**Phase 4A version (line 476):**
```javascript
function calculateGenreSimilarity(keywords1, keywords2) {
  if (keywords1.length === 0 || keywords2.length === 0) {
    return 0.5; // Neutral if no keywords ✅ CORRECT
  }
  // ... Jaccard similarity
}
```

**Phase 4C version (line 862):**
```javascript
function calculateGenreSimilarity(genres1, genres2) {
  if (!genres1.length || !genres2.length) return 0; // ❌ WRONG
  // ... Jaccard similarity
}
```

**Problem:** Phase 4C version overwrote Phase 4A version, returning `0` instead of `0.5` when no genres found.

### Issue 2: False Drift Detection

When tracks have no genre keywords in metadata:
1. `extractGenreKeywords()` returns empty arrays `[]`
2. `calculateGenreSimilarity([], [])` returns `0` (0% similarity)
3. Drift detection triggers (0% < 30% threshold)
4. Radio re-anchors to seed
5. Seed track also has no keywords → same result
6. **Infinite loop!**

### Issue 3: Poor Metadata

Many tracks (especially Romanian folk music) don't have genre keywords in title/author:
- "Vasile Pandelescu - Suparat am fost de mic" → No genre keywords
- "Dan Ciotoi & Generci Band - S-a Rupt Lantul De Iubire" → No genre keywords

---

## ✅ Solution

### 1. Remove Duplicate Functions

Removed duplicate `extractGenreKeywords()` and `calculateGenreSimilarity()` from Phase 4A section.

Kept only Phase 4C versions with improved logic.

### 2. Fix calculateGenreSimilarity()

**Before:**
```javascript
function calculateGenreSimilarity(genres1, genres2) {
  if (!genres1.length || !genres2.length) return 0; // ❌ Triggers false drift
  // ...
}
```

**After:**
```javascript
function calculateGenreSimilarity(genres1, genres2) {
  // If either has no genres, return neutral similarity (50%)
  // This prevents false drift detection when metadata is poor
  if (!genres1 || !genres2 || !genres1.length || !genres2.length) {
    return 0.5; // ✅ Neutral - don't trigger drift
  }
  
  const set1 = new Set(genres1);
  const set2 = new Set(genres2);
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  // Avoid division by zero
  if (union.size === 0) return 0.5;
  
  return intersection.size / union.size;
}
```

### 3. Improved Genre Keywords

Added more Romanian-specific keywords:
```javascript
const genreKeywords = [
  // ... existing keywords ...
  "manele", "lautareasca", "populara", "acordeon" // ✅ Added
];
```

---

## 📊 Behavior Changes

### Before Fix:

**Scenario:** Track with no genre keywords
```
extractGenreKeywords("Vasile Pandelescu - Suparat am fost de mic")
→ []

calculateGenreSimilarity([], [])
→ 0 (0% similarity)

detectGenreDrift()
→ true (0% < 30% threshold)

Result: Re-anchor → Same track → Infinite loop ❌
```

### After Fix:

**Scenario:** Track with no genre keywords
```
extractGenreKeywords("Vasile Pandelescu - Suparat am fost de mic")
→ []

calculateGenreSimilarity([], [])
→ 0.5 (50% similarity - neutral)

detectGenreDrift()
→ false (50% >= 30% threshold)

Result: Continue normal playback ✅
```

---

## 🎯 Expected Behavior

### With Genre Keywords:
```
Track 1: "Manele Hit 2024" → ["manele"]
Track 2: "Pop Song" → ["pop"]

Similarity: 0% (no common keywords)
Drift detected: YES ✅
Re-anchor: YES ✅
```

### Without Genre Keywords:
```
Track 1: "Vasile Pandelescu - Song" → []
Track 2: "Dan Ciotoi - Song" → []

Similarity: 50% (neutral - no data)
Drift detected: NO ✅
Continue playback: YES ✅
```

### Mixed:
```
Track 1: "Manele Hit" → ["manele"]
Track 2: "Vasile Pandelescu - Song" → []

Similarity: 50% (neutral - one has no data)
Drift detected: NO ✅
Continue playback: YES ✅
```

---

## 🧪 Testing

### Test Case 1: Tracks with Keywords
```javascript
const track1 = { basic_info: { title: "Manele Hit", author: "Artist" } };
const track2 = { basic_info: { title: "Pop Song", author: "Singer" } };

const genres1 = extractGenreKeywords(track1); // ["manele"]
const genres2 = extractGenreKeywords(track2); // ["pop"]
const similarity = calculateGenreSimilarity(genres1, genres2); // 0

// Expected: Drift detected (0% < 30%)
```

### Test Case 2: Tracks without Keywords
```javascript
const track1 = { basic_info: { title: "Vasile Pandelescu - Song", author: "Artist" } };
const track2 = { basic_info: { title: "Dan Ciotoi - Song", author: "Singer" } };

const genres1 = extractGenreKeywords(track1); // []
const genres2 = extractGenreKeywords(track2); // []
const similarity = calculateGenreSimilarity(genres1, genres2); // 0.5

// Expected: NO drift detected (50% >= 30%)
```

### Test Case 3: Mixed
```javascript
const track1 = { basic_info: { title: "Manele Hit", author: "Artist" } };
const track2 = { basic_info: { title: "Vasile Pandelescu - Song", author: "Singer" } };

const genres1 = extractGenreKeywords(track1); // ["manele"]
const genres2 = extractGenreKeywords(track2); // []
const similarity = calculateGenreSimilarity(genres1, genres2); // 0.5

// Expected: NO drift detected (50% >= 30%)
```

---

## 📝 Additional Improvements

### 1. Better Logging
```javascript
logger.info(`Genre drift detected: seed=${seedGenre.join(", ") || "none"} vs current=${currentGenre.join(", ") || "none"} (similarity: ${Math.round(similarity * 100)}%)`);
```

Now shows "none" instead of empty string when no genres.

### 2. Neutral Similarity Philosophy

**Principle:** When we don't have enough data (no genre keywords), we should **not** assume drift.

**Rationale:**
- Missing data ≠ Different genres
- Better to continue playback than loop infinitely
- Genre drift is for **detected** differences, not **missing** data

### 3. Threshold Still Works

With 30% threshold:
- 0% similarity → Drift detected ✅
- 50% similarity → No drift ✅
- 100% similarity → No drift ✅

The fix doesn't disable drift detection, it just handles missing data correctly.

---

## 🔄 Backward Compatibility

✅ **No breaking changes**

- Tracks with genre keywords: Same behavior
- Tracks without keywords: Fixed behavior (no more loops)
- Drift detection threshold: Unchanged (30%)
- All existing presets: Work correctly

---

## 📊 Impact

### Before Fix:
- ❌ Infinite loops with tracks lacking genre keywords
- ❌ Poor experience with Romanian folk music
- ❌ False drift detection
- ❌ Same track repeating

### After Fix:
- ✅ No infinite loops
- ✅ Smooth playback for all genres
- ✅ Accurate drift detection
- ✅ Normal track progression

---

## 🚀 Deployment

### For Existing Installations:
1. Update `index.js` with the fix
2. Restart radio: `node backend/server.js`
3. Test with tracks that previously looped

### For New Installations:
Fix is already included in backup v2.5.1+

---

## 📝 Lessons Learned

1. **Avoid duplicate functions** - Use single source of truth
2. **Handle missing data gracefully** - Don't assume worst case
3. **Test edge cases** - Tracks without metadata
4. **Log meaningful data** - Show "none" instead of empty
5. **Neutral is better than wrong** - 50% > 0% for missing data

---

**Fix Date:** April 17, 2026  
**Status:** ✅ COMPLETE  
**Impact:** Critical bug fix - prevents infinite loops
