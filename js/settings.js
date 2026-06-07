// settings.js — Settings panel: save/load credentials from localStorage

window.Settings = (() => {

  const KEYS = {
    gemini:       'gemini_api_key',
    twitchToken:  'twitch_oauth_token',
    twitchClient: 'twitch_client_id',
    ghToken:      'gh_token',
    ghOwner:      'gh_owner',
    ghRepo:       'gh_repo',
  };

  function get(key)      { return localStorage.getItem(KEYS[key]) || ''; }
  function set(key, val) { localStorage.setItem(KEYS[key], val); }

  function getAll() {
    return {
      geminiKey:    get('gemini'),
      twitchToken:  get('twitchToken'),
      twitchClient: get('twitchClient'),
      ghToken:      get('ghToken'),
      ghOwner:      get('ghOwner'),
      ghRepo:       get('ghRepo'),
    };
  }

  function hasMinimum() {
    return !!(get('gemini') && get('twitchToken') && get('twitchClient'));
  }

  // ── DOM wiring ────────────────────────────────────────────────────
  function init() {
    const overlay  = document.getElementById('settings-overlay');
    const openBtn  = document.getElementById('btn-open-settings');
    const closeBtn = document.getElementById('settings-close');
    const saveBtn  = document.getElementById('settings-save');
    const note     = document.getElementById('settings-save-note');

    // Populate fields with stored values on open
    function openPanel() {
      document.getElementById('s-gemini-key').value      = get('gemini');
      document.getElementById('s-twitch-token').value    = get('twitchToken');
      document.getElementById('s-twitch-client-id').value= get('twitchClient');
      document.getElementById('s-github-token').value    = get('ghToken');
      document.getElementById('s-github-owner').value    = get('ghOwner');
      document.getElementById('s-github-repo').value     = get('ghRepo');
      note.textContent = '';
      overlay.classList.remove('hidden');
    }

    function closePanel() { overlay.classList.add('hidden'); }

    openBtn.addEventListener('click', openPanel);
    closeBtn.addEventListener('click', closePanel);
    overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); });

    saveBtn.addEventListener('click', () => {
      set('gemini',      document.getElementById('s-gemini-key').value.trim());
      set('twitchToken', document.getElementById('s-twitch-token').value.trim());
      set('twitchClient',document.getElementById('s-twitch-client-id').value.trim());
      set('ghToken',     document.getElementById('s-github-token').value.trim());
      set('ghOwner',     document.getElementById('s-github-owner').value.trim());
      set('ghRepo',      document.getElementById('s-github-repo').value.trim());
      note.textContent = '✓ Saved';
      setTimeout(() => note.textContent = '', 2000);
      // Re-check analyse button state
      if (window.App) App.checkAnalyseReady();
    });
  }

  return { init, get, set, getAll, hasMinimum };

})();
