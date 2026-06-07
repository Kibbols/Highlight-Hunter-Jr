// twitch.js — Twitch Helix API + m3u8 quality fetching

window.Twitch = (() => {

  // ── Helpers ───────────────────────────────────────────────────────

  function getHeaders() {
    const token  = Settings.get('twitchToken').replace(/^oauth:/, '');
    const client = Settings.get('twitchClient');
    return {
      'Authorization': `Bearer ${token}`,
      'Client-Id': client,
    };
  }

  function extractVodId(input) {
    input = input.trim();
    // Pure numeric ID
    if (/^\d+$/.test(input)) return input;
    // URL forms: /videos/12345  or  ?video=v12345
    const match = input.match(/(?:videos\/|video=v?)(\d+)/i);
    if (match) return match[1];
    return null;
  }

  // ── Helix: fetch VOD metadata ─────────────────────────────────────
  async function fetchVodMeta(vodId) {
    const res = await fetch(
      `https://api.twitch.tv/helix/videos?id=${vodId}`,
      { headers: getHeaders() }
    );
    if (res.status === 401) throw new Error('Twitch auth failed — check your OAuth token and Client ID in Settings');
    if (!res.ok) throw new Error(`Twitch API error: ${res.status}`);
    const data = await res.json();
    if (!data.data || !data.data.length) throw new Error('VOD not found or not accessible');
    return data.data[0];
  }

  // ── m3u8 manifest fetch + quality parsing ─────────────────────────
  // Twitch CDN URLs: https://usher.twitchapps.com/vod/{vodId}
  // Requires a signed token — obtained from Helix API access token flow
  // We attempt the Helix approach first; if CDN rejects, fall back to
  // the GQL sig+token approach (isolated here for easy swap-out)

  async function fetchM3u8Url(vodId) {
    // Helix returns a thumbnail_url we can derive stream CDN from, but
    // the actual m3u8 requires a signed token via GQL.
    // Using isolated GQL call for signed token only (not full data scrape)
    return await _gqlGetVodToken(vodId);
  }

  async function _gqlGetVodToken(vodId) {
    const clientId = Settings.get('twitchClient');
    const token    = Settings.get('twitchToken').replace(/^oauth:/, '');

    const payload = {
      operationName: 'PlaybackAccessToken_Template',
      query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
        streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }
        videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename }
      }`,
      variables: {
        isLive: false,
        login: '',
        isVod: true,
        vodID: vodId,
        playerType: 'site',
      },
    };

    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Authorization': `OAuth ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`GQL token fetch failed: ${res.status}`);
    const data = await res.json();
    const tok = data?.data?.videoPlaybackAccessToken;
    if (!tok) throw new Error('Could not obtain VOD playback token');

    const sig   = encodeURIComponent(tok.signature);
    const value = encodeURIComponent(tok.value);
    return `https://usher.twitchapps.com/vod/${vodId}?nauth=${value}&nauthsig=${sig}&allow_source=true&allow_spectre=true`;
  }

  // Parse m3u8 master playlist — returns array of { label, resolution, bandwidth, url }
  async function parseQualities(m3u8Url) {
    const res = await fetch(m3u8Url);
    if (!res.ok) throw new Error(`m3u8 fetch failed: ${res.status}`);
    const text = await res.text();
    return parseM3u8Variants(text, m3u8Url);
  }

  function parseM3u8Variants(text, baseUrl) {
    const lines    = text.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const infoLine = lines[i];
      const urlLine  = lines[i + 1];
      if (!urlLine || urlLine.startsWith('#')) continue;

      const resolution = _parseAttr(infoLine, 'RESOLUTION') || '';
      const bandwidth  = parseInt(_parseAttr(infoLine, 'BANDWIDTH') || '0');
      const video      = _parseAttr(infoLine, 'VIDEO') || '';

      // height in pixels
      const heightMatch = resolution.match(/\d+x(\d+)/);
      const height = heightMatch ? parseInt(heightMatch[1]) : 9999;

      // Build absolute URL if relative
      const url = urlLine.startsWith('http') ? urlLine : new URL(urlLine, baseUrl).href;

      variants.push({ label: video || resolution, resolution, height, bandwidth, url });
    }

    // Sort ascending by height (smallest first)
    variants.sort((a, b) => a.height - b.height);
    return variants;
  }

  function _parseAttr(line, attr) {
    const match = line.match(new RegExp(`${attr}=(?:"([^"]+)"|([^,\\s]+))`));
    return match ? (match[1] || match[2]) : null;
  }

  // ── Quality selection: smallest at or below 480p ──────────────────
  function selectSmallestQuality(variants) {
    const eligible = variants.filter(v => v.height <= 480);
    if (!eligible.length) return null;
    return eligible[0]; // already sorted ascending
  }

  // ── Download m3u8 stream as Blob (for Gemini upload) ─────────────
  // Fetches the chunklist and all .ts segments, assembles into a single Blob
  // This can be large — progress callback(loaded, total) optional
  async function downloadStreamAsBlob(qualityUrl, onProgress, cancelSignal) {
    // Fetch the variant playlist
    const res = await fetch(qualityUrl);
    if (!res.ok) throw new Error(`Stream playlist fetch failed: ${res.status}`);
    const text = await res.text();

    // Extract segment URLs
    const lines   = text.split('\n').map(l => l.trim()).filter(Boolean);
    const segments = lines.filter(l => !l.startsWith('#') && (l.includes('.ts') || l.includes('.aac')));
    const baseUrl  = qualityUrl.substring(0, qualityUrl.lastIndexOf('/') + 1);
    const segUrls  = segments.map(s => s.startsWith('http') ? s : baseUrl + s);

    if (!segUrls.length) throw new Error('No segments found in stream playlist');

    const blobs = [];
    for (let i = 0; i < segUrls.length; i++) {
      if (cancelSignal && cancelSignal.cancelled) throw new Error('Cancelled');
      const segRes = await fetch(segUrls[i]);
      if (!segRes.ok) throw new Error(`Segment ${i} fetch failed: ${segRes.status}`);
      blobs.push(await segRes.arrayBuffer());
      if (onProgress) onProgress(i + 1, segUrls.length);
    }

    return new Blob(blobs, { type: 'video/mp2t' });
  }

  // ── Full flow: given VOD URL/ID → returns VodInfo object ──────────
  async function loadVod(input, onProgress) {
    const vodId = extractVodId(input);
    if (!vodId) throw new Error('Could not parse VOD ID from input');

    // Step 1: metadata
    const meta = await fetchVodMeta(vodId);

    // Step 2: get m3u8 URL
    const m3u8Url = await fetchM3u8Url(vodId);

    // Step 3: parse qualities
    const variants = await parseQualities(m3u8Url);
    if (!variants.length) throw new Error('No quality variants found in m3u8 manifest');

    const smallest = selectSmallestQuality(variants);

    return {
      vodId,
      meta,
      variants,
      smallest,       // null if nothing ≤ 480p
      m3u8Url,        // master playlist URL (full quality available for FFmpeg)
      accessible: !!smallest,
    };
  }

  // Format seconds → H:MM:SS or M:SS
  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  // Parse Twitch duration string "3h12m45s" → seconds
  function parseTwitchDuration(str) {
    if (!str) return 0;
    let secs = 0;
    const h = str.match(/(\d+)h/); if (h) secs += parseInt(h[1]) * 3600;
    const m = str.match(/(\d+)m/); if (m) secs += parseInt(m[1]) * 60;
    const s = str.match(/(\d+)s/); if (s) secs += parseInt(s[1]);
    return secs;
  }

  return {
    extractVodId,
    fetchVodMeta,
    fetchM3u8Url,
    parseQualities,
    selectSmallestQuality,
    downloadStreamAsBlob,
    loadVod,
    formatDuration,
    parseTwitchDuration,
  };

})();
