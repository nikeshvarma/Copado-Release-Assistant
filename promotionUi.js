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
const L = require('./src/lifecycle');
const J = require('./src/jobs');
const X = require('./src/xmlParser');
const libs = { X, duplicates: require('./src/duplicates'), rules: require('./src/rules') };

let h;          // helpers from the release module
let ctx;
let current = null;   // { s: store, promotion, info: { back, sides, login, pipelineId, sourceBranch }, jobs }
const changed = new vscode.EventEmitter();

function activate(context, helpers) {
  h = helpers;
  ctx = context;
  // the deployment watch's timer stops with the extension
  context.subscriptions.push(changed, { dispose: () => stopWatch() });
  const cmd = h.cmd;
  // the one starting point here: everything else is on the page, so it opens there
  cmd('cmr.promotion.open', async () => { await vscode.commands.executeCommand('cmr.page.open'); return open(); });
  if (h.onValidation) context.subscriptions.push(h.onValidation(() => changed.fire()));
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
  return openRef(ref);
}

/** Opens a promotion by number, story, record id or Copado link - for the command and the page. */
async function openRef(input) {
  h.requireTrust('Opening a promotion runs the Salesforce CLI');
  const c = needOrg();
  if (!c) return;
  const ref = promotionRef(input) || String(input || '').trim();
  if (!ref) return;
  const a = await api(c);
  let found;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for ' + ref + ' in Copado' }, async () => {
    found = await P.promotionConflicts(a, ref);
  });
  const inConflict = p => p.conflicts.some(x => !x.resolution) || (/conflict/i.test(p.status || '') && !/resolved/i.test(p.status || ''));
  const list = found.promotions.slice().sort((a, b) => (inConflict(b) ? 1 : 0) - (inConflict(a) ? 1 : 0));
  if (!list.length) { vscode.window.showInformationMessage('No promotion found for ' + ref + '.'); return; }
  const promotion = list.length === 1 ? list[0] : ((await vscode.window.showQuickPick(list.map(p => ({ label: p.name, description: (p.status || '') + (inConflict(p) ? ' \u00b7 ' + p.conflicts.filter(x => !x.resolution).length + ' conflict file(s)' : ''),
    detail: (p.from || '?') + ' \u2192 ' + (p.to || '?'), p })), { title: 'Which promotion?', ignoreFocusOut: true })) || {}).p;
  if (!promotion) return;
  await load(promotion, c, a);
  ctx.workspaceState.update('cmr.recentPromotions', [promotion.name].concat(ctx.workspaceState.get('cmr.recentPromotions', []).filter(n => n !== promotion.name)).slice(0, 10));
}

async function load(promotion, c, a) {
  const dir = path.join((await h.deps.storageDir('promotions')).fsPath, promotion.name.replace(/[^\w.-]/g, '_'));
  const s = W.store(dir);
  if (!current || current.promotion.id !== promotion.id) stopWatch();
  current = { s, promotion, info: (current && current.promotion.id === promotion.id && current.info) || null, jobs: current && current.promotion.id === promotion.id ? current.jobs : null, components: current && current.promotion.id === promotion.id ? current.components : null };
  const t0 = Date.now();
  let r;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Opening ' + promotion.name }, async progress => {
    progress.report({ message: autoOn() ? 'Getting the conflicts and settling the easy ones for you' : 'Getting the conflicts - nothing is resolved without you' });
    const [synced, info] = await Promise.all([W.sync(a, s, promotion, h.deps.promoMerge, { copadoOrg: c.copadoOrg, autoResolve: autoOn() }), facts(promotion, c, a).catch(e => { h.output.appendLine('copado: ' + e.message); return null; })]);
    r = synced;
    if (info) current.info = info;
  });
  const f = Object.values(r.state.files);
  const st0 = s.load();
  // resolutions the one-line version of the choices broke are rebuilt from your recorded choices
  const rebuilt = W.repairChoices(current.s, st0, libs.X);
  if (rebuilt.length) {
    W.logEvent(st0, 'reset', 'Rebuilt ' + rebuilt.length + ' resolution' + (rebuilt.length === 1 ? '' : 's') + ' from your choices', 'an earlier version broke values that span lines: ' + rebuilt.map(r => path.basename(r)).join(', '));
    h.output.appendLine('copado: rebuilt ' + rebuilt.join(', ') + ' from your choices - an earlier version broke values that span lines');
  }
  W.logEvent(st0, 'fetch', r.fetched ? 'Got ' + r.fetched + ' conflict file' + (r.fetched === 1 ? '' : 's') + ' from Copado' : f.length ? 'Checked Copado for updates' : 'Opened from Copado',
    r.fetched ? 'in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' seconds' : f.length ? 'nothing changed in Copado meanwhile' : 'no conflicts on this promotion');
  const autoN = f.filter(e => e.state === 'auto').length;
  if (r.fetched && autoN) W.logEvent(st0, 'auto', autoN + ' resolved automatically', 'no decision needed');
  if (r.returned) W.logEvent(st0, 'reset', r.returned + ' file' + (r.returned === 1 ? '' : 's') + ' back to you to review', 'resolving automatically is off - their merge is now a suggestion');
  s.save(st0);
  changed.fire();
  const count = st => f.filter(e => st.includes(e.state)).length;
  h.output.appendLine('copado: ' + promotion.name + ' - ' + r.fetched + ' file' + (r.fetched === 1 ? '' : 's') + ' fetched in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's: ' +
    count(['auto']) + ' resolved automatically, ' + count(['review']) + ' to review, ' + count(['code', 'error']) + ' code, ' + count(['uploaded', 'copado']) + ' done');
  // a pre-check left running when VS Code closed is not running any more
  const left = current.s.load();
  if (left && left.precheck && left.precheck.state === 'running' && (!activeRun || activeRun.id !== left.precheck.id)) {
    Object.assign(left.precheck, { state: 'stopped', message: 'Stopped - VS Code was closed while it ran.', finishedAt: left.precheck.finishedAt || new Date().toISOString() });
    current.s.save(left);
  }
  // the box as Copado has it: ticked there by anyone counts from now; unticked there, nothing to wait for
  const pending = current.s.load();
  const rc = current.info && current.info.recreate;
  if (pending && rc && !rc.missing) {
    if (rc.value && !pending.recreate) { pending.recreate = { setAt: new Date().toISOString(), field: rc.field, noticed: true }; W.logEvent(pending, 'status', rc.label + ' is ticked in Copado', 'it is unticked by itself once Copado validates the promotion successfully'); current.s.save(pending); }
    else if (!rc.value && pending.recreate) { delete pending.recreate; current.s.save(pending); }
  }
  if (pending && pending.recreate) readJobs({ notify: false }).catch(() => {});
  if (!f.length) { vscode.window.showInformationMessage(promotion.name + ' (' + (promotion.status || '?') + ') has no conflicts - validate its promotion branch, or follow its deployment, from the page.'); return; }
  vscode.window.showInformationMessage(promotion.name + ': ' + count(['auto']) + ' resolved automatically, ' + count(['review']) + ' to review, ' + count(['code', 'error']) + ' code file' +
    (count(['code', 'error']) === 1 ? '' : 's') + ' to resolve' + (count(['uploaded', 'copado']) ? ', ' + count(['uploaded', 'copado']) + ' done' : '') + '.');
}

