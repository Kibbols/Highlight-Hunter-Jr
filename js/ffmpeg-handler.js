// ffmpeg-handler.js — FFmpeg.wasm v0.11.x non-threaded wrapper
// Handles: clip extraction, 9:16 crop, CTA overlay compositing

window.FFmpegHandler = (() => {

  let _ffmpeg = null;
  let _loaded = false;

  async function load() {
    if (_loaded) return;
    if (typeof FFmpeg === 'undefined') throw new Error('FFmpeg.wasm not found. Add ffmpeg.js to your repo root.');
    const { createFFmpeg, fetchFile } = FFmpeg;
    _ffmpeg = createFFmpeg({
      log: false,
      corePath: 'ffmpeg-core.js', // non-threaded core in repo root
    });
    await _ffmpeg.load();
    _loaded = true;
  }

  // ── Extract a clip from full-res stream via HLS url ───────────────
  // Returns a Blob of the extracted clip (full resolution)
  async function extractClip(hlsUrl, startSec, endSec, onProgress) {
    await load();
    const duration = endSec - startSec;
    const outName  = 'clip_out.mp4';

    // Write input file — we fetch the HLS segments for this time range
    // For HLS, we pass the URL directly using FFmpeg's HLS demuxer
    // Note: FFmpeg.wasm can't fetch URLs directly; we must download first
    onProgress && onProgress('Downloading clip segments…', 0.1);
    const blob = await _fetchHlsRange(hlsUrl, startSec, endSec, onProgress);

    onProgress && onProgress('Transcoding…', 0.5);
    _ffmpeg.FS('writeFile', 'input.ts', new Uint8Array(await blob.arrayBuffer()));

    await _ffmpeg.run(
      '-i', 'input.ts',
      '-ss', '0',
      '-t', String(duration),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outName
    );

    const data = _ffmpeg.FS('readFile', outName);
    _ffmpeg.FS('unlink', 'input.ts');
    _ffmpeg.FS('unlink', outName);
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // ── Apply 9:16 crop based on Gemini proportional crop instructions ─
  // cropInstructions: { x: 0.0-1.0, width: 0.0-1.0, y: 0.0-1.0, height: 0.0-1.0 }
  //   expressed as proportions of the FULL resolution frame
  // fullResW, fullResH: the actual dimensions of the source clip
  async function applyCrop(inputBlob, cropInstructions, fullResW, fullResH, onProgress) {
    await load();

    // Scale proportions to absolute pixels
    const cropX = Math.round(cropInstructions.x * fullResW);
    const cropY = Math.round(cropInstructions.y * fullResH);
    const cropW = Math.round(cropInstructions.width  * fullResW);
    const cropH = Math.round(cropInstructions.height * fullResH);

    // Ensure even dimensions (H.264 requirement)
    const w = cropW % 2 === 0 ? cropW : cropW - 1;
    const h = cropH % 2 === 0 ? cropH : cropH - 1;
    const x = cropX;
    const y = cropY;

    onProgress && onProgress('Applying crop…', 0.6);
    _ffmpeg.FS('writeFile', 'crop_in.mp4', new Uint8Array(await inputBlob.arrayBuffer()));

    await _ffmpeg.run(
      '-i', 'crop_in.mp4',
      '-vf', `crop=${w}:${h}:${x}:${y}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      'cropped.mp4'
    );

    const data = _ffmpeg.FS('readFile', 'cropped.mp4');
    _ffmpeg.FS('unlink', 'crop_in.mp4');
    _ffmpeg.FS('unlink', 'cropped.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // ── Overlay a CTA gif/mp4 onto the clip ───────────────────────────
  // overlayBlob: GIF or alpha MP4
  // startOffset: seconds into clip where overlay appears (default 1.0)
  async function applyOverlay(clipBlob, overlayBlob, overlayMime, startOffset = 1.0, onProgress) {
    await load();

    onProgress && onProgress('Compositing overlay…', 0.8);

    _ffmpeg.FS('writeFile', 'base.mp4',    new Uint8Array(await clipBlob.arrayBuffer()));
    _ffmpeg.FS('writeFile', 'overlay_src', new Uint8Array(await overlayBlob.arrayBuffer()));

    const isGif = overlayMime === 'image/gif';

    // Overlay filter: center it, start at startOffset seconds
    // For GIF: use -ignore_loop 0 so it loops for the full duration
    const filterComplex = `[1:v]setpts=PTS-STARTPTS[ov];[0:v][ov]overlay=(W-w)/2:(H-h)/2:enable='gte(t,${startOffset})'[v]`;

    const inputArgs = isGif
      ? ['-ignore_loop', '0', '-i', 'overlay_src']
      : ['-i', 'overlay_src'];

    await _ffmpeg.run(
      '-i', 'base.mp4',
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-map', '0:a',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-shortest',
      '-movflags', '+faststart',
      'final.mp4'
    );

    const data = _ffmpeg.FS('readFile', 'final.mp4');
    _ffmpeg.FS('unlink', 'base.mp4');
    _ffmpeg.FS('unlink', 'overlay_src');
    _ffmpeg.FS('unlink', 'final.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // ── Apply zoom effect ─────────────────────────────────────────────
  // type: 'zoom_face' or 'zoom_gameplay' (handled via crop adjustments
  // passed from Gemini; this function applies a simple scale if needed)
  async function applyZoom(clipBlob, zoomFactor = 1.2, onProgress) {
    await load();
    onProgress && onProgress('Applying zoom…', 0.75);
    _ffmpeg.FS('writeFile', 'zoom_in.mp4', new Uint8Array(await clipBlob.arrayBuffer()));

    // Zoom crop: crop to center 1/zoomFactor of the frame then scale back up
    const scale = 1 / zoomFactor;
    const filter = `crop=iw*${scale.toFixed(4)}:ih*${scale.toFixed(4)}:(iw-iw*${scale.toFixed(4)})/2:(ih-ih*${scale.toFixed(4)})/2,scale=iw*${zoomFactor.toFixed(4)}:ih*${zoomFactor.toFixed(4)}`;

    await _ffmpeg.run(
      '-i', 'zoom_in.mp4',
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      'zoom_out.mp4'
    );

    const data = _ffmpeg.FS('readFile', 'zoom_out.mp4');
    _ffmpeg.FS('unlink', 'zoom_in.mp4');
    _ffmpeg.FS('unlink', 'zoom_out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // ── HLS range downloader ──────────────────────────────────────────
  // Downloads only the .ts segments that cover [startSec, endSec]
  async function _fetchHlsRange(hlsUrl, startSec, endSec, onProgress) {
    const res = await fetch(hlsUrl);
    if (!res.ok) throw new Error(`HLS playlist fetch failed: ${res.status}`);
    const text = await res.text();

    const lines    = text.split('\n').map(l => l.trim()).filter(Boolean);
    const baseUrl  = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);

    // Parse segment durations and URLs
    const segments = [];
    let cumTime    = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:')) {
        const dur = parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
        const url = lines[i + 1]?.startsWith('http') ? lines[i + 1] : baseUrl + lines[i + 1];
        segments.push({ startTime: cumTime, endTime: cumTime + dur, dur, url });
        cumTime += dur;
        i++;
      }
    }

    // Select segments that overlap [startSec, endSec]
    const needed = segments.filter(s => s.endTime > startSec && s.startTime < endSec);
    const blobs  = [];

    for (let i = 0; i < needed.length; i++) {
      const segRes = await fetch(needed[i].url);
      if (!segRes.ok) throw new Error(`Segment fetch failed: ${segRes.status}`);
      blobs.push(await segRes.arrayBuffer());
      onProgress && onProgress(`Downloading segments… ${i + 1}/${needed.length}`, 0.1 + 0.35 * ((i + 1) / needed.length));
    }

    return new Blob(blobs, { type: 'video/mp2t' });
  }

  return { load, extractClip, applyCrop, applyOverlay, applyZoom };

})();
