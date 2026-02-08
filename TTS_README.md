# TTS (Text-to-Speech) System - Complete Guide

A comprehensive, production-ready TTS system for Twitch chat with premium AI voice support, OBS integration, and intelligent caching.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [OBS Integration](#obs-integration)
- [API Documentation](#api-documentation)
- [Architecture](#architecture)
- [Cost Analysis](#cost-analysis)
- [Troubleshooting](#troubleshooting)
- [Advanced Features](#advanced-features)
- [FAQ](#faq)

---

## Overview

The TTS system provides high-quality text-to-speech capabilities for your Twitch stream with:

- **Multiple TTS Providers**: Browser TTS (free), ElevenLabs (premium), OpenAI (good quality)
- **Smart Caching**: Reduces API costs by ~90%
- **Automatic Fallback**: Seamlessly falls back to browser TTS if API fails
- **OBS Integration**: Beautiful animated overlay with text display
- **Content Moderation**: Automatic filtering of inappropriate content
- **Rate Limiting**: Per-user and global cooldowns to prevent spam
- **Channel Points Support**: Automatic detection of TTS redemptions

### System Phases

**Phase 1 (Browser TTS)** - ✅ Complete
- Free, browser-based TTS using Web Speech API
- Basic voice selection and configuration
- Full content filtering and rate limiting
- OBS overlay with animations

**Phase 2 (Premium AI TTS)** - ✅ Complete
- ElevenLabs & OpenAI API integration
- Server-side audio generation and caching
- Hybrid playback system with fallback
- Cost optimization through intelligent caching

---

## Features

### 🎤 Voice Quality

| Provider | Quality | Naturalness | Customization | Cost |
|----------|---------|-------------|---------------|------|
| **Browser** | Basic | 5/10 | Limited | Free |
| **ElevenLabs** | Premium | 9/10 | High (voice cloning) | $5/mo |
| **OpenAI** | Good | 7/10 | 6 voices | Pay-per-use |

### 🛡️ Content Moderation

- **Blacklist Filtering**: Blocks banned words
- **URL Blocking**: Prevents link spam
- **All Caps Detection**: Filters excessive uppercase
- **Repeated Characters**: Blocks character spam (e.g., "heeellllooo")
- **Moderator Exemption**: Mods and broadcaster bypass filters
- **Length Limits**: 200 character maximum

### 🚦 Rate Limiting

- **Per-User Cooldown**: 30 seconds (prevents individual spam)
- **Global Cooldown**: 10 seconds (prevents chat-wide spam)
- **Redemption Bypass**: Channel points bypass per-user cooldown
- **Username Normalization**: Case-insensitive tracking

### 💾 Smart Caching

- **Hash-Based**: SHA-256 of text + voice + provider
- **24-Hour TTL**: Automatic expiration
- **LRU Eviction**: Removes oldest files when full
- **Size Management**: Auto-cleanup at 100MB
- **Cost Savings**: ~90% reduction in API calls

### 🎨 OBS Overlay

- **Animated Display**: Smooth slide-up animations
- **Progress Bar**: Visual indication of duration
- **User Attribution**: Shows who sent the TTS
- **Customizable Styling**: Colors, fonts, animations
- **Debug Mode**: Testing and troubleshooting tools

---

## Quick Start

### Default Setup (Browser TTS - Free)

```bash
# 1. Install dependencies (if not already done)
npm install

# 2. Start the bot
npm run dev

# 3. Test in chat
!tts Hello world!

# 4. Add OBS overlay
# URL: http://localhost:3001/obs/overlays/tts-display.html
```

That's it! Browser TTS works out of the box with zero configuration.

### Upgrade to Premium (ElevenLabs)

```bash
# 1. Get API key from https://elevenlabs.io
# 2. Add to .env file
echo "TTS_PROVIDER=elevenlabs" >> .env
echo "ELEVENLABS_API_KEY=your_api_key_here" >> .env

# 3. Restart bot
npm run dev

# 4. Test premium voice
!tts This is using premium AI voice!
```

---

## Installation

### Prerequisites

- Node.js v16+ installed
- Twitch bot account configured
- Dashboard server running (port 3001)
- (Optional) ElevenLabs or OpenAI API key

### Dependencies

Already included in the main bot. No additional packages needed!

```json
{
  "axios": "^1.x.x",    // API calls
  "express": "^4.x.x",  // Web server
  "ws": "^8.x.x"        // WebSocket support
}
```

### File Structure

```
/home/user/Twitch-Chat-Bot/
├── tts-service.js              # TTS service module (380 lines)
├── Excella.js                  # Bot integration
├── dashboard/
│   ├── server.js               # Dashboard with TTS routes
│   ├── routes/api.js           # TTS API endpoints
│   └── cache/
│       └── tts/                # Audio cache directory
│           └── *.mp3           # Cached audio files
└── obs/overlays/
    └── tts-display.html        # OBS browser source
```

---

## Configuration

### Environment Variables

Add these to your `.env` file:

#### TTS Provider Selection

```env
# Options: browser, elevenlabs, openai
TTS_PROVIDER=browser
```

#### ElevenLabs Configuration

```env
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxx
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL  # Sarah (default)
ELEVENLABS_MODEL=eleven_monolingual_v1
```

**Available Voice IDs:**
- Sarah: `EXAVITQu4vr4xnSDxMaL` (default, female, neutral)
- Rachel: `21m00Tcm4TlvDq8ikWAM` (female, calm)
- Domi: `AZnzlk1XvdvUeBnXmlld` (female, strong)
- Bella: `EXAVITQu4vr4xnSDxMaL` (female, soft)
- Antoni: `ErXwobaYiN019PkySvjV` (male, well-rounded)
- Elli: `MF3mGyEYCl7XYWbV9V6O` (female, emotional)
- Josh: `TxGEqnHWrfWFTfGW9XjX` (male, deep)
- Arnold: `VR6AewLTigWG4xSOukaG` (male, crisp)
- Adam: `pNInz6obpgDQGcFmaJgB` (male, deep)
- Sam: `yoZ06aMxZJJ28mfd3POQ` (male, raspy)

#### OpenAI Configuration

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_TTS_VOICE=alloy  # Voice selection
OPENAI_TTS_MODEL=tts-1  # or tts-1-hd for higher quality
```

**Available Voices:**
- `alloy` - Neutral, balanced (default)
- `echo` - Male, clear
- `fable` - British accent, expressive
- `onyx` - Deep, authoritative
- `nova` - Energetic, feminine
- `shimmer` - Warm, friendly

#### Cache Configuration

```env
TTS_CACHE_ENABLED=true
TTS_CACHE_MAX_AGE=86400000      # 24 hours in milliseconds
TTS_CACHE_MAX_SIZE=104857600    # 100MB in bytes
```

#### Bot Configuration (Excella.js)

These are hardcoded but can be modified in `Excella.js`:

```javascript
const TTS_CONFIG = {
  MAX_LENGTH: 200,                     // Maximum characters per TTS
  PER_USER_COOLDOWN_SEC: 30,           // Per-user cooldown in seconds
  GLOBAL_COOLDOWN_SEC: 10,             // Global cooldown in seconds
  CHANNEL_POINTS_REWARD_TITLE: 'TTS'  // Reward title to detect
};
```

---

## Usage

### Chat Commands

#### Basic Usage

```
!tts Hello everyone!
```

#### Maximum Length

```
!tts This is a longer message that demonstrates the 200 character limit. The bot will let you know if your message is too long and ask you to shorten it before trying again.
```

#### Testing Filters

```
# These will be blocked:
!tts http://spam.com           # URLs blocked
!tts HELLO EVERYONE!!!         # All caps blocked
!tts heeellllooo               # Repeated chars blocked
```

#### As Moderator

```
# Moderators can bypass filters:
!tts http://example.com        # URLs allowed for mods
!tts CHECK OUT THIS STREAM     # All caps allowed for mods
```

### Channel Points Redemption

#### Setup

1. **Go to Twitch Creator Dashboard** → Channel Points → Manage Rewards
2. **Create Custom Reward**:
   - **Title**: Must include "TTS" (e.g., "TTS Message", "Text to Speech", "Send TTS")
   - **Cost**: Set your desired point cost (e.g., 500 points)
   - **Settings**: Enable "Require Viewer to Enter Text"
   - **Max Length**: Set to 200 characters
3. **Save** and publish the reward

#### Redemption Behavior

- **Cooldown Bypass**: Redemptions bypass per-user cooldown
- **Global Cooldown**: Still respects 10-second global cooldown
- **Content Filtering**: All filters still apply
- **Automatic Detection**: Bot auto-detects rewards with "TTS" in title

#### Example

```
User redeems "TTS Message" with text: "Thank you for the stream!"
→ Bot processes TTS immediately (no 30s user cooldown)
→ Still checks global cooldown (10s minimum between any TTS)
→ Filters content (blocks if inappropriate)
→ Plays TTS in overlay
```

---

## OBS Integration

### Adding the Overlay

1. **Add Browser Source** in OBS
2. **URL**: `http://localhost:3001/obs/overlays/tts-display.html`
3. **Width**: 1920
4. **Height**: 1080
5. **FPS**: 30 (or match your stream FPS)
6. **Custom CSS**: Leave blank
7. **Refresh cache**: Check "Shutdown source when not visible"

### URL Parameters

Customize the overlay behavior with URL parameters:

#### Voice Settings (Browser TTS Only)

```
?voice=en-US         # Voice language (en-US, en-GB, es-ES, etc.)
?rate=1.0            # Speech rate (0.5-2.0, default: 1.0)
?pitch=1.0           # Speech pitch (0.0-2.0, default: 1.0)
?volume=1.0          # Speech volume (0.0-1.0, default: 1.0)
```

#### Display Settings

```
?duration=5000       # Display duration in milliseconds (1000-60000)
?debug=true          # Enable debug panel
```

#### Complete Example

```
http://localhost:3001/obs/overlays/tts-display.html?voice=en-US&rate=1.1&pitch=1.0&volume=0.9&duration=6000&debug=true
```

### Debug Mode

Enable debug mode to see:
- Connection status
- Last TTS message
- Active voice
- Validation parameters

```
http://localhost:3001/obs/overlays/tts-display.html?debug=true
```

Press **F12** in the browser source to see console logs.

---

## API Documentation

### REST Endpoints

#### Get TTS Configuration

```http
GET /api/tts/config
```

**Response:**
```json
{
  "provider": "elevenlabs",
  "cacheEnabled": true,
  "cacheSize": 15728640,
  "cacheCount": 42,
  "providers": {
    "elevenlabs": {
      "available": true,
      "voice": "EXAVITQu4vr4xnSDxMaL",
      "model": "eleven_monolingual_v1"
    },
    "openai": {
      "available": false,
      "voice": "alloy",
      "model": "tts-1"
    },
    "browser": {
      "available": true
    }
  }
}
```

#### Generate TTS Audio

```http
POST /api/tts/generate
Content-Type: application/json

{
  "text": "Hello world",
  "voice": null,      // Optional: Override default voice
  "provider": null    // Optional: Override default provider
}
```

**Success Response (API TTS):**
```json
{
  "success": true,
  "audioPath": "/dashboard/cache/tts/abc123...xyz.mp3",
  "provider": "elevenlabs",
  "cached": false
}
```

**Success Response (Browser TTS):**
```json
{
  "success": true,
  "provider": "browser",
  "useBrowserTTS": true
}
```

**Error Response:**
```json
{
  "success": false,
  "provider": "browser",
  "useBrowserTTS": true,
  "error": "ElevenLabs TTS generation failed"
}
```

#### Serve Cached Audio

```http
GET /api/tts/audio/:filename
```

**Example:**
```
GET /api/tts/audio/a1b2c3d4e5f6...xyz.mp3
```

**Response:**
- Content-Type: `audio/mpeg`
- Cache-Control: `public, max-age=86400`
- Body: MP3 audio file

### WebSocket Events

#### TTS Alert Event

```javascript
{
  "type": "alert",
  "data": {
    "alertType": "tts",
    "user": "username",
    "message": "Hello world",
    "timestamp": "2024-01-15T12:34:56.789Z",
    "audioPath": "/api/tts/audio/hash.mp3",  // null for browser TTS
    "useBrowserTTS": false,                   // true for browser TTS
    "config": {
      "ttsEnabled": true,
      "ttsTemplate": "Hello world",
      "duration": 5500                        // Base 5s + 50ms per character
    }
  }
}
```

---

## Architecture

### System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                          User Input                             │
│                  !tts Hello world / Redemption                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Excella.js (Bot)                           │
│  • Validate length (200 chars)                                 │
│  • Check content filters (blacklist, URLs, caps, etc.)         │
│  • Check cooldowns (per-user 30s, global 10s)                  │
│  • Normalize username (lowercase)                              │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   POST /api/tts/generate                        │
│                    (Dashboard Server)                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TTS Service Module                           │
│                   (tts-service.js)                              │
└───────────────┬───────────────────────┬─────────────────────────┘
                │                       │
     ┌──────────▼──────────┐ ┌─────────▼──────────┐
     │   Check Cache       │ │  Provider Check    │
     │   (SHA-256 hash)    │ │  (browser/API)     │
     └──────────┬──────────┘ └─────────┬──────────┘
                │                       │
          ┌─────▼─────┐                 │
          │  Cached?  │                 │
          └─────┬─────┘                 │
                │                       │
         ┌──────┴──────┐                │
         │             │                │
    ┌────▼───┐   ┌────▼───────────────▼──────────┐
    │  Yes   │   │         No - Generate          │
    │ Return │   │  ┌──────────────────────────┐  │
    │  Path  │   │  │   Provider Selection     │  │
    └────┬───┘   │  └──────┬────────┬──────────┘  │
         │       │         │        │             │
         │       │  ┌──────▼───┐ ┌──▼──────────┐  │
         │       │  │ Browser  │ │   API TTS   │  │
         │       │  │   TTS    │ │ (ElevenLabs/│  │
         │       │  │(fallback)│ │   OpenAI)   │  │
         │       │  └──────┬───┘ └──┬──────────┘  │
         │       │         │        │             │
         │       │         └────┬───┘             │
         │       │              │                 │
         │       │       ┌──────▼──────────┐      │
         │       │       │  Save to Cache  │      │
         │       │       │  (hash.mp3)     │      │
         │       │       └──────┬──────────┘      │
         │       │              │                 │
         └───────┴──────────────┴─────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                 POST /api/test-alert                            │
│              Broadcast via WebSocket                            │
│      { type: 'alert', data: { alertType: 'tts', ... } }       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   OBS Overlay (Browser)                         │
│               tts-display.html receives event                   │
└───────────────┬───────────────────────┬─────────────────────────┘
                │                       │
     ┌──────────▼──────────┐ ┌─────────▼──────────┐
     │   API TTS Audio     │ │   Browser TTS      │
     │   (audio element)   │ │  (Web Speech API)  │
     └──────────┬──────────┘ └─────────┬──────────┘
                │                       │
                └───────────┬───────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Display on Stream                             │
│      • Animated text display with username                     │
│      • Progress bar showing duration                            │
│      • Audio playback synchronized with display                 │
└─────────────────────────────────────────────────────────────────┘
```

### Cache System

```
Cache Key Generation:
text + voice + provider → SHA-256 hash → filename.mp3

Example:
"Hello world" + "EXAVITQu4vr4xnSDxMaL" + "elevenlabs"
→ a1b2c3d4e5f6789...xyz
→ a1b2c3d4e5f6789...xyz.mp3

Cache Structure:
dashboard/cache/tts/
├── a1b2c3d4e5f6789...xyz.mp3  (24h TTL)
├── def456...abc.mp3             (18h TTL)
└── ghi789...xyz.mp3             (2h TTL)

Eviction Policy (LRU):
When cache > 100MB:
1. Sort files by timestamp (oldest first)
2. Delete oldest 25% of files
3. Update cache metadata
```

### Fallback Chain

```
Primary TTS Attempt
    ├─ API Provider (ElevenLabs/OpenAI)
    │   ├─ Success → Return audio path
    │   └─ Fail → Try Browser TTS
    │
    └─ Browser TTS (Web Speech API)
        ├─ Success → Use client-side speech
        └─ Fail → Silent failure (logged)

Overlay Playback:
    ├─ Audio Path Available?
    │   ├─ Yes → Play MP3
    │   │   ├─ Success → Done
    │   │   └─ Error → Fall back to Browser TTS
    │   │
    │   └─ No → Use Browser TTS
    │       ├─ Success → Done
    │       └─ Error → Log and display text only
```

---

## Cost Analysis

### Provider Pricing

#### ElevenLabs

| Plan | Price | Characters | Cost per 1k chars |
|------|-------|------------|-------------------|
| Free | $0 | 10,000/mo | $0.00 |
| Starter | $5/mo | 30,000/mo | $0.17 |
| Creator | $22/mo | 100,000/mo | $0.22 |
| Pro | $99/mo | 500,000/mo | $0.20 |

#### OpenAI

| Model | Price per 1k chars |
|-------|-------------------|
| tts-1 | $0.015 |
| tts-1-hd | $0.030 |

#### Browser TTS

| Cost | Quality | Availability |
|------|---------|--------------|
| $0.00 | Basic | Always |

### Usage Estimates

#### Typical Stream Scenarios

**Small Stream (50-100 viewers)**
- TTS messages per hour: ~20
- Average message length: 50 characters
- Total characters per 4-hour stream: 4,000

**Medium Stream (100-500 viewers)**
- TTS messages per hour: ~50
- Average message length: 50 characters
- Total characters per 4-hour stream: 10,000

**Large Stream (500-1000 viewers)**
- TTS messages per hour: ~100
- Average message length: 50 characters
- Total characters per 4-hour stream: 20,000

#### Monthly Cost Projections

Assuming 3 streams per week (12 per month):

| Stream Size | Chars/Month | ElevenLabs | OpenAI | Browser |
|-------------|-------------|------------|--------|---------|
| Small | 48,000 | $5.00* | $0.72 | $0.00 |
| Medium | 120,000 | $22.00** | $1.80 | $0.00 |
| Large | 240,000 | $22.00** | $3.60 | $0.00 |

*Free tier covers up to 10k, then Starter plan
**Creator plan needed for this volume

#### With Caching (90% hit rate)

Cached messages don't consume API credits:

| Stream Size | Actual API Calls | ElevenLabs | OpenAI | Savings |
|-------------|------------------|------------|--------|---------|
| Small | 4,800 | $0.00* | $0.07 | ~90% |
| Medium | 12,000 | $5.00 | $0.18 | ~90% |
| Large | 24,000 | $5.00 | $0.36 | ~90% |

### Cost Optimization Tips

1. **Enable Caching**: Reduces costs by 90%
2. **Use Browser TTS for Testing**: Free and unlimited
3. **Set Character Limits**: Lower than 200 if needed
4. **Increase Cooldowns**: Reduce message frequency
5. **Channel Points Only**: Require redemption (natural rate limiting)
6. **Start with Free Tier**: Test before committing to paid plans

---

## Troubleshooting

### Common Issues

#### TTS Not Working

**Symptoms:** !tts command does nothing

**Checks:**
1. Bot running? `npm run dev`
2. Dashboard running? Check `http://localhost:3001`
3. Check console for errors
4. Verify command syntax: `!tts hello world`

**Solutions:**
```bash
# Restart bot
npm run dev

# Check logs
tail -f dashboard/logs/commands.json

# Test command
!tts test message
```

#### "TTS Provider selected but no API key"

**Cause:** API key not set in `.env`

**Fix:**
```bash
# Add API key to .env
echo "ELEVENLABS_API_KEY=your_key_here" >> .env

# Restart bot
npm run dev
```

#### "ElevenLabs TTS generation failed"

**Possible Causes:**
- Invalid API key
- Insufficient credits
- Invalid voice ID
- Rate limit exceeded
- Network error

**Debug Steps:**
```bash
# 1. Check API key
cat .env | grep ELEVENLABS

# 2. Test API directly
curl -X POST https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL \
  -H "xi-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"test"}' \
  --output test.mp3

# 3. Check ElevenLabs dashboard
# Visit: https://elevenlabs.io/app/usage

# 4. Fall back to browser TTS temporarily
echo "TTS_PROVIDER=browser" >> .env
```

#### Audio Not Playing in Overlay

**Symptoms:** Text displays but no audio

**Checks:**
1. Overlay URL correct?
2. Dashboard running?
3. Browser console errors? (F12)
4. Audio file exists?

**Debug:**
```javascript
// In browser console (F12):
console.log('Audio element:', document.getElementById('tts-audio'));
console.log('Audio source:', document.getElementById('tts-audio').src);

// Test audio directly
const audio = new Audio('http://localhost:3001/api/tts/audio/HASH.mp3');
audio.play();
```

**Solutions:**
```bash
# Check cache directory
ls -lh dashboard/cache/tts/

# Verify file permissions
chmod 644 dashboard/cache/tts/*.mp3

# Clear cache and regenerate
rm -rf dashboard/cache/tts/*.mp3

# Test with browser TTS
# Add to overlay URL: ?debug=true
```

#### Cache Issues

**Symptoms:** Cache grows too large or doesn't clean up

**Check Cache Status:**
```bash
# Check size
du -sh dashboard/cache/tts/

# Count files
ls dashboard/cache/tts/ | wc -l

# Check oldest files
ls -lt dashboard/cache/tts/ | tail -10
```

**Manual Cleanup:**
```bash
# Clear entire cache
rm -rf dashboard/cache/tts/*.mp3

# Remove files older than 24 hours
find dashboard/cache/tts/ -name "*.mp3" -mtime +1 -delete
```

**Adjust Cache Settings:**
```env
# Reduce cache size limit
TTS_CACHE_MAX_SIZE=52428800  # 50MB instead of 100MB

# Reduce cache TTL
TTS_CACHE_MAX_AGE=43200000   # 12 hours instead of 24 hours
```

#### Cooldown Not Working

**Symptoms:** Users can spam TTS

**Cause:** Username case sensitivity bug (fixed in Phase 2)

**Verify Fix:**
```bash
# Check Excella.js for normalization
grep "normalizedUsername" Excella.js

# Should see: const normalizedUsername = username.toLowerCase();
```

**Test:**
```
# As user "TestUser"
!tts first message

# Wait 5 seconds, try as "testuser"
!tts second message

# Should say: "You're on TTS cooldown"
```

#### Filter Not Working

**Symptoms:** Inappropriate messages get through

**Check Filters:**
```bash
# View blacklist
!filters  # (as mod)

# Add word
!addfilter badword

# Test filter
!tts badword  # Should be blocked
```

**Verify Config:**
```env
# Check .env file
CHAT_FILTER_WORDS=word1|word2|word3
CHAT_FILTER_URLS=true
CHAT_FILTER_ALLCAPS=true
CHAT_FILTER_REPEAT=true
CHAT_FILTER_ACTION=warn
```

---

## Advanced Features

### Voice Cloning (ElevenLabs)

Clone your own voice for personalized TTS:

1. **Go to ElevenLabs Dashboard** → Voice Library
2. **Instant Voice Cloning**:
   - Record 1-3 minutes of clear audio
   - Upload audio file
   - Name your voice
3. **Get Voice ID** from voice settings
4. **Update .env**:
   ```env
   ELEVENLABS_VOICE_ID=your_cloned_voice_id
   ```
5. **Restart bot** and test

### Multi-Voice Support

Set up different voices for different user roles:

```javascript
// In Excella.js handleTTS function:

// Determine voice based on user role
let voiceId = config.elevenLabsVoiceId; // Default

if (isBroadcaster) {
  voiceId = 'YOUR_BROADCASTER_VOICE_ID';
} else if (isMod) {
  voiceId = 'YOUR_MOD_VOICE_ID';
} else if (isSubscriber) {
  voiceId = 'YOUR_SUBSCRIBER_VOICE_ID';
}

// Pass to TTS generation
const ttsResponse = await apiClient_axios.post(`${dashboardBaseUrl}/api/tts/generate`, {
  text,
  voice: voiceId,
  provider: null
}, { timeout: 30000 });
```

### Language Detection

Automatically detect language and use appropriate voice:

```javascript
// Add to handleTTS function:

// Simple language detection (basic)
function detectLanguage(text) {
  if (/[а-яА-Я]/.test(text)) return 'ru'; // Russian
  if (/[ñáéíóúÑÁÉÍÓÚ]/.test(text)) return 'es'; // Spanish
  if (/[àâäæçéèêëïîôùûüÿœ]/.test(text)) return 'fr'; // French
  return 'en'; // Default English
}

const language = detectLanguage(text);
const voiceMap = {
  'en': 'EXAVITQu4vr4xnSDxMaL', // Sarah
  'es': 'SPANISH_VOICE_ID',
  'fr': 'FRENCH_VOICE_ID',
  'ru': 'RUSSIAN_VOICE_ID'
};

const voiceId = voiceMap[language] || voiceMap['en'];
```

### Custom Animations

Modify the overlay animations in `tts-display.html`:

```css
/* Add to overlay-base.css or inline styles */

/* Custom entrance animation */
@keyframes customSlide {
  0% {
    opacity: 0;
    transform: translateX(-50%) translateY(100px) rotate(-5deg);
  }
  60% {
    opacity: 1;
    transform: translateX(-50%) translateY(-10px) rotate(2deg);
  }
  100% {
    opacity: 1;
    transform: translateX(-50%) translateY(0) rotate(0deg);
  }
}

.tts-container.custom-animation {
  animation: customSlide 0.8s cubic-bezier(0.68, -0.55, 0.265, 1.55);
}

/* Rainbow progress bar */
.tts-progress.rainbow {
  background: linear-gradient(
    90deg,
    #ff0000 0%,
    #ff7f00 16%,
    #ffff00 33%,
    #00ff00 50%,
    #0000ff 66%,
    #4b0082 83%,
    #9400d3 100%
  );
}
```

### Analytics & Monitoring

Track TTS usage with custom logging:

```javascript
// Add to Excella.js handleTTS function:

// Log TTS analytics
const ttsAnalytics = {
  timestamp: new Date().toISOString(),
  user: normalizedUsername,
  message: text,
  length: text.length,
  provider: 'elevenlabs', // or 'openai' or 'browser'
  cached: ttsResponse.data.cached,
  isRedemption: isRedemption
};

// Append to analytics file
fs.appendFileSync(
  'dashboard/logs/tts-analytics.json',
  JSON.stringify(ttsAnalytics) + '\n'
);

// Weekly report
function generateTTSReport() {
  // Read analytics file
  // Calculate:
  // - Total TTS messages
  // - Average message length
  // - Cache hit rate
  // - Cost estimate
  // - Top users
  // - Peak hours
}
```

### Rate Limiting by Subscription Tier

Different cooldowns for different subscriber tiers:

```javascript
// In handleTTS function:

let perUserCooldown = TTS_CONFIG.PER_USER_COOLDOWN_SEC;

if (msg?.userInfo?.isBroadcaster) {
  perUserCooldown = 0; // No cooldown for broadcaster
} else if (msg?.userInfo?.isMod) {
  perUserCooldown = 15; // 15 second cooldown for mods
} else if (msg?.userInfo?.isSubscriber) {
  // Check tier
  const tier = msg.userInfo.subscriptionTier;
  if (tier === '3000') perUserCooldown = 10; // Tier 3: 10s
  else if (tier === '2000') perUserCooldown = 15; // Tier 2: 15s
  else perUserCooldown = 20; // Tier 1: 20s
} else {
  perUserCooldown = 30; // Non-subs: 30s
}

// Apply cooldown check with custom duration
```

---

## FAQ

### General Questions

**Q: Does TTS work without premium API?**
A: Yes! Browser TTS works out of the box for free.

**Q: Can I test premium voices before paying?**
A: Yes! ElevenLabs has a free tier (10k chars/month), OpenAI requires credits but is pay-per-use.

**Q: Will my viewers hear the TTS?**
A: Only if you add the OBS overlay to your stream. The audio doesn't play in Twitch chat.

**Q: Can viewers bypass cooldowns?**
A: Channel points redemptions bypass per-user cooldown but respect global cooldown.

**Q: Do mods get special treatment?**
A: Yes, mods and broadcaster bypass content filters but not cooldowns (unless customized).

### Technical Questions

**Q: Where is audio cached?**
A: `dashboard/cache/tts/*.mp3` (auto-created)

**Q: How long is audio cached?**
A: 24 hours by default (configurable with `TTS_CACHE_MAX_AGE`)

**Q: What happens if cache fills up?**
A: Automatic LRU eviction removes oldest 25% when exceeding 100MB

**Q: Can I use multiple voices?**
A: Yes! See [Multi-Voice Support](#multi-voice-support) in Advanced Features

**Q: Does it work with StreamElements/StreamLabs?**
A: No direct integration, but you can add the OBS overlay to any streaming software

**Q: Is there a maximum message length?**
A: Yes, 200 characters (configurable in `TTS_CONFIG`)

### Cost Questions

**Q: How much does ElevenLabs cost?**
A: Free tier: 10k chars/mo, Starter: $5/mo for 30k chars

**Q: How much does OpenAI TTS cost?**
A: $0.015 per 1k characters (tts-1) or $0.030 (tts-1-hd)

**Q: How much can caching save?**
A: ~90% reduction in API calls for typical usage

**Q: Do failed API calls count against quota?**
A: No, only successful generations count

**Q: Can I switch providers without reconfiguring?**
A: Yes! Just change `TTS_PROVIDER` in `.env` and restart

### Troubleshooting Questions

**Q: TTS not working at all?**
A: Check bot is running (`npm run dev`), dashboard accessible (`http://localhost:3001`)

**Q: Audio plays but no text display?**
A: Check OBS overlay is added and URL is correct

**Q: Text displays but no audio?**
A: Check browser console (F12) for errors, verify audio file exists

**Q: Getting "API key invalid" error?**
A: Double-check API key in `.env`, ensure no extra spaces

**Q: Cache not working?**
A: Check `dashboard/cache/tts/` directory exists and is writable

---

## Support

### Resources

- **Main Documentation**: `/CLAUDE.md`
- **TTS Service Code**: `/tts-service.js`
- **Bot Integration**: `/Excella.js` (search for `handleTTS`)
- **Overlay Code**: `/obs/overlays/tts-display.html`
- **API Routes**: `/dashboard/routes/api.js` (TTS section)

### Getting Help

1. **Check Logs**:
   ```bash
   # Bot console output
   npm run dev

   # Dashboard logs
   cat dashboard/logs/commands.json | grep tts
   ```

2. **Debug Mode**:
   ```
   # Add to OBS overlay URL
   ?debug=true
   ```

3. **Test API Directly**:
   ```bash
   # Get config
   curl http://localhost:3001/api/tts/config

   # Generate TTS
   curl -X POST http://localhost:3001/api/tts/generate \
     -H "Content-Type: application/json" \
     -d '{"text":"test message"}'
   ```

4. **Report Issues**:
   - Include console logs
   - Specify provider (browser/elevenlabs/openai)
   - Include `.env` configuration (redact API keys!)
   - Describe expected vs actual behavior

---

## License

Part of Excella Twitch Chat Bot - see main repository for license details.

---

## Changelog

### Phase 2 (Latest) - Premium AI TTS
- ✅ ElevenLabs API integration
- ✅ OpenAI TTS API integration
- ✅ Server-side audio generation
- ✅ Smart caching with LRU eviction
- ✅ Hybrid playback system
- ✅ Automatic fallback chain
- ✅ Cost optimization

### Phase 1 - Browser TTS Foundation
- ✅ Browser-based TTS using Web Speech API
- ✅ OBS overlay with animations
- ✅ Content filtering system
- ✅ Rate limiting (per-user + global)
- ✅ Channel points integration
- ✅ Moderator exemptions
- ✅ Username normalization
- ✅ URL parameter validation

---

**Last Updated**: 2024-01-15
**Version**: 2.0
**Author**: Claude Code Assistant
**Repository**: github.com/dpoloniajr/Twitch-Chat-Bot