/**
 * What the page shows besides the files: a back-promotion or not (Copado's
 * flag, else the pipeline's direction), what each side of a conflict is, the
 * destination's login, and the branches.
 */
async function facts(promotion, c, a) {
  const p = await L.promotionById(a, promotion.id) || promotion;
  const pid = await L.pipelineIdFor(a, { pipelineId: p.pipelineId, toId: promotion.toId, fromId: promotion.fromId });
  const map = pid ? await L.pipeline(a, pid).catch(() => null) : null;
  const back = L.isBackPromotion(Object.assign({}, promotion, { backFlag: p.backFlag }), map);
  let localOrgs = [];
  try { localOrgs = await h.orgList(c, h.projectRoot()); } catch (e) { /* none */ }
  const logins = promotion.toId ? await L.logins(a, [{ id: promotion.toId, name: promotion.to }], localOrgs, c.environmentOrgs || {}) : {};
  const env = id => map && map.envs[id];
  const recreate = await recreateInfo(a, promotion.id).catch(() => ({ missing: true }));
  return { back, pipelineId: pid, recreate, pipeline: map ? map.name : null, sides: { ours: 'Target branch', theirs: back ? 'Back-promoted from ' + (promotion.from || 'the source') : 'Feature branch' },
    login: logins[promotion.toId] || null, sourceBranch: env(promotion.fromId) ? env(promotion.fromId).branch : null, destinationBranch: env(promotion.toId) ? env(promotion.toId).branch : null,
    promotionBranch: String(vscode.workspace.getConfiguration('cmr').get('repo.promotionBranch', 'promotion/{promotion}')).split('{promotion}').join(promotion.name),
    production: !!(map && promotion.toId && map.productionId === promotion.toId) };
}

async function refresh() {
  if (!current) return open();
  const c = needOrg();
  if (!c) return;
  const a = await api(c);
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking ' + current.promotion.name + ' for updates' },
    () => P.promotionConflicts(a, current.promotion.id));
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
  W.logEvent(st, state === 'resolved' ? 'accept' : 'reset', path.basename(rel) + ' ' + (state === 'resolved' ? (note || 'resolved') : 'reset'), '');
  current.s.save(st);
  changed.fire();
}

async function review(rel) {
  const e = entry(rel);
  if (!e) return;
  const s = current.s;
  if (e.revising) { await vscode.window.showTextDocument(vscode.Uri.file(s.file('resolved', rel)), { preview: false }); return; }
  // code too, in the merge editor - unless VS Code's own conflict view is chosen (cmr.merge.codeIn)
  const codeHere = e.kind !== 'xml' && vscode.workspace.getConfiguration('cmr').get('merge.codeIn', 'mergeEditor') !== 'vscode';
  if ((e.kind === 'xml' || codeHere) && fs.existsSync(s.file('promotion', rel)) && fs.existsSync(s.file('feature', rel))) {
    const lb = e.labels || {};
    // Copado's conflict file has no common ancestor: the repository's merge-base can give it
    if (!fs.existsSync(s.file('base', rel)) && h.ancestorFor && current.info && current.info.destinationBranch && e.story && !(current.info && current.info.back)) {
      const pattern = vscode.workspace.getConfiguration('cmr').get('repo.featureBranch', 'feature/{story}');
      const body = await h.ancestorFor({ rel, featureBranch: pattern.split('{story}').join(e.story), destinationBranch: current.info.destinationBranch });
      if (body) { fs.mkdirSync(path.dirname(s.file('base', rel)), { recursive: true }); fs.writeFileSync(s.file('base', rel), body); }
    }
    await h.deps.startSession(vscode.Uri.file(s.file('promotion', rel)), vscode.Uri.file(s.file('feature', rel)),
      fs.existsSync(s.file('base', rel)) ? vscode.Uri.file(s.file('base', rel)) : null, {
        labels: { target: 'Target branch' + (lb.ours ? ' (' + lb.ours + ')' : ''), incoming: theirsLabel() + (lb.theirs ? ' (' + lb.theirs + ')' : ''), ancestor: 'Common ancestor', merged: 'Your resolution (editable)' },
        applyToUri: vscode.Uri.file(s.file('resolved', rel)),
        // what you save in the merge view is your resolution: saving moves the file on, nothing else to choose
        applyOnSave: true, openAfterApply: false, theirs: current.info && current.info.back ? (current.promotion.from || 'the source') : 'the feature branch',
        // code starts from Copado's conflict file, its blocks to choose - or what you resolved
        startFrom: e.state === 'resolved' || e.kind !== 'xml' ? s.read('resolved', rel) : null,
        appliedMessage: path.basename(rel) + ' is ready to upload - what you saved is your resolution.',
        // the first save makes it yours; saving again only refreshes the page - no new entry each time
        onApplied: () => { const f = entry(rel); if (f && f.state === 'resolved' && f.note === 'your resolution from the merge view') changed.fire(); else setState(rel, 'resolved', 'your resolution from the merge view'); }
      });
  } else {
    await vscode.window.showTextDocument(vscode.Uri.file(s.file('resolved', rel)), { preview: false });
    if (P.hasMarkers(s.read('resolved', rel) || '')) vscode.window.setStatusBarMessage('Resolve each block with Accept Current / Incoming / Both, then save - the file moves to Ready.', 8000);
  }
}

