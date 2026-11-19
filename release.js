'use strict';

const vscode = require('vscode');
const manual = require('./manualUi');
const path = require('path');
const fs = require('fs');
const compare = require('./compareUi');
const manifest = require('./src/manifest');
const policies = require('./src/guard');
const lifecycle = require('./src/lifecycle');
const history = require('./src/history');
const httpx = require('./src/http');
const inspectLib = require('./src/copadoInspect');
const promotionLib = require('./src/promotion');
const { createClient } = require('./src/copadoClient');
const repoHost = require('./src/repoHost');
const branchCheck = require('./src/branchCheck');
const { redact } = require('./src/redact');
const gitops = require('./src/gitops');
const sfcli = require('./src/sfcli');
const fixes = require('./src/fixes');
const X = require('./src/xmlParser');
const { projectFolder, forCli } = require('./src/paths');

let deps;
let secrets = null;
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
  secrets = context.secrets;
  ctx = context;
  output = d.output;
  deployDiagnostics = vscode.languages.createDiagnosticCollection('copadoDeploy');
  context.subscriptions.push(deployDiagnostics);

  branchProvider = provider(branchRoots, branchChildren);
  deployProvider = provider(deployRoots, deployChildren);
  branchTree = vscode.window.createTreeView('cmrBranchView', { treeDataProvider: branchProvider, showCollapseAll: true });
  deployTree = vscode.window.createTreeView('cmrDeployView', { treeDataProvider: deployProvider, showCollapseAll: true });
  // when no section has anything to show, the sidebar is one button to the page (its welcome content)
  context.subscriptions.push(vscode.window.createTreeView('cmrStart', { treeDataProvider: { getChildren: () => [], getTreeItem: x => x } }));
  context.subscriptions.push(branchTree, deployTree);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('cmr.sf.path')) { cliCache.version = null; cliCache.orgs = null; }
    if (e.affectsConfiguration('cmr.http') || e.affectsConfiguration('http.proxy') || e.affectsConfiguration('http.proxyStrictSSL')) configureNetwork();
  }));
  configureNetwork();
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
  cmd('cmr.policy.create', cmdCreatePolicy);
  cmd('cmr.copado.inspect', () => cmdInspectStory());
  cmd('cmr.copado.prepare', () => cmdPrepareStory());
  cmd('cmr.repo.connect', cmdConnectRepo);
  cmd('cmr.repo.forget', cmdForgetRepo);
  cmd('cmr.repo.validateStory', () => validateFromBranch());
  const helpers = { output, deps, rc, cmd, requireTrust, projectRoot, apiVersion, copadoApi, cmdValidate, runBranchCheck, orgForEnvironment, orgList, sfcli, needCopado,
    credentialsFor, validatePromotionBranch, validateFromBranch, prepareStory: cmdPrepareStory, inspectStory: cmdInspectStory, ancestorFor, onValidation, validationStatus, showCopadoErrors, readinessReport, ensureRepo };
  exported.helpers = helpers;
  require('./promotionUi').activate(context, helpers);
  // the promotion open on the page is in use: never removed by the clean-up
  if (deps.inUse) deps.inUse(() => require('./promotionUi').openDirs());
  require('./lifecycleUi').activate(context, helpers);
  const page = require('./releasePage');
  manual.activate(context, { startSession: (...a) => deps.startSession(...a), generatePackage, storageDir: sub => deps.storageDir(sub), showPage: nav => page.show(nav) }, cmd);
  // the Compare tab: the connected repository only - it never asks for a token
  compare.activate(context, { host: connectedHost, packageDirs, storageDir: sub => deps.storageDir(sub), startSession: (...a) => deps.startSession(...a) });
  page.activate(context, require('./promotionUi'), require('./lifecycleUi'), cmd, manual, compare);
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
    targetOrg: c.get('org.target', ''),
    confirmOrgs: c.get('org.confirm', true),
    testLevel: c.get('validate.testLevel', 'ask'),
    testLevelWithoutApex: c.get('validate.testLevelWithoutApex', 'NoTestRun'),
    testPattern: c.get('validate.testClassPattern', 'Test$'),
    defaultTests: c.get('validate.defaultTests', []),
    waitMinutes: c.get('validate.waitMinutes', 60),
    warnOnProduction: c.get('validate.warnOnProduction', true),
    revealOutput: c.get('validate.revealOutput', true),
    progressInterval: Math.max(0, Number(c.get('validate.progressInterval', 0)) || 0),
    copadoOrg: c.get('copado.org', ''),
    repoUrl: c.get('repo.url', ''),
    repoProvider: c.get('repo.provider', 'auto'),
    featureBranch: c.get('repo.featureBranch', 'feature/{story}'),
    environmentOrgs: c.get('copado.environmentOrgs', {}),
    maskIdentities: c.get('output.maskIdentities', false),
    guard: { allowedTargetOrgs: c.get('guard.allowedTargetOrgs', []), blockedTargetOrgs: c.get('guard.blockedTargetOrgs', []),
      allowProduction: c.get('guard.allowProduction', true), minimumTestLevel: c.get('guard.minimumTestLevel', {}), environments: c.get('guard.environments', {}) },
    promotionBranch: c.get('repo.promotionBranch', 'promotion/{promotion}'),
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
  await writePackageFiles(pkg);
  state.pkg = pkg;

  output.clear();
  output.appendLine('Package from ' + files.map(f => path.basename(f.fsPath)).join(', '));
  output.appendLine('');
  for (const line of manifest.summary(result, version)) output.appendLine(line);
  output.appendLine('Written to ' + vscode.workspace.asRelativePath(pkg.folder));
  output.show(true);

  reveal('cmrDeployView');
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
  pkg.files.retrieve = pkg.files.deploy;
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
async function applyPolicy(c, root, params, pkg, quiet) {
  let fileText = null;
  try { fileText = fs.readFileSync(path.join(root, 'copado-policy.json'), 'utf8'); } catch (e) { /* no policy file */ }
  const { policy, source, error } = policies.resolvePolicy(fileText, c.guard);
  if (error) output.appendLine('policy: ' + error);
  let orgs = [];
  try { orgs = await orgList(c, root); } catch (e) { /* checked by name only */ }
  const known = orgs.find(o => o.alias === params.targetOrg || o.username === params.targetOrg);
  // an org the CLI cannot describe is treated as production - the stricter reading
  const org = { alias: known ? known.alias : params.targetOrg, username: known ? known.username : params.targetOrg, isSandbox: known ? known.isSandbox : false };
  params.username = known ? known.username : (/@/.test(params.targetOrg) ? params.targetOrg : null);
  const r = policies.check(policy, org, params.testLevel, { environment: params.environment, username: params.username, hasApex: !!(pkg && pkg.result.hasApex) });
  params.coverageRule = r.coverage != null ? r.coverage : null;
  if (r.environmentRule && !quiet) output.appendLine('policy: the ' + params.environment + ' stage rules from ' + source + ' apply' +
    (r.environmentRule.requiredTargetUser.length ? ' - validate as ' + r.environmentRule.requiredTargetUser.join(' or ') : '') +
    (r.environmentRule.minimumTestLevel ? ' - tests at least ' + r.environmentRule.minimumTestLevel : '') + (r.coverage != null ? ' - coverage ' + r.coverage + '%' : ''));
  if (!r.allowed) {
    emit({ step: 'error', message: 'Not checked: ' + r.reason + '.' });
    const pick = await vscode.window.showErrorMessage('Validation blocked: ' + r.reason + '.', { modal: true, detail: 'Rule from ' + source + '.' }, 'Open policy');
    if (pick === 'Open policy') {
      if (source === 'copado-policy.json') vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'copado-policy.json')));
      else vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.guard');
    }
    return false;
  }
  if (r.raisedFrom && !quiet) {
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
  if (Object.keys(g.environments || {}).length) body.environments = g.environments;
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage('copado-policy.json created. Adjust it, then commit it - it applies to everyone who opens this project.');
}

