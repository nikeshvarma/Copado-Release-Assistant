'use strict';

const vscode = require('vscode');
const path = require('path');
const X = require('./src/xmlParser');
const { findDuplicates, dedupeEdits } = require('./src/duplicates');
const formatter = require('./src/formatter');
const merger = require('./src/merge');
const { Worker } = require('worker_threads');
const { runMergeJob } = require('./src/mergeJob');
const { projectFolder, findProjectRoot } = require('./src/paths');
const { redact } = require('./src/redact');
const masked = text => redact(text, vscode.workspace.getConfiguration('cmr').get('output.maskIdentities', false));
const fsSync = require('fs');
const rules = require('./src/rules');
const treeView = require('./treeView');

const NAMESPACE = 'http://soap.sforce.com/2006/04/metadata';
const META_EXT = new Set([
  '.object', '.field', '.profile', '.permissionset', '.permissionsetgroup', '.layout', '.labels',
  '.workflow', '.app', '.flow', '.flexipage', '.tab', '.site', '.objectTranslation', '.translation',
  '.sharingRules', '.quickAction', '.recordType', '.listView', '.validationRule', '.webLink',
  '.compactLayout', '.fieldSet', '.md', '.matchingRule', '.assignmentRules', '.reportType', '.report',
  '.dashboard', '.globalValueSet', '.standardValueSet', '.customPermission', '.network', '.connectedApp'
]);
const MARKER = /^(<{7}|={7}$|>{7}|\|{7})/;

let ctx;
let diagnostics;
let output;
let lensEmitter;
let decorations;
let tree;
let treeUi;
let session = null;        // the merge in progress
let starting = false;      // a merge is being prepared
let sessionSeq = 0;
let pendingTarget = null;  // file marked with "Use as Target"
const findingsByDoc = new Map();

function activate(context) {
  ctx = context;
  diagnostics = vscode.languages.createDiagnosticCollection('copadoMerge');
  output = vscode.window.createOutputChannel('Copado Release Assistant');
  // tokens are always masked before anything reaches the panel; identities when cmr.output.maskIdentities is on
  { const line = output.appendLine.bind(output), part = output.append.bind(output);
    output.appendLine = t => line(masked(t)); output.append = t => part(masked(t)); }
  lensEmitter = new vscode.EventEmitter();
  decorations = {
    added: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('merge.incomingContentBackground'),
      overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    }),
    conflict: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('inputValidation.warningBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    }),
    dedup: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconSize: 'contain'
    })
  };
  context.subscriptions.push(diagnostics, output,
    decorations.added, decorations.conflict, decorations.dedup);

  const debounce = new Map();
  const schedule = (doc, delay) => {
    const key = doc.uri.toString();
    clearTimeout(debounce.get(key));
    debounce.set(key, setTimeout(() => refresh(doc), delay || 300));
  };
  // Large files are checked once typing settles rather than on every keystroke.
  const scheduleOnEdit = doc => {
    // size without copying the text: offset of the end of the document
    const kb = doc.offsetAt(new vscode.Position(doc.lineCount, 0)) / 1024;
    const limit = cfg().largeFileKb;
    if (limit > 0 && kb > limit) schedule(doc, 2500);
    else schedule(doc, 300);
  };

  context.subscriptions.push(
    // files the merge opens behind the scenes are never analysed - only what is on screen or edited
    vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(e => scheduleOnEdit(e.document))),
    vscode.workspace.onDidChangeTextDocument(e => {
      scheduleOnEdit(e.document);
      if (session && e.document.uri.toString() === session.mergedUri.toString()) {
        shiftMarks(e.contentChanges);
        schedulePaint();
        scheduleChecks();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(doc => refresh(doc)),
    vscode.workspace.onDidCloseTextDocument(doc => {
      diagnostics.delete(doc.uri);
      findingsByDoc.delete(doc.uri.toString());
    }),
    vscode.window.onDidChangeVisibleTextEditors(paint),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cmr')) vscode.window.visibleTextEditors.forEach(ed => scheduleOnEdit(ed.document));
    })
  );
  vscode.window.visibleTextEditors.forEach(ed => scheduleOnEdit(ed.document));

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('cmr.resolve', cmdResolve);
  cmd('cmr.useAsTarget', cmdUseAsTarget);
  cmd('cmr.mergeIntoTarget', cmdMergeIntoTarget);
  cmd('cmr.compare', cmdCompare);
  cmd('cmr.applyMerge', cmdApplyMerge);
  cmd('cmr.cancelMerge', cmdCancelMerge);
  cmd('cmr.showTargetVsMerged', () => showDiff('target'));
  cmd('cmr.showIncomingVsMerged', () => showDiff('incoming'));
  cmd('cmr.showTargetVsIncoming', () => showDiff('sides'));
  cmd('cmr.listConflicts', cmdListConflicts);
  cmd('cmr.nextConflict', () => jumpConflict(1));
  cmd('cmr.prevConflict', () => jumpConflict(-1));
  cmd('cmr.useTargetValue', i => setConflict(i, 'base'));
  cmd('cmr.useIncomingValue', i => setConflict(i, 'incoming'));
  cmd('cmr.useAllTarget', () => setAllConflicts('base'));
  cmd('cmr.useAllIncoming', () => setAllConflicts('incoming'));
  cmd('cmr.checkDuplicates', cmdCheckDuplicates);
  cmd('cmr.removeDuplicates', cmdRemoveDuplicates);
  cmd('cmr.format', cmdFormat);
  cmd('cmr.showOrder', cmdShowOrder);
  cmd('cmr.revealConflict', arg => revealConflict(conflictIndexOf(arg)));
  cmd('cmr.revealLine', line => revealLine(line));
  cmd('cmr.showReport', () => output.show(true));
  cmd('cmr.copyReport', cmdCopyReport);
  cmd('cmr.swapDirection', cmdSwapDirection);
  cmd('cmr.sectionUseTarget', item => setSection(item, 'base'));
  cmd('cmr.sectionUseIncoming', item => setSection(item, 'incoming'));
  cmd('cmr.refreshPanel', () => { scheduleChecks(); tree.refresh(); });
  cmd('cmr.dropEntry', item => dropEntry(item));
  cmd('cmr.writeWorkspaceSettings', cmdWriteWorkspaceSettings);
  cmd('cmr.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nikeshvarma.copado-release-assistant'));

  require('./release').activate(context, {
    output,
    startSession,
    writeTemp,
    storageDir,
    resolveProject,
    isMetadata,
    promoMerge
  });
  require('./quickMerge').activate(context, { output, startSession, resolveProject });

  tree = treeView.createProvider(() => session);
  treeUi = vscode.window.createTreeView('cmrMergePanel', { treeDataProvider: tree, showCollapseAll: true });
  treeUi.message = 'No merge in progress. Right-click the file to keep everything from and choose "Use as Target".';
  context.subscriptions.push(treeUi);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'xml' }, { pattern: '**/*.xml' }],
      { onDidChangeCodeLenses: lensEmitter.event, provideCodeLenses: mergeLenses }
    ),
    vscode.languages.registerHoverProvider([{ language: 'xml' }, { pattern: '**/*.xml' }], { provideHover: mergeHover }),
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'xml' }, { pattern: '**/*.xml' }],
      new DuplicateActions(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      [{ language: 'xml' }, { pattern: '**/*.xml' }],
      { provideDocumentFormattingEdits: doc => (isMetadata(doc) ? formatEdits(doc) : []) }
    )
  );
}

function deactivate() {
  vscode.commands.executeCommand('setContext', 'cmr.activeMerge', false);
}

/* ---------- settings and detection ---------- */

