// style-profiles.js

window.StyleProfiles = (() => {

  let _profiles = {};
  let _manifest = [];

  async function loadAll() {
    if (!Settings.hasGitHub()) return;
    try {
      _manifest = await GH.readManifest();
      _profiles = {};
      for (const name of _manifest) {
        const p = await GH.readProfile(name);
        if (p) _profiles[name] = p;
      }
    } catch (e) {
      console.warn('Style profiles: load failed —', e.message);
    }
  }

  function match(contentType) {
    if (!contentType || !_manifest.length) return null;
    const q = contentType.toLowerCase().replace(/[\s_-]+/g, '-');
    if (_profiles[q]) return _profiles[q];
    for (const name of _manifest) {
      const n = name.toLowerCase();
      if (n.includes(q) || q.includes(n)) return _profiles[name];
    }
    return null;
  }

  function getNames() { return _manifest.slice(); }

  function asPromptText(profile) {
    if (!profile) return '';
    return `\n\n--- STYLE PROFILE (${profile.name || 'custom'}) ---\n${JSON.stringify(profile, null, 2)}\n--- END STYLE PROFILE ---`;
  }

  async function createProfile(videoBlob, profileName, onStatus) {
    if (!Settings.hasGitHub()) throw new Error('GitHub not configured in Settings — profile cannot be saved');

    onStatus('Uploading reference video to Gemini…');
    const fileUri = await Gemini.uploadFile(videoBlob, videoBlob.type || 'video/mp4', `style-ref-${profileName}`);

    onStatus('Analysing editing style…');
    const existing = _manifest.map(n => _profiles[n]).filter(Boolean);
    const consolidate = existing.length
      ? `\n\nCONSOLIDATE this new reference with the existing profiles below into ONE unified profile object:\n${JSON.stringify(existing, null, 2)}`
      : '';

    const result = await Gemini.generate(
      [
        { fileData: { mimeType: videoBlob.type || 'video/mp4', fileUri } },
        { text: `Watch this video and extract a highlight clipping profile for content type "${profileName}".${consolidate}

This profile will be used to identify 30-60 second highlight clips from a longer VOD. Focus on what makes a moment worth clipping.

Return ONLY valid JSON:
{
  "name": "${profileName}",
  "energy_level": "high|medium|low",
  "highlight_moments": {
    "always_clip": [],
    "never_clip": []
  },
  "excitement_signals": {
    "audio": [],
    "visual": [],
    "gameplay": []
  },
  "crop_focus": {
    "primary_action_region": "",
    "avoid_region": "",
    "notes": ""
  },
  "clip_pacing": {
    "ideal_duration_seconds": <number>,
    "start_before_peak_seconds": <number>,
    "end_after_peak_seconds": <number>
  },
  "commentary_style": "",
  "notes": ""
}` },
      ],
      null, true
    );

    onStatus('Saving to GitHub…');
    _profiles[profileName] = result;
    if (!_manifest.includes(profileName)) _manifest.push(profileName);
    await GH.writeProfile(profileName, result);
    await GH.writeManifest(_manifest);

    onStatus(`✓ Profile "${profileName}" saved`);
    return result;
  }

  // ── Panel wiring — IDs match index.html ──────────────────────────
  function initPanel() {
    const overlay  = document.getElementById('profiles-overlay');
    const openBtn  = document.getElementById('btn-open-profiles');
    const closeBtn = document.getElementById('profiles-close');
    const genBtn   = document.getElementById('btn-create-profile');
    const statusEl = document.getElementById('profile-status');
    const nameIn   = document.getElementById('p-name');
    const fileIn   = document.getElementById('p-file');
    const fileWrap = document.getElementById('p-file-wrap');
    const fileLabel= document.getElementById('p-file-label');
    const listEl   = document.getElementById('profiles-list');
    const emptyEl  = document.getElementById('profiles-empty');

    // File pick
    fileWrap?.addEventListener('click', () => fileIn?.click());
    fileIn?.addEventListener('change', () => {
      if (fileLabel) fileLabel.textContent = fileIn.files[0]?.name || 'Choose video…';
    });

    function openPanel() {
      _refreshList(listEl, emptyEl);
      if (statusEl) { statusEl.classList.add('hidden'); statusEl.textContent = ''; }
      overlay?.classList.remove('hidden');
    }
    function closePanel() { overlay?.classList.add('hidden'); }

    openBtn?.addEventListener('click', openPanel);
    closeBtn?.addEventListener('click', closePanel);
    overlay?.addEventListener('click', e => { if (e.target === overlay) closePanel(); });

    genBtn?.addEventListener('click', async () => {
      const name = nameIn?.value.trim();
      const file = fileIn?.files[0];
      if (!name) { alert('Enter a profile name'); return; }
      if (!file) { alert('Select a reference video'); return; }
      if (genBtn) genBtn.disabled = true;
      if (statusEl) statusEl.classList.remove('hidden');
      try {
        await createProfile(file, name, msg => { if (statusEl) statusEl.textContent = msg; });
        _refreshList(listEl, emptyEl);
        if (window.App) App.updateProfileMatchNote();
      } catch (e) {
        if (statusEl) statusEl.textContent = `✗ ${e.message}`;
      } finally {
        if (genBtn) genBtn.disabled = false;
      }
    });
  }

  function _refreshList(listEl, emptyEl) {
    if (!_manifest.length) {
      listEl?.classList.add('hidden');
      emptyEl?.classList.remove('hidden');
      return;
    }
    emptyEl?.classList.add('hidden');
    listEl?.classList.remove('hidden');
    if (listEl) {
      listEl.innerHTML = '';
      _manifest.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        listEl.appendChild(li);
      });
    }
  }

  return { loadAll, match, getNames, asPromptText, createProfile, initPanel };

})();