/**
 * Phase 0: a read-only report of what the Copado org holds for one user story,
 * written to .copado/inspect/ and opened. Nothing in Copado is changed.
 */
/** The report of what Copado holds about a story - for the story on the page, or one asked for. */
async function cmdInspectStory(storyInput) {
  requireTrust('Inspecting Copado runs the Salesforce CLI');
  const c = rc();
  if (!c.copadoOrg) {
    const p = await vscode.window.showInformationMessage('Set the Copado org first - the alias of the org where Copado runs, logged in with the Salesforce CLI.', 'Open settings');
    if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.copado.org');
    return;
  }
  const input = typeof storyInput === 'string' && storyInput ? storyInput : await vscode.window.showInputBox({
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
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking up ' + input + ' in Copado', cancellable: false }, async progress => {
    progress.report({ message: 'Reading the story and everything attached to it' });
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
  if (deps.copadoApi) return deps.copadoApi(c, root, version);   // the tests' stand-in Copado org
  const key = c.copadoOrg + '|' + version + '|' + root;
  if (!clients.has(key)) {
    const folder = require('./src/paths').insideProject(vscode.workspace.getConfiguration('cmr').get('storage.folder', '.copado'), '.copado');
    clients.set(key, createClient({ sfcli, sfPath: c.sfPath, org: c.copadoOrg, cwd: root, version,
      cacheFile: path.join(root, folder, 'cache', 'copado-describe.json'), onNote: t => output.appendLine('copado: ' + t) }));
  }
  return clients.get(key);
}

/** True when the Copado org is set; otherwise says how to set it. */
function needCopado(c) {
  if (c.copadoOrg) return true;
  vscode.window.showInformationMessage('Set the Copado org first - the alias of the org where Copado runs, logged in with the Salesforce CLI.', 'Open settings')
    .then(p => { if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.copado.org'); });
  return false;
}

/**
 * Everything for one user story, straight from Copado: its commit file
 * becomes the package (with the usual pre-flight checks), and it is validated
 * from its feature branch against the next environment in the pipeline.
 */
/** The story's package.xml from its commit - for the story on the page, or one asked for. */
async function cmdPrepareStory(storyInput) {
  requireTrust('Preparing a story runs the Salesforce CLI');
  const c = rc();
  if (!needCopado(c)) return;
  const input = typeof storyInput === 'string' && storyInput ? storyInput : await vscode.window.showInputBox({ title: 'Prepare a user story from Copado', prompt: 'User story number or record id', placeHolder: 'US-0012345',
    ignoreFocusOut: true, validateInput: v => inspectLib.parseStoryRef(v) ? null : 'A story number such as US-0012345 or 12345, or a record id' });
  if (!input) return;
  const root = projectRoot();
  const api = copadoApi(c, root, (await apiVersion()) || '62.0');
  let r;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Getting ' + input + ' ready' }, async progress => {
    progress.report({ message: 'Finding what the story changed' });
    let localOrgs = [];
    try { localOrgs = await orgList(c, root); } catch (e) { /* matched later */ }
    r = await inspectLib.inspect(inspectLib.parseStoryRef(input), api, { localOrgs, keepContent: true, only: ['User Story'], peekLimit: 100 });
  });
  const story = r.story;
  const commits = r.files.filter(f => f.content && f.what.kind === 'commit-json');
  if (!commits.length) {
    throw new Error('No Copado commit file on ' + story.name + '. Commit the story in Copado first - "Copado: Inspect User Story in Copado" shows what the story holds.');
  }
  const storyDir = vscode.Uri.joinPath(await deps.storageDir('stories'), story.name);
  await vscode.workspace.fs.createDirectory(storyDir);
  const uris = [];
  for (const f of commits) {
    const uri = vscode.Uri.joinPath(storyDir, String(f.name).replace(/[\\/:*?"<>|]/g, '_'));
    await vscode.workspace.fs.writeFile(uri, f.content);
    uris.push(uri);
  }
  output.appendLine('copado: ' + story.name + ' - ' + commits.length + ' commit file' + (commits.length === 1 ? '' : 's') + ' from Copado');
  await cmdPackage(uris[0], uris);
  if (!state.pkg) return;
  const go = await vscode.window.showInformationMessage(story.name + ' is prepared: ' + state.pkg.result.counts.deploy + ' components to deploy.',
    { detail: (story.title ? story.title + '\n' : '') + 'Validate from its feature branch against ' + (story.next ? story.next.name + ', the next environment in the pipeline.' : 'an org you choose (no next environment found in the pipeline).') },
    'Validate from feature branch');
  if (go === 'Validate from feature branch') await validateFromBranch(story.name);
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
  const cred = (r.credentials || []).find(x => x.localAlias && (x.environmentId === envId || x.environment === envName));
  if (cred) return cred.localAlias;
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

/** The Copado environment a CLI org stands for, from cmr.copado.environmentOrgs. */
function environmentOf(c, org) {
  const hit = Object.entries(c.environmentOrgs || {}).find(([, v]) => v && org && String(v).toLowerCase() === String(org).toLowerCase());
  return hit ? hit[0] : null;
}

/** The org credentials of some environments, each matched to a CLI login by username. */
async function credentialsFor(api, envIds, localOrgs) {
  const ids = envIds.filter(Boolean);
  if (!ids.length) return [];
  const rows = await inspectLib.robustQuery(api, ['Name', 'copado__Username__c', 'copado__Environment__c', 'copado__Environment__r.Name'], 'copado__Org__c',
    'copado__Environment__c IN (' + ids.map(i => "'" + String(i).replace(/[^A-Za-z0-9]/g, '') + "'").join(', ') + ')', 'LIMIT 200', []);
  return rows.map(r => {
    const user = r.copado__Username__c;
    const local = (localOrgs || []).find(l => user && l.username && l.username.toLowerCase() === String(user).toLowerCase());
    return { name: r.Name, environment: (r.copado__Environment__r || {}).Name, environmentId: r.copado__Environment__c, username: user, localAlias: local ? (local.alias || local.username) : null };
  });
}

/* ---------------------------------------------------------- the repository */

const tokenKey = host => 'cmr.repoToken:' + host;

/**
 * Connects the repository: address, provider, token - and the same check as
 * by hand. With an address from Copado's Git Repository record, only the
 * token is asked for. Returns true when connected.
 */
async function cmdConnectRepo(prefill) {
  const c = rc();
  const known = prefill && prefill.url && repoHost.parseRepoUrl(prefill.url, c.repoProvider) ? prefill.url : null;
  const url = known || await vscode.window.showInputBox({ title: 'Connect the repository Copado commits to', prompt: 'The repository\u2019s address - as in its clone link or Copado\u2019s Git Repository record',
    value: (prefill && prefill.url) || c.repoUrl, placeHolder: 'https://dev.azure.com/org/project/_git/repo, https://github.com/owner/repo, https://gitlab.com/group/repo, https://bitbucket.org/workspace/repo',
    ignoreFocusOut: true, validateInput: v => repoHost.parseRepoUrl(v, c.repoProvider) ? null : 'Not a recognised Azure DevOps, GitHub, GitLab or Bitbucket address - for a self-hosted server, set Repository \u203a Provider first' });
  if (!url) return false;
  const repo = repoHost.parseRepoUrl(url, c.repoProvider);
  const hint = { azure: 'a personal access token with Code: Read', github: 'a fine-grained token with Contents: Read-only', gitlab: 'a personal or project access token with read_repository',
    bitbucket: 'an API token with read:repository:bitbucket, as your-email:token - or a repository access token' }[repo.provider];
  const token = await vscode.window.showInputBox({ title: 'Token for ' + repo.repo + ' on ' + repo.host + (known ? ' (the address is from ' + prefill.from + ')' : ''),
    prompt: 'Read-only: ' + hint + '. Kept in VS Code\u2019s encrypted secret storage.', password: true, ignoreFocusOut: true });
  if (!token) return false;
  const res = await repoHost.createHost(repo, token.trim()).check();
  if (!res.ok) { vscode.window.showErrorMessage('Not connected: ' + res.message + '.'); return false; }
  await secrets.store(tokenKey(repo.host), token.trim());
  await vscode.workspace.getConfiguration('cmr').update('repo.url', url.trim(), vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  output.appendLine('repository: connected to ' + repo.provider + ' ' + repo.host + ' (' + repo.repo + ') - read-only' + (known ? ', address from ' + prefill.from : ''));
  vscode.window.showInformationMessage('Connected to ' + repo.repo + ' on ' + repo.host + ': ' + res.message + '.');
  return true;
}

async function cmdForgetRepo() {
  const repo = repoHost.parseRepoUrl(rc().repoUrl, rc().repoProvider);
  if (!repo) { vscode.window.showInformationMessage('No repository is connected.'); return; }
  await secrets.delete(tokenKey(repo.host));
  vscode.window.showInformationMessage('The token for ' + repo.host + ' is removed from this machine.');
}

/**
 * The connected repository and its token. When none is connected, the
 * address is read from Copado's Git Repository record of the pipeline, so only
 * the token needs asking for. o: { api, pipelineId, toId, fromId, envId }.
 */
/**
 * A promotion file's common ancestor: the file at the merge-base of the story's feature branch and the
 * promotion's destination branch, from the connected repository. Never asks for anything - null when nothing
 * is connected, the setting is off (cmr.merge.useAncestor), or the repository cannot say.
 */
async function ancestorFor(o) {
  if (vscode.workspace.getConfiguration('cmr').get('merge.useAncestor', true) === false) return null;
  const repo = repoHost.parseRepoUrl(rc().repoUrl, rc().repoProvider);
  const token = repo ? await secrets.get(tokenKey(repo.host)) : null;
  if (!repo || !token || !o.featureBranch || !o.destinationBranch) return null;
  try {
    const host = repoHost.createHost(repo, token);
    const sha = await host.mergeBase(o.featureBranch, o.destinationBranch);
    const body = sha ? await host.readFileAt(sha, o.rel) : null;
    if (body) output.appendLine('merge: the common ancestor of ' + o.rel + ' from ' + repo.repo + ' at ' + sha.slice(0, 8) + ' (' + o.featureBranch + ' and ' + o.destinationBranch + ')');
    return body;
  } catch (e) { output.appendLine('merge: no common ancestor for ' + o.rel + ' - ' + e.message); return null; }
}

/** The connected repository, or null - never asking for anything. */
async function connectedHost() {
  const repo = repoHost.parseRepoUrl(rc().repoUrl, rc().repoProvider);
  const token = repo ? await secrets.get(tokenKey(repo.host)) : null;
  return repo && token ? repoHost.createHost(repo, token) : null;
}

/** The project's package directories, from sfdx-project.json - force-app when it says nothing. */
function packageDirs() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'sfdx-project.json'), 'utf8'));
    const dirs = (j.packageDirectories || []).map(d => d && d.path).filter(Boolean);
    return dirs.length ? dirs : ['force-app'];
  } catch (e) { return ['force-app']; }
}

async function ensureRepo(o) {
  const c = rc();
  const parse = () => repoHost.parseRepoUrl(rc().repoUrl, rc().repoProvider);
  let repo = parse();
  let token = repo ? await secrets.get(tokenKey(repo.host)) : null;
  if (repo && token) return { repo, token };
  let fromCopado = repo ? { url: c.repoUrl, from: 'settings' } : null;
  if (!repo && o && o.api) {
    try {
      const pid = o.pipelineId || await lifecycle.pipelineIdFor(o.api, o, []);
      const pl = pid ? (await lifecycle.pipelines(o.api)).find(p => p.id === pid) : null;
      const rec = pl && pl.repoId ? await lifecycle.repositoryUri(o.api, pl.repoId) : null;
      const url = rec ? repoHost.fromCopadoUri(rec.uri) : null;
      if (url) fromCopado = { url, from: 'Copado\u2019s Git Repository record ' + rec.name };
      else if (rec) output.appendLine('repository: Copado\u2019s Git Repository record ' + rec.name + ' has the address "' + rec.uri + '", which is not one the connectors read');
    } catch (e) { output.appendLine('repository: could not read its address from Copado - ' + e.message); }
  }
  const msg = fromCopado && fromCopado.from !== 'settings' ? 'Connect ' + fromCopado.url + ' - the address is from Copado, only a read-only token is needed.' : 'Connect the repository first - read-only, with a token.';
  const p = await vscode.window.showInformationMessage(msg, 'Connect Repository');
  if (p !== 'Connect Repository') return null;
  if (!(await cmdConnectRepo(fromCopado))) return null;
  repo = parse();
  token = repo ? await secrets.get(tokenKey(repo.host)) : null;
  return repo && token ? { repo, token } : null;
}

/**
 * Validates a story from its feature branch: the commit file gives the
 * components, the branch gives their files exactly as Copado committed them,
 * in a separate check workspace - no retrieve, the project untouched. The
 * branch is the one Copado's records name when they do, else the pattern.
 */
async function validateFromBranch(storyInput) {
  requireTrust('Validating from the branch runs the Salesforce CLI');
  const c = rc();
  if (!needCopado(c)) return;
  const input = storyInput || await vscode.window.showInputBox({ title: 'Validate a user story from its feature branch', prompt: 'User story number', placeHolder: 'US-0012345', ignoreFocusOut: true,
    validateInput: v => inspectLib.parseStoryRef(v) ? null : 'A story number such as US-0012345' });
  if (!input) return;
  const root = projectRoot();
  const version = (await apiVersion()) || '62.0';
  const api = copadoApi(c, root, version);
  let localOrgs = [];
  let r, fb, hotfix = false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Getting the changes of ' + input + ' from Copado' }, async () => {
    try { localOrgs = await orgList(c, root); } catch (e) { /* asked below */ }
    r = await inspectLib.inspect(inspectLib.parseStoryRef(input), api, { localOrgs, keepContent: true, only: ['User Story'], peekLimit: 100 });
    fb = await lifecycle.featureBranch(api, { id: r.story.id, name: r.story.name }, c.featureBranch);
    if (r.story.pipelineId && r.story.baseBranch) {
      try { hotfix = lifecycle.isHotfix(r.story, await lifecycle.pipeline(api, r.story.pipelineId)); } catch (e) { /* not a hotfix then */ }
    }
  });
  const rows = [].concat(...r.files.filter(f => f.content && f.what.kind === 'commit-json').map(f => JSON.parse(f.content.toString('utf8'))));
  if (!rows.length) throw new Error('No Copado commit file on ' + r.story.name + ' - commit the story in Copado first.');
  output.appendLine('branch check: ' + r.story.name + (hotfix ? ' is a hotfix (based on the production branch)' : '') + ' - its branch is ' + fb.branch + ', from ' + fb.source);
  const target = r.story.next ? await orgForEnvironment(c, r, r.story.next.id, r.story.next.name, localOrgs, 'target - validated against, nothing is deployed') : null;
  await runBranchCheck({ rows, branches: [fb.branch], name: r.story.name, target, label: r.story.name + (hotfix ? ' (hotfix)' : ''), environment: r.story.next ? r.story.next.name : null,
    api, pipelineId: r.story.pipelineId, envId: r.story.environmentId, meta: { source: hotfix ? 'hotfix branch' : 'feature branch', stories: [r.story.name] } });
}