function cfg() {
  const c = vscode.workspace.getConfiguration('cmr');
  return {
    enable: c.get('diagnostics.enable', true),
    severity: c.get('diagnostics.duplicateSeverity', 'error'),
    warnSingletons: c.get('diagnostics.warnRepeatedSingletons', true),
    reportParseErrors: c.get('diagnostics.reportParseErrors', true),
    indent: c.get('format.indent', 4),
    elementOrder: c.get('format.elementOrder', 'standard'),
    sortCollections: c.get('format.sortCollections', true),
    typeOrder: c.get('format.typeOrder', {}),
    leadingElements: c.get('format.leadingElements', {}),
    removeDuplicatesOnFormat: c.get('format.removeDuplicatesOnFormat', false),
    keep: c.get('dedupe.keep', 'first'),
    mergeRemoveDuplicates: c.get('merge.removeDuplicates', true),
    normalizeBeforeDiff: c.get('merge.normalizeBeforeDiff', true),
    mergeApplyFormatting: c.get('merge.applyFormatting', true),
    conflictWinner: c.get('merge.conflictWinner', 'incoming'),
    alwaysKeepTarget: c.get('merge.alwaysKeepTarget', []),
    maxInlineConflicts: c.get('merge.maxInlineConflicts', 50),
    rulesEnable: c.get('rules.enable', true),
    rulesDisabled: c.get('rules.disabled', []),
    largeFileKb: c.get('diagnostics.largeFileKb', 256)
  };
}

function isMetadata(doc) {
  if (doc.uri.scheme === 'git' || doc.uri.scheme === 'output') return false;
  const name = doc.fileName || '';
  if (!/\.xml$/i.test(name) && doc.languageId !== 'xml') return false;
  if (/-meta\.xml$/i.test(name) || /package\.xml$/i.test(name)) return true;
  const base = name.replace(/-meta\.xml$/i, '');
  if (META_EXT.has(path.extname(base))) return true;
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 6), 0));
  return head.indexOf(NAMESPACE) !== -1;
}

/** Left-hand panes and git versions in the working folder - read-only references, not linted. */
function isReferenceCopy(doc) {
  if (!ctx) return false;
  const name = path.basename(doc.uri.fsPath);
  if (!/^(TARGET__|INCOMING__|GIT_TARGET__|GIT_INCOMING__|GIT_ANCESTOR__|A__|B__)/.test(name)) return false;
  const p = doc.uri.fsPath;
  return p.indexOf(storageRoot().fsPath) === 0 || (ctx.globalStorageUri && p.indexOf(ctx.globalStorageUri.fsPath) === 0);
}

function hasMarkers(text) {
  return text.split(/\r?\n/).some(l => MARKER.test(l));
}

/** Formatting for merge output: the merge-only switch can turn ordering off entirely. */
function mergeFormatOptions(c, eol, extra) {
  if (c.mergeApplyFormatting) return formatOptions(c, eol, extra);
  return Object.assign(formatOptions(c, eol, extra), {
    elementOrder: 'preserve', sortCollections: false, typeOrder: {}, leadingElements: {}
  });
}

function formatOptions(c, eol, extra) {
  return Object.assign({
    indent: c.indent,
    eol: eol || '\n',
    elementOrder: c.elementOrder,
    sortCollections: c.sortCollections,
    typeOrder: c.typeOrder,
    leadingElements: c.leadingElements
  }, extra || {});
}

/* ---------- duplicate diagnostics ---------- */

function refresh(doc) {
  const c = cfg();
  if (!c.enable || !isMetadata(doc) || isReferenceCopy(doc)) { diagnostics.delete(doc.uri); return; }
  const text = doc.getText();
  const list = [];

  if (hasMarkers(text)) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (MARKER.test(line)) {
        const d = new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length),
          'Conflict marker. Copado Merge Resolver works on two whole files - take the two versions from Copado and run "Copado Merge: Resolve Metadata Conflict" instead of editing markers.',
          vscode.DiagnosticSeverity.Warning);
        d.source = 'copadoMerge';
        list.push(d);
      }
    });
    diagnostics.set(doc.uri, list);
    findingsByDoc.delete(doc.uri.toString());
    return;
  }

  const parsed = X.parse(text);
  if (!parsed.root) { diagnostics.set(doc.uri, list); return; }

  if (c.reportParseErrors) {
    for (const e of parsed.errors) {
      const d = new vscode.Diagnostic(
        new vscode.Range(doc.positionAt(e.offset), doc.positionAt(e.offset + (e.length || 1))),
        e.message, vscode.DiagnosticSeverity.Error);
      d.source = 'copadoMerge';
      list.push(d);
    }
  }

  const findings = findDuplicates(parsed, { warnRepeatedSingletons: c.warnSingletons });
  findingsByDoc.set(doc.uri.toString(), { findings, parsed });

  if (c.rulesEnable) {
    for (const v of rules.check(parsed, { disabled: c.rulesDisabled })) {
      const d = new vscode.Diagnostic(
        new vscode.Range(doc.positionAt(v.node.start), doc.positionAt(v.node.openTagEnd || v.node.start + 1)),
        v.message,
        v.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'copadoMerge';
      d.code = v.id;
      list.push(d);
    }
  }

  for (const f of findings) {
    const range = new vscode.Range(doc.positionAt(f.node.start), doc.positionAt(f.node.openTagEnd));
    const d = new vscode.Diagnostic(range, f.message, severityOf(f, c.severity));
    d.source = 'copadoMerge';
    d.code = f.kind;
    d.relatedInformation = [new vscode.DiagnosticRelatedInformation(
      new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(f.first.start), doc.positionAt(f.first.openTagEnd))),
      'First occurrence')];
    list.push(d);
  }
  diagnostics.set(doc.uri, list);
}

function severityOf(finding, configured) {
  if (finding.kind === 'duplicate-key' && !finding.identical) return vscode.DiagnosticSeverity.Error;
  return configured === 'warning' ? vscode.DiagnosticSeverity.Warning
    : configured === 'information' ? vscode.DiagnosticSeverity.Information
      : vscode.DiagnosticSeverity.Error;
}

class DuplicateActions {
  provideCodeActions(doc, range, context) {
    const entry = findingsByDoc.get(doc.uri.toString());
    if (!entry) return [];
    const hits = context.diagnostics.filter(d => d.source === 'copadoMerge' && String(d.code).startsWith('duplicate'));
    if (!hits.length) return [];
    const actions = [];
    for (const d of hits) {
      const offset = doc.offsetAt(d.range.start);
      const f = entry.findings.find(x => x.node.start === offset);
      if (!f) continue;
      actions.push(removal(doc, f.node, 'Remove this duplicate <' + f.tag + '>', d));
      actions.push(removal(doc, f.first, 'Remove the earlier <' + f.tag + '> and keep this one', d));
    }
    const all = new vscode.CodeAction('Remove all duplicates in this file', vscode.CodeActionKind.QuickFix);
    all.command = { command: 'cmr.removeDuplicates', title: 'Remove all duplicates' };
    actions.push(all);
    return actions;
  }
}

function removal(doc, node, title, diagnostic) {
  const src = doc.getText();
  let start = node.start;
  const lineStart = src.lastIndexOf('\n', start - 1) + 1;
  if (src.slice(lineStart, start).trim() === '') start = lineStart;
  let end = node.end;
  const m = src.slice(end).match(/^[ \t]*\r?\n/);
  if (m) end += m[0].length;
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.edit = new vscode.WorkspaceEdit();
  action.edit.delete(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)));
  return action;
}

/* ---------- the merge session ---------- */

