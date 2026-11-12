'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const manifest = require('./src/manifest');
const selective = require('./src/selective');
const policies = require('./src/guard');
const inspectLib = require('./src/copadoInspect');
const promotionLib = require('./src/promotion');
const { createClient } = require('./src/copadoClient');
const { redact } = require('./src/redact');
const gitops = require('./src/gitops');
const sfcli = require('./src/sfcli');
const fixes = require('./src/fixes');
const X = require('./src/xmlParser');
const { projectFolder, forCli } = require('./src/paths');

let deps;
let ctx;
let output;
let deployDiagnostics;
let branchProvider;
let deployProvider;
let branchTree;
let deployTree;

const state = {
  pkg: null,          // last generated package
  branch: null,       // last branch analysis
  validation: null    // last validation run
};

function activate(context, d) {
  deps = d;
  ctx = context;
  output = d.output;
  deployDiagnostics = vscode.languages.createDiagnosticCollection('copadoDeploy');
  context.subscriptions.push(deployDiagnostics);

  branchProvider = provider(branchRoots, branchChildren);
  deployProvider = provider(deployRoots, deployChildren);
  branchTree = vscode.window.createTreeView('cmrBranchView', { treeDataProvider: branchProvider, showCollapseAll: true });
  deployTree = vscode.window.createTreeView('cmrDeployView', { treeDataProvider: deployProvider, showCollapseAll: true });
  context.subscriptions.push(branchTree, deployTree);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('cmr.sf.path')) { cliCache.version = null; cliCache.orgs = null; }
  }));
  refreshMessages();

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));
  cmd('cmr.package.fromCommit', cmdPackage);
  cmd('cmr.package.openFile', uri => uri && vscode.window.showTextDocument(uri));
  cmd('cmr.git.check', cmdBranchCheck);
  cmd('cmr.git.resolveFile', cmdBranchResolve);
  cmd('cmr.git.compareFile', cmdBranchCompare);
  cmd('cmr.validate.run', () => cmdValidate({}));
  cmd('cmr.validate.rerun', () => cmdValidate({ rerun: true }));
  cmd('cmr.validate.applyFix', cmdApplyFix);
  cmd('cmr.validate.openFailure', cmdOpenFailure);
  cmd('cmr.validate.copyErrors', cmdCopyErrors);
  cmd('cmr.selective.import', () => importSelective(state.pkg, false));
  cmd('cmr.selective.undo', cmdUndoSelective);
  cmd('cmr.selective.download', () => downloadSelective(state.pkg, false));
  cmd('cmr.policy.create', cmdCreatePolicy);
  cmd('cmr.copado.inspect', cmdInspectStory);
  cmd('cmr.copado.prepare', cmdPrepareStory);
  require('./promotionUi').activate(context, { output, deps, rc, cmd, requireTrust, projectRoot, apiVersion, copadoApi, cmdPackage, cmdValidate, orgForEnvironment, orgList, sfcli });
  cmd('cmr.validate.clear', () => {
    state.validation = null;
    deployDiagnostics.clear();
    refreshAll();
  });
}

/** Turns thrown errors into a readable message instead of a silent failure. */
function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); } catch (e) {
      const msg = (e && e.message) || String(e);
      output.appendLine('Error: ' + msg);
      const actions = e && e.setting ? ['Open settings', 'Show output'] : ['Show output'];
      vscode.window.showErrorMessage(msg, ...actions).then(p => {
        if (p === 'Open settings') vscode.commands.executeCommand('workbench.action.openSettings', e.setting);
        else if (p) output.show(true);
      });
    }
  };
}

function rc() {
  const c = vscode.workspace.getConfiguration('cmr');
  return {
    outputFolder: c.get('package.outputFolder', 'manifest'),
    apiVersion: c.get('package.apiVersion', ''),
    actions: c.get('package.actionMapping', manifest.DEFAULT_ACTIONS),
    warnStandardFields: c.get('package.warnStandardFields', true),
    openAfterGenerate: c.get('package.openAfterGenerate', true),
    targetBranch: c.get('git.targetBranch', ''),
    incomingBranch: c.get('git.incomingBranch', ''),
    remote: c.get('git.remote', 'origin'),
    fetchFirst: c.get('git.fetchFirst', true),
    includeBothChanged: c.get('git.includeBothChanged', true),
    metadataOnly: c.get('git.metadataOnly', false),
    confirmBranches: c.get('git.confirmBranches', true),
    sfPath: c.get('sf.path', 'sf') || 'sf',
    sourceOrg: c.get('org.source', ''),
    targetOrg: c.get('org.target', ''),
    confirmOrgs: c.get('org.confirm', true),
    validateSource: c.get('validate.source', 'ask'),
    testLevel: c.get('validate.testLevel', 'ask'),
    testLevelWithoutApex: c.get('validate.testLevelWithoutApex', 'NoTestRun'),
    testPattern: c.get('validate.testClassPattern', 'Test$'),
    defaultTests: c.get('validate.defaultTests', []),
    waitMinutes: c.get('validate.waitMinutes', 60),
    warnOnProduction: c.get('validate.warnOnProduction', true),
    revealOutput: c.get('validate.revealOutput', true),
    progressInterval: Math.max(0, Number(c.get('validate.progressInterval', 0)) || 0),
    selFolder: c.get('selective.folder', 'conflict/selective'),
    copadoOrg: c.get('copado.org', ''),
    environmentOrgs: c.get('copado.environmentOrgs', {}),
    maskIdentities: c.get('output.maskIdentities', false),
    guard: { allowedTargetOrgs: c.get('guard.allowedTargetOrgs', []), blockedTargetOrgs: c.get('guard.blockedTargetOrgs', []),
      allowProduction: c.get('guard.allowProduction', true), minimumTestLevel: c.get('guard.minimumTestLevel', {}) },
    selAuto: c.get('selective.autoImport', true),
    selConfirm: c.get('selective.confirm', true),
    skipSourceTracking: c.get('validate.skipSourceTracking', true)
  };
}

/**
 * The Salesforce project to work in, as found by the shared resolver
 * (cmr.project.path, the open file's project, the open folder, or the one
 * project inside it). Throws a message with a way to fix it.
 */
function projectRoot() {
  const p = deps.resolveProject();
  if (p.root) return p.root;
  const e = new Error(p.error || 'Open your Salesforce project folder first.');
  e.setting = 'cmr.project.path';
  throw e;
}

/** The project if there is one, else the open folder - for features that do not need sfdx-project.json. */
function projectOrFolder() {
  const p = deps.resolveProject();
  const r = p.root || p.fallback;
  if (!r) throw new Error('Open your project folder first.');
  return r;
}

/* =========================================================== package.xml */

async function cmdPackage(uri, uris) {
  let files = (Array.isArray(uris) && uris.length ? uris : (uri && uri.fsPath ? [uri] : []))
    .filter(u => /\.json$/i.test(u.fsPath));
  if (!files.length) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: 'Use these commits',
      filters: { 'Copado commit JSON': ['json'] },
      title: 'Pick one or more Copado commit JSON files (several user stories combine into one package)'
    });
    if (!picked || !picked.length) return null;
    files = picked;
  }
  return generatePackage(files);
}

async function generatePackage(files) {
  const c = rc();
  const rows = [];
  for (const f of files) {
    const text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8');
    rows.push(...manifest.parseCommit(text, path.basename(f.fsPath)));
  }
  if (!rows.length) throw new Error('No components found in ' + files.map(f => path.basename(f.fsPath)).join(', ') + '.');

  const version = await apiVersion();
  const result = manifest.build(rows, { actions: c.actions, warnStandardFields: c.warnStandardFields, testPattern: c.testPattern });
  const pkg = { result, version, sources: files, folder: null, files: {}, changed: false };
  pkg.selectiveImported = new Set();
  refreshSelective(pkg);
  await writePackageFiles(pkg);
  state.pkg = pkg;

  output.clear();
  output.appendLine('Package from ' + files.map(f => path.basename(f.fsPath)).join(', '));
  output.appendLine('');
  for (const line of manifest.summary(result, version)) output.appendLine(line);
  output.appendLine('Written to ' + vscode.workspace.asRelativePath(pkg.folder));
  output.show(true);

  refreshAll();
  vscode.commands.executeCommand('cmrDeployView.focus');
  if (c.openAfterGenerate) await vscode.window.showTextDocument(pkg.files.deploy, { preview: false });

  const warnings = result.notes.filter(n => n.severity === 'warning').length;
  vscode.window.showInformationMessage(
    'package.xml: ' + result.counts.deploy + ' to deploy' +
    (result.counts.retrieveOnly ? ', ' + result.counts.retrieveOnly + ' retrieve only' : '') +
    (warnings ? ' \u00b7 ' + warnings + ' pre-flight warning' + (warnings === 1 ? '' : 's') : '') + '.',
    'Validate now').then(p => { if (p) vscode.commands.executeCommand('cmr.validate.run'); });
  return pkg;
}

