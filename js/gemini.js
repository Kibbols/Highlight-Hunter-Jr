// gemini.js — Gemini Files API + generateContent (gemini-3.1-flash-lite)

window.Gemini = (() => {

  const MODEL  = 'gemini-3.1-flash-lite';
  const BASE   = 'https://generativelanguage.googleapis.com';
  const V1B    = `${BASE}/v1beta`;
  const UPLOAD = `${BASE}/upload/v1beta`;

  function _key() {
    const k = Settings.get('gemini_key');
    if (!k) throw new Error('Gemini API key not set — open Settings');
    return k;
  }

  // ── Upload blob via multipart ─────────────────────────────────────
  async function uploadFile(blob, mimeType, displayName, _onProgress, cancelSignal) {
    const key = _key();

    const meta    = JSON.stringify({ file: { display_name: displayName } });
    const enc     = new TextEncoder();
    const boundary = 'gem_bound';
    const body    = new Blob([
      enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      enc.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      blob,
      enc.encode(`\r\n--${boundary}--`),
    ]);

    let res = await fetch(`${UPLOAD}/files?uploadType=multipart&key=${key}`, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });

    if (res.status === 503) {
      await _sleep(2000);
      res = await fetch(`${UPLOAD}/files?uploadType=multipart&key=${key}`, {
        method: 'POST',
        headers: { 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
    }
    if (!res.ok) throw new Error(`Gemini upload failed (${res.status}): ${await res.text()}`);

    const data     = await res.json();
    const fileUri  = data.file?.uri  || data.uri;
    const fileName = data.file?.name || data.name;
    if (!fileUri) throw new Error('Gemini upload: no URI in response');

    return _pollActive(fileName, fileUri, cancelSignal);
  }

  async function _pollActive(fileName, fileUri, cancelSignal) {
    const key     = _key();
    const timeout = Date.now() + 5 * 60 * 1000;
    while (Date.now() < timeout) {
      if (cancelSignal?.cancelled) throw new Error('Cancelled');
      const r = await fetch(`${V1B}/${fileName}?key=${key}`);
      if (r.status === 503) { await _sleep(3000); continue; }
      if (!r.ok) throw new Error(`File poll failed: ${r.status}`);
      const d     = await r.json();
      const state = d.state || d.file?.state;
      if (state === 'ACTIVE') return fileUri;
      if (state === 'FAILED') throw new Error('Gemini file processing failed');
      await _sleep(3000);
    }
    throw new Error('Gemini upload timed out after 5 minutes');
  }

  // ── generateContent ───────────────────────────────────────────────
  async function generate(parts, systemPrompt = null, jsonMode = false) {
    const key  = _key();
    const body = { contents: [{ role: 'user', parts }] };
    if (systemPrompt) body.system_instruction = { parts: [{ text: systemPrompt }] };
    if (jsonMode)     body.generation_config   = { response_mime_type: 'application/json' };

    const res = await fetch(`${V1B}/models/${MODEL}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gemini generateContent failed (${res.status}): ${await res.text()}`);

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';

    if (jsonMode) {
      return JSON.parse(text.replace(/```json|```/gi, '').trim());
    }
    return text;
  }

  // ── Delete uploaded file (cleanup) ───────────────────────────────
  async function deleteFile(fileName) {
    try { await fetch(`${V1B}/${fileName}?key=${_key()}`, { method: 'DELETE' }); } catch { /* non-fatal */ }
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { uploadFile, generate, deleteFile };

})();