async function cmdResolve(uri) {
  let target = uri || activeUri();
  if (!target) {
    target = await pickFile(null, 'Step 1 of 2 - pick the file to KEEP EVERYTHING from (your target)');
    if (!target) return;
  }
  const incoming = await pickFile(target, 'Step 2 - pick the file to merge IN (wins a real conflict)');
  if (!incoming) return;

  await startSession(target, incoming, null);
}

function cmdUseAsTarget(uri) {
  pendingTarget = uri || activeUri();
  if (pendingTarget) {
    vscode.window.setStatusBarMessage(
      'Target: ' + path.basename(pendingTarget.fsPath) + ' - nothing will be removed from it', 5000);
  }
}

async function cmdMergeIntoTarget(uri) {
  const incoming = uri || activeUri();
  if (!pendingTarget) {
    vscode.window.showWarningMessage('First right-click the file to keep everything from and choose "Use as Target".');
    return;
  }
  if (!incoming || incoming.toString() === pendingTarget.toString()) {
    vscode.window.showWarningMessage('Pick a different file to merge in.');
    return;
  }
  await startSession(pendingTarget, incoming);
}

/**
 * Starts a merge. The heavy work - parsing, merging, formatting, checking -
 * runs in a worker thread, so VS Code stays responsive and the merge can be
 * cancelled. Only one merge is prepared at a time, the previous one is ended
 * first, and each session writes to its own folder, so an old merged tab can
 * never stand in for the new one.
 */
async function startSession(targetUri, incomingUri, ancestorUri, sessionOptions) {
  if (starting) {
    vscode.window.showInformationMessage('A merge is already being prepared - wait for it, or cancel it from its notification.');
    return;
  }
  starting = true;
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Merging ' + path.basename(targetUri.fsPath), cancellable: true
    }, (progress, token) => prepareSession(targetUri, incomingUri, ancestorUri, sessionOptions || {}, progress, token));
  } catch (e) {
    if (session && !session.ready) await endSession();   // never leave a half-built session behind
    throw e;
  } finally {
    starting = false;
  }
}

async function prepareSession(targetUri, incomingUri, ancestorUri, so, progress, token) {
  const c = cfg();
  const t0 = Date.now();
  const timing = {};
  progress.report({ message: 'reading the files' });
  const targetDoc = await vscode.workspace.openTextDocument(targetUri);
  const incomingDoc = await vscode.workspace.openTextDocument(incomingUri);
  let ancestorDoc = null;
  if (ancestorUri && ancestorUri.toString() !== targetUri.toString() &&
    ancestorUri.toString() !== incomingUri.toString()) {
    try { ancestorDoc = await vscode.workspace.openTextDocument(ancestorUri); } catch (e) { ancestorDoc = null; }
  }
  for (const doc of [targetDoc, incomingDoc, ancestorDoc].filter(Boolean)) {
    if (hasMarkers(doc.getText())) {
      vscode.window.showErrorMessage(path.basename(doc.fileName) + ' contains conflict markers. Use the two clean versions from Copado.');
      return;
    }
  }
  timing.read = Date.now() - t0;

  // the previous merge ends first: its tabs close and its files can never be mistaken for this one
  if (session) await endSession();
  if (token.isCancellationRequested) return;

  const lines = Math.max(targetDoc.lineCount, incomingDoc.lineCount);
  progress.report({ message: 'merging ' + lines.toLocaleString() + ' lines' });
  const eol = targetDoc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const e0 = Date.now();
  const result = await runEngine({
    targetText: targetDoc.getText(),
    incomingText: incomingDoc.getText(),
    ancestorText: ancestorDoc ? ancestorDoc.getText() : null,
    merge: { dedupe: c.mergeRemoveDuplicates, keep: c.keep, keepTarget: c.alwaysKeepTarget, winner: c.conflictWinner === 'target' ? 'target' : 'incoming' },
    format: mergeFormatOptions(c, eol),
    normalize: c.normalizeBeforeDiff,
    rules: { enable: c.rulesEnable, disabled: c.rulesDisabled }
  }, token);
  timing.engine = Date.now() - e0;
  if (token.isCancellationRequested || !result) { output.appendLine('merge cancelled'); return; }
  if (!result.ok) { vscode.window.showErrorMessage(result.error); return; }
  if (result.warning) vscode.window.showWarningMessage(result.warning);

  progress.report({ message: 'writing the merge views' });
  const w0 = Date.now();
  const dir = await sessionDir();
  const write = async (name, text) => {
    const uri = vscode.Uri.joinPath(dir, name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    return uri;
  };
  const base = path.basename(targetUri.fsPath);
  const marks = result.marks;
  // the files are written before the session is published, so nothing ever sees a session without them
  const normTargetUri = await write('TARGET__' + base, result.targetText);
  const normIncomingUri = await write('INCOMING__' + base, result.incomingText);
  const mergedUri = await write('MERGED__' + base, result.mergedText);
  timing.write = Date.now() - w0;
  if (token.isCancellationRequested) return;
  session = {
    normTargetUri, normIncomingUri, mergedUri,
    ready: false,
    typeName: result.typeName,
    threeWay: result.threeWay,
    targetUri,
    incomingUri,
    ancestorUri: result.threeWay ? ancestorUri : null,
    applyToUri: so.applyToUri || targetUri,
    labels: {
      target: (so.labels && so.labels.target) || path.basename(targetUri.fsPath),
      incoming: (so.labels && so.labels.incoming) || path.basename(incomingUri.fsPath),
      ancestor: (so.labels && so.labels.ancestor) || (ancestorUri ? path.basename(ancestorUri.fsPath) : '')
    },
    onApplied: so.onApplied || null,
    report: result.report,
    marks,
    conflicts: marks.filter(m => m.mark.kind === 'conflict').map(m => Object.assign({}, m.mark.conflict, {
      line: m.startLine,
      resolved: c.conflictWinner === 'target' ? 'base' : 'incoming',
      reviewed: false
    })),
    checks: result.checks
  };
  session.conflicts.sort((a, b) => a.line - b.line);

  writeReport();
  tree.refresh();
  updateBadge();
  await vscode.commands.executeCommand('setContext', 'cmr.activeMerge', true);
  progress.report({ message: 'opening the diff' });
  const d0 = Date.now();
  await showDiff('target');
  timing.diff = Date.now() - d0;
  session.ready = true;
  lensEmitter.fire();
  output.appendLine(timingLine(base, result, timing, Date.now() - t0));

  if (session.conflicts.length > c.maxInlineConflicts) {
    vscode.window.showInformationMessage(
      session.conflicts.length + ' conflicting values - too many for inline buttons. Use the Copado Merge panel in the side bar.',
      'Open panel').then(pick => { if (pick === 'Open panel') vscode.commands.executeCommand('cmrMergePanel.focus'); });
  }
  const r = result.report;
  if (!r.added.length && !r.updated.length && !r.conflicts.length && !r.duplicates.length) {
    vscode.window.showInformationMessage('These two files already describe the same metadata. Nothing to merge.');
  }
}

/** "merge X · 49,167 lines · 3.2s: read 0.2s · engine 1.4s (parse 0.4s, merge 0.1s, ...) · views 0.1s · diff 1.4s" */
function timingLine(name, result, t, total) {
  const s = ms => ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  const parts = Object.entries(result.timings || {}).map(([k, v]) => k + ' ' + s(v)).join(', ');
  return 'merge ' + name + ' \u00b7 ' + (result.lines || 0).toLocaleString() + ' lines \u00b7 ' + s(total) + ': read ' + s(t.read) +
    ' \u00b7 engine ' + s(t.engine) + (parts ? ' (' + parts + ')' : '') + ' \u00b7 views ' + s(t.write) + ' \u00b7 diff ' + s(t.diff);
}

/**
 * Runs the merge job in a worker thread, so the extension host stays free.
 * Cancelling stops the worker. If a worker cannot be started, the same job
 * runs in the main thread instead.
 */
function runEngine(job, token) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const inProcess = why => {
      output.appendLine('merge running in the main thread (' + why + ')');
      try { finish(runMergeJob(job)); } catch (e) { finish({ ok: false, error: 'The merge failed: ' + e.message }); }
    };
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'src', 'mergeWorker.js'), { workerData: job });
    } catch (e) { inProcess(e.message); return; }
    const sub = token.onCancellationRequested(() => { worker.terminate(); finish(null); });
    worker.once('message', m => { sub.dispose(); finish(m); worker.terminate(); });
    worker.once('error', e => { sub.dispose(); if (!done) inProcess('worker failed: ' + e.message); });
    worker.once('exit', code => { sub.dispose(); if (!done) finish({ ok: false, error: 'The merge stopped unexpectedly (exit code ' + code + ').' }); });
  });
}