async function writePackageFiles(pkg) {
  const c = rc();
  const root = projectOrFolder();
  // package.xml goes where every Salesforce project keeps it, and replaces what is there
  let projectJson = '';
  try { projectJson = await fs.promises.readFile(path.join(root, 'sfdx-project.json'), 'utf8'); } catch (e) { /* not a project file */ }
  const folder = path.join(root, projectFolder(c.outputFolder, 'manifest', projectJson));
  await fs.promises.mkdir(folder, { recursive: true });
  pkg.folder = vscode.Uri.file(folder);
  const r = pkg.result;

  const write = async (dir, name, text) => {
    const uri = vscode.Uri.file(path.join(dir, name));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    return uri;
  };
  pkg.files.deploy = await write(folder, 'package.xml', manifest.toPackageXml(r.deploy, pkg.version));
  pkg.files.destructive = r.destructive.size
    ? await write(folder, 'destructiveChanges.xml', manifest.toPackageXml(r.destructive, pkg.version))
    : null;
  // the retrieve list is a working file, so it lives in the extension's folder; it differs from
  // package.xml when there are retrieve-only items, or selective commits that must not be retrieved
  pkg.files.retrieve = r.retrieveOnly.size || (r.selective && r.selective.size)
    ? await write((await deps.storageDir()).fsPath, 'package-retrieve.xml', manifest.toPackageXml(r.retrieve, pkg.version))
    : pkg.files.deploy;
}

/* ---------------------------------------------------------- selective commits */

function selectiveSetup(pkg) {
  const c = rc();
  const root = projectOrFolder();
  let dirs = ['force-app'];
  try { dirs = require('./src/paths').packageDirsOf(fs.readFileSync(path.join(root, 'sfdx-project.json'), 'utf8')); } catch (e) { /* default */ }
  const folder = path.join(root, require('./src/paths').insideProject(c.selFolder, 'conflict/selective'));
  const note = pkg.result.notes.find(n => n.id === 'selective-commit');
  return { c, root, dirs, folder, items: note ? note.components : [] };
}

/**
 * Re-reads the drop folder and turns what it finds into pre-flight notes, one
 * per selective commit, so the Package row always says what will happen.
 */
function refreshSelective(pkg) {
  if (!pkg || !pkg.result.selective || !pkg.result.selective.size) return;
  const o = selectiveSetup(pkg);
  const p = selective.plan(o);
  pkg.selectivePlan = p;
  const rel = f => path.relative(o.root, f).split(path.sep).join('/');
  const label = it => it.type + ' ' + it.name;
  const notes = [];
  for (const it of p.items) {
    const done = pkg.selectiveImported && pkg.selectiveImported.has(it.type + '|' + it.name);
    if (it.status === 'missing' && done) notes.push(['info', label(it) + ': the committed version from Copado is in the project.']);
    else if (it.status === 'ready') notes.push(['info', label(it) + ': the committed version is ready to import from ' + path.basename(it.source) + '.']);
    else if (it.status === 'missing') notes.push(['warning', label(it) + ': no download in ' + rel(o.folder) + '. ' + (fs.existsSync(it.target)
      ? 'Validation would use the project\u2019s current version.' : 'It is not in the project either.') +
      ' Download Copado file ' + (it.copadoFile || 'for it') + ' into ' + rel(o.folder) + '.']);
    else if (it.status === 'duplicate') notes.push(['warning', label(it) + ': ' + it.files.length + ' downloads (' + it.files.map(f => path.basename(f)).join(', ') + '). Keep only the right one.']);
    else if (it.status === 'mismatch') notes.push(['warning', label(it) + ': the downloaded file is a <' + (it.found || '?') + '>, not a <' + it.type + '>. It will not be imported.']);
    else if (it.status === 'split') notes.push(['warning', label(it) + ': the downloaded CustomObject holds fields and other parts that source format keeps in separate files. It will not be imported.']);
    else if (it.status === 'unsupported') notes.push(['info', label(it) + ': this type is not imported automatically - put its committed version in the project yourself.']);
  }
  for (const x of p.extra) {
    notes.push(['info', path.basename(x.file) + (x.id ? ' (' + x.id.type + ' ' + x.id.name + ')' : '') + ' is in ' + rel(o.folder) + ' but belongs to no selective commit in this package.']);
  }
  pkg.result.notes = pkg.result.notes.filter(n => n.id !== 'selective-status')
    .concat(notes.map(([severity, message]) => ({ severity, id: 'selective-status', message })));
  watchSelective(o.folder);
}

let selectiveWatcher = null;
let selectiveWatched = '';
function watchSelective(folder) {
  if (selectiveWatched === folder) return;
  if (selectiveWatcher) selectiveWatcher.dispose();
  selectiveWatched = folder;
  selectiveWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '*'));
  const again = () => { if (state.pkg) { refreshSelective(state.pkg); refreshAll(); } };
  selectiveWatcher.onDidCreate(again); selectiveWatcher.onDidChange(again); selectiveWatcher.onDidDelete(again);
}

/**
 * Copies the committed versions into the project. From a validation it returns
 * 'stop' when you decline, so nothing is validated by surprise.
 */
async function importSelective(pkg, fromValidation) {
  if (!pkg || !pkg.result.selective || !pkg.result.selective.size) {
    if (!fromValidation) vscode.window.showInformationMessage('The current package has no selective commits.');
    return 'none';
  }
  pkg.selectiveImported = pkg.selectiveImported || new Set();
  refreshSelective(pkg);
  const o = selectiveSetup(pkg);
  if (fromValidation && !o.c.selAuto) return 'skipped';
  const items = pkg.selectivePlan.items;
  const ready = items.filter(i => i.status === 'ready');
  const missing = items.filter(i => i.status === 'missing' && !pkg.selectiveImported.has(i.type + '|' + i.name));
  const rel = f => path.relative(o.root, f).split(path.sep).join('/');

  const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && ready.some(i => path.resolve(i.target).toLowerCase() === path.resolve(d.uri.fsPath).toLowerCase()));
  if (dirty.length) {
    vscode.window.showWarningMessage('Save or revert ' + dirty.map(d => path.basename(d.fileName)).join(', ') + ' first - the selective import would replace ' + (dirty.length === 1 ? 'it' : 'them') + '.', { modal: true });
    return 'stop';
  }
  if (ready.length) {
    if (o.c.selConfirm) {
      const buttons = ['Import', 'Show diffs'].concat(fromValidation ? ['Validate without importing'] : []);
      const pick = await vscode.window.showInformationMessage(
        'Import ' + ready.length + ' selective commit' + (ready.length === 1 ? '' : 's') + ' into the project?',
        { modal: true, detail: ready.map(i => i.type + ' ' + i.name + '  \u2192  ' + rel(i.target)).join('\n') +
          '\n\nThe current files are backed up; "Copado: Undo Last Selective Import" restores them.' }, ...buttons);
      if (pick === 'Show diffs') {
        for (const i of ready) {
          const left = fs.existsSync(i.target) ? vscode.Uri.file(i.target) : vscode.Uri.parse('untitled:' + path.basename(i.target));
          await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(i.source), path.basename(i.target) + ' \u2194 committed version');
        }
        vscode.window.showInformationMessage('Review the differences, then import or validate again.');
        return 'stop';
      }
      if (pick === 'Validate without importing') return 'skipped';
      if (pick !== 'Import') return 'stop';
    }
    const storage = (await deps.storageDir()).fsPath;
    const record = selective.apply(items, { root: o.root, storage });
    for (const it of record.items) {
      pkg.selectiveImported.add(it.type + '|' + it.name);
      output.appendLine('  selective: ' + it.type + ' ' + it.name + ' \u2190 ' + path.basename(it.download) + '  \u2192  ' + rel(it.target));
    }
    refreshSelective(pkg);
    refreshAll();
    if (!fromValidation) vscode.window.showInformationMessage(record.items.length + ' selective commit' + (record.items.length === 1 ? '' : 's') + ' imported. Source Control shows the changes.');
  } else if (!fromValidation) {
    vscode.window.showInformationMessage('Nothing to import - no matching downloads in ' + rel(o.folder) + '. The Package row in Deploy Check says what each selective commit needs.');
  }
  if (fromValidation && missing.length) {
    const go = await vscode.window.showWarningMessage(
      missing.length + ' selective commit' + (missing.length === 1 ? ' has' : 's have') + ' no download in ' + rel(o.folder) + '.',
      { modal: true, detail: missing.map(i => i.type + ' ' + i.name + (i.copadoFile ? '  (Copado file ' + i.copadoFile + ')' : '')).join('\n') +
        '\n\nValidate with the project\u2019s current version instead?' }, ...(o.c.copadoOrg ? ['Download from Copado'] : []), 'Validate anyway');
    if (go === 'Download from Copado') {
      if (!(await downloadSelective(pkg, true))) return 'stop';
      return importSelective(pkg, true);
    }
    if (go !== 'Validate anyway') return 'stop';
  }
  return 'imported';
}

/** Org and git commands only run in a folder VS Code trusts. */
function requireTrust(what) {
  if (vscode.workspace.isTrusted === false) {
    const e = new Error(what + ', so it is turned off until you trust this folder (Manage Workspace Trust).');
    throw e;
  }
}

/**
 * Applies the team's guardrails to this validation: copado-policy.json at the
 * project root if there is one, otherwise the guard settings. A blocked target
 * stops the run; a test level below the policy's minimum is raised.
 */
