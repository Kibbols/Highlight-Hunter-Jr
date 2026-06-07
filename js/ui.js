// ui.js — View management and results rendering

window.UI = (() => {

  function showView(id) {
    document.querySelectorAll('.view').forEach(v => {
      const active = v.id === id;
      v.classList.toggle('active', active);
      v.style.display = active ? 'flex' : 'none';
    });
  }

  function setProgress(label, sub, pct) {
    document.getElementById('analysing-stage').textContent = label;
    document.getElementById('analysing-sub').textContent   = sub || '';
    document.getElementById('progress-bar').style.width    = `${Math.round((pct || 0) * 100)}%`;
  }

  // ── VOD list ──────────────────────────────────────────────────────
  function renderVodList(vods, onSelect) {
    const list = document.getElementById('vod-list');
    list.innerHTML = '';
    if (!vods.length) {
      list.innerHTML = '<div class="vod-loading">No recent VODs found</div>';
      return;
    }
    vods.forEach(vod => {
      const item = document.createElement('div');
      item.className = 'vod-item';
      item.dataset.id = vod.id;
      const dur = vod.duration || '';
      const date = vod.created_at ? new Date(vod.created_at).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '';
      const thumb = (vod.thumbnail_url || '').replace('%{width}','88').replace('%{height}','50');
      item.innerHTML = `
        <img class="vod-thumb" src="${thumb}" alt="" loading="lazy" />
        <div class="vod-item-info">
          <div class="vod-item-title">${_esc(vod.title || 'Untitled')}</div>
          <div class="vod-item-meta">${dur}${dur && date ? ' · ' : ''}${date}</div>
        </div>
        <div class="vod-item-check">✓</div>
      `;
      item.addEventListener('click', () => {
        document.querySelectorAll('.vod-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        onSelect(vod);
      });
      list.appendChild(item);
    });
  }

  function setVodLoading(msg) {
    document.getElementById('vod-list').innerHTML = `<div class="vod-loading">${_esc(msg)}</div>`;
  }

  // ── Selected VOD card ─────────────────────────────────────────────
  function showSelectedVod(vodInfo) {
    const card = document.getElementById('selected-vod-card');
    const meta  = vodInfo.meta;
    const thumb = (meta.thumbnail_url || '').replace('%{width}','100').replace('%{height}','56');
    document.getElementById('selected-thumb').src = thumb;
    document.getElementById('selected-title').textContent = meta.title || 'Untitled';

    const dur  = meta.duration || '';
    const date = meta.created_at ? new Date(meta.created_at).toLocaleDateString() : '';
    document.getElementById('selected-meta').textContent = [dur, date].filter(Boolean).join(' · ');

    const badge = document.getElementById('quality-badge');
    const warn  = document.getElementById('quality-warn');
    if (vodInfo.smallest) {
      badge.textContent = `Smallest: ${vodInfo.smallest.resolution || vodInfo.smallest.height + 'p'}`;
      warn.classList.add('hidden');
    } else {
      badge.textContent = 'No quality ≤ 480p';
      warn.textContent  = 'This VOD has no stream at or below 480p — processing disabled';
      warn.classList.remove('hidden');
    }
    card.classList.remove('hidden');
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
    document.getElementById('sum-duration').textContent = `${Analysis.fmt(total)} combined`;
    document.getElementById('sum-output').textContent   = `~${Analysis.fmt(total)} output`;

    const iframe = document.getElementById('vod-preview');
    iframe.src = `https://player.twitch.tv/?video=${vodInfo.vodId}&parent=${location.hostname}&autoplay=false&muted=true`;

    const cards = document.getElementById('highlight-cards');
    cards.innerHTML = '';
    segments.forEach((seg, i) => cards.appendChild(_buildCard(seg, i, vodInfo.vodId)));
  }

  function _buildCard(seg, i, vodId) {
    const colors = { 5:'#e84040', 4:'#e87020', 3:'#e8a020', 2:'#70b040', 1:'#4080c0' };
    const card = document.createElement('div');
    card.className = `highlight-card rank-${seg.rank}`;
    card.style.setProperty('--rank-color', colors[seg.rank] || '#4080c0');
    card.innerHTML = `
      <div class="card-top">
        <div class="card-label">${_esc(seg.label)}</div>
        <div class="rank-badge">${seg.rank}</div>
      </div>
      <div class="card-time">${Analysis.fmt(seg.startSec)} — ${Analysis.fmt(seg.endSec)} · ${Analysis.fmt(seg.durationSec)}</div>
      <div class="card-reason">${_esc(seg.reason)}</div>
      ${seg.fx ? `<div class="card-fx"><span class="fx-tag">${seg.fx.replace('_',' ')}</span></div>` : ''}
      <div class="card-actions">
        <button class="btn btn-process" data-index="${i}">Process Clip</button>
        <span class="process-status" id="ps-${i}"></span>
      </div>
      <div class="download-links" id="dl-${i}"></div>
    `;
    card.addEventListener('click', e => {
      if (e.target.closest('.btn-process, .download-links')) return;
      document.querySelectorAll('.highlight-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _seekPreview(vodId, seg.startSec);
      document.getElementById('preview-hint').textContent = `${_esc(seg.label)} · ${Analysis.fmt(seg.startSec)}`;
    });
    return card;
  }

  function _seekPreview(vodId, startSec) {
    const h = Math.floor(startSec / 3600);
    const m = Math.floor((startSec % 3600) / 60);
    const s = Math.floor(startSec % 60);
    document.getElementById('vod-preview').src =
      `https://player.twitch.tv/?video=${vodId}&parent=${location.hostname}&autoplay=true&time=${h}h${m}m${s}s`;
  }

  function setCardStatus(i, text, state) {
    const el = document.getElementById(`ps-${i}`);
    if (el) { el.textContent = text; el.className = `process-status ${state || ''}`; }
  }

  function setCardDownloads(i, outputs) {
    const el = document.getElementById(`dl-${i}`);
    if (el) el.innerHTML = outputs.map(o =>
      `<a class="download-link" href="${o.url}" download="${_esc(o.filename)}">${_esc(o.label)} ↓</a>`
    ).join('');
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { showView, setProgress, renderVodList, setVodLoading, showSelectedVod, setAnalyseState, renderResults, setCardStatus, setCardDownloads };

})();
