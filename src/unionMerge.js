'use strict';

/**
 * Permission sets, profiles, labels, translations - files whose entries add up - from Copado's conflict file: git's
 * merge kept as it is, and inside each of its blocks the target's entries as they are, the feature's added - or, where
 * it changed an entry, its version in place. Nothing of the target is removed, nothing to resolve.
 *
 *   resolve(conflictText, typeName) -> { ok: true, text } | { ok: false, reason }
 *
 * Not ok when a block is not whole entries on either side - git can cut through the middle of one - so the file is
 * resolved as any other: each block a conflict.
 */
const X = require('./xmlParser');
const XC = require('./xmlCompare');
const { blocks } = require('./codeChecks');

const split = t => String(t).split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1);

// the settings that grant access - true grants - and a tab's visibility, most to least
const GRANTS = new Set(['editable', 'readable', 'enabled', 'visible', 'allowCreate', 'allowRead', 'allowEdit', 'allowDelete', 'viewAllRecords', 'modifyAllRecords', 'viewAllFields']);
const RANK = { DefaultOn: 2, Visible: 2, DefaultOff: 1, Available: 1, Hidden: 0, None: 0 };
const ACCESS = new Set(['PermissionSet', 'Profile', 'MutingPermissionSet']);
// B2.10: files whose entries are words - labels, translations: an entry both stories changed differently is yours to choose
const WORDS = new Set(['CustomLabels', 'Translations', 'CustomObjectTranslation', 'GlobalValueSetTranslation', 'StandardValueSetTranslation']);
// B2.8: a profile's security settings - any change, an addition too, is yours to choose
const SECURITY = new Set(['loginIpRanges', 'loginHours', 'loginFlows', 'passwordPolicies', 'sessionSettings']);
const valuesOf = t => { const v = {}; for (const [, k, x] of String(t).matchAll(/<(\w+)>([^<]*)<\/\1>/g)) if (!(k in v)) v[k] = x.trim(); return v; };
/** B2.12: how much a copy grants - each access setting granted counts, a tab's visibility by its rank; a muting set's true takes away. */
function grants(typeName, text) {
  const v = valuesOf(text), muting = typeName === 'MutingPermissionSet';
  let n = 0;
  for (const [k, x] of Object.entries(v)) { if (GRANTS.has(k)) n += (x === 'true') !== muting ? 1 : 0; if (k === 'visibility' && RANK[x] != null) n += RANK[x]; }
  return n;
}
/** What the copy taken out sets differently - its first setting that differs, e.g. "editable: false". */
function differs(kept, gone) {
  const a = valuesOf(kept), b = valuesOf(gone);
  for (const k of Object.keys(b)) if (a[k] !== b[k]) return k + ': ' + b[k];
  return 'the other copy';
}

/** Whether the feature's version of an entry grants less than the target's - in a muting permission set, true takes access away. */
function narrows(typeName, mine, theirs) {
  if (!ACCESS.has(typeName)) return false;
  const values = t => { const v = {}; for (const [, k, x] of String(t).matchAll(/<(\w+)>([^<]*)<\/\1>/g)) if (!(k in v)) v[k] = x.trim(); return v; };
  const a = values(mine), b = values(theirs), muting = typeName === 'MutingPermissionSet';
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (GRANTS.has(k) && (muting ? a[k] === 'false' && b[k] === 'true' : a[k] === 'true' && b[k] === 'false')) return true;
    if (k === 'visibility' && RANK[a[k]] != null && RANK[b[k]] != null && RANK[b[k]] < RANK[a[k]]) return true;
  }
  return false;
}

// what an access setting is called in Setup, and what an entry is named by
const SETTING_WORDS = { editable: 'Edit access', readable: 'Read access', enabled: 'Enabled', visible: 'Visible', allowCreate: 'Create', allowRead: 'Read', allowEdit: 'Edit',
  allowDelete: 'Delete', viewAllRecords: 'View All', modifyAllRecords: 'Modify All', viewAllFields: 'View All Fields', visibility: 'Tab visibility', default: 'Default' };
const NAMED_BY = ['field', 'object', 'apexClass', 'apexPage', 'tab', 'recordType', 'application', 'layout', 'flow', 'customPermission', 'customMetadataType', 'customSetting', 'externalDataSource', 'name', 'fullName'];

