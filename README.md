# Highlight Hunter

Personal Twitch VOD highlight tool. Finds, crops, and exports 9:16 clips for YouTube Shorts / TikTok using Gemini AI and FFmpeg.wasm — runs entirely in the browser from GitHub Pages, no server required.

## Setup

### 1. Add FFmpeg.wasm files

Copy these four files from your existing AI Clip Editor repo into the **root** of this repo:

```
ffmpeg.js
814.ffmpeg.js
ffmpeg-core.js
ffmpeg-core.wasm
```

These are the non-threaded v0.11.x build. Do not use the threaded build — it requires SharedArrayBuffer headers that GitHub Pages cannot serve.

### 2. Deploy to GitHub Pages

Enable GitHub Pages in your repo settings → source: `main` branch, root `/`.

### 3. Open the tool and configure Settings

Click ⚙ in the top-right and enter:

| Field | Where to get it |
|---|---|
| Gemini API Key | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| Twitch OAuth Token | Your existing token (without `oauth:` prefix, or with — both work) |
| Twitch Client ID | Your Twitch app's Client ID |
| GitHub Token | Personal access token with `repo` scope (for style profiles) |
| GitHub Owner | Your GitHub username |
| GitHub Repo | This repo's name |

All credentials are stored in `localStorage` — never sent anywhere except the respective APIs.

## Usage

### Finding Highlights

1. Paste a Twitch VOD URL or ID and click **Fetch**
2. The tool shows the smallest available stream resolution (e.g. `160p`) — this is what Gemini will see
3. If no quality ≤ 480p is available, the VOD is blocked from processing
4. Enter your highlight description, target clip count, duration, and pacing
5. Optionally enter a content type to match a style profile
6. Click **Analyse VOD**

### Processing Clips

Each highlight card shows timestamp, label, rank (1–5), and reason.

- Click a card to seek the embedded preview to that moment
- Click **Process Clip** to run Stage 2: Gemini determines the 9:16 crop, FFmpeg extracts and crops the full-resolution clip
- Download links appear on the card when done

### CTA Overlays

Upload a GIF or alpha-channel MP4 for YouTube and/or TikTok before processing. If provided, processing produces two output files per clip (one per platform).

### Style Profiles

Click ⊞ to open the style profile creator. Upload an existing edited Short, name the content type, and click **Analyse & Generate Profile**. The profile is saved to `Reference Data/` in your repo via GitHub API and auto-loaded on next visit.

The more reference Shorts you feed it, the more refined the output style becomes — each new reference consolidates into one unified profile, not appended blocks.

## Resolution Rules

- Gemini **always** sees the smallest available stream quality — never anything above 480p
- If 160p is available, 160p is used. Always the absolute smallest
- FFmpeg always works with the full-resolution original
- Gemini returns crop positions as **proportions** (0.0–1.0), never pixels
- FFmpeg scales those proportions to the actual full-resolution frame at processing time

## File Structure

```
highlight-hunter/
├── index.html
├── css/app.css
├── js/
│   ├── app.js              # Main controller
│   ├── settings.js         # Credentials
│   ├── twitch.js           # Twitch API + m3u8
│   ├── gemini.js           # Gemini Files API + generateContent
│   ├── analysis.js         # Stage 1 analysis
│   ├── clip-processor.js   # Stage 2 per-clip
│   ├── ffmpeg-handler.js   # FFmpeg.wasm wrapper
│   ├── style-profiles.js   # Profile management
│   ├── github.js           # GitHub API read/write
│   └── ui.js               # Results screen
├── Reference Data/
│   ├── manifest.json       # Profile index
│   └── *.json              # Style profiles (auto-created)
├── ffmpeg.js               # ← ADD FROM YOUR EXISTING TOOL
├── 814.ffmpeg.js           # ← ADD FROM YOUR EXISTING TOOL
├── ffmpeg-core.js          # ← ADD FROM YOUR EXISTING TOOL
└── ffmpeg-core.wasm        # ← ADD FROM YOUR EXISTING TOOL
```
