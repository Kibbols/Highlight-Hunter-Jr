// clip-processor.js — Stage 2: per-clip Gemini analysis + FFmpeg processing

window.ClipProcessor = (() => {

  // ── Run Stage 2 for a single segment ─────────────────────────────
  // Returns { outputs: [{ label, url, blob }] }  (1 or 2 outputs depending on overlays)
  async function processClip({
    segment,              // { startSec, endSec, rank, label, fx, ... }
    smallestQualityUrl,   // HLS playlist URL for smallest resolution (Gemini analysis)
    fullQualityUrl,       // HLS master/variant URL for full resolution (FFmpeg output)
    smallestRes,          // e.g. { height: 160, width: 284 } or string '160p'
    fullResW,             // full resolution width
    fullResH,             // full resolution height
    overlayYouTube,       // { blob, mime } or null
    overlayTikTok,        // { blob, mime } or null
    onStatus,             // onStatus(message)
    cancelSignal,
  }) {

    // ── Step 1: extract low-res clip for Gemini ───────────────────
    onStatus('Extracting low-res clip for analysis…');
    const lowResBlob = await FFmpegHandler._fetchHlsRange(
      smallestQualityUrl,
      segment.startSec,
      segment.endSec,
      (msg, p) => onStatus(msg)
    ).then(blob => blob);

    const lowResMime  = 'video/mp2t';
    const lowResW     = typeof smallestRes === 'object' ? smallestRes.width  : null;
    const lowResH     = typeof smallestRes === 'object' ? smallestRes.height : null;
    const smallestStr = lowResH ? `${lowResW}x${lowResH}` : String(smallestRes);

    // ── Step 2: upload low-res clip to Gemini ─────────────────────
    onStatus('Uploading clip to Gemini…');
    const fileUri = await Gemini.uploadFile(
      new Blob([await lowResBlob.arrayBuffer()], { type: lowResMime }),
      lowResMime,
      `clip-${segment.startSec}`
    );

    // ── Step 3: Gemini crop analysis ──────────────────────────────
    onStatus('Gemini analysing crop position…');
    const prompt = buildCropPrompt(segment, smallestStr, fullResW, fullResH);
    const cropInstructions = await Gemini.generate(
      [
        { fileData: { mimeType: lowResMime, fileUri } },
        { text: prompt },
      ],
      null,
      true
    );

    // Validate crop instructions
    const crop = validateCrop(cropInstructions, segment.fx);

    // Cleanup Gemini file
    const fileName = fileUri.split('/').slice(-2).join('/');
    Gemini.deleteFile(fileName).catch(() => {});

    // ── Step 4: extract full-res clip for FFmpeg ──────────────────
    onStatus('Downloading full-res clip…');
    const fullResBlob = await FFmpegHandler.extractClip(
      fullQualityUrl,
      segment.startSec,
      segment.endSec,
      (msg, p) => onStatus(msg)
    );

    // ── Step 5: apply crop (proportional → pixel) ─────────────────
    onStatus('Cropping to 9:16…');
    let croppedBlob = await FFmpegHandler.applyCrop(
      fullResBlob,
      crop,
      fullResW,
      fullResH,
      (msg) => onStatus(msg)
    );

    // ── Step 6: produce output(s) ─────────────────────────────────
    const outputs = [];
    const hasYT  = !!overlayYouTube;
    const hasTT  = !!overlayTikTok;

    if (!hasYT && !hasTT) {
      // No overlays — single output
      onStatus('Encoding final clip…');
      outputs.push({
        label: segment.label,
        filename: `${_safeFilename(segment.label)}.mp4`,
        blob: croppedBlob,
        url: URL.createObjectURL(croppedBlob),
      });
    } else {
      if (hasYT) {
        onStatus('Compositing YouTube overlay…');
        const ytBlob = await FFmpegHandler.applyOverlay(
          croppedBlob, overlayYouTube.blob, overlayYouTube.mime, 1.0,
          (msg) => onStatus(msg)
        );
        outputs.push({
          label: `${segment.label} (YouTube)`,
          filename: `${_safeFilename(segment.label)}_yt.mp4`,
          blob: ytBlob,
          url: URL.createObjectURL(ytBlob),
        });
      }
      if (hasTT) {
        onStatus('Compositing TikTok overlay…');
        const ttBlob = await FFmpegHandler.applyOverlay(
          croppedBlob, overlayTikTok.blob, overlayTikTok.mime, 1.0,
          (msg) => onStatus(msg)
        );
        outputs.push({
          label: `${segment.label} (TikTok)`,
          filename: `${_safeFilename(segment.label)}_tt.mp4`,
          blob: ttBlob,
          url: URL.createObjectURL(ttBlob),
        });
      }
    }

    onStatus('Done ✓');
    return { outputs };
  }

  // ── Build Gemini crop prompt ──────────────────────────────────────
  function buildCropPrompt(segment, smallestRes, fullResW, fullResH) {
    const fxNote = segment.fx === 'zoom_gameplay'
      ? `IMPORTANT: This clip has a "zoom_gameplay" flag. Position the crop to EXCLUDE the facecam and focus entirely on gameplay action.`
      : `Default behavior: position the crop to INCLUDE both gameplay and facecam in the 9:16 frame if both are visible.`;

    return `You are analysing a clip extracted from a Twitch VOD.

You are seeing this clip at resolution: ${smallestRes}
The ORIGINAL full resolution is: ${fullResW}x${fullResH}

Your task is to determine the best 9:16 (vertical) crop of this 16:9 frame for a short-form video.

${fxNote}

Step 1: Detect the facecam position. Common positions: top-left, top-right, bottom-left, bottom-right, or not present.
Step 2: Determine the optimal 9:16 crop window.

CRITICAL: All values must be proportions (0.0 to 1.0) of the frame dimensions — NEVER absolute pixels.
- x: left edge as proportion of frame width (0.0 = left edge, 1.0 = right edge)
- y: top edge as proportion of frame height (0.0 = top, 1.0 = bottom)
- width: crop width as proportion of frame width
- height: crop height as proportion of frame height

For a 16:9 source to 9:16 output:
- Optimal crop width ≈ 0.5625 of the source width (9/16 ratio)
- Height = 1.0 (full height)
- x = 0.0 to 0.4375 depending on where the action is

Return ONLY a JSON object, no preamble:
{
  "facecam_position": "top-right|top-left|bottom-right|bottom-left|none",
  "x": 0.0,
  "y": 0.0,
  "width": 0.5625,
  "height": 1.0,
  "reasoning": "brief explanation"
}`;
  }

  // ── Validate and clamp crop instructions ─────────────────────────
  function validateCrop(crop, fx) {
    const safe = {
      x:      _clamp(crop.x      ?? 0.21875, 0, 0.4375),
      y:      _clamp(crop.y      ?? 0,       0, 1),
      width:  _clamp(crop.width  ?? 0.5625,  0.1, 1),
      height: _clamp(crop.height ?? 1.0,     0.1, 1),
    };
    // Ensure x + width <= 1
    if (safe.x + safe.width > 1) safe.x = Math.max(0, 1 - safe.width);
    // Ensure y + height <= 1
    if (safe.y + safe.height > 1) safe.y = Math.max(0, 1 - safe.height);
    return safe;
  }

  function _clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v) || 0)); }

  function _safeFilename(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
  }

  return { processClip };

})();