/** A merge of two sides of a promotion conflict, for the automatic pass - in the background thread. */
async function promoMerge(ours, theirs, base) {
  const c = cfg();
  const eol = /\r\n/.test(ours) ? '\r\n' : '\n';
  const r = await runEngine({
    targetText: ours, incomingText: theirs, ancestorText: base || null,
    merge: { dedupe: c.mergeRemoveDuplicates, keep: c.keep, keepTarget: c.alwaysKeepTarget, winner: c.conflictWinner === 'target' ? 'target' : 'incoming' },
    format: mergeFormatOptions(c, eol), normalize: false, rules: { enable: false }
  }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  return r && r.ok ? { ok: true, mergedText: r.mergedText, conflicts: r.report.conflicts.length } : { ok: false, error: r ? r.error : 'cancelled' };
}

/** A fresh folder for this session's views; earlier sessions' folders are removed. */
async function sessionDir() {
  const root = await storageDir('merge');
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
      if (type === vscode.FileType.Directory && /^s-/.test(name)) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, name), { recursive: true, useTrash: false });
      }
    }
  } catch (e) { /* nothing to clean */ }
  const dir = vscode.Uri.joinPath(root, 's-' + Date.now().toString(36) + '-' + (++sessionSeq));
  await vscode.workspace.fs.createDirectory(dir);
  return dir;
}

/**
 * Writes a working copy (a branch version, a compare side) to its own new
 * folder. A fixed path could already be open in a tab, and VS Code would then
 * hand back that old in-memory copy instead of the new content. Only the most
 * recent folders are kept.
 */
async function writeTemp(name, content) {
  const root = await storageDir('merge');
  const dir = vscode.Uri.joinPath(root, 't-' + Date.now().toString(36) + '-' + (++sessionSeq));
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(dir, name);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  pruneTemp(root, 12).catch(() => { /* best effort */ });
  return uri;
}

async function pruneTemp(root, keep) {
  const inUse = new Set(session ? [session.targetUri, session.incomingUri, session.ancestorUri].filter(Boolean).map(u => path.dirname(u.fsPath)) : []);
  const olds = (await vscode.workspace.fs.readDirectory(root))
    .filter(([n, t]) => t === vscode.FileType.Directory && /^t-/.test(n)).map(([n]) => n)
    .sort((x, y) => parseInt(x.slice(2), 36) - parseInt(y.slice(2), 36));
  for (const n of olds.slice(0, Math.max(0, olds.length - keep))) {
    const u = vscode.Uri.joinPath(root, n);
    if (!inUse.has(u.fsPath)) await vscode.workspace.fs.delete(u, { recursive: true, useTrash: false });
  }
}

/**
 * The extension's working folder, inside the open project (cmr.storage.folder,
 * ".copado" by default) - never inside a package directory such as force-app.
 * It holds a .gitignore of "*", so nothing in it is ever committed and the
 * project's own .gitignore is left alone. With no folder open it falls back
 * to the extension's private storage.
 */
function storageRoot() {
  const project = resolveProject();
  const base = project.root || project.fallback;
  if (!base) return ctx.globalStorageUri;
  const rel = projectFolder(vscode.workspace.getConfiguration('cmr').get('storage.folder', '.copado'), '.copado', readProjectJson(base));
  return vscode.Uri.joinPath(vscode.Uri.file(base), ...rel.split('/'));
}

/**
 * The Salesforce project the extension works in: cmr.project.path if set,
 * otherwise the project of the open file, the open folder, or the single
 * project found inside it. "fallback" is the first open folder, for the
 * features that do not need a Salesforce project.
 */
function resolveProject() {
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  const editor = vscode.window.activeTextEditor;
  const activeFile = editor && editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : null;
  const found = findProjectRoot({
    configured: vscode.workspace.getConfiguration('cmr').get('project.path', ''),
    folders,
    activeFile
  });
  return Object.assign({ fallback: folders[0] || null }, found);
}

function readProjectJson(root) {
  try { return fsSync.readFileSync(path.join(root, 'sfdx-project.json'), 'utf8'); } catch (e) { return ''; }
}

async function storageDir(sub) {
  const root = storageRoot();
  await vscode.workspace.fs.createDirectory(root);
  const ignore = vscode.Uri.joinPath(root, '.gitignore');
  try { await vscode.workspace.fs.stat(ignore); } catch (e) {
    await vscode.workspace.fs.writeFile(ignore, Buffer.from('# Copado Release Assistant working files - never committed\n*\n', 'utf8'));
  }
  if (!sub) return root;
  const dir = vscode.Uri.joinPath(root, sub);
  await vscode.workspace.fs.createDirectory(dir);
  return dir;
}

async function showDiff(which) {
  if (!session) { vscode.window.showInformationMessage('No merge in progress.'); return; }
  const tName = session.labels.target;
  const iName = session.labels.incoming;
  const views = {
    target: [session.normTargetUri, session.mergedUri, tName + ' (target) \u2194 MERGED (editable)'],
    incoming: [session.normIncomingUri, session.mergedUri, iName + ' (incoming) \u2194 MERGED (editable)'],
    sides: [session.normTargetUri, session.normIncomingUri, tName + ' \u2194 ' + iName + ' (both normalised)']
  };
  const v = views[which] || views.target;
  await vscode.commands.executeCommand('vscode.diff', v[0], v[1], v[2], { preview: false });
  paint();
}

/** Keeps mark line numbers correct when the user edits the merged file by hand. */
function shiftMarks(changes) {
  for (const ch of changes) {
    const removed = ch.range.end.line - ch.range.start.line;
    const addedLines = (ch.text.match(/\n/g) || []).length;
    const delta = addedLines - removed;
    if (!delta) continue;
    const pivot = ch.range.end.line;
    for (const m of session.marks) {
      if (m.startLine > pivot) { m.startLine += delta; m.endLine += delta; }
    }
    for (const c of session.conflicts) {
      if (c.line > pivot) c.line += delta;
    }
  }
}

let paintTimer;
function schedulePaint() {
  clearTimeout(paintTimer);
  paintTimer = setTimeout(() => { paint(); lensEmitter.fire(); }, 120);
}

/**
 * Highlights the merged file. Ranges only - the explanation for a highlight is
 * built when you hover it (see mergeHover), not up front for every entry, which
 * matters on files with thousands of changes.
 */
