// twitch.js — Twitch Helix API, recent VODs, m3u8 quality fetch

window.Twitch = (() => {

  function _headers() {
    const token  = Settings.get('twitchToken');
    const client = Settings.get('twitchClientId');
    return {
      'Authorization': `Bearer ${token}`,
      'Client-Id': client,
    };
  }

  // ── Fetch current user info, cache login + id ─────────────────────
  async function fetchCurrentUser() {
    const res = await fetch('https://api.twitch.tv/helix/users', { headers: _headers() });
    if (res.status === 401) throw new Error('Twitch token expired — reconnect in Settings');
    if (!res.ok) throw new Error(`Twitch API error: ${res.status}`);
    const data = await res.json();
    const user = data.data?.[0];
    if (!user) throw new Error('Could not load Twitch user');
    Settings.set('twitchLogin', user.login);
    Settings.set('twitchUserId', user.id);
    return user;
  }

  // ── Fetch recent VODs for the current user ────────────────────────
  async function fetchRecentVods(count = 3) {
    let userId = Settings.get('twitchUserId');
    if (!userId) {
      const user = await fetchCurrentUser();
      userId = user.id;
    }
    const res = await fetch(
      `https://api.twitch.tv/helix/videos?user_id=${userId}&first=${count}&type=archive`,
      { headers: _headers() }
    );
    if (res.status === 401) throw new Error('Twitch token expired — reconnect in Settings');
    if (!res.ok) throw new Error(`Twitch API error: ${res.status}`);
    const data = await res.json();
    return data.data || [];
  }

  // ── Get signed m3u8 URL via GQL (isolated, easy to swap) ─────────
  async function _getSignedM3u8Url(vodId) {
    const token  = Settings.get('twitchToken');
    const client = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // GQL requires Twitch web client ID

    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': client,
        'Authorization': `OAuth ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken_Template',
        query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){
          videoPlaybackAccessToken(id:$vodID,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value signature __typename}
        }`,
        variables: { isLive: false, login: '', isVod: true, vodID: vodId, playerType: 'site' },
      }),
    });
    if (!res.ok) throw new Error(`GQL token fetch failed: ${res.status}`);
    const data = await res.json();
    const tok  = data?.data?.videoPlaybackAccessToken;
    if (!tok) throw new Error('Could not get VOD playback token');
    const sig   = encodeURIComponent(tok.signature);
    const value = encodeURIComponent(tok.value);
    return `https://usher.twitchapps.com/vod/${vodId}?nauth=${value}&nauthsig=${sig}&allow_source=true&allow_spectre=true`;
  }

  // ── Parse quality variants from m3u8 master playlist ─────────────
  async function fetchQualities(vodId) {
    const masterUrl = await _getSignedM3u8Url(vodId);
    const res = await fetch(masterUrl);
    if (!res.ok) throw new Error(`m3u8 fetch failed: ${res.status}`);
    const text = await res.text();
    return _parseVariants(text, masterUrl);
  }

  function _parseVariants(text, baseUrl) {
    const lines    = text.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const info   = lines[i];
      const url    = lines[i + 1];
      if (!url || url.startsWith('#')) continue;
      const res    = _attr(info, 'RESOLUTION') || '';
      const bw     = parseInt(_attr(info, 'BANDWIDTH') || '0');
      const hMatch = res.match(/\d+x(\d+)/);
      const height = hMatch ? parseInt(hMatch[1]) : 9999;
      const wMatch = res.match(/(\d+)x\d+/);
      const width  = wMatch ? parseInt(wMatch[1]) : 0;
      variants.push({
        label:      _attr(info, 'VIDEO') || res || `${height}p`,
        resolution: res,
        height, width, bandwidth: bw,
        url: url.startsWith('http') ? url : new URL(url, baseUrl).href,
      });
    }
    return variants.sort((a, b) => a.height - b.height); // ascending: smallest first
  }

  function _attr(line, key) {
    const m = line.match(new RegExp(`${key}=(?:"([^"]+)"|([^,\\s]+))`));
    return m ? (m[1] || m[2]) : null;
  }

  // ── Select smallest quality at or below 480p ──────────────────────
  function selectSmallest(variants) {
    return variants.find(v => v.height <= 480) || null;
  }

  // ── Download a stream as a single Blob (all segments) ────────────
  async function downloadStreamAsBlob(variantUrl, onProgress, cancelSignal) {
    const res = await fetch(variantUrl);
    if (!res.ok) throw new Error(`Playlist fetch failed: ${res.status}`);
    const text = await res.text();

    const base  = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
    const segs  = text.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.startsWith('http') ? l : base + l);

    if (!segs.length) throw new Error('No segments found in playlist');

    const parts = [];
    for (let i = 0; i < segs.length; i++) {
      if (cancelSignal?.cancelled) throw new Error('Cancelled');
      const r = await fetch(segs[i]);
      if (!r.ok) throw new Error(`Segment ${i + 1} failed: ${r.status}`);
      parts.push(await r.arrayBuffer());
      onProgress && onProgress(i + 1, segs.length);
    }
    return new Blob(parts, { type: 'video/mp2t' });
  }

  // ── Load a full VodInfo object from a VOD metadata object ─────────
  async function loadVodInfo(vodMeta) {
    const vodId   = vodMeta.id;
    const variants = await fetchQualities(vodId);
    const smallest = selectSmallest(variants);
    return {
      vodId,
      meta:       vodMeta,
      variants,
      smallest,
      accessible: !!smallest,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function parseDuration(str) {
    if (!str) return 0;
    let s = 0;
    const h = str.match(/(\d+)h/); if (h) s += parseInt(h[1]) * 3600;
    const m = str.match(/(\d+)m/); if (m) s += parseInt(m[1]) * 60;
    const x = str.match(/(\d+)s/); if (x) s += parseInt(x[1]);
    return s;
  }

  function fmtDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function fmtDate(str) {
    if (!str) return '';
    return new Date(str).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function thumbUrl(meta, w = 320, h = 180) {
    return (meta.thumbnail_url || '')
      .replace('%{width}', w)
      .replace('%{height}', h);
  }

  return {
    fetchCurrentUser,
    fetchRecentVods,
    fetchQualities,
    selectSmallest,
    downloadStreamAsBlob,
    loadVodInfo,
    parseDuration,
    fmtDuration,
    fmtDate,
    thumbUrl,
  };

})();
