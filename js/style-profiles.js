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
        { text: `Watch this short-form video and extract an editing style profile for content type "${profileName}".${consolidate}

Return ONLY valid JSON:
{
  "name": "${profileName}",
  "pacing": "fast|medium|slow",
  "avg_clip_duration_seconds": <number>,
  "cut_style": "hard|jump|transition",
  "preferred_moments": [],
  "avoid": [],
  "energy_level": "high|medium|low",
  "commentary_weight": "heavy|moderate|minimal",
  "reaction_weight": "heavy|moderate|minimal",
  "gameplay_weight": "heavy|moderate|minimal",
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

  // ── Panel wiring ──────────────────────────────────────────────────
  function initPanel() {
    const overlay  = document.getElementById('profile-overlay');
    const openBtn  = document.getElementById('btn-open-profile');
    const closeBtn = document.getElementById('profile-close');
    const genBtn   = document.getElementById('profile-generate-btn');
    const statusEl = document.getElementById('profile-status');
    const nameIn   = document.getElementById('p-profile-name');
    const fileIn   = document.getElementById('p-profile-video');
    const fileDrop = document.getElementById('profile-file-drop');
    const fileLabel= document.getElementById('profile-file-label');
    const listEl   = document.getElementById('profiles-list');
    const emptyEl  = document.getElementById('profiles-empty');

    // File drop label update
    fileIn.addEventListener('change', () => {
      fileLabel.textContent = fileIn.files[0]?.name || 'Choose a video file…';
    });
    fileDrop.addEventListener('click', () => fileIn.click());

    function openPanel() {
      _refreshList(listEl, emptyEl);
      statusEl.classList.add('hidden');
      statusEl.textContent = '';
      overlay.classList.remove('hidden');
    }
    openBtn.addEventListener('click', openPanel);
    closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });

    genBtn.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      const file = fileIn.files[0];
      if (!name) { alert('Enter a profile name'); return; }
      if (!file) { alert('Select a reference video'); return; }
      genBtn.disabled = true;
      statusEl.classList.remove('hidden');
      try {
        await createProfile(file, name, msg => { statusEl.textContent = msg; });
        _refreshList(listEl, emptyEl);
        if (window.App) App.updateProfileMatchNote();
      } catch (e) {
        statusEl.textContent = `✗ ${e.message}`;
      } finally {
        genBtn.disabled = false;
      }
    });
  }

  function _refreshList(listEl, emptyEl) {
    if (!_manifest.length) {
      listEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.classList.remove('hidden');
    listEl.innerHTML = '';
    _manifest.forEach(name => {
      const li = document.createElement('li');
      li.textContent = name;
      listEl.appendChild(li);
    });
  }

  return { loadAll, match, getNames, asPromptText, createProfile, initPanel };

})();
