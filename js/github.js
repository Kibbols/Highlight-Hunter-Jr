// github.js — GitHub Contents API read/write for style profiles

window.GH = (() => {

  function _creds() {
    return {
      token: Settings.get('gh_token'),
      owner: Settings.get('gh_owner'),
      repo:  Settings.get('gh_repo'),
    };
  }

  function _headers() {
    return {
      'Authorization': `Bearer ${_creds().token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  function _base() {
    const { owner, repo } = _creds();
    if (!owner || !repo) throw new Error('GitHub owner/repo not set in Settings');
    return `https://api.github.com/repos/${owner}/${repo}/contents`;
  }

  async function readFile(path) {
    const res = await fetch(`${_base()}/${encodeURIComponent(path)}`, { headers: _headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
    const data = await res.json();
    return { content: atob(data.content.replace(/\n/g, '')), sha: data.sha };
  }

  async function writeFile(path, content, message, sha = null) {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
    };
    if (sha) body.sha = sha;
    const res = await fetch(`${_base()}/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: _headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function upsertFile(path, content, message) {
    const existing = await readFile(path);
    return writeFile(path, content, message, existing?.sha || null);
  }

  async function readManifest() {
    const r = await readFile('Reference Data/manifest.json');
    if (!r) return [];
    try { return JSON.parse(r.content); } catch { return []; }
  }

  async function writeManifest(names) {
    return upsertFile('Reference Data/manifest.json', JSON.stringify(names, null, 2), 'Update style profile manifest');
  }

  async function readProfile(name) {
    const r = await readFile(`Reference Data/${name}.json`);
    if (!r) return null;
    try { return JSON.parse(r.content); } catch { return null; }
  }

  async function writeProfile(name, obj) {
    return upsertFile(`Reference Data/${name}.json`, JSON.stringify(obj, null, 2), `Update style profile: ${name}`);
  }

  return { readFile, writeFile, upsertFile, readManifest, writeManifest, readProfile, writeProfile };

})();