/**
 * Validates exactly what a promotion deploys: its components, read from the
 * promotion branch Copado builds (promotion/{promotion}), check-only against
 * its destination org. p: { id, name, to, toId, from, fromId, pipelineId }.
 */
async function validatePromotionBranch(p) {
  requireTrust('Validating the promotion branch runs the Salesforce CLI');
  const c = rc();
  if (!needCopado(c)) return;
  const root = projectRoot();
  const api = copadoApi(c, root, (await apiVersion()) || '62.0');
  const branch = String(c.promotionBranch || 'promotion/{promotion}').split('{promotion}').join(p.name);
  let stories = [], comp, localOrgs = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Getting the changes of ' + p.name + ' from Copado' }, async () => {
    try { localOrgs = await orgList(c, root); } catch (e) { /* asked below */ }
    stories = await lifecycle.promotionStories(api, p.id);
    comp = await lifecycle.promotionComponents(api, p.id, stories);
  });
  if (!comp.rows.length) throw new Error('No component list for ' + p.name + ': Copado attaches "Copado Promotion changes" to a promotion, and none of its stories has a commit file.');
  output.appendLine('promotion branch: ' + p.name + ' - ' + branch + ', ' + comp.rows.length + ' component row(s) from the ' + comp.source);
  const creds = await credentialsFor(api, [p.toId], localOrgs);
  const target = await orgForEnvironment(c, { credentials: creds }, p.toId, p.to, localOrgs, 'target - validated against, nothing is deployed');
  await runBranchCheck({ rows: comp.rows, branches: [branch], name: p.name + '-branch', target, label: 'promotion branch of ' + p.name, environment: p.to,
    api, pipelineId: p.pipelineId, toId: p.toId, fromId: p.fromId, requireBranch: true,
    missingBranch: branch + ' is not in the repository yet - Copado creates it when the promotion merges its stories. The branch name comes from Repository \u203a Promotion branch (now "' + c.promotionBranch + '").',
    meta: { source: 'promotion branch', promotion: p.name, stories: stories.map(s => s.name) } });
}

