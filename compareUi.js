'use strict';

/**
 * The Compare tab: two branches of the connected repository, the files that differ between them grouped by
 * metadata type, each opened in the merge editor - the To branch read-only, a copy of the From branch's file to
 * work on (Format and Order Metadata, Remove Duplicate Entries, Save as file). Nothing in git is changed.
 */
const vscode = require('vscode');
const CB = require('./src/compareBranches');

const changed = new vscode.EventEmitter();
let deps = null;
const st = { connected: null, branches: null, from: null, to: null, busy: null, error: null, files: null, at: null };
const texts = new Map();   // path -> { to, from }

function activate(context, d) { deps = d; }
function onChange(fn) { return changed.event(fn); }
function snapshot() { return JSON.parse(JSON.stringify(st)); }

async function act(name, o) {
  o = o || {};
  switch (name) {
    case 'compare.load': if (st.branches == null) await loadBranches(); break;
    case 'compare.refresh': await loadBranches(); break;
    case 'compare.set': if (o.side === 'from' || o.side === 'to') st[o.side] = String(o.value || '') || null; break;
    case 'compare.swap': { const f = st.from; st.from = st.to; st.to = f; break; }
    case 'compare.reset': st.from = null; st.to = null; st.files = null; st.error = null; st.at = null; texts.clear(); break;
    case 'compare.run': await run(); break;
    case 'compare.open': await open(String(o.path || '')); break;
    case 'compare.summaries': await summaries((o.paths || []).map(String)); break;
    case 'compare.connect': await vscode.commands.executeCommand('cmr.repo.connect'); await loadBranches(); break;
    default: return;
  }
  changed.fire();
}

async function loadBranches() {
  const host = await deps.host();
  st.connected = !!host;
  st.error = null;
  if (!host) { st.branches = []; return; }
  st.busy = 'Reading the branches'; changed.fire();
  try {
    st.branches = await host.listBranches();
    if (!st.branches.length) st.error = 'The repository listed no branches - check the connection.';
  } finally { st.busy = null; }
}

async function run() {
  const host = await deps.host();
  if (!host) { st.connected = false; return; }
  if (!st.from || !st.to || st.from === st.to) { st.error = 'Choose two different branches.'; return; }
  st.error = null; st.files = null; texts.clear();
  st.busy = 'Comparing ' + st.from + ' with ' + st.to; changed.fire();
  try {
    const list = await host.changedFiles(st.from, st.to);
    if (list == null) { st.error = 'The repository could not compare these branches.'; return; }
    // a list the repository cut short is said to be - its last folders (permission sets, profiles) would be missing
    if (list.incomplete) st.error = 'The repository listed only the first ' + list.length + ' changed files - the rest, often whole folders such as permission sets and profiles, are not shown.';
    const dirs = deps.packageDirs();
    st.files = list.filter(f => CB.inProject(f.path, dirs)).map(f => Object.assign({ summary: null }, f, CB.groupOf(f.path)))
      // what was removed or changed first, then what is new
      .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    st.at = new Date().toISOString();
  } finally { st.busy = null; }
}
const RANK = { removed: 0, changed: 1, added: 2 };

/** What differs, in a few words - only for the files shown, six at a time; each read once. */
async function summaries(paths) {
  const host = await deps.host();
  const todo = (st.files || []).filter(f => paths.includes(f.path) && f.kind === 'changed' && !f.summary && !f.reading);
  if (!host || !todo.length) return;
  for (const f of todo) f.reading = true;
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async f => { try { const t = await both(host, f); f.summary = CB.summarize(f.path, t.to, t.from); f.same = CB.same(f.summary); } catch (e) { f.summary = 'could not be read'; } finally { delete f.reading; } }));
    changed.fire();
  }
}

async function both(host, f) {
  if (texts.has(f.path)) return texts.get(f.path);
  const read = async br => { const b = await host.readFile(br, f.path); return b == null ? null : b.toString('utf8'); };
  const t = { to: f.kind === 'added' ? null : await read(st.to), from: f.kind === 'removed' ? null : await read(st.from) };
  // held only for the last 200 files read - the rest are read again when needed
  texts.set(f.path, t);
  if (texts.size > 200) texts.delete(texts.keys().next().value);
  return t;
}

async function open(p) {
  const f = (st.files || []).find(x => x.path === p);
  const host = await deps.host();
  if (!f || !host) return;
  const t = await both(host, f);
  // only on one side: the file itself, to read
  if (t.to == null || t.from == null) {
    const doc = await vscode.workspace.openTextDocument({ content: t.to == null ? t.from : t.to, language: CB.languageOf(p) || 'xml' });
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  const name = p.split('/').pop();
  const key = require('crypto').createHash('sha1').update(st.from + '\u0000' + st.to + '\u0000' + p + '\u0000' + t.to + '\u0000' + t.from).digest('hex').slice(0, 12);
  const dir = vscode.Uri.joinPath(await deps.storageDir('compare'), key);
  const to = vscode.Uri.joinPath(dir, 'to', name), from = vscode.Uri.joinPath(dir, 'from', name);
  await vscode.workspace.fs.writeFile(to, Buffer.from(t.to, 'utf8'));
  await vscode.workspace.fs.writeFile(from, Buffer.from(t.from, 'utf8'));
  await deps.startSession(to, from, null, { manual: true, compare: true, applyOnSave: false, openAfterApply: false, theirs: st.from, short: st.from, startFrom: t.from,
    labels: { target: st.to, incoming: st.from, merged: st.from } });
}

module.exports = { activate, act, snapshot, onChange };
