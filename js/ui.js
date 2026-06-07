// ui.js — Results screen rendering and interaction

window.UI = (() => {

  // ── View switching ────────────────────────────────────────────────
  function showView(id) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.toggle('active',  v.id === id);
      v.classList.toggle('hidden', v.id !== id);
    });
  }

  // ── Analysing view ────────────────────────────────────────────────
  function setAnalysingStage(label, sub, progress) {
    document.getElementById('analysing-stage').textContent = label;
    document.getElementById('analysing-sub').textContent   = sub || '';
    document.getElementById('progress-bar').style.width    = `${Math.round((progress || 0) * 100)}%`;
  }

  // ── Results view ──────────────────────────────────────────────────
  function renderResults(segments, vodInfo) {
    // Summary bar
    const totalDur = segments.reduce((s, seg) => s + seg.durationSec, 0);
    document.getElementById('sum-clips').textContent    = `${segments.length} clips`;
    document.getElementById('sum-duration').textContent = `${Analysis._fmt(totalDur)} total`;
    document.getElementById('sum-output').textContent   = `~${Analysis._fmt(totalDur)} output`;

    // Preview iframe — embed Twitch VOD player at smallest quality
    const vodId = vodInfo.vodId;
    const iframe = document.getElementById('vod-preview');
    // Twitch embed player supports ?t= param for seek
    iframe.src = `https://player.twitch.tv/?video=${vodId}&parent=${location.hostname}&autoplay=false&muted=true`;

    // Render cards
    const container = document.getElementById('highlight-cards');
    container.innerHTML = '';
    segments.forEach((seg, i) => {
      const card = buildCard(seg, i, vodId);
      container.appendChild(card);
    });
  }

  function buildCard(seg, index, vodId) {
    const card = document.createElement('div');
    card.className = `highlight-card rank-${seg.rank}`;
    card.dataset.index = index;

    const rankColors = { 5: '#e84040', 4: '#e87020', 3: '#e8a020', 2: '#70b040', 1: '#4080c0' };
    card.style.setProperty('--rank-color', rankColors[seg.rank] || '#4080c0');

    const startLabel = Analysis._fmt(seg.startSec);
    const endLabel   = Analysis._fmt(seg.endSec);
    const durLabel   = Analysis._fmt(seg.durationSec);

    const fxHtml = seg.fx
      ? `<div class="card-fx"><span class="fx-tag">${seg.fx.replace('_', ' ')}</span></div>`
      : '';

    card.innerHTML = `
      <div class="card-top">
        <div class="card-label">${_esc(seg.label)}</div>
        <div class="rank-badge" title="Rank ${seg.rank}">${seg.rank}</div>
      </div>
      <div class="card-time">${startLabel} — ${endLabel} · ${durLabel}</div>
      <div class="card-reason">${_esc(seg.reason)}</div>
      ${fxHtml}
      <div class="card-actions">
        <button class="btn btn-process" data-index="${index}">Process Clip</button>
        <span class="process-status" id="status-${index}"></span>
      </div>
      <div class="download-links" id="downloads-${index}"></div>
    `;

    // Seek preview on card click (not on button)
    card.addEventListener('click', e => {
      if (e.target.closest('.btn-process') || e.target.closest('.download-links')) return;
      seekPreview(vodId, seg.startSec);
      document.querySelectorAll('.highlight-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('preview-label').textContent =
        `${_esc(seg.label)} · ${Analysis._fmt(seg.startSec)}`;
    });

    return card;
  }

  // ── Seek Twitch embed player ──────────────────────────────────────
  function seekPreview(vodId, startSec) {
    const t = _secToTwitchTime(startSec);
    const iframe = document.getElementById('vod-preview');
    // Rebuild src with time param — simplest reliable seek for Twitch embed
    iframe.src = `https://player.twitch.tv/?video=${vodId}&parent=${location.hostname}&autoplay=true&time=${t}&muted=false`;
  }

  function _secToTwitchTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${h}h${m}m${s}s`;
  }

  // ── Card process button status ────────────────────────────────────
  function setCardStatus(index, text, state) {
    const el = document.getElementById(`status-${index}`);
    if (!el) return;
    el.textContent = text;
    el.className   = `process-status ${state || ''}`;
  }

  function setCardDownloads(index, outputs) {
    const el = document.getElementById(`downloads-${index}`);
    if (!el) return;
    el.innerHTML = outputs.map(o =>
      `<a class="download-link" href="${o.url}" download="${_esc(o.filename)}">${_esc(o.label)} ↓</a>`
    ).join('');
  }

  function disableCardProcess(index) {
    const btn = document.querySelector(`.btn-process[data-index="${index}"]`);
    if (btn) btn.disabled = true;
  }

  // ── VOD input view helpers ────────────────────────────────────────
  function showVodMeta(meta, vodInfo) {
    const thumbUrl = meta.thumbnail_url
      ?.replace('%{width}', '320')
      ?.replace('%{height}', '180')
      || '';

    document.getElementById('vod-thumb').src       = thumbUrl;
    document.getElementById('vod-title-text').textContent = meta.title || 'Unknown title';
    document.getElementById('vod-duration-text').textContent = meta.duration || '';
    document.getElementById('vod-date-text').textContent =
      meta.created_at ? new Date(meta.created_at).toLocaleDateString() : '';
    document.getElementById('vod-meta').classList.remove('hidden');

    // Quality badge
    const qInfo = document.getElementById('vod-quality-info');
    const qBadge = document.getElementById('quality-badge-text');
    const qWarn  = document.getElementById('quality-warning');

    if (vodInfo.smallest) {
      qBadge.textContent = `Smallest available: ${vodInfo.smallest.resolution || vodInfo.smallest.height + 'p'}`;
      qWarn.classList.add('hidden');
      qWarn.textContent = '';
    } else {
      qBadge.textContent = 'No quality ≤ 480p available';
      qWarn.textContent  = 'This VOD has no stream quality at or below 480p. Processing is disabled.';
      qWarn.classList.remove('hidden');
    }
    qInfo.classList.remove('hidden');
  }

  function setAnalyseButtonState(enabled, hint) {
    const btn  = document.getElementById('btn-analyse');
    const hint2 = document.getElementById('analyse-hint');
    btn.disabled      = !enabled;
    hint2.textContent = hint || '';
  }

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    showView,
    setAnalysingStage,
    renderResults,
    seekPreview,
    setCardStatus,
    setCardDownloads,
    disableCardProcess,
    showVodMeta,
    setAnalyseButtonState,
  };

})();
