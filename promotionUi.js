'use strict';

/**
 * The Promotion panel: one Copado promotion's conflicts, fetched at once into a
 * local workspace, resolved automatically where nothing needs deciding, reviewed
 * file by file where it does, uploaded in one go, and optionally validated
 * first. The logic lives in src/promotionWork.js; this is the VS Code side.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const W = require('./src/promotionWork');
const P = require('./src/promotion');
const X = require('./src/xmlParser');
const libs = { X, duplicates: require('./src/duplicates'), rules: require('./src/rules') };

let h;          // helpers from the release module
let ctx;
let current = null;   // { s: store, promotion }
let tree;
const changed = new vscode.EventEmitter();

const GROUPS = [
  ['review', 'To review', 'warning', ['review']],
  ['code', 'Code to resolve', 'code', ['code', 'error']],
  ['ready', 'Ready to upload', 'pass', ['auto', 'resolved']],
  ['done', 'Done', 'check-all', ['uploaded', 'copado']]
];

function activate(context, helpers) {
  h = helpers;
  ctx = context;
  tree = vscode.window.createTreeView('cmrPromotionView', { treeDataProvider: { getTreeItem: x => x, getChildren, onDidChangeTreeData: changed.event }, showCollapseAll: true });
  context.subscriptions.push(tree, changed);
  const cmd = h.cmd;
  cmd('cmr.promotion.open', () => open());
  cmd('cmr.copado.resolvePromotion', () => open());           // the 2.4 name
  cmd('cmr.promotion.refresh', () => refresh());
  cmd('cmr.promotion.review', item => review(fileOf(item)));
  cmd('cmr.promotion.accept', item => accept(fileOf(item)));
  cmd('cmr.promotion.compare', item => compare(fileOf(item)));
  cmd('cmr.promotion.reset', item => reset(fileOf(item)));
  cmd('cmr.promotion.copy', item => copy(fileOf(item)));
  cmd('cmr.copado.copyResolution', item => copy(fileOf(item)));  // the 2.4 name
  cmd('cmr.promotion.uploadAll', () => uploadAll());
  cmd('cmr.promotion.undoUpload', () => undoUpload());
  cmd('cmr.copado.undoUpload', () => undoUpload());            // the 2.5 name
  cmd('cmr.promotion.precheck', () => precheck());
  cmd('cmr.promotion.undoPrecheck', () => undoPrecheck());
  cmd('cmr.promotion.openInCopado', () => openInCopado());
  cmd('cmr.promotion.close', () => close());
  // a code file finished in the editor moves to Ready by itself
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
    if (!current) return;
    const rel = relInStore(doc.uri.fsPath, 'resolved');
    const st = current.s.load();
    if (!rel || !st || !st.files[rel]) return;
    const e = st.files[rel];
    if (['code', 'review', 'error', 'auto'].includes(e.state) && !P.hasMarkers(doc.getText())) {
      e.state = 'resolved'; e.note = 'resolved here';
      current.s.save(st); changed.fire();
    }
  }));
}

/* ------------------------------------------------------------ the tree */

