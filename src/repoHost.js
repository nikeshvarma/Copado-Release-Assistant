'use strict';

/**
 * Read-only access to a Git host, to read the files Copado committed on a
 * feature branch. One adapter per provider, the same three operations:
 *   check()                    -> { ok, message }
 *   readFile(branch, path)     -> Buffer, or null when the file is not on the branch
 *   listFiles(branch, folder)  -> [paths] below the folder, recursively
 * Providers: Azure DevOps (incl. *.visualstudio.com and Server), GitHub (incl.
 * Enterprise), GitLab (incl. self-managed) and Bitbucket Cloud. Nothing is written.
 */
const PROVIDERS = ['azure', 'github', 'gitlab', 'bitbucket'];

/** A repository address -> { provider, host, ... } or null. provider forces the kind for self-hosted servers. */
function parseRepoUrl(url, provider) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
  const host = u.host.toLowerCase();
  const parts = decodeURIComponent(u.pathname).replace(/\.git$/, '').split('/').filter(Boolean);
  const kind = provider && provider !== 'auto' ? provider
    : /(^|\.)dev\.azure\.com$|\.visualstudio\.com$/.test(host) ? 'azure'
    : host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket' : null;
  if (!kind) return null;
  const origin = u.protocol + '//' + u.host;
  if (kind === 'azure') {
    const g = parts.indexOf('_git');
    if (g < 1 || !parts[g + 1]) return null;
    const pre = parts.slice(0, g);                       // [org,] project  (or [collection,] project on a server)
    const project = pre[pre.length - 1];
    const prefix = pre.slice(0, -1);                     // the org on dev.azure.com, nothing on *.visualstudio.com
    return { provider: kind, host, repo: parts[g + 1], project,
      api: origin + '/' + prefix.concat([project]).map(encodeURIComponent).join('/') + '/_apis/git/repositories/' + encodeURIComponent(parts[g + 1]) };
  }
  if (kind === 'github') {
    if (parts.length < 2) return null;
    return { provider: kind, host, repo: parts[1], owner: parts[0], api: (host === 'github.com' ? 'https://api.github.com' : origin + '/api/v3') + '/repos/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) };
  }
  if (kind === 'gitlab') {
    const p = parts.slice(0, parts.indexOf('-') === -1 ? parts.length : parts.indexOf('-'));
    if (p.length < 2) return null;
    return { provider: kind, host, repo: p[p.length - 1], api: origin + '/api/v4/projects/' + encodeURIComponent(p.join('/')) };
  }
  if (parts.length < 2) return null;
  return { provider: kind, host, repo: parts[1], workspace: parts[0], api: (host === 'bitbucket.org' ? 'https://api.bitbucket.org' : origin) + '/2.0/repositories/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) };
}

/**
 * The address Copado keeps on its Git Repository record, as a web address the
 * connectors understand. Copado often stores the SSH form; it is turned into
 * https so only a token is needed:
 *   git@github.com:owner/repo.git                 -> https://github.com/owner/repo
 *   git@ssh.dev.azure.com:v3/org/project/repo     -> https://dev.azure.com/org/project/_git/repo
 *   org@vs-ssh.visualstudio.com:v3/org/proj/repo  -> https://org.visualstudio.com/proj/_git/repo
 *   ssh://git@host:22/group/repo.git              -> https://host/group/repo
 * Returns null for anything else.
 */
function fromCopadoUri(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    try { const u = new URL(v); u.username = ''; u.password = ''; return u.toString().replace(/\.git$/, '').replace(/\/$/, ''); } catch (e) { return null; }
  }
  let host, rest;
  let m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(v);
  if (m) { host = m[1]; rest = m[2]; } else if ((m = /^(?:[^@\s]+@)?([^:\s/]+):(?!\/\/)(.+)$/.exec(v))) { host = m[1]; rest = m[2]; } else return null;
  rest = rest.replace(/\.git$/, '').replace(/^\/+/, '');
  host = host.toLowerCase();
  const parts = rest.split('/').filter(Boolean);
  if (host === 'ssh.dev.azure.com' && parts[0] === 'v3' && parts.length >= 4) return 'https://dev.azure.com/' + parts[1] + '/' + parts[2] + '/_git/' + parts.slice(3).join('/');
  if (/^vs-ssh\.visualstudio\.com$/.test(host) && parts[0] === 'v3' && parts.length >= 4) return 'https://' + parts[1] + '.visualstudio.com/' + parts[2] + '/_git/' + parts.slice(3).join('/');
  if (!parts.length) return null;
  return 'https://' + host + '/' + parts.join('/');
}

