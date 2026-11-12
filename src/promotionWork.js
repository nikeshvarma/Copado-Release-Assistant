'use strict';

/**
 * The local workspace for one Copado promotion's conflicts.
 *
 *   <dir>/promotion.json         header + each file's state
 *   <dir>/conflicted/<path>      as fetched from Copado, markers and all (never edited)
 *   <dir>/promotion/<path>       the promotion branch side (HEAD)
 *   <dir>/feature/<path>         the story's side
 *   <dir>/base/<path>            the common ancestor, when the markers carry it
 *   <dir>/merged/<path>          the automatic result, for Reset
 *   <dir>/resolved/<path>        the result you upload - the one folder you edit
 *   <dir>/uploads.json           what was written to Copado, batch by batch, for undo
 *
 * File states: auto (resolved automatically) | review (real conflicts to look at)
 * | code (code blocks left for VS Code's buttons) | resolved (accepted here)
 * | uploaded (written to Copado and read back) | copado (resolved in Copado meanwhile) | error.
 *
 * Plain Node.js; the Copado access and the merge are injected.
 */
const fs = require('fs');
const path = require('path');
const P = require('./promotion');

const READY = ['auto', 'resolved'];

function store(dir) {
  const file = (folder, rel) => path.join(dir, folder, ...String(rel).split('/'));
  const self = {
    dir,
    file,
    read: (folder, rel) => { try { return fs.readFileSync(file(folder, rel), 'utf8'); } catch (e) { return null; } },
    write: (folder, rel, text) => { const f = file(folder, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; },
    remove: (folder, rel) => { try { fs.unlinkSync(file(folder, rel)); } catch (e) { /* not there */ } },
    load: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'promotion.json'), 'utf8')); } catch (e) { return null; } },
    save: st => {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, 'promotion.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
      fs.renameSync(tmp, path.join(dir, 'promotion.json'));
    }
  };
  return self;
}

/* ------------------------------------------------------------ the automatic pass */

/**
 * Settles the code conflict blocks that need no decision: both sides the same,
 * or (with the common ancestor) only one side changed. Returns the text with
 * only the real clashes still marked, and how many remain.
 */
function settleCodeBlocks(text) {
  const lines = String(text).split(/(?<=\n)/);
  const out = [];
  let remaining = 0, settled = 0, i = 0;
  while (i < lines.length) {
    if (!/^<{7}( |\r?\n|$)/.test(lines[i])) { out.push(lines[i++]); continue; }
    const block = { open: lines[i++], ours: [], base: null, mid: null, theirs: [], close: null };
    let part = 'ours';
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (part === 'ours' && /^\|{7}( |\r?\n|$)/.test(l)) { part = 'base'; block.base = []; block.baseOpen = l; continue; }
      if ((part === 'ours' || part === 'base') && /^={7}\r?\n?$/.test(l)) { part = 'theirs'; block.mid = l; continue; }
      if (part === 'theirs' && /^>{7}( |\r?\n|$)/.test(l)) { block.close = l; i++; break; }
      block[part].push(l);
    }
    if (!block.close) { out.push(block.open, ...block.ours, ...(block.base ? [block.baseOpen, ...block.base] : []), ...(block.mid ? [block.mid] : []), ...block.theirs); remaining++; break; }
    const o = block.ours.join(''), t = block.theirs.join(''), b = block.base ? block.base.join('') : null;
    let take = null;
    if (o === t) take = o;
    else if (b != null && o === b) take = t;
    else if (b != null && t === b) take = o;
    if (take != null) { out.push(take); settled++; } else { out.push(block.open, ...block.ours, ...(block.base ? [block.baseOpen, ...block.base] : []), block.mid, ...block.theirs, block.close); remaining++; }
  }
  return { text: out.join(''), remaining, settled };
}

/**
 * One conflicted file -> what to show and what to upload. merge(ours, theirs, base)
 * returns { ok, mergedText, conflicts } for metadata XML.
 */
