# Highlight Hunter

Personal Twitch VOD highlight tool. Finds, crops, and exports 9:16 clips using Gemini AI and FFmpeg.wasm. Runs entirely in the browser from GitHub Pages — no server required.

---

## One-time setup

### 1. Edit `js/config.js`

Open `js/config.js` and fill in two values:

```js
TWITCH_CLIENT_ID: 'your_client_id_here',
GITHUB_PAGES_URL: 'https://yourusername.github.io/highlight-hunter',
```

**Getting a Twitch Client ID:**
1. Go to https://dev.twitch.tv/console/apps
2. Register a new application (any name, category: Website Integration)
3. Add `https://yourusername.github.io/highlight-hunter/auth-twitch.html` as OAuth redirect URL
4. Copy the Client ID

### 2. Add FFmpeg.wasm files

Copy these four files from your existing AI Clip Editor tool into the repo **root**:

```
ffmpeg.js
814.ffmpeg.js
ffmpeg-core.js
ffmpeg-core.wasm
```

### 3. Enable GitHub Pages

Repo Settings → Pages → Source: main branch, root `/`

### 4. Open the tool

- Click ⚙ Settings and add:
  - **Gemini API key** — from https://aistudio.google.com/app/apikey
  - **GitHub Personal Access Token** — GitHub → Settings → Developer Settings → Personal Access Tokens (classic) → `repo` scope only
  - **GitHub Owner** and **Repo** name
- Click **Connect Twitch** — logs you in via Twitch OAuth, returns automatically

---

## Usage

**Finding highlights:**
1. Your 3 most recent VODs load automatically — tap one to select it
2. The smallest available stream quality is shown (e.g. `160p`) — this is what Gemini sees
3. VODs with no quality ≤ 480p are not selectable
4. Fill in your highlight description, clip count, duration, pacing
5. Optionally enter a content type to match a saved style profile
6. Click **Analyse VOD**

**Processing clips:**
- Tap any result card to seek the preview to that moment
- Click **Process Clip** to run Stage 2: Gemini determines the 9:16 crop, FFmpeg extracts and crops the full-res clip
- Download links appear on the card when done

**CTA Overlays:**
Upload a GIF or alpha-channel MP4 for YouTube and/or TikTok before processing. If provided, two output files are produced per clip.

**Style Profiles:**
Click ⊞ → upload a reference Short → name it → click Analyse & Save. Saved to your GitHub repo automatically. The more reference clips you add, the more refined the style becomes.

---

## Resolution rules

- Gemini **always** sees the smallest available quality — never above 480p
- If 160p exists, 160p is used — always the absolute smallest
- FFmpeg always processes the full-resolution original
- Gemini returns crop positions as proportions (0.0–1.0), never pixels
- FFmpeg scales those to the actual frame at processing time

---

## File structure

```
highlight-hunter/
├── index.html
├── auth-twitch.html        ← Twitch OAuth callback
├── css/app.css
├── js/
│   ├── config.js           ← EDIT THIS FIRST
│   ├── app.js
│   ├── settings.js
│   ├── twitch.js
│   ├── gemini.js
│   ├── analysis.js
│   ├── clip-processor.js
│   ├── ffmpeg-handler.js
│   ├── style-profiles.js
│   ├── github.js
│   └── ui.js
├── Reference Data/
│   └── manifest.json
├── ffmpeg.js               ← ADD FROM EXISTING TOOL
├── 814.ffmpeg.js           ← ADD FROM EXISTING TOOL
├── ffmpeg-core.js          ← ADD FROM EXISTING TOOL
└── ffmpeg-core.wasm        ← ADD FROM EXISTING TOOL
```
