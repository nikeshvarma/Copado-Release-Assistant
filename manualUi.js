'use strict';

/**
 * The page's Manual tab - always there, with or without Copado access: two versions pasted, dropped or chosen,
 * compared side by side; a package from a Copado commit file. Compare in Release Assistant opens it with a file.
 * The texts stay here; the page gets what each is (its type, its lines, valid or not) and its first lines.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const X = require('./src/xmlParser');

const changed = new vscode.EventEmitter();
let deps = null;
const sides = { target: null, incoming: null };
let commit = null;
let last = null;

function activate(context, d, cmd) {
  deps = d;
  cmd('cmr.manual.mergeWith', uri => mergeWith(uri));
}

/** What a pasted text is: its metadata type, its lines, valid XML or not - and its first lines. */
function describe(name, text) {
  const t = String(text);
  const d = X.parse(t);
  const ok = !!d.root && !(d.errors && d.errors.length);
  const lines = t.split(/\r?\n/);
  return { name: name || null, type: d.root ? d.root.name : null, lines: lines.length - (t.endsWith('\n') ? 1 : 0), valid: ok, problem: ok ? null : String((d.errors && d.errors[0] && d.errors[0].message) || 'not XML'), head: lines.slice(0, 7) };
}


function snapshot() {
  const side = s => sides[s] ? describe(sides[s].name, sides[s].text) : null;
  let rows = null;
  if (commit) { try { rows = require('./src/manifest').parseCommit(commit.text, commit.name || 'commit').length; } catch (e) { rows = 0; } }
  return { show: true, target: side('target'), incoming: side('incoming'), commit: commit ? { name: commit.name, components: rows } : null, last };
}

async function pickFile(filters, title) {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters, title });
  if (!picked || !picked.length) return null;
  return { name: path.basename(picked[0].fsPath), text: Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8') };
}

async function act(name, p) {
  const o = p || {};
  const side = o.side === 'incoming' ? 'incoming' : 'target';
  switch (name) {
    case 'manual.set': sides[side] = { name: o.name || null, text: String(o.text || '') }; break;
    case 'manual.dropUri': { const u = vscode.Uri.parse(String(o.uri)); sides[side] = { name: path.basename(u.fsPath), text: Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8') }; break; }
    case 'manual.pick': { const f = await pickFile({ 'Metadata XML': ['xml'], 'All files': ['*'] }, side === 'target' ? 'The target - keeps everything' : 'The incoming version - merged in'); if (f) sides[side] = f; break; }
    case 'manual.clear': sides[side] = null; break;
    case 'manual.clearBoth': sides.target = null; sides.incoming = null; break;
    case 'manual.swap': { const t = sides.target; sides.target = sides.incoming; sides.incoming = t; break; }
    case 'manual.merge': await merge(); break;
    case 'manual.again': if (last && last.target && last.incoming) { sides.target = last.target; sides.incoming = last.incoming; await merge(); } break;
    case 'manual.commitSet': commit = { name: o.name || 'pasted commit', text: String(o.text || '') }; break;
    case 'manual.commitPick': { const f = await pickFile({ 'Copado commit JSON': ['json'] }, 'A Copado commit file'); if (f) commit = f; break; }
    case 'manual.commitClear': commit = null; break;
    case 'manual.package': await packageFromCommit(); break;
    case 'manual.validate': await vscode.commands.executeCommand('cmr.validate.run'); break;
    default: return;
  }
  changed.fire();
}

/** The two versions, merged in the merge editor: their texts written to working files first. */
async function merge() {
  if (!sides.target || !sides.incoming) { vscode.window.showWarningMessage('Paste, drop or choose both versions first.'); return; }
  for (const s of ['target', 'incoming']) {
    const d = describe(sides[s].name, sides[s].text);
    if (!d.valid) { vscode.window.showWarningMessage('The ' + (s === 'target' ? 'target' : 'incoming version') + ' is not valid XML: ' + d.problem); return; }
  }
  // a folder of its own for these two versions: another pair can never be read in their place - VS Code keeps a file
  // it has opened in memory - and unsaved changes come back only for the very same two
  const fingerprint = require('crypto').createHash('sha1').update(sides.target.text + '\u0000' + sides.incoming.text).digest('hex').slice(0, 12);
  const root = await deps.storageDir('manual');
  const dir = vscode.Uri.joinPath(root, fingerprint);
  prune(root.fsPath, fingerprint);
  const type = describe(null, sides.target.text).type || 'metadata';
  // the file's own name - the merge editor's tab says it - or one from the type for pasted text
  const base = sides.target.name ? sides.target.name.replace(/[^\w .%()-]+/g, '_').replace(/^(?!.*\.xml$)(.*)$/i, '$1.xml') : type + '-meta.xml';
  const t = vscode.Uri.joinPath(dir, 'target', base), i = vscode.Uri.joinPath(dir, 'incoming', base);
  await vscode.workspace.fs.writeFile(t, Buffer.from(sides.target.text, 'utf8'));
  await vscode.workspace.fs.writeFile(i, Buffer.from(sides.incoming.text, 'utf8'));
  last = { type, at: new Date().toISOString(), target: sides.target, incoming: sides.incoming };
  await deps.startSession(t, i, null, { manual: true, applyOnSave: false, openAfterApply: false, theirs: 'the incoming version',
    labels: { target: 'Target', incoming: 'Incoming', merged: 'Incoming' } });
}

/** Earlier merges' folders: the ten most recent kept, the rest removed. */
function prune(root, keep) {
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^[0-9a-f]{12}$/.test(d.name) && d.name !== keep)
      .map(d => ({ d: path.join(root, d.name), t: fs.statSync(path.join(root, d.name)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of dirs.slice(9)) fs.rmSync(x.d, { recursive: true, force: true });
  } catch (e) { /* nothing to prune */ }
}

/** package.xml from a pasted or chosen Copado commit file, the same way as from the right-click. */
async function packageFromCommit() {
  if (!commit) { vscode.window.showWarningMessage('Paste or choose a Copado commit file first.'); return; }
  const dir = await deps.storageDir('manual');
  const f = vscode.Uri.joinPath(dir, (commit.name || 'commit').replace(/[^\w.-]+/g, '_').replace(/(\.json)?$/i, '.json'));
  await vscode.workspace.fs.writeFile(f, Buffer.from(commit.text, 'utf8'));
  await deps.generatePackage([f]);
}

/** Compare in Release Assistant: the Manual tab, with this file as the target. */
async function mergeWith(uri) {
  if (uri && uri.fsPath) sides.target = { name: path.basename(uri.fsPath), text: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') };
  changed.fire();
  await deps.showPage('Manual');
}

module.exports = { activate, snapshot, act, describe, onChange: f => changed.event(f) };