async function autoResolve(rel, conflictedText, merge) {
  const parts = P.splitConflicts(conflictedText);
  if (!parts.ok) return { state: 'error', note: parts.reason, kind: 'code' };
  const meta = { blocks: parts.blocks, labels: parts.labels, hasBase: parts.base != null };
  if (!parts.blocks) return Object.assign(meta, { state: 'auto', kind: kindOf(rel), sides: parts, merged: conflictedText, note: 'no conflict markers' });
  if (kindOf(rel) === 'xml') {
    let r = null;
    try { r = await merge(parts.ours, parts.theirs, parts.base); } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok) {
      return Object.assign(meta, { kind: 'xml', sides: parts, merged: r.mergedText, conflicts: r.conflicts,
        state: r.conflicts ? 'review' : 'auto', note: r.conflicts ? r.conflicts + ' real conflict' + (r.conflicts === 1 ? '' : 's') + ' to review' : 'resolved automatically' });
    }
    // sides that are not valid XML on their own: resolve like code
    meta.note = 'merged as text (' + ((r && r.error) || 'not valid XML on its own') + ')';
  }
  const s = settleCodeBlocks(conflictedText);
  return Object.assign(meta, { kind: 'code', sides: parts, merged: s.text, conflicts: s.remaining,
    state: s.remaining ? 'code' : 'auto',
    note: (meta.note ? meta.note + '; ' : '') + (s.remaining ? s.remaining + ' block' + (s.remaining === 1 ? '' : 's') + ' to resolve' + (s.settled ? ', ' + s.settled + ' settled' : '') : 'every block settled automatically') });
}

function kindOf(rel) { return /\.xml$/i.test(rel) ? 'xml' : 'code'; }

/* ------------------------------------------------------------ fetch and refresh */

/**
 * Brings the local workspace up to date with Copado: new or changed conflict
 * files are downloaded (in parallel) and passed through the automatic pass;
 * files resolved in Copado meanwhile are marked and never overwritten; your
 * local resolutions of unchanged files are kept.
 */
async function sync(api, s, promotion, merge, opts) {
  const o = opts || {};
  const st = s.load() || { files: {} };
  Object.assign(st, { id: promotion.id, name: promotion.name, from: promotion.from, to: promotion.to,
    fromId: promotion.fromId, toId: promotion.toId, copadoOrg: o.copadoOrg || st.copadoOrg, syncedAt: new Date().toISOString() });
  const atts = await api.query("SELECT Id, Name, BodyLength, LastModifiedDate FROM Attachment WHERE ParentId = '" + String(promotion.id).replace(/[^A-Za-z0-9]/g, '') +
    "' ORDER BY LastModifiedDate DESC LIMIT 500");
  const seen = new Set();
  const fetch = [];
  for (const a of atts) {
    const n = P.parseConflictName(a.Name);
    if (!n || seen.has(n.path)) continue;
    seen.add(n.path);
    const e = st.files[n.path] || {};
    if (n.resolved) {
      if (!(e.state === 'uploaded' && e.attachmentId === a.Id)) st.files[n.path] = Object.assign(e, { attachmentId: a.Id, attachmentName: a.Name, story: n.story, modified: a.LastModifiedDate, state: 'copado', note: 'resolved in Copado' });
      continue;
    }
    if (e.attachmentId === a.Id && e.modified === a.LastModifiedDate && e.state && e.state !== 'copado' && e.state !== 'error') continue;
    fetch.push({ a, n, previous: e });
  }
  const results = await Promise.all(fetch.map(async ({ a, n, previous }) => {
    const text = (await api.download('Attachment', a.Id)).toString('utf8');
    const r = await autoResolve(n.path, text, merge);
    s.write('conflicted', n.path, text);
    if (r.sides) {
      s.write('promotion', n.path, r.sides.ours);
      s.write('feature', n.path, r.sides.theirs);
      if (r.sides.base != null) s.write('base', n.path, r.sides.base); else s.remove('base', n.path);
    }
    if (r.merged != null) s.write('merged', n.path, r.merged);
    // a resolution you made for an older version is kept beside the new one
    const mine = s.read('resolved', n.path);
    if (mine != null && previous.state === 'resolved') s.write('resolved', n.path + '.mine', mine);
    s.write('resolved', n.path, r.merged != null ? r.merged : text);
    st.files[n.path] = { attachmentId: a.Id, attachmentName: a.Name, story: n.story, modified: a.LastModifiedDate, kind: r.kind, state: r.state,
      blocks: r.blocks || 0, conflicts: r.conflicts || 0, labels: r.labels, hasBase: !!r.hasBase, note: (previous.state === 'resolved' ? 'changed in Copado - fetched again; your earlier resolution is in resolved/' + n.path + '.mine. ' : '') + (r.note || '') };
    return n.path;
  }));
  s.save(st);
  return { state: st, fetched: results.length };
}

