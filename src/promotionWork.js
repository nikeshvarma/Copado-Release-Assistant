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
const X = require('./xmlParser');

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
 * only the real conflicts still marked, and how many remain.
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
/**
 * The first pass over a conflict file. With auto on (cmr.promotion.autoResolve),
 * what needs no decision is resolved: state 'auto', ready to upload. With it
 * off - the default - nothing is: a clean XML merge is only a suggestion to
 * review and accept (state 'review', suggestion), and code keeps every
 * conflict block for you to decide.
 */
async function autoResolve(rel, conflictedText, auto) {
  const on = auto !== false;
  const parts = P.splitConflicts(conflictedText);
  if (!parts.ok) return { state: 'error', note: parts.reason, kind: 'code' };
  const meta = { blocks: parts.blocks, labels: parts.labels, hasBase: parts.base != null };
  if (!parts.blocks) return Object.assign(meta, on ? { state: 'auto', note: 'no conflict markers' } : { state: 'review', suggestion: true, note: 'no conflict markers - check it and accept' },
    { kind: kindOf(rel), sides: parts, merged: conflictedText });
  if (kindOf(rel) === 'xml') {
    // never a merge of ours: the two sides were rebuilt from Copado's file, each holding git's merge already.
    // Files whose entries add up - the target's entries kept, the feature's added; every other one, its conflicts yours
    const type = (/<([A-Za-z][\w]*)[\s>]/.exec(String(conflictedText).replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '')) || [])[1] || null;
    const u = require('./mergeStart').ADDITIVE.has(type) ? require('./unionMerge').resolve(conflictedText, type) : null;
    if (u && u.ok) return Object.assign(meta, { kind: 'xml', sides: parts, merged: u.text, conflicts: 0,
      state: on ? 'auto' : 'review', suggestion: !on, note: on ? 'resolved: the target kept, the feature added' : 'the target kept, the feature added - review it and accept' });
    return Object.assign(meta, { kind: 'xml', sides: parts, merged: conflictedText, conflicts: parts.blocks, state: 'review', suggestion: false,
      note: parts.blocks + ' conflict' + (parts.blocks === 1 ? '' : 's') + ' to resolve' + (u ? ' (' + u.reason + ')' : '') });
  }
  // with auto off, every block stays for you to decide
  const s = on ? settleCodeBlocks(conflictedText) : { text: conflictedText, remaining: parts.blocks, settled: 0 };
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
async function sync(api, s, promotion, opts) {
  const o = opts || {};
  const st = s.load() || { files: {} };
  Object.assign(st, { id: promotion.id, name: promotion.name, status: promotion.status || st.status, from: promotion.from, to: promotion.to,
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
      if (e.revising && e.attachmentId === a.Id) continue;
      if (!(e.state === 'uploaded' && e.attachmentId === a.Id)) st.files[n.path] = Object.assign(e, { attachmentId: a.Id, attachmentName: a.Name, story: n.story, modified: a.LastModifiedDate, state: 'copado', note: 'resolved in Copado' });
      continue;
    }
    if (e.attachmentId === a.Id && e.modified === a.LastModifiedDate && e.state && e.state !== 'copado' && e.state !== 'error') continue;
    fetch.push({ a, n, previous: e });
  }
  const results = await Promise.all(fetch.map(async ({ a, n, previous }) => {
    const text = (await api.download('Attachment', a.Id)).toString('utf8');
    const r = await autoResolve(n.path, text, o.autoResolve);
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
      blocks: r.blocks || 0, conflicts: r.conflicts || 0, autoState: r.state, suggestion: !!r.suggestion, labels: r.labels, hasBase: !!r.hasBase, note: (previous.state === 'resolved' ? 'changed in Copado - fetched again; your earlier resolution is in resolved/' + n.path + '.mine. ' : '') + (r.note || '') };
    return n.path;
  }));
  // resolved automatically by an earlier run, with auto now off: back to you, as a suggestion
  let returned = 0;
  if (o.autoResolve === false) {
    for (const e of Object.values(st.files)) {
      if (e.state !== 'auto') continue;
      Object.assign(e, { state: 'review', suggestion: true, note: 'resolved automatically before - now a suggestion: review it and accept' });
      returned++;
    }
  }
  s.save(st);
  return { state: st, fetched: results.length, returned };
}