/** How each provider wants the token. Bitbucket: "email:api-token" for an API token, a bare repository access token as Bearer. */
function authHeaders(provider, token) {
  const t = String(token || '');
  if (provider === 'azure') return { Authorization: 'Basic ' + Buffer.from(':' + t).toString('base64') };
  if (provider === 'github') return { Authorization: 'Bearer ' + t, 'X-GitHub-Api-Version': '2022-11-28' };
  if (provider === 'gitlab') return { 'PRIVATE-TOKEN': t };
  return t.includes(':') ? { Authorization: 'Basic ' + Buffer.from(t).toString('base64') } : { Authorization: 'Bearer ' + t };
}

/** A GET through the shared client (proxy included); a redirect to another host is reported, never followed with the token. */
function request(url, headers) {
  return require('./http').request(url, { headers: Object.assign({ 'User-Agent': 'copado-release-assistant', Accept: '*/*' }, headers) });
}

/** Turns an answer into a plain explanation, per what each status means on these hosts. */
function explain(r, what) {
  if (r.redirectedTo || (r.status >= 300 && r.status < 400)) return what + ': the host redirected to ' + (r.redirectedTo || 'a sign-in page') + ' - the token was not accepted, or the address points at the wrong host';
  if (r.status === 203 || /text\/html/.test(r.headers['content-type'] || '') && r.status === 200) return what + ': a sign-in page came back - the token was not accepted';
  if (r.status === 401) return what + ': the token is invalid or expired (401)';
  if (r.status === 403) return what + ': the token was accepted but has no read access to this repository, or a policy blocks it (403)';
  if (r.status === 404) return what + ': not found (404) - check the address, or the token cannot see this repository';
  return what + ': HTTP ' + r.status + ' ' + r.body.toString('utf8').slice(0, 160);
}

