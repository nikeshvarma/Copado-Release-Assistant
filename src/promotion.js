'use strict';

/**
 * Promotion conflicts as Copado stores them: each conflicted file is an
 * attachment on the Promotion named "<story> <path>", holding the file with git
 * conflict markers; a resolution is attached as "RESOLVED <story> <path>"
 * ("AUTO RESOLVED ..." when Copado resolved it itself). Read-only here.
 */
const { robustQuery } = require('./copadoInspect');

/** "<story> <path>" or "RESOLVED <story> <path>" -> { story, path, resolved, auto } or null. */
function parseConflictName(name) {
  const m = /^(AUTO RESOLVED |RESOLVED )?(\S+) (\S.*\/.*\.[A-Za-z0-9-]+)$/.exec(String(name || ''));
  return m ? { story: m[2], path: m[3], resolved: !!m[1], auto: m[1] === 'AUTO RESOLVED ' } : null;
}

/**
 * A file with git conflict markers -> its two sides (and the common ancestor
 * when the markers carry one, diff3 style), plus the markers' labels.
 */
function splitConflicts(text) {
  const lines = String(text).split(/(?<=\n)/);
  const ours = [], theirs = [], base = [];
  const labels = { ours: null, base: null, theirs: null };
  let state = 'common', blocks = 0, everyBlockHasBase = true, thisHasBase = false;
  for (const ln of lines) {
    const t = ln.replace(/\r?\n$/, '');
    let m;
    if (state === 'common' && (m = /^<{7}(?: (.*))?$/.exec(t))) { state = 'ours'; blocks++; thisHasBase = false; if (labels.ours == null) labels.ours = m[1] || ''; continue; }
    if (state === 'ours' && (m = /^\|{7}(?: (.*))?$/.exec(t))) { state = 'base'; thisHasBase = true; if (labels.base == null) labels.base = m[1] || ''; continue; }
    if ((state === 'ours' || state === 'base') && /^={7}$/.test(t)) { if (!thisHasBase) everyBlockHasBase = false; state = 'theirs'; continue; }
    if (state === 'theirs' && (m = /^>{7}(?: (.*))?$/.exec(t))) { state = 'common'; if (labels.theirs == null) labels.theirs = m[1] || ''; continue; }
    if (state === 'common') { ours.push(ln); theirs.push(ln); base.push(ln); } else if (state === 'ours') ours.push(ln); else if (state === 'base') base.push(ln); else theirs.push(ln);
  }
  if (state !== 'common') return { ok: false, reason: 'a conflict block is not closed', blocks };
  return { ok: true, blocks, ours: ours.join(''), theirs: theirs.join(''), base: blocks && everyBlockHasBase ? base.join('') : null, labels };
}

/** True while a text still holds conflict markers. */
function hasMarkers(text) { return /^(<{7}|>{7})( |$)/m.test(String(text)) || /^={7}$/m.test(String(text)); }

/**
 * The promotions in conflict for a story ("US-0012345") or a promotion
 * ("P12345"), and their conflicted files - newest attachment per path.
 */