/**
 * A conflict between two versions of an entry in plain words: what it is about and what each version sets, saying
 * when the feature's version grants less - "Account.Revenue__c: Edit access true \u2192 false \u2013 removes access".
 * Null when the versions are not entries that set something (code, or a whole block of text).
 */
function explainChange(target, feature, typeName) {
  const a = valuesOf(target), b = valuesOf(feature);
  const keyName = NAMED_BY.find(k => a[k] || b[k]);
  const changed = Object.keys(Object.assign({}, a, b)).filter(k => k !== keyName && a[k] !== b[k] && (k in a) && (k in b));
  if (!keyName && !changed.length) return null;
  const who = keyName ? (a[keyName] || b[keyName]) : null;
  if (!String(target).trim()) return (who ? who + ': ' : '') + 'only the feature has it \u2013 Accept feature adds it';
  if (!String(feature).trim()) return (who ? who + ': ' : '') + 'the feature removes it \u2013 Accept target keeps it';
  if (!changed.length) return null;
  const muting = typeName === 'MutingPermissionSet';
  const lessOf = k => GRANTS.has(k) ? (muting ? a[k] === 'false' && b[k] === 'true' : a[k] === 'true' && b[k] === 'false') : k === 'visibility' && RANK[a[k]] != null && RANK[b[k]] != null && RANK[b[k]] < RANK[a[k]];
  const moreOf = k => GRANTS.has(k) ? (muting ? a[k] === 'true' && b[k] === 'false' : a[k] === 'false' && b[k] === 'true') : k === 'visibility' && RANK[a[k]] != null && RANK[b[k]] != null && RANK[b[k]] > RANK[a[k]];
  const parts = changed.slice(0, 3).map(k => (SETTING_WORDS[k] || k) + ' ' + a[k] + ' \u2192 ' + b[k]);
  const less = changed.some(lessOf), more = changed.some(moreOf);
  return (who ? who + ': ' : '') + parts.join(', ') + (changed.length > 3 ? '\u2026' : '') +
    (less && more ? ' \u2013 grants some access, removes other' : less ? ' \u2013 the feature removes access' : more ? ' \u2013 the feature grants more access' : '');
}

/** A file's entries that are named - a field's permission, a class's access - by what identifies them; null when it is not valid XML. */
function entriesOf(text, typeName) {
  const d = X.parse(String(text || ''));
  if (!d.root || (d.errors && d.errors.length)) return null;
  return d.root.children.filter(c => c.type === X.ELEMENT && !XC.isLeaf(c)).map(c => {
    const k = XC.identity(typeName, [typeName], c, true);
    return k == null ? null : { id: c.name + ':' + k, text: String(text).slice(c.start, c.end) };
  }).filter(Boolean);
}

/**
 * Where a resolution grants less than the target has now - a permission set's field made read-only, a tab hidden -
 * each in plain words. Only for the access types; [] for every other file, or one that cannot be read.
 */
function accessLost(targetText, resolvedText, typeName) {
  if (!ACCESS.has(typeName)) return [];
  const a = entriesOf(targetText, typeName), b = entriesOf(resolvedText, typeName);
  if (!a || !b) return [];
  const mine = new Map(b.map(e => [e.id, e.text]));
  const out = [];
  for (const e of a) { const r = mine.get(e.id); if (r != null && narrows(typeName, e.text, r)) out.push(explainChange(e.text, r, typeName).replace(/ \u2013 the feature removes access$/, ' \u2013 removes access')); }
  return out;
}

/** A block's side as whole entries: each with its text and what identifies it - or null when it is not whole. */
/**
 * The union, the whole file at once - for blocks git cut through an entry: each side rebuilt from Copado's file is a
 * whole, valid file, so the two are joined entry by entry - the target's text kept as it is, an entry the feature
 * changed replaced in its place, an entry only the feature has added after the target's last of its kind. Matched by
 * what identifies them, an entry the two share stays once.
 */
