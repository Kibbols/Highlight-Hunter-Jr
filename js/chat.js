// chat.js — Fetch VOD chat replay via GQL

window.Chat = (() => {

  const GQL = 'https://gql.twitch.tv/gql';
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

  async function _gql(body) {
    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Chat GQL failed: ${res.status}`);
    return res.json();
  }

  // ── Fetch all chat messages for a VOD ─────────────────────────────
  // Returns array of { offsetSec, username, message }
  async function fetchVodChat(vodId, onProgress) {
    const messages = [];
    let cursor = null;
    let page = 0;

    while (true) {
      const variables = cursor
        ? { videoID: vodId, cursor }
        : { videoID: vodId, contentOffsetSeconds: 0 };

      const data = await _gql({
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables,
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
          },
        },
      });

      const comments = data?.data?.video?.comments;
      if (!comments) break;

      for (const edge of comments.edges || []) {
        const node = edge.node;
        if (!node) continue;
        messages.push({
          offsetSec: node.contentOffsetSeconds,
          username:  node.commenter?.displayName || 'unknown',
          message:   node.message?.fragments?.map(f => f.text).join('') || '',
        });
      }

      const pageInfo = comments.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = comments.edges?.[comments.edges.length - 1]?.cursor;
      if (!cursor) break;

      page++;
      onProgress && onProgress(messages.length);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    return messages;
  }

  // ── Format chat into a text summary for Gemini ────────────────────
  // Groups messages into 30-second windows, returns spike timestamps
  function summarizeChat(messages, vodDurationSec, windowSec = 30) {
    if (!messages.length) return { summary: 'No chat data available.', spikes: [] };

    const windows = {};
    for (const msg of messages) {
      const bucket = Math.floor(msg.offsetSec / windowSec) * windowSec;
      if (!windows[bucket]) windows[bucket] = [];
      windows[bucket].push(msg);
    }

    // Find average messages per window
    const counts = Object.values(windows).map(w => w.length);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const threshold = avg * 2; // spike = 2x average activity

    const spikes = [];
    const lines = [];

    for (const [bucketStr, msgs] of Object.entries(windows).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const bucket = Number(bucketStr);
      const h = Math.floor(bucket / 3600);
      const m = Math.floor((bucket % 3600) / 60);
      const s = bucket % 60;
      const ts = h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${m}:${String(s).padStart(2,'0')}`;

      const isSpike = msgs.length >= threshold;
      if (isSpike) spikes.push({ startSec: bucket, endSec: bucket + windowSec, msgCount: msgs.length });

      // Sample up to 5 messages per window for context
      const sample = msgs.slice(0, 5).map(m => `  ${m.username}: ${m.message}`).join('\n');
      lines.push(`[${ts}] ${msgs.length} messages${isSpike ? ' ⚡SPIKE' : ''}\n${sample}`);
    }

    return {
      summary: lines.join('\n\n'),
      spikes,
      totalMessages: messages.length,
    };
  }

  return { fetchVodChat, summarizeChat };

})();