async function promotionConflicts(api, input) {
  const notes = [];
  const raw = String(input || '').trim();
  const isId = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(raw) && /[a-zA-Z]/.test(raw) && !/^US-?\d+$/i.test(raw) && !/^P-?\d+$/i.test(raw);
  const isPromotion = /^P-?\d+$/i.test(raw);
  const isStory = /^(US-?)?\d+$/i.test(raw) && !isPromotion;
  if (!isPromotion && !isStory && !isId) throw new Error('Give a promotion (P12345) or a user story (US-0012345).');
  const digits = raw.replace(/\D/g, '');
  const promoFields = ['Id', 'Name', 'copado__Status__c', 'copado__Source_Environment__c', 'copado__Source_Environment__r.Name', 'copado__Destination_Environment__c', 'copado__Destination_Environment__r.Name', 'CreatedDate'];
  let promotions;
  if (isId) {
    promotions = await robustQuery(api, promoFields, 'copado__Promotion__c', "Id = '" + raw + "'", 'LIMIT 1', notes);
  } else if (isPromotion) {
    promotions = (await robustQuery(api, promoFields, 'copado__Promotion__c', "Name LIKE '%" + digits + "'", 'ORDER BY CreatedDate DESC LIMIT 20', notes))
      .filter(p => String(p.Name).replace(/\D/g, '') === digits || Number(String(p.Name).replace(/\D/g, '')) === Number(digits));
  } else {
    const links = await robustQuery(api, ['copado__Promotion__c', 'copado__User_Story__r.Name'], 'copado__Promoted_User_Story__c',
      "copado__User_Story__r.Name LIKE '%" + digits + "'", 'ORDER BY CreatedDate DESC LIMIT 50', notes);
    const ids = [...new Set(links.filter(l => Number(String((l.copado__User_Story__r || {}).Name).replace(/\D/g, '')) === Number(digits)).map(l => l.copado__Promotion__c).filter(Boolean))];
    promotions = ids.length ? await robustQuery(api, promoFields, 'copado__Promotion__c', 'Id IN (' + ids.map(i => "'" + String(i).replace(/[^A-Za-z0-9]/g, '') + "'").join(', ') + ')', 'ORDER BY CreatedDate DESC', notes) : [];
  }
  const out = [];
  for (const p of promotions) {
    const atts = await api.query("SELECT Id, Name, BodyLength, CreatedDate, LastModifiedDate FROM Attachment WHERE ParentId = '" + String(p.Id).replace(/[^A-Za-z0-9]/g, '') + "' ORDER BY CreatedDate DESC LIMIT 500");
    const conflicts = new Map(), resolved = new Map();
    for (const a of atts) {
      const n = parseConflictName(a.Name);
      if (!n) continue;
      const bucket = n.resolved ? resolved : conflicts;
      if (!bucket.has(n.path)) bucket.set(n.path, { id: a.Id, name: a.Name, story: n.story, path: n.path, size: a.BodyLength, created: a.CreatedDate, modified: a.LastModifiedDate || a.CreatedDate, auto: n.auto });
    }
    out.push({
      id: p.Id, name: p.Name, status: p.copado__Status__c,
      from: (p.copado__Source_Environment__r || {}).Name, to: (p.copado__Destination_Environment__r || {}).Name,
      fromId: p.copado__Source_Environment__c, toId: p.copado__Destination_Environment__c,
      conflicts: [...conflicts.values()].map(c => Object.assign(c, { resolution: resolved.get(c.path) || null })).sort((a, b) => a.path.localeCompare(b.path))
    });
  }
  return { promotions: out, notes };
}

/* ------------------------------------------------------------ writing back */

const clean = id => String(id).replace(/[^A-Za-z0-9]/g, '');

/**
 * Uploads a resolution the way Copado's resolution editor does: the conflict
 * attachment "<story> <path>" is renamed "RESOLVED <story> <path>" and its body
 * replaced. Refuses when the attachment changed in Copado since it was fetched,
 * or is already resolved; reads it back to confirm. api.patch(sobject, id, fields).
 */
async function uploadResolution(api, item, resolvedText) {
  if (hasMarkers(resolvedText)) throw new Error('the resolution still has conflict markers');
  const fresh = (await api.query("SELECT Id, Name, LastModifiedDate FROM Attachment WHERE Id = '" + clean(item.id) + "'"))[0];
  if (!fresh) throw new Error('the conflict attachment is gone from the promotion');
  const parsed = parseConflictName(fresh.Name);
  if (!parsed) throw new Error('the attachment is now named "' + fresh.Name + '" - not a conflict file');
  if (parsed.resolved) throw new Error('it was already resolved in Copado (' + (fresh.LastModifiedDate || '') + ') - use Edit again to change that resolution');
  if (item.modified && fresh.LastModifiedDate && fresh.LastModifiedDate !== item.modified) throw new Error('it changed in Copado since it was fetched - fetch it again');
  const name = 'RESOLVED ' + fresh.Name;
  const body = Buffer.from(resolvedText, 'utf8');
  await api.patch('Attachment', fresh.Id, { Name: name, Body: body.toString('base64') });
  // read back: name and content exactly as sent
  const after = (await api.query("SELECT Id, Name, BodyLength FROM Attachment WHERE Id = '" + clean(fresh.Id) + "'"))[0];
  const stored = await api.download('Attachment', fresh.Id);
  if (!after || after.Name !== name) throw new Error('read back: the attachment name is "' + (after && after.Name) + '", not "' + name + '"');
  if (!Buffer.from(stored).equals(body)) throw new Error('read back: the stored content differs from the resolution (' + stored.length + ' bytes stored, ' + body.length + ' sent)');
  return { id: fresh.Id, name, previousName: fresh.Name, bytes: body.length };
}

