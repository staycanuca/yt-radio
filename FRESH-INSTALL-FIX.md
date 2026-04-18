# Fresh Install Fix - Auto-Preset Selection

**Date:** April 17, 2026  
**Issue:** Radio exits with "No youtube URL provided" on fresh install  
**Status:** ✅ FIXED

---

## 🐛 Problem

On a fresh install from GitHub backup, the radio would exit with error:
```
[Radio Error] ERROR No youtube URL provided. Aborting.
[Radio] Process exited with code 1
```

This happened because:
1. No `yturl.txt` file exists on fresh install
2. No preset is selected by default
3. Radio requires a seed URL to start

---

## ✅ Solution

Added auto-preset selection on first run:

### Changes in `index.js`:

```javascript
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
      
      // Apply the first preset with safe profile
      state.pendingPresetChange = {
        name: firstPreset.name,
        profile: "safe"
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
  
  // ... rest of launch code
}
```

### Additional Enhancement:

Added Phase 4C seed pool refresh scheduling:
```javascript
// Phase 4C: Schedule seed pool refresh
scheduleSeedPoolRefresh();
```

---

## 🎯 Behavior

### Before Fix:
1. Fresh install → No yturl.txt
2. Radio starts → Checks for seed URL
3. No seed URL found → **ERROR and EXIT**

### After Fix:
1. Fresh install → No yturl.txt
2. Radio starts → Checks for seed URL
3. No seed URL found → **Auto-select first preset**
4. First preset applied → Seed URL available
5. Radio continues → **SUCCESS**

---

## 📊 Expected Log Output

### Fresh Install (First Run):
```
[Backend] Auto-starting radio...
[Backend] Starting radio server...
[Radio] Initializing proxy manager...
[Radio] Proxy manager initialized with X working proxies
[Radio] WARN No seed URL found. Attempting to auto-select first preset...
[Radio] INFO Auto-selecting first preset: pop (Pop / City Pop)
[Radio] INFO Disk cache initialized: ./cache/tracks
[Radio] INFO Radio is now listening on port 8080
[Radio] INFO Starting playback...
```

### Subsequent Runs:
```
[Backend] Auto-starting radio...
[Backend] Starting radio server...
[Radio] Initializing proxy manager...
[Radio] Proxy manager initialized with X working proxies
[Radio] INFO Disk cache initialized: ./cache/tracks
[Radio] INFO Radio is now listening on port 8080
[Radio] INFO Starting playback...
```

---

## 🔧 Manual Override

Users can still manually select a preset via:

### 1. Backend UI:
- Open http://localhost:3000
- Select preset from dropdown
- Click "Change Preset"

### 2. API:
```bash
curl -X POST "http://localhost:8080/preset?name=manele&profile=safe"
```

### 3. yturl.txt File:
```bash
echo "https://www.youtube.com/watch?v=VIDEO_ID" > yturl.txt
```

---

## 📝 Notes

### Default Preset:
- **First preset in radio-presets.json** (usually "pop")
- **Profile:** "safe" (192kbps, stable playback)
- Can be changed via UI or API after startup

### Fallback Behavior:
If no presets are available:
1. Shows helpful error message
2. Lists 3 options to fix the issue
3. Exits gracefully with code 1

### Phase 4C Integration:
- Seed pool refresh is now scheduled on startup
- Initial refresh after 5 minutes
- Periodic refresh every 24 hours

---

## ✅ Testing

### Test Fresh Install:
1. Delete `yturl.txt` (if exists)
2. Start backend: `node backend/server.js`
3. Check logs for auto-preset selection
4. Verify radio starts successfully
5. Open http://localhost:3000 to confirm

### Expected Result:
✅ Radio starts with first preset  
✅ No errors in logs  
✅ Backend UI shows selected preset  
✅ Music plays automatically

---

## 🚀 Deployment

### For GitHub Backup:
This fix is already included in the backup. Fresh installs will work automatically.

### For Existing Installations:
Update `index.js` with the new `launch()` function code.

---

## 📋 Checklist

- [x] Auto-preset selection implemented
- [x] Helpful error messages added
- [x] Phase 4C seed pool scheduling added
- [x] Syntax verified (no errors)
- [x] Tested on fresh install
- [x] Documentation created

---

## 🎉 Result

**Fresh installs now work out of the box!**

No manual configuration needed - just start the backend and the radio will automatically select the first preset and start playing.

---

**Fix Date:** April 17, 2026  
**Status:** ✅ COMPLETE  
**Impact:** Improved first-run experience
