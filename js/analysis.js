// analysis.js — Stage 1: full VOD analysis via Gemini
// Block-number based approach: no AI timestamps, all timing from source data

window.Analysis = (() => {

  // ── Block builder ─────────────────────────────────────────────────
  // Divides VOD into fixed-size time blocks, each with a sequential number
  // Returns array of { blockNum, startSec, endSec, label }
  function buildBlocks(vodDurationSec, blockSizeSec = 30) {
    const blocks = [];
    let n = 1;
    for (let t = 0; t < vodDurationSec; t += blockSizeSec) {
      blocks.push({
        blockNum: n++,
        startSec: t,
        endSec: Math.min(t + blockSizeSec, vodDurationSec),
      });
    }
    return blocks;
  }

  function blocksToText(blocks) {
    return blocks.map(b =>
      `Block ${b.blockNum}: ${_fmt(b.startSec)} - ${_fmt(b.endSec)}`
    ).join('\n');
  }

  // ── Build Gemini prompt ───────────────────────────────────────────
  function buildAnalysisPrompt({
    blocks,
    highlightPrompt,
    targetClips,
    targetDurationMin,
    pacing,
    vodResolution,
    styleProfile,
  }) {
    const targetSec = Math.round(targetDurationMin * 60);
    const styleText = StyleProfiles.profileAsPromptText(styleProfile);

    return `You are an expert Twitch highlight editor. You are watching a low-resolution VOD (${vodResolution}) for analysis purposes only.

YOUR TASK:
Find the best highlights matching this description: "${highlightPrompt}"

TARGET OUTPUT: ${targetClips} clips, totalling approximately ${targetSec} seconds (${targetDurationMin} minutes), pacing: ${pacing}
${styleText}

VOD TIME BLOCKS:
${blocksToText(blocks)}

INSTRUCTIONS:
1. For each block, decide KEEP or CUT
2. For KEPT blocks, assign a rank 1-5:
   - 5 = unmissable, never trim
   - 4 = excellent
   - 3 = good
   - 2 = decent, trim first if over duration
   - 1 = weakest keep, cut first if over duration
3. Merge consecutive KEEP blocks into segments
4. Add a short label and reason for each kept segment
5. Optionally add fx flags per segment: "zoom_face" or "zoom_gameplay"
   - zoom_gameplay: shift crop to exclude facecam, focus purely on gameplay action

RESPOND WITH ONLY A JSON ARRAY. No preamble, no markdown fences. Example:
[
  {
    "blocks": [12, 13, 14],
    "rank": 5,
    "label": "Insane clutch",
    "reason": "Survival against 3 survivors with 1 hook remaining",
    "fx": "zoom_gameplay"
  },
  {
    "blocks": [28],
    "rank": 3,
    "label": "Funny chat reaction",
    "reason": "Kembi reacts to donation",
    "fx": null
  }
]`;
  }

  // ── Run Stage 1 analysis ──────────────────────────────────────────
  async function runAnalysis({
    vodBlob,           // Blob of smallest-res stream
    vodMimeType,       // e.g. 'video/mp2t'
    vodDurationSec,
    vodResolution,     // e.g. '160p' or '320x240'
    highlightPrompt,
    targetClips,
    targetDurationMin,
    pacing,
    styleProfile,
    onStage,           // onStage(label, subtext, progress 0-1)
    cancelSignal,
  }) {
    // 1. Upload to Gemini
    onStage('Uploading to Gemini…', `${(vodBlob.size / 1024 / 1024).toFixed(1)} MB`, 0.1);

    const fileUri = await Gemini.uploadFile(
      vodBlob,
      vodMimeType,
      'vod-analysis',
      null,
      cancelSignal
    );

    if (cancelSignal?.cancelled) throw new Error('Cancelled');
    onStage('Building time blocks…', '', 0.35);

    // 2. Build blocks (30s each)
    const blockSizeSec = 30;
    const blocks = buildBlocks(vodDurationSec, blockSizeSec);

    const prompt = buildAnalysisPrompt({
      blocks,
      highlightPrompt,
      targetClips,
      targetDurationMin,
      pacing,
      vodResolution,
      styleProfile,
    });

    onStage('Gemini is analysing…', `${blocks.length} blocks`, 0.45);

    // 3. Call generateContent
    const rawResult = await Gemini.generate(
      [
        { fileData: { mimeType: vodMimeType, fileUri } },
        { text: prompt },
      ],
      null,
      true // JSON mode
    );

    if (cancelSignal?.cancelled) throw new Error('Cancelled');
    onStage('Processing results…', '', 0.85);

    // 4. Map block numbers back to timestamps
    const blockMap = {};
    blocks.forEach(b => { blockMap[b.blockNum] = b; });

    let segments = _mapSegments(rawResult, blockMap);

    // 5. Duration enforcement
    const targetSec = targetDurationMin * 60;
    segments = _enforceDuration(segments, targetSec);

    onStage('Done', '', 1.0);

    // Cleanup uploaded file (non-blocking)
    const fileName = fileUri.split('/').slice(-2).join('/');
    Gemini.deleteFile(fileName).catch(() => {});

    return segments;
  }

  // ── Map AI block numbers → real timestamps ────────────────────────
  function _mapSegments(rawSegments, blockMap) {
    const out = [];
    for (const seg of rawSegments) {
      if (!seg.blocks || !seg.blocks.length) continue;
      const validBlocks = seg.blocks
        .map(n => blockMap[n])
        .filter(Boolean)
        .sort((a, b) => a.startSec - b.startSec);
      if (!validBlocks.length) continue;

      out.push({
        startSec:  validBlocks[0].startSec,
        endSec:    validBlocks[validBlocks.length - 1].endSec,
        durationSec: validBlocks[validBlocks.length - 1].endSec - validBlocks[0].startSec,
        rank:      Math.max(1, Math.min(5, seg.rank || 3)),
        label:     seg.label || 'Highlight',
        reason:    seg.reason || '',
        fx:        seg.fx || null,
        blocks:    seg.blocks,
      });
    }
    // Sort by start time
    return out.sort((a, b) => a.startSec - b.startSec);
  }

  // ── Duration enforcement ──────────────────────────────────────────
  // If total duration > target, trim lowest-ranked segments first
  function _enforceDuration(segments, targetSec) {
    const total = segments.reduce((s, seg) => s + seg.durationSec, 0);
    if (total <= targetSec) return segments;

    // Sort by rank ascending (lowest rank trimmed first)
    const sorted = segments.slice().sort((a, b) => a.rank - b.rank || b.durationSec - a.durationSec);
    let remaining = total - targetSec;
    const trimmed = new Set();

    for (const seg of sorted) {
      if (remaining <= 0) break;
      if (seg.rank === 5) continue; // never trim rank 5
      trimmed.add(seg);
      remaining -= seg.durationSec;
    }

    return segments.filter(s => !trimmed.has(s));
  }

  function _fmt(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  return { buildBlocks, runAnalysis, _fmt };

})();
