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

  // ── Fetch VOD metadata from GQL including seekPreviewsURL ─────────
  async function _getVodGqlData(vodId) {
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id':    'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `{ video(id: "${vodId}") { broadcastType, createdAt, seekPreviewsURL, owner { login } } }`,
      }),
    });
    if (!res.ok) throw new Error(`GQL metadata request failed: ${res.status}`);
    const data = await res.json();
    const video = data?.data?.video;
    if (!video) throw new Error(`GQL returned no video data for VOD ${vodId}`);
    return video;
  }

  // ── Build CDN quality URLs from GQL metadata (bypasses usher entirely) ──
  async function fetchQualities(vodId) {
    const vodData = await _getVodGqlData(vodId);

    if (!vodData.seekPreviewsURL) throw new Error('No seekPreviewsURL in GQL response');

    const previewUrl   = new URL(vodData.seekPreviewsURL);
    const domain       = previewUrl.host;
    const paths        = previewUrl.pathname.split('/');
    const sbIdx        = paths.findIndex(p => p.includes('storyboards'));
    if (sbIdx < 1) throw new Error('Could not parse vodSpecialID from seekPreviewsURL');
    const vodSpecialID = paths[sbIdx - 1];

    const broadcastType = (vodData.broadcastType || 'archive').toLowerCase();
    const createdAt     = new Date(vodData.createdAt);
    const daysSince     = (Date.now() - createdAt.getTime()) / (1000 * 3600 * 24);

    // Quality presets matching Twitch's standard offerings
    const qualities = [
      { key: 'chunked', label: '1080p60 (Source)', res: '1920x1080', fps: 60 },
      { key: '1080p60',  label: '1080p60',          res: '1920x1080', fps: 60 },
      { key: '720p60',   label: '720p60',            res: '1280x720',  fps: 60 },
      { key: '720p30',   label: '720p30',            res: '1280x720',  fps: 30 },
      { key: '480p30',   label: '480p30',            res: '854x480',   fps: 30 },
      { key: '360p30',   label: '360p30',            res: '640x360',   fps: 30 },
      { key: '160p30',   label: '160p30',            res: '284x160',   fps: 30 },
    ];

    function buildUrl(key) {
      if (broadcastType === 'highlight') {
        return `https://${domain}/${vodSpecialID}/${key}/highlight-${vodId}.m3u8`;
      }
      if (broadcastType === 'upload' && daysSince > 7) {
        return `https://${domain}/${vodData.owner.login}/${vodId}/${vodSpecialID}/${key}/index-dvr.m3u8`;
      }
      return `https://${domain}/${vodSpecialID}/${key}/index-dvr.m3u8`;
    }

    // Build all variants optimistically — CDN blocks HEAD/OPTIONS so we
    // can't pre-validate. Segment fetch will fail gracefully if a quality
    // doesn't exist. We always include chunked + standard tiers.
    const variants = qualities.map(q => {
      const [w, h] = q.res.split('x').map(Number);
      return {
        label:      q.label,
        resolution: q.res,
        height:     h,
        width:      w,
        bandwidth:  0,
        url:        buildUrl(q.key),
      };
    });

    return variants.sort((a, b) => a.height - b.height); // ascending: smallest first
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
    const vodId    = vodMeta.id;
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