/** Resolving automatically: off unless the setting turns it on. */
const autoOn = () => vscode.workspace.getConfiguration('cmr').get('promotion.autoResolve', false) === true;

async function accept(rel) {
  const e = entry(rel);
  if (!e) return;
  if (P.hasMarkers(current.s.read('resolved', rel) || '')) { vscode.window.showWarningMessage(path.basename(rel) + ' still has conflict markers - resolve them first.'); return; }
  setState(rel, 'resolved', e.suggestion ? 'you accepted the suggested merge' : e.state === 'review' ? 'accepted as merged (the feature\u2019s value where both changed)' : 'accepted');
}

/** The page's choices for a file's real clashes: applied to the automatic result, the file accepted. */
async function choose(rel, choices) {
  const e = entry(rel);
  if (!e || !e.clashes || !e.clashes.length) return;
  const merged = current.s.read('merged', rel);
  const r = W.applyChoices(merged, e.clashes, choices);
  if (r.moved.length) { vscode.window.showWarningMessage(path.basename(rel) + ': ' + r.moved.length + ' clash(es) could not be placed - use Open in merge.'); return; }
  // never a broken file from a choice: if the result is not well-formed, nothing is written
  const bad = W.wellFormed(r.text, libs.X);
  if (bad) { vscode.window.showWarningMessage(path.basename(rel) + ': your choices would give ' + bad + ' - nothing was changed. Use Open in merge.'); return; }
  current.s.write('resolved', rel, r.text);
  const st = current.s.load();
  st.files[rel].choices = choices;
  current.s.save(st);
  setState(rel, 'resolved', 'your choices: ' + Object.values(choices).map(v => v === 'target' ? 'target' : 'feature').join(', '));
}

async function compare(rel) {
  const e = entry(rel) || {};
  if (!entry(rel)) return;
  const s = current.s;
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(s.file('promotion', rel)), vscode.Uri.file(s.file('feature', rel)),
    path.basename(rel) + ': Target branch' + ((e.labels || {}).ours ? ' (' + e.labels.ours + ')' : '') + ' \u2194 ' + theirsLabel() + ((e.labels || {}).theirs ? ' (' + e.labels.theirs + ')' : ''));
}

/** Copado's "Re-create promotion branch" checkbox on this promotion: { field, label, value } or { missing: true }. */
async function recreateInfo(a, promotionId) {
  const override = vscode.workspace.getConfiguration('cmr').get('copado.recreateBranchField', '');
  const f = await P.recreateBranchField(a, override);
  if (!f) return { missing: true, override: override || null };
  return Object.assign(f, { value: await P.promotionFlag(a, promotionId, f.field) });
}

/**
 * Ticks or unticks Re-create promotion branch in Copado - read back, and
 * logged. A tick by the extension is remembered, so it can be unticked once
 * Copado has validated the promotion successfully.
 */
async function setRecreate(value, why) {
  if (!current) return;
  const c = needOrg();
  if (!c) return;
  const a = await api(c);
  const info = current.info && current.info.recreate && !current.info.recreate.missing ? current.info.recreate : await recreateInfo(a, current.promotion.id);
  if (info.missing) {
    vscode.window.showInformationMessage('This Copado version has no Re-create promotion branch checkbox on the promotion' + (info.override ? ' named ' + info.override : '') + '. If it has one by another name, set Copado \u203a Re-create branch field.');
    return;
  }
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: (value ? 'Turning on ' : 'Turning off ') + (info.label || 'Re-create promotion branch') + ' in Copado' },
    () => P.setPromotionFlag(a, current.promotion.id, info.field, value));
  const st = current.s.load();
  if (value) st.recreate = { setAt: new Date().toISOString(), field: info.field };
  else delete st.recreate;
  if (!r.unchanged) W.logEvent(st, 'status', (value ? 'Ticked ' : 'Unticked ') + info.label + ' in Copado', why || (value ? 'Copado rebuilds the promotion branch from the stories next time' : 'read back'));
  current.s.save(st);
  current.info = Object.assign({}, current.info, { recreate: Object.assign({}, info, { value }) });
  h.output.appendLine('copado: ' + current.promotion.name + ' ' + info.field + ' = ' + value + ' (read back)' + (why ? ' - ' + why : ''));
  changed.fire();
}

/** Once Copado has validated the promotion successfully after the tick, the box is unticked again. */
async function untickIfValidated(snap) {
  const st = current && current.s.load();
  if (!st || !st.recreate) return;
  const v = J.validationSince(snap, st.recreate.setAt);
  if (v.state !== 'done') return;
  await setRecreate(false, 'Copado validated it successfully (' + v.run.name + ')');
  vscode.window.showInformationMessage(current.promotion.name + ': Copado validated it successfully - Re-create promotion branch is unticked again.');
}

/**
 * Edit again: a resolution already in Copado - uploaded from here or made in
 * Copado's editor - is fetched as it is there now and opened, to change after
 * a validation found a problem in it. Uploading replaces it in Copado.
 */
async function revise(rel) {
  if (!current) return;
  const c = needOrg();
  if (!c) return;
  const a = await api(c);
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Getting the latest ' + path.basename(rel) + ' from Copado' },
    () => W.startRevision(a, current.s, rel));
  const st = current.s.load();
  W.logEvent(st, 'reset', 'Editing ' + path.basename(rel) + ' again', r.changedInCopado ? 'it changed in Copado since your upload - starting from the version there' : 'starting from the resolution in Copado');
  current.s.save(st);
  changed.fire();
  await vscode.window.showTextDocument(vscode.Uri.file(current.s.file('resolved', rel)), { preview: false });
  vscode.window.setStatusBarMessage('Change the file and save it - then Upload replaces the resolution in Copado.', 8000);
}

