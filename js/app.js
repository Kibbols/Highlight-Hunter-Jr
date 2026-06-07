// app.js — Main controller

window.App = (() => {

  const state = {
    vods:          [],
    selectedVod:   null,   // raw Twitch VOD metadata object
    vodInfo:       null,   // { vodId, meta, variants, smallest, accessible }
    vodDurationSec: 0,
    segments:      [],
    overlayYT:     null,
    overlayTT:     null,
    cancelSignal:  null,
  };

  // ── Boot ──────────────────────────────────────────────────────────
  async function init() {
    Settings.init();
    StyleProfiles.initPanel();

    // Wire content-type → profile match note
    document.getElementById('content-type').addEventListener('input', updateProfileMatchNote);

    // Wire overlays
    document.getElementById('overlay-youtube').addEventListener('change', e => {
      const f = e.target.files[0];
      state.overlayYT = f ? { blob: f, mime: f.type } : null;
    });
    document.getElementById('overlay-tiktok').addEventListener('change', e => {
      const f = e.target.files[0];
      state.overlayTT = f ? { blob: f, mime: f.type } : null;
    });

    // Wire highlight prompt → re-check ready
    document.getElementById('highlight-prompt').addEventListener('input', checkReady);

    // Wire VOD refresh
    document.getElementById('btn-refresh-vods').addEventListener('click', loadRecentVods);

    // Wire analyse
    document.getElementById('btn-analyse').addEventListener('click', runAnalysis);
    document.getElementById('btn-cancel').addEventListener('click', () => {
      if (state.cancelSignal) state.cancelSignal.cancelled = true;
    });

    // Wire back
    document.getElementById('btn-back').addEventListener('click', () => UI.showView('view-input'));

    // Wire process buttons (delegated)
    document.getElementById('highlight-cards').addEventListener('click', e => {
      const btn = e.target.closest('.btn-process');
      if (!btn) return;
      runProcessClip(parseInt(btn.dataset.index));
    });

    // Decide initial view
    if (Settings.hasTwitch()) {
      UI.showView('view-input');
      loadRecentVods();
      StyleProfiles.loadAll().catch(() => {});
    } else {
      UI.showView('view-setup');
    }
  }

  // ── Called when Twitch disconnects ────────────────────────────────
  function onTwitchDisconnected() {
    state.vods          = [];
    state.selectedVod   = null;
    state.vodInfo       = null;
    state.vodDurationSec = 0;
    UI.showView('view-setup');
  }

  // ── Load the 3 most recent VODs ───────────────────────────────────
  async function loadRecentVods() {
    UI.setVodLoading('Loading your recent VODs…');
    try {
      state.vods = await Twitch.fetchRecentVods(3);
      UI.renderVodList(state.vods, onVodSelected);
      checkReady();
    } catch (e) {
      UI.setVodLoading(`Error: ${e.message}`);
    }
  }

  // ── User selects a VOD from the list ─────────────────────────────
  async function onVodSelected(vod) {
    state.selectedVod  = vod;
    state.vodInfo      = null;
    state.vodDurationSec = Twitch.parseDuration(vod.duration || '');
    document.getElementById('selected-vod-card').classList.add('hidden');
    checkReady();

    try {
      const info = await Twitch.loadVodInfo(vod);
      state.vodInfo = info;
      UI.showSelectedVod(info);
      checkReady();
    } catch (e) {
      alert(`Could not load VOD qualities: ${e.message}`);
    }
  }

  // ── Analyse-ready gate ────────────────────────────────────────────
  function checkReady() {
    if (!Settings.hasTwitch()) return;
    if (!Settings.hasGemini()) {
      UI.setAnalyseState(false, 'Add your Gemini API key in Settings ⚙');
      return;
    }
    if (!state.vodInfo) {
      UI.setAnalyseState(false, 'Select a VOD above');
      return;
    }
    if (!state.vodInfo.accessible) {
      UI.setAnalyseState(false, 'This VOD has no stream quality ≤ 480p');
      return;
    }
    if (!document.getElementById('highlight-prompt').value.trim()) {
      UI.setAnalyseState(false, 'Enter a highlight description');
      return;
    }
    UI.setAnalyseState(true, '');
  }

  function updateProfileMatchNote() {
    const val     = document.getElementById('content-type').value.trim();
    const profile = StyleProfiles.match(val);
    document.getElementById('profile-match-note').textContent = profile
      ? `✓ Matched: ${profile.name || val}`
      : val ? 'No profile matched — generic analysis' : '';
  }

  // ── Stage 1: full analysis ────────────────────────────────────────
  async function runAnalysis() {
    if (!state.vodInfo?.accessible) return;

    const highlightPrompt  = document.getElementById('highlight-prompt').value.trim();
    const targetClips      = parseInt(document.getElementById('target-clips').value)      || 5;
    const targetDurationMin= parseFloat(document.getElementById('target-duration').value)  || 3;
    const pacing           = document.getElementById('pacing-select').value;
    const contentType      = document.getElementById('content-type').value.trim();
    const styleProfile     = StyleProfiles.match(contentType);

    state.cancelSignal = { cancelled: false };
    UI.showView('view-analysing');
    UI.setProgress('Starting…', '', 0);

    try {
      UI.setProgress('Downloading stream…', 'Fetching at smallest resolution', 0.05);

      const vodBlob = await Twitch.downloadStreamAsBlob(
        state.vodInfo.smallest.url,
        (loaded, total) => UI.setProgress('Downloading stream…', `${loaded} / ${total} segments`, 0.05 + 0.25 * (loaded / total)),
        state.cancelSignal
      );

      if (state.cancelSignal.cancelled) throw new Error('Cancelled');

      const vodResolution = state.vodInfo.smallest.resolution || `${state.vodInfo.smallest.height}p`;

      state.segments = await Analysis.runAnalysis({
        vodBlob,
        vodMimeType:       'video/mp2t',
        vodDurationSec:    state.vodDurationSec,
        vodResolution,
        highlightPrompt,
        targetClips,
        targetDurationMin,
        pacing,
        styleProfile,
        onStage: (label, sub, pct) => UI.setProgress(label, sub, 0.3 + pct * 0.7),
        cancelSignal: state.cancelSignal,
      });

      UI.renderResults(state.segments, state.vodInfo);
      UI.showView('view-results');

    } catch (e) {
      UI.showView('view-input');
      if (e.message !== 'Cancelled') alert(`Analysis failed: ${e.message}`);
    }
  }

  // ── Stage 2: process single clip ─────────────────────────────────
  async function runProcessClip(index) {
    const seg = state.segments[index];
    if (!seg) return;
    const btn = document.querySelector(`.btn-process[data-index="${index}"]`);
    if (btn) btn.disabled = true;

    UI.setCardStatus(index, 'Starting…', 'running');

    try {
      const smallest  = state.vodInfo.smallest;
      const variants  = state.vodInfo.variants;
      const fullVar   = variants[variants.length - 1];
      let fullResW = 1920, fullResH = 1080;
      if (fullVar.resolution) {
        const m = fullVar.resolution.match(/(\d+)x(\d+)/);
        if (m) { fullResW = parseInt(m[1]); fullResH = parseInt(m[2]); }
      }

      const result = await ClipProcessor.processClip({
        segment:     seg,
        smallestUrl: smallest.url,
        fullUrl:     fullVar.url,
        smallestRes: smallest,
        fullResW, fullResH,
        overlayYT:   state.overlayYT,
        overlayTT:   state.overlayTT,
        onStatus:    msg => UI.setCardStatus(index, msg, 'running'),
        cancelSignal: null,
      });

      UI.setCardStatus(index, `${result.outputs.length} file(s) ready`, 'done');
      UI.setCardDownloads(index, result.outputs);

    } catch (e) {
      UI.setCardStatus(index, `Error: ${e.message}`, 'error');
      if (btn) btn.disabled = false;
    }
  }

  return { init, checkReady, updateProfileMatchNote, onTwitchDisconnected };

})();

document.addEventListener('DOMContentLoaded', () => App.init());
