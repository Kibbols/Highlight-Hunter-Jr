// ffmpeg-handler.js — FFmpeg.wasm v0.11.x non-threaded

window.FFmpegHandler = (() => {

  let _ff     = null;
  let _loaded = false;

  async function load() {
    if (_loaded) return;
    if (typeof FFmpeg === 'undefined') throw new Error('FFmpeg.wasm not found — add ffmpeg.js to repo root');
    const { createFFmpeg } = FFmpeg;
    _ff = createFFmpeg({ log: false, corePath: 'ffmpeg-core.js' });
    await _ff.load();
    _loaded = true;
  }

  // Download HLS segments covering [startSec, endSec]
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

  async function extractClip(hlsUrl, startSec, endSec, onProgress) {
    await load();
    const duration = endSec - startSec;
    onProgress && onProgress('Downloading clip…', 0.1);
    const blob = await fetchHlsRange(hlsUrl, startSec, endSec, onProgress);
    onProgress && onProgress('Transcoding…', 0.5);
    _ff.FS('writeFile', 'in.ts', new Uint8Array(await blob.arrayBuffer()));
    await _ff.run('-i','in.ts','-t',String(duration),'-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-movflags','+faststart','out.mp4');
    const data = _ff.FS('readFile', 'out.mp4');
    _ff.FS('unlink', 'in.ts'); _ff.FS('unlink', 'out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // crop: { x, y, width, height } all proportions 0–1
  async function applyCrop(inputBlob, crop, fullW, fullH, onProgress) {
    await load();
    let x = Math.round(crop.x * fullW);
    let y = Math.round(crop.y * fullH);
    let w = Math.round(crop.width  * fullW);
    let h = Math.round(crop.height * fullH);
    // Even dimensions
    w = w % 2 === 0 ? w : w - 1;
    h = h % 2 === 0 ? h : h - 1;
    if (x + w > fullW) x = fullW - w;
    if (y + h > fullH) y = fullH - h;
    onProgress && onProgress('Cropping…', 0.6);
    _ff.FS('writeFile', 'crop_in.mp4', new Uint8Array(await inputBlob.arrayBuffer()));
    await _ff.run('-i','crop_in.mp4','-vf',`crop=${w}:${h}:${x}:${y}`,'-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-movflags','+faststart','crop_out.mp4');
    const data = _ff.FS('readFile', 'crop_out.mp4');
    _ff.FS('unlink', 'crop_in.mp4'); _ff.FS('unlink', 'crop_out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  async function applyOverlay(clipBlob, overlayBlob, overlayMime, startOffset = 1.0, onProgress) {
    await load();
    onProgress && onProgress('Compositing overlay…', 0.8);
    _ff.FS('writeFile', 'base.mp4',  new Uint8Array(await clipBlob.arrayBuffer()));
    _ff.FS('writeFile', 'ovl',       new Uint8Array(await overlayBlob.arrayBuffer()));
    const isGif = overlayMime === 'image/gif';
    const filter = `[1:v]setpts=PTS-STARTPTS[ov];[0:v][ov]overlay=(W-w)/2:(H-h)/2:enable='gte(t,${startOffset})'[v]`;
    const args = ['-i','base.mp4'];
    if (isGif) args.push('-ignore_loop','0');
    args.push('-i','ovl','-filter_complex',filter,'-map','[v]','-map','0:a','-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-shortest','-movflags','+faststart','final.mp4');
    await _ff.run(...args);
    const data = _ff.FS('readFile', 'final.mp4');
    _ff.FS('unlink', 'base.mp4'); _ff.FS('unlink', 'ovl'); _ff.FS('unlink', 'final.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // Remux .ts blob to .mp4 container (no re-encode, just container swap)
  async function remuxToMp4(tsBlob, onProgress) {
    await load();
    onProgress && onProgress('Remuxing to mp4…', 0.5);
    _ff.FS('writeFile', 'remux_in.ts', new Uint8Array(await tsBlob.arrayBuffer()));
    await _ff.run('-i','remux_in.ts','-c','copy','-movflags','+faststart','remux_out.mp4');
    const data = _ff.FS('readFile', 'remux_out.mp4');
    _ff.FS('unlink', 'remux_in.ts'); _ff.FS('unlink', 'remux_out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  return { load, fetchHlsRange, extractClip, applyCrop, applyOverlay, remuxToMp4 };

})();