function whole(conflictText, typeName) {
  const lines = split(conflictText), T = [], F = [], B = [];
  let i = 0;
  const bs = blocks(conflictText), withBase = bs.length && bs.every(b => b.base);
  for (const b of bs) { T.push(...lines.slice(i, b.b0), ...b.ours); F.push(...lines.slice(i, b.b0), ...b.theirs); if (withBase) B.push(...lines.slice(i, b.b0), ...b.base); i = b.b1; }
  T.push(...lines.slice(i)); F.push(...lines.slice(i)); if (withBase) B.push(...lines.slice(i));
  const t = T.join(''), f = F.join('');
  const top = (text) => {
    const d = X.parse(text);
    if (!d.root || (d.errors && d.errors.length)) return null;
    return { root: d.root, items: d.root.children.filter(c => c.type === X.ELEMENT).map(c => {
      const id = XC.isLeaf(c) ? c.name : (() => { const k = XC.identity(typeName, [typeName], c, true); return k == null ? null : c.name + ':' + k; })();
      const body = text.slice(c.start, c.end);
      return { id, name: c.name, start: c.start, end: c.end, text: body, canon: body.replace(/\s+/g, ' ').trim() };
    }) };
  };
  const mine = top(t), theirs = top(f);
  if (!mine || !theirs) return null;
  // the common ancestor, when Copado's file has it (git's diff3 style): what each story changed is known exactly
  const base = withBase ? top(B.join('')) : null, baseById = new Map();
  if (base) for (const y of base.items) if (y.id != null && !baseById.has(y.id)) baseById.set(y.id, y);
  const eol = /\r\n/.test(t) ? '\r\n' : '\n';
  const indentOf = at => { const ls = t.lastIndexOf('\n', at - 1) + 1; return (/^[ \t]*/.exec(t.slice(ls, at)) || [''])[0]; };
  const byId = new Map(); for (const m of mine.items) if (m.id != null && !byId.has(m.id)) byId.set(m.id, m);
  const lineRange = m => { const a = t.lastIndexOf('\n', m.start - 1) + 1, z0 = t.indexOf('\n', m.end); return [a, z0 < 0 ? t.length : z0 + 1]; };
  // an entry the target has twice: the same - the second taken out, said (B2.11); different - the copy granting more
  // kept, said, undoable (B2.12) - a tie keeps the first
  const removedDups = [], removedAt = [], removedInfo = [], early = [];
  const lineOf = off => { let n = 0; for (let i = t.indexOf('\n'); i >= 0 && i < off; i = t.indexOf('\n', i + 1)) n++; return n; };
  for (const m of mine.items) {
    if (m.id == null) continue;
    const first = byId.get(m.id);
    if (first === m) continue;
    const [a, z] = lineRange(m);
    if (first.canon === m.canon) { early.push({ at: a, end: z, text: '' }); removedDups.push(m.text); removedAt.push([lineOf(a), lineOf(z)]); removedInfo.push(null); continue; }
    const keepFirst = grants(typeName, first.text) >= grants(typeName, m.text);
    const kept = keepFirst ? first : m, gone = keepFirst ? m : first;
    const [ga, gz] = lineRange(gone), [ka, kz] = lineRange(kept);
    early.push({ at: ga, end: gz, text: '' });
    removedDups.push(gone.text); removedAt.push([lineOf(ga), lineOf(gz)]);
    removedInfo.push({ kept: [lineOf(ka), lineOf(kz)], label: differs(kept.text, gone.text) });
    // the feature's changes go to the copy kept
    if (!keepFirst) byId.set(m.id, m);
    continue;
  }
  const canons = new Set(mine.items.map(m => m.canon));
  const edits = [], blocksAt = [];  // { at, end, text, order }; the conflict blocks' ranges
  let order = 0, narrowed = 0, values = 0;
  const label = re => { const m = re.exec(String(conflictText)); return m && m[1].trim() ? m[1].trim() : null; };
  const ours = label(/^<{7} ?([^\r\n]*)/m) || 'HEAD', theirsLabel = label(/^>{7} ?([^\r\n]*)/m) || 'feature';
  // B2.8: a profile's security settings, each kind as a whole - all the target's IP ranges against all the feature's
  const securityDone = new Set();
  if (typeName === 'Profile') for (const name of SECURITY) {
    const tg = mine.items.filter(y => y.name === name), fg = theirs.items.filter(y => y.name === name);
    if (!fg.length || tg.map(y => y.canon).join('|') === fg.map(y => y.canon).join('|')) continue;
    securityDone.add(name);
    const a = tg.length ? lineRange(tg[0])[0] : lineRange(mine.items.length ? mine.items[mine.items.length - 1] : { start: mine.root.closeStart, end: mine.root.closeStart })[1];
    const z = tg.length ? lineRange(tg[tg.length - 1])[1] : a;
    const ind = tg.length ? indentOf(tg[0].start) : (mine.items.length ? indentOf(mine.items[0].start) : '    ');
    edits.push({ at: a, end: z, text: '<<<<<<< ' + ours + eol + t.slice(a, z) + '=======' + eol + fg.map(y => ind + y.text.trim() + eol).join('') + '>>>>>>> ' + theirsLabel + eol, order: order++ });
    blocksAt.push([a, z]); narrowed++;
  }
  for (const x of theirs.items) {
    const m = x.id != null ? byId.get(x.id) : null;
    if (securityDone.has(x.name) || (typeName === 'Profile' && SECURITY.has(x.name))) continue;
    if (m && m.canon !== x.canon && narrows(typeName, m.text, x.text)) {
      // access narrowed: yours to choose - the target's entry and the feature's, as git writes a conflict
      const a = t.lastIndexOf('\n', m.start - 1) + 1, z0 = t.indexOf('\n', m.end), z = z0 < 0 ? t.length : z0 + 1;
      const mineLines = t.slice(a, z), indent = indentOf(m.start);
      edits.push({ at: a, end: z, text: '<<<<<<< ' + ours + eol + mineLines + (/\n$/.test(mineLines) ? '' : eol) + '=======' + eol + indent + x.text.trim() + eol + '>>>>>>> ' + theirsLabel + eol, order: order++ });
      blocksAt.push([a, z]); narrowed++;
      continue;
    }
    // B2.10: a label or a translation both stories changed, each its own way - yours to choose. Without the ancestor
    // it cannot be told whose change it was, so it is asked; with it, a change only one story made is taken
    if (m && m.canon !== x.canon && WORDS.has(typeName)) {
      const was = base && baseById.get(x.id);
      if (was && was.canon === x.canon) continue;
      if (!(was && was.canon === m.canon)) {
        const a = t.lastIndexOf('\n', m.start - 1) + 1, z0 = t.indexOf('\n', m.end), z = z0 < 0 ? t.length : z0 + 1;
        const mineLines = t.slice(a, z), indent = indentOf(m.start);
        edits.push({ at: a, end: z, text: '<<<<<<< ' + ours + eol + mineLines + (/\n$/.test(mineLines) ? '' : eol) + '=======' + eol + indent + x.text.trim() + eol + '>>>>>>> ' + theirsLabel + eol, order: order++ });
        blocksAt.push([a, z]); narrowed++; values++;
        continue;
      }
    }
    if (m) { if (m.canon !== x.canon) edits.push({ at: m.start, end: m.end, text: x.text, order: order++ }); continue; }
    if (canons.has(x.canon)) continue;
    // where the target keeps its kind: after the last of them - or, none of its kind, before the file's end
    const last = mine.items.filter(y => y.name === x.name).pop();
    const at = last ? last.end : mine.root.closeStart;
    const indent = last ? indentOf(last.start) : indentOf(mine.items.length ? mine.items[mine.items.length - 1].start : mine.root.closeStart) || '    ';
    edits.push({ at, end: at, text: (last ? eol + indent : indent) + x.text.trim() + (last ? '' : eol), order: order++ });
  }
  // an entry to add after one that became a conflict: after its block, never inside it
  for (const e of edits) {
    if (e.end !== e.at) continue;
    const inside = blocksAt.find(([a, z]) => e.at > a && e.at < z);
    if (inside) { e.at = e.end = inside[1]; e.text = e.text.replace(/^\r?\n/, '') + (/\n$/.test(e.text) ? '' : eol); }
  }
  // the target's duplicates' edits with the rest - none overlapping one of the feature's (their ids are skipped above)
  for (const e of early) edits.push(Object.assign(e, { order: order++ }));
  let out = t;
  for (const e of edits.sort((a, b) => b.at - a.at || b.order - a.order)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return { text: out, narrowed, values, removedDups, removedAt, removedInfo };
}

/**
 * resolve(conflictText, typeName) -> { ok, text, narrowed } | { ok: false, reason }
 * narrowed: how many entries are left in text as conflict blocks, yours to choose - where the feature would grant less,
 * and (values, B2.10) labels or translations both stories changed differently.
 */
function resolve(conflictText, typeName) {
  const w = whole(conflictText, typeName);
  return w ? { ok: true, text: w.text, narrowed: w.narrowed, values: w.values, removedDups: w.removedDups, removedAt: w.removedAt, removedInfo: w.removedInfo } : { ok: false, reason: 'a side of Copado\u2019s file is not valid XML' };
}

module.exports = { resolve, explainChange, accessLost };
