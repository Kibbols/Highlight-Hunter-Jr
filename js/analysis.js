// analysis.js — Stage 1 VOD analysis using transcript + audio peaks + chat

window.Analysis = (() => {

  function fmt(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function buildBlocks(durationSec, blockSizeSec = 30) {
    const blocks = [];
    let n = 1;
    for (let t = 0; t < durationSec; t += blockSizeSec) {
      blocks.push({ blockNum: n++, startSec: t, endSec: Math.min(t + blockSizeSec, durationSec) });
    }
    return blocks;
  }

  async function runAnalysis({
    vodBlob, vodMimeType, vodDurationSec, vodResolution,
    vodId,
    highlightPrompt, targetClips, clipMinSec, clipMaxSec, pacing,
    styleProfile, onStage, cancelSignal,
  }) {

    // ── Step 1: Download audio-only if we have a blob, otherwise use vodBlob ──
    // vodBlob here is the audio-only blob downloaded from Twitch

    // ── Step 2: Detect audio peaks ────────────────────────────────────
    onStage('Analysing audio peaks…', '', 0.05);
    let peaksText = 'No audio peak data.';
    try {
      const { peaks, avgEnergy } = await AudioAnalysis.detectPeaks(vodBlob, 10, vodDurationSec);
      peaksText = AudioAnalysis.formatPeaks(peaks, avgEnergy);
    } catch (e) {
      console.warn('Peak detection failed:', e.message);
    }
    if (cancelSignal?.cancelled) throw new Error('Cancelled');

    // ── Step 3: Transcribe with Whisper ───────────────────────────────
    onStage('Transcribing audio…', 'Loading Whisper model…', 0.1);
    let transcriptText = 'No transcript available.';
    try {
      const result = await AudioAnalysis.transcribe(vodBlob,
        (msg, pct) => onStage('Transcribing…', msg, 0.1 + pct * 0.3)
      );
      transcriptText = AudioAnalysis.formatTranscript(result);
    } catch (e) {
      console.warn('Transcription failed:', e.message);
      onStage('Transcription skipped', e.message, 0.4);
    }
    if (cancelSignal?.cancelled) throw new Error('Cancelled');

    // ── Step 4: Fetch chat replay ─────────────────────────────────────
    onStage('Fetching chat replay…', '', 0.42);
    let chatText = 'No chat data available.';
    let chatSpikes = [];
    try {
      const messages = await Chat.fetchVodChat(vodId,
        count => onStage('Fetching chat…', `${count} messages`, 0.42)
      );
      const { summary, spikes } = Chat.summarizeChat(messages, vodDurationSec);
      chatText   = summary;
      chatSpikes = spikes;
    } catch (e) {
      console.warn('Chat fetch failed:', e.message);
    }
    if (cancelSignal?.cancelled) throw new Error('Cancelled');

    // ── Step 5: Build Gemini prompt ───────────────────────────────────
    onStage('Analysing with Gemini…', 'Building prompt', 0.55);

    const styleText = StyleProfiles.asPromptText(styleProfile);

    const prompt = `You are an expert Twitch highlight editor analysing a VOD to find the best clips.

TASK: Find the best highlights matching: "${highlightPrompt}"
TARGET: You MUST return EXACTLY ${targetClips} clips. Each clip must be ${clipMinSec}–${clipMaxSec} seconds long. Pacing: ${pacing}. Do not return fewer than ${targetClips} clips.
VOD DURATION: ${fmt(vodDurationSec)}
${styleText}

You have three data sources — use ALL of them together to identify highlight moments:

--- SPEECH TRANSCRIPT (with timestamps) ---
${transcriptText}

--- AUDIO VOLUME PEAKS (moments of loud audio/reactions) ---
${peaksText}

--- CHAT REPLAY (message frequency and content by time window) ---
${chatText}

High chat activity + audio peaks + excited speech = strong highlight candidate.

Return ONLY a JSON array of EXACTLY ${targetClips} objects, no markdown, no explanation:
[{"startSec":120,"endSec":180,"rank":5,"label":"Clip title","reason":"Why it's a highlight"}]

Use seconds as integers. Rank 1–5 (5 = unmissable). Spread clips across the VOD timeline. Array must have exactly ${targetClips} entries.`;

    // ── Step 6: Send to Gemini (text only — no file upload needed) ────
    const raw = await Gemini.generate(
      [{ text: prompt }],
      null, true
    );

    if (cancelSignal?.cancelled) throw new Error('Cancelled');
    onStage('Processing results…', '', 0.9);

    // Map raw results to segment format
    const segments = raw
      .filter(s => typeof s.startSec === 'number' && typeof s.endSec === 'number')
      .map(s => ({
        startSec:    Math.max(0, s.startSec),
        endSec:      Math.min(vodDurationSec, s.endSec),
        durationSec: s.endSec - s.startSec,
        rank:        Math.max(1, Math.min(5, s.rank || 3)),
        label:       s.label || 'Highlight',
        reason:      s.reason || '',
        fx:          null,
      }))
      .filter(s => s.durationSec > 0)
      .sort((a, b) => a.startSec - b.startSec);

    // Deduplicate — remove clips that start within 30 seconds of another
    const deduped = [];
    for (const seg of segments) {
      if (!deduped.some(d => Math.abs(d.startSec - seg.startSec) < 30)) {
        deduped.push(seg);
      }
    }

    return deduped;
  }

  return { buildBlocks, runAnalysis, fmt };

})();
