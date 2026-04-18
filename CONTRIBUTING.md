# Contributing to YT Radio

Thank you for your interest in contributing to YT Radio! This document provides guidelines and instructions for contributing.

## 🤝 How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/yourusername/yt-radio/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - System information (OS, Node version)
   - Logs (if applicable)

### Suggesting Features

1. Check [Discussions](https://github.com/yourusername/yt-radio/discussions) for similar ideas
2. Create a new discussion with:
   - Clear description of the feature
   - Use cases and benefits
   - Possible implementation approach

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Test thoroughly
5. Commit with clear messages: `git commit -m 'Add amazing feature'`
6. Push to your fork: `git push origin feature/amazing-feature`
7. Open a Pull Request

## 📝 Code Style

### JavaScript
- Use 2 spaces for indentation
- Use semicolons
- Use `const` and `let`, avoid `var`
- Use async/await over callbacks
- Add JSDoc comments for functions
- Follow existing code patterns

### Example:
```javascript
/**
 * Fetches track information from YouTube
 * @param {string} videoId - YouTube video ID
 * @returns {Promise<Object>} Track information
 */
async function getTrackInfo(videoId) {
  const track = await getMusicTrack(videoId);
  return track.basic_info;
}
```

### HTML/CSS
- Use semantic HTML5 elements
- Mobile-first responsive design
- Use CSS variables for theming
- Keep styles in `<style>` tag for simplicity

## 🧪 Testing

Before submitting a PR:

1. **Test manually:**
   - Start backend: `node backend/server.js`
   - Test all affected features
   - Check console for errors
   - Test on mobile (if UI changes)

2. **Check logs:**
   - No errors in console
   - No warnings (except deprecation)
   - Proper logging for new features

3. **Test edge cases:**
   - Empty states
   - Error conditions
   - Network failures
   - Invalid inputs

## 📋 Commit Messages

Use clear, descriptive commit messages:

### Format:
```
<type>: <subject>

<body>

<footer>
```

### Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding tests
- `chore`: Maintenance tasks

### Examples:
```
feat: add search functionality to presets

- Add search input to preset list
- Filter presets by name and group
- Update UI to show filtered results

Closes #123
```

```
fix: resolve rate limiting issues

- Add retry logic with exponential backoff
- Implement request queue
- Add rate limit detection

Fixes #456
```

## 🏗️ Project Structure

```
yt-radio/
├── backend/           # Backend server
│   ├── db/           # Database (JSON files)
│   ├── public/       # Frontend (dashboard)
│   └── server.js     # Express server
├── config.js         # Configuration
├── index.js          # Radio server
├── logger.js         # Logging
├── radio-broadcaster.js  # Streaming
└── radio-presets.json    # Presets
```

## 🎯 Areas for Contribution

### High Priority
- [ ] Search & filter functionality
- [ ] Export/Import data
- [ ] Advanced statistics
- [ ] Playlist manager
- [ ] Performance optimizations

### Medium Priority
- [ ] Keyboard shortcuts
- [ ] Theme customization
- [ ] Preset scheduling
- [ ] Lyrics display
- [ ] PWA features

### Low Priority
- [ ] Social features
- [ ] Voice control
- [ ] Audio visualizer
- [ ] Multi-room sync

## 📚 Resources

- [Node.js Documentation](https://nodejs.org/docs/)
- [Express.js Guide](https://expressjs.com/en/guide/routing.html)
- [YouTube API](https://developers.google.com/youtube/v3)
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)

## ❓ Questions?

- Open a [Discussion](https://github.com/yourusername/yt-radio/discussions)
- Join our community chat (if available)
- Check existing [Issues](https://github.com/yourusername/yt-radio/issues)

## 📜 Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on the issue, not the person
- Help others learn and grow

## 🎉 Recognition

Contributors will be:
- Listed in README.md
- Mentioned in release notes
- Credited in commit history

Thank you for contributing to YT Radio! 🎵