function paint() {
  if (!session) return;
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() !== session.mergedUri.toString()) continue;
    const added = [];
    const conflict = [];
    const dedup = [];
    const max = editor.document.lineCount - 1;
    for (const m of session.marks) {
      if (m.startLine > max) continue;
      const range = new vscode.Range(m.startLine, 0, Math.min(m.endLine, max), 0);
      const k = m.mark.kind;
      if (k === 'added' || k === 'auto') added.push(range);
      else if (k === 'dedup' || k === 'deleted') dedup.push(range);
      else if (k === 'conflict') conflict.push(range);
    }
    editor.setDecorations(decorations.added, added);
    editor.setDecorations(decorations.conflict, conflict);
    editor.setDecorations(decorations.dedup, dedup);
  }
}

/** The explanation for whatever highlight is under the cursor. */
function mergeHover(doc, position) {
  if (!session || doc.uri.toString() !== session.mergedUri.toString()) return null;
  const line = position.line;
  const m = session.marks.find(x => line >= x.startLine && line <= x.endLine);
  if (!m) return null;
  const k = m.mark.kind;
  let text;
  if (k === 'added') text = 'Added from the incoming file: ' + m.mark.added.path + (m.mark.added.label ? ' [' + m.mark.added.label + ']' : '');
  else if (k === 'dedup') text = dedupHover(m.mark.dupes);
  else if (k === 'auto') text = 'Taken from the incoming file automatically - only that side had changed it (was "' + m.mark.auto.from + '").';
  else if (k === 'deleted') text = 'The incoming file deleted this. It is kept, because the target never loses anything - drop it from the merge panel if you want it gone.';
  else if (k === 'conflict') {
    const c = session.conflicts.find(x => x.line === m.startLine) || m.mark.conflict;
    text = new vscode.MarkdownString('**Both files set `' + c.tag + '`**\n\n- target: `' + c.base + '`\n- incoming: `' + c.incoming + '`\n\n' +
      'Currently using the **' + (c.resolved === 'base' ? 'target' : 'incoming') + '** value.');
  }
  return text ? new vscode.Hover(text, new vscode.Range(m.startLine, 0, m.endLine, 0)) : null;
}

function dedupHover(dupes) {
  const risky = dupes.filter(d => !d.identical).length;
  return dupes.length + ' duplicate ' + (dupes.length === 1 ? 'entry' : 'entries') + ' of this were removed' +
    (risky ? '. ' + risky + ' had the same key but different values - check this one.' : ' (identical copies).');
}

function mergeLenses(doc) {
  if (!session || doc.uri.toString() !== session.mergedUri.toString()) return [];
  const lenses = [];
  const r = session.report;
  const unreviewed = session.conflicts.filter(c => !c.reviewed).length;
  const top = new vscode.Range(0, 0, 0, 0);

  lenses.push(new vscode.CodeLens(top, {
    title: '$(check) Apply to ' + path.basename(session.applyToUri.fsPath),
    command: 'cmr.applyMerge'
  }));
  lenses.push(new vscode.CodeLens(top, {
    title: '$(diff) ' + r.added.length + ' added \u00b7 ' + r.duplicates.length + ' duplicates removed \u00b7 ' +
      session.conflicts.length + ' conflicts' + (unreviewed ? ' (' + unreviewed + ' unreviewed)' : ''),
    command: 'cmr.listConflicts'
  }));
  if (session.conflicts.length) {
    lenses.push(new vscode.CodeLens(top, { title: 'Use all target values', command: 'cmr.useAllTarget' }));
    lenses.push(new vscode.CodeLens(top, { title: 'Use all incoming values', command: 'cmr.useAllIncoming' }));
  }
  lenses.push(new vscode.CodeLens(top, { title: '$(arrow-swap) Compare against incoming', command: 'cmr.showIncomingVsMerged' }));
  lenses.push(new vscode.CodeLens(top, { title: '$(x) Discard', command: 'cmr.cancelMerge' }));

  if (session.conflicts.length > cfg().maxInlineConflicts) {
    lenses.push(new vscode.CodeLens(top, {
      title: '$(list-tree) ' + session.conflicts.length + ' conflicts - resolve them in the side panel',
      command: 'cmrMergePanel.focus'
    }));
    return lenses;
  }

  session.conflicts.forEach((c, i) => {
    if (c.multiline || c.line == null || c.line >= doc.lineCount) return;
    if (doc.lineAt(c.line).text.indexOf('<' + c.tag + '>') === -1) return;
    const range = new vscode.Range(c.line, 0, c.line, 0);
    const usingTarget = c.resolved === 'base';
    lenses.push(new vscode.CodeLens(range, {
      title: '$(git-merge) conflict ' + (i + 1) + '/' + session.conflicts.length +
        ' \u00b7 using ' + (usingTarget ? 'target' : 'incoming') + ' "' + shorten(usingTarget ? c.base : c.incoming) + '"',
      command: 'cmr.listConflicts'
    }));
    lenses.push(new vscode.CodeLens(range, {
      title: usingTarget
        ? 'switch to incoming "' + shorten(c.incoming) + '"'
        : 'switch to target "' + shorten(c.base) + '"',
      command: usingTarget ? 'cmr.useIncomingValue' : 'cmr.useTargetValue',
      arguments: [i]
    }));
  });
  return lenses;
}

function shorten(v) {
  v = String(v == null ? '' : v);
  return v.length > 40 ? v.slice(0, 37) + '\u2026' : v;
}

function conflictIndexOf(arg) {
  if (typeof arg === 'number') return arg;
  if (arg && typeof arg.conflictIndex === 'number') return arg.conflictIndex;
  return -1;
}

async function setSection(item, side) {
  if (!session || !item || !item.entries) return;
  for (const e of item.entries) {
    if (typeof e.i === 'number') await setConflict(e.i, side);
  }
}

async function setConflict(index, side) {
  if (!session) return;
  index = conflictIndexOf(index);
  const c = session.conflicts[index];
  if (!c) return;
  const doc = await vscode.workspace.openTextDocument(session.mergedUri);
  if (c.line >= doc.lineCount || doc.lineAt(c.line).text.indexOf('<' + c.tag + '>') === -1) {
    vscode.window.showWarningMessage('That line has moved. Edit the value directly.');
    return;
  }
  const line = doc.lineAt(c.line);
  const indent = line.text.match(/^\s*/)[0];
  const value = side === 'base' ? c.base : c.incoming;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(session.mergedUri, line.range, indent + '<' + c.tag + '>' + escapeXml(value) + '</' + c.tag + '>');
  await vscode.workspace.applyEdit(edit);
  c.resolved = side;
  c.reviewed = true;
  lensEmitter.fire();
  paint();
  tree.refresh();
  updateBadge();
  scheduleChecks();
}

async function setAllConflicts(side) {
  if (!session) return;
  for (let i = 0; i < session.conflicts.length; i++) {
    if (session.conflicts[i].resolved !== side) await setConflict(i, side);
    else { session.conflicts[i].reviewed = true; }
  }
  lensEmitter.fire();
  tree.refresh();
  updateBadge();
}

/* ---------- deploy checks on the merged result ---------- */

let checkTimer;
function scheduleChecks() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    if (!session) return;
    try {
      const doc = await vscode.workspace.openTextDocument(session.mergedUri);
      session.checks = checksFor(doc.getText());
      tree.refresh();
    } catch (e) { /* document gone */ }
  }, 600);
}

function checksFor(text) {
  const c = cfg();
  if (!c.rulesEnable) return [];
  const parsed = X.parse(text);
  const starts = X.lineStarts(text);
  return rules.check(parsed, { disabled: c.rulesDisabled }).map(v => ({
    id: v.id,
    severity: v.severity,
    message: v.message,
    line: X.lineAt(starts, v.node.start)
  }));
}

