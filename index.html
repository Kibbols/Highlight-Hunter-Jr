// clip-processor.js — Stage 2: per-clip Gemini crop + FFmpeg pipeline

window.ClipProcessor = (() => {

  async function processClip({ segment, smallestUrl, fullUrl, smallestRes, fullResW, fullResH, overlayYT, overlayTT, onStatus, cancelSignal }) {

    // 1. Fetch low-res clip for Gemini
    onStatus('Fetching low-res clip for analysis…');
    const lowBlob = await FFmpegHandler.fetchHlsRange(smallestUrl, segment.startSec, segment.endSec);
    const lowMime = 'video/mp2t';
    const resStr  = typeof smallestRes === 'object'
      ? `${smallestRes.width}x${smallestRes.height}`
      : String(smallestRes);

    // 2. Upload to Gemini
    onStatus('Uploading to Gemini…');
    const fileUri = await Gemini.uploadFile(new Blob([await lowBlob.arrayBuffer()], { type: lowMime }), lowMime, `clip-${segment.startSec}`);

    // 3. Gemini crop analysis
    onStatus('Analysing crop position…');
    const fxNote = segment.fx === 'zoom_gameplay'
      ? 'IMPORTANT: "zoom_gameplay" flag — exclude the facecam, focus purely on gameplay.'
      : 'Default: include both gameplay and facecam in the 9:16 crop if both are visible.';

    const crop = await Gemini.generate([
      { fileData: { mimeType: lowMime, fileUri } },
      { text: `Analysing a clip from a Twitch VOD.
Clip resolution you are seeing: ${resStr}
Original full resolution: ${fullResW}x${fullResH}

${fxNote}

Determine the best 9:16 crop of this 16:9 frame.
ALL values must be proportions (0.0–1.0) of the frame — NEVER absolute pixels.
For 16:9 → 9:16: width ≈ 0.5625, height = 1.0, x between 0 and 0.4375.

Return ONLY JSON:
{"facecam_position":"top-right|top-left|bottom-right|bottom-left|none","x":0.21875,"y":0.0,"width":0.5625,"height":1.0,"reasoning":""}` },
    ], null, true);

    // Cleanup
    const fname = fileUri.replace('https://generativelanguage.googleapis.com/v1beta/', '').split('?')[0];
    Gemini.deleteFile(fname).catch(() => {});

    // Clamp crop values
    const c = _clampCrop(crop);

    // 4. Extract full-res clip
    onStatus('Downloading full-res clip…');
    const fullBlob = await FFmpegHandler.extractClip(fullUrl, segment.startSec, segment.endSec, msg => onStatus(msg));

    // 5. Apply crop
    onStatus('Cropping to 9:16…');
    const cropped = await FFmpegHandler.applyCrop(fullBlob, c, fullResW, fullResH);

    // 6. Build outputs
    const outputs = [];
    const safe    = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';

    if (!overlayYT && !overlayTT) {
      outputs.push({ label: segment.label, filename: `${safe(segment.label)}.mp4`, blob: cropped, url: URL.createObjectURL(cropped) });
    } else {
      if (overlayYT) {
        onStatus('Compositing YouTube overlay…');
        const b = await FFmpegHandler.applyOverlay(cropped, overlayYT.blob, overlayYT.mime, 1.0);
        outputs.push({ label: `${segment.label} (YouTube)`, filename: `${safe(segment.label)}_yt.mp4`, blob: b, url: URL.createObjectURL(b) });
      }
      if (overlayTT) {
        onStatus('Compositing TikTok overlay…');
        const b = await FFmpegHandler.applyOverlay(cropped, overlayTT.blob, overlayTT.mime, 1.0);
        outputs.push({ label: `${segment.label} (TikTok)`, filename: `${safe(segment.label)}_tt.mp4`, blob: b, url: URL.createObjectURL(b) });
      }
    }

    onStatus('Done ✓');
    return { outputs };
  }

  function _clampCrop(c) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
    const x = clamp(c.x ?? 0.21875, 0, 0.4375);
    const y = clamp(c.y ?? 0, 0, 1);
    const w = clamp(c.width  ?? 0.5625, 0.1, 1);
    const h = clamp(c.height ?? 1.0,    0.1, 1);
    return {
      x: x + w > 1 ? 1 - w : x,
      y: y + h > 1 ? 1 - h : y,
      width: w, height: h,
    };
  }

  return { processClip };

})();