function getChildren(el) {
  if (!current) return [];
  const st = current.s.load();
  if (!st) return [];
  if (!el) {
    const files = Object.entries(st.files);
    const head = new vscode.TreeItem(st.name + (current.promotion.status ? ' \u00b7 ' + current.promotion.status : ''), vscode.TreeItemCollapsibleState.None);
    head.description = (st.from || '?') + ' \u2192 ' + (st.to || '?');
    head.tooltip = 'Fetched ' + (st.syncedAt || '').replace('T', ' ').slice(0, 19) + ' from ' + (st.copadoOrg || 'Copado') + '. Refresh to look again.';
    head.iconPath = new vscode.ThemeIcon('git-pull-request');
    head.contextValue = 'promoHead';
    const groups = GROUPS.map(([id, label, icon, states]) => {
      const n = files.filter(([, e]) => states.includes(e.state)).length;
      if (!n) return null;
      const g = new vscode.TreeItem(label + ' (' + n + ')', id === 'done' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      g.iconPath = new vscode.ThemeIcon(icon);
      g.group = states;
      g.contextValue = 'promoGroup.' + id;
      return g;
    }).filter(Boolean);
    return [head, ...groups];
  }
  if (!el.group) return [];
  return Object.entries(st.files).filter(([, e]) => el.group.includes(e.state)).sort((a, b) => a[0].localeCompare(b[0])).map(([rel, e]) => {
    const t = new vscode.TreeItem(path.basename(rel), vscode.TreeItemCollapsibleState.None);
    t.description = (e.story ? e.story + ' \u00b7 ' : '') + (e.note || e.state);
    t.tooltip = new vscode.MarkdownString('`' + rel + '`\n\n' + (e.note || '') + (e.labels ? '\n\nSides: **' + (e.labels.ours || '?') + '** (promotion) and **' + (e.labels.theirs || '?') + '** (feature)' + (e.hasBase ? ', with the common ancestor' : '') : ''));
    t.resourceUri = vscode.Uri.file(current.s.file('resolved', rel));
    t.contextValue = 'promoFile.' + e.state;
    t.rel = rel;
    t.command = { command: 'cmr.promotion.review', title: 'Review', arguments: [t] };
    return t;
  });
}

function fileOf(item) {
  if (item && item.rel) return item.rel;
  const ed = vscode.window.activeTextEditor;
  return ed && current ? relInStore(ed.document.uri.fsPath, 'resolved') : null;
}

function relInStore(fsPath, folder) {
  if (!current) return null;
  const base = path.resolve(current.s.dir, folder) + path.sep;
  const p = path.resolve(fsPath);
  return p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length).split(path.sep).join('/') : null;
}

/* ------------------------------------------------------------ open and refresh */

function needOrg() {
  const c = h.rc();
  if (c.copadoOrg) return c;
  vscode.window.showInformationMessage('Set the Copado org first - the alias of the org where Copado runs, logged in with the Salesforce CLI.', 'Open settings')
    .then(p => { if (p) vscode.commands.executeCommand('workbench.action.openSettings', 'cmr.copado.org'); });
  return null;
}

async function api(c) { return h.copadoApi(c, h.projectRoot(), (await h.apiVersion()) || '62.0'); }

/** The promotion: typed, pasted as a Copado link, or picked from the recent ones. */
async function askPromotion() {
  const recent = ctx.workspaceState.get('cmr.recentPromotions', []);
  const dir = (await h.deps.storageDir('promotions')).fsPath;
  prune(dir);
  let local = [];
  try { local = fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, 'promotion.json'))); } catch (e) { /* none yet */ }
  const names = [...new Set(recent.concat(local))];
  if (names.length) {
    const pick = await vscode.window.showQuickPick([{ label: '$(search) Another promotion\u2026', other: true }].concat(names.map(n => ({ label: n, description: 'fetched before' }))),
      { title: 'Open a promotion from Copado', ignoreFocusOut: true });
    if (!pick) return null;
    if (!pick.other) return pick.label;
  }
  const v = await vscode.window.showInputBox({ title: 'Open a promotion from Copado', prompt: 'A promotion, a user story, or the promotion\u2019s Copado link',
    placeHolder: 'P12345, US-0012345 or https://\u2026/copado__Promotion__c/a0P\u2026/view', ignoreFocusOut: true,
    validateInput: x => promotionRef(x) ? null : 'A promotion such as P12345, a user story such as US-0012345, or a Copado link to a promotion' });
  return v ? promotionRef(v) : null;
}

/** Removes finished promotions - every file uploaded or resolved in Copado - not touched for the configured days. */
function prune(dir) {
  const days = Number(vscode.workspace.getConfiguration('cmr').get('promotion.keepDays', 30));
  if (!(days > 0)) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const n of names) {
    const s = W.store(path.join(dir, n));
    const st = s.load();
    if (!st || !st.syncedAt || Date.now() - Date.parse(st.syncedAt) < days * 864e5) continue;
    if (Object.values(st.files).every(e => e.state === 'uploaded' || e.state === 'copado')) fs.rmSync(s.dir, { recursive: true, force: true });
  }
}

