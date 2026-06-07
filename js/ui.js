// ui.js

window.UI = (() => {

  function showView(id) {
    document.querySelectorAll('.view').forEach(v => {
      const on = v.id === id;
      v.classList.toggle('active', on);
      v.classList.toggle('hidden', !on);
      v.style.display = on ? 'flex' : 'none';
    });
  }

  function setProgress(label, sub, pct) {
    document.getElementById('progress-stage').textContent = label;
    document.getElementById('progress-sub').textContent   = sub || '';
    document.getElementById('progress-fill').style.width  = `${Math.round((pct || 0) * 100)}%`;
  }

  // ── VOD list ──────────────────────────────────────────────────────
  function renderVodList(vods, onSelect) {
    const list = document.getElementById('vod-list');
    list.innerHTML = '';
    if (!vods.length) {
      list.innerHTML = '<div class="vod-list-state">No recent VODs found</div>';
      return;
    }
    vods.forEach(vod => {
      const item   = document.createElement('div');
      item.className = 'vod-item';
      const thumb  = (vod.thumbnail_url || '').replace('%{width}', '90').replace('%{height}', '50');
      const dur    = vod.duration || '';
      const date   = vod.created_at
        ? new Date(vod.created_at).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })
        : '';
      item.innerHTML = `
        <img class="vod-thumb" src="${thumb}" alt="" loading="lazy" />
        <div class="vod-info">
          <div class="vod-item-title">${_e(vod.title || 'Untitled')}</div>
          <div class="vod-item-meta">${[dur, date].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="vod-check">✓</div>
      `;
      item.addEventListener('click', () => {
        document.querySelectorAll('.vod-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        onSelect(vod);
      });
      list.appendChild(item);
    });
  }

  function setVodListState(msg) {
    document.getElementById('vod-list').innerHTML = `<div class="vod-list-state">${_e(msg)}</div>`;
  }

  // ── Selected VOD ──────────────────────────────────────────────────
  function showSelectedVod(vodInfo) {
    const meta  = vodInfo.meta;
    const thumb = (meta.thumbnail_url || '').replace('%{width}', '88').replace('%{height}', '50');
    document.getElementById('sel-thumb').src         = thumb;
    document.getElementById('sel-title').textContent = meta.title || 'Untitled';
    const dur  = meta.duration || '';
    const date = meta.created_at ? new Date(meta.created_at).toLocaleDateString() : '';
    document.getElementById('sel-meta').textContent  = [dur, date].filter(Boolean).join(' · ');

    const qPill  = document.getElementById('sel-quality');
    const qError = document.getElementById('sel-quality-error');
    if (vodInfo.smallest) {
      qPill.textContent = `Smallest: ${vodInfo.smallest.resolution || vodInfo.smallest.height + 'p'}`;
      qError.classList.add('hidden');
    } else {
      qPill.textContent  = 'No quality ≤ 480p';
      qError.textContent = 'This VOD cannot be processed';
      qError.classList.remove('hidden');
    }
    document.getElementById('selected-vod').classList.remove('hidden');
  }

  // ── Analyse button ────────────────────────────────────────────────
  function setAnalyseState(enabled, hint) {
    document.getElementById('btn-analyse').disabled       = !enabled;
    document.getElementById('analyse-hint').textContent   = hint || '';
  }

  // ── Results ───────────────────────────────────────────────────────
  function renderResults(segments, vodInfo) {
    const total = segments.reduce((s, x) => s + x.durationSec, 0);
    document.getElementById('sum-clips').textContent    = `${segments.length} clips`;
    document.getElementById('sum-duration').textContent = `${Analysis.fmt(total)} total`;

    const iframe = document.getElementById('vod-preview');
    iframe.src = `https://player.twitch.tv/?video=${vodInfo.vodId}&parent=${location.hostname}&autoplay=false&muted=true`;

    const list = document.getElementById('clips-list');
    list.innerHTML = '';
    segments.forEach((seg, i) => list.appendChild(_buildCard(seg, i, vodInfo.vodId)));
  }

  function _buildCard(seg, i, vodId) {
    const colors = { 5: 'var(--rank-5)', 4: 'var(--rank-4)', 3: 'var(--rank-3)', 2: 'var(--rank-2)', 1: 'var(--rank-1)' };
    const card   = document.createElement('div');
    card.className = `clip-card rank-${seg.rank}`;
    card.style.setProperty('--rank-color', colors[seg.rank] || 'var(--c-border2)');

    card.innerHTML = `
      <div class="clip-top">
        <div class="clip-label">${_e(seg.label)}</div>
        <div class="clip-rank">${seg.rank}</div>
      </div>
      <div class="clip-time">${Analysis.fmt(seg.startSec)} — ${Analysis.fmt(seg.endSec)} · ${Analysis.fmt(seg.durationSec)}</div>
      <div class="clip-reason">${_e(seg.reason)}</div>
      ${seg.fx ? `<div class="clip-fx"><span class="fx-chip">${seg.fx.replace('_', ' ')}</span></div>` : ''}
      <div class="clip-actions">
        <button class="process-btn" data-index="${i}">Process Clip</button>
        <span class="clip-status" id="cs-${i}"></span>
      </div>
      <div class="clip-downloads" id="cd-${i}"></div>
    `;

    card.addEventListener('click', e => {
      if (e.target.closest('.process-btn, .clip-downloads')) return;
      document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      _seekPreview(vodId, seg.startSec);
      document.getElementById('preview-label').textContent =
        `${_e(seg.label)} · ${Analysis.fmt(seg.startSec)}`;
    });

    return card;
  }

  function _seekPreview(vodId, sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    document.getElementById('vod-preview').src =
      `https://player.twitch.tv/?video=${vodId}&parent=${location.hostname}&autoplay=true&time=${h}h${m}m${s}s`;
  }

  function setCardStatus(i, text, state) {
    const el = document.getElementById(`cs-${i}`);
    if (el) { el.textContent = text; el.className = `clip-status ${state || ''}`; }
  }

  function setCardDownloads(i, outputs) {
    const el = document.getElementById(`cd-${i}`);
    if (el) el.innerHTML = outputs.map(o =>
      `<a class="dl-link" href="${o.url}" download="${_e(o.filename)}">${_e(o.label)} ↓</a>`
    ).join('');
  }

  function _e(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return {
    showView, setProgress,
    renderVodList, setVodListState,
    showSelectedVod, setAnalyseState,
    renderResults, setCardStatus, setCardDownloads,
  };

})();