async function applyPolicy(c, root, params) {
  let fileText = null;
  try { fileText = fs.readFileSync(path.join(root, 'copado-policy.json'), 'utf8'); } catch (e) { /* no policy file */ }
  const { policy, source, error } = policies.resolvePolicy(fileText, c.guard);
  if (error) output.appendLine('policy: ' + error);
  let orgs = [];
  try { orgs = await orgList(c, root); } catch (e) { /* checked by name only */ }
  const known = orgs.find(o => o.alias === params.targetOrg || o.username === params.targetOrg);
  // an org the CLI cannot describe is treated as production - the stricter reading
  const org = { alias: known ? known.alias : params.targetOrg, username: known ? known.username : params.targetOrg, isSandbox: known ? known.isSandbox : false };
  const r = policies.check(policy, org, params.testLevel);
  if (!r.allowed) {
    const pick = await vscode.window.showErrorMessage('Validation blocked: ' + r.reason + '.', { modal: true, detail: 'Rule from ' + source + '.' }, 'Open policy');
    if (pick === 'Open policy') {
      if (source === 'copado-policy.json') vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'copado-policy.json')));
      else vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.guard');
    }
    return false;
  }
  if (r.raisedFrom) {
    let level = r.testLevel;
    if (level === 'RunSpecifiedTests' && !(params.tests || []).length) level = 'RunLocalTests';   // specified tests need test classes
    output.appendLine('policy: tests raised from ' + r.raisedFrom + ' to ' + level + ' for ' + params.targetOrg + ' (rule "' + r.rule + '" in ' + source + ')');
    vscode.window.showInformationMessage('The team policy requires ' + level + ' for ' + params.targetOrg + ' - using it instead of ' + r.raisedFrom + '.');
    params.testLevel = level;
  }
  return true;
}

/** Writes a starting copado-policy.json from the current guard settings, to review and commit. */
async function cmdCreatePolicy() {
  const root = projectRoot();
  const file = path.join(root, 'copado-policy.json');
  if (fs.existsSync(file)) { await vscode.window.showTextDocument(vscode.Uri.file(file)); return; }
  const g = rc().guard;
  const body = {
    allowedTargetOrgs: g.allowedTargetOrgs.length ? g.allowedTargetOrgs : ['qa', 'uat'],
    blockedTargetOrgs: g.blockedTargetOrgs,
    allowProduction: g.allowProduction,
    minimumTestLevel: Object.keys(g.minimumTestLevel).length ? g.minimumTestLevel : { production: 'RunLocalTests' }
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage('copado-policy.json created. Adjust it, then commit it - it applies to everyone who opens this project.');
}

/**
 * Fetches the committed version of each selective commit still waiting for a
 * download, straight from the Copado org, into the drop folder. Returns true
 * if anything was downloaded.
 */
async function downloadSelective(pkg, fromValidation) {
  requireTrust('Downloading from Copado runs the Salesforce CLI');
  if (!pkg || !pkg.result.selective || !pkg.result.selective.size) {
    if (!fromValidation) vscode.window.showInformationMessage('The current package has no selective commits.');
    return false;
  }
  const c = rc();
  if (!c.copadoOrg) {
    const p = await vscode.window.showInformationMessage('Set the Copado org first - the alias of the org where Copado runs, logged in with the Salesforce CLI.', 'Open settings');
    if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.copado.org');
    return false;
  }
  refreshSelective(pkg);
  const o = selectiveSetup(pkg);
  const wanted = pkg.selectivePlan.items.filter(i => i.status === 'missing' && i.copadoFile && !(pkg.selectiveImported && pkg.selectiveImported.has(i.type + '|' + i.name)));
  if (!wanted.length) {
    if (!fromValidation) vscode.window.showInformationMessage('Nothing to download - every selective commit already has its file, or has no Copado file id.');
    return false;
  }
  fs.mkdirSync(o.folder, { recursive: true });
  const done = [], failed = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Downloading from Copado (' + c.copadoOrg + ')' }, async progress => {
    for (const it of wanted) {
      progress.report({ message: it.type + ' ' + it.name });
      try {
        const body = await sfcli.selectiveFileGet(c.sfPath, c.copadoOrg, it.copadoFile, pkg.version, o.root);
        // the name Copado gives it: its hash, with "/" made file-safe
        const name = it.hash.replace(/\//g, '_') + '.xml';
        fs.writeFileSync(path.join(o.folder, name), body);
        done.push(it);
        output.appendLine('  copado: ' + it.type + ' ' + it.name + ' \u2190 file ' + it.copadoFile + '  \u2192  ' + name);
      } catch (e) {
        failed.push(it.type + ' ' + it.name + ': ' + e.message);
        output.appendLine('  copado: ' + it.type + ' ' + it.name + ' failed - ' + e.message);
      }
    }
  });
  refreshSelective(pkg);
  refreshAll();
  if (failed.length) vscode.window.showWarningMessage('Downloaded ' + done.length + ' of ' + wanted.length + ' from Copado.', { modal: fromValidation, detail: failed.join('\n') });
  else if (!fromValidation) vscode.window.showInformationMessage('Downloaded ' + done.length + ' selective commit file' + (done.length === 1 ? '' : 's') + ' from Copado into ' + path.basename(o.folder) + '. Import them, or validate.');
  return done.length > 0;
}

/**
 * Phase 0: a read-only report of what the Copado org holds for one user story,
 * written to .copado/inspect/ and opened. Nothing in Copado is changed.
 */
async function cmdInspectStory() {
  requireTrust('Inspecting Copado runs the Salesforce CLI');
  const c = rc();
  if (!c.copadoOrg) {
    const p = await vscode.window.showInformationMessage('Set the Copado org first - the alias of the org where Copado runs, logged in with the Salesforce CLI.', 'Open settings');
    if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.copado.org');
    return;
  }
  const input = await vscode.window.showInputBox({
    title: 'Inspect a user story in Copado (read-only)',
    prompt: 'User story number or record id',
    placeHolder: 'US-0012345',
    ignoreFocusOut: true,
    validateInput: v => inspectLib.parseStoryRef(v) ? null : 'A story number such as US-0012345 or 12345, or a record id'
  });
  if (!input) return;
  const ref = inspectLib.parseStoryRef(input);
  const root = projectOrFolder();
  const api = copadoApi(c, root, (await apiVersion()) || '62.0');
  let result;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Inspecting ' + input + ' in Copado (' + c.copadoOrg + ')', cancellable: false }, async progress => {
    progress.report({ message: 'reading the story, its commits, promotions and files' });
    let localOrgs = [];
    try { localOrgs = await orgList(c, root); } catch (e) { /* no matching then */ }
    result = await inspectLib.inspect(ref, api, { localOrgs });
  });
  const text = redact(inspectLib.report(result), c.maskIdentities);
  const dir = await deps.storageDir('inspect');
  const file = vscode.Uri.joinPath(dir, result.story.name + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.md');
  await vscode.workspace.fs.writeFile(file, Buffer.from(text, 'utf8'));
  await vscode.window.showTextDocument(file, { preview: false });
  output.appendLine('copado: inspected ' + result.story.name + ' - ' + result.commits.length + ' commits, ' + result.promotions.length + ' promotions, ' + result.files.length + ' files; report ' + path.basename(file.fsPath));
  vscode.window.showInformationMessage('Inspection of ' + result.story.name + ' written to .copado/inspect. Read-only - nothing in Copado was changed.' +
    (c.maskIdentities ? '' : ' Turn on Mask identities before sharing it.'));
}

/** Read-only access to the Copado org through the Salesforce CLI. */
const clients = new Map();
function copadoApi(c, root, version) {
  const key = c.copadoOrg + '|' + version + '|' + root;
  if (!clients.has(key)) {
    const folder = require('./src/paths').insideProject(vscode.workspace.getConfiguration('cmr').get('storage.folder', '.copado'), '.copado');
    clients.set(key, createClient({ sfcli, sfPath: c.sfPath, org: c.copadoOrg, cwd: root, version,
      cacheFile: path.join(root, folder, 'cache', 'copado-describe.json'), onNote: t => output.appendLine('copado: ' + t) }));
  }
  return clients.get(key);
}

/**
 * Phase 1: everything for one user story, straight from Copado - its commit
 * file becomes the package, its selective-commit files go to the drop folder,
 * and its environment and the next one in the pipeline are matched to your CLI
 * logins - then the usual validation, with both orgs preselected.
 */
