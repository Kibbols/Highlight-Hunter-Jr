// settings.js

window.Settings = (() => {

  function get(key)      { return localStorage.getItem(key) || ''; }
  function set(key, val) { if (val) localStorage.setItem(key, val); else localStorage.removeItem(key); }

  function getAll() {
    return {
      geminiKey:   get('gemini_key'),
      twitchToken: get('twitch_oauth_token'),
      ghToken:     get('gh_token'),
      ghOwner:     get('gh_owner'),
      ghRepo:      get('gh_repo'),
    };
  }

  function hasGemini()  { return !!get('gemini_key'); }
  function hasTwitch()  { return !!get('twitch_oauth_token'); }
  function hasGitHub()  { return !!(get('gh_token') && get('gh_owner') && get('gh_repo')); }

  // ── Twitch OAuth implicit grant ───────────────────────────────────
  function connectTwitch() {
    const clientId    = CONFIG.TWITCH_CLIENT_ID;
    const redirectUri = encodeURIComponent(`${CONFIG.GITHUB_PAGES_URL}/auth-twitch.html`);
    const scopes      = encodeURIComponent('user:read:email');
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=token&scope=${scopes}`;
    window.location.href = url;
  }

  function disconnectTwitch() {
    set('twitch_oauth_token', null);
    set('twitch_user_login',  null);
    set('twitch_user_id',     null);
  }

  // ── DOM wiring ────────────────────────────────────────────────────
  function init() {
    const overlay  = document.getElementById('settings-overlay');
    const openBtn  = document.getElementById('btn-open-settings');
    const closeBtn = document.getElementById('settings-close');
    const saveBtn  = document.getElementById('settings-save');
    const note     = document.getElementById('settings-save-note');

    // Twitch connect buttons (header panel + setup view)
    document.getElementById('btn-twitch-connect')
      .addEventListener('click', connectTwitch);
    document.getElementById('btn-twitch-connect-main')
      .addEventListener('click', connectTwitch);
    document.getElementById('btn-twitch-disconnect')
      .addEventListener('click', () => {
        disconnectTwitch();
        _refreshTwitchState();
        if (window.App) App.onTwitchDisconnected();
      });

    function openPanel() {
      document.getElementById('s-gemini-key').value   = get('gemini_key');
      document.getElementById('s-github-token').value = get('gh_token');
      document.getElementById('s-github-owner').value = get('gh_owner');
      document.getElementById('s-github-repo').value  = get('gh_repo');
      note.textContent = '';
      _refreshTwitchState();
      overlay.classList.remove('hidden');
    }

    openBtn.addEventListener('click', openPanel);
    closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });

    saveBtn.addEventListener('click', () => {
      set('gemini_key', document.getElementById('s-gemini-key').value.trim());
      set('gh_token',   document.getElementById('s-github-token').value.trim());
      set('gh_owner',   document.getElementById('s-github-owner').value.trim());
      set('gh_repo',    document.getElementById('s-github-repo').value.trim());
      note.textContent = '✓ Saved';
      setTimeout(() => { note.textContent = ''; }, 2000);
      overlay.classList.add('hidden');
      if (window.App) App.checkReady();
    });

    // Setup view settings shortcut
    document.getElementById('setup-open-settings')
      .addEventListener('click', openPanel);
  }

  function _refreshTwitchState() {
    const connected = document.getElementById('twitch-connected-state');
    const disconnected = document.getElementById('twitch-disconnected-state');
    const usernameEl = document.getElementById('twitch-username-display');
    if (hasTwitch()) {
      const login = get('twitch_user_login');
      usernameEl.textContent = login ? `@${login}` : 'Connected';
      connected.classList.remove('hidden');
      disconnected.classList.add('hidden');
    } else {
      connected.classList.add('hidden');
      disconnected.classList.remove('hidden');
    }
  }

  return { init, get, set, getAll, hasGemini, hasTwitch, hasGitHub, connectTwitch, disconnectTwitch };

})();
