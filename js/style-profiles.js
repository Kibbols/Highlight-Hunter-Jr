// style-profiles.js — Load profiles from GitHub, match by name, create new profiles

window.StyleProfiles = (() => {

  let _profiles = {};     // { name: profileObj }
  let _manifest = [];     // [ 'name1', 'name2', ... ]

  // ── Load all profiles at startup ──────────────────────────────────
  async function loadAll() {
    try {
      _manifest = await GH.readManifest();
      _profiles = {};
      for (const name of _manifest) {
        const p = await GH.readProfile(name);
        if (p) _profiles[name] = p;
      }
    } catch (e) {
      console.warn('Style profiles: could not load from GitHub —', e.message);
      _manifest = [];
      _profiles = {};
    }
  }

  // ── Match profile by content type string (fuzzy) ──────────────────
  function match(contentType) {
    if (!contentType || !_manifest.length) return null;
    const query = contentType.toLowerCase().replace(/[\s_-]+/g, '-');
    // Exact match first
    if (_profiles[query]) return _profiles[query];
    // Prefix / contains match
    for (const name of _manifest) {
      const n = name.toLowerCase();
      if (n.includes(query) || query.includes(n)) return _profiles[name];
    }
    return null;
  }

  function getProfileNames() { return _manifest.slice(); }

  function profileAsPromptText(profile) {
    if (!profile) return '';
    return `\n\n--- STYLE PROFILE (${profile.name || 'custom'}) ---\n${JSON.stringify(profile, null, 2)}\n--- END STYLE PROFILE ---`;
  }

  // ── Create a new profile from a reference Short ───────────────────
  // videoBlob: the uploaded reference video
  // profileName: string key for this profile
  // existingProfiles: array of existing profile objects (for consolidation)
  async function createProfile(videoBlob, profileName, onStatus) {
    onStatus('Uploading reference video to Gemini…');

    const fileUri = await Gemini.uploadFile(
      videoBlob,
      videoBlob.type || 'video/mp4',
      `style-ref-${profileName}`
    );

    onStatus('Analysing editing style…');

    const existingList = _manifest.map(n => _profiles[n]).filter(Boolean);
    const consolidateNote = existingList.length
      ? `\n\nYou are CONSOLIDATING this new reference into the existing style knowledge. Existing profiles:\n${JSON.stringify(existingList, null, 2)}\n\nProduce ONE unified profile object, not appended blocks.`
      : '';

    const systemPrompt = `You are an expert short-form video editor analysing a reference clip to extract editorial style guidelines.${consolidateNote}`;

    const userPrompt = `Watch this short-form video clip and extract a detailed style profile JSON for content type "${profileName}".

Return ONLY a valid JSON object with this structure:
{
  "name": "${profileName}",
  "pacing": "fast|medium|slow",
  "avg_clip_duration_seconds": <number>,
  "cut_style": "hard|jump|transition",
  "preferred_moments": ["list of moment types to prioritize"],
  "avoid": ["list of moment types to avoid or cut"],
  "energy_level": "high|medium|low",
  "commentary_weight": "heavy|moderate|minimal",
  "reaction_weight": "heavy|moderate|minimal",
  "gameplay_weight": "heavy|moderate|minimal",
  "notes": "freeform editorial notes"
}`;

    const result = await Gemini.generate(
      [
        { fileData: { mimeType: videoBlob.type || 'video/mp4', fileUri } },
        { text: userPrompt },
      ],
      systemPrompt,
      true // JSON mode
    );

    onStatus('Saving profile to GitHub…');

    _profiles[profileName] = result;
    if (!_manifest.includes(profileName)) _manifest.push(profileName);

    await GH.writeProfile(profileName, result);
    await GH.writeManifest(_manifest);

    onStatus(`✓ Profile "${profileName}" saved`);
    return result;
  }

  // ── Profile creator panel wiring ──────────────────────────────────
  function initPanel() {
    const overlay    = document.getElementById('profile-overlay');
    const openBtn    = document.getElementById('btn-open-profile');
    const closeBtn   = document.getElementById('profile-close');
    const genBtn     = document.getElementById('profile-generate-btn');
    const statusEl   = document.getElementById('profile-status');
    const nameInput  = document.getElementById('p-profile-name');
    const videoInput = document.getElementById('p-profile-video');
    const listEl     = document.getElementById('profile-names-list');
    const listWrap   = document.getElementById('profile-existing-list');

    function openPanel() {
      // Populate existing profiles list
      if (_manifest.length) {
        listEl.innerHTML = '';
        _manifest.forEach(n => {
          const li = document.createElement('li');
          li.textContent = n;
          listEl.appendChild(li);
        });
        listWrap.classList.remove('hidden');
      } else {
        listWrap.classList.add('hidden');
      }
      statusEl.classList.add('hidden');
      statusEl.textContent = '';
      overlay.classList.remove('hidden');
    }

    function closePanel() { overlay.classList.add('hidden'); }

    openBtn.addEventListener('click', openPanel);
    closeBtn.addEventListener('click', closePanel);
    overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); });

    genBtn.addEventListener('click', async () => {
      const name  = nameInput.value.trim();
      const file  = videoInput.files[0];
      if (!name)  { alert('Please enter a profile name'); return; }
      if (!file)  { alert('Please select a reference video'); return; }

      genBtn.disabled = true;
      statusEl.classList.remove('hidden');

      try {
        await createProfile(file, name, msg => {
          statusEl.textContent = msg;
        });
        // Update content-type match note on main form
        if (window.App) App.updateProfileMatchNote();
      } catch (e) {
        statusEl.textContent = `✗ Error: ${e.message}`;
      } finally {
        genBtn.disabled = false;
      }
    });
  }

  return { loadAll, match, getProfileNames, profileAsPromptText, createProfile, initPanel };

})();