function promotionRef(v) {
  const s = String(v || '').trim();
  const link = /copado__Promotion__c\/([a-zA-Z0-9]{15,18})/.exec(s);
  if (link) return link[1];
  if (/^(P-?\d+|(US-?)?\d+|[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?)$/i.test(s)) return s;
  return null;
}

async function open() {
  h.requireTrust('Opening a promotion runs the Salesforce CLI');
  const c = needOrg();
  if (!c) return;
  const ref = await askPromotion();
  if (!ref) return;
  const a = await api(c);
  let found;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Finding ' + ref + ' in Copado' }, async () => {
    found = await P.promotionConflicts(a, ref);
  });
  const list = found.promotions.filter(p => p.conflicts.length || /conflict/i.test(p.status || ''));
  if (!list.length) {
    vscode.window.showInformationMessage('No promotion with conflicts for ' + ref + (found.promotions.length ? ' - ' + found.promotions.map(p => p.name + ' (' + (p.status || '?') + ')').join(', ') : '') + '.');
    return;
  }
  const promotion = list.length === 1 ? list[0] : ((await vscode.window.showQuickPick(list.map(p => ({ label: p.name, description: p.status || '', detail: (p.from || '?') + ' \u2192 ' + (p.to || '?'), p })),
    { title: 'Which promotion?', ignoreFocusOut: true })) || {}).p;
  if (!promotion) return;
  await load(promotion, c, a);
  ctx.workspaceState.update('cmr.recentPromotions', [promotion.name].concat(ctx.workspaceState.get('cmr.recentPromotions', []).filter(n => n !== promotion.name)).slice(0, 10));
  vscode.commands.executeCommand('cmrPromotionView.focus');
}

async function load(promotion, c, a) {
  const dir = path.join((await h.deps.storageDir('promotions')).fsPath, promotion.name.replace(/[^\w.-]/g, '_'));
  const s = W.store(dir);
  current = { s, promotion };
  const t0 = Date.now();
  let r;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: promotion.name + ': fetching the conflicts' }, async progress => {
    progress.report({ message: 'downloading in parallel and merging what needs no decision' });
    r = await W.sync(a, s, promotion, h.deps.promoMerge, { copadoOrg: c.copadoOrg });
  });
  changed.fire();
  const f = Object.values(r.state.files);
  const count = st => f.filter(e => st.includes(e.state)).length;
  h.output.appendLine('copado: ' + promotion.name + ' - ' + r.fetched + ' file' + (r.fetched === 1 ? '' : 's') + ' fetched in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's: ' +
    count(['auto']) + ' resolved automatically, ' + count(['review']) + ' to review, ' + count(['code', 'error']) + ' code, ' + count(['uploaded', 'copado']) + ' done');
  vscode.window.showInformationMessage(promotion.name + ': ' + count(['auto']) + ' resolved automatically, ' + count(['review']) + ' to review, ' + count(['code', 'error']) + ' code file' +
    (count(['code', 'error']) === 1 ? '' : 's') + ' to resolve' + (count(['uploaded', 'copado']) ? ', ' + count(['uploaded', 'copado']) + ' done' : '') + '.');
}

async function refresh() {
  if (!current) return open();
  const c = needOrg();
  if (!c) return;
  const a = await api(c);
  const found = await P.promotionConflicts(a, current.promotion.id);
  const p = found.promotions[0] || current.promotion;
  await load(p, c, a);
}

/* ------------------------------------------------------------ working on files */

function entry(rel) { const st = current && current.s.load(); return st && rel ? st.files[rel] : null; }

function setState(rel, state, note) {
  const st = current.s.load();
  if (!st.files[rel]) return;
  st.files[rel].state = state;
  if (note) st.files[rel].note = note;
  current.s.save(st);
  changed.fire();
}