async function cmdPrepareStory() {
  requireTrust('Preparing a story runs the Salesforce CLI');
  const c = rc();
  if (!c.copadoOrg) {
    const p = await vscode.window.showInformationMessage('Set the Copado org first - the alias of the org where Copado runs, logged in with the Salesforce CLI.', 'Open settings');
    if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.copado.org');
    return;
  }
  const input = await vscode.window.showInputBox({ title: 'Prepare a user story from Copado', prompt: 'User story number or record id', placeHolder: 'US-0012345',
    ignoreFocusOut: true, validateInput: v => inspectLib.parseStoryRef(v) ? null : 'A story number such as US-0012345 or 12345, or a record id' });
  if (!input) return;
  const root = projectRoot();
  const api = copadoApi(c, root, (await apiVersion()) || '62.0');
  let localOrgs = [];
  let r;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing ' + input + ' from Copado (' + c.copadoOrg + ')' }, async progress => {
    progress.report({ message: 'finding the story, its commit file and selective-commit files' });
    try { localOrgs = await orgList(c, root); } catch (e) { /* asked for below */ }
    r = await inspectLib.inspect(inspectLib.parseStoryRef(input), api, { localOrgs, keepContent: true, only: ['User Story'], peekLimit: 100 });
  });
  const story = r.story;
  const commits = r.files.filter(f => f.content && f.what.kind === 'commit-json');
  if (!commits.length) {
    throw new Error('No Copado commit file on ' + story.name + '. Commit the story in Copado first - "Copado: Inspect User Story in Copado" shows what the story holds.');
  }
  // the commit file, kept with the story; the selective files, into the drop folder
  const storyDir = vscode.Uri.joinPath(await deps.storageDir('stories'), story.name);
  await vscode.workspace.fs.createDirectory(storyDir);
  const uris = [];
  for (const f of commits) {
    const uri = vscode.Uri.joinPath(storyDir, String(f.name).replace(/[\\/:*?"<>|]/g, '_'));
    await vscode.workspace.fs.writeFile(uri, f.content);
    uris.push(uri);
  }
  const selectiveFiles = r.files.filter(f => f.content && f.what.kind === 'selective');
  if (selectiveFiles.length) {
    const folder = path.join(root, require('./src/paths').insideProject(c.selFolder, 'conflict/selective'));
    fs.mkdirSync(folder, { recursive: true });
    for (const f of selectiveFiles) fs.writeFileSync(path.join(folder, String(f.name).replace(/[\\/:*?"<>|]/g, '_')), f.content);
  }
  output.appendLine('copado: ' + story.name + ' - ' + commits.length + ' commit file' + (commits.length === 1 ? '' : 's') + ', ' + selectiveFiles.length + ' selective-commit file' + (selectiveFiles.length === 1 ? '' : 's') + ' from Copado');

  // the package, from the commit file - pre-flight checks and the selective plan as usual
  await cmdPackage(uris[0], uris);
  if (!state.pkg) return;

  // the orgs: the story's environment, and where the pipeline sends it next
  const source = await orgForEnvironment(c, r, story.environmentId, story.environment, localOrgs, 'source - where the story was built');
  const target = story.next ? await orgForEnvironment(c, r, story.next.id, story.next.name, localOrgs, 'target - the next environment in the pipeline') : null;
  const go = await vscode.window.showInformationMessage(
    story.name + ' is prepared: ' + state.pkg.result.counts.deploy + ' components to deploy' + (selectiveFiles.length ? ', ' + selectiveFiles.length + ' selective-commit files ready to import' : '') + '.',
    { detail: (story.title ? story.title + '\n' : '') + 'Validate: ' + (source || 'choose') + '  \u2192  ' + (target || 'choose') + (story.next ? '' : '\n(No next environment found in the pipeline.)') },
    'Validate now');
  if (go === 'Validate now') await cmdValidate({ sourceOrg: source, targetOrg: target });
}

/**
 * The CLI org for a Copado environment: a remembered choice first, then the
 * org credential's username among your logins; otherwise you pick once and it
 * is remembered for this workspace.
 */
async function orgForEnvironment(c, r, envId, envName, localOrgs, role) {
  if (!envName) return null;
  const remembered = c.environmentOrgs && c.environmentOrgs[envName];
  if (remembered) return remembered;
  const cred = r.credentials.find(x => x.environmentId === envId || x.environment === envName);
  if (cred && cred.localAlias) return cred.localAlias;
  if (!localOrgs.length) {
    vscode.window.showWarningMessage('No Salesforce CLI login for the Copado environment ' + envName + '. Log in with: sf org login web --alias <name>');
    return null;
  }
  const pick = await vscode.window.showQuickPick(localOrgs.map(o => ({ label: o.alias || o.username, description: o.alias ? o.username : '', org: o })),
    { title: 'Which of your orgs is the Copado environment "' + envName + '"? (' + role + ')', placeHolder: 'Remembered for this workspace', ignoreFocusOut: true });
  if (!pick) return null;
  const value = pick.org.alias || pick.org.username;
  const all = Object.assign({}, c.environmentOrgs, { [envName]: value });
  await vscode.workspace.getConfiguration('cmr').update('copado.environmentOrgs', all, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return value;
}

async function cmdUndoSelective() {
  const storage = (await deps.storageDir()).fsPath;
  const record = selective.undo(storage);
  if (!record) { vscode.window.showInformationMessage('There is no selective import to undo.'); return; }
  if (state.pkg && state.pkg.selectiveImported) for (const it of record.items) state.pkg.selectiveImported.delete(it.type + '|' + it.name);
  if (state.pkg) refreshSelective(state.pkg);
  refreshAll();
  vscode.window.showInformationMessage('Undid the selective import of ' + record.items.length + ' file' + (record.items.length === 1 ? '' : 's') + ': the project files are restored and the downloads are back in the drop folder.');
}

async function apiVersion() {
  const c = rc();
  if (c.apiVersion) return String(c.apiVersion);
  try {
    const p = path.join(projectOrFolder(), 'sfdx-project.json');
    const v = manifest.apiVersionFrom(await fs.promises.readFile(p, 'utf8'));
    if (v) return v;
  } catch (e) { /* no project file */ }
  return '62.0';
}

/** Reads a hand-made package.xml into the same shape a commit produces. */
async function packageFromXml(uri) {
  const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const parsed = X.parse(text);
  if (!parsed.root || parsed.root.name !== 'Package') throw new Error(path.basename(uri.fsPath) + ' is not a package.xml.');
  const rows = [];
  for (const t of X.elements(parsed.root).filter(e => e.name === 'types')) {
    const type = X.childText(t, 'name');
    for (const m of X.elements(t).filter(e => e.name === 'members')) rows.push({ type, name: X.textOf(m), rawName: X.textOf(m), action: 'Add', source: path.basename(uri.fsPath) });
  }
  const c = rc();
  const result = manifest.build(rows, { warnStandardFields: c.warnStandardFields, testPattern: c.testPattern });
  return { result, version: X.childText(parsed.root, 'version') || await apiVersion(), sources: [uri], folder: vscode.Uri.file(path.dirname(uri.fsPath)), files: { deploy: uri, retrieve: uri, destructive: null }, changed: false, external: true };
}

/* ======================================================= branch conflicts */

async function cmdBranchCheck() {
  requireTrust('Branch conflicts run git in this folder');
  const c = rc();
  const root = await gitops.repoRoot(projectOrFolder());
  const version = await gitops.gitVersion(root);
  if (version && (version.major < 2 || (version.major === 2 && version.minor < 38))) {
    throw new Error('Branch conflicts need git 2.38 or newer (found ' + version.text + ').');
  }

  let target = c.targetBranch;
  let incoming = c.incomingBranch;
  if (c.confirmBranches || !target || !incoming) {
    const all = await gitops.branches(root);
    target = await pickBranch(all, target, 'Target branch - keeps everything (usually the environment you promote into)');
    if (!target) return;
    // with no default set, the branch you are on is the likeliest incoming one
    const current = await gitops.currentBranch(root);
    const incomingHint = incoming ? 'from settings' : 'current branch';
    if (!incoming && current && current !== target && current !== 'HEAD') incoming = current;
    incoming = await pickBranch(all.filter(b => b !== target), incoming, 'Incoming branch - your changes, wins a real conflict', incomingHint);
    if (!incoming) return;
  }

  const analysis = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: 'Comparing ' + incoming + ' into ' + target, cancellable: false
  }, async progress => {
    if (c.fetchFirst) {
      progress.report({ message: 'fetching ' + c.remote });
      try { await gitops.fetch(root, c.remote); } catch (e) { output.appendLine('Fetch skipped: ' + e.message); }
    }
    progress.report({ message: 'computing the merge (read-only)' });
    return gitops.analyse(root, target, incoming, {
      remote: c.remote, includeBothChanged: c.includeBothChanged, metadataOnly: c.metadataOnly
    });
  });

  state.branch = { root, analysis, current: await gitops.currentBranch(root), resolved: new Set() };
  refreshAll();
  vscode.commands.executeCommand('cmrBranchView.focus');

  const conflicts = analysis.files.filter(f => f.status === 'conflict').length;
  const both = analysis.files.length - conflicts;
  vscode.window.showInformationMessage(analysis.files.length
    ? incoming + ' \u2192 ' + target + ': ' + conflicts + ' git conflict' + (conflicts === 1 ? '' : 's') +
      (both ? ', ' + both + ' changed on both sides' : '') + '.'
    : incoming + ' merges into ' + target + ' cleanly.');
}

async function pickBranch(all, preferred, placeHolder, hint) {
  const items = [];
  if (preferred) items.push({ label: preferred, description: hint || 'from settings' });
  for (const b of all) if (b !== preferred) items.push({ label: b });
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  return pick ? pick.label : null;
}

async function branchVersions(file) {
  const a = state.branch.analysis;
  const root = state.branch.root;
  const [ancestor, target, incoming] = await Promise.all([
    gitops.show(root, a.base, file.path),
    gitops.show(root, a.target.sha, file.path),
    gitops.show(root, a.incoming.sha, file.path)
  ]);
  return { ancestor, target, incoming };
}

async function cmdBranchResolve(item) {
  if (!state.branch || !item || !item.file) return;
  const file = item.file;
  const a = state.branch.analysis;
  const v = await branchVersions(file);
  if (v.target === null || v.incoming === null) {
    vscode.window.showInformationMessage(path.basename(file.path) + ' exists on only one branch - nothing to merge. Opening a comparison instead.');
    return cmdBranchCompare(item);
  }
  if (!file.metadata) return cmdBranchCompare(item);

  const base = path.basename(file.path);
  const tUri = await deps.writeTemp('GIT_TARGET__' + base, v.target);
  const iUri = await deps.writeTemp('GIT_INCOMING__' + base, v.incoming);
  const aUri = v.ancestor !== null ? await deps.writeTemp('GIT_ANCESTOR__' + base, v.ancestor) : null;

  const workingUri = vscode.Uri.file(path.join(state.branch.root, file.path));
  const targetShort = a.target.ref.replace(new RegExp('^' + escapeRe(rc().remote) + '/'), '');
  if (state.branch.current && state.branch.current !== targetShort) {
    const go = await vscode.window.showWarningMessage(
      'You are on ' + state.branch.current + ', not ' + targetShort + '. Applying the merge writes it into your working copy of ' +
      state.branch.current + '. Check out ' + targetShort + ' first if that is where it belongs.',
      { modal: true }, 'Merge anyway');
    if (go !== 'Merge anyway') return;
  }
  if (!fs.existsSync(workingUri.fsPath)) {
    await fs.promises.mkdir(path.dirname(workingUri.fsPath), { recursive: true });
    await fs.promises.writeFile(workingUri.fsPath, v.target, 'utf8');
  }

  await deps.startSession(tUri, iUri, aUri, {
    applyToUri: workingUri,
    labels: {
      target: targetShort + ': ' + base,
      incoming: a.incoming.ref.replace(new RegExp('^' + escapeRe(rc().remote) + '/'), '') + ': ' + base,
      ancestor: 'merge-base ' + a.base.slice(0, 8)
    },
    onApplied: () => { state.branch.resolved.add(file.path); refreshAll(); }
  });
}

async function cmdBranchCompare(item) {
  if (!state.branch || !item || !item.file) return;
  const file = item.file;
  const a = state.branch.analysis;
  const v = await branchVersions(file);
  const base = path.basename(file.path);
  const left = await deps.writeTemp('GIT_TARGET__' + base, v.target === null ? '' : v.target);
  const right = await deps.writeTemp('GIT_INCOMING__' + base, v.incoming === null ? '' : v.incoming);
  await vscode.commands.executeCommand('vscode.diff', left, right,
    base + ': ' + a.target.ref + ' \u2194 ' + a.incoming.ref, { preview: true });
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ============================================================ validation */

async function cmdValidate(options) {
  requireTrust('Validation runs the Salesforce CLI in this folder');
  const c = rc();
  const root = projectRoot();
  const rerun = options.rerun && state.validation;
  const params = rerun ? Object.assign({}, state.validation.params) : {};
  // re-validating checks the project as it is now - it never retrieves over your fixes
  if (rerun) params.mode = 'workspace';
  if (!rerun && options.overlay) params.overlay = options.overlay;

  // The CLI is slow to start, so its checks begin now, in the background,
  // while you answer the first questions.
  const cliCheck = cliVersion(c);
  if (!rerun) orgList(c, root).catch(() => { /* reported when the picker needs it */ });

  if (!rerun) {
    params.mode = options.mode || c.validateSource;
    if (params.mode === 'ask') {
      const pick = await vscode.window.showQuickPick([
        { label: '$(cloud-download) Retrieve into this project, then validate', detail: 'sf project retrieve start with the package - overwrites the matching files in your package directory - then validates the project.', mode: 'retrieve' },
        { label: '$(file-code) Validate this project as it is', detail: 'No retrieve. For example after resolving branch conflicts or applying fixes.', mode: 'workspace' }
      ], { placeHolder: 'What should be validated?', ignoreFocusOut: true });
      if (!pick) return;
      params.mode = pick.mode;
    }
  }

  const cli = await busy(cliCheck, 'Checking the Salesforce CLI\u2026');
  if (!cli) {
    const p = await vscode.window.showErrorMessage(
      'The Salesforce CLI was not found (' + c.sfPath + '). Install it, or set its path in settings.', 'Open settings');
    if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.sf.path');
    return;
  }

  let pkg = state.pkg;
  if (!pkg) {
    const choice = await vscode.window.showQuickPick([
      { label: '$(json) From Copado commit JSON', how: 'json' },
      { label: '$(file) From an existing package.xml', how: 'xml' }
    ], { placeHolder: 'Which components?', ignoreFocusOut: true });
    if (!choice) return;
    if (choice.how === 'json') pkg = await cmdPackage();
    else {
      const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'package.xml': ['xml'] }, defaultUri: vscode.Uri.file(root) });
      if (!f || !f.length) return;
      pkg = await packageFromXml(f[0]);
      state.pkg = pkg;
    }
    if (!pkg) return;
  }
  if (!pkg.result.counts.deploy && !pkg.result.counts.destructive) throw new Error('Nothing to deploy in this package.');

  if (!rerun) {
    const load = refresh => orgList(c, root, refresh);
    if (params.mode === 'retrieve') {
      params.sourceOrg = await pickOrg(load, options.sourceOrg || c.sourceOrg, 'Source org - where the components are retrieved from', c.confirmOrgs);
      if (!params.sourceOrg) return;
    }
    params.targetOrg = await pickOrg(load, options.targetOrg || c.targetOrg, 'Target org - validated against, nothing is deployed', c.confirmOrgs);
    if (!params.targetOrg) return;
    const orgs = await load(false);
    const t = orgs.find(o => o.username === params.targetOrg || o.alias === params.targetOrg);
    if (t && !t.isSandbox && c.warnOnProduction) {
      const go = await vscode.window.showWarningMessage(
        (t.alias || t.username) + ' does not look like a sandbox. Validation is check-only - nothing is deployed - but tests will run there.',
        { modal: true }, 'Validate');
      if (go !== 'Validate') return;
    }
    const tests = await chooseTests(pkg);
    if (!tests) return;
    params.testLevel = tests.level;
    params.tests = tests.tests;
  }

  if (!(await applyPolicy(c, root, params))) return;
  if (pkg.result.selective && pkg.result.selective.size && (await importSelective(pkg, true)) === 'stop') return;
  if (!(await saveBeforeValidating(root))) return;
  const run = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: (params.mode === 'retrieve' ? 'Retrieving and validating against ' : 'Validating against ') + params.targetOrg, cancellable: true
  }, (progress, token) => execute(pkg, params, progress, token));
  if (!run) return;

  state.validation = Object.assign(run, { params });
  pkg.changed = false;
  publish(run);
}

/**
 * Org picker that opens straight away. While the CLI is still listing orgs it
 * shows a busy bar and a "loading" row; the list fills in when it arrives.
 * The last row reloads the list, for an org you have just logged in to.
 */
async function pickOrg(load, preferred, placeHolder, confirm) {
  if (preferred && !confirm) {
    const orgs = await busy(load(false), 'Loading orgs from the Salesforce CLI\u2026');
    const match = orgs.find(o => o.alias === preferred || o.username === preferred);
    if (match) return match.alias || match.username;
  }
  const qp = vscode.window.createQuickPick();
  qp.placeholder = placeHolder;
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;
  const waiting = [{ label: '$(sync~spin) Loading orgs from the Salesforce CLI\u2026', alwaysShow: true, inert: true }];

  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); qp.hide(); };
    const fill = refresh => {
      qp.busy = true;
      qp.items = waiting;
      load(refresh).then(orgs => {
        if (done) return;
        const match = preferred && orgs.find(o => o.alias === preferred || o.username === preferred);
        const items = orgs.map(o => ({
          label: (o.isSandbox ? '$(beaker) ' : '$(warning) ') + (o.alias || o.username),
          description: (o.alias ? o.username : '') + (match && o === match ? '  \u00b7  from settings' : ''),
          detail: o.isSandbox ? undefined : 'not a sandbox',
          value: o.alias || o.username,
          first: match && o === match
        })).sort((a, b) => (b.first ? 1 : 0) - (a.first ? 1 : 0));
        if (!items.length) items.push({ label: '$(info) No orgs are authorised - run "sf org login web", then reload', alwaysShow: true, inert: true });
        items.push({ label: '$(refresh) Reload the org list', alwaysShow: true, reload: true });
        qp.items = items;
        qp.busy = false;
      }, err => {
        if (done) return;
        qp.items = [{ label: '$(error) ' + err.message, alwaysShow: true, inert: true }, { label: '$(refresh) Try again', alwaysShow: true, reload: true }];
        qp.busy = false;
      });
    };
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (!sel || sel.inert) return;
      if (sel.reload) { fill(true); return; }
      finish(sel.value);
    });
    qp.onDidHide(() => { if (!done) { done = true; resolve(null); } qp.dispose(); });
    fill(false);
    qp.show();
  });
}

