// audio-analysis.js — Audio peak detection and Whisper transcription

window.AudioAnalysis = (() => {

  // ── Rough volume/energy peak detection from raw TS bytes ──────────
  // Samples the byte data as a proxy for audio energy — not perfect
  // but avoids the fMP4 decoding issue entirely
  async function detectPeaks(tsBlob, windowSec = 10, vodDurationSec = 0) {
    try {
      const buf    = await tsBlob.arrayBuffer();
      const bytes  = new Uint8Array(buf);
      const total  = bytes.length;
      const dur    = vodDurationSec || 3600; // fallback 1hr
      const wins   = Math.ceil(dur / windowSec);
      const winBytes = Math.floor(total / wins);

      const windows = [];
      for (let i = 0; i < wins; i++) {
        const start = i * winBytes;
        const end   = Math.min(start + winBytes, total);
        let sum = 0;
        // Sample every 100th byte for speed
        for (let j = start; j < end; j += 100) sum += bytes[j];
        const avg = sum / ((end - start) / 100);
        windows.push({ startSec: i * windowSec, endSec: Math.min((i + 1) * windowSec, dur), energy: avg });
      }

      const avgEnergy   = windows.reduce((s, w) => s + w.energy, 0) / windows.length;
      const threshold   = avgEnergy * 1.3;
      const peaks       = windows.filter(w => w.energy >= threshold);

      return { peaks, avgEnergy, threshold, durationSec: dur };
    } catch(e) {
      console.warn('[Peaks] failed:', e.message);
      return { peaks: [], avgEnergy: 0, threshold: 0, durationSec: vodDurationSec };
    }
  }

  // ── Format peaks into text for Gemini ────────────────────────────
  function formatPeaks(peaks, avgEnergy) {
    if (!peaks.length) return 'No significant audio peaks detected.';
    const fmt = sec => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      return h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${m}:${String(s).padStart(2,'0')}`;
    };
    return peaks.map(p => {
      const intensity = p.energy / avgEnergy;
      return `${fmt(p.startSec)}–${fmt(p.endSec)}: energy ${intensity.toFixed(1)}x average`;
    }).join('\n');
  }

  // ── Convert TS blob to audio-only fMP4 using mux.js ─────────────
  function _tsToAudioMp4(tsBlob) {
    return new Promise((resolve, reject) => {
      if (typeof muxjs === 'undefined') { reject(new Error('mux.js not loaded')); return; }
      // audio: true tells mux.js to output audio-only fMP4
      const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
      const segments = [];
      let initSegment = null;

      transmuxer.on('data', seg => {
        if (!initSegment) initSegment = seg.initSegment;
        segments.push(new Uint8Array(seg.data));
      });
      transmuxer.on('error', e => reject(new Error('mux.js: ' + e)));

      tsBlob.arrayBuffer().then(buf => {
        const data = new Uint8Array(buf);
        const chunk = 512 * 1024; // 512KB chunks
        for (let i = 0; i < data.length; i += chunk) {
          transmuxer.push(data.slice(i, i + chunk));
        }
        transmuxer.flush();

        const total = (initSegment ? initSegment.byteLength : 0) +
          segments.reduce((s, g) => s + g.byteLength, 0);
        const mp4 = new Uint8Array(total);
        let off = 0;
        if (initSegment) { mp4.set(new Uint8Array(initSegment), off); off += initSegment.byteLength; }
        for (const seg of segments) { mp4.set(seg, off); off += seg.byteLength; }
        resolve(new Blob([mp4.buffer], { type: 'audio/mp4' }));
      }).catch(reject);
    });
  }

  // ── Transcribe using Transformers.js Whisper ──────────────────────
  async function transcribe(tsBlob, onProgress) {
    // Wait for Transformers.js to be available
    let attempts = 0;
    while (!window._transformers && attempts < 50) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    if (!window._transformers) throw new Error('Transformers.js failed to load');
    const { pipeline, env } = window._transformers;

    env.allowRemoteModels = true;
    env.allowLocalModels  = false;

    onProgress && onProgress('Loading Whisper model (downloads once ~75MB)…', 0.1);

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

    // audio_only segments from Twitch CDN are already mp4a.40.2 (AAC in MP4)
    // No conversion needed — pass directly as audio/mp4
    const audioBlob = new Blob([tsBlob], { type: 'audio/mp4' });
    console.log('[Whisper] Audio blob size:', audioBlob.size, 'bytes');
    const blobUrl = URL.createObjectURL(audioBlob);
    try {
      const result = await pipe(blobUrl, {
        return_timestamps: true,
        chunk_length_s:    30,
        stride_length_s:   5,
      });
      return result;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // ── Format transcript chunks into text for Gemini ─────────────────
  function formatTranscript(result) {
    if (!result?.chunks?.length) {
      return result?.text || 'No transcript available.';
    }
    const fmt = sec => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      return h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${m}:${String(s).padStart(2,'0')}`;
    };
    return result.chunks.map(chunk => {
      const [start] = chunk.timestamp || [0];
      return `[${fmt(start)}] ${chunk.text.trim()}`;
    }).join('\n');
  }

  return { detectPeaks, formatPeaks, transcribe, formatTranscript };

})();
