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
let session = null;        // the merge in progress
let extensionUri = null;   // where the extension's own files are: the merge editor's page loads from there
let starting = false;      // a merge is being prepared
let sessionSeq = 0;
const findingsByDoc = new Map();

function activate(context) {
  extensionUri = context.extensionUri;
  ctx = context;
  diagnostics = vscode.languages.createDiagnosticCollection('copadoMerge');
  output = vscode.window.createOutputChannel('Copado Release Assistant');
  // tokens are always masked before anything reaches the panel; identities when cmr.output.maskIdentities is on
  { const line = output.appendLine.bind(output), part = output.append.bind(output);
    output.appendLine = t => line(masked(t)); output.append = t => part(masked(t)); }
  context.subscriptions.push(diagnostics, output);

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
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      refresh(doc);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      diagnostics.delete(doc.uri);
      findingsByDoc.delete(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cmr')) vscode.window.visibleTextEditors.forEach(ed => scheduleOnEdit(ed.document));
    })
  );
  vscode.window.visibleTextEditors.forEach(ed => scheduleOnEdit(ed.document));

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('cmr.checkDuplicates', cmdCheckDuplicates);
  cmd('cmr.removeDuplicates', cmdRemoveDuplicates);
  cmd('cmr.storage.clean', cmdCleanStorage);
  // old working files removed by themselves: soon after starting, then twice a day (cmr.storage.keepDays)
  const tidy = () => { try { tidyStorage(); } catch (e) { /* next time */ } };
  // never what keeps VS Code - or a test - from closing
  const first = setTimeout(tidy, 30000), again = setInterval(tidy, 12 * 3600000);
  if (first.unref) first.unref(); if (again.unref) again.unref();
  context.subscriptions.push({ dispose() { clearTimeout(first); clearInterval(again); } });
  cmd('cmr.format', cmdFormat);
  cmd('cmr.showOrder', cmdShowOrder);
  cmd('cmr.writeWorkspaceSettings', cmdWriteWorkspaceSettings);
  cmd('cmr.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nikeshvarma.copado-release-assistant'));

  require('./release').activate(context, {
    inUse: fn => busyFns.push(fn),
    output,
    startSession,
    writeTemp,
    storageDir,
    resolveProject,
    isMetadata,
    promoMerge
  });


  context.subscriptions.push(
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
  // what the extension hands to whoever activates it: its own Manual tab - for the tests inside VS Code, which
  // must reach the very module the extension loaded (a path of their own can name another copy on Windows)
  return { manualUi: require('./manualUi') };
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
    mergeStartFrom: c.get('merge.startFrom', 'auto'),
    normalizeBeforeDiff: c.get('merge.normalizeBeforeDiff', true),
    mergeApplyFormatting: c.get('merge.applyFormatting', true),
    conflictWinner: c.get('merge.conflictWinner', 'incoming'),
    alwaysKeepTarget: c.get('merge.alwaysKeepTarget', []),
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

/** Code the merge editor shows in its own language, compared by lines (Apex and JavaScript by their members); null for metadata XML. */
function codeLanguage(file) {
  const ext = String(path.extname(file)).toLowerCase();
  if (ext === '.cls' || ext === '.trigger') return 'apex';
  if (ext === '.js') return 'javascript';
  if (ext === '.css') return 'css';
  // a component's template, a Visualforce page, Aura markup
  if (['.html', '.page', '.component', '.cmp', '.app', '.evt', '.intf', '.design', '.auradoc', '.tokens'].includes(ext)) return 'html';
  return null;
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
    if (session && !session.ready) await endSession({ noDraft: true });   // never leave a half-built session behind
    throw e;
  } finally {
    starting = false;
  }
}