function updateBadge() {
  if (!treeUi) return;
  const unreviewed = session ? session.conflicts.filter(c => !c.reviewed).length : 0;
  const errors = session ? (session.checks || []).filter(c => c.severity === 'error').length : 0;
  try {
    treeUi.badge = (unreviewed + errors)
      ? { value: unreviewed + errors, tooltip: unreviewed + ' conflicts to review, ' + errors + ' deploy errors' }
      : undefined;
  } catch (e) { /* older VS Code */ }
  treeUi.message = session ? undefined
    : 'No merge in progress. Right-click the file to keep everything from and choose "Use as Target".';
  treeUi.title = session
    ? 'Merge: ' + session.labels.target
    : 'Copado Merge';
}

async function revealLine(line) {
  if (!session || typeof line !== 'number') return;
  const doc = await vscode.workspace.openTextDocument(session.mergedUri);
  let editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === session.mergedUri.toString());
  if (!editor) {
    await showDiff('target');
    editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === session.mergedUri.toString());
  }
  if (!editor) editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(Math.max(0, Math.min(line, doc.lineCount - 1)), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/** Removes an entry from the merged result (used for incoming-side deletions). */
async function dropEntry(item) {
  if (!session || !item) return;
  const mark = (session.marks || []).find(m => m.mark === item.markRef || (item.entryRef && m.mark.deletion === item.entryRef));
  if (!mark) { vscode.window.showWarningMessage('That entry has already moved or been removed.'); return; }
  const doc = await vscode.workspace.openTextDocument(session.mergedUri);
  const last = Math.min(mark.endLine, doc.lineCount - 1);
  const start = new vscode.Position(Math.max(0, mark.startLine), 0);
  const end = last + 1 <= doc.lineCount - 1
    ? new vscode.Position(last + 1, 0)
    : doc.lineAt(last).range.end;
  const edit = new vscode.WorkspaceEdit();
  edit.delete(session.mergedUri, new vscode.Range(start, end));
  await vscode.workspace.applyEdit(edit);
  session.marks = session.marks.filter(m => m !== mark);
  session.report.deletions = session.report.deletions.filter(d => d !== mark.mark.deletion);
  tree.refresh();
  paint();
  scheduleChecks();
}

/* ---------- workspace settings ---------- */

async function cmdWriteWorkspaceSettings() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) { vscode.window.showWarningMessage('Open the repo folder first.'); return; }
  const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json');

  const recommended = {
    'cmr.format.indent': 4,
    'cmr.format.elementOrder': 'standard',
    'cmr.format.sortCollections': true,
    'cmr.merge.removeDuplicates': true,
    'cmr.merge.normalizeBeforeDiff': true,
    'cmr.merge.alwaysKeepTarget': ['loginIpRanges', 'loginHours'],
    'cmr.rules.enable': true,
    'cmr.format.leadingElements': {
      PermissionSet: ['label', 'description', 'hasActivationRequired', 'license', 'userLicense'],
      Profile: ['custom', 'description', 'userLicense']
    },
    '[xml]': { 'editor.defaultFormatter': 'nikeshvarma.copado-release-assistant' },
    'cmr.package.outputFolder': 'manifest',
    'cmr.storage.folder': '.copado',
    'files.eol': '\n',
    'files.trimTrailingWhitespace': true,
    'files.insertFinalNewline': true
  };

  let existing = {};
  let raw = '';
  try {
    raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    existing = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch (e) { existing = {}; }

  const clashes = Object.keys(recommended).filter(k => existing[k] !== undefined &&
    JSON.stringify(existing[k]) !== JSON.stringify(recommended[k]));
  let overwrite = true;
  if (clashes.length) {
    const go = await vscode.window.showWarningMessage(
      clashes.length + ' of these settings are already set differently in this workspace (' + clashes.slice(0, 3).join(', ') +
      (clashes.length > 3 ? ', ...' : '') + ').',
      { modal: true }, 'Overwrite them', 'Keep what is there');
    if (!go) return;
    overwrite = go === 'Overwrite them';
  }

  const merged = Object.assign({}, existing);
  for (const [k, v] of Object.entries(recommended)) {
    if (merged[k] === undefined || overwrite) merged[k] = v;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(merged, null, 2) + '\n', 'utf8'));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    'Recommended settings written to .vscode/settings.json. Commit it so everyone formats metadata the same way - identical formatting is what stops most conflicts happening.');
}

/* ---------- report and direction ---------- */

async function cmdCopyReport() {
  if (!session) { vscode.window.showInformationMessage('No merge in progress.'); return; }
  await vscode.env.clipboard.writeText(masked(markdownReport()));
  vscode.window.showInformationMessage('Merge report copied as markdown.');
}

