# FFmpeg Installation Guide

**Error:** `spawn ffmpeg ENOENT` or `ffmpeg exited with code -4058`  
**Cause:** FFmpeg is not installed or not in system PATH  
**Status:** ⚠️ REQUIRED DEPENDENCY

---

## 🎯 Quick Fix

FFmpeg is **required** for YT Radio to work. Install it using one of the methods below:

---

## 📦 Installation Methods

### Windows

#### Method 1: Chocolatey (Recommended)
```powershell
# Install Chocolatey if not already installed
# Visit: https://chocolatey.org/install

# Install FFmpeg
choco install ffmpeg

# Verify installation
ffmpeg -version
```

#### Method 2: Scoop
```powershell
# Install Scoop if not already installed
# Visit: https://scoop.sh

# Install FFmpeg
scoop install ffmpeg

# Verify installation
ffmpeg -version
```

#### Method 3: Manual Installation
1. Download FFmpeg from: https://www.gyan.dev/ffmpeg/builds/
2. Extract the ZIP file (e.g., to `C:\ffmpeg`)
3. Add to PATH:
   - Open System Properties → Environment Variables
   - Edit "Path" variable
   - Add: `C:\ffmpeg\bin`
   - Click OK
4. **Restart terminal/PowerShell**
5. Verify: `ffmpeg -version`

---

### Linux

#### Ubuntu/Debian:
```bash
sudo apt update
sudo apt install ffmpeg

# Verify installation
ffmpeg -version
```

#### Fedora/RHEL:
```bash
sudo dnf install ffmpeg

# Verify installation
ffmpeg -version
```

#### Arch Linux:
```bash
sudo pacman -S ffmpeg

# Verify installation
ffmpeg -version
```

---

### macOS

#### Homebrew (Recommended):
```bash
# Install Homebrew if not already installed
# Visit: https://brew.sh

# Install FFmpeg
brew install ffmpeg

# Verify installation
ffmpeg -version
```

#### MacPorts:
```bash
sudo port install ffmpeg

# Verify installation
ffmpeg -version
```

---

## ✅ Verify Installation

After installing FFmpeg, verify it's working:

```bash
# Check FFmpeg version
ffmpeg -version

# Should output something like:
# ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers
# ...
```

---

## 🔄 Restart Required

**Important:** After installing FFmpeg:
1. **Close all terminal/PowerShell windows**
2. **Restart your IDE/editor** (if using one)
3. **Restart the backend:** `node backend/server.js`

---

## 🐛 Troubleshooting

### Issue: "ffmpeg: command not found" or "spawn ffmpeg ENOENT"

**Solution:**
1. Verify FFmpeg is installed: `ffmpeg -version`
2. If not found, install using methods above
3. Restart terminal/PowerShell
4. Restart backend

### Issue: FFmpeg installed but still not found

**Solution (Windows):**
1. Check PATH environment variable:
   ```powershell
   $env:Path -split ';' | Select-String ffmpeg
   ```
2. If not in PATH, add manually:
   - System Properties → Environment Variables
   - Edit "Path"
   - Add FFmpeg bin directory
   - **Restart terminal**

**Solution (Linux/macOS):**
1. Check PATH:
   ```bash
   echo $PATH | grep ffmpeg
   ```
2. Find FFmpeg location:
   ```bash
   which ffmpeg
   ```
3. If not in PATH, add to `~/.bashrc` or `~/.zshrc`:
   ```bash
   export PATH="/path/to/ffmpeg/bin:$PATH"
   ```
4. Reload shell: `source ~/.bashrc`

### Issue: Permission denied

**Solution (Linux/macOS):**
```bash
# Make FFmpeg executable
sudo chmod +x /usr/local/bin/ffmpeg
```

---

## 📊 Expected Behavior

### Before FFmpeg Installation:
```
[Radio Error] ERROR Radio pipeline error: Error: spawn ffmpeg ENOENT
[Radio Error] ERROR Radio pipeline error: Error: ffmpeg exited with code -4058
```

### After FFmpeg Installation:
```
[Radio] INFO -- Now Playing: Artist - Song Title
[Radio] INFO Up next: Artist - Next Song
[Radio] INFO Radio is streaming on port 8080
```

---

## 🎵 Why FFmpeg is Required

FFmpeg is used for:
- **Audio transcoding** - Convert YouTube audio to MP3
- **Bitrate control** - Ensure consistent 192kbps or 320kbps
- **Format conversion** - Handle various audio formats
- **Stream processing** - Apply audio filters (fade in/out)
- **Metadata handling** - ICY metadata for radio clients

Without FFmpeg, the radio **cannot stream audio**.

---

## 📝 Alternative: yt-dlp Backend

If you cannot install FFmpeg, you can use yt-dlp backend (less reliable):

1. Install yt-dlp:
   ```bash
   # Windows (Chocolatey)
   choco install yt-dlp
   
   # Linux/macOS
   pip install yt-dlp
   ```

2. Edit `config.js` or set environment variable:
   ```bash
   PLAYBACK_BACKEND=yt-dlp
   ```

3. Restart backend

**Note:** yt-dlp backend is less stable and not recommended for production.

---

## 🚀 Quick Start After Installation

1. Install FFmpeg (see methods above)
2. Verify: `ffmpeg -version`
3. Restart terminal
4. Start backend: `node backend/server.js`
5. Open browser: http://localhost:3000
6. Enjoy your radio! 🎵

---

## 📞 Still Having Issues?

If FFmpeg is installed but radio still doesn't work:

1. Check FFmpeg version: `ffmpeg -version`
2. Check PATH: `echo $PATH` (Linux/macOS) or `$env:Path` (Windows)
3. Restart terminal and backend
4. Check radio logs for other errors
5. Report issue with:
   - OS and version
   - FFmpeg version
   - Installation method
   - Full error log

---

**Installation Date:** April 17, 2026  
**Status:** ⚠️ REQUIRED DEPENDENCY  
**Priority:** HIGH