async function review(rel) {
  const e = entry(rel);
  if (!e) return;
  const s = current.s;
  if (e.kind === 'xml' && fs.existsSync(s.file('promotion', rel)) && fs.existsSync(s.file('feature', rel))) {
    const L = e.labels || {};
    await h.deps.startSession(vscode.Uri.file(s.file('promotion', rel)), vscode.Uri.file(s.file('feature', rel)),
      fs.existsSync(s.file('base', rel)) ? vscode.Uri.file(s.file('base', rel)) : null, {
        labels: { target: 'promotion branch' + (L.ours ? ' (' + L.ours + ')' : ''), incoming: 'feature' + (L.theirs ? ' (' + L.theirs + ')' : ''), ancestor: 'common ancestor' },
        applyToUri: vscode.Uri.file(s.file('resolved', rel)),
        onApplied: () => setState(rel, 'resolved', 'resolved here')
      });
  } else {
    await vscode.window.showTextDocument(vscode.Uri.file(s.file('resolved', rel)), { preview: false });
    if (P.hasMarkers(s.read('resolved', rel) || '')) vscode.window.setStatusBarMessage('Resolve each block with Accept Current / Incoming / Both, then save - the file moves to Ready.', 8000);
  }
}

async function accept(rel) {
  const e = entry(rel);
  if (!e) return;
  if (P.hasMarkers(current.s.read('resolved', rel) || '')) { vscode.window.showWarningMessage(path.basename(rel) + ' still has conflict markers - resolve them first.'); return; }
  setState(rel, 'resolved', e.state === 'review' ? 'accepted as merged (the feature\u2019s value where both changed)' : 'accepted');
}

async function compare(rel) {
  if (!entry(rel)) return;
  const s = current.s;
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(s.file('promotion', rel)), vscode.Uri.file(s.file('feature', rel)),
    path.basename(rel) + ': promotion branch \u2194 feature');
}

async function reset(rel) {
  const e = entry(rel);
  if (!e) return;
  const merged = current.s.read('merged', rel);
  if (merged == null) return;
  current.s.write('resolved', rel, merged);
  const auto = P.hasMarkers(merged) ? 'code' : e.kind === 'xml' && e.conflicts ? 'review' : 'auto';
  setState(rel, auto, 'reset to the automatic result');
}

async function copy(rel) {
  if (!current || !rel) { vscode.window.showInformationMessage('Pick a file in the Promotion panel first.'); return; }
  const text = current.s.read('resolved', rel) || '';
  if (P.hasMarkers(text)) { vscode.window.showWarningMessage(path.basename(rel) + ' still has conflict markers.'); return; }
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage('Copied the resolution of ' + path.basename(rel), 4000);
}

/* ------------------------------------------------------------ upload, undo */

async function uploadAll() {
  if (!current) return;
  h.requireTrust('Uploading to Copado runs the Salesforce CLI');
  const c = needOrg();
  if (!c) return;
  const st = current.s.load();
  const { ready, held } = W.readyFiles(current.s, st, libs);
  if (!ready.length) {
    vscode.window.showInformationMessage('Nothing ready to upload' + (held.length ? ' - ' + held.map(x => path.basename(x.rel) + ': ' + x.reason).join('; ') : '') + '.');
    return;
  }
  const open = Object.values(st.files).filter(e => !['uploaded', 'copado'].includes(e.state)).length;
  const last = open === ready.length;
  const detail = ready.map(x => (x.entry.state === 'auto' ? '\u2713 auto   ' : '\u2713 yours  ') + x.rel).join('\n') +
    (held.length ? '\n\nHeld back:\n' + held.map(x => '\u2717 ' + x.rel + ' - ' + x.reason).join('\n') : '') +
    '\n\nEach conflict attachment is renamed "RESOLVED \u2026" with the resolved content, as Copado\u2019s editor does, then read back.' +
    (last ? '\n\nThese are the last conflicts: Copado\u2019s editor would now set the promotion\u2019s status to "Conflicts Resolved".' : '');
  const pick = await vscode.window.showWarningMessage('Upload ' + ready.length + ' resolution' + (ready.length === 1 ? '' : 's') + ' to ' + st.name + '?', { modal: true, detail },
    ...(last ? ['Upload and set the status', 'Upload only'] : ['Upload']));
  if (!pick) return;
  const a = await api(c);
  let r;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Uploading to Copado (' + c.copadoOrg + ')' }, async () => {
    r = await W.uploadAll(a, current.s, ready, { status: pick === 'Upload and set the status' });
  });
  changed.fire();
  for (const f of r.uploaded) h.output.appendLine('copado: uploaded ' + f.path + ' to ' + st.name + ' as "' + f.name + '" (' + f.bytes + ' bytes, read back and identical)');
  for (const f of r.failed) h.output.appendLine('copado: NOT uploaded ' + f.rel + ' - ' + f.reason);
  if (r.batch.statusChange) h.output.appendLine('copado: ' + st.name + ' status "' + r.batch.statusChange.from + '" \u2192 "' + r.batch.statusChange.to + '" (read back)');
  const left = Object.values(current.s.load().files).filter(e => !['uploaded', 'copado'].includes(e.state)).length;
  const msg = r.uploaded.length + ' uploaded to ' + st.name + (r.failed.length ? ', ' + r.failed.length + ' failed (see the output)' : '') +
    (r.batch.statusChange ? '. Status: ' + r.batch.statusChange.to + '. Continue the promotion in Copado.' : left ? '. ' + left + ' still to resolve.' : '.');
  const next = await (r.failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(msg, 'Open in Copado');
  if (next) await openInCopado();
}