/* ---- the CLI is slow to start, so its answers are kept for the session */

const cliCache = { version: null, orgs: null };

function cliVersion(c) {
  if (!cliCache.version) {
    cliCache.version = sfcli.version(c.sfPath).then(v => { if (!v) cliCache.version = null; return v; });
  }
  return cliCache.version;
}

function orgList(c, root, refresh) {
  if (refresh || !cliCache.orgs) {
    cliCache.orgs = sfcli.listOrgs(c.sfPath, root).catch(e => { cliCache.orgs = null; throw e; });
  }
  return cliCache.orgs;
}

/** Waits for work already under way, showing a notification only if it is not done yet. */
async function busy(promise, title) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(r => setTimeout(r, 50));
  if (settled) return promise;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => promise);
}

async function chooseTests(pkg) {
  const c = rc();
  const hasApex = pkg.result.hasApex;
  if (!hasApex) return { level: c.testLevelWithoutApex || 'NoTestRun', tests: [] };
  if (c.testLevel === 'RunLocalTests' || c.testLevel === 'NoTestRun') return { level: c.testLevel, tests: [] };

  const remembered = ctx.workspaceState.get('cmr.lastTests', []);
  const suggested = Array.from(new Set([].concat(pkg.result.testClasses, c.defaultTests || [])));
  if (c.testLevel === 'RunSpecifiedTests' && suggested.length) return { level: 'RunSpecifiedTests', tests: suggested };

  const names = Array.from(new Set(suggested.concat(remembered)));
  let picked = [];
  if (names.length) {
    const sel = await vscode.window.showQuickPick(names.map(n => ({
      label: n,
      description: pkg.result.testClasses.indexOf(n) !== -1 ? 'in this package' : (remembered.indexOf(n) !== -1 ? 'used last time' : 'from settings'),
      picked: pkg.result.testClasses.indexOf(n) !== -1 || remembered.indexOf(n) !== -1
    })), { canPickMany: true, placeHolder: 'This package contains Apex - which test classes should run?' });
    if (!sel) return null;
    picked = sel.map(s => s.label);
  }
  const more = await vscode.window.showInputBox({
    prompt: 'Any other test classes? Comma separated - leave empty to continue.',
    placeHolder: 'MyServiceTest, MyHandlerTest'
  });
  if (more === undefined) return null;
  const extra = more.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const tests = Array.from(new Set(picked.concat(extra)));
  if (!tests.length) {
    const go = await vscode.window.showWarningMessage('No test classes chosen. The org may reject an Apex deployment without tests.',
      { modal: true }, 'Run local tests instead', 'Validate without tests');
    if (!go) return null;
    return go === 'Run local tests instead' ? { level: 'RunLocalTests', tests: [] } : { level: 'NoTestRun', tests: [] };
  }
  await ctx.workspaceState.update('cmr.lastTests', tests);
  return { level: 'RunSpecifiedTests', tests };
}