/** The incoming side of this promotion's conflicts: a story's feature branch, or the environment a back-promotion comes from. */
function theirsLabel() { return current && current.info && current.info.sides ? current.info.sides.theirs : 'Feature branch'; }

async function reset(rel) {
  const e = entry(rel);
  if (!e) return;
  if (e.revising) {
    W.cancelRevision(current.s, rel);
    const st = current.s.load();
    W.logEvent(st, 'reset', path.basename(rel) + ': changes discarded', 'the resolution in Copado is unchanged');
    current.s.save(st);
    changed.fire();
    return;
  }
  const merged = current.s.read('merged', rel);
  if (merged == null) return;
  current.s.write('resolved', rel, merged);
  const auto = P.hasMarkers(merged) ? 'code' : (e.kind === 'xml' && e.conflicts) || !autoOn() ? 'review' : 'auto';
  const st = current.s.load();
  st.files[rel].suggestion = auto === 'review' && !(e.kind === 'xml' && (e.conflicts || e.featureLacks));
  current.s.save(st);
  setState(rel, auto, auto === 'auto' ? 'reset to the automatic result' : st.files[rel].suggestion ? 'reset to the suggested merge - review it and accept' : 'reset - to resolve');
}

async function copy(rel) {
  if (!current || !rel) { vscode.window.showInformationMessage('Pick a file in the Promotion panel first.'); return; }
  const text = current.s.read('resolved', rel) || '';
  if (P.hasMarkers(text)) { vscode.window.showWarningMessage(path.basename(rel) + ' still has conflict markers.'); return; }
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage('Copied the resolution of ' + path.basename(rel), 4000);
}

/* ------------------------------------------------------------ upload, undo */

async function uploadAll(opts) {
  if (!current) return;
  const confirmed = opts && opts.confirmed;
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
  const revised = ready.filter(x => x.entry.revising).length;
  const last = open === ready.length && !revised;
  const rc = current.info && current.info.recreate;
  const offerRecreate = revised > 0 && rc && !rc.missing && !rc.value;
  const detail = ready.map(x => (x.entry.revising ? '\u21bb replace ' : x.entry.state === 'auto' ? '\u2713 auto   ' : '\u2713 yours  ') + x.rel).join('\n') +
    (held.length ? '\n\nHeld back:\n' + held.map(x => '\u2717 ' + x.rel + ' - ' + x.reason).join('\n') : '') +
    '\n\nEach conflict attachment is renamed "RESOLVED \u2026" with the resolved content, as Copado\u2019s editor does, then read back.' +
    (revised ? '\n\n' + revised + ' replace' + (revised === 1 ? 's a resolution' : ' resolutions') + ' already in Copado - only if Copado still holds the one you started from.' : '') +
    (offerRecreate ? '\n\nCopado uses changed resolutions only when it rebuilds the promotion branch: tick Re-create promotion branch.' : '') +
    (last ? '\n\nThese are the last conflicts: Copado\u2019s editor would now set the promotion\u2019s status to "Conflicts Resolved".' : '');
  const pick = confirmed ? (opts.status && last ? 'Upload and set the status' : opts.recreate && offerRecreate ? 'Upload and tick Re-create branch' : 'Upload') :
    await vscode.window.showWarningMessage('Upload ' + ready.length + ' resolution' + (ready.length === 1 ? '' : 's') + ' to ' + st.name + '?', { modal: true, detail },
      ...(last ? ['Upload and set the status', 'Upload only'] : offerRecreate ? ['Upload and tick Re-create branch', 'Upload only'] : ['Upload']));
  if (!pick) return;
  const a = await api(c);
  let r;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Saving your resolutions to Copado' }, async () => {
    r = await W.uploadAll(a, current.s, ready, { status: pick === 'Upload and set the status' });
  });
  const st2 = current.s.load();
  const replaced = r.batch.files.filter(f => f.revised).length;
  W.logEvent(st2, 'upload', (replaced === r.uploaded.length && replaced ? 'Replaced ' + replaced + ' resolution' + (replaced === 1 ? '' : 's') + ' in Copado' : 'Uploaded ' + r.uploaded.length + ' resolution' + (r.uploaded.length === 1 ? '' : 's') + ' to Copado' + (replaced ? ' (' + replaced + ' replaced)' : '')) +
    (r.failed.length ? ', ' + r.failed.length + ' failed' : ''), 'each read back and identical');
  if (r.batch.statusChange) W.logEvent(st2, 'status', 'Status: ' + r.batch.statusChange.to, 'from ' + r.batch.statusChange.from);
  current.s.save(st2);
  changed.fire();
  for (const f of r.uploaded) h.output.appendLine('copado: uploaded ' + f.path + ' to ' + st.name + ' as "' + f.name + '" (' + f.bytes + ' bytes, read back and identical)');
  for (const f of r.failed) h.output.appendLine('copado: NOT uploaded ' + f.rel + ' - ' + f.reason);
  if (r.batch.statusChange) h.output.appendLine('copado: ' + st.name + ' status "' + r.batch.statusChange.from + '" \u2192 "' + r.batch.statusChange.to + '" (read back)');
  const left = Object.values(current.s.load().files).filter(e => !['uploaded', 'copado'].includes(e.state)).length;
  const msg = r.uploaded.length + ' uploaded to ' + st.name + (r.failed.length ? ', ' + r.failed.length + ' failed (see the output)' : '') +
    (r.batch.statusChange ? '. Status: ' + r.batch.statusChange.to + '. Continue the promotion in Copado.' : left ? '. ' + left + ' still to resolve.' : '.');
  if (pick === 'Upload and tick Re-create branch' && r.uploaded.length) await setRecreate(true, 'the resolutions changed after a validation');
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
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Putting ' + (b.files.length === 1 ? 'the file' : 'the ' + b.files.length + ' files') + ' back as ' + (b.files.length === 1 ? 'it was' : 'they were') + ' in Copado' },
    async () => W.undoBatch(await api(c), current.s, b));
  const st3 = current.s.load();
  W.logEvent(st3, 'undo', 'Undid the upload of ' + b.files.length + ' file' + (b.files.length === 1 ? '' : 's'), b.statusChange ? 'status back to ' + b.statusChange.from : '');
  current.s.save(st3);
  changed.fire();
  h.output.appendLine('copado: undid the upload of ' + b.files.length + ' file(s) to ' + b.promotion.name);
  vscode.window.showInformationMessage('Undone: ' + b.files.length + ' file' + (b.files.length === 1 ? ' is a conflict' : 's are conflicts') + ' again in Copado, still resolved here.');
}

