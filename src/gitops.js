'use strict';

const { execFile } = require('child_process');

/**
 * Read-only git access. Nothing here checks out, commits, merges, resets or
 * pushes - every command only reads. The merge is computed with
 * `git merge-tree --write-tree`, which works on objects and never touches
 * the working tree or the index.
 */

function git(cwd, args, opts) {
  const o = Object.assign({ allowFail: false, maxBuffer: 64 * 1024 * 1024 }, opts || {});
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotePath=false'].concat(args), { cwd, maxBuffer: o.maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
        if (err && err.code === 'ENOENT') return reject(new Error('git was not found on PATH.'));
        if (err && !o.allowFail) {
          return reject(new Error((stderr || err.message || '').trim() || 'git ' + args.join(' ') + ' failed'));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      });
  });
}

async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.stdout.trim();
}

async function currentBranch(cwd) {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

async function gitVersion(cwd) {
  const r = await git(cwd, ['--version'], { allowFail: true });
  const m = /(\d+)\.(\d+)/.exec(r.stdout);
  return m ? { major: +m[1], minor: +m[2], text: r.stdout.trim() } : null;
}

async function branches(cwd) {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/\/HEAD$/.test(s));
}

/** Prefers the local branch, then <remote>/<name>, so either form works in settings. */
async function resolveRef(cwd, name, remote) {
  const candidates = [name];
  if (remote && name.indexOf('/') === -1) candidates.push(remote + '/' + name);
  for (const c of candidates) {
    const r = await git(cwd, ['rev-parse', '--verify', '--quiet', c + '^{commit}'], { allowFail: true });
    if (r.code === 0 && r.stdout.trim()) return { ref: c, sha: r.stdout.trim() };
  }
  return null;
}

async function fetch(cwd, remote) {
  await git(cwd, ['fetch', '--quiet', remote]);
}

async function mergeBase(cwd, a, b) {
  const r = await git(cwd, ['merge-base', a, b], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Files git itself would leave in conflict, computed without touching the working tree. */
async function conflictedFiles(cwd, target, incoming) {
  const r = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, incoming], { allowFail: true });
  if (r.code !== 0 && r.code !== 1) throw new Error(r.stderr.trim() || 'git merge-tree failed (needs git 2.38 or newer).');
  return parseMergeTree(r.stdout);
}

/**
 * --name-only output: first line is the result tree, then one conflicted
 * path per line, then a blank line before any messages.
 */
function parseMergeTree(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) break;
    if (out.indexOf(l) === -1) out.push(l);
  }
  return out;
}

async function changedSince(cwd, base, ref) {
  const r = await git(cwd, ['diff', '--name-only', '--no-renames', base, ref]);
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** Contents of a file at a ref, or null when it does not exist there. */
async function show(cwd, ref, filePath) {
  const r = await git(cwd, ['show', ref + ':' + filePath.replace(/\\/g, '/')], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

/**
 * Compares two branches the way a promotion would.
 *
 *   conflict   git would stop with a conflict
 *   both       both branches changed it since the merge-base; git may merge
 *              it line by line, which for metadata XML can still produce
 *              duplicates or broken structure - worth a semantic merge
 */
async function analyse(cwd, targetName, incomingName, options) {
  const o = Object.assign({ remote: 'origin', includeBothChanged: true, metadataOnly: false }, options || {});
  const target = await resolveRef(cwd, targetName, o.remote);
  if (!target) throw new Error('Branch "' + targetName + '" was not found locally or on ' + o.remote + '.');
  const incoming = await resolveRef(cwd, incomingName, o.remote);
  if (!incoming) throw new Error('Branch "' + incomingName + '" was not found locally or on ' + o.remote + '.');

  const base = await mergeBase(cwd, target.sha, incoming.sha);
  if (!base) throw new Error(target.ref + ' and ' + incoming.ref + ' have no common history.');

  const conflicts = await conflictedFiles(cwd, target.sha, incoming.sha);
  const files = new Map();
  for (const p of conflicts) files.set(p, { path: p, status: 'conflict' });

  if (o.includeBothChanged) {
    const t = new Set(await changedSince(cwd, base, target.sha));
    const i = await changedSince(cwd, base, incoming.sha);
    for (const p of i) if (t.has(p) && !files.has(p)) files.set(p, { path: p, status: 'both' });
  }

  let list = Array.from(files.values()).map(f => Object.assign(f, { metadata: isMetadataPath(f.path) }));
  if (o.metadataOnly) list = list.filter(f => f.metadata);
  list.sort((a, b) => (a.status === b.status ? 0 : a.status === 'conflict' ? -1 : 1) || a.path.localeCompare(b.path));
  return { target, incoming, base, files: list };
}

function isMetadataPath(p) {
  return /-meta\.xml$/i.test(p) || /\/package\.xml$/i.test(p) ||
    /\.(object|profile|permissionset|layout|labels|workflow|flexipage|app|tab|field|recordType)$/i.test(p);
}

module.exports = { repoRoot, currentBranch, gitVersion, branches, fetch, show, analyse, parseMergeTree };
