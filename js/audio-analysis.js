// audio-analysis.js — Audio peak detection and transcription via Transformers.js

window.AudioAnalysis = (() => {

  // ── Detect volume peaks from audio blob ───────────────────────────
  // Returns array of { startSec, endSec, rms } for windows above threshold
  async function _transmuxToAudio(tsBlob) {
    // Use mux.js to convert MPEG-TS to fMP4 so Web Audio API can decode it
    return new Promise((resolve, reject) => {
      const transmuxer = new muxjs.mp4.Transmuxer();
      const segments = [];
      let initSegment = null;
      transmuxer.on('data', seg => {
        if (!initSegment) initSegment = seg.initSegment;
        segments.push(new Uint8Array(seg.data));
      });
      transmuxer.on('error', e => reject(new Error('mux.js: ' + e)));
      tsBlob.arrayBuffer().then(buf => {
        const data = new Uint8Array(buf);
        const chunk = 1024 * 1024;
        for (let i = 0; i < data.length; i += chunk) transmuxer.push(data.slice(i, i + chunk));
        transmuxer.flush();
        const total = (initSegment ? initSegment.byteLength : 0) + segments.reduce((s, g) => s + g.byteLength, 0);
        const mp4 = new Uint8Array(total);
        let off = 0;
        if (initSegment) { mp4.set(new Uint8Array(initSegment), off); off += initSegment.byteLength; }
        for (const seg of segments) { mp4.set(seg, off); off += seg.byteLength; }
        resolve(new Blob([mp4.buffer], { type: 'audio/mp4' }));
      }).catch(reject);
    });
  }

  async function detectPeaks(audioBlob, windowSec = 5) {
    let decodeBlob;
    try {
      decodeBlob = await _transmuxToAudio(audioBlob);
    } catch(e) {
      console.warn('[Peaks] Transmux failed, skipping peaks:', e.message);
      return { peaks: [], avgRms: 0, threshold: 0, durationSec: 0 };
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let audioBuf;
    try {
      const arrayBuf = await decodeBlob.arrayBuffer();
      audioBuf = await ctx.decodeAudioData(arrayBuf);
    } catch(e) {
      ctx.close();
      console.warn('[Peaks] decodeAudioData failed:', e.message);
      return { peaks: [], avgRms: 0, threshold: 0, durationSec: 0 };
    }
    ctx.close();

    const data     = audioBuf.getChannelData(0); // mono
    const sr       = audioBuf.sampleRate;
    const winSize  = Math.floor(windowSec * sr);
    const windows  = [];

    for (let i = 0; i < data.length; i += winSize) {
      const slice = data.slice(i, i + winSize);
      let sum = 0;
      for (let j = 0; j < slice.length; j++) sum += slice[j] * slice[j];
      const rms = Math.sqrt(sum / slice.length);
      windows.push({ startSec: i / sr, endSec: Math.min((i + winSize) / sr, audioBuf.duration), rms });
    }

    // Find average RMS, flag windows above 1.5x average as peaks
    const avg = windows.reduce((s, w) => s + w.rms, 0) / windows.length;
    const threshold = avg * 1.5;
    const peaks = windows.filter(w => w.rms >= threshold);

    return { peaks, avgRms: avg, threshold, durationSec: audioBuf.duration };
  }

  // ── Format peaks into text for Gemini ────────────────────────────
  function formatPeaks(peaks, avgRms) {
    if (!peaks.length) return 'No significant audio peaks detected.';

    return peaks.map(p => {
      const fmt = sec => {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return h > 0
          ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
          : `${m}:${String(s).padStart(2,'0')}`;
      };
      const intensity = p.rms / avgRms;
      return `${fmt(p.startSec)}–${fmt(p.endSec)}: volume ${intensity.toFixed(1)}x average`;
    }).join('\n');
  }

  // ── Transcribe audio using Transformers.js Whisper ────────────────
  // Model downloads once (~75MB for tiny) and caches in browser
  async function transcribe(audioBlob, onProgress) {
    // Wait for Transformers.js to be available (loaded via module script in index.html)
    let attempts = 0;
    while (!window._transformers && attempts < 50) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    if (!window._transformers) throw new Error('Transformers.js failed to load — check browser console');
    const { pipeline, env } = window._transformers;

    // Allow remote model loading from Hugging Face
    env.allowRemoteModels = true;
    env.allowLocalModels  = false;

    onProgress && onProgress('Loading Whisper model (downloads once, ~75MB)…', 0.1);

    const pipe = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en',
      {
        progress_callback: info => {
          if (info.status === 'downloading') {
            const pct = info.loaded / info.total;
            onProgress && onProgress(`Downloading Whisper model… ${Math.round(pct * 100)}%`, 0.1 + pct * 0.2);
          }
        },
      }
    );

    onProgress && onProgress('Transcribing audio…', 0.35);

    // Convert blob to Float32Array at 16kHz (Whisper requirement)
    // First transmux TS to fMP4 so AudioContext can decode it
    const mp4Blob  = await _transmuxToAudio(audioBlob);
    const ctx      = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    let audioBuf;
    try {
      const arrayBuf = await mp4Blob.arrayBuffer();
      audioBuf = await ctx.decodeAudioData(arrayBuf);
    } catch(e) {
      ctx.close();
      throw new Error(`Audio decode failed: ${e.message} — browser may not support fMP4 audio decoding`);
    }
    ctx.close();

    const float32 = audioBuf.getChannelData(0);

    const result = await pipe(float32, {
      return_timestamps: true,
      chunk_length_s:    30,
      stride_length_s:   5,
    });

    return result;
  }

  // ── Format transcript chunks into text for Gemini ─────────────────
  function formatTranscript(result) {
    if (!result?.chunks?.length) {
      return result?.text || 'No transcript available.';
    }

    return result.chunks.map(chunk => {
      const [start] = chunk.timestamp || [0];
      const fmt = sec => {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return h > 0
          ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
          : `${m}:${String(s).padStart(2,'0')}`;
      };
      return `[${fmt(start)}] ${chunk.text.trim()}`;
    }).join('\n');
  }

  return { detectPeaks, formatPeaks, transcribe, formatTranscript };

})();