/** Puts an uploaded attachment back as it was: its conflict name and conflicted content. */
async function restoreAttachment(api, record) {
  await api.patch('Attachment', record.id, { Name: record.previousName, Body: Buffer.from(record.original, 'utf8').toString('base64') });
}

/** Conflict files on the promotion that are not resolved yet. */
async function unresolvedCount(api, promotionId) {
  const atts = await api.query("SELECT Id, Name FROM Attachment WHERE ParentId = '" + clean(promotionId) + "' LIMIT 500");
  return atts.filter(a => { const n = parseConflictName(a.Name); return n && !n.resolved; }).length;
}

/**
 * What Copado's editor does after the last file: the promotion's status from a
 * merge-conflict value to the org's own "Conflicts Resolved" value. Only when
 * nothing is left unresolved, the status still says merge conflict, and the
 * org's Status field has such a value. Returns { from, to } or { skipped }.
 */
const sha = text => require('crypto').createHash('sha256').update(Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8')).digest('hex');

/**
 * Replaces a resolution already in Copado - yours, or one made in Copado's
 * editor - after a validation showed it needs another change. Only the body
 * changes; the "RESOLVED ..." name stays. item.expectSha is the content you
 * started editing from: if the attachment holds anything else now, someone
 * changed it in Copado meanwhile and nothing is overwritten. Read back like
 * an upload; previousBody is kept for undo.
 */
async function reviseResolution(api, item, resolvedText) {
  if (hasMarkers(resolvedText)) throw new Error('the resolution still has conflict markers');
  const fresh = (await api.query("SELECT Id, Name, LastModifiedDate FROM Attachment WHERE Id = '" + clean(item.id) + "'"))[0];
  if (!fresh) throw new Error('the conflict attachment is gone from the promotion');
  const parsed = parseConflictName(fresh.Name);
  if (!parsed || !parsed.resolved) throw new Error('the attachment is now named "' + fresh.Name + '" - not a resolution to replace');
  const current = Buffer.from(await api.download('Attachment', fresh.Id));
  if (item.expectSha && sha(current) !== item.expectSha) throw new Error('its resolution changed in Copado since you started editing it - use Edit again to start from the new one');
  const body = Buffer.from(resolvedText, 'utf8');
  await api.patch('Attachment', fresh.Id, { Body: body.toString('base64') });
  const after = (await api.query("SELECT Id, Name, BodyLength FROM Attachment WHERE Id = '" + clean(fresh.Id) + "'"))[0];
  const stored = await api.download('Attachment', fresh.Id);
  if (!after || after.Name !== fresh.Name) throw new Error('read back: the attachment name is "' + (after && after.Name) + '", not "' + fresh.Name + '"');
  if (!Buffer.from(stored).equals(body)) throw new Error('read back: the stored content differs from the resolution (' + stored.length + ' bytes stored, ' + body.length + ' sent)');
  return { id: fresh.Id, name: fresh.Name, previousName: fresh.Name, previousBody: current.toString('utf8'), bytes: body.length, revised: true };
}

/**
 * Copado's "Re-create promotion branch" checkbox on the promotion, whichever
 * name this Copado version gives it: the setting when set, else a checkbox
 * whose name or label says re-create (or rebuild) and branch. Returns
 * { field, label } or null.
 */
async function recreateBranchField(api, override) {
  const fields = (await api.describe('copado__Promotion__c')) || [];
  if (override) { const f = fields.find(x => x.name.toLowerCase() === String(override).toLowerCase()); return f ? { field: f.name, label: f.label || f.name } : null; }
  const said = f => (f.name + ' ' + (f.label || '')).replace(/[_-]+/g, ' ');
  const hit = fields.find(f => (!f.type || f.type === 'boolean') && /\b(re ?create|recreate|rebuild)\b.*\bbranch\b/i.test(said(f)));
  return hit ? { field: hit.name, label: hit.label || hit.name } : null;
}

/** Ticks or unticks a checkbox on the promotion, and reads it back. */
async function setPromotionFlag(api, promotionId, field, value) {
  if (!/^[A-Za-z0-9_]+$/.test(field)) throw new Error('not a field name: ' + field);
  const before = (await api.query('SELECT Id, ' + field + " FROM copado__Promotion__c WHERE Id = '" + clean(promotionId) + "'"))[0];
  if (!before) throw new Error('the promotion is gone');
  if (!!before[field] === !!value) return { from: !!before[field], to: !!value, unchanged: true };
  await api.patch('copado__Promotion__c', before.Id, { [field]: !!value });
  const after = (await api.query('SELECT ' + field + " FROM copado__Promotion__c WHERE Id = '" + clean(promotionId) + "'"))[0];
  if (!after || !!after[field] !== !!value) throw new Error('read back: ' + field + ' is ' + (after && after[field]));
  return { from: !!before[field], to: !!value };
}

/** The checkbox's value now. */
async function promotionFlag(api, promotionId, field) {
  if (!/^[A-Za-z0-9_]+$/.test(field)) return null;
  const r = (await api.query('SELECT Id, ' + field + " FROM copado__Promotion__c WHERE Id = '" + clean(promotionId) + "'"))[0];
  return r ? !!r[field] : null;
}

async function markConflictsResolved(api, promotionId, opts) {
  const o = opts || {};
  if ((await unresolvedCount(api, promotionId)) > 0) return { skipped: 'files are still unresolved' };
  const fields = await api.describe('copado__Promotion__c');
  const status = (fields || []).find(f => f.name === 'copado__Status__c');
  const value = status && (status.picklist || []).find(v => /^conflicts?\s+resolved$/i.test(v));
  if (!value) return { skipped: 'this org\u2019s promotion Status has no "Conflicts Resolved" value' };
  const now = (await api.query("SELECT Id, copado__Status__c FROM copado__Promotion__c WHERE Id = '" + clean(promotionId) + "'"))[0];
  if (!now) return { skipped: 'the promotion is gone' };
  if (now.copado__Status__c === value) return { skipped: 'already ' + value, already: true };
  if (!/merge\s+conflict/i.test(now.copado__Status__c || '')) return { skipped: 'its status is "' + now.copado__Status__c + '", not a merge conflict' };
  if (o.dryRun) return { from: now.copado__Status__c, to: value, dryRun: true };
  await api.patch('copado__Promotion__c', now.Id, { copado__Status__c: value });
  const after = (await api.query("SELECT copado__Status__c FROM copado__Promotion__c WHERE Id = '" + clean(promotionId) + "'"))[0];
  if (!after || after.copado__Status__c !== value) throw new Error('read back: the status is "' + (after && after.copado__Status__c) + '"');
  return { from: now.copado__Status__c, to: value };
}

/** Undoes a status change, if the status is still the one the extension set. */
async function restoreStatus(api, promotionId, change) {
  const now = (await api.query("SELECT copado__Status__c FROM copado__Promotion__c WHERE Id = '" + clean(promotionId) + "'"))[0];
  if (!now || now.copado__Status__c !== change.to) return false;
  await api.patch('copado__Promotion__c', clean(promotionId), { copado__Status__c: change.from });
  return true;
}

module.exports = { parseConflictName, splitConflicts, hasMarkers, promotionConflicts, uploadResolution, reviseResolution, restoreAttachment, unresolvedCount, markConflictsResolved, restoreStatus,
  recreateBranchField, setPromotionFlag, promotionFlag, sha };
