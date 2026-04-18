# yt-dlp Installation Guide

**Status:** ⚠️ OPTIONAL (but recommended for Phase 4C)  
**Required for:** External source integration (YouTube Trending, Charts)  
**Alternative:** Can work without it (limited functionality)

---

## 🎯 Quick Answer

**Best Method by Platform:**
- **Windows:** Chocolatey or Scoop (easiest)
- **Linux:** Package manager (apt, dnf, pacman)
- **macOS:** Homebrew
- **All platforms:** pip (Python package manager)

---

## 📦 Installation Methods

### Windows (Recommended: Chocolatey)

#### Method 1: Chocolatey ⭐ RECOMMENDED
```powershell
# Install Chocolatey if not already installed
# Visit: https://chocolatey.org/install

# Install yt-dlp
choco install yt-dlp

# Verify installation
yt-dlp --version
```

**Pros:**
- ✅ Automatic updates via `choco upgrade yt-dlp`
- ✅ Adds to PATH automatically
- ✅ Easy to uninstall
- ✅ Most reliable on Windows

---

#### Method 2: Scoop
```powershell
# Install Scoop if not already installed
# Visit: https://scoop.sh

# Install yt-dlp
scoop install yt-dlp

# Verify installation
yt-dlp --version
```

**Pros:**
- ✅ Clean installation
- ✅ Easy updates via `scoop update yt-dlp`
- ✅ No admin rights needed

---

#### Method 3: pip (Python)
```powershell
# Requires Python 3.7+
# Install Python from: https://www.python.org/downloads/

# Install yt-dlp
pip install yt-dlp

# Or upgrade if already installed
pip install --upgrade yt-dlp

# Verify installation
yt-dlp --version
```

**Pros:**
- ✅ Works on all platforms
- ✅ Easy to update
- ✅ Official method

**Cons:**
- ⚠️ Requires Python installed
- ⚠️ May need to add Python Scripts to PATH

---

#### Method 4: Direct Download (Not Recommended)
```powershell
# Download from: https://github.com/yt-dlp/yt-dlp/releases
# Get: yt-dlp.exe

# Place in a folder (e.g., C:\yt-dlp\)
# Add folder to PATH manually
```

**Pros:**
- ✅ No dependencies

**Cons:**
- ❌ Manual updates
- ❌ Manual PATH configuration
- ❌ More complex

---

### Linux

#### Ubuntu/Debian ⭐ RECOMMENDED
```bash
# Method 1: Official PPA (most up-to-date)
sudo add-apt-repository ppa:tomtomtom/yt-dlp
sudo apt update
sudo apt install yt-dlp

# Method 2: pip (if PPA not available)
sudo apt install python3-pip
pip3 install yt-dlp

# Verify installation
yt-dlp --version
```

---

#### Fedora/RHEL/CentOS
```bash
# Method 1: DNF (Fedora 33+)
sudo dnf install yt-dlp

# Method 2: pip
sudo dnf install python3-pip
pip3 install yt-dlp

# Verify installation
yt-dlp --version
```

---

#### Arch Linux
```bash
# Official repository
sudo pacman -S yt-dlp

# Verify installation
yt-dlp --version
```

---

#### Universal (any Linux)
```bash
# Using pip (works on all distributions)
pip3 install yt-dlp

# Or with sudo for system-wide install
sudo pip3 install yt-dlp

# Verify installation
yt-dlp --version
```

---

### macOS

#### Homebrew ⭐ RECOMMENDED
```bash
# Install Homebrew if not already installed
# Visit: https://brew.sh

# Install yt-dlp
brew install yt-dlp

# Verify installation
yt-dlp --version
```

**Pros:**
- ✅ Easiest method on macOS
- ✅ Automatic updates via `brew upgrade yt-dlp`
- ✅ Clean installation

---

#### pip (Alternative)
```bash
# Install pip if not available
python3 -m ensurepip --upgrade

# Install yt-dlp
pip3 install yt-dlp

# Verify installation
yt-dlp --version
```

---

#### MacPorts
```bash
sudo port install yt-dlp

# Verify installation
yt-dlp --version
```

---

## ✅ Verify Installation

After installing, verify yt-dlp is working:

```bash
# Check version
yt-dlp --version

# Should output something like:
# 2024.04.09

# Test download (audio only, no actual download)
yt-dlp --simulate --print title "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Should output the video title
```

---

## 🔄 Update yt-dlp

yt-dlp is frequently updated. Keep it current:

### Windows (Chocolatey):
```powershell
choco upgrade yt-dlp
```

### Windows (Scoop):
```powershell
scoop update yt-dlp
```

### Windows/Linux/macOS (pip):
```bash
pip install --upgrade yt-dlp
```

### Linux (apt):
```bash
sudo apt update
sudo apt upgrade yt-dlp
```

### macOS (Homebrew):
```bash
brew upgrade yt-dlp
```

---

## 🐛 Troubleshooting

### Issue: "yt-dlp: command not found"

**Windows:**
```powershell
# Check if in PATH
where.exe yt-dlp

# If not found, reinstall with Chocolatey or Scoop
```

**Linux/macOS:**
```bash
# Check if in PATH
which yt-dlp

# If installed via pip, add to PATH:
export PATH="$HOME/.local/bin:$PATH"

# Add to ~/.bashrc or ~/.zshrc for permanent
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

### Issue: "pip: command not found"

**Windows:**
```powershell
# Install Python from: https://www.python.org/downloads/
# Make sure to check "Add Python to PATH" during installation
```

**Linux:**
```bash
# Ubuntu/Debian
sudo apt install python3-pip

# Fedora
sudo dnf install python3-pip

