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

  const CHUNK_BYTES = 100 * 1024 * 1024; // 100MB per chunk — well under FFmpeg.wasm 261MB limit
  const SEGMENT_DURATION_SEC = 10;       // each .ts segment is 10 seconds

  // ── Convert a TS blob chunk to WAV using FFmpeg.wasm ─────────────
  async function _tsChunkToWav(tsChunk, chunkIndex) {
    await FFmpegHandler.load();
    const _ff = FFmpegHandler._ff;
    if (!_ff) throw new Error('FFmpeg not loaded');

    const inFile  = `chunk_${chunkIndex}.ts`;
    const outFile = `chunk_${chunkIndex}.wav`;
    const inData  = new Uint8Array(await tsChunk.arrayBuffer());
    console.log(`[FFmpeg] Chunk ${chunkIndex}: ${inData.length} bytes`);

    await _ff.writeFile(inFile, inData);
    await _ff.exec([
      '-i', inFile,
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      outFile,
    ]);
    const wavData = await _ff.readFile(outFile);
    await _ff.deleteFile(inFile);
    await _ff.deleteFile(outFile);
    return new Blob([wavData.buffer], { type: 'audio/wav' });
  }

  // ── Parse WAV → Float32Array without AudioContext.decodeAudioData ──
  // WAV is just a header + raw PCM samples — we read it directly
  // FFmpeg outputs pcm_s16le at 16kHz mono, so the format is known
  async function _wavToFloat32(wavBlob) {
    const buf   = await wavBlob.arrayBuffer();
    const view  = new DataView(buf);

    // Find 'data' chunk (starts at byte 12, scan for 0x64617461)
    let dataOffset = 12;
    while (dataOffset < buf.byteLength - 8) {
      const chunkId   = view.getUint32(dataOffset, false);
      const chunkSize = view.getUint32(dataOffset + 4, true);
      if (chunkId === 0x64617461) { // 'data'
        dataOffset += 8;
        break;
      }
      dataOffset += 8 + chunkSize;
    }

    // PCM s16le → Float32Array
    const samples = new Int16Array(buf, dataOffset);
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      float32[i] = samples[i] / 32768.0;
    }
    return float32;
  }

  // ── Transcribe a single WAV blob, offset timestamps by startSec ──
  async function _transcribeWav(pipe, wavBlob, startSec) {
    // Parse WAV directly to Float32Array — no AudioContext.decodeAudioData needed
    const float32 = await _wavToFloat32(wavBlob);
    console.log(`[Whisper] Float32Array samples: ${float32.length} (${(float32.length/16000/60).toFixed(1)} min)`);

    const result = await pipe(float32, {
      return_timestamps: true,
      chunk_length_s:    30,
      stride_length_s:   5,
    });

    // Offset timestamps by where this chunk starts in the full VOD
    if (result?.chunks) {
      result.chunks = result.chunks.map(c => ({
        ...c,
        timestamp: c.timestamp
          ? [c.timestamp[0] + startSec, c.timestamp[1] ? c.timestamp[1] + startSec : null]
          : [startSec, null],
      }));
    }
    return result;
  }

  // ── Transcribe using Transformers.js Whisper, chunked ────────────
  // Splits the TS blob into ~100MB chunks so FFmpeg.wasm never hits its 261MB limit
  // Works for any VOD length
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

    onProgress && onProgress('Loading Whisper model (downloads once ~75MB)…', 0.05);

    const pipe = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en',
      {
        progress_callback: info => {
          if (info.status === 'downloading') {
            const pct = info.loaded / info.total;
            onProgress && onProgress(
              `Downloading Whisper model… ${Math.round(pct * 100)}%`,
              0.05 + pct * 0.1
            );
          }
        },
      }
    );

    // Split blob into ~100MB chunks
    const totalBytes   = tsBlob.size;
    const numChunks    = Math.ceil(totalBytes / CHUNK_BYTES);
    const bytesPerSeg  = totalBytes / (tsBlob.size / 535000); // approx segment size
    const segsPerChunk = Math.ceil(CHUNK_BYTES / bytesPerSeg);
    const secPerChunk  = segsPerChunk * SEGMENT_DURATION_SEC;

    console.log(`[Whisper] ${totalBytes} bytes → ${numChunks} chunks of ~${CHUNK_BYTES/1024/1024}MB`);

    const allChunks = [];
    let fullText    = '';

    for (let i = 0; i < numChunks; i++) {
      const startByte = i * CHUNK_BYTES;
      const endByte   = Math.min(startByte + CHUNK_BYTES, totalBytes);
      const startSec  = i * secPerChunk;
      const pctBase   = 0.15 + (i / numChunks) * 0.75;

      onProgress && onProgress(
        `Converting chunk ${i + 1}/${numChunks} to WAV…`,
        pctBase
      );

      const chunk  = tsBlob.slice(startByte, endByte);
      let wavBlob;
      try {
        wavBlob = await _tsChunkToWav(chunk, i);
        console.log(`[Whisper] Chunk ${i} WAV: ${wavBlob.size} bytes`);
      } catch(e) {
        throw new Error(`FFmpeg chunk ${i} failed: ${e.message}`);
      }

      onProgress && onProgress(
        `Transcribing chunk ${i + 1}/${numChunks}…`,
        pctBase + (0.75 / numChunks) * 0.5
      );

      const result = await _transcribeWav(pipe, wavBlob, startSec);
      if (result?.chunks) allChunks.push(...result.chunks);
      if (result?.text)   fullText += result.text + ' ';
    }

    return { chunks: allChunks, text: fullText.trim() };
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
