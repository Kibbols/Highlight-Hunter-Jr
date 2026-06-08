// analysis.js — Stage 1 VOD analysis

window.Analysis = (() => {

  function buildBlocks(durationSec, blockSizeSec = 30) {
    const blocks = [];
    let n = 1;
    for (let t = 0; t < durationSec; t += blockSizeSec) {
      blocks.push({ blockNum: n++, startSec: t, endSec: Math.min(t + blockSizeSec, durationSec) });
    }
    return blocks;
  }

  function blocksToText(blocks) {
    return blocks.map(b => `Block ${b.blockNum}: ${fmt(b.startSec)} – ${fmt(b.endSec)}`).join('\n');
  }

  async function runAnalysis({
    vodBlob, vodMimeType, vodDurationSec, vodResolution,
    highlightPrompt, targetClips, clipMinSec, clipMaxSec, pacing,
    styleProfile, onStage, cancelSignal,
  }) {
    onStage('Remuxing to mp4…', 'Converting for Gemini compatibility', 0.08);
    const mp4Blob = await FFmpegHandler.remuxToMp4(vodBlob,
      (msg, pct) => onStage('Remuxing…', msg, 0.08 + pct * 0.12)
    );
    if (cancelSignal?.cancelled) throw new Error('Cancelled');

    onStage('Uploading to Gemini…', `${(mp4Blob.size / 1024 / 1024).toFixed(1)} MB`, 0.2);

    const fileUri = await Gemini.uploadFile(mp4Blob, 'video/mp4', 'vod-analysis', null, cancelSignal);
    if (cancelSignal?.cancelled) throw new Error('Cancelled');

    onStage('Building time blocks…', '', 0.35);
    const blocks = buildBlocks(vodDurationSec);
    const targetSec = clipMaxSec * targetClips;
    const styleText = StyleProfiles.asPromptText(styleProfile);

    const prompt = `You are an expert Twitch highlight editor. You are watching a low-resolution VOD (${vodResolution}) for analysis only.

TASK: Find the best highlights matching: "${highlightPrompt}"
TARGET: ${targetClips} clips, each between ${clipMinSec}–${clipMaxSec} seconds, pacing: ${pacing}
${styleText}

VOD TIME BLOCKS:
${blocksToText(blocks)}

For each block decide KEEP or CUT. For KEPT blocks assign rank 1–5 (5 = unmissable, never trim; 1 = weakest, trim first). Merge consecutive KEEP blocks into segments. Optionally flag fx: "zoom_face" or "zoom_gameplay" (zoom_gameplay = exclude facecam, focus on gameplay action).

Return ONLY a JSON array, no markdown:
[{"blocks":[1,2,3],"rank":5,"label":"Clip title","reason":"Why it's a highlight","fx":null}]`;

    onStage('Gemini is analysing…', `${blocks.length} blocks`, 0.45);

    const raw = await Gemini.generate(
      [{ fileData: { mimeType: vodMimeType, fileUri } }, { text: prompt }],
      null, true
    );

    if (cancelSignal?.cancelled) throw new Error('Cancelled');
    onStage('Processing results…', '', 0.85);

    const blockMap = {};
    blocks.forEach(b => { blockMap[b.blockNum] = b; });
    let segments = _mapSegments(raw, blockMap);
    segments = _enforceDuration(segments, targetSec);

    // Cleanup uploaded file
    const name = fileUri.replace('https://generativelanguage.googleapis.com/v1beta/', '').split('?')[0];
    Gemini.deleteFile(name).catch(() => {});

    return segments;
  }

  function _mapSegments(raw, blockMap) {
    return raw
      .filter(s => s.blocks?.length)
      .map(s => {
        const valid = s.blocks.map(n => blockMap[n]).filter(Boolean).sort((a, b) => a.startSec - b.startSec);
        if (!valid.length) return null;
        return {
          startSec:    valid[0].startSec,
          endSec:      valid[valid.length - 1].endSec,
          durationSec: valid[valid.length - 1].endSec - valid[0].startSec,
          rank:        Math.max(1, Math.min(5, s.rank || 3)),
          label:       s.label || 'Highlight',
          reason:      s.reason || '',
          fx:          s.fx || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startSec - b.startSec);
  }

  function _enforceDuration(segments, targetSec) {
    const total = segments.reduce((s, seg) => s + seg.durationSec, 0);
    if (total <= targetSec) return segments;
    const sorted = segments.slice().sort((a, b) => a.rank - b.rank || b.durationSec - a.durationSec);
    let over = total - targetSec;
    const trim = new Set();
    for (const seg of sorted) {
      if (over <= 0) break;
      if (seg.rank === 5) continue;
      trim.add(seg);
      over -= seg.durationSec;
    }
    return segments.filter(s => !trim.has(s));
  }

  function fmt(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  return { buildBlocks, runAnalysis, fmt };

})();