/**
 * Builds a check workspace from one or more branches - each component from the
 * first branch that has it - puts any given files on top, and validates it
 * check-only. Shared by the story route, the promotion branch and the pre-check.
 * o: { rows, branches, name, overlay: [{ rel, file }], target, label, environment, api, pipelineId, toId, requireBranch, missingBranch, meta }
 */
async function runBranchCheck(o) {
  // the page follows the whole run - the files read from the branch too, not only the check with Salesforce
  const prevHooks = runHooks, prevQuiet = runQuiet;
  if (o.onEvent) { runHooks = o.onEvent; runQuiet = !!o.quiet; }
  try { return await branchCheckOnce(o); }
  finally { runHooks = prevHooks; runQuiet = prevQuiet; }
}

async function branchCheckOnce(o) {
  const c = rc();
  const root = projectRoot();
  const version = (await apiVersion()) || '62.0';
  const conn = await ensureRepo({ api: o.api || (c.copadoOrg ? copadoApi(c, root, version) : null), pipelineId: o.pipelineId, toId: o.toId, fromId: o.fromId, envId: o.envId });
  if (!conn) return;
  const { repo, token } = conn;
  const host = repoHost.createHost(repo, token);
  // the branch already holds the committed versions: selective commits deploy as they are; retrieve-only items are not deployed
  const result = manifest.build(manifest.parseCommit(JSON.stringify(o.rows), 'commit'), { actions: Object.assign({}, c.actions, { SelectiveCommit: 'deploy', RetrieveOnly: 'ignore' }) });
  const dir = path.join((await deps.storageDir('branch-check')).fsPath, o.name.replace(/[^\w.-]/g, '_'));
  let fallback = null;
  try { fallback = fs.readFileSync(path.join(root, 'sfdx-project.json'), 'utf8'); } catch (e) { /* default */ }
  const written = [];
  let remaining = result.deploy;
  const absent = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Getting the files from the repository' }, async progress => {
    let first = true;
    for (let i = 0; i < o.branches.length && remaining.size; i++) {
      progress.report({ message: 'Reading ' + o.branches[i] });
      emit({ step: 'files', state: 'running', message: 'Reading the files from ' + o.branches[i] });
      let exists = true;
      try { exists = await host.branchExists(o.branches[i]); } catch (e) { output.appendLine('branch check: could not look up ' + o.branches[i] + ' - ' + e.message); }
      if (!exists) { absent.push(o.branches[i]); continue; }
      const b = await branchCheck.buildWorkspace(host, o.branches[i], remaining, dir, { fallbackProject: fallback, keep: !first });
      first = false;
      written.push(...b.written);
      const left = new Map();
      for (const m of b.missing) { const k = m.indexOf(' '); const t = m.slice(0, k), n = m.slice(k + 1).replace(/ \(type not supported\)$/, ''); (left.get(t) || left.set(t, new Set()).get(t)).add(n); }
      remaining = left;
    }
  });
  if (absent.length) output.appendLine('branch check: not in ' + repo.repo + ': ' + absent.join(', '));
  if (absent.length === o.branches.length) {
    throw new Error(o.missingBranch || (absent.join(', ') + ' ' + (absent.length === 1 ? 'is' : 'are') + ' not in ' + repo.repo + '. Check Repository \u203a Feature branch (now "' + c.featureBranch + '").'));
  }
  if (o.requireBranch && absent.length) throw new Error(o.missingBranch || absent.join(', ') + ' is not in ' + repo.repo + '.');
  // files to put on top - the pre-check's resolutions
  fs.mkdirSync(dir, { recursive: true });
  for (const f of o.overlay || []) {
    const to = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.file, to);
    const comp = require('./src/promotionWork').componentOf(f.rel);
    if (comp && remaining.get(comp.type)) { remaining.get(comp.type).delete(comp.name); if (!remaining.get(comp.type).size) remaining.delete(comp.type); }
  }
  // files not resolved yet are left out of the check entirely - never taken from a branch in their place
  const leftOut = [];
  for (const rel of o.exclude || []) {
    const comp = require('./src/promotionWork').componentOf(rel);
    if (!comp) continue;
    const set = result.deploy.get(comp.type);
    if (set && set.delete(comp.name)) { leftOut.push(comp.type + ' ' + comp.name); if (!set.size) result.deploy.delete(comp.type); }
    if (remaining.get(comp.type)) { remaining.get(comp.type).delete(comp.name); if (!remaining.get(comp.type).size) remaining.delete(comp.type); }
  }
  const missing = [...remaining].flatMap(([t, ns]) => [...ns].map(n => t + ' ' + n)).sort();
  emit({ step: 'files', state: 'done', fromBranches: written.length, resolved: (o.overlay || []).length, leftOut, missing, branches: o.branches.filter(b => !absent.includes(b)),
    message: written.length + ' file' + (written.length === 1 ? '' : 's') + ' from the branch' + ((o.overlay || []).length ? ', ' + o.overlay.length + ' resolved' : '') + (leftOut.length ? ', ' + leftOut.length + ' left out' : '') });
  const used = o.branches.filter(b => !absent.includes(b));
  output.appendLine('branch check: ' + o.label + ' - ' + written.length + ' file(s) from ' + repo.repo + ' (' + used.join(', ') + ')' +
    ((o.overlay || []).length ? ', ' + o.overlay.length + ' resolved file(s) on top' : '') + (missing.length ? '; not on the branch: ' + missing.join(', ') : ''));
  if (!written.length && !(o.overlay || []).length) throw new Error('Nothing of ' + o.label + ' was found on ' + used.join(', ') + '. Check Repository \u203a Feature branch (now "' + c.featureBranch + '").');
  if (missing.length) {
    const go = await vscode.window.showWarningMessage(missing.length + ' component(s) are not on ' + used.join(', ') + '.', { modal: true, detail: missing.join('\n') + '\n\nValidate the rest?' }, 'Validate the rest');
    if (go !== 'Validate the rest') return;
    for (const [t, ns] of remaining) { const set = result.deploy.get(t); if (set) { ns.forEach(n => set.delete(n)); if (!set.size) result.deploy.delete(t); } }
  }
  fs.mkdirSync(path.join(dir, 'manifest'), { recursive: true });
  const deployFile = path.join(dir, 'manifest', 'package.xml');
  fs.writeFileSync(deployFile, manifest.toPackageXml(result.deploy, version));
  let destructive = null;
  if (result.destructive.size) { destructive = path.join(dir, 'manifest', 'destructiveChanges.xml'); fs.writeFileSync(destructive, manifest.toPackageXml(result.destructive, version)); }
  result.counts.deploy = [...result.deploy.values()].reduce((n, x) => n + x.size, 0);
  if (!result.counts.deploy) throw new Error('The package for ' + o.label + ' is empty - nothing in it can be deployed. Check the commit or promotion change list.');
  output.appendLine('branch check: package.xml with ' + result.counts.deploy + ' component(s) - ' + [...result.deploy].map(([t, n]) => t + ' ' + n.size).join(', '));
  const pkg = { result, version, sources: [], folder: vscode.Uri.file(path.dirname(deployFile)), changed: false, workspace: dir,
    files: { deploy: vscode.Uri.file(deployFile), retrieve: vscode.Uri.file(deployFile), destructive: destructive ? vscode.Uri.file(destructive) : null } };
  await cmdValidate({ root: dir, pkg, mode: 'workspace', targetOrg: o.target, label: o.label, environment: o.environment, meta: Object.assign({ branches: used }, o.meta || {}), onEvent: o.onEvent, quiet: o.quiet });
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
    location: vscode.ProgressLocation.Notification, title: 'Comparing ' + incoming + ' with ' + target, cancellable: false
  }, async progress => {
    if (c.fetchFirst) {
      progress.report({ message: 'Getting the latest from the server' });
      try { await gitops.fetch(root, c.remote); } catch (e) { output.appendLine('Fetch skipped: ' + e.message); }
    }
    progress.report({ message: 'Working out what would conflict \u2013 nothing is changed' });
    return gitops.analyse(root, target, incoming, {
      remote: c.remote, includeBothChanged: c.includeBothChanged, metadataOnly: c.metadataOnly
    });
  });

  state.branch = { root, analysis, current: await gitops.currentBranch(root), resolved: new Set() };
  reveal('cmrBranchView');

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
  const o = options || {};
  runHooks = o.onEvent || null;
  runQuiet = !!o.quiet;
  try { return await validateOnce(o); }
  finally { runHooks = null; runQuiet = false; }
}