async function execute(pkg, params, progress, token) {
  const c = rc();
  const root = projectRoot();
  const project = deps.resolveProject();
  const log = l => output.appendLine('  ' + l);
  if (c.revealOutput) output.show(true);
  output.appendLine('');
  output.appendLine('\u2550\u2550 Validation \u00b7 ' + new Date().toLocaleString() + ' ' + '\u2550'.repeat(20));
  log((params.mode === 'retrieve' ? 'retrieve from ' + params.sourceOrg + ', then ' : '') +
    'validate against ' + params.targetOrg + ', tests ' + params.testLevel +
    (params.tests && params.tests.length ? ' (' + params.tests.join(', ') + ')' : ''));
  log('project ' + root + (project.source ? ' (' + project.source + ')' : ''));
  let dirs = ['force-app'];
  try { dirs = require('./src/paths').packageDirsOf(fs.readFileSync(path.join(root, 'sfdx-project.json'), 'utf8')); } catch (e) { /* default */ }
  log('source format, using the package director' + (dirs.length === 1 ? 'y ' : 'ies ') + dirs.join(', '));

  let retrieved = null;
  if (params.mode === 'retrieve' && !pkg.result.counts.retrieve) {
    log('nothing to retrieve - every component is a selective commit, deployed from the project as it is');
  } else if (params.mode === 'retrieve') {
    const args = { manifest: forCli(pkg.files.retrieve.fsPath, root), org: params.sourceOrg, wait: c.waitMinutes };
    const live = liveLog('retrieving from ' + params.sourceOrg, progress, sfcli.display(c.sfPath, sfcli.retrieveArgs(args)));
    try {
      retrieved = await sfcli.retrieve(c.sfPath, Object.assign(args, { cwd: root, token, onLine: live.onLine, onStatus: live.onStatus, progressIntervalMs: c.progressInterval * 1000, env: cliEnv(c) }));
    } finally { live.done(); }
    if (token.isCancellationRequested || !retrieved) return null;
    log('retrieved ' + retrieved.files + ' file' + (retrieved.files === 1 ? '' : 's') + ' into the project in ' + live.elapsed() +
      timeSplit(retrieved.orgWaitMs, live.ms()) + ' - Source Control shows what changed');
    for (const w of retrieved.warnings) log('retrieve warning: ' + w.problem);
  }

  // a promotion pre-check puts the resolved files over what was just retrieved
  if (params.mode === 'retrieve' && params.overlay) log(await params.overlay());

  const vargs = {
    org: params.targetOrg,
    manifest: forCli(pkg.files.deploy.fsPath, root),
    destructiveChanges: pkg.files.destructive ? forCli(pkg.files.destructive.fsPath, root) : undefined,
    testLevel: params.testLevel,
    tests: params.tests,
    wait: c.waitMinutes
  };
  const live = liveLog(params.testLevel === 'NoTestRun' ? 'validating (check-only)' : 'validating with ' + params.testLevel,
    progress, sfcli.display(c.sfPath, sfcli.validateArgs(vargs)));
  let result;
  try {
    result = await sfcli.validate(c.sfPath, Object.assign(vargs, { cwd: root, token, onLine: live.onLine, onStatus: live.onStatus, progressIntervalMs: c.progressInterval * 1000, env: cliEnv(c) }));
  } finally { live.done(); }
  if (token.isCancellationRequested || !result) return null;
  log('validation finished in ' + live.elapsed());

  const isRetrieveOnly = (t, n) => !!(pkg.result.retrieveOnly.get(t) && pkg.result.retrieveOnly.get(t).has(n));
  const failures = [];
  for (const f of result.componentFailures) {
    const fileUri = await locate(f, root);
    failures.push(Object.assign({}, f, { fileUri }, {
      suggestions: fixes.suggest(f, { isRetrieveOnly }).map(s => Object.assign(s, { applied: false }))
    }));
  }
  return {
    result, failures, advice: fixes.testAdvice(result), ranAt: new Date(),
    retrieveWarnings: retrieved ? retrieved.warnings : [],
    retrievedFiles: retrieved ? retrieved.files : 0
  };
}

/**
 * Shows a running CLI command in the output panel - the command itself, then
 * the CLI's own snapshots as they change - and keeps the progress notification
 * current: what the CLI is doing, without its own timers, and this command's
 * elapsed time, ticking every second.
 */
function liveLog(label, progress, command) {
  const started = Date.now();
  let doing = '';
  output.appendLine('');
  output.appendLine('  \u25b6 ' + command);
  const show = () => progress.report({ message: label + (doing ? ' \u00b7 ' + doing : '') + ' \u00b7 ' + elapsed(Date.now() - started) });
  // what the CLI is doing, in words: no spinner, no stage symbol, no timer of its own
  const note = text => {
    const t = String(text)
      .replace(/^\s*(?:[\u2800-\u28ff]|[|\/\\-](?=\s*[A-Za-z]))\s*/, '')
      .replace(/^[\s\u221a\u2713\u2714\u2716\u2717\u2718\u00d7\u25a0\u25a1\u25cb\u25cf\u25ef\u25b8\u25ba\u2022\u2026]+/, '')
      .replace(/\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b/gi, '')
      .replace(/\s+/g, ' ').trim();
    if (!t || /^elapsed( time)?:?$/i.test(t) || /[\u2500\u2014\u2013-]{3,}/.test(t) || !/[A-Za-z]/.test(t)) return;
    doing = t.slice(0, 70);
    show();
  };
  show();
  const ticker = setInterval(show, 1000);
  return {
    onLine: l => { output.appendLine('    ' + l); note(l); },
    onStatus: s => note(s),
    done: () => clearInterval(ticker),
    elapsed: () => elapsed(Date.now() - started),
    ms: () => Date.now() - started
  };
}

/** Where the time went: the org's own processing, against everything else. */
function timeSplit(orgMs, totalMs) {
  if (orgMs == null || !totalMs) return '';
  const local = Math.max(0, totalMs - orgMs);
  return ' (' + elapsed(orgMs) + ' waiting on the org, ' + elapsed(local) + ' in the CLI on this machine)';
}

/** Environment for CLI runs: SourceMember polling off, unless the setting turns it back on. */
function cliEnv(c) {
  return c.skipSourceTracking ? { SF_DISABLE_SOURCE_MEMBER_POLLING: 'true' } : {};
}

function elapsed(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

/** The failing file in the project: by the path the org reported, else by name. */
async function locate(f, root) {
  for (const rel of fixes.candidatePaths(f)) {
    const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (fs.existsSync(p)) return vscode.Uri.file(p);
  }
  const base = path.basename(String(f.fileName || '')).replace(/-meta\.xml$/, '');
  if (!base) return null;
  const found = await vscode.workspace.findFiles('**/' + escapeGlob(base) + '-meta.xml', '**/{node_modules,.sfdx,.sf,.copado}/**', 2);
  return found.length === 1 ? found[0] : null;
}

/** Metadata names can contain glob characters - "[N] Sample Profile". */
function escapeGlob(s) {
  return String(s).replace(/[[\]{}*?]/g, ch => '[' + ch + ']');
}

/** Validation reads files from disk, so unsaved edits would be invisible to it. */
async function saveBeforeValidating(root) {
  const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file' &&
    d.uri.fsPath.indexOf(root + path.sep) === 0);
  if (!dirty.length) return true;
  const go = await vscode.window.showWarningMessage(
    dirty.length + ' file' + (dirty.length === 1 ? ' in this project has' : 's in this project have') +
    ' unsaved changes. Validation reads the files from disk.', { modal: true },
    'Save and continue', 'Continue without saving');
  if (!go) return false;
  if (go === 'Save and continue') await Promise.all(dirty.map(d => d.save()));
  return true;
}

