// settings.js

window.Settings = (() => {

  const K = {
    gemini:         'gemini_key',
    twitchToken:    'twitch_oauth_token',
    twitchClientId: 'twitch_client_id',
    twitchSecret:   'twitch_client_secret',
    twitchLogin:    'twitch_user_login',
    twitchUserId:   'twitch_user_id',
    ghToken:        'gh_token',
    ghOwner:        'gh_owner',
    ghRepo:         'gh_repo',
  };

  const get = key      => localStorage.getItem(K[key]) || '';
  const set = (key, v) => v ? localStorage.setItem(K[key], v) : localStorage.removeItem(K[key]);

  const hasTwitch      = () => !!get('twitchToken');
  const hasGemini      = () => !!get('gemini');
  const hasGitHub      = () => !!(get('ghToken') && get('ghOwner') && get('ghRepo'));
  const hasClientCreds = () => !!(get('twitchClientId') && get('twitchSecret'));

  function connectTwitch() {
    const clientId = get('twitchClientId');
    if (!clientId) {
      alert('No Twitch Client ID found. Please enter it in Settings and save first.');
      return;
    }
    // Build redirect URI from the known GitHub Pages URL
    const redirectUri = encodeURIComponent('https://kibbols.github.io/Highlight-Hunter-Jr/auth-twitch.html');
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=token&scope=user:read:email`;
    console.log('[HH] Redirecting to Twitch OAuth:', url);
    window.location.href = url;
  }

  function disconnectTwitch() {
    set('twitchToken',  null);
    set('twitchLogin',  null);
    set('twitchUserId', null);
  }

  // ── DOM ───────────────────────────────────────────────────────────
  function init() {
    const overlay  = document.getElementById('settings-overlay');
    const openBtn  = document.getElementById('btn-open-settings');
    const closeBtn = document.getElementById('settings-close');
    const saveBtn  = document.getElementById('settings-save');
    const feedback = document.getElementById('settings-feedback');

    // Show the exact redirect URI they need to register
    document.getElementById('redirect-uri-display').textContent =
      'https://kibbols.github.io/Highlight-Hunter-Jr/auth-twitch.html';

    function open() {
      document.getElementById('s-twitch-client-id').value     = get('twitchClientId');
      document.getElementById('s-twitch-client-secret').value = get('twitchSecret');
      document.getElementById('s-gemini-key').value           = get('gemini');
      document.getElementById('s-gh-token').value             = get('ghToken');
      document.getElementById('s-gh-owner').value             = get('ghOwner');
      document.getElementById('s-gh-repo').value              = get('ghRepo');
      feedback.textContent = '';
      _refreshTwitchState();
      overlay.classList.remove('hidden');
    }
    function close() { overlay.classList.add('hidden'); }

    openBtn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    saveBtn.addEventListener('click', () => {
      set('twitchClientId', document.getElementById('s-twitch-client-id').value.trim());
      set('twitchSecret',   document.getElementById('s-twitch-client-secret').value.trim());
      set('gemini',         document.getElementById('s-gemini-key').value.trim());
      set('ghToken',        document.getElementById('s-gh-token').value.trim());
      set('ghOwner',        document.getElementById('s-gh-owner').value.trim());
      set('ghRepo',         document.getElementById('s-gh-repo').value.trim());
      feedback.textContent = '✓ Saved';
      setTimeout(() => { feedback.textContent = ''; close(); }, 1200);
      if (window.App) App.checkReady();
    });

    // Settings panel connect button
    document.getElementById('btn-connect-twitch')
      ?.addEventListener('click', connectTwitch);

    // Setup screen connect button
    document.getElementById('btn-connect-twitch-setup')
      ?.addEventListener('click', () => {
        if (!get('twitchClientId')) {
          open();
        } else {
          connectTwitch();
        }
      });

    document.getElementById('btn-disconnect-twitch')
      ?.addEventListener('click', () => {
        disconnectTwitch();
        _refreshTwitchState();
        if (window.App) App.onTwitchDisconnected();
      });

    document.getElementById('btn-setup-settings')
      ?.addEventListener('click', open);
  }

  function _refreshTwitchState() {
    const conn   = document.getElementById('twitch-connected');
    const disc   = document.getElementById('twitch-disconnected');
    const dispEl = document.getElementById('twitch-user-display');
    if (hasTwitch()) {
      const login = get('twitchLogin');
      dispEl.textContent = login ? `@${login}` : 'Connected';
      conn.classList.remove('hidden');
      disc.classList.add('hidden');
    } else {
      conn.classList.add('hidden');
      disc.classList.remove('hidden');
    }
  }

  return { init, get, set, hasTwitch, hasGemini, hasGitHub, hasClientCreds, connectTwitch, disconnectTwitch };

})();