async function validateOnce(options) {
  requireTrust('Validation runs the Salesforce CLI in this folder');
  const c = rc();
  const root = options.root || projectRoot();
  const rerun = options.rerun && state.validation;
  if (rerun && !state.validation.pkg) {
    vscode.window.showInformationMessage('Re-validate repeats a validation run from here - this result came from ' + (state.validation.params.label || 'Copado') + '.');
    return;
  }
  const params = rerun ? Object.assign({}, state.validation.params) : {};
  // re-validating checks the project as it is now - it never retrieves over your fixes
  if (rerun) params.mode = 'workspace';
  if (!rerun) { params.root = options.root || null; params.label = options.label || null; params.environment = options.environment || null; params.meta = options.meta || null; }

  // The CLI is slow to start, so its checks begin now, in the background,
  // while you answer the first questions.
  const cliCheck = cliVersion(c);
  if (!rerun) orgList(c, root).catch(() => { /* reported when the picker needs it */ });

  if (!rerun) params.mode = 'workspace';

  const cli = await busy(cliCheck, 'Making sure the Salesforce CLI is ready');
  if (!cli) {
    const p = await vscode.window.showErrorMessage(
      'The Salesforce CLI was not found (' + c.sfPath + '). Install it, or set its path in settings.', 'Open settings');
    if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.sf.path');
    return;
  }

  let pkg = options.pkg || (rerun ? state.validation.pkg : null) || state.pkg;
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
    params.targetOrg = await pickOrg(load, options.targetOrg || c.targetOrg, 'Target org - validated against, nothing is deployed' + (params.environment ? ' (Copado environment ' + params.environment + ')' : ''), c.confirmOrgs);
    if (!params.targetOrg) return;
    if (!params.environment) params.environment = environmentOf(c, params.targetOrg);
    // a target the policy refuses is said before any question about tests
    if (!(await applyPolicy(c, projectRoot(), Object.assign({}, params, { testLevel: 'RunAllTestsInOrg' }), pkg, true))) return;
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

  // the team policy lives in the project, whichever workspace is validated
  if (!(await applyPolicy(c, projectRoot(), params, pkg))) return;
  if (!(await saveBeforeValidating(root))) return;
  announce({ running: true, label: params.label || 'the project', target: params.targetOrg, username: params.username, environment: params.environment, at: new Date().toISOString() });
  let run;
  try {
    run = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Validating against ' + (params.environment || params.targetOrg) + (params.testLevel === 'NoTestRun' ? '' : ', with tests'), cancellable: true
    }, (progress, token) => execute(pkg, params, progress, token));
  } catch (e) { announce(null); throw e; }
  if (!run) { announce(null); return; }

  state.validation = Object.assign(run, { params, pkg });
  coverageCheck(run, pkg, params);
  pkg.changed = false;
  publish(run);
  await record(run, pkg, params);
  const r = run.result, below = run.coverageCheck ? run.coverageCheck.below : [];
  emit({ step: 'done', success: !!r.success && !below.length,
    failures: run.failures.slice(0, 200).map(f => ({ type: f.type, fullName: f.fullName, problem: f.problem, line: f.line || null, file: f.fileUri ? path.relative(params.root || projectRoot(), f.fileUri.fsPath).split(path.sep).join('/') : null,
      fixes: (f.suggestions || []).map(x => x.title) })),
    tests: r.testFailures.slice(0, 100).map(t => ({ name: t.name || '', method: t.methodName || t.method || '', message: t.message || '' })),
    coverage: below.map(x => ({ name: x.name, percent: x.percent })), coverageRule: run.coverageCheck ? run.coverageCheck.rule : null,
    cliError: !r.success && !run.failures.length && !r.testFailures.length ? (cliError(run) || r.message || 'Salesforce could not run the check') : null });
}

