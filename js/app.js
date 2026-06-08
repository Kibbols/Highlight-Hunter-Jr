// app.js

window.App = (() => {

  const state = {
    vods:          [],
    vodInfo:       null,
    vodDurationSec: 0,
    segments:      [],
    overlayYT:     null,
    overlayTT:     null,
    cancelSignal:  null,
  };

  async function init() {
    Settings.init();
    StyleProfiles.initPanel();

    _wireOverlayToggle();
    _wireOverlayFiles();
    _wirePromptInput();
    _wireRefresh();
    _wireAnalyse();
    _wireBack();
    _wireProcessButtons();
    document.getElementById('content-type').addEventListener('input', updateProfileMatchNote);

    if (Settings.hasTwitch()) {
      _goToInput();
    } else {
      UI.showView('view-setup');
    }
  }

  function onTwitchDisconnected() {
    state.vodInfo = null;
    state.vods    = [];
    UI.showView('view-setup');
  }

  // ── Navigation ────────────────────────────────────────────────────
  function _goToInput() {
    UI.showView('view-input');
    loadVods();
    StyleProfiles.loadAll().catch(() => {});
  }

  // ── Collapsible overlays ──────────────────────────────────────────
  function _wireOverlayToggle() {
    const toggle = document.getElementById('toggle-overlays');
    const body   = document.getElementById('overlays-body');
    const arrow  = document.getElementById('toggle-arrow');
    toggle.addEventListener('click', () => {
      const open = !body.classList.contains('hidden');
      body.classList.toggle('hidden', open);
      arrow.classList.toggle('open', !open);
    });
  }

  function _wireOverlayFiles() {
    _fileInput('overlay-yt', 'overlay-yt-label', f => {
      state.overlayYT = f ? { blob: f, mime: f.type } : null;
    });
    _fileInput('overlay-tt', 'overlay-tt-label', f => {
      state.overlayTT = f ? { blob: f, mime: f.type } : null;
    });
  }

  function _fileInput(inputId, labelId, onChange) {
    const inp   = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    const wrap  = inp?.closest('.file-input-wrap');
    wrap?.addEventListener('click', () => inp.click());
    inp?.addEventListener('change', () => {
      const f = inp.files[0];
      label.textContent = f?.name || 'Choose file…';
      onChange(f || null);
    });
  }

  function _wirePromptInput() {
    document.getElementById('highlight-prompt').addEventListener('input', checkReady);
  }

  function _wireRefresh() {
    document.getElementById('btn-refresh-vods').addEventListener('click', loadVods);
  }

  function _wireAnalyse() {
    document.getElementById('btn-analyse').addEventListener('click', runAnalysis);
    document.getElementById('btn-cancel').addEventListener('click', () => {
      if (state.cancelSignal) state.cancelSignal.cancelled = true;
    });
  }

  function _wireBack() {
    document.getElementById('btn-back').addEventListener('click', () => UI.showView('view-input'));
  }

  function _wireProcessButtons() {
    document.getElementById('clips-list').addEventListener('click', e => {
      const btn = e.target.closest('.process-btn');
      if (!btn) return;
      runProcessClip(parseInt(btn.dataset.index));
    });
  }

  // ── Load VODs ─────────────────────────────────────────────────────
  async function loadVods() {
    UI.setVodListState('Loading your recent VODs…');
    try {
      state.vods = await Twitch.fetchRecentVods(3);
      UI.renderVodList(state.vods, onVodSelected);
      checkReady();
    } catch (e) {
      UI.setVodListState(`Failed to load VODs: ${e.message}`);
    }
  }

  async function onVodSelected(vod) {
    state.vodInfo       = null;
    state.vodDurationSec = Twitch.parseDuration(vod.duration || '');
    document.getElementById('selected-vod').classList.add('hidden');
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

  // ── Ready gate ────────────────────────────────────────────────────
  function checkReady() {
    if (!Settings.hasTwitch()) return;
    if (!Settings.hasGemini()) {
      UI.setAnalyseState(false, 'Add your Gemini API key in Settings ⚙'); return;
    }
    if (!state.vodInfo) {
      UI.setAnalyseState(false, 'Select a VOD above'); return;
    }
    if (!state.vodInfo.accessible) {
      UI.setAnalyseState(false, 'VOD has no stream quality at or below 480p'); return;
    }
    if (!document.getElementById('highlight-prompt').value.trim()) {
      UI.setAnalyseState(false, 'Enter a highlight description'); return;
    }
    UI.setAnalyseState(true, '');
  }

  function updateProfileMatchNote() {
    const val     = document.getElementById('content-type').value.trim();
    const profile = StyleProfiles.match(val);
    document.getElementById('profile-match').textContent = profile
      ? `✓ Matched: ${profile.name || val}`
      : val ? 'No profile matched — generic analysis' : '';
  }

  // ── Stage 1 ───────────────────────────────────────────────────────
  async function runAnalysis() {
    if (!state.vodInfo?.accessible) return;

    const prompt   = document.getElementById('highlight-prompt').value.trim();
    const clips    = parseInt(document.getElementById('target-clips').value)    || 5;
    const clipMinSec = parseInt(document.getElementById('clip-min-sec').value) || 20;
    const clipMaxSec = parseInt(document.getElementById('clip-max-sec').value) || 60;
    const pacing   = document.getElementById('pacing').value;
    const cType    = document.getElementById('content-type').value.trim();
    const profile  = StyleProfiles.match(cType);

    state.cancelSignal = { cancelled: false };
    UI.showView('view-analysing');
    UI.setProgress('Starting…', '', 0);

    try {
      UI.setProgress('Downloading stream…', 'Fetching smallest available resolution', 0.05);

      const vodBlob = await Twitch.downloadStreamAsBlob(
        state.vodInfo.smallest.url,
        (loaded, total) => UI.setProgress('Downloading stream…', `${loaded} / ${total} segments`, 0.05 + 0.25 * (loaded / total)),
        state.cancelSignal
      );

      if (state.cancelSignal.cancelled) throw new Error('Cancelled');

      const vodRes = state.vodInfo.smallest.resolution || `${state.vodInfo.smallest.height}p`;

      state.segments = await Analysis.runAnalysis({
        vodBlob,
        vodMimeType:       'video/mp2t',
        vodDurationSec:    state.vodDurationSec,
        vodResolution:     vodRes,
        highlightPrompt:   prompt,
        targetClips:       clips,
        clipMinSec,
        clipMaxSec,
        pacing,
        styleProfile:      profile,
        onStage: (label, sub, pct) => UI.setProgress(label, sub, 0.3 + pct * 0.7),
        cancelSignal:      state.cancelSignal,
      });

      UI.renderResults(state.segments, state.vodInfo);
      UI.showView('view-results');

    } catch (e) {
      console.error('Analysis error:', e);
      UI.showView('view-input');
      const msg = e?.message || String(e) || 'Unknown error';
      if (msg !== 'Cancelled') alert(`Analysis failed: ${msg}`);
    }
  }

  // ── Stage 2 ───────────────────────────────────────────────────────
  async function runProcessClip(index) {
    const seg = state.segments[index];
    if (!seg) return;
    const btn = document.querySelector(`.process-btn[data-index="${index}"]`);
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