/* ------------------------------------------------------------ checks and upload */

/**
 * The checks a resolved file must pass before it goes to Copado: no markers;
 * for metadata, valid XML of the same type as the promotion side, no duplicate
 * entries and no deploy-breaking rule errors.
 */
const isXmlFile = (rel, entry) => (entry && entry.kind === 'xml') || /\.xml$/i.test(String(rel));
const lineOf = (text, offset) => String(text).slice(0, Math.max(0, offset)).split('\n').length;

/**
 * Whether XML is well-formed the way the Metadata API reads it: every element
 * closed by its own end tag, one root element, nothing after it. The parser
 * is the editor's - tolerant, so it reports problems instead of throwing -
 * and every one it reports counts here. Returns null, or the problem with
 * its line.
 */
function wellFormed(text, X) {
  let doc;
  try { doc = X.parse(text); } catch (e) { return 'not valid XML: ' + e.message; }
  if (!doc.root) return 'not valid XML: no root element';
  if (doc.errors && doc.errors.length) {
    const e = doc.errors[0];
    return 'not valid XML: ' + e.message + ' (line ' + lineOf(text, e.offset) + ')' + (doc.errors.length > 1 ? ' (+' + (doc.errors.length - 1) + ' more)' : '');
  }
  const els = (doc.doc && doc.doc.children || []).filter(n => n.type === doc.root.type && n.name);
  if (els.length > 1) return 'not valid XML: a second root element <' + els[1].name + '> (line ' + lineOf(text, els[1].start) + ')';
  const after = doc.root.end > 0 ? String(text).slice(doc.root.end).replace(/<!--[\s\S]*?-->/g, '').trim() : '';
  if (after) return 'not valid XML: text after </' + doc.root.name + '> (line ' + lineOf(text, doc.root.end + String(text).slice(doc.root.end).search(/\S/)) + ')';
  return null;
}