/** The stage's coverage rule, checked against the Apex the package deploys. */
function coverageCheck(run, pkg, params) {
  if (params.coverageRule == null || !pkg.result.hasApex) return;
  let pattern;
  try { pattern = new RegExp(rc().testPattern || 'Test$', 'i'); } catch (e) { pattern = /Test$/i; }
  const names = [...(pkg.result.deploy.get('ApexClass') || []), ...(pkg.result.deploy.get('ApexTrigger') || [])].filter(n => !pattern.test(n));
  const stage = params.environment || params.targetOrg;
  if (params.testLevel === 'NoTestRun') {
    run.advice.push({ title: 'Coverage not measured for the ' + stage + ' stage’s ' + params.coverageRule + '%', detail: 'No tests ran, so coverage could not be checked.' });
    return;
  }
  const r = policies.belowCoverage(run.result.coverage, params.coverageRule, names);
  run.coverageCheck = Object.assign({ rule: params.coverageRule }, r);
  if (r.below.length) run.advice.unshift({ title: 'Coverage below the ' + stage + ' stage’s ' + params.coverageRule + '%', detail: r.below.map(x => x.name + ' ' + x.percent + '%').join(', ') + '\nThe team policy asks for ' + params.coverageRule + '% per class at this stage.' });
  if (r.unreported.length) run.advice.push({ title: 'No coverage reported for ' + r.unreported.length + ' class' + (r.unreported.length === 1 ? '' : 'es'), detail: r.unreported.join(', ') + '\nThe tests that ran did not touch them.' });
}

/** The run, kept in the project's validation history for the readiness report. */
async function record(run, pkg, params) {
  const r = run.result, m = params.meta || {};
  try {
    history.add((await deps.storageDir('history')).fsPath, {
      label: params.label || 'the project', source: m.source || (params.root ? 'check workspace' : 'project'), branches: m.branches || [], stories: m.stories || [], promotion: m.promotion || null,
      environment: params.environment || null, targetOrg: params.targetOrg, username: params.username || null, testLevel: params.testLevel, success: !!r.success && !(run.coverageCheck && run.coverageCheck.below.length),
      cliSuccess: !!r.success, deployId: r.id || null, components: pkg.result.counts.deploy, componentErrors: run.failures.length, testFailures: r.testFailures.length,
      coverage: (r.coverage || []).map(x => ({ name: x.name, percent: x.percent })), coverageRule: params.coverageRule, belowCoverage: run.coverageCheck ? run.coverageCheck.below : []
    });
  } catch (e) { output.appendLine('history: not recorded - ' + e.message); }
}

/* ---- a run the page follows step by step (the pre-check): its events, and no Output panel popping up */

let runHooks = null, runQuiet = false;
function emit(ev) { if (runHooks) { try { runHooks(Object.assign({ at: new Date().toISOString() }, ev)); } catch (e) { /* the listener */ } } }