/* ------------------------------------------------------------ the pre-check */

/**
 * The pre-check: the promotion as it would be with your resolutions, checked
 * with Salesforce before anything goes to Copado. Every conflict file is used
 * as resolved - your resolved file, what you uploaded, or the resolution made
 * in Copado's editor (fetched first) - on top of the stories' branches for the
 * rest. A file not resolved yet is left out of the check, never taken from a
 * branch in its place. The page follows the run step by step; the Output
 * panel is not opened.
 */
let activeRun = null;

async function precheck() {
  if (!current) return;
  h.requireTrust('The pre-check runs the Salesforce CLI');
  const c = needOrg();
  if (!c) return;
  if (activeRun && activeRun.state === 'running') { vscode.window.showInformationMessage('A pre-check is already running - see the Pre-check tab.'); return; }
  const st = current.s.load();
  const { ready, held } = W.readyFiles(current.s, st, libs);
  const readySet = new Set(ready.map(x => x.rel));
  const used = [], leftOut = [];
  for (const [rel, e] of Object.entries(st.files)) {
    if (readySet.has(rel)) used.push({ rel, from: e.revising ? 'your changed version' : e.state === 'auto' ? 'resolved automatically' : 'your resolution', file: current.s.file('resolved', rel) });
    else if (e.state === 'uploaded') used.push({ rel, from: 'what you uploaded', file: current.s.read('uploaded', rel) != null ? current.s.file('uploaded', rel) : current.s.file('resolved', rel) });
    else if (e.state === 'copado') used.push({ rel, from: 'resolved in Copado', copado: true });
    else leftOut.push({ rel, reason: (held.find(x => x.rel === rel) || {}).reason || (e.state === 'review' ? 'not reviewed yet' : 'not resolved yet') });
  }
  if (!used.length) { vscode.window.showInformationMessage('Resolve some files first - the pre-check checks your resolved files.'); return; }
  const run = activeRun = { id: Date.now().toString(36), at: new Date().toISOString(), state: 'running', promotion: st.name, steps: { gather: 'running', files: '', check: '', result: '' },
    phase: null, log: [], used: used.map(u => ({ rel: u.rel, from: u.from })), leftOut, target: null, files: null, result: null, message: null, finishedAt: null };
  const say = (text, kind) => { run.log.push({ at: new Date().toISOString(), text, kind: kind || 'info' }); if (run.log.length > 80) run.log.splice(0, run.log.length - 80); };
  const save = () => { const s2 = current && current.s.load(); if (!s2 || s2.id !== st.id) return; s2.precheck = run; current.s.save(s2); changed.fire(); };
  const finish = (state, message) => {
    if (run.state !== 'running') return;
    run.state = state; run.message = message || null; run.finishedAt = new Date().toISOString();
    for (const k of Object.keys(run.steps)) if (run.steps[k] === 'running') run.steps[k] = state === 'passed' ? 'done' : 'failed';
    if (message) say(message, state === 'passed' ? 'ok' : 'bad');
  };
  say('Started: ' + used.length + ' resolved file' + (used.length === 1 ? '' : 's') + (leftOut.length ? ', ' + leftOut.length + ' left out' : ''));
  save();
  const s2 = current.s.load();
  W.logEvent(s2, 'precheck', 'Pre-check started', used.length + ' resolved file' + (used.length === 1 ? '' : 's') + ' checked' + (leftOut.length ? ', ' + leftOut.length + ' left out (not resolved yet)' : ''));
  current.s.save(s2);
  const conflictOf = f => {
    const rels = Object.keys(st.files);
    if (f.file && rels.includes(f.file)) return f.file;
    return rels.find(rel => { const comp = W.componentOf(rel); return comp && comp.type.toLowerCase() === String(f.type).toLowerCase() && comp.name.toLowerCase() === W.decodeName(f.fullName).toLowerCase(); }) || null;
  };
  const onEvent = ev => {
    if (run.state !== 'running') return;
    if (ev.step === 'files' && ev.state === 'running') { run.steps.gather = 'done'; run.steps.files = 'running'; say(ev.message); }
    else if (ev.step === 'files' && ev.state === 'done') {
      run.steps.files = 'done';
      run.files = { fromBranches: ev.fromBranches, resolved: ev.resolved, leftOut: ev.leftOut, missing: ev.missing, branches: ev.branches };
      say('Prepared: ' + ev.message);
    } else if (ev.step === 'check' && ev.state === 'running') {
      run.steps.gather = run.steps.gather || 'done'; run.steps.files = run.steps.files === 'running' || !run.steps.files ? 'done' : run.steps.files; run.steps.check = 'running';
      run.target = { environment: ev.environment, alias: ev.target, username: ev.username, tests: ev.tests };
      say(ev.message);
    } else if (ev.step === 'check' && ev.phase) { run.phase = ev.phase; say(ev.phase); }
    else if (ev.step === 'done') {
      run.steps.check = 'done';
      run.steps.result = ev.success ? 'done' : 'failed';
      run.result = { success: ev.success, failures: ev.failures.map(f => Object.assign({}, f, { resolution: conflictOf(f) })), tests: ev.tests, coverage: ev.coverage, coverageRule: ev.coverageRule, cliError: ev.cliError };
      const n = ev.failures.length + ev.tests.length;
      finish(ev.success ? 'passed' : 'failed', ev.success ? 'Validated successfully.' :
        'Validation failed: ' + (ev.cliError ? ev.cliError : n + ' error' + (n === 1 ? '' : 's')) + '.');
    } else if (ev.step === 'error') finish('failed', ev.message);
    save();
  };
  try {
    const a = await api(c);
    const info = current.info || {};
    let rows = [], branches = [], stories = [], localOrgs = [], creds = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Getting ready for the pre-check of ' + st.name }, async () => {
      // the promotion's own component list, if Copado attached one
      try {
        const links = await a.query("SELECT ContentDocument.Title, ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId = '" +
          String(st.id).replace(/[^A-Za-z0-9]/g, '') + "'");
        const list = links.map(l => l.ContentDocument || {}).filter(d => /promotion changes/i.test(d.Title || '')).sort((x, y) => String(y.CreatedDate).localeCompare(String(x.CreatedDate)));
        if (list[0]) rows = JSON.parse((await a.download('ContentVersion', list[0].LatestPublishedVersionId)).toString('utf8'));
      } catch (e) { h.output.appendLine('copado: no promotion change list (' + e.message + ') - checking the resolved files on their own'); }
      if (!Array.isArray(rows)) rows = [];
      for (const u of used) {
        const comp = W.componentOf(u.rel);
        if (comp && !rows.some(r => r.t === comp.type && W.decodeName(r.n) === comp.name)) rows.push({ t: comp.type, n: comp.name, a: 'Add' });
      }
      // a resolution made in Copado's editor is used as Copado holds it
      for (const u of used.filter(x => x.copado)) {
        const e = st.files[u.rel];
        u.file = current.s.write('incopado', u.rel, Buffer.from(await a.download('Attachment', e.attachmentId)).toString('utf8'));
      }
      // the rest of the promotion: the stories' branches - for a back-promotion, the source environment's
      stories = [...new Set(Object.values(st.files).map(e => e.story).filter(Boolean))];
      const pattern = vscode.workspace.getConfiguration('cmr').get('repo.featureBranch', 'feature/{story}');
      if (info.back && info.sourceBranch) branches = [info.sourceBranch];
      else {
        const known = await L.promotionStories(a, st.id).catch(() => []);
        for (const name of stories) {
          const rec = known.find(k => k.name === name);
          const fb = rec ? await L.featureBranch(a, rec, pattern).catch(() => null) : null;
          branches.push(fb ? fb.branch : pattern.split('{story}').join(name));
        }
      }
      try { localOrgs = await h.orgList(c, h.projectRoot()); } catch (e) { /* asked below */ }
      creds = await h.credentialsFor(a, [st.toId].filter(Boolean), localOrgs);
    });
    run.steps.gather = 'done';
    run.branches = branches;
    say('Collected ' + rows.length + ' component' + (rows.length === 1 ? '' : 's') + '; the rest from ' + (branches.join(', ') || 'the stories\u2019 branches'));
    save();
    const target = await h.orgForEnvironment(c, { credentials: creds }, st.toId, st.to, localOrgs, 'target - validated against, nothing is deployed');
    if (!target) { finish('stopped', 'Not checked: no Salesforce login chosen for ' + (st.to || 'the destination') + '.'); save(); return; }
    await h.runBranchCheck({ rows, branches, name: st.name + '-precheck', api: a, pipelineId: info.pipelineId, toId: st.toId, fromId: st.fromId, environment: st.to,
      overlay: used.map(u => ({ rel: u.rel, file: u.file })), exclude: leftOut.map(x => x.rel), target, quiet: true, onEvent,
      label: 'pre-check of ' + st.name + (leftOut.length ? ' (' + leftOut.length + ' not resolved yet, left out)' : ''),
      meta: { source: 'pre-check', promotion: st.name, stories } });
    finish('stopped', 'Validation stopped before Salesforce answered.');
  } catch (e) {
    finish('failed', e.message);
  } finally {
    save();
    if (current) {
      const s3 = current.s.load();
      if (s3 && s3.id === st.id && run.state !== 'running') { W.logEvent(s3, 'precheck', run.state === 'passed' ? 'Pre-check: validated successfully' : run.state === 'failed' ? 'Pre-check: validation failed' : 'Pre-check: validation stopped', run.message || ''); current.s.save(s3); changed.fire(); }
    }
  }
}

