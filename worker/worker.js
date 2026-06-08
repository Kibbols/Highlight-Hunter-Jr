// Highlight Hunter Worker
// Handles Twitch OAuth and VOD m3u8 URL fetching server-side to avoid CORS issues

const ALLOWED_ORIGIN = 'https://kibbols.github.io';

const cors = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function err(message, status = 500) {
  return json({ error: message }, status);
}

export default {
  async fetch(request, env) {

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return err('Method not allowed', 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON', 400);
    }

    const url   = new URL(request.url);
    const path  = url.pathname;

    // ── /twitch-auth ─────────────────────────────────────────────────
    // Exchanges an OAuth authorization code for an access token.
    // Keeps the Client Secret server-side.
    if (path === '/twitch-auth') {
      const { code, redirect_uri } = body;
      if (!code || !redirect_uri) return err('Missing code or redirect_uri', 400);
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
        });
      } catch (e) {
        return err(e.message);
      }
    }

    // ── /twitch-refresh ──────────────────────────────────────────────
    // Refreshes an expired access token using a stored refresh token.
    if (path === '/twitch-refresh') {
      const { refresh_token } = body;
      if (!refresh_token) return err('Missing refresh_token', 400);
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
        });
      } catch (e) {
        return err(e.message);
      }
    }

    // ── /twitch-vod-m3u8 ────────────────────────────────────────────
    // Gets a signed m3u8 URL for a Twitch VOD via GQL.
    // Must run server-side — GQL blocks browser requests.
    if (path === '/twitch-vod-m3u8') {
      const { vod_id, access_token } = body;
      if (!vod_id || !access_token) return err('Missing vod_id or access_token', 400);
      try {
        const gqlRes = await fetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: {
            'Client-Id':     env.TWITCH_CLIENT_ID,
            'Authorization': `OAuth ${access_token}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            operationName: 'PlaybackAccessToken_Template',
            query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){
              videoPlaybackAccessToken(id:$vodID,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value signature __typename}
            }`,
            variables: { isLive: false, login: '', isVod: true, vodID: vod_id, playerType: 'site' },
          }),
        });
        const gqlData = await gqlRes.json();
        const tok = gqlData?.data?.videoPlaybackAccessToken;
        if (!tok) throw new Error('No playback token returned from GQL');
        const sig = encodeURIComponent(tok.signature);
        const val = encodeURIComponent(tok.value);
        return json({
          url: `https://usher.twitchapps.com/vod/${vod_id}?nauth=${val}&nauthsig=${sig}&allow_source=true&allow_spectre=true`,
        });
      } catch (e) {
        return err(e.message);
      }
    }

    return err('Unknown endpoint', 404);
  },
};
