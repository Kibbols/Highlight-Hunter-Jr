// ffmpeg-handler.js — FFmpeg.wasm v0.12.x (FFmpegWASM global)

window.FFmpegHandler = (() => {

  let _ff     = null;
  let _loaded = false;

  async function _toBlobURL(url, mimeType) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const blob = new Blob([await res.arrayBuffer()], { type: mimeType });
    return URL.createObjectURL(blob);
  }

  async function load() {
    if (_loaded) return;
    if (typeof FFmpegWASM === 'undefined') throw new Error('FFmpeg.wasm not found — add ffmpeg.js to repo root');
    const { FFmpeg } = FFmpegWASM;
    _ff = new FFmpeg();
    _ff.on('log', ({ message }) => console.log('[FFmpeg]', message));
    const base = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '/');
    const coreURL = await _toBlobURL(base + 'ffmpeg-core.js', 'text/javascript');
    const wasmURL = await _toBlobURL(base + 'ffmpeg-core.wasm', 'application/wasm');
    await _ff.load({ coreURL, wasmURL });
    _loaded = true;
  }

  // ── Write/read helpers ────────────────────────────────────────────
  async function _write(name, blob) {
    await _ff.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
  }

  async function _read(name) {
    return new Uint8Array(await _ff.readFile(name));
  }

  async function _unlink(...names) {
    for (const n of names) try { await _ff.deleteFile(n); } catch { /* ignore */ }
  }

  // ── Download HLS segments covering [startSec, endSec] ────────────
  async function fetchHlsRange(hlsUrl, startSec, endSec, onProgress) {
    const res = await fetch(hlsUrl);
    if (!res.ok) throw new Error(`Playlist fetch failed: ${res.status}`);
    const text  = await res.text();
    const base  = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const segs = [];
    let cum = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXTINF:')) continue;
      const dur = parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
      const url = lines[i + 1]?.startsWith('http') ? lines[i + 1] : base + lines[i + 1];
      segs.push({ start: cum, end: cum + dur, url });
      cum += dur;
      i++;
    }

    const needed = segs.filter(s => s.end > startSec && s.start < endSec);
    const parts  = [];
    for (let i = 0; i < needed.length; i++) {
      const r = await fetch(needed[i].url);
      if (!r.ok) throw new Error(`Segment fetch failed: ${r.status}`);
      parts.push(await r.arrayBuffer());
      onProgress && onProgress(`Downloading… ${i + 1}/${needed.length}`, (i + 1) / needed.length);
    }
    return new Blob(parts, { type: 'video/mp2t' });
  }

  // ── Remux .ts blob to fMP4 using mux.js (no FFmpeg, no memory limits) ──
  async function remuxToMp4(tsBlob, onProgress) {
    if (!tsBlob || tsBlob.size === 0) throw new Error('Remux input blob is empty');
    if (typeof muxjs === 'undefined') throw new Error('mux.js not loaded');

    onProgress && onProgress('Remuxing to mp4…', 0.1);

    return new Promise((resolve, reject) => {
      const transmuxer = new muxjs.mp4.Transmuxer();
      const segments = [];
      let initSegment = null;

      transmuxer.on('data', segment => {
        if (!initSegment) {
          initSegment = segment.initSegment;
        }
        const data = new Uint8Array(segment.data.byteLength);
        data.set(new Uint8Array(segment.data), 0);
        segments.push(data);
      });

      transmuxer.on('error', err => reject(new Error('mux.js error: ' + err)));

      tsBlob.arrayBuffer().then(buf => {
        const chunkSize = 1024 * 1024; // 1MB chunks
        const data = new Uint8Array(buf);
        const total = Math.ceil(data.length / chunkSize);

        for (let i = 0; i < data.length; i += chunkSize) {
          transmuxer.push(data.slice(i, i + chunkSize));
          onProgress && onProgress('Remuxing…', 0.1 + 0.8 * ((i / chunkSize) / total));
        }
        transmuxer.flush();

        // Assemble final MP4 blob
        const totalBytes = (initSegment ? initSegment.byteLength : 0) +
          segments.reduce((s, seg) => s + seg.byteLength, 0);
        const mp4 = new Uint8Array(totalBytes);
        let offset = 0;
        if (initSegment) {
          mp4.set(new Uint8Array(initSegment), offset);
          offset += initSegment.byteLength;
        }
        for (const seg of segments) {
          mp4.set(seg, offset);
          offset += seg.byteLength;
        }

        onProgress && onProgress('Remux complete', 1.0);
        resolve(new Blob([mp4.buffer], { type: 'video/mp4' }));
      }).catch(reject);
    });
  }

  // ── Extract a clip from HLS by time range ─────────────────────────
  async function extractClip(hlsUrl, startSec, endSec, onProgress) {
    await load();
    const duration = endSec - startSec;
    onProgress && onProgress('Downloading clip…', 0.1);
    const blob = await fetchHlsRange(hlsUrl, startSec, endSec, onProgress);
    onProgress && onProgress('Transcoding…', 0.5);
    await _write('in.ts', blob);
    await _ff.exec(['-i','in.ts','-t',String(duration),'-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-movflags','+faststart','out.mp4']);
    const data = await _read('out.mp4');
    await _unlink('in.ts', 'out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // ── Crop video to 9:16 ────────────────────────────────────────────
  async function applyCrop(inputBlob, crop, fullW, fullH, onProgress) {
    await load();
    let x = Math.round(crop.x * fullW);
    let y = Math.round(crop.y * fullH);
    let w = Math.round(crop.width  * fullW);
    let h = Math.round(crop.height * fullH);
    w = w % 2 === 0 ? w : w - 1;
    h = h % 2 === 0 ? h : h - 1;
    if (x + w > fullW) x = fullW - w;
    if (y + h > fullH) y = fullH - h;
    onProgress && onProgress('Cropping…', 0.6);
    await _write('crop_in.mp4', inputBlob);
    await _ff.exec(['-i','crop_in.mp4','-vf',`crop=${w}:${h}:${x}:${y}`,'-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-movflags','+faststart','crop_out.mp4']);
    const data = await _read('crop_out.mp4');
    await _unlink('crop_in.mp4', 'crop_out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // ── Apply overlay (gif or image) ──────────────────────────────────
  async function applyOverlay(clipBlob, overlayBlob, overlayMime, startOffset = 1.0, onProgress) {
    await load();
    onProgress && onProgress('Compositing overlay…', 0.8);
    await _write('base.mp4', clipBlob);
    await _write('ovl', overlayBlob);
    const isGif = overlayMime === 'image/gif';
    const filter = `[1:v]setpts=PTS-STARTPTS[ov];[0:v][ov]overlay=(W-w)/2:(H-h)/2:enable='gte(t,${startOffset})'[v]`;
    const args = ['-i','base.mp4'];
    if (isGif) args.push('-ignore_loop','0');
    args.push('-i','ovl','-filter_complex',filter,'-map','[v]','-map','0:a','-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-shortest','-movflags','+faststart','final.mp4');
    await _ff.exec(args);
    const data = await _read('final.mp4');
    await _unlink('base.mp4', 'ovl', 'final.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  return { load, fetchHlsRange, remuxToMp4, extractClip, applyCrop, applyOverlay };

})();