async function undoUpload() {
  if (!current) { vscode.window.showInformationMessage('Open the promotion first.'); return; }
  const b = W.lastBatch(current.s);
  if (!b) { vscode.window.showInformationMessage('There is no upload to undo for ' + current.promotion.name + '.'); return; }
  const ok = await vscode.window.showWarningMessage('Undo the upload of ' + b.files.length + ' file' + (b.files.length === 1 ? '' : 's') + ' to ' + b.promotion.name + '?', { modal: true,
    detail: b.files.map(f => f.path).join('\n') + '\n\nEach attachment is renamed back with its conflicted content' + (b.statusChange ? '; the status goes back to "' + b.statusChange.from + '" if it is still "' + b.statusChange.to + '"' : '') + '.' }, 'Undo');
  if (ok !== 'Undo') return;
  const c = Object.assign({}, h.rc(), { copadoOrg: b.copadoOrg || h.rc().copadoOrg });
  await W.undoBatch(await api(c), current.s, b);
  changed.fire();
  h.output.appendLine('copado: undid the upload of ' + b.files.length + ' file(s) to ' + b.promotion.name);
  vscode.window.showInformationMessage('Undone: ' + b.files.length + ' file' + (b.files.length === 1 ? ' is a conflict' : 's are conflicts') + ' again in Copado, still resolved here.');
}

/* ------------------------------------------------------------ the pre-check */

/**
 * Validates the resolved files before uploading: the promotion's components are
 * retrieved from its source org, the resolved files put on top, and the whole
 * validated check-only against its destination org - a pre-check, because the
 * other components come from the source org rather than the feature branch.
 */