async function prepareSession(targetUri, incomingUri, ancestorUri, so, progress, token) {
  const c = cfg();
  const t0 = Date.now();
  const timing = {};
  progress.report({ message: 'Reading both files' });
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
  progress.report({ message: 'Merging' + (lines > 5000 ? ' \u2013 a large file, this can take a moment' : '') });
  const eol = targetDoc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const e0 = Date.now();
  // code: no metadata merge - its two sides, compared as you edit; the start is Copado's conflict file, its blocks to choose
  const language = codeLanguage(targetUri.fsPath);
  // Manual and Compare: two versions compared, nothing merged. A promotion's code: Copado's conflict file as git merged
  // it, each conflict block taken out - neither version in until you accept one. A resolution you saved: as it is
  const plain = !!(so.manual || so.compare);
  const gitMerge = language && !plain && so.startFrom != null && hasMarkers(so.startFrom) ? require('./src/codeMerge').fromConflictFile(so.startFrom) : null;
  const result = language ? { ok: true, typeName: null, threeWay: !!ancestorDoc, marks: [], checks: [],
    report: { added: [], updated: [], auto: [], conflicts: [], deletions: [], duplicates: [], skipped: [] },
    targetText: targetDoc.getText(), incomingText: incomingDoc.getText(), mergedText: plain ? incomingDoc.getText() : gitMerge ? gitMerge.text : so.startFrom != null && !hasMarkers(so.startFrom) ? so.startFrom : targetDoc.getText() } : await runEngine({
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

  progress.report({ message: 'Preparing the comparison' });
  const w0 = Date.now();
  const dir = await sessionDir();
  const write = async (name, text) => {
    const uri = vscode.Uri.joinPath(dir, name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    return uri;
  };
  const base = path.basename(targetUri.fsPath);
  // a resolution you saved before is where you left it - not the merge worked out again; otherwise
  // where cmr.merge.startFrom says: nothing is merged behind your back (src/mergeStart.js)
  // code: Copado's conflict file is never where you start - it only told where git's blocks were
  const usable = so.startFrom != null && !(language && hasMarkers(so.startFrom));
  const startFrom = usable && String(so.startFrom) !== result.mergedText ? String(so.startFrom) : null;
  const starts = { merged: result.mergedText, feature: result.incomingText, target: result.targetText };
  // identical duplicates out of each start, once, here - what merging always does to its result, now also for a
  // start from a branch's file; the merge editor marks what was removed and never removes anything twice
  const dupRemoved = { merged: (result.report && result.report.duplicates || []).length, feature: 0, target: 0 }, removedDups = new Set();
  if (c.mergeRemoveDuplicates) {
    for (const k of ['feature', 'target']) {
      const d = require('./src/mergeDuplicates').dedupe(starts[k]);
      starts[k] = d.text; dupRemoved[k] = d.removed.length; d.removed.forEach(f => removedDups.add(f));
    }
  }
  const startKind = usable ? 'saved' : plain ? 'feature' : language ? 'merged' : require('./src/mergeStart').startFor(result.typeName, c.mergeStartFrom);
  let initial = startFrom != null ? startFrom : starts[startKind] != null ? starts[startKind] : result.mergedText;
  // unsaved changes this merge was closed with: offered back, once
  const draft = draftOf(so.applyToUri || targetUri);
  if (draft && draft.text !== initial) {
    const go = await vscode.window.showInformationMessage('This merge was closed with changes you had not saved (' + new Date(draft.at).toLocaleString() + '). Restore them?',
      { modal: true }, 'Restore my changes', 'Start fresh');
    if (go === 'Restore my changes') initial = draft.text;
  }
  if (draft) await keepDraft(so.applyToUri || targetUri, null);
  const marks = initial !== result.mergedText ? remapConflicts(result.marks, result.mergedText, initial) : result.marks;
  // the files are written before the session is published, so nothing ever sees a session without them
  const normTargetUri = await write('TARGET__' + base, result.targetText);
  const normIncomingUri = await write('INCOMING__' + base, result.incomingText);
  const mergedUri = await write('MERGED__' + base, initial);
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
      ancestor: (so.labels && so.labels.ancestor) || (ancestorUri ? path.basename(ancestorUri.fsPath) : ''),
      merged: (so.labels && so.labels.merged) || null
    },
    onApplied: so.onApplied || null,
    // a promotion's merge: saving the result is applying it; and it says so in its own words
    applyOnSave: !!so.applyOnSave, appliedMessage: so.appliedMessage || null, openAfterApply: so.openAfterApply !== false,
    // the incoming side inside a sentence: "the feature branch", an environment, or the incoming file
    theirs: so.theirs || null,
    report: result.report,
    marks,
    conflicts: marks.filter(m => m.mark.kind === 'conflict').map(m => Object.assign({}, m.mark.conflict, {
      line: m.startLine,
      resolved: c.conflictWinner === 'target' ? 'base' : 'incoming',
      reviewed: false
    })),
    checks: result.checks,
    language,
    code: language ? { conflicts: gitMerge ? gitMerge.conflicts : [], reviewed: new Map() } : null,
    plain,
    // your resolution against both branches - and their common ancestor, when known - worked out as you type
    normTargetText: result.targetText, normIncomingText: result.incomingText, ancestorText: ancestorDoc ? ancestorDoc.getText() : null,
    starts, startKind, dupRemoved, removedDups
  };
  session.conflicts.sort((a, b) => a.line - b.line);

  writeReport();
  
  progress.report({ message: 'Opening it' });
  const d0 = Date.now();
  openMergePanel(initial, so);
  timing.diff = Date.now() - d0;
  session.ready = true;
  output.appendLine(timingLine(base, result, timing, Date.now() - t0));

  const r = result.report;
  if (!language && !plain && !r.added.length && !r.updated.length && !r.conflicts.length && !r.duplicates.length) {
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
  if (!r || !r.ok) return { ok: false, error: r ? r.error : 'cancelled' };
  // each real clash: where it sits in the merged file and both values, for choosing in the page
  const clashes = r.marks.filter(m => m.mark.kind === 'conflict').map(m => ({ line: m.startLine, tag: m.mark.conflict.tag,
    where: m.mark.conflict.path || '', label: m.mark.conflict.label || '', target: m.mark.conflict.base, incoming: m.mark.conflict.incoming }));
  return { ok: true, mergedText: r.mergedText, conflicts: r.report.conflicts.length, clashes };
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

/**
 * Clean Working Files: the extension's working folder (.copado by default) emptied - what it holds listed first, and
 * any promotion whose resolutions are not uploaded yet named. Not while a merge is open; its .gitignore stays.
 */
async function cmdCleanStorage() {
  if (session) { vscode.window.showWarningMessage('Close the merge first - its files are in the working folder.'); return; }
  const root = storageRoot().fsPath;
  let entries = [];
  try { entries = fsSync.readdirSync(root, { withFileTypes: true }).filter(e => e.name !== '.gitignore'); } catch (e) { /* not there */ }
  const measure = p => { let bytes = 0, files = 0; const walk = d => { for (const e of fsSync.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { files++; bytes += fsSync.statSync(f).size; } } };
    try { if (fsSync.statSync(p).isDirectory()) walk(p); else { files = 1; bytes = fsSync.statSync(p).size; } } catch (e) { /* gone */ } return { bytes, files }; };
  const parts = entries.map(e => Object.assign({ name: e.name }, measure(path.join(root, e.name)))).filter(x => x.files);
  const rel = path.relative(resolveProject().root || resolveProject().fallback || root, root) || root;
  if (!parts.length) { vscode.window.showInformationMessage(rel + ' is already empty.'); return; }
  const size = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  // resolutions made here and not uploaded to Copado yet - gone with the folder
  const pending = [];
  try {
    for (const d of fsSync.readdirSync(path.join(root, 'promotions'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const st = JSON.parse(fsSync.readFileSync(path.join(root, 'promotions', d.name, 'promotion.json'), 'utf8'));
        const n = Object.values((st && st.files) || {}).filter(f => f.state === 'resolved').length;
        if (n) pending.push(d.name + ' (' + n + ')');
      } catch (e) { /* no state */ }
    }
  } catch (e) { /* no promotions */ }
  const total = parts.reduce((a, x) => a + x.bytes, 0);
  const go = await vscode.window.showWarningMessage('Empty ' + rel + '? ' + size(total) + ' in ' + parts.map(x => x.name + ' (' + x.files + ' file' + (x.files === 1 ? '' : 's') + ', ' + size(x.bytes) + ')').join(', ') + '.',
    { modal: true, detail: (pending.length ? 'Resolutions not uploaded to Copado yet will be lost: ' + pending.join(', ') + '. Upload them first, or they are gone.\n\n' : '') +
      'Everything here is the extension\u2019s own working copies - your project, git and Copado are not touched. Promotions are fetched again when you open them.' }, 'Empty it');
  if (go !== 'Empty it') return;
  for (const x of parts) fsSync.rmSync(path.join(root, x.name), { recursive: true, force: true });
  vscode.window.showInformationMessage('Emptied ' + rel + ' - ' + size(total) + ' removed.');
}

// what other parts of the extension have open in the working folder - the promotion on the page - kept by tidyStorage
const busyFns = [];
/** Working files older than cmr.storage.keepDays removed - never the open merge's, nor a promotion's not uploaded yet. */
function tidyStorage() {
  const days = vscode.workspace.getConfiguration('cmr').get('storage.keepDays', 14);
  const root = storageRoot().fsPath;
  const open = session ? [session.targetUri, session.incomingUri, session.applyToUri].filter(Boolean).map(u => u.fsPath) : [];
  const inUse = open.concat(...busyFns.map(fn => { try { return fn() || []; } catch (e) { return []; } }));
  const busy = p => inUse.some(f => f === p || f.startsWith(p + path.sep) || p.startsWith(f + path.sep));
  const removed = require('./src/retention').prune(root, { days, busy });
  if (removed.length) output.appendLine('Working files older than ' + days + ' days removed: ' + removed.join(', '));
  return removed;
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


/**
 * Reopened on a resolution you saved: the merge's conflicts found again in it,
 * by the text of their line - one you settled differently is no longer a
 * conflict, and the live marks show how it differs instead.
 */
function remapConflicts(marks, mergedText, startFrom) {
  const was = String(mergedText).split(/\r?\n/), now = String(startFrom).split(/\r?\n/);
  const used = new Set();
  const out = [];
  for (const m of marks) {
    if (m.mark.kind !== 'conflict') continue;
    const text = (was[m.startLine] || '').trim();
    if (!text) continue;
    const at = now.findIndex((l, i) => !used.has(i) && l.trim() === text);
    if (at < 0) continue;
    used.add(at);
    out.push(Object.assign({}, m, { startLine: at, endLine: at + (m.endLine - m.startLine) }));
  }
  return out;
}

/**
 * The merge in the extension's own editor (src/mergePanel.js). While it is
 * open it is the one place for this merge: the side bar's Merge view and its
 * commands stay hidden, and saving reads your resolution from the panel.
 */
function openMergePanel(startText, so) {
  const s = session;
  const theirs = s.theirs || 'the incoming file';
  const short = /feature/i.test(theirs) ? 'the feature' : theirs;
  const conflictsFor = text => remapConflicts(s.marks, startText, text).map(m => Object.assign({}, m.mark.conflict, { line: m.startLine }))
    .filter(c => c.tag && !c.multiline);
  s.panelText = startText;
  s.mergedStart = startText;
  s.panel = require('./src/mergePanel').open(vscode, extensionUri, {
    file: path.basename(s.targetUri.fsPath),
    labels: { target: s.labels.target, merged: s.labels.merged || 'Your resolution' },
    theirs, short, typeName: s.typeName,
    target: s.normTargetText, incoming: s.normIncomingText || '', text: startText, language: s.language || null, code: s.code || null, plain: !!s.plain,
    // code in one pane or two: cmr.merge.codeView - the switch in the editor's \u22ef writes it
    codeView: vscode.workspace.getConfiguration('cmr').get('merge.codeView', 'onePane'),
    setCodeView: v => vscode.workspace.getConfiguration('cmr').update('merge.codeView', v, vscode.ConfigurationTarget.Global).then(() => {}, () => {}),
    // the common ancestor, when known: what each branch did since - unless turned off (cmr.merge.useAncestor)
    ancestor: s.ancestorText && vscode.workspace.getConfiguration('cmr').get('merge.useAncestor', true) !== false ? s.ancestorText : null,
    savedText: so.startFrom != null && !(s.language && hasMarkers(so.startFrom)) ? String(so.startFrom) : null,
    applyOnly: !s.applyOnSave,
    starts: s.starts, start: s.startKind, dupRemoved: s.dupRemoved, removedDups: s.removedDups,
    hideIdentical: vscode.workspace.getConfiguration('cmr').get('merge.hideIdentical', false),
    onPref: p => vscode.workspace.getConfiguration('cmr').update('merge.hideIdentical', !!p.hideIdentical, vscode.ConfigurationTarget.Global),
    conflictsFor: s.plain ? null : conflictsFor,
    onText: text => { if (session === s) s.panelText = text; },
    save: async (text, close) => {
      if (session !== s) return { ok: false, message: 'This merge has ended.' };
      s.panelText = text;
      if (close) { const done = await applyOnce(); return done ? { ok: true, message: 'Saved' } : { ok: false, message: 'Not saved' }; }
      const notes = await saveIntoResolution();
      return { ok: true, warn: notes.length > 0, message: notes.length ? 'Saved as your resolution \u2013 ' + notes.join(', ') : 'Saved as your resolution' };
    },
    // \u22ef: discard asks first; the report and the swap as they always were
    discard: async () => {
      if (session !== s) return;
      const go = await vscode.window.showWarningMessage('Discard this merge?', { modal: true, detail: s.applyOnSave ? 'Your saved resolution is kept as it is.' : 'Nothing is written.' }, 'Discard');
      if (go === 'Discard') await cmdCancelMerge();
    },
    report: async () => { await cmdCopyReport(); return null; },
    // Remove Duplicate Entries, in the editor: as the command does it - the same rule for which one stays, the same
    // question first when duplicates differ
    dedupe: async text => {
      const c = cfg();
      const parsed = X.parse(String(text));
      if (!parsed.root || (parsed.errors && parsed.errors.length)) return { error: 'Not valid XML - fix it first' };
      const findings = findDuplicates(parsed, { warnRepeatedSingletons: c.warnSingletons }).filter(f => f.kind !== 'duplicate-single');
      if (!findings.length) return { note: 'No duplicate entries to remove.' };
      const risky = findings.filter(f => !f.identical);
      if (risky.length) {
        const go = await vscode.window.showWarningMessage(risky.length + ' of ' + findings.length + ' duplicates have the same key but different values. Keeping the ' + c.keep + ' occurrence will discard the other. Continue?', { modal: true }, 'Remove duplicates');
        if (go !== 'Remove duplicates') return { note: 'Nothing removed.' };
      }
      let out = String(text);
      for (const r of dedupeEdits(parsed, findings, c.keep).sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + out.slice(r.end);
      return { text: out, note: 'Removed ' + findings.length + ' duplicate ' + (findings.length === 1 ? 'entry' : 'entries') + ' \u2013 Ctrl+Z undoes it.' };
    },
    // \u22ef \u203a Format and Order Metadata: Salesforce's own order, as Format Document - duplicates are left for the editor to show
    format: text => {
      const parsed = X.parse(String(text));
      if (!parsed.root || (parsed.errors && parsed.errors.length)) return { error: 'Not valid XML - fix it first: ' + ((parsed.errors && parsed.errors[0] && parsed.errors[0].message) || 'no root element') };
      const c = cfg();
      const out = formatter.format(parsed, formatOptions(c, /\r\n/.test(text) ? '\r\n' : '\n', { removeDuplicates: false, keep: c.keep }));
      return out == null ? { error: 'This file cannot be formatted' } : { text: out };
    },
    swap: async () => { await cmdSwapDirection(); return null; },
    // a manual merge's ways out: copied to paste into Copado, or saved as a file
    copyResult: async text => { await vscode.env.clipboard.writeText(text); return { ok: true, message: 'Copied \u2013 paste it into Copado\u2019s resolution and save it there' }; },
    // a file of either side: in a comparison, each side is yours to save
    saveAs: async (text, side) => {
      const name = s.plain ? (side === 'left' ? (s.labels.target || 'left') : (s.labels.incoming || 'right')).replace(/[^\w.-]+/g, '_') + '-' + path.basename(s.targetUri.fsPath) : 'resolved-' + path.basename(s.targetUri.fsPath);
      const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(s.targetUri, '..', name), filters: { 'Metadata XML': ['xml'] } });
      if (!to) return null;
      await vscode.workspace.fs.writeFile(to, Buffer.from(text, 'utf8'));
      return { ok: true, message: 'Saved as ' + path.basename(to.fsPath) };
    },
    manual: !!so.manual,
    onDirty: d => { if (session === s) s.dirty = !!d; },
    onClose: () => { if (session === s && s.panel) { s.panel = null; endSession(); } }
  });
}

/** Your resolution as it is now: in the merge panel, or in the merge view. */
async function mergedText() {
  return session.panelText;
}


/* ---------- deploy checks on the merged result ---------- */


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
  await endSession({ noDraft: true });   // you were told your edits are discarded
  await startSession(incoming, target, ancestor, {
    applyToUri: applyTo || undefined,
    onApplied,
    labels: { target: labels.incoming, incoming: labels.target, ancestor: labels.ancestor, merged: labels.merged }
  });
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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


/**
 * Ctrl+S in a promotion's merge view: what you saved becomes your resolution,
 * and the merge view stays open to go on working. No questions on a save -
 * what Save and close would ask about is said in the status bar instead (a
 * file that is not valid XML is still held back from upload).
 */
async function saveIntoResolution() {
  const text = await mergedText();
  await keepDraft(session.applyToUri || session.targetUri, null);
  const notes = [];
  if (session.language) {
    const problems = require('./src/codeChecks').problems(text, session.language).filter(p => p.severity === 'error');
    if (problems.length) notes.push(problems.length + ' problem' + (problems.length === 1 ? '' : 's') + ' (' + problems[0].message + ')');
  } else {
    const parsed = X.parse(text);
    if (parsed.errors.length) notes.push(parsed.errors.length + ' XML problem' + (parsed.errors.length === 1 ? '' : 's'));
    if (checksFor(text).some(v => v.severity === 'error')) notes.push('a deploy check would fail');
    if (findDuplicates(parsed, { warnRepeatedSingletons: true }).length) notes.push('duplicate entries');
  }
  const targetDoc = await vscode.workspace.openTextDocument(session.applyToUri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(session.applyToUri, new vscode.Range(targetDoc.positionAt(0), targetDoc.positionAt(targetDoc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
  await targetDoc.save();
  if (session.onApplied) { try { session.onApplied(session.applyToUri); } catch (e) { /* view refresh only */ } }
  if (!session.panel) vscode.window.setStatusBarMessage((notes.length ? '$(warning) Saved as your resolution - ' + notes.join(', ') : '$(check) Saved as your resolution') + ' \u00b7 the merge view stays open', 6000);
  return notes;
}

async function applyOnce() {
  const inPanel = !!session.panel;
  const unreviewed = inPanel ? remapConflicts(session.marks, session.mergedStart != null ? session.mergedStart : session.panelText, session.panelText).length
    : session.conflicts.filter(c => !c.reviewed).length;
  if (unreviewed) {
    const go = await vscode.window.showWarningMessage(unreviewed + ' value' + (unreviewed === 1 ? '' : 's') + ' both branches changed still as the merge suggested. Apply anyway?', { modal: true }, 'Apply anyway');
    if (go !== 'Apply anyway') return false;
  }

  const text = await mergedText();
  if (session.language) {
    // code: a conflict not chosen for yet; then brackets that do not balance
    const c = session.code;
    const needs = c && !session.plain ? require('./src/codeMerge').marks({ text, conflicts: c.conflicts, language: session.language, reviewed: c.reviewed }).counts.needs : 0;
    if (needs) {
      const go = await vscode.window.showWarningMessage(needs + ' conflict' + (needs === 1 ? ' is' : 's are') + ' not resolved yet - ' + (needs === 1 ? 'its' : 'their') + ' lines are not in the file. Save anyway?', { modal: true }, 'Save anyway');
      if (go !== 'Save anyway') return false;
    }
    const problems = require('./src/codeChecks').problems(text, session.language).filter(p => p.severity === 'error');
    if (problems.length) {
      const go = await vscode.window.showWarningMessage(problems[0].message + ' (line ' + problems[0].line + ')' + (problems.length > 1 ? ' \u2013 and ' + (problems.length - 1) + ' more' : '') + '. Apply anyway?', { modal: true }, 'Apply anyway');
      if (go !== 'Apply anyway') return false;
    }
    return finishApply(text);
  }
  const parsed = X.parse(text);
  if (parsed.errors.length) {
    const go = await vscode.window.showWarningMessage(
      'The merged file has ' + parsed.errors.length + ' XML problem(s) after your edits. Apply anyway?',
      { modal: true }, 'Apply anyway');
    if (go !== 'Apply anyway') return false;
  }
  const violations = checksFor(text).filter(v => v.severity === 'error');
  if (violations.length) {
    const go = await vscode.window.showWarningMessage(
      violations.length + ' deploy check' + (violations.length === 1 ? '' : 's') + ' would fail on this result, e.g. "' +
      violations[0].message + '" Apply anyway?',
      { modal: true }, 'Apply anyway');
    if (go !== 'Apply anyway') return false;
  }

  const leftovers = findDuplicates(parsed, { warnRepeatedSingletons: true });
  if (leftovers.length) {
    const go = await vscode.window.showWarningMessage(
      leftovers.length + ' duplicate entr' + (leftovers.length === 1 ? 'y' : 'ies') + ' in the merged result. Apply anyway?',
      { modal: true }, 'Apply anyway');
    if (go !== 'Apply anyway') return false;
  }

  return finishApply(text);
}

/** The checks passed or were waived: the result written into its file, the merge ended. */
async function finishApply(text) {
  const targetDoc = await vscode.workspace.openTextDocument(session.applyToUri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(session.applyToUri, new vscode.Range(targetDoc.positionAt(0), targetDoc.positionAt(targetDoc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
  await targetDoc.save();

  const targetUri = session.applyToUri;
  const onApplied = session.onApplied;
  const name = path.basename(targetUri.fsPath);
  const message = session.appliedMessage, open = session.openAfterApply;
  await keepDraft(session.applyToUri || session.targetUri, null);
  await endSession({ noDraft: true });
  if (open) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(targetUri));
  if (onApplied) { try { onApplied(targetUri); } catch (e) { /* view refresh only */ } }
  vscode.window.showInformationMessage(message || 'Merged into ' + name + '. Commit it back to Copado when you are happy.');
  return true;
}

async function cmdCancelMerge() {
  if (!session) return;
  await keepDraft(session.applyToUri || session.targetUri, null);
  await endSession({ noDraft: true });
  vscode.window.showInformationMessage('Merge discarded. Nothing was written.');
}

/**
 * Unsaved changes of a merge that ended without your say - its tab closed, another merge opened - are kept
 * as a draft for that file, and the next merge of it offers them back. Discarding or saving clears it.
 */
const DRAFTS = 'releaseAssistant.mergeDrafts';
function draftOf(uri) { const all = (ctx && ctx.workspaceState && ctx.workspaceState.get(DRAFTS, {})) || {}; return all[uri.toString()] || null; }
async function keepDraft(uri, text) {
  if (!ctx || !ctx.workspaceState || !uri) return;
  const all = Object.assign({}, ctx.workspaceState.get(DRAFTS, {}));
  if (text == null) delete all[uri.toString()]; else all[uri.toString()] = { text, at: Date.now() };
  await ctx.workspaceState.update(DRAFTS, all);
}

async function endSession(opts) {
  if (session && session.dirty && session.panelText != null && !(opts && opts.noDraft)) {
    const uri = session.applyToUri || session.targetUri;
    await keepDraft(uri, session.panelText);
    vscode.window.showInformationMessage('Your unsaved changes to ' + path.basename(uri.fsPath) + ' are kept \u2013 open its merge again to restore them.');
  }
  if (session && session.panel) { const p = session.panel; session.panel = null; p.dispose(); }
  const uris = session
    ? [session.mergedUri, session.normTargetUri, session.normIncomingUri]
      .filter(Boolean).map(u => u.toString())
    : [];
  session = null;
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


/* ---------- housekeeping commands ---------- */


function activeMetadataDoc() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage('Open a Salesforce metadata XML file first.'); return null; }
  if (!isMetadata(editor.document)) {
    vscode.window.showWarningMessage('This file does not look like Salesforce metadata XML.');
    return null;
  }
  return editor.document;
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
