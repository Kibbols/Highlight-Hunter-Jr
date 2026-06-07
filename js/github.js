// github.js — GitHub Contents API (read + write)
// Used for: style profiles, manifest.json

window.GH = (() => {

  function getCreds() {
    return {
      token:  localStorage.getItem('gh_token')  || '',
      owner:  localStorage.getItem('gh_owner')  || '',
      repo:   localStorage.getItem('gh_repo')   || '',
    };
  }

  function headers() {
    const { token } = getCreds();
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  function repoBase() {
    const { owner, repo } = getCreds();
    if (!owner || !repo) throw new Error('GitHub owner/repo not configured in Settings');
    return `https://api.github.com/repos/${owner}/${repo}/contents`;
  }

  // Read a file — returns { content (parsed), sha } or null if 404
  async function readFile(path) {
    const url = `${repoBase()}/${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const text = atob(data.content.replace(/\n/g, ''));
    return { content: text, sha: data.sha };
  }

  // Write a file (create or update)
  // content should be a plain string; this function base64-encodes it
  async function writeFile(path, content, message, sha = null) {
    const url = `${repoBase()}/${encodeURIComponent(path)}`;
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))), // UTF-8 safe base64
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
    return await res.json();
  }

  // Upsert — read SHA first, then write
  async function upsertFile(path, content, message) {
    const existing = await readFile(path);
    return writeFile(path, content, message, existing ? existing.sha : null);
  }

  // Read manifest.json — returns array of profile names, or []
  async function readManifest() {
    const result = await readFile('Reference Data/manifest.json');
    if (!result) return [];
    try { return JSON.parse(result.content); }
    catch { return []; }
  }

  // Write manifest.json
  async function writeManifest(profileNames) {
    return upsertFile(
      'Reference Data/manifest.json',
      JSON.stringify(profileNames, null, 2),
      'Update style profile manifest'
    );
  }

  // Read a named style profile JSON
  async function readProfile(name) {
    const result = await readFile(`Reference Data/${name}.json`);
    if (!result) return null;
    try { return JSON.parse(result.content); }
    catch { return null; }
  }

  // Write a named style profile JSON
  async function writeProfile(name, profileObj) {
    return upsertFile(
      `Reference Data/${name}.json`,
      JSON.stringify(profileObj, null, 2),
      `Update style profile: ${name}`
    );
  }

  return { readFile, writeFile, upsertFile, readManifest, writeManifest, readProfile, writeProfile };

})();