async function precheck() {
  if (!current) return;
  h.requireTrust('The pre-check runs the Salesforce CLI');
  const c = needOrg();
  if (!c) return;
  const st = current.s.load();
  const { ready, held } = W.readyFiles(current.s, st, libs);
  const done = Object.entries(st.files).filter(([, e]) => e.state === 'uploaded').map(([rel]) => ({ rel }));
  const rels = ready.concat(done).map(x => x.rel);
  if (!rels.length) { vscode.window.showInformationMessage('Resolve some files first - the pre-check validates the resolved ones.'); return; }
  const a = await api(c);
  // the promotion's own component list, if Copado attached one
  let rows = [];
  try {
    const links = await a.query("SELECT ContentDocument.Title, ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId = '" +
      String(st.id).replace(/[^A-Za-z0-9]/g, '') + "'");
    const list = links.map(l => l.ContentDocument || {}).filter(d => /promotion changes/i.test(d.Title || '')).sort((x, y) => String(y.CreatedDate).localeCompare(String(x.CreatedDate)));
    if (list[0]) rows = JSON.parse((await a.download('ContentVersion', list[0].LatestPublishedVersionId)).toString('utf8'));
  } catch (e) { h.output.appendLine('copado: no promotion change list (' + e.message + ') - checking the resolved files on their own'); }
  if (!Array.isArray(rows)) rows = [];
  for (const rel of rels) {
    const comp = W.componentOf(rel);
    if (comp && !rows.some(r => r.t === comp.type && r.n === comp.name)) rows.push({ t: comp.type, n: comp.name, a: 'Add' });
  }
  const file = vscode.Uri.file(path.join(current.s.dir, 'precheck-package.json'));
  fs.writeFileSync(file.fsPath, JSON.stringify(rows, null, 2));
  await h.cmdPackage(file, [file]);
  // the orgs: the promotion's source and destination environments
  let localOrgs = [];
  try { localOrgs = await h.orgList(c, h.projectRoot()); } catch (e) { /* asked below */ }
  const creds = await environmentLogins(a, [st.fromId, st.toId].filter(Boolean), localOrgs);
  const r = { credentials: creds };
  const source = await h.orgForEnvironment(c, r, st.fromId, st.from, localOrgs, 'source - the components come from here');
  const target = await h.orgForEnvironment(c, r, st.toId, st.to, localOrgs, 'target - validated against, nothing is deployed');
  const s = current.s, root = h.projectRoot();
  h.output.appendLine('copado: pre-check of ' + st.name + ' - ' + rels.length + ' resolved file(s) over the promotion\u2019s components from ' + (source || '?') + ', validated against ' + (target || '?') +
    (held.length ? ' (' + held.length + ' file(s) not resolved yet are left out)' : ''));
  await h.cmdValidate({ sourceOrg: source, targetOrg: target, mode: 'retrieve',
    overlay: async () => { const rec = W.overlay(s, root, rels); return 'pre-check: ' + rec.files.length + ' resolved file(s) put over the retrieved ones - "Copado: Undo Pre-check Files" restores the project'; } });
}

async function environmentLogins(a, envIds, localOrgs) {
  if (!envIds.length) return [];
  const { robustQuery } = require('./src/copadoInspect');
  const rows = await robustQuery(a, ['Name', 'copado__Username__c', 'copado__Environment__c', 'copado__Environment__r.Name'], 'copado__Org__c',
    'copado__Environment__c IN (' + envIds.map(i => "'" + String(i).replace(/[^A-Za-z0-9]/g, '') + "'").join(', ') + ')', 'LIMIT 50', []);
  return rows.map(c => {
    const user = c.copado__Username__c;
    const local = localOrgs.find(l => user && l.username && l.username.toLowerCase() === String(user).toLowerCase());
    return { name: c.Name, environment: (c.copado__Environment__r || {}).Name, environmentId: c.copado__Environment__c, username: user, localAlias: local ? (local.alias || local.username) : null };
  });
}

async function undoPrecheck() {
  if (!current) return;
  const rec = W.undoOverlay(current.s);
  vscode.window.showInformationMessage(rec ? 'Restored ' + rec.files.length + ' project file(s) the pre-check replaced.' : 'There is no pre-check to undo.');
}

/* ------------------------------------------------------------ Copado */

async function openInCopado() {
  if (!current) return;
  const c = h.rc();
  await h.sfcli.openPath(c.sfPath, (current.s.load() || {}).copadoOrg || c.copadoOrg, '/lightning/r/copado__Promotion__c/' + current.promotion.id + '/view', h.projectRoot());
}

async function close() {
  if (!current) return;
  const name = current.promotion.name;
  const ok = await vscode.window.showWarningMessage('Close ' + name + ' and delete its local files?', { modal: true,
    detail: 'Removes .copado/promotions/' + name + ' - the fetched files, your resolutions and the upload log. Nothing in Copado changes.' }, 'Close and delete');
  if (ok !== 'Close and delete') return;
  fs.rmSync(current.s.dir, { recursive: true, force: true });
  current = null;
  changed.fire();
}

module.exports = { activate, promotionRef };