function markdownReport() {
  const r = session.report;
  const target = session.labels.target;
  const incoming = session.labels.incoming;
  const L = [];
  L.push('## Metadata merge - ' + session.typeName);
  L.push('');
  L.push('| | |');
  L.push('| --- | --- |');
  L.push('| Mode | ' + (session.threeWay ? 'three-way (ancestor used)' : 'two-way') + ' |');
  L.push('| Target (kept everything) | `' + target + '` |');
  L.push('| Incoming (won a real conflict) | `' + incoming + '` |');
  if (session.ancestorUri) L.push('| Ancestor | `' + vscode.workspace.asRelativePath(session.ancestorUri) + '` |');
  L.push('| Resolved | ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' |');
  L.push('| Entries added | ' + r.added.length + ' |');
  L.push('| Entries updated | ' + r.updated.length + ' |');
  L.push('| Duplicates removed | ' + r.duplicates.length + ' |');
  L.push('| Value conflicts | ' + session.conflicts.length + ' |');
  if (session.threeWay) {
    L.push('| Auto-resolved (only one side changed) | ' + r.auto.length + ' |');
    L.push('| Deleted in incoming, kept | ' + r.deletions.length + ' |');
    L.push('| Deleted in target, not restored | ' + r.skipped.length + ' |');
  }
  L.push('');

  if (session.conflicts.length) {
    L.push('### Conflicting values');
    L.push('');
    if (session.threeWay) {
      L.push('| Where | Was | Target | Incoming | Kept |');
      L.push('| --- | --- | --- | --- | --- |');
    } else {
      L.push('| Where | Target | Incoming | Kept |');
      L.push('| --- | --- | --- | --- |');
    }
    for (const c of session.conflicts) {
      L.push('| ' + md(c.path) + ' | ' + (c.ancestor !== undefined ? '`' + md(c.ancestor) + '` | ' : '') +
        '`' + md(c.base) + '` | `' + md(c.incoming) + '` | **' +
        (c.resolved === 'base' ? 'target' : 'incoming') + '** |');
    }
    L.push('');
  }
  if (session.threeWay && r.deletions.length) {
    L.push('### Deleted on the incoming side, kept in the result');
    L.push('');
    for (const d of r.deletions) L.push('- ' + md(d.path) + (d.label ? ' - `' + md(d.label) + '`' : ''));
    L.push('');
  }
  if (session.threeWay && r.skipped.length) {
    L.push('### Deleted on the target side, not brought back');
    L.push('');
    for (const sk of r.skipped) L.push('- ' + md(sk.path) + (sk.label ? ' - `' + md(sk.label) + '`' : ''));
    L.push('');
  }
  if (r.added.length) {
    L.push('### Added from the incoming file');
    L.push('');
    for (const a of r.added) L.push('- ' + md(a.path) + (a.label ? ' - `' + md(a.label) + '`' : '') + (a.review ? ' (appended, position reviewed)' : ''));
    L.push('');
  }
  if (r.duplicates.length) {
    L.push('### Duplicates removed');
    L.push('');
    for (const d of r.duplicates) {
      L.push('- ' + md(d.path) + (d.label ? ' - `' + md(d.label) + '`' : '') +
        (d.identical ? ' (identical copy)' : ' (same key, different values)'));
    }
    L.push('');
  }
  if (r.policy && r.policy.length) {
    L.push('### Kept from the target by policy');
    L.push('');
    for (const p of r.policy) L.push('- ' + md(p.path) + ' - kept ' + p.kept + ', ignored ' + p.ignored + ' incoming');
    L.push('');
  }
  const checks = session.checks || [];
  L.push('### Deploy checks on the merged result');
  L.push('');
  if (!checks.length) L.push('No structural problems found.');
  else for (const c of checks) L.push('- **' + c.severity + '**: ' + md(c.message) + ' (`' + c.id + '`)');
  L.push('');
  return L.join('\n');
}

function md(v) {
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function cmdSwapDirection() {
  if (!session) { vscode.window.showInformationMessage('No merge in progress.'); return; }
  const target = session.targetUri;
  const incoming = session.incomingUri;
  const ancestor = session.ancestorUri;
  // a branch merge applies to the working copy, not to either input - keep that
  const applyTo = session.applyToUri.toString() !== target.toString() ? session.applyToUri : null;
  const onApplied = session.onApplied;
  const go = await vscode.window.showWarningMessage(
    'Swap direction? ' + path.basename(incoming.fsPath) + ' becomes the file that keeps everything, and ' +
    path.basename(target.fsPath) + ' wins on overlap. Any edits you made to the merged file are discarded.',
    { modal: true }, 'Swap and re-merge');
  if (go !== 'Swap and re-merge') return;
  const labels = session.labels;
  await endSession();
  await startSession(incoming, target, ancestor, {
    applyToUri: applyTo || undefined,
    onApplied,
    labels: { target: labels.incoming, incoming: labels.target, ancestor: labels.ancestor }
  });
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function cmdListConflicts() {
  if (!session) { vscode.window.showInformationMessage('No merge in progress.'); return; }
  if (!session.conflicts.length) {
    vscode.window.showInformationMessage('No value conflicts. ' + session.report.added.length +
      ' entries were added and ' + session.report.duplicates.length + ' duplicates removed.');
    return;
  }
  const items = session.conflicts.map((c, i) => ({
    label: (c.reviewed ? '$(check) ' : '$(circle-outline) ') + c.tag,
    description: 'target "' + shorten(c.base) + '"  vs  incoming "' + shorten(c.incoming) + '"  \u2192 using ' + (c.resolved === 'base' ? 'target' : 'incoming'),
    detail: c.path,
    index: i
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Jump to a conflict in the merged file', matchOnDetail: true });
  if (!pick) return;
  await revealConflict(pick.index);
}

async function revealConflict(index) {
  const c = session.conflicts[index];
  const doc = await vscode.workspace.openTextDocument(session.mergedUri);
  let editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === session.mergedUri.toString());
  if (!editor) {
    await showDiff('target');
    editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === session.mergedUri.toString());
  }
  if (!editor) editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(Math.min(c.line, doc.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  session.cursor = index;
}

async function jumpConflict(step) {
  if (!session || !session.conflicts.length) return;
  const n = session.conflicts.length;
  const current = typeof session.cursor === 'number' ? session.cursor : (step > 0 ? -1 : 0);
  await revealConflict(((current + step) % n + n) % n);
}

function writeReport() {
  const r = session.report;
  output.clear();
  output.appendLine('Copado Merge Resolver - ' + session.typeName +
    (session.threeWay ? ' (three-way)' : ' (two-way)'));
  output.appendLine('');
  for (const line of merger.reportLines(r,
    session.labels.target,
    session.labels.incoming,
    session.ancestorUri ? vscode.workspace.asRelativePath(session.ancestorUri) : null)) {
    output.appendLine(line);
  }
  const checks = session.checks || [];
  if (checks.length) {
    output.appendLine('Deploy checks on the merged result:');
    for (const v of checks) output.appendLine('  ' + (v.severity === 'error' ? '!' : '?') + ' line ' + (v.line + 1) + '  ' + v.message);
    output.appendLine('');
  } else {
    output.appendLine('Deploy checks on the merged result: nothing found.');
    output.appendLine('');
  }
  output.appendLine('Review in the diff on screen. Nothing is written to the target until you apply.');
}

async function cmdApplyMerge() {
  if (!session) { vscode.window.showInformationMessage('No merge in progress.'); return; }
  const unreviewed = session.conflicts.filter(c => !c.reviewed).length;
  if (unreviewed) {
    const go = await vscode.window.showWarningMessage(
      unreviewed + ' conflict' + (unreviewed === 1 ? '' : 's') + ' still on the incoming value without being looked at. Apply anyway?',
      { modal: true }, 'Apply anyway', 'Review them');
    if (go === 'Review them') { await cmdListConflicts(); return; }
    if (go !== 'Apply anyway') return;
  }

  const mergedDoc = await vscode.workspace.openTextDocument(session.mergedUri);
  const text = mergedDoc.getText();
  const parsed = X.parse(text);
  if (parsed.errors.length) {
    const go = await vscode.window.showWarningMessage(
      'The merged file has ' + parsed.errors.length + ' XML problem(s) after your edits. Apply anyway?',
      { modal: true }, 'Apply anyway');
    if (go !== 'Apply anyway') return;
  }
  const violations = checksFor(text).filter(v => v.severity === 'error');
  if (violations.length) {
    const go = await vscode.window.showWarningMessage(
      violations.length + ' deploy check' + (violations.length === 1 ? '' : 's') + ' would fail on this result, e.g. "' +
      violations[0].message + '" Apply anyway?',
      { modal: true }, 'Apply anyway', 'Show them');
    if (go === 'Show them') { session.checks = checksFor(text); tree.refresh(); await vscode.commands.executeCommand('cmrMergePanel.focus'); return; }
    if (go !== 'Apply anyway') return;
  }

  const leftovers = findDuplicates(parsed, { warnRepeatedSingletons: true });
  if (leftovers.length) {
    const go = await vscode.window.showWarningMessage(
      leftovers.length + ' duplicate entr' + (leftovers.length === 1 ? 'y' : 'ies') + ' in the merged result. Apply anyway?',
      { modal: true }, 'Apply anyway', 'Show them');
    if (go === 'Show them') { await vscode.window.showTextDocument(mergedDoc); return; }
    if (go !== 'Apply anyway') return;
  }

  const targetDoc = await vscode.workspace.openTextDocument(session.applyToUri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(session.applyToUri, new vscode.Range(targetDoc.positionAt(0), targetDoc.positionAt(targetDoc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
  await targetDoc.save();

  const targetUri = session.applyToUri;
  const onApplied = session.onApplied;
  const name = path.basename(targetUri.fsPath);
  await endSession();
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(targetUri));
  if (onApplied) { try { onApplied(targetUri); } catch (e) { /* view refresh only */ } }
  vscode.window.showInformationMessage('Merged into ' + name + '. Commit it back to Copado when you are happy.');
}

async function cmdCancelMerge() {
  if (!session) return;
  await endSession();
  vscode.window.showInformationMessage('Merge discarded. Nothing was written.');
}

async function endSession() {
  const uris = session
    ? [session.mergedUri, session.normTargetUri, session.normIncomingUri]
      .filter(Boolean).map(u => u.toString())
    : [];
  session = null;
  pendingTarget = null;
  lensEmitter.fire();
  if (tree) tree.refresh();
  updateBadge();
  await vscode.commands.executeCommand('setContext', 'cmr.activeMerge', false);
  await closeTabs(uris);
}

/** Closes only the tabs this session opened. */
async function closeTabs(uris) {
  if (!vscode.window.tabGroups) return;
  const doomed = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input || {};
      const candidates = [input.uri, input.original, input.modified, input.base, input.input1, input.input2, input.result]
        .filter(Boolean)
        .map(u => (u.uri ? u.uri.toString() : u.toString()));
      if (candidates.some(u => uris.indexOf(u) !== -1)) doomed.push(tab);
    }
  }
  if (doomed.length) {
    try { await vscode.window.tabGroups.close(doomed, true); } catch (e) { /* tab already gone */ }
  }
}

/* ---------- compare without merging ---------- */

async function cmdCompare(uri) {
  const c = cfg();
  const left = uri || activeUri();
  if (!left) return;
  const right = await pickFile(left, 'Compare ' + path.basename(left.fsPath) + ' with...');
  if (!right) return;

  const docs = [];
  for (const u of [left, right]) {
    const doc = await vscode.workspace.openTextDocument(u);
    const parsed = X.parse(doc.getText());
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    docs.push({
      uri: u,
      text: parsed.root && c.normalizeBeforeDiff ? formatter.format(parsed, formatOptions(c, eol)) : doc.getText()
    });
  }
  const a = await writeTemp('A__' + path.basename(left.fsPath), docs[0].text);
  const b = await writeTemp('B__' + path.basename(right.fsPath), docs[1].text);
  await vscode.commands.executeCommand('vscode.diff', a, b,
    path.basename(left.fsPath) + ' \u2194 ' + path.basename(right.fsPath) + ' (normalised)', { preview: false });
}

/* ---------- housekeeping commands ---------- */

function activeUri() {
  const e = vscode.window.activeTextEditor;
  return e ? e.document.uri : null;
}

function activeMetadataDoc() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage('Open a Salesforce metadata XML file first.'); return null; }
  if (!isMetadata(editor.document)) {
    vscode.window.showWarningMessage('This file does not look like Salesforce metadata XML.');
    return null;
  }
  return editor.document;
}

async function pickFile(exclude, placeHolder) {
  const open = vscode.workspace.textDocuments
    .filter(d => d.uri.scheme === 'file' && /\.xml$/i.test(d.fileName))
    .map(d => d.uri);
  const found = await vscode.workspace.findFiles('**/*.xml', '**/{node_modules,.sfdx,.sf,.git}/**', 3000);
  const seen = new Set();
  const items = [];
  const push = (uri, group) => {
    const key = uri.toString();
    if (seen.has(key)) return;
    if (exclude && key === exclude.toString()) return;
    if (uri.fsPath.indexOf(path.join('globalStorage', '')) !== -1) return;
    seen.add(key);
    items.push({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri), uri, group });
  };
  for (const u of open) push(u, 'open');
  for (const u of found) push(u, 'workspace');
  if (!items.length) {
    const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { XML: ['xml'] } });
    return chosen && chosen.length ? chosen[0] : null;
  }
  items.unshift({ label: '$(folder-opened) Browse...', description: 'pick a file outside the workspace', browse: true });
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  if (!pick) return null;
  if (pick.browse) {
    const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { XML: ['xml'] } });
    return chosen && chosen.length ? chosen[0] : null;
  }
  return pick.uri;
}

