// gemini.js — Gemini Files API + generateContent
// Model: gemini-3.1-flash-lite

window.Gemini = (() => {

  const MODEL    = 'gemini-3.1-flash-lite';
  const BASE     = 'https://generativelanguage.googleapis.com';
  const V1BETA   = `${BASE}/v1beta`;
  const UPLOAD   = `${BASE}/upload/v1beta`;

  function apiKey() {
    const k = Settings.get('gemini');
    if (!k) throw new Error('Gemini API key not set — open Settings');
    return k;
  }

  // ── Files API: upload a Blob ──────────────────────────────────────
  // Returns file URI (e.g. files/abc123) once ACTIVE
  async function uploadFile(blob, mimeType, displayName, onProgress, cancelSignal) {
    const key = apiKey();

    // Initiate resumable upload
    const initRes = await fetch(
      `${UPLOAD}/files?uploadType=multipart&key=${key}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'multipart',
          'Content-Type': `multipart/related; boundary=gem_bound`,
        },
        body: _buildMultipart(blob, mimeType, displayName),
      }
    );

    if (initRes.status === 503) {
      // Retry once on 503
      await _sleep(2000);
      return uploadFile(blob, mimeType, displayName, onProgress, cancelSignal);
    }
    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`Gemini upload failed (${initRes.status}): ${err}`);
    }

    const data = await initRes.json();
    const fileUri  = data.file?.uri || data.uri;
    const fileName = data.file?.name || data.name;

    if (!fileUri) throw new Error('Gemini upload: no URI returned');

    // Poll until ACTIVE (max 5 minutes)
    return await _pollFileActive(fileName, fileUri, cancelSignal);
  }

  function _buildMultipart(blob, mimeType, displayName) {
    const boundary  = 'gem_bound';
    const meta = JSON.stringify({ file: { display_name: displayName } });
    const enc  = new TextEncoder();

    // Build multipart body
    const metaPart  = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`);
    const filePart  = enc.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const endPart   = enc.encode(`\r\n--${boundary}--`);

    // Combine
    const total = metaPart.byteLength + filePart.byteLength + blob.size + endPart.byteLength;
    const buf   = new Uint8Array(total);
    let offset  = 0;
    buf.set(metaPart, offset); offset += metaPart.byteLength;
    buf.set(filePart,  offset); offset += filePart.byteLength;
    // We can't set a Blob directly — caller must pass ArrayBuffer or Uint8Array
    // blob will be passed as ArrayBuffer via FileReader in practice
    // For now, return a Blob of the parts + the video blob
    return new Blob([metaPart, filePart, blob, endPart]);
  }

  async function _pollFileActive(fileName, fileUri, cancelSignal) {
    const key     = apiKey();
    const timeout = Date.now() + 5 * 60 * 1000; // 5 min

    while (Date.now() < timeout) {
      if (cancelSignal && cancelSignal.cancelled) throw new Error('Cancelled');

      // fileName format: "files/abc123" — use that as path
      const res = await fetch(`${V1BETA}/${fileName}?key=${key}`);
      if (res.status === 503) { await _sleep(3000); continue; }
      if (!res.ok) throw new Error(`File poll failed: ${res.status}`);

      const data  = await res.json();
      const state = data.state || data.file?.state;
      if (state === 'ACTIVE') return fileUri;
      if (state === 'FAILED') throw new Error('Gemini file processing failed');
      await _sleep(3000);
    }
    throw new Error('Gemini file upload timed out after 5 minutes');
  }

  // ── generateContent ───────────────────────────────────────────────
  async function generate(parts, systemPrompt = null, jsonMode = false) {
    const key = apiKey();
    const body = {
      contents: [{ role: 'user', parts }],
    };
    if (systemPrompt) {
      body.system_instruction = { parts: [{ text: systemPrompt }] };
    }
    if (jsonMode) {
      body.generation_config = {
        response_mime_type: 'application/json',
      };
    }

    const res = await fetch(
      `${V1BETA}/models/${MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini generateContent failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)
      ?.map(p => p.text)
      ?.join('') || '';

    if (jsonMode) {
      // Strip any stray markdown fences
      const clean = text.replace(/```json|```/gi, '').trim();
      return JSON.parse(clean);
    }
    return text;
  }

  // ── Delete uploaded file (cleanup) ───────────────────────────────
  async function deleteFile(fileName) {
    const key = apiKey();
    try {
      await fetch(`${V1BETA}/${fileName}?key=${key}`, { method: 'DELETE' });
    } catch { /* non-fatal */ }
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { uploadFile, generate, deleteFile };

})();