function gates(s, rel, entry, libs) {
  const text = s.read('resolved', rel);
  if (text == null) return { ok: false, reason: 'no resolved file' };
  if (P.hasMarkers(text)) return { ok: false, reason: 'conflict markers left' };
  // decided by the file, not by how it was merged: an XML file merged as text is still XML to Salesforce
  if (isXmlFile(rel, entry)) {
    const bad = wellFormed(text, libs.X);
    if (bad) return { ok: false, reason: bad };
    const doc = libs.X.parse(text);
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

/**
 * Resolutions already in Copado that would fail a deployment: XML that is not
 * well-formed. Checks what was uploaded (or, for older uploads, the resolved
 * file). Returns [{ rel, reason }].
 */
function uploadedHealth(s, st, libs) {
  const out = [];
  for (const [rel, e] of Object.entries(st.files || {})) {
    if (!['uploaded', 'copado'].includes(e.state) || !isXmlFile(rel, e)) continue;
    const text = s.read('uploaded', rel) != null ? s.read('uploaded', rel) : e.state === 'uploaded' ? s.read('resolved', rel) : null;
    if (text == null) continue;
    const bad = P.hasMarkers(text) ? 'conflict markers left' : wellFormed(text, libs.X);
    if (bad) out.push({ rel, reason: bad });
  }
  return out;
}

/**
 * Starts changing a resolution that is already in Copado - after a
 * validation failed on it, say. What Copado holds now is fetched into the
 * resolved file to edit, and remembered: uploading replaces it only if
 * Copado still holds exactly that.
 */
async function startRevision(api, s, rel) {
  const st = s.load();
  const e = st.files[rel];
  if (!e) throw new Error('no such file in the promotion');
  if (!['uploaded', 'copado'].includes(e.state)) throw new Error('it is not in Copado yet - resolve it as usual');
  const fresh = (await api.query("SELECT Id, Name, LastModifiedDate FROM Attachment WHERE Id = '" + String(e.attachmentId).replace(/[^A-Za-z0-9]/g, '') + "'"))[0];
  if (!fresh) throw new Error('the attachment is gone from the promotion');
  const body = Buffer.from(await api.download('Attachment', fresh.Id)).toString('utf8');
  const mine = e.state === 'uploaded' ? s.read('uploaded', rel) : null;
  s.write('uploaded', rel, body);
  s.write('resolved', rel, body);
  e.revising = { from: e.state, since: new Date().toISOString(), expectSha: P.sha(body), name: fresh.Name, modified: fresh.LastModifiedDate };
  Object.assign(e, { state: 'resolved', note: 'editing again - uploading replaces the resolution in Copado' + (mine != null && mine !== body ? ' (it changed in Copado since your upload; this is the version there now)' : '') });
  s.save(st);
  return { rel, changedInCopado: mine != null && mine !== body };
}

/** Puts a resolution being edited again back as it is in Copado. */
function cancelRevision(s, rel) {
  const st = s.load();
  const e = st.files[rel];
  if (!e || !e.revising) return false;
  const was = s.read('uploaded', rel);
  if (was != null) s.write('resolved', rel, was);
  Object.assign(e, { state: e.revising.from, note: e.revising.from === 'copado' ? 'resolved in Copado' : 'uploaded and read back' });
  delete e.revising;
  s.save(st);
  return true;
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
      const rev = x.entry.revising;
      const r = rev ? await P.reviseResolution(api, { id: x.entry.attachmentId, expectSha: rev.expectSha }, x.text)
        : await P.uploadResolution(api, { id: x.entry.attachmentId, name: x.entry.attachmentName, modified: x.entry.modified }, x.text);
      batch.files.push(Object.assign({ path: x.rel, id: r.id, previousName: r.previousName, name: r.name, bytes: r.bytes }, rev ? { revised: true, previousBody: r.previousBody, previousState: rev.from } : {}));
      s.write('uploaded', x.rel, x.text);
      const e = st.files[x.rel];
      delete e.revising;
      Object.assign(e, { state: 'uploaded', uploadedName: r.name, uploadedAt: new Date().toISOString(), attachmentName: r.name, uploadedSha: P.sha(x.text),
        note: rev ? 'replaced in Copado and read back' : 'uploaded and read back', revisions: (e.revisions || 0) + (rev ? 1 : 0) });
    } catch (e) {
      failed.push({ rel: x.rel, reason: e.message });
    }
  }));
  // a revision changes a resolution already counted: the status question is only for first uploads
  if (batch.files.length && opts && opts.status && !batch.files.some(f => f.revised)) {
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
    if (f.revised) {
      await P.restoreAttachment(api, { id: f.id, previousName: f.previousName, original: f.previousBody });
      s.write('uploaded', f.path, f.previousBody);
      if (st.files[f.path]) Object.assign(st.files[f.path], { state: f.previousState || 'uploaded', uploadedSha: P.sha(f.previousBody), note: 'change undone - the earlier resolution is back in Copado' });
      return;
    }
    await P.restoreAttachment(api, { id: f.id, previousName: f.previousName, original: s.read('conflicted', f.path) });
    s.remove('uploaded', f.path);
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
/** A component name as Copado and package.xml give it: decoded - "%5BA%5D R%26D Admin" is "[A] R&D Admin". */
function decodeName(n) { try { return decodeURIComponent(String(n)); } catch (e) { return String(n); } }

/** The component a file is, by its path - its name decoded, as Copado names it. */
function componentOf(rel) {
  const c = componentAt(rel);
  return c ? { type: c.type, name: decodeName(c.name) } : null;
}

function componentAt(rel) {
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



/* ------------------------------------------------------------ activity */


/** Where each line starts, for offsets <-> line numbers. */
function lineStarts(src) { const out = [0]; for (let i = 0; i < src.length; i++) if (src[i] === '\n') out.push(i + 1); return out; }


/** Adds an entry to the promotion's activity, newest last, at most 300. */
function logEvent(st, kind, text, detail) {
  st.events = (st.events || []).concat([{ at: new Date().toISOString(), kind, text, detail: detail || '' }]).slice(-300);
}

module.exports = { decodeName, logEvent, store, settleCodeBlocks, autoResolve, sync, gates, wellFormed, uploadedHealth, startRevision, cancelRevision, readyFiles, uploadAll, lastBatch, undoBatch, componentOf, READY };