# Arch
sudo pacman -S python-pip
```

**macOS:**
```bash
# Install pip
python3 -m ensurepip --upgrade
```

---

### Issue: Permission denied (Linux/macOS)

```bash
# Install for current user only (no sudo)
pip3 install --user yt-dlp

# Or use sudo for system-wide
sudo pip3 install yt-dlp
```

---

### Issue: Old version installed

```bash
# Force reinstall latest version
pip3 install --upgrade --force-reinstall yt-dlp
```

---

## 🎯 Recommended Method by Use Case

### Personal Use (Home PC):
**Windows:** Chocolatey  
**Linux:** Package manager (apt, dnf, pacman)  
**macOS:** Homebrew

**Why:** Easy installation, automatic updates, clean uninstall

---

### Server/VPS:
**All platforms:** pip

**Why:** 
- Works everywhere
- No GUI package manager needed
- Easy to script
- Consistent across platforms

---

### Docker/Container:
```dockerfile
# In Dockerfile
RUN pip3 install yt-dlp
```

**Why:** Reproducible, version-controlled

---

### Development:
**All platforms:** pip with virtual environment

```bash
# Create virtual environment
python3 -m venv venv

# Activate
source venv/bin/activate  # Linux/macOS
venv\Scripts\activate     # Windows

# Install yt-dlp
pip install yt-dlp
```

**Why:** Isolated from system Python, easy to manage versions

---

## 📊 Comparison Table

| Method | Windows | Linux | macOS | Updates | Ease |
|--------|---------|-------|-------|---------|------|
| **Chocolatey** | ✅ Best | ❌ | ❌ | Auto | ⭐⭐⭐⭐⭐ |
| **Scoop** | ✅ Good | ❌ | ❌ | Auto | ⭐⭐⭐⭐⭐ |
| **Homebrew** | ❌ | ❌ | ✅ Best | Auto | ⭐⭐⭐⭐⭐ |
| **apt/dnf/pacman** | ❌ | ✅ Best | ❌ | Auto | ⭐⭐⭐⭐⭐ |
| **pip** | ✅ Good | ✅ Good | ✅ Good | Manual | ⭐⭐⭐⭐ |
| **Direct Download** | ✅ Works | ✅ Works | ✅ Works | Manual | ⭐⭐ |

---

## 🔧 YT Radio Integration

### Where yt-dlp is Used:

**Phase 4C - External Source Integration:**
- Fetching YouTube Trending music videos
- Fetching YouTube Charts
- Extracting playlist information

**Code Location:**
```javascript
// index.js - Phase 4C
async function fetchYouTubeTrending(region = "RO") {
  const command = `yt-dlp --flat-playlist --print "%(id)s|%(title)s|%(uploader)s" ...`;
  // ...
}
```

---

### If yt-dlp is Not Installed:

**Impact:**
- ⚠️ External source integration won't work
- ⚠️ YouTube Trending fetch will fail
- ⚠️ YouTube Charts fetch will fail
- ✅ Radio will still work (uses youtubei.js for main playback)
- ✅ All other features work normally

**Workaround:**
- Radio works fine without yt-dlp
- Phase 4C features are optional
- Can be installed later when needed

---

## 📝 Post-Installation

### 1. Verify Installation:
```bash
yt-dlp --version
```

### 2. Test with YT Radio:
```bash
# Start backend
node backend/server.js

# Trigger manual seed pool refresh
curl -X POST http://localhost:8080/seed-pool-refresh

# Check logs for yt-dlp usage
```

### 3. Check Seed Pool:
```bash
# View external seeds
curl http://localhost:8080/seed-pool | jq '.external'
```

---

## 🚀 Quick Start Summary

### Windows (Easiest):
```powershell
choco install yt-dlp
yt-dlp --version
```

### Linux (Easiest):
```bash
sudo apt install yt-dlp  # Ubuntu/Debian
yt-dlp --version
```

### macOS (Easiest):
```bash
brew install yt-dlp
yt-dlp --version
```

### Universal (All Platforms):
```bash
pip3 install yt-dlp
yt-dlp --version
```

---

## 💡 Pro Tips

### 1. Keep Updated
```bash
# Check for updates weekly
yt-dlp --version

# Update regularly (YouTube changes frequently)
pip3 install --upgrade yt-dlp
```

### 2. Configuration File
```bash
# Create config file (optional)
# ~/.config/yt-dlp/config (Linux/macOS)
# %APPDATA%\yt-dlp\config.txt (Windows)

# Example config:
--no-playlist
--extract-audio
--audio-format mp3
```

### 3. Test Before Using
```bash
# Test download (simulate only)
yt-dlp --simulate "https://www.youtube.com/watch?v=VIDEO_ID"
```

---

## 📞 Still Having Issues?

### Check Installation:
```bash
# Windows
where.exe yt-dlp

# Linux/macOS
which yt-dlp

# Check Python version (if using pip)
python3 --version  # Should be 3.7+
```

### Common Solutions:
1. **Restart terminal** after installation
2. **Check PATH** environment variable
3. **Reinstall** with recommended method
4. **Update pip** first: `pip3 install --upgrade pip`
5. **Use sudo** on Linux/macOS if permission denied

---

## 🎯 Recommendation

**For YT Radio users:**

1. **Windows:** Use **Chocolatey** (easiest, most reliable)
2. **Linux:** Use **package manager** (apt, dnf, pacman)
3. **macOS:** Use **Homebrew** (standard on macOS)
4. **All platforms:** **pip** works everywhere (good fallback)

**Priority:** Medium (optional for Phase 4C, not required for core functionality)

---

**Document Date:** April 17, 2026  
**Status:** ✅ COMPLETE  
**Priority:** OPTIONAL (recommended for Phase 4C)