function publish(run) {
  const r = run.result;
  deployDiagnostics.clear();
  const byFile = new Map();
  for (const f of run.failures) {
    const uri = f.fileUri;
    if (!uri) continue;
    const line = Math.max(0, (f.line || 1) - 1);
    const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 500), f.problem,
      /warning/i.test(f.problemType) ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
    d.source = 'Copado validation';
    d.code = f.type;
    const key = uri.toString();
    if (!byFile.has(key)) byFile.set(key, { uri, list: [] });
    byFile.get(key).list.push(d);
  }
  for (const { uri, list } of byFile.values()) deployDiagnostics.set(uri, list);

  output.appendLine('');
  output.appendLine(r.success ? '  VALIDATED' : '  FAILED');
  if (r.id) output.appendLine('  deploy id ' + r.id);
  if (!r.success && cliError(run)) {
    output.appendLine('  ' + cliError(run));
    for (const a of r.actions) output.appendLine('    try: ' + a);
  }
  for (const f of run.failures) {
    output.appendLine('  ! ' + f.type + ' ' + f.fullName + (f.line ? ' line ' + f.line : '') + ': ' + f.problem);
    for (const s of f.suggestions) output.appendLine('      -> ' + s.title);
  }
  for (const a of run.advice) output.appendLine('  ? ' + a.title + ': ' + a.detail.split('\n')[0]);
  output.show(true);

  refreshAll();
  vscode.commands.executeCommand('cmrDeployView.focus');
  const errors = run.failures.length;
  const tests = r.testFailures.length;
  if (r.success) vscode.window.showInformationMessage('Validated against ' + run.params.targetOrg + ' - it would deploy.');
  else if (cliError(run)) vscode.window.showErrorMessage('Validation could not run: ' + cliError(run), 'Show output')
    .then(p => { if (p) output.show(true); });
  else vscode.window.showWarningMessage('Validation failed: ' + errors + ' component error' + (errors === 1 ? '' : 's') +
    (tests ? ', ' + tests + ' test failure' + (tests === 1 ? '' : 's') : '') + '. Fixes are in the Deploy Check panel.');
}

/**
 * The CLI's own message, when the failure is not about any component - a
 * rejected flag, an expired login, a timeout. Never leave "FAILED" bare.
 */
function cliError(run) {
  const r = run.result;
  if (r.success || run.failures.length || r.testFailures.length) return '';
  return (r.message || r.errorName || 'The Salesforce CLI reported a failure without details - run the command from the output panel in a terminal to see it.').trim();
}

/* ------------------------------------------------------------- fixing */

async function cmdApplyFix(item) {
  if (!item || !item.fix || item.fix.applied || !state.validation) return;
  const fix = item.fix;
  const f = item.failure;

  if (fix.kind === 'package') {
    const pkg = state.pkg;
    const { type, name } = fix.component;
    const add = (map) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(name); };
    const del = (map) => { const s = map.get(type); if (s) { s.delete(name); if (!s.size) map.delete(type); } };
    if (fix.op === 'add') { add(pkg.result.deploy); add(pkg.result.retrieve); del(pkg.result.retrieveOnly); }
    else { del(pkg.result.deploy); del(pkg.result.retrieve); if (pkg.result.selective) del(pkg.result.selective); }
    pkg.result.counts.deploy = count(pkg.result.deploy);
    if (pkg.result.selective) pkg.result.counts.selective = count(pkg.result.selective);
    pkg.result.counts.retrieve = count(pkg.result.retrieve);
    pkg.result.counts.retrieveOnly = count(pkg.result.retrieveOnly);
    if (!pkg.external) await writePackageFiles(pkg);
    pkg.changed = true;
    fix.applied = true;
    refreshAll();
    vscode.window.showInformationMessage(
      (fix.op === 'add' ? 'Added ' : 'Removed ') + type + ' ' + name + (fix.op === 'add' ? ' to' : ' from') +
      ' package.xml. Make the same change on the user story in Copado, then re-validate.', 'Re-validate')
      .then(p => { if (p) vscode.commands.executeCommand('cmr.validate.rerun'); });
    return;
  }

  if (fix.kind !== 'edit') return;
  const uri = f.fileUri;
  if (!uri) throw new Error('The file for ' + f.fullName + ' could not be found in this project.');
  const doc = await vscode.workspace.openTextDocument(uri);
  const after = fixes.applyEdit(doc.getText(), fix);
  if (after.count) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), after.text);
    await vscode.workspace.applyEdit(edit);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  fix.applied = true;
  refreshAll();
  vscode.window.showInformationMessage(after.count
    ? fix.title + ' - done (' + after.count + ' change' + (after.count === 1 ? '' : 's') + '). The file is left unsaved so you can review it.'
    : 'Nothing matched - the file may already be fixed.', 'Re-validate')
    .then(p => { if (p) vscode.commands.executeCommand('cmr.validate.rerun'); });
}

function count(map) { let n = 0; for (const s of map.values()) n += s.size; return n; }