/* ---- what the page shows about the latest validation */

const listeners = new Set();
let latest = null;
function announce(v) { latest = v; for (const f of listeners) { try { f(v); } catch (e) { /* a listener */ } } }
function onValidation(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }
function validationStatus() { return latest; }

/**
 * Org picker that opens straight away. While the CLI is still listing orgs it
 * shows a busy bar and a "loading" row; the list fills in when it arrives.
 * The last row reloads the list, for an org you have just logged in to.
 */
async function pickOrg(load, preferred, placeHolder, confirm) {
  if (preferred && !confirm) {
    const orgs = await busy(load(false), 'Getting your Salesforce logins');
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
  const root = params.root || projectRoot();
  const project = deps.resolveProject();
  const log = l => output.appendLine('  ' + l);
  if (c.revealOutput && !runQuiet) output.show(true);
  emit({ step: 'check', state: 'running', message: 'Validating against ' + (params.environment || params.targetOrg) + (params.testLevel === 'NoTestRun' ? '' : ', with tests'),
    target: params.targetOrg, username: params.username || null, environment: params.environment || null, tests: params.testLevel !== 'NoTestRun' });
  output.appendLine('');
  output.appendLine('\u2550\u2550 Validation \u00b7 ' + new Date().toLocaleString() + ' ' + '\u2550'.repeat(20));
  log((params.label ? params.label + ': ' : '') + 'validate against ' + params.targetOrg + ', tests ' + params.testLevel +
    (params.tests && params.tests.length ? ' (' + params.tests.join(', ') + ')' : ''));
  log('validating as ' + (params.username || 'the user ' + params.targetOrg + ' logs in as') + (params.environment ? ' - Copado environment ' + params.environment : '') +
    (params.meta && params.meta.branches && params.meta.branches.length ? ' - from ' + params.meta.branches.join(', ') : ''));
  log('project ' + root + (project.source ? ' (' + project.source + ')' : ''));
  let dirs = ['force-app'];
  try { dirs = require('./src/paths').packageDirsOf(fs.readFileSync(path.join(root, 'sfdx-project.json'), 'utf8')); } catch (e) { /* default */ }
  log('source format, using the package director' + (dirs.length === 1 ? 'y ' : 'ies ') + dirs.join(', '));

  const vargs = {
    org: params.targetOrg,
    manifest: forCli(pkg.files.deploy.fsPath, root),
    destructiveChanges: pkg.files.destructive ? forCli(pkg.files.destructive.fsPath, root) : undefined,
    testLevel: params.testLevel,
    tests: params.tests,
    wait: c.waitMinutes
  };
  const live = liveLog('Getting started',
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
  return { result, failures, advice: fixes.testAdvice(result), ranAt: new Date() };
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
  const show = () => progress.report({ message: (doing || label) + ' \u00b7 ' + elapsed(Date.now() - started) });
  // what the CLI is doing, in words: no spinner, no stage symbol, no timer of its own
  const note = text => {
    const t = String(text)
      .replace(/^\s*(?:[\u2800-\u28ff]|[|\/\\-](?=\s*[A-Za-z]))\s*/, '')
      .replace(/^[\s\u221a\u2713\u2714\u2716\u2717\u2718\u00d7\u25a0\u25a1\u25cb\u25cf\u25ef\u25b8\u25ba\u2022\u2026]+/, '')
      .replace(/\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b/gi, '')
      .replace(/\s+/g, ' ').trim();
    if (!t || /^elapsed( time)?:?$/i.test(t) || /[\u2500\u2014\u2013-]{3,}/.test(t) || !/[A-Za-z]/.test(t)) return;
    // the CLI's own words stay in the Output panel; the notification says what is happening, plainly
    const plain = require('./src/plain').phase(t);
    if (!plain || plain === doing) return;
    if (plain === 'Getting started' && doing) return;   // never back to the start once under way
    doing = plain;
    emit({ step: 'check', phase: plain });
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
  if (!runQuiet) output.show(true);
  const below = run.coverageCheck ? run.coverageCheck.below : [];
  announce({ running: false, label: run.params.label || 'the project', target: run.params.targetOrg, username: run.params.username, environment: run.params.environment,
    at: new Date().toISOString(), success: !!r.success && !below.length, errors: run.failures.length, tests: r.testFailures.length, below: below.length, copado: run.params.mode === 'copado' });

  if (runQuiet) { refreshAll(); return; }
  reveal('cmrDeployView');
  const errors = run.failures.length;
  const tests = r.testFailures.length;
  if (r.success && below.length) vscode.window.showWarningMessage('Validated successfully against ' + run.params.targetOrg + ', but coverage is below the ' + (run.params.environment || run.params.targetOrg) + ' stage\u2019s ' + run.coverageCheck.rule + '%: ' + below.map(x => x.name + ' ' + x.percent + '%').join(', ') + '.');
  else if (r.success) vscode.window.showInformationMessage('Validated successfully against ' + run.params.targetOrg + '.');
  else if (cliError(run)) vscode.window.showErrorMessage('Validation could not run: ' + cliError(run), 'Show output')
    .then(p => { if (p) output.show(true); });
  else vscode.window.showWarningMessage('Validation failed against ' + run.params.targetOrg + ': ' + errors + ' component error' + (errors === 1 ? '' : 's') +
    (tests ? ', ' + tests + ' test failure' + (tests === 1 ? '' : 's') : '') + '. See Deploy Check for the fixes.');
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
    const pkg = state.validation.pkg;
    if (!pkg) { vscode.window.showInformationMessage('Make this change on the user story in Copado - this result came from Copado\u2019s own deployment.'); return; }
    if (pkg.workspace && fix.op === 'add') {
      vscode.window.showInformationMessage('Add ' + fix.component.type + ' ' + fix.component.name + ' to the user story in Copado and commit it - this validation reads its files from the branch, so it has to be on the branch too.');
      return;
    }
    const { type, name } = fix.component;
    const add = (map) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(name); };
    const del = (map) => { const s = map.get(type); if (s) { s.delete(name); if (!s.size) map.delete(type); } };
    if (fix.op === 'add') { add(pkg.result.deploy); add(pkg.result.retrieve); del(pkg.result.retrieveOnly); }
    else { del(pkg.result.deploy); del(pkg.result.retrieve); if (pkg.result.selective) del(pkg.result.selective); }
    pkg.result.counts.deploy = count(pkg.result.deploy);
    if (pkg.result.selective) pkg.result.counts.selective = count(pkg.result.selective);
    pkg.result.counts.retrieve = count(pkg.result.retrieve);
    pkg.result.counts.retrieveOnly = count(pkg.result.retrieveOnly);
    if (pkg.workspace) fs.writeFileSync(pkg.files.deploy.fsPath, manifest.toPackageXml(pkg.result.deploy, pkg.version));
    else if (!pkg.external) await writePackageFiles(pkg);
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
  L.push('| From | ' + md(v.params.meta && v.params.meta.branches && v.params.meta.branches.length ? v.params.meta.branches.join(', ') : v.params.label || 'the project') + ' |');
  if (v.params.environment) L.push('| Copado environment | ' + md(v.params.environment) + ' |');
  if (v.params.username) L.push('| Validated as | ' + md(v.params.username) + ' |');
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

/* ======================================================= network */

/** The proxy and certificates for every request: cmr.http.proxy, else VS Code's http.proxy, else the environment. */
function configureNetwork() {
  const c = vscode.workspace.getConfiguration('cmr');
  const h = vscode.workspace.getConfiguration('http');
  let ca = null;
  const caFile = c.get('http.caFile', '');
  if (caFile) { try { ca = fs.readFileSync(caFile, 'utf8'); } catch (e) { output.appendLine('network: cannot read the CA file ' + caFile + ' - ' + e.message); } }
  const noProxy = h.get('noProxy', []);
  httpx.configure({ proxy: c.get('http.proxy', '') || h.get('proxy', '') || '', strictSSL: h.get('proxyStrictSSL', true) !== false, ca,
    noProxy: Array.isArray(noProxy) ? noProxy.join(',') : String(noProxy || '') });
}

/* ======================================================= after Copado deploys */

/**
 * Component errors from Copado's own deployment, put in the Deploy Check
 * panel with the same file lookup and fix advice as a validation of ours.
 * o: { label, environment }.
 */
async function showCopadoErrors(failures, o) {
  const root = projectRoot();
  const list = [];
  for (const f of failures) {
    const fileUri = await locate(f, root);
    list.push(Object.assign({}, f, { fileUri, suggestions: fixes.suggest(f, { isRetrieveOnly: () => false }).map(s => Object.assign(s, { applied: false })) }));
  }
  const result = { id: null, status: 'Failed', success: false, componentFailures: failures, testFailures: [], coverageWarnings: [], coverage: [], message: '', errorName: '', actions: [] };
  const run = { result, failures: list, advice: [], ranAt: new Date(), pkg: null,
    params: { targetOrg: o.environment || 'Copado', testLevel: 'Copado deployment', mode: 'copado', label: o.label, environment: o.environment || null } };
  state.validation = run;
  publish(run);
  return list.map(f => ({ type: f.type, fullName: f.fullName, problem: f.problem, line: f.line, file: f.fileUri ? vscode.workspace.asRelativePath(f.fileUri) : null,
    fixes: f.suggestions.map(s => s.title) }));
}

/* ======================================================= readiness */

/**
 * The readiness report for a promotion, written under .copado/reports/ and
 * opened. o: { promotion: { id, name, status, to } }.
 */
async function readinessReport(o) {
  const c = rc();
  if (!needCopado(c)) return null;
  const root = projectRoot();
  const api = copadoApi(c, root, (await apiVersion()) || '62.0');
  let data;
  const p = o.promotion;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Putting together the readiness report for ' + p.name }, async () => {
    const stories = await lifecycle.promotionStories(api, p.id);
    const full = await lifecycle.storiesByIds(api, stories.map(s => s.id));
    const comp = await lifecycle.promotionComponents(api, p.id, stories);
    const per = await lifecycle.storyComponents(api, stories);
    let files = 0;
    try { files = await promotionLib.unresolvedCount(api, p.id); } catch (e) { /* unknown */ }
    data = { name: p.name, status: p.status, to: p.to, stories: full.length ? full : stories, components: comp.rows,
      overlaps: lifecycle.forecast(Object.fromEntries(stories.map(s => [s.name, (per[s.id] || {}).rows || []]))),
      missing: stories.filter(s => !per[s.id]).map(s => s.name), conflicts: [{ promotion: p.name, status: p.status, files, open: files > 0 }].filter(x => x.files || /conflict/i.test(x.status || '')),
      storyNames: stories.map(s => s.name), promotionName: p.name };
  });
  const all = history.load((await deps.storageDir('history')).fsPath);
  data.validations = history.about(all, { stories: data.storyNames, promotion: data.promotionName || null });
  data.at = new Date().toISOString();
  const text = redact(require('./src/report').readiness(data), c.maskIdentities);
  const dir = await deps.storageDir('reports');
  const file = vscode.Uri.joinPath(dir, 'readiness-' + data.name.replace(/[^\w.-]/g, '_') + '-' + data.at.replace(/[:.]/g, '-').slice(0, 19) + '.md');
  await vscode.workspace.fs.writeFile(file, Buffer.from(text, 'utf8'));
  await vscode.window.showTextDocument(file, { preview: false });
  output.appendLine('readiness: ' + data.name + ' - ' + data.stories.length + ' stories, ' + data.validations.length + ' validation(s) recorded; report ' + path.basename(file.fsPath));
  return { file: file.fsPath, name: data.name };
}

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
  // these decide which sidebar sections show: a section is revealed only once VS Code has them
  return Promise.all([
    vscode.commands.executeCommand('setContext', 'cmr.hasPackage', !!state.pkg),
    vscode.commands.executeCommand('setContext', 'cmr.hasValidation', !!state.validation),
    vscode.commands.executeCommand('setContext', 'cmr.hasBranchCheck', !!state.branch)
  ]).catch(() => {});
}

