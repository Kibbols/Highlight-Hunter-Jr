// Highlight Hunter Worker
// Single source of truth for all API keys and CDN proxying

function getCors(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [
    'https://kibbols.github.io',
    'https://highlightjr.portgamingsttv.workers.dev',
  ];
  // Also allow Android app (no origin header) and any null origin
  const allowedOrigin = allowed.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function err(message, status = 500, cors = {}) {
  return json({ error: message }, status, cors);
}

export default {
  async fetch(request, env) {
    const cors = getCors(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── /config — returns keys to the app (GET, no secrets exposed beyond key values) ──
    if (path === '/config') {
      if (request.method !== 'GET') return err('Method not allowed', 405, cors);
      return json({
        twitch_client_id: env.TWITCH_CLIENT_ID,
        gemini_api_key:   env.GEMINI_API_KEY,
      }, 200, cors);
    }

    // All other endpoints require POST
    if (request.method !== 'POST') {
      return err('Method not allowed', 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON', 400, cors);
    }

    // ── /twitch-auth ─────────────────────────────────────────────────
    if (path === '/twitch-auth') {
      const { code, redirect_uri } = body;
      if (!code || !redirect_uri) return err('Missing code or redirect_uri', 400, cors);
      try {
        const res = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id:     env.TWITCH_CLIENT_ID,
            client_secret: env.TWITCH_CLIENT_SECRET,
            code,
            grant_type:    'authorization_code',
            redirect_uri,
          }),
        });
        const data = await res.json();
        if (!data.access_token) throw new Error(data.message || 'Token exchange failed');
        return json({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in,
        }, 200, cors);
      } catch (e) {
        return err(e.message, 500, cors);
      }
    }

    // ── /twitch-refresh ──────────────────────────────────────────────
    if (path === '/twitch-refresh') {
      const { refresh_token } = body;
      if (!refresh_token) return err('Missing refresh_token', 400, cors);
      try {
        const res = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id:     env.TWITCH_CLIENT_ID,
            client_secret: env.TWITCH_CLIENT_SECRET,
            grant_type:    'refresh_token',
            refresh_token,
          }),
        });
        const data = await res.json();
        if (!data.access_token) throw new Error(data.message || 'Refresh failed');
        return json({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in,
        }, 200, cors);
      } catch (e) {
        return err(e.message, 500, cors);
      }
    }

    // ── /proxy-m3u8 — proxy CDN segments to bypass CORS (web app only) ──
    if (path === '/proxy-m3u8') {
      const { url } = body;
      if (!url) return err('Missing url', 400, cors);
      try {
        const res = await fetch(url);
        if (!res.ok) {
          const text = await res.text();
          return json({ error: `CDN fetch failed: ${res.status}`, body: text }, 500, cors);
        }
        const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
        return new Response(res.body, {
          headers: { ...cors, 'Content-Type': contentType },
        });
      } catch (e) {
        return err(e.message, 500, cors);
      }
    }

    return err('Unknown endpoint', 404, cors);
  },
};