async function cmdOpenFailure(item) {
  const f = item && item.failure;
  if (!f) return;
  const uri = f.fileUri;
  if (!uri) { vscode.window.showInformationMessage('No file to open for ' + f.fullName + '.'); return; }
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  if (f.line) {
    const pos = new vscode.Position(Math.max(0, f.line - 1), Math.max(0, (f.column || 1) - 1));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

async function cmdCopyErrors() {
  const v = state.validation;
  if (!v) { vscode.window.showInformationMessage('Run a validation first.'); return; }
  const L = [];
  L.push('## Validation against ' + v.params.targetOrg + ' - ' + (v.result.success ? 'passed' : 'failed'));
  L.push('');
  L.push('| | |');
  L.push('| --- | --- |');
  if (v.result.id) L.push('| Deploy id | `' + v.result.id + '` |');
  L.push('| Mode | ' + v.params.mode + (v.params.sourceOrg ? ' from ' + v.params.sourceOrg : '') + ' |');
  L.push('| Tests | ' + v.params.testLevel + (v.params.tests && v.params.tests.length ? ': ' + v.params.tests.join(', ') : '') + ' |');
  L.push('| Component errors | ' + v.failures.length + ' |');
  L.push('| Test failures | ' + v.result.testFailures.length + ' |');
  L.push('');
  if (v.failures.length) {
    L.push('| Component | Line | Error | Suggested fix |');
    L.push('| --- | --- | --- | --- |');
    for (const f of v.failures) {
      L.push('| ' + md(f.type + ' ' + f.fullName) + ' | ' + (f.line || '') + ' | ' + md(f.problem) + ' | ' +
        md(f.suggestions.map(s => (s.applied ? '\u2713 ' : '') + s.title).join('; ') || '-') + ' |');
    }
    L.push('');
  }
  for (const a of v.advice) L.push('- **' + md(a.title) + '** - ' + md(a.detail.split('\n')[0]));
  await vscode.env.clipboard.writeText(redact(L.join('\n'), rc().maskIdentities));
  vscode.window.showInformationMessage('Validation report copied as markdown.');
}

function md(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

/* ================================================================ views */

function provider(roots, children) {
  const emitter = new vscode.EventEmitter();
  return {
    onDidChangeTreeData: emitter.event,
    refresh: () => emitter.fire(),
    getTreeItem: i => i,
    getChildren: p => (p ? children(p) : roots())
  };
}

function refreshAll() {
  branchProvider.refresh();
  deployProvider.refresh();
  refreshMessages();
  vscode.commands.executeCommand('setContext', 'cmr.hasPackage', !!state.pkg);
  vscode.commands.executeCommand('setContext', 'cmr.hasValidation', !!state.validation);
  vscode.commands.executeCommand('setContext', 'cmr.hasBranchCheck', !!state.branch);
}

function refreshMessages() {
  const c = rc();
  branchTree.message = state.branch ? undefined
    : (c.incomingBranch && c.targetBranch
      ? 'Compare ' + c.incomingBranch + ' into ' + c.targetBranch + ' without touching your working tree.'
      : 'Compare two branches without touching your working tree. Set default branches in settings to skip the pickers.');
  deployTree.message = (state.pkg || state.validation) ? undefined
    : 'Generate a package.xml from a Copado commit JSON, then validate it against an org.';
  const pending = state.validation ? state.validation.failures.filter(f => f.suggestions.some(s => !s.applied)).length : 0;
  try {
    deployTree.badge = pending ? { value: pending, tooltip: pending + ' errors with fixes to review' } : undefined;
    const open = state.branch ? state.branch.analysis.files.filter(f => !state.branch.resolved.has(f.path)).length : 0;
    branchTree.badge = open ? { value: open, tooltip: open + ' files to look at' } : undefined;
  } catch (e) { /* older VS Code */ }
}

function item(label, opts) {
  const o = opts || {};
  const t = new vscode.TreeItem(label, o.children
    ? (o.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
    : vscode.TreeItemCollapsibleState.None);
  if (o.description !== undefined) t.description = o.description;
  if (o.tooltip) t.tooltip = o.tooltip;
  if (o.icon) t.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
  if (o.contextValue) t.contextValue = o.contextValue;
  if (o.command) t.command = o.command;
  Object.assign(t, o.data || {});
  return t;
}

/* ---- branch view */

function branchRoots() {
  if (!state.branch) return [];
  const b = state.branch;
  const a = b.analysis;
  const out = [item(a.incoming.ref + '  \u2192  ' + a.target.ref, {
    icon: 'git-merge',
    description: 'base ' + a.base.slice(0, 8) + (b.current ? '  \u00b7  on ' + b.current : ''),
    tooltip: new vscode.MarkdownString(
      '**Target** (keeps everything): `' + a.target.ref + '`\n\n**Incoming**: `' + a.incoming.ref + '`\n\n' +
      'Merge-base `' + a.base + '` is used as the ancestor, so every merge here is three-way.\n\n' +
      'Computed read-only - your working tree was not touched.'),
    contextValue: 'cmrBranchHeader'
  })];
  if (!a.files.length) {
    out.push(item('No conflicts', { icon: 'pass', description: 'merges cleanly' }));
    return out;
  }
  const conflicts = a.files.filter(f => f.status === 'conflict');
  const both = a.files.filter(f => f.status === 'both');
  if (conflicts.length) out.push(item('Git conflicts', { children: true, expanded: true, icon: 'warning', color: 'list.warningForeground', description: String(conflicts.length), data: { group: conflicts } }));
  if (both.length) out.push(item('Changed on both branches', {
    children: true, expanded: !conflicts.length, icon: 'diff-modified', description: both.length + '  \u00b7  git may merge these line by line',
    tooltip: 'Git can auto-merge these, but a line-by-line merge of metadata XML can still produce duplicates or broken structure. Worth a semantic merge.',
    data: { group: both }
  }));
  return out;
}

function branchChildren(p) {
  if (!p.group) return [];
  return p.group.map(f => {
    const done = state.branch.resolved.has(f.path);
    return item(path.basename(f.path), {
      icon: done ? 'pass-filled' : (f.metadata ? 'symbol-structure' : 'file'),
      color: done ? 'testing.iconPassed' : undefined,
      description: (done ? 'merged \u00b7 ' : '') + path.dirname(f.path),
      tooltip: f.path + (f.metadata ? '\nClick to merge it three-way.' : '\nNot metadata XML - click to compare the two versions.'),
      contextValue: f.metadata ? 'cmrBranchMeta' : 'cmrBranchOther',
      command: { command: f.metadata ? 'cmr.git.resolveFile' : 'cmr.git.compareFile', title: 'Open', arguments: [{ file: f }] },
      data: { file: f }
    });
  });
}

/* ---- deploy view */

function deployRoots() {
  const out = [];
  if (state.pkg) {
    const r = state.pkg.result;
    const warnings = r.notes.filter(n => n.severity === 'warning').length;
    out.push(item('Package', {
      children: true, expanded: !state.validation,
      icon: 'package',
      description: r.counts.deploy + ' to deploy' + (r.counts.retrieveOnly ? ' \u00b7 ' + r.counts.retrieveOnly + ' retrieve only' : '') +
        (r.counts.selective ? ' \u00b7 ' + r.counts.selective + ' selective' : '') +
        ' \u00b7 API ' + state.pkg.version + (state.pkg.changed ? ' \u00b7 changed, re-validate' : ''),
      tooltip: 'From ' + state.pkg.sources.map(s => path.basename(s.fsPath)).join(', ') + (warnings ? '\n' + warnings + ' pre-flight warnings' : ''),
      contextValue: 'cmrPackage',
      data: { kind: 'package' }
    }));
  }
  const v = state.validation;
  if (v) {
    const r = v.result;
    out.push(item(r.success ? 'Validated' : 'Validation failed', {
      icon: r.success ? 'pass-filled' : 'error',
      color: r.success ? 'testing.iconPassed' : 'testing.iconFailed',
      description: v.params.targetOrg + ' \u00b7 ' + v.params.testLevel + ' \u00b7 ' + v.ranAt.toLocaleTimeString(),
      tooltip: (r.id ? 'Deploy id ' + r.id + '\n' : '') + (v.params.mode === 'retrieve' ? 'Retrieved from ' + v.params.sourceOrg : 'Validated from the workspace') +
        (v.params.tests && v.params.tests.length ? '\nTests: ' + v.params.tests.join(', ') : ''),
      contextValue: 'cmrValidation'
    }));
    if (cliError(v)) {
      out.push(item(cliError(v), {
        icon: 'error', color: 'testing.iconFailed', description: r.errorName || 'Salesforce CLI',
        tooltip: new vscode.MarkdownString('**The Salesforce CLI stopped before checking any component.**\n\n' + cliError(v) +
          (r.actions.length ? '\n\n' + r.actions.map(a => '- ' + a).join('\n') : '')),
        command: { command: 'cmr.showReport', title: 'Show output' }
      }));
    }
    if (v.params.mode === 'retrieve') {
      out.push(item('Retrieved into this project', {
        icon: 'cloud-download',
        description: v.retrievedFiles + ' file' + (v.retrievedFiles === 1 ? '' : 's') + ' \u00b7 click to see the changes',
        tooltip: 'Retrieved from ' + v.params.sourceOrg + ' with sf project retrieve start, into your package directories. Source Control shows exactly what changed.',
        command: { command: 'workbench.view.scm', title: 'Show changes' }
      }));
    }
    if (v.retrieveWarnings && v.retrieveWarnings.length) {
      out.push(item('Retrieve warnings', { children: true, expanded: true, icon: 'warning', color: 'list.warningForeground', description: String(v.retrieveWarnings.length), data: { kind: 'retrieveWarnings' } }));
    }
    if (v.failures.length) {
      out.push(item('Component errors', { children: true, expanded: true, icon: 'bug', description: String(v.failures.length), data: { kind: 'errors' } }));
    }
    if (r.testFailures.length || r.coverageWarnings.length) {
      out.push(item('Tests and coverage', { children: true, expanded: true, icon: 'beaker', description: (r.testFailures.length + r.coverageWarnings.length) + '', data: { kind: 'tests' } }));
    }
  }
  return out;
}

function deployChildren(p) {
  if (p.kind === 'package') {
    const pkg = state.pkg;
    const kids = [];
    for (const [label, uri] of [['package.xml', pkg.files.deploy], ['package-retrieve.xml', pkg.files.retrieve !== pkg.files.deploy ? pkg.files.retrieve : null], ['destructiveChanges.xml', pkg.files.destructive]]) {
      if (!uri) continue;
      kids.push(item(label, { icon: 'file-code', description: vscode.workspace.asRelativePath(uri), command: { command: 'cmr.package.openFile', title: 'Open', arguments: [uri] } }));
    }
    for (const n of pkg.result.notes) {
      kids.push(item(n.message, {
        icon: n.severity === 'warning' ? 'warning' : 'info',
        color: n.severity === 'warning' ? 'list.warningForeground' : undefined,
        tooltip: n.message
      }));
    }
    return kids;
  }
  if (p.kind === 'errors') {
    const groups = new Map();
    for (const f of state.validation.failures) {
      const k = f.type + ' ' + f.fullName;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    return Array.from(groups.entries()).map(([k, list]) => item(k, {
      children: true, expanded: groups.size <= 6, icon: 'symbol-class', description: String(list.length),
      data: { kind: 'component', list }
    }));
  }
  if (p.kind === 'component') {
    return p.list.map(f => item(f.problem, {
      children: f.suggestions.length > 0, expanded: true,
      icon: 'error', color: 'testing.iconFailed',
      description: f.line ? 'line ' + f.line : '',
      tooltip: new vscode.MarkdownString('`' + f.type + ' ' + f.fullName + '`\n\n' + f.problem +
        (f.fileUri ? '\n\n' + f.fileUri.fsPath : '') + (f.suggestions.length ? '' : '\n\nNo automatic fix for this one.')),
      command: { command: 'cmr.validate.openFailure', title: 'Open', arguments: [{ failure: f }] },
      data: { kind: 'failure', failure: f }
    }));
  }
  if (p.kind === 'failure') {
    return p.failure.suggestions.map(s => item(s.title, {
      icon: s.applied ? 'pass-filled' : (s.kind === 'package' ? 'package' : s.kind === 'info' ? 'info' : 'wrench'),
      color: s.applied ? 'testing.iconPassed' : undefined,
      description: s.applied ? 'applied' : (s.kind === 'package' ? 'package' : s.kind === 'info' ? 'advice' : 'edit'),
      tooltip: s.detail,
      contextValue: s.applied ? 'cmrFixApplied' : s.kind === 'info' ? 'cmrAdvice' : 'cmrFix',
      data: { fix: s, failure: p.failure }
    }));
  }
  if (p.kind === 'retrieveWarnings') {
    return state.validation.retrieveWarnings.map(w => item(w.problem, {
      icon: 'warning', color: 'list.warningForeground', description: w.fileName, tooltip: (w.fileName ? w.fileName + '\n' : '') + w.problem
    }));
  }
  if (p.kind === 'tests') {
    return state.validation.advice.map(a => item(a.title, {
      icon: /^Coverage/.test(a.title) ? 'graph' : 'beaker', color: 'list.warningForeground',
      description: a.detail.split('\n')[0], tooltip: a.detail
    }));
  }
  return [];
}

module.exports = { activate, state };