async function cmdCheckDuplicates() {
  const doc = activeMetadataDoc();
  if (!doc) return;
  refresh(doc);
  const entry = findingsByDoc.get(doc.uri.toString());
  const n = entry ? entry.findings.length : 0;
  if (!n) { vscode.window.showInformationMessage('No duplicate metadata entries found.'); return; }
  const pick = await vscode.window.showWarningMessage(
    n + ' duplicate ' + (n === 1 ? 'entry' : 'entries') + ' in ' + path.basename(doc.fileName) + '.',
    'Show Problems', 'Remove Duplicates');
  if (pick === 'Show Problems') vscode.commands.executeCommand('workbench.actions.view.problems');
  if (pick === 'Remove Duplicates') cmdRemoveDuplicates();
}

async function cmdRemoveDuplicates() {
  const doc = activeMetadataDoc();
  if (!doc) return;
  const c = cfg();
  const parsed = X.parse(doc.getText());
  const findings = findDuplicates(parsed, { warnRepeatedSingletons: c.warnSingletons })
    .filter(f => f.kind !== 'duplicate-single');
  if (!findings.length) { vscode.window.showInformationMessage('No duplicate metadata entries to remove.'); return; }

  const risky = findings.filter(f => !f.identical);
  if (risky.length) {
    const go = await vscode.window.showWarningMessage(
      risky.length + ' of ' + findings.length + ' duplicates have the same key but different values. Keeping the ' +
      c.keep + ' occurrence will discard the other. Continue?', { modal: true }, 'Remove duplicates');
    if (go !== 'Remove duplicates') return;
  }
  const ranges = dedupeEdits(parsed, findings, c.keep);
  const edit = new vscode.WorkspaceEdit();
  for (const r of ranges) edit.delete(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)));
  await vscode.workspace.applyEdit(edit);
  vscode.window.showInformationMessage('Removed ' + findings.length + ' duplicate ' + (findings.length === 1 ? 'entry' : 'entries') + '.');
}

function formatEdits(doc) {
  const c = cfg();
  const parsed = X.parse(doc.getText());
  if (!parsed.root) return [];
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const text = formatter.format(parsed, formatOptions(c, eol, {
    removeDuplicates: c.removeDuplicatesOnFormat,
    keep: c.keep
  }));
  if (text === null || text === doc.getText()) return [];
  return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text)];
}

async function cmdFormat() {
  const doc = activeMetadataDoc();
  if (!doc) return;
  if (hasMarkers(doc.getText())) {
    vscode.window.showWarningMessage('This file has conflict markers in it. Use the two separate versions from Copado.');
    return;
  }
  const edits = formatEdits(doc);
  if (!edits.length) { vscode.window.showInformationMessage('Already in order.'); return; }
  const edit = new vscode.WorkspaceEdit();
  edit.set(doc.uri, edits);
  await vscode.workspace.applyEdit(edit);
}

async function cmdShowOrder() {
  const doc = activeMetadataDoc();
  if (!doc) return;
  const parsed = X.parse(doc.getText());
  if (!parsed.root) return;
  const typeName = parsed.root.name;
  const c = cfg();
  const formatted = formatter.format(parsed, formatOptions(c));
  const order = [];
  for (const child of X.elements(X.parse(formatted).root)) {
    if (order.indexOf(child.name) === -1) order.push(child.name);
  }
  const snippet = JSON.stringify({ 'cmr.format.typeOrder': { [typeName]: order } }, null, 2);
  output.clear();
  output.appendLine('Section order in effect for ' + typeName + ':');
  output.appendLine('');
  order.forEach((t, i) => output.appendLine('  ' + (i + 1) + '. ' + t));
  output.appendLine('');
  output.appendLine('Paste this into settings.json and reorder the list. Tags you leave out go to the end, alphabetically.');
  output.appendLine('');
  output.appendLine(snippet);
  output.show(true);
  const pick = await vscode.window.showInformationMessage(
    typeName + ' has ' + order.length + ' top-level sections. Order and settings snippet are in the output panel.',
    'Copy settings snippet');
  if (pick === 'Copy settings snippet') {
    await vscode.env.clipboard.writeText(masked(snippet));
    vscode.window.showInformationMessage('Snippet copied.');
  }
}

module.exports = { activate, deactivate };