/** Validates the promotion branch - what Copado deploys - once no conflict is open. */
async function validateBranch() {
  if (!current) { vscode.window.showInformationMessage('Open the promotion first.'); return; }
  const st = current.s.load() || {};
  const open = Object.values(st.files || {}).filter(e => !['uploaded', 'copado'].includes(e.state)).length;
  if (open) {
    const go = await vscode.window.showWarningMessage(st.name + ' still has ' + open + ' conflict file(s) open - the promotion branch does not have their resolutions yet.', { modal: true,
      detail: 'The pre-check validates the feature branches with your resolutions on top instead.' }, 'Pre-check instead', 'Validate the branch anyway');
    if (go === 'Pre-check instead') return precheck();
    if (go !== 'Validate the branch anyway') return;
  }
  const p = current.promotion;
  const st5 = current.s.load();
  if (st5) { W.logEvent(st5, 'precheck', 'Promotion branch validation started', (current.info && current.info.promotionBranch) || ''); current.s.save(st5); changed.fire(); }
  await h.validatePromotionBranch({ id: p.id, name: p.name, to: p.to, toId: p.toId, from: p.from, fromId: p.fromId, pipelineId: current.info && current.info.pipelineId });
}

/* ------------------------------------------------------------ Copado's deployment, followed */

let watchTimer = null;
let jobTrees = null, jobTreesOrg = null;

function stopWatch() { if (watchTimer) clearTimeout(watchTimer); watchTimer = null; }