/* ------------------------------------------------------------ checks and upload */

/**
 * The checks a resolved file must pass before it goes to Copado: no markers;
 * for metadata, valid XML of the same type as the promotion side, no duplicate
 * entries and no deploy-breaking rule errors.
 */
function gates(s, rel, entry, libs) {
  const text = s.read('resolved', rel);
  if (text == null) return { ok: false, reason: 'no resolved file' };
  if (P.hasMarkers(text)) return { ok: false, reason: 'conflict markers left' };
  if (entry.kind === 'xml') {
    let doc;
    try { doc = libs.X.parse(text); } catch (e) { return { ok: false, reason: 'not valid XML: ' + e.message }; }
    if (!doc.root) return { ok: false, reason: 'not valid XML' };
    const side = s.read('promotion', rel);
    let want = null;
    try { want = side ? libs.X.parse(side).root.name : null; } catch (e) { want = null; }
    if (want && doc.root.name !== want) return { ok: false, reason: 'a <' + doc.root.name + '>, not a <' + want + '>' };
    const dups = libs.duplicates.findDuplicates(doc, {}).filter(d => d.severity !== 'info');
    if (dups.length) return { ok: false, reason: dups.length + ' duplicate entr' + (dups.length === 1 ? 'y' : 'ies') };
    const errs = libs.rules.check(doc, {}).filter(v => v.severity === 'error');
    if (errs.length) return { ok: false, reason: errs[0].message + (errs.length > 1 ? ' (+' + (errs.length - 1) + ' more)' : '') };
  }
  return { ok: true, text };
}

/** The files ready to upload, and those held back by a check. */
function readyFiles(s, st, libs) {
  const ready = [], held = [];
  for (const [rel, e] of Object.entries(st.files)) {
    if (!READY.includes(e.state)) continue;
    const g = gates(s, rel, e, libs);
    if (g.ok) ready.push({ rel, entry: e, text: g.text }); else held.push({ rel, reason: g.reason });
  }
  return { ready, held };
}

/**
 * Uploads every ready file in parallel, each as Copado's editor would and read
 * back, recording the batch for undo. Returns { uploaded, failed, batch }.
 */
async function uploadAll(api, s, list, opts) {
  const st = s.load();
  const batch = { id: 'b' + Date.now().toString(36), when: new Date().toISOString(), promotion: { id: st.id, name: st.name }, copadoOrg: st.copadoOrg, files: [] };
  const failed = [];
  await Promise.all(list.map(async x => {
    try {
      const r = await P.uploadResolution(api, { id: x.entry.attachmentId, name: x.entry.attachmentName, modified: x.entry.modified }, x.text);
      batch.files.push({ path: x.rel, id: r.id, previousName: r.previousName, name: r.name, bytes: r.bytes });
      Object.assign(st.files[x.rel], { state: 'uploaded', uploadedName: r.name, uploadedAt: new Date().toISOString(), attachmentName: r.name, note: 'uploaded and read back' });
    } catch (e) {
      failed.push({ rel: x.rel, reason: e.message });
    }
  }));
  if (batch.files.length && opts && opts.status) {
    const change = await P.markConflictsResolved(api, st.id);
    if (change.to) batch.statusChange = { from: change.from, to: change.to };
  }
  s.save(st);
  if (batch.files.length) appendLog(s, batch);
  return { uploaded: batch.files, failed, batch };
}

function appendLog(s, batch) {
  const f = path.join(s.dir, 'uploads.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* first */ }
  log.push(batch);
  fs.writeFileSync(f, JSON.stringify(log, null, 2));
}

/** The most recent batch not yet undone. */
function lastBatch(s) {
  try { return [...JSON.parse(fs.readFileSync(path.join(s.dir, 'uploads.json'), 'utf8'))].reverse().find(b => !b.undone) || null; } catch (e) { return null; }
}

/** Puts a batch back: every attachment to its conflict name and content, the status if it is still ours. */
async function undoBatch(api, s, batch) {
  const st = s.load();
  await Promise.all(batch.files.map(async f => {
    await P.restoreAttachment(api, { id: f.id, previousName: f.previousName, original: s.read('conflicted', f.path) });
    if (st.files[f.path]) Object.assign(st.files[f.path], { state: 'resolved', attachmentName: f.previousName, note: 'upload undone - resolved here, not in Copado' });
  }));
  if (batch.statusChange) await P.restoreStatus(api, batch.promotion.id, batch.statusChange);
  // the attachments changed again: their times are re-read on the next refresh
  s.save(st);
  const f = path.join(s.dir, 'uploads.json');
  const log = JSON.parse(fs.readFileSync(f, 'utf8'));
  const it = log.find(b => b.id === batch.id);
  if (it) it.undone = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(log, null, 2));
}

