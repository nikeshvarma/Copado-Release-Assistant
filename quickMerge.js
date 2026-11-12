'use strict';

/**
 * One-click merge of a fixed pair of conflict files - by default
 * conflict/metadata/resolution.xml (the target, kept whole) and feature.xml
 * (merged in) - for when Copado's two versions are pasted into the project.
 *
 *   - a status bar button whenever both files exist, and the same action in
 *     the editor title bar while either file is open;
 *   - optional auto-merge: after either file is saved with new content;
 *   - both can be switched on and off from the button's tooltip or settings.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const pair = require('./src/quickPair');

let deps;
let item;
let watcher;
let timer;
let baseline = null;     // { target, incoming } content keys at the last merge, apply or start-up

function activate(context, d) {
  deps = d;
  item = vscode.window.createStatusBarItem('cmr.quickMerge', vscode.StatusBarAlignment.Left, 50);
  item.name = 'Copado: Merge Conflict Files';
  item.command = 'cmr.quickMerge.run';
  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));
  cmd('cmr.quickMerge.run', () => run(false));
  cmd('cmr.quickMerge.toggleAuto', () => toggle('quickMerge.auto', 'Auto-merge after paste'));
  cmd('cmr.quickMerge.toggleButton', () => toggle('quickMerge.enabled', 'The merge conflict files button'));

  context.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cmr.quickMerge') || e.affectsConfiguration('cmr.project')) rewatch();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(rewatch),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidSaveTextDocument(doc => { if (isPairFile(doc.uri)) changed(); }),
    { dispose: () => { if (watcher) watcher.dispose(); clearTimeout(timer); } }
  );
  rewatch();
}

function cfg() {
  const c = vscode.workspace.getConfiguration('cmr');
  return {
    enabled: c.get('quickMerge.enabled', true),
    auto: c.get('quickMerge.auto', false),
    folder: c.get('quickMerge.folder', 'conflict/metadata'),
    target: c.get('quickMerge.target', 'resolution.xml'),
    incoming: c.get('quickMerge.incoming', 'feature.xml')
  };
}

function files() {
  const p = deps.resolveProject();
  const root = p.root || p.fallback;
  return root ? pair.pairPaths(root, cfg()) : null;
}

function isPairFile(uri) {
  const f = files();
  if (!f || uri.scheme !== 'file') return false;
  const p = path.resolve(uri.fsPath).toLowerCase();
  return p === path.resolve(f.target).toLowerCase() || p === path.resolve(f.incoming).toLowerCase();
}

/** Watches the pair's folder, so the button appears and disappears with the files. */
function rewatch() {
  if (watcher) { watcher.dispose(); watcher = null; }
  const f = files();
  if (f) {
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(f.folder), '*.xml'));
    const onFile = (uri, isChange) => { refreshItem(); if (isChange && isPairFile(uri)) changed(); };
    watcher.onDidCreate(uri => onFile(uri, true));
    watcher.onDidChange(uri => onFile(uri, true));
    watcher.onDidDelete(uri => onFile(uri, false));
    // what is there now is the starting point: only content pasted from here on counts
    baseline = null;
    guard(recordBaseline)();
  }
  refreshItem();
  updateContext();
}

function refreshItem() {
  const c = cfg();
  const f = files();
  const present = f && fs.existsSync(f.target) && fs.existsSync(f.incoming);
  if (!c.enabled || !present) { item.hide(); return; }
  const t = path.basename(f.target), i = path.basename(f.incoming);
  item.text = '$(git-merge) Merge ' + stem(i) + ' \u2192 ' + stem(t) + (c.auto ? '  $(sync)' : '');
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown('**Merge `' + i + '` into `' + t + '`**\n\n');
  md.appendMarkdown('`' + t + '` keeps everything; `' + i + '` wins a real conflict. Apply writes the result into `' + t + '`.\n\n');
  md.appendMarkdown('Auto-merge after paste: **' + (c.auto ? 'on' : 'off') + '** \u2013 [turn ' + (c.auto ? 'off' : 'on') + '](command:cmr.quickMerge.toggleAuto)' +
    (c.auto ? '  \nIt opens the merge once both files have been pasted and saved.' : '') + '\n\n');
  md.appendMarkdown('[Hide this button](command:cmr.quickMerge.toggleButton) \u00b7 [Settings](command:workbench.action.openSettings?' +
    encodeURIComponent(JSON.stringify(['cmr.quickMerge'])) + ')');
  item.tooltip = md;
  item.show();
}