/** Reads the promotion's job records once; keeps polling, read-only, while a job runs. */
/**
 * What the promotion's stories committed: Copado's promotion change list, else each story's commit
 * (src/lifecycle.js) - with the story each came from. Read once, read-only; where each stands is worked
 * out with the page's state (componentsView), so it follows the conflicts and the pre-check as they change.
 */
async function readComponents() {
  if (!current) return;
  const c = needOrg();
  if (!c) return;
  const at = current;
  at.components = { loading: true };
  changed.fire();
  try {
    const a = await api(c);
    const notes = [];
    const stories = await L.promotionStories(a, at.promotion.id);
    const [all, per] = await Promise.all([L.promotionComponents(a, at.promotion.id, stories, notes), L.storyComponents(a, stories, notes).catch(() => ({}))]);
    const byStory = new Map();
    for (const st of stories) for (const r of (per[st.id] || {}).rows || []) {
      const k = (r.t + '|' + W.decodeName(r.n)).toLowerCase();
      (byStory.get(k) || byStory.set(k, new Set()).get(k)).add(st.name);
    }
    const seen = new Map();
    for (const r of all.rows || []) {
      const name = W.decodeName(r.n), k = (r.t + '|' + name).toLowerCase();
      if (!seen.has(k)) seen.set(k, { type: r.t, name, action: r.a || 'Add', stories: [...(byStory.get(k) || [])].sort() });
    }
    at.components = { at: Date.now(), source: all.source, notes, rows: [...seen.values()].sort((x, y) => x.type.localeCompare(y.type) || x.name.localeCompare(y.name)) };
    h.output.appendLine('copado: ' + at.promotion.name + ' - ' + at.components.rows.length + ' component(s) from ' + (all.source || 'nowhere') + (notes.length ? ' (' + notes.join('; ') + ')' : ''));
  } catch (e) {
    at.components = { error: e.message };
  }
  if (current === at) changed.fire();
}

/** Each committed component and where it stands: a conflict (resolved or not), from the branch, not on the branch. */
function componentsView(st, comps) {
  if (!comps || !comps.rows) return comps || null;
  const conflicts = new Map();
  for (const [rel, e] of Object.entries(st.files)) { const c = W.componentOf(rel); if (c) conflicts.set((c.type + '|' + c.name).toLowerCase(), { rel, state: e.state }); }
  const pre = st.precheck && st.precheck.files ? st.precheck : null;
  const notOnBranch = new Set(((pre && pre.files.missing) || []).map(m => m.toLowerCase().replace(/ \(type not supported\)$/, '').replace(/^(\S+) /, '$1|')));
  const rows = comps.rows.map(r => {
    const k = (r.type + '|' + r.name).toLowerCase(), cf = conflicts.get(k);
    const where = cf ? (['uploaded', 'copado'].includes(cf.state) ? 'conflict-uploaded' : ['resolved', 'auto'].includes(cf.state) ? 'conflict-resolved' : 'conflict-open')
      : notOnBranch.has(k) ? 'missing' : pre && pre.state !== 'running' ? 'branch' : 'commit';
    return Object.assign({}, r, { where, rel: cf ? cf.rel : null });
  });
  const count = w => rows.filter(r => r.where === w).length;
  return { at: comps.at, source: comps.source, rows, checked: !!pre, branches: pre ? pre.files.branches || [] : [],
    counts: { all: rows.length, conflicts: rows.filter(r => r.where.startsWith('conflict')).length, missing: count('missing') } };
}

async function readJobs(opts) {
  if (!current) return;
  const c = needOrg();
  if (!c) return;
  const id = current.promotion.id;
  // asked for: a notification at the bottom; the polling while a job runs stays quiet
  const quietly = fn => fn();
  const shown = fn => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking how ' + current.promotion.name + ' is going in Copado' }, fn);
  try {
    // inside the try: an expired login while following is said on the tab, not lost
    const a = await api(c);
    const { snap, errors } = await ((opts && opts.notify) ? shown : quietly)(async () => {
      if (!jobTrees || jobTreesOrg !== c.copadoOrg) { jobTrees = await J.discover(a); jobTreesOrg = c.copadoOrg; }
      const sn = await J.snapshot(a, id, jobTrees);
      return { snap: sn, errors: sn.failed ? await J.errorsOf(a, sn) : [] };
    });
    if (!current || current.promotion.id !== id) return;
    current.jobs = { at: new Date().toISOString(), snap, errors: withResolutions(errors), objects: jobTrees.map(t => t.obj), watching: snap.running, error: null };
    await untickIfValidated(snap).catch(e => h.output.appendLine('copado: could not untick Re-create promotion branch - ' + e.message));
  } catch (e) {
    if (current) current.jobs = { at: new Date().toISOString(), snap: null, errors: [], objects: [], watching: false, error: e.message };
  }
  changed.fire();
  stopWatch();
  const every = Math.max(5, Number(vscode.workspace.getConfiguration('cmr').get('copado.watchSeconds', 15)) || 15);
  if (current && current.jobs && current.jobs.watching && !(opts && opts.once)) watchTimer = setTimeout(() => readJobs({ notify: false }).catch(() => {}), every * 1000);
}

/** Each component error with the promotion's conflict file for that component, when there is one - the resolution to look at. */
function withResolutions(errors) {
  const st = current && current.s.load();
  if (!st) return errors;
  const byComp = new Map();
  for (const rel of Object.keys(st.files)) { const c = W.componentOf(rel); if (c) byComp.set((c.type + '|' + c.name).toLowerCase(), rel); }
  return errors.map(e => Object.assign({}, e, { resolution: byComp.get((e.type + '|' + W.decodeName(e.fullName)).toLowerCase()) || null }));
}

/** The deployment's component errors in Deploy Check, mapped to files with the fix advice. */
async function jobErrors() {
  if (!current || !current.jobs || !current.jobs.errors.length) { vscode.window.showInformationMessage('No component errors in Copado\u2019s deployment of this promotion.'); return; }
  const mapped = await h.showCopadoErrors(current.jobs.errors, { label: 'Copado\u2019s deployment of ' + current.promotion.name, environment: current.promotion.to });
  current.jobs.mapped = mapped.map((m, i) => Object.assign({}, m, { resolution: current.jobs.errors[i] && current.jobs.errors[i].resolution }));
  changed.fire();
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
  stopWatch();
  current = null;
  changed.fire();
}

