// app.js — Main app controller: state management, event wiring, orchestration

window.App = (() => {

  // ── App state ─────────────────────────────────────────────────────
  const state = {
    vodInfo:       null,   // { vodId, meta, variants, smallest, m3u8Url, accessible }
    vodDurationSec: 0,
    segments:      [],     // Stage 1 results
    overlayYT:     null,   // { blob, mime }
    overlayTT:     null,
    cancelSignal:  null,
  };

  // ── Init ──────────────────────────────────────────────────────────
  async function init() {
    Settings.init();
    StyleProfiles.initPanel();

    // Load style profiles (non-blocking, fail silently)
    StyleProfiles.loadAll().catch(() => {});

    _wireFetchVod();
    _wireAnalyse();
    _wireBackButton();
    _wireOverlayInputs();
    _wireProcessButtons();
    _wireContentTypeInput();

    checkAnalyseReady();
  }

  // ── Analyse-ready gate ────────────────────────────────────────────
  function checkAnalyseReady() {
    const hasSettings = Settings.hasMinimum();
    const hasVod      = !!(state.vodInfo?.accessible);
    const hasPrompt   = !!document.getElementById('highlight-prompt')?.value?.trim();

    if (!hasSettings) {
      UI.setAnalyseButtonState(false, 'Open Settings and add your API keys first');
    } else if (!hasVod) {
      UI.setAnalyseButtonState(false, 'Fetch a VOD first');
    } else if (!hasPrompt) {
      UI.setAnalyseButtonState(false, 'Enter a highlight description');
    } else {
      UI.setAnalyseButtonState(true, '');
    }
  }

  // ── Fetch VOD ─────────────────────────────────────────────────────
  function _wireFetchVod() {
    const btn   = document.getElementById('btn-fetch-vod');
    const input = document.getElementById('vod-url');

    async function doFetch() {
      const val = input.value.trim();
      if (!val) return;
      btn.disabled     = true;
      btn.textContent  = '…';

      try {
        const info = await Twitch.loadVod(val);
        state.vodInfo = info;

        // Parse duration
        const durStr = info.meta.duration || '0s';
        state.vodDurationSec = Twitch.parseTwitchDuration(durStr);

        UI.showVodMeta(info.meta, info);
        updateProfileMatchNote();
        checkAnalyseReady();
      } catch (e) {
        alert(`Failed to load VOD: ${e.message}`);
        state.vodInfo = null;
        checkAnalyseReady();
      } finally {
        btn.disabled    = false;
        btn.textContent = 'Fetch';
      }
    }

    btn.addEventListener('click', doFetch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doFetch(); });
  }

  // ── Highlight prompt → re-check ready ────────────────────────────
  function _wireAnalyse() {
    document.getElementById('highlight-prompt').addEventListener('input', checkAnalyseReady);
    document.getElementById('btn-analyse').addEventListener('click', _runAnalysis);
    document.getElementById('btn-cancel-analysis').addEventListener('click', () => {
      if (state.cancelSignal) state.cancelSignal.cancelled = true;
    });
  }

  // ── Back to input ─────────────────────────────────────────────────
  function _wireBackButton() {
    document.getElementById('btn-back-to-input').addEventListener('click', () => {
      UI.showView('view-input');
    });
  }

  // ── Overlay file inputs ───────────────────────────────────────────
  function _wireOverlayInputs() {
    document.getElementById('overlay-youtube').addEventListener('change', e => {
      const file = e.target.files[0];
      state.overlayYT = file ? { blob: file, mime: file.type } : null;
    });
    document.getElementById('overlay-tiktok').addEventListener('change', e => {
      const file = e.target.files[0];
      state.overlayTT = file ? { blob: file, mime: file.type } : null;
    });
  }

  // ── Process buttons (delegated) ───────────────────────────────────
  function _wireProcessButtons() {
    document.getElementById('highlight-cards').addEventListener('click', async e => {
      const btn = e.target.closest('.btn-process');
      if (!btn) return;
      const index = parseInt(btn.dataset.index);
      if (isNaN(index)) return;
      await _runProcessClip(index);
    });
  }

  // ── Content type → profile match note ────────────────────────────
  function _wireContentTypeInput() {
    document.getElementById('content-type').addEventListener('input', updateProfileMatchNote);
  }

  function updateProfileMatchNote() {
    const val     = document.getElementById('content-type').value.trim();
    const note    = document.getElementById('profile-match-note');
    const profile = StyleProfiles.match(val);
    note.textContent = profile
      ? `✓ Style profile matched: ${profile.name || val}`
      : val ? 'No profile matched — will use generic analysis' : '';
  }

  // ── Stage 1: full analysis ────────────────────────────────────────
  async function _runAnalysis() {
    if (!state.vodInfo?.accessible) return;

    const highlightPrompt = document.getElementById('highlight-prompt').value.trim();
    const targetClips     = parseInt(document.getElementById('target-clips').value)     || 5;
    const targetDuration  = parseFloat(document.getElementById('target-duration').value) || 3;
    const pacing          = document.getElementById('pacing-select').value;
    const contentType     = document.getElementById('content-type').value.trim();
    const styleProfile    = StyleProfiles.match(contentType);

    UI.showView('view-analysing');
    UI.setAnalysingStage('Starting…', '', 0);

    state.cancelSignal = { cancelled: false };

    try {
      // Download the small stream
      UI.setAnalysingStage('Downloading stream…', 'Fetching segments at smallest resolution', 0.05);

      const vodBlob = await Twitch.downloadStreamAsBlob(
        state.vodInfo.smallest.url,
        (loaded, total) => {
          UI.setAnalysingStage(
            'Downloading stream…',
            `${loaded} / ${total} segments`,
            0.05 + 0.25 * (loaded / total)
          );
        },
        state.cancelSignal
      );

      if (state.cancelSignal.cancelled) throw new Error('Cancelled');

      const vodResolution = state.vodInfo.smallest.resolution
        || `${state.vodInfo.smallest.height}p`;

      const segments = await Analysis.runAnalysis({
        vodBlob,
        vodMimeType:      'video/mp2t',
        vodDurationSec:   state.vodDurationSec,
        vodResolution,
        highlightPrompt,
        targetClips,
        targetDurationMin: targetDuration,
        pacing,
        styleProfile,
        onStage: (label, sub, progress) => {
          UI.setAnalysingStage(label, sub, 0.3 + progress * 0.7);
        },
        cancelSignal: state.cancelSignal,
      });

      state.segments = segments;
      UI.renderResults(segments, state.vodInfo);
      UI.showView('view-results');

    } catch (e) {
      if (e.message === 'Cancelled') {
        UI.showView('view-input');
      } else {
        alert(`Analysis failed: ${e.message}`);
        UI.showView('view-input');
      }
    }
  }

  // ── Stage 2: process single clip ─────────────────────────────────
  async function _runProcessClip(index) {
    const seg = state.segments[index];
    if (!seg) return;

    const btn = document.querySelector(`.btn-process[data-index="${index}"]`);
    if (btn) btn.disabled = true;

    UI.setCardStatus(index, 'Starting…', 'running');

    try {
      const smallest = state.vodInfo.smallest;

      // Resolve full-res variant: highest bandwidth from variants
      const variants    = state.vodInfo.variants;
      const fullVariant = variants[variants.length - 1]; // last = highest quality after sort asc
      const fullUrl     = fullVariant.url;

      // Parse full resolution dimensions
      let fullResW = 1920, fullResH = 1080;
      if (fullVariant.resolution) {
        const m = fullVariant.resolution.match(/(\d+)x(\d+)/);
        if (m) { fullResW = parseInt(m[1]); fullResH = parseInt(m[2]); }
      }

      const result = await ClipProcessor.processClip({
        segment:           seg,
        smallestQualityUrl: smallest.url,
        fullQualityUrl:    fullUrl,
        smallestRes:       smallest,
        fullResW,
        fullResH,
        overlayYouTube:    state.overlayYT,
        overlayTikTok:     state.overlayTT,
        onStatus: msg => UI.setCardStatus(index, msg, 'running'),
        cancelSignal: null,
      });

      UI.setCardStatus(index, `Done — ${result.outputs.length} file(s) ready`, 'done');
      UI.setCardDownloads(index, result.outputs);

    } catch (e) {
      UI.setCardStatus(index, `Error: ${e.message}`, 'error');
      if (btn) btn.disabled = false;
    }
  }

  return { init, checkAnalyseReady, updateProfileMatchNote };

})();

// ── Boot ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