function stem(name) { return name.replace(/\.xml$/i, ''); }

function updateContext() {
  const ed = vscode.window.activeTextEditor;
  const on = !!(ed && cfg().enabled && isPairFile(ed.document.uri));
  vscode.commands.executeCommand('setContext', 'cmr.quickMergeFile', on);
}

/** The pair's current contents: an open, unsaved editor wins over the file on disk. */
async function readPair(f) {
  const read = async p => {
    const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath).toLowerCase() === path.resolve(p).toLowerCase());
    if (open) return open.getText();
    try { return await fs.promises.readFile(p, 'utf8'); } catch (e) { return ''; }
  };
  return { target: await read(f.target), incoming: await read(f.incoming) };
}

/** A save or a change on disk: wait for writing to settle, then merge if the pair is new. */
function changed() {
  if (!cfg().auto) return;
  clearTimeout(timer);
  timer = setTimeout(() => guard(autoRun)(), deps.autoDelayMs || 1200);
}

async function recordBaseline() {
  const f = files();
  if (!f) return;
  const texts = await readPair(f);
  baseline = { target: pair.fileKey(texts.target), incoming: pair.fileKey(texts.incoming) };
}

async function autoRun() {
  const f = files();
  if (!f) return;
  const texts = await readPair(f);
  const d = pair.autoDecision(baseline, texts.target, texts.incoming);
  if (d.baseline && !d.run) baseline = d.baseline;
  if (d.waiting) {
    const other = path.basename(d.waiting === 'incoming' ? f.incoming : f.target);
    vscode.window.setStatusBarMessage('$(clock) Auto-merge waits for ' + other + ' to be pasted', 5000);
  }
  if (!d.run) return;
  await run(true);
}

async function run(auto) {
  const f = files();
  if (!f) throw new Error('Open your project folder first.');
  const missing = [f.target, f.incoming].filter(p => !fs.existsSync(p));
  if (missing.length) {
    const rel = p => path.relative(path.dirname(f.folder), p);
    throw new Error('Put both files in ' + path.basename(f.folder) + ': ' + missing.map(rel).join(' and ') + ' not found.');
  }
  const texts = await readPair(f);
  if (!texts.target.trim() || !texts.incoming.trim()) {
    if (auto) return;
    throw new Error(path.basename(!texts.target.trim() ? f.target : f.incoming) + ' is empty - paste the version from Copado first.');
  }
  baseline = { target: pair.fileKey(texts.target), incoming: pair.fileKey(texts.incoming) };
  await deps.startSession(vscode.Uri.file(f.target), vscode.Uri.file(f.incoming), null, {
    // the result written into the target is not a new paste
    onApplied: () => guard(recordBaseline)()
  });
}

async function toggle(key, label) {
  const c = vscode.workspace.getConfiguration('cmr');
  const next = !c.get(key, key === 'quickMerge.enabled');
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update(key, next, target);
  if (key === 'quickMerge.auto' && next) await recordBaseline();   // only pastes from now on count
  vscode.window.setStatusBarMessage(label + (next ? ' is on' : ' is off'), 3000);
  if (key === 'quickMerge.enabled' && !next) {
    vscode.window.showInformationMessage('The merge conflict files button is hidden. Turn it back on with "Copado: Show/Hide the Merge Conflict Files Button" or in settings.');
  }
}

function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (deps && deps.output) deps.output.appendLine('Error: ' + msg);
      vscode.window.showErrorMessage(msg);
    }
  };
}

module.exports = { activate };