/** Everything the page shows, in one object. */
async function snapshot() {
  const dir = (await h.deps.storageDir('promotions')).fsPath;
  let recent = [];
  try {
    const names = [...new Set(ctx.workspaceState.get('cmr.recentPromotions', []).concat(fs.readdirSync(dir)))];
    recent = names.map(n => ({ n, st: W.store(path.join(dir, n.replace(/[^\w.-]/g, '_'))).load() })).filter(x => x.st).slice(0, 8).map(({ st }) => {
      const files = Object.values(st.files);
      const c = k => files.filter(e => k.includes(e.state)).length;
      return { name: st.name, status: st.status || '', from: st.from, to: st.to, total: files.length, ready: c(['auto', 'resolved']), review: c(['review']), code: c(['code', 'error']), done: c(['uploaded', 'copado']), syncedAt: st.syncedAt };
    });
  } catch (e) { /* nothing yet */ }
  const c = h.rc();
  const out = { copadoOrg: c.copadoOrg || '', recent, current: null, validation: h.validationStatus ? h.validationStatus() : null, autoResolve: autoOn() };
  if (current) {
    const st = current.s.load();
    if (st) {
      const { ready, held } = W.readyFiles(current.s, st, libs);
      const open = Object.values(st.files).filter(e => !['uploaded', 'copado'].includes(e.state)).length;
      out.current = { promotion: Object.assign({}, current.promotion, { status: current.promotion.status }), state: st, info: current.info || null, precheck: st.precheck || null,
        jobs: current.jobs ? { at: current.jobs.at, watching: current.jobs.watching, error: current.jobs.error, objects: current.jobs.objects, errors: current.jobs.errors, mapped: current.jobs.mapped || null,
          jobs: current.jobs.snap ? current.jobs.snap.jobs.map(slim) : [], running: current.jobs.snap ? current.jobs.snap.running : false, failed: current.jobs.snap ? current.jobs.snap.failed : false, finished: current.jobs.snap ? current.jobs.snap.finished : false } : null,
        plan: { ready: ready.map(x => ({ rel: x.rel, how: x.entry.revising ? 'replaces the one in Copado' : x.entry.state === 'auto' ? 'auto' : 'yours', revising: !!x.entry.revising })), held,
          last: open === ready.length && ready.length > 0 && !ready.some(x => x.entry.revising), revised: ready.filter(x => x.entry.revising).length },
        // resolutions in Copado that a deployment would trip on: not well-formed, or named by Copado's latest errors
        health: W.uploadedHealth(current.s, st, libs),
        flagged: (current.jobs && current.jobs.errors || []).filter(e => e.resolution).reduce((m, e) => { (m[e.resolution] = m[e.resolution] || []).push(e.problem); return m; }, {}),
        canUndo: !!W.lastBatch(current.s),
        components: componentsView(st, current.components) };
    }
  }
  return out;
}

/** A job record for the page: what it is, how far, any error - and its children the same way. */
function slim(x) {
  return { id: x.id, name: x.name, kind: x.kind, status: x.status, state: x.state, progress: x.progress, error: x.error ? String(x.error).slice(0, 400) : '', type: x.type, created: x.created, modified: x.modified,
    children: (x.children || []).map(slim) };
}

/** The page's actions. */
/*
 * One Copado action at a time: a second click while one runs - Upload twice,
 * say - is told so instead of starting it again. Quick local actions are not
 * held up.
 */
const ONE_AT_A_TIME = { open: 'opening the promotion', refresh: 'checking for updates', upload: 'saving to Copado', undo: 'undoing the upload',
  validateBranch: 'validating the promotion branch', revise: 'getting the resolution from Copado', recreate: 'changing Re-create promotion branch', readiness: 'the readiness report' };
let busyWith = null;

async function act(name, p) {
  if (ONE_AT_A_TIME[name]) {
    if (busyWith) { vscode.window.showInformationMessage('Still busy with ' + busyWith + ' - one moment.'); return; }
    busyWith = ONE_AT_A_TIME[name];
    try { return await actOnce(name, p); } finally { busyWith = null; }
  }
  return actOnce(name, p);
}

async function actOnce(name, p) {
  const rel = p && p.rel;
  switch (name) {
    case 'open': return openRef(p.ref);
    case 'refresh': return refresh();
    case 'review': return review(rel);
    case 'accept': return accept(rel);
    case 'choose': return choose(rel, p.choices);
    case 'compare': return compare(rel);
    case 'reset': return reset(rel);
    case 'copy': return copy(rel);
    case 'undo': return undoUpload();
    case 'precheck': return precheck();
    case 'validateBranch': return validateBranch();
    case 'jobs': return readJobs({ notify: true });
    case 'components': return readComponents();
    case 'revise': return revise(rel);
    case 'recreate': return setRecreate(!!p.value);
    case 'upload': return uploadAll({ confirmed: true, status: !!p.status, recreate: !!p.recreate });
    case 'jobErrors': return jobErrors();
    case 'readiness': return current && h.readinessReport({ promotion: Object.assign({}, current.promotion) });
    case 'openInCopado': return openInCopado();
    case 'close': return close();
    case 'home': stopWatch(); current = null; changed.fire(); return;
    case 'stopWatch': stopWatch(); return;
    default: return;
  }
}

/** Opens a promotion from elsewhere on the page (the pipeline, a story's journey). */
async function openById(id) { return openRef(id); }

/** The working folders in use: the promotion open on the page. */
function openDirs() { return current && current.s && current.s.dir ? [current.s.dir] : []; }

module.exports = { openDirs, activate, promotionRef, snapshot, act, openById, onChange: f => changed.event(f), fire: () => changed.fire(), componentsView };