function createHost(repo, token) {
  const h = authHeaders(repo.provider, token);
  const get = async (url, extra) => request(url, Object.assign({}, h, extra || {}));
  const json = async url => { const r = await get(url, { Accept: 'application/json' }); if (r.status !== 200 || /text\/html/.test(r.headers['content-type'] || '')) throw new Error(explain(r, 'Listing files')); return JSON.parse(r.body.toString('utf8')); };
  const enc = encodeURIComponent;
  const bbHash = new Map();
  const ops = {
    azure: {
      check: () => get(repo.api + '?api-version=7.1', { Accept: 'application/json' }),
      branch: async b => { const r = await get(repo.api + '/refs?filter=' + enc('heads/' + b) + '&api-version=7.1', { Accept: 'application/json' });
        if (r.status !== 200) return r; const v = JSON.parse(r.body.toString('utf8')).value || []; return { status: v.some(x => x.name === 'refs/heads/' + b) ? 200 : 404, headers: {}, body: Buffer.alloc(0) }; },
      file: (b, p) => get(repo.api + '/items?path=' + enc('/' + p) + '&versionDescriptor.version=' + enc(b) + '&versionDescriptor.versionType=branch&includeContent=true&$format=octetStream&api-version=7.1', { Accept: 'application/octet-stream' }),
      list: async (b, f) => (await json(repo.api + '/items?scopePath=' + enc('/' + f) + '&recursionLevel=Full&versionDescriptor.version=' + enc(b) + '&versionDescriptor.versionType=branch&api-version=7.1')).value
        .filter(x => !x.isFolder).map(x => x.path.replace(/^\//, ''))
    },
    github: {
      check: () => get(repo.api, { Accept: 'application/vnd.github+json' }),
      branch: b => get(repo.api + '/git/ref/heads/' + b.split('/').map(enc).join('/'), { Accept: 'application/vnd.github+json' }),
      file: (b, p) => get(repo.api + '/contents/' + p.split('/').map(enc).join('/') + '?ref=' + enc(b), { Accept: 'application/vnd.github.raw+json' }),
      list: async (b, f) => {
        const out = [];
        const walk = async dir => {
          for (const x of await json(repo.api + '/contents/' + dir.split('/').map(enc).join('/') + '?ref=' + enc(b))) {
            if (x.type === 'file') out.push(x.path); else if (x.type === 'dir') await walk(x.path);
          }
        };
        await walk(f);
        return out;
      }
    },
    gitlab: {
      check: () => get(repo.api, { Accept: 'application/json' }),
      branch: b => get(repo.api + '/repository/branches/' + enc(b), { Accept: 'application/json' }),
      file: (b, p) => get(repo.api + '/repository/files/' + enc(p) + '/raw?ref=' + enc(b)),
      list: async (b, f) => {
        const out = [];
        for (let page = 1; page < 50; page++) {
          const r = await get(repo.api + '/repository/tree?path=' + enc(f) + '&ref=' + enc(b) + '&recursive=true&per_page=100&page=' + page, { Accept: 'application/json' });
          if (r.status !== 200) throw new Error(explain(r, 'Listing files'));
          const rows = JSON.parse(r.body.toString('utf8'));
          out.push(...rows.filter(x => x.type === 'blob').map(x => x.path));
          if (!r.headers['x-next-page']) break;
        }
        return out;
      }
    },
    bitbucket: {
      // a branch with a slash is ambiguous in /src/, so it is turned into its commit first
      hash: async b => {
        if (bbHash.has(b)) return bbHash.get(b);
        const r = await get(repo.api + '/refs/branches/' + enc(b), { Accept: 'application/json' });
        const h2 = r.status === 200 ? JSON.parse(r.body.toString('utf8')).target.hash : null;
        bbHash.set(b, h2);
        return h2;
      },
      check: () => get(repo.api, { Accept: 'application/json' }),
      branch: async b => ({ status: (await ops.hash(b)) ? 200 : 404, headers: {}, body: Buffer.alloc(0) }),
      file: async (b, p) => { const hh = await ops.hash(b); return hh ? get(repo.api + '/src/' + hh + '/' + p.split('/').map(enc).join('/')) : { status: 404, body: Buffer.alloc(0), headers: {} }; },
      list: async (b, f) => {
        const hh = await ops.hash(b);
        if (!hh) return [];
        const out = [];
        const walk = async dir => {
          let url = repo.api + '/src/' + hh + '/' + dir.split('/').map(enc).join('/') + '/?pagelen=100';
          while (url) {
            const page = await json(url);
            for (const x of page.values || []) { if (x.type === 'commit_file') out.push(x.path); else if (x.type === 'commit_directory') await walk(x.path); }
            url = page.next || null;
          }
        };
        await walk(f);
        return out;
      }
    }
  }[repo.provider];
  return {
    provider: repo.provider,
    async check() {
      const r = await ops.check();
      if (r.status === 200 && !/text\/html/.test(r.headers['content-type'] || '')) return { ok: true, message: 'the token can read ' + repo.repo };
      return { ok: false, message: explain(r, 'Reading the repository') };
    },
    /** True when the branch exists, false when the host says it does not; other answers are errors. */
    async branchExists(branch) {
      const r = await ops.branch(branch);
      if (r.status === 404) return false;
      if (r.status === 200 && !/text\/html/.test(r.headers['content-type'] || '')) return true;
      throw new Error(explain(r, 'Looking up the branch ' + branch));
    },
    async readFile(branch, p) {
      const r = await ops.file(branch, p);
      if (r.status === 404) return null;
      if (r.status !== 200 || /text\/html/.test(r.headers['content-type'] || '') && !/\.(html|page|component)$/.test(p)) throw new Error(explain(r, 'Reading ' + p));
      return r.body;
    },
    async listFiles(branch, folder) {
      try { return await ops.list(branch, folder); } catch (e) { if (/\(404\)/.test(e.message)) return []; throw e; }
    }
  };
}

module.exports = { PROVIDERS, parseRepoUrl, fromCopadoUri, authHeaders, createHost };