/* ------------------------------------------------------------ the pre-check */

// source-format folders -> metadata types, for building a package from file paths
const FOLDERS = {
  classes: 'ApexClass', triggers: 'ApexTrigger', pages: 'ApexPage', components: 'ApexComponent', permissionsets: 'PermissionSet',
  permissionsetgroups: 'PermissionSetGroup', profiles: 'Profile', layouts: 'Layout', flexipages: 'FlexiPage', flows: 'Flow',
  customMetadata: 'CustomMetadata', labels: 'CustomLabels', staticresources: 'StaticResource', tabs: 'CustomTab', applications: 'CustomApplication',
  quickActions: 'QuickAction', customPermissions: 'CustomPermission', workflows: 'Workflow', approvalProcesses: 'ApprovalProcess',
  globalValueSets: 'GlobalValueSet', standardValueSets: 'StandardValueSet', remoteSiteSettings: 'RemoteSiteSetting', namedCredentials: 'NamedCredential'
};
const OBJECT_CHILDREN = { fields: 'CustomField', recordTypes: 'RecordType', listViews: 'ListView', validationRules: 'ValidationRule', webLinks: 'WebLink',
  compactLayouts: 'CompactLayout', fieldSets: 'FieldSet', businessProcesses: 'BusinessProcess' };

/** A source path -> { type, name }, or null for a folder it does not know. */
function componentOf(rel) {
  const parts = String(rel).split('/');
  const strip = f => f.replace(/\.[A-Za-z]+-meta\.xml$/, '').replace(/\.(cls|trigger|page|component)$/, '');
  for (let i = 0; i < parts.length - 1; i++) {
    const folder = parts[i];
    if (folder === 'lwc' || folder === 'aura') return parts[i + 1] ? { type: folder === 'lwc' ? 'LightningComponentBundle' : 'AuraDefinitionBundle', name: parts[i + 1] } : null;
    if (folder === 'objects' && parts[i + 1]) {
      const obj = parts[i + 1];
      if (parts[i + 2] && OBJECT_CHILDREN[parts[i + 2]] && parts[i + 3]) return { type: OBJECT_CHILDREN[parts[i + 2]], name: obj + '.' + strip(parts[i + 3]) };
      if (parts[i + 2] && parts[i + 2] === obj + '.object-meta.xml') return { type: 'CustomObject', name: obj };
      return null;
    }
    if (FOLDERS[folder] && i === parts.length - 2) return { type: FOLDERS[folder], name: strip(parts[i + 1]) };
  }
  return null;
}

/**
 * Puts the resolved files into the project (after the pre-check's retrieve),
 * backing up what they replace. Returns the record for undoOverlay.
 */
function overlay(s, root, rels, stamp) {
  const id = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const rec = { id, files: [] };
  for (const rel of rels) {
    const target = path.join(root, ...rel.split('/'));
    const backup = fs.existsSync(target) ? s.file(path.join('precheck-backup', id), rel) : null;
    if (backup) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(target, backup); }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(s.file('resolved', rel), target);
    rec.files.push({ rel, target, backup });
  }
  fs.writeFileSync(path.join(s.dir, 'precheck.json'), JSON.stringify(rec, null, 2));
  return rec;
}

/** Restores the project files the last pre-check replaced. */
function undoOverlay(s) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(s.dir, 'precheck.json'), 'utf8')); } catch (e) { return null; }
  for (const f of rec.files) {
    if (f.backup && fs.existsSync(f.backup)) fs.copyFileSync(f.backup, f.target);
    else if (!f.backup && fs.existsSync(f.target)) fs.unlinkSync(f.target);
  }
  fs.renameSync(path.join(s.dir, 'precheck.json'), path.join(s.dir, 'precheck.undone.json'));
  return rec;
}

module.exports = { store, settleCodeBlocks, autoResolve, sync, gates, readyFiles, uploadAll, lastBatch, undoBatch, componentOf, overlay, undoOverlay, READY };