/** Shows a sidebar section: after it is visible, never an error if VS Code cannot focus it. */
function reveal(view) {
  return refreshAll().then(() => vscode.commands.executeCommand(view + '.focus')).catch(() => {});
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
      tooltip: (r.id ? 'Deploy id ' + r.id + '\n' : '') + (v.params.label ? v.params.label + '\n' : '') + (v.params.username ? 'Validated as ' + v.params.username + '\n' : '') +
        (v.params.environment ? 'Copado environment ' + v.params.environment : '') + (v.params.tests && v.params.tests.length ? '\nTests: ' + v.params.tests.join(', ') : ''),
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
    if (v.failures.length) {
      out.push(item('Component errors', { children: true, expanded: true, icon: 'bug', description: String(v.failures.length), data: { kind: 'errors' } }));
    }
    if (v.advice.length) {
      out.push(item('Tests and coverage', { children: true, expanded: true, icon: 'beaker', description: String(v.advice.length), data: { kind: 'tests' } }));
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
  if (p.kind === 'tests') {
    return state.validation.advice.map(a => item(a.title, {
      icon: /^Coverage/.test(a.title) ? 'graph' : 'beaker', color: 'list.warningForeground',
      description: a.detail.split('\n')[0], tooltip: a.detail
    }));
  }
  return [];
}

const exported = { activate, state, helpers: null };
module.exports = exported;
