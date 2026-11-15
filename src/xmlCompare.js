'use strict';

/**
 * Your resolution compared with both branches element by element - not line
 * by line. Metadata XML repeats the same lines everywhere (<itemInstances>,
 * <name>uiBehavior</name>, <value>readonly</value>), so a line comparison can
 * pair a deleted block's lines with the next block's and report one change in
 * two wrong places. Elements are matched by what they are instead:
 *
 *   a tag that appears once among its siblings    - by its tag (its value changed, or what is inside it)
 *   a repeated element the metadata type keys     - by that key (src/registry.js): fieldPermissions by field, ...
 *   a repeated element of one value               - by its value: <fields>QUOTE.TOTALPRICE</fields>
 *   a repeated element with an identity-like child - <identifier>, <fullName>, <name>, <field>, ...
 *   a wrapper of one element                      - by the element inside: itemInstances > fieldInstance > identifier
 *   anything else (conditions, criteria, columns) - identical ones first, then by order: their order is their meaning
 *
 * Long text inside one element - a formula, a JSON schema - is compared line
 * by line within that element only, like code.
 *
 * Returns the same changes as src/liveMarks.js - kind, the lines of your
 * resolution they cover (bStart..bEnd), the target's lines (removed), yours
 * (added), an undo of whole lines - plus a label saying what changed in the
 * metadata's own terms. Or { hold: true } while your resolution is not valid
 * XML, so the marks keep their last good state. Plain Node.js.
 */
const X = require('./xmlParser');
const registry = require('./registry');
const keys = require('./keys');
const D = require('./linediff');

const IDS = ['identifier', 'fullName', 'name', 'field', 'apiName', 'actionName', 'developerName', 'apexClass', 'apexPage', 'object', 'tab',
  'application', 'flow', 'customPermission', 'layout', 'recordType', 'picklist', 'fieldName'];

const kids = el => (el.children || []).filter(c => c.type === X.ELEMENT);
const isLeaf = el => !kids(el).length;
const val = el => X.textOf(el).trim();

/** One parsed side: its source, lines, and helpers on it. */
function side(text) {
  const src = String(text);
  const doc = X.parse(src);
  const starts = X.lineStarts(src);
  const lineOf = off => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return lo; };
  const lines = src.split(/(?<=\n)/);
  const memo = new WeakMap();
  // an element as Salesforce reads it, not as it is written: <x/> and <x></x> alike, entities decoded, attributes in
  // one order, line endings ignored - and within an entry whose fields each appear once, their order is not meaning.
  // Comments count: one added inside an element is a change
  const flat = el => {
    let f = memo.get(el);
    if (f != null) return f;
    const attrs = (el.attrs || []).map(a => a.name + '="' + a.value + '"').sort().join(' ');
    const ks = kids(el);
    if (!ks.length) f = '<' + el.name + (attrs ? ' ' + attrs : '') + '>' + X.textOf(el).replace(/\r\n?/g, '\n') + '</' + el.name + '>';
    else {
      const comments = (el.children || []).filter(c => c.type === X.COMMENT).map(c => '<!--' + c.value.trim() + '-->').join('');
      let parts = ks.map(flat);
      if (new Set(ks.map(k => k.name)).size === ks.length) parts = parts.slice().sort();
      f = '<' + el.name + (attrs ? ' ' + attrs : '') + '>' + comments + parts.join('') + '</' + el.name + '>';
    }
    memo.set(el, f);
    return f;
  };
  // an element owns its lines when only whitespace shares them - then whole lines can be put back or taken out
  const owns = el => /^\s*$/.test(src.slice(starts[lineOf(el.start)], el.start)) && /^\s*$/.test(src.slice(el.end, (starts[lineOf(el.end - 1) + 1] || src.length + 1) - 1));
  return { src, doc, ok: !!doc.root && !(doc.errors && doc.errors.length), lineOf, lines, flat, owns };
}

/**
 * What a repeated element is, or null when only its order says. A wrapper
 * takes the identity of the element inside only when every element of its
 * tag holds just one (FlexiPage itemInstances do; a layout column with one
 * item is still a column - by order).
 */
function identity(type, path, el, wrappers) {
  const spec = registry.specFor(type, path, el.name);
  if (spec && spec.key && spec.key.length) { const k = keys.keyOf(el, spec); if (k && k.kind === 'key') return k.value; }
  if (isLeaf(el)) return '=' + val(el);
  const ks = kids(el);
  for (const n of IDS) { const c = ks.find(k => k.name === n && isLeaf(k)); if (c) return n + '=' + val(c); }
  if (wrappers && ks.length === 1 && !isLeaf(ks[0])) { const inner = identity(type, path.concat(el.name), ks[0], true); if (inner) return ks[0].name + '/' + inner; }
  return null;
}

/** The words for an element: its tag and what identifies it. */
function describe(type, path, el) {
  const id = identity(type, path, el, kids(el).length === 1);
  if (!id) return el.name;
  if (id[0] === '=') return el.name + ' ' + id.slice(1);
  const inner = /^(\w+)\/(.*)$/.exec(id);
  const shown = (inner ? inner[2] : id).split('|').map(p => p.slice(p.indexOf('=') + 1)).filter(Boolean).join(' / ');
  return (inner ? inner[1] : el.name) + ' ' + shown;
}

/**
 * A field that can stand for the identity of a list's elements when nothing else does: a leaf every element
 * has exactly once, named like an identity (…Name, …Key, …Id, …Reference, identifier), whose values are unique
 * on each side. null when there is none - repeated values mean order is the identity, as in a list view's filters.
 */
const NAME_LIKE = /^(?:identifier|.+(?:Name|Key|Id|Reference))$/;
function inferKey(la, lb) {
  const all = la.concat(lb);
  if (all.length < 2) return null;
  const once = e => { const m = new Map(); for (const k of kids(e)) if (isLeaf(k)) m.set(k.name, (m.get(k.name) || 0) + 1); return m; };
  const counts = all.map(once);
  const names = [...counts[0].keys()].filter(n => NAME_LIKE.test(n) && counts.every(c => c.get(n) === 1));
  const unique = (list, n) => { const vs = list.map(e => val(kids(e).find(k => k.name === n))); return vs.every(v => v) && new Set(vs).size === vs.length; };
  return names.find(n => unique(la, n) && unique(lb, n)) || null;
}

/**
 * Pairs the children of two matched elements. Returns { pairs: [[a, b]], onlyA, onlyB }.
 */
function match(type, path, A, B, sa, sb) {
  const pairs = [], onlyA = [], onlyB = [];
  const tagsA = new Map(), tagsB = new Map();
  for (const x of A) (tagsA.get(x.name) || tagsA.set(x.name, []).get(x.name)).push(x);
  for (const y of B) (tagsB.get(y.name) || tagsB.set(y.name, []).get(y.name)).push(y);
  const used = new Set();
  for (const [tag, la] of tagsA) {
    const lb = tagsB.get(tag) || [];
    if (la.length === 1 && lb.length === 1) { pairs.push([la[0], lb[0]]); used.add(lb[0]); continue; }
    // wrappers of one element, on both sides throughout: identified by what they wrap
    const wrappers = la.concat(lb).every(e => kids(e).length === 1 && !isLeaf(kids(e)[0]));
    const idOf = new Map();
    // nothing known identifies them: a name-like field they all have once, unique on both sides, does - so a list
    // from a newer release (agents, topics, summary configurations...) pairs by its names, not by position
    const inferred = la.concat(lb).every(e => !isLeaf(e) && identity(type, path, e, wrappers) == null) ? inferKey(la, lb) : null;
    const id = e => { if (!idOf.has(e)) idOf.set(e, inferred ? inferred + '=' + val(kids(e).find(k => k.name === inferred)) : identity(type, path, e, wrappers)); return idOf.get(e); };
    // by identity, when it is unique on both sides
    const idsB = new Map(), dupB = new Set();
    for (const y of lb) { const k = id(y); if (k == null) continue; if (idsB.has(k)) dupB.add(k); idsB.set(k, y); }
    const idsA = new Map(), dupA = new Set();
    for (const x of la) { const k = id(x); if (k == null) continue; if (idsA.has(k)) dupA.add(k); idsA.set(k, x); }
    const restA = [];
    for (const x of la) {
      const k = id(x);
      if (k != null && !dupA.has(k) && !dupB.has(k)) {
        const y = idsB.get(k);
        if (y) { pairs.push([x, y]); used.add(y); } else onlyA.push(x);
      } else restA.push(x);
    }
    const restB = lb.filter(y => { if (used.has(y)) return false; const k = id(y); return k == null || dupA.has(k) || dupB.has(k); });
    for (const y of lb) { if (used.has(y) || restB.includes(y)) continue; onlyB.push(y); used.add(y); }
    // the rest: identical ones first, then by order - their order is their meaning
    const freeB = restB.slice();
    const leftA = [];
    for (const x of restA) {
      const i = freeB.findIndex(y => sb.flat(y) === sa.flat(x));
      if (i >= 0) { pairs.push([x, freeB[i]]); used.add(freeB[i]); freeB.splice(i, 1); } else leftA.push(x);
    }
    for (let i = 0; i < leftA.length; i++) {
      if (i < freeB.length) { pairs.push([leftA[i], freeB[i]]); used.add(freeB[i]); } else onlyA.push(leftA[i]);
    }
    for (const y of freeB.slice(leftA.length)) { onlyB.push(y); used.add(y); }
  }
  for (const y of B) if (!used.has(y)) onlyB.push(y);
  return { pairs, onlyA, onlyB };
}

/**
 * Compares target, your resolution and the feature branch. Returns
 * { list, counts, hold } shaped like src/liveMarks.js.
 */
function compare(targetText, incomingText, mergedText, opts) {
  const type = (opts && opts.type) || null;
  const sa = side(targetText), sb = side(mergedText), sf = incomingText != null ? side(incomingText) : null;
  if (!sa.ok) return null;   // the target is not XML: the line comparison does it
  if (!sb.ok) return { hold: true, list: [], counts: {} };   // XML you are halfway through editing: the marks hold
  const out = [];
  const linesOf = (s, el) => s.lines.slice(s.lineOf(el.start), s.lineOf(el.end - 1) + 1);
  const strip = ls => ls.map(l => l.replace(/\r?\n$/, ''));
  const add = (kind, bStart, bEnd, removed, added, label, undo) => out.push({ kind, bStart, bEnd, aStart: 0, aEnd: 0, removed: strip(removed), added: strip(added), label, undo });

  // where an element of one side goes back in your resolution: straight after the sibling it followed, else before
  // the one it preceded, else first inside the parent - where it was, whatever else changed around it
  function placeIn(list, idx, pairOf, parentB) {
    for (let i = idx - 1; i >= 0; i--) { const y = pairOf(list[i]); if (y) return sb.lineOf(y.end - 1) + 1; }
    for (let i = idx + 1; i < list.length; i++) { const y = pairOf(list[i]); if (y) return sb.lineOf(y.start); }
    return sb.lineOf(parentB.openTagEnd || parentB.start) + 1;
  }

  function walk(a, b, f, path) {
    if (sa.flat(a) === sb.flat(b) && (!f || sf.flat(f) === sb.flat(b))) return;
    const A = kids(a), B = kids(b), F = f ? kids(f) : [];
    const ab = match(type, path, A, B, sa, sb);
    const bf = f ? match(type, path, B, F, sb, sf) : { pairs: [], onlyA: B, onlyB: [] };
    const fOf = new Map(bf.pairs.map(([y, z]) => [y, z]));
    const bOfA = new Map(ab.pairs.map(([x, y]) => [x, y]));
    // what the target has and your resolution does not
    A.forEach((x, i) => {
      if (bOfA.has(x)) return;
      const at = placeIn(A, i, el => bOfA.get(el), b);
      const ls = linesOf(sa, x);
      add('removed', at, at, ls, [], describe(type, path, x) + (ls.length > 1 ? ' (' + ls.length + ' lines)' : ''),
        sa.owns(x) ? { bStart: at, bEnd: at, expect: [], insert: ls.join('') } : null);
    });
    // what your resolution has and the target does not: from the feature when the feature has it just so
    for (const y of ab.onlyB) {
      const z = fOf.get(y);
      const ls = linesOf(sb, y), s0 = sb.lineOf(y.start);
      add(z && sf.flat(z) === sb.flat(y) ? 'feature' : 'own', s0, s0 + ls.length, [], ls, describe(type, path, y) + (ls.length > 1 ? ' (' + ls.length + ' lines)' : ''),
        sb.owns(y) ? { bStart: s0, bEnd: s0 + ls.length, expect: strip(ls), insert: '' } : null);
    }
    // what the feature has, the target never had, and your resolution left out
    if (f) {
      const inA = new Set(match(type, path, A, F, sa, sf).pairs.map(([, z]) => z));
      const bOfF = new Map(bf.pairs.map(([y, z]) => [z, y]));
      F.forEach((z, i) => {
        if (bOfF.has(z) || inA.has(z)) return;
        const at = placeIn(F, i, el => bOfF.get(el), b);
        const ls = linesOf(sf, z);
        add('dropped', at, at, ls, [], describe(type, path, z) + (ls.length > 1 ? ' (' + ls.length + ' lines)' : ''),
          sf.owns(z) ? { bStart: at, bEnd: at, expect: [], insert: ls.join('') } : null);
      });
    }
    // what both have: the same, a changed value, or changes inside
    for (const [x, y] of ab.pairs) {
      const z = fOf.get(y);
      if (sa.flat(x) === sb.flat(y) && (!z || sf.flat(z) === sb.flat(y))) continue;
      if (isLeaf(x) && isLeaf(y)) {
        if (sa.flat(x) === sb.flat(y)) continue;
        const ta = val(x), tb = val(y);
        if (/\n/.test(ta) || /\n/.test(tb)) { longText(x, y, z, path); continue; }
        const head = leafHead(path, a, x);
        const s0 = sb.lineOf(y.start), ls = linesOf(sb, y), la = linesOf(sa, x);
        add(z && val(z) === tb ? 'changed-feature' : 'changed-own', s0, s0 + ls.length, la, ls, head + ': ' + clip(ta) + ' \u2192 ' + clip(tb),
          sb.owns(y) && sa.owns(x) ? { bStart: s0, bEnd: s0 + ls.length, expect: strip(ls), insert: la.join('') } : null);
        continue;
      }
      if (isLeaf(x) !== isLeaf(y)) {
        const s0 = sb.lineOf(y.start), ls = linesOf(sb, y), la = linesOf(sa, x);
        add(z && sf.flat(z) === sb.flat(y) ? 'changed-feature' : 'changed-own', s0, s0 + ls.length, la, ls, describe(type, path, y),
          sb.owns(y) && sa.owns(x) ? { bStart: s0, bEnd: s0 + ls.length, expect: strip(ls), insert: la.join('') } : null);
        continue;
      }
      walk(x, y, z || null, path.concat(x.name));
    }
  }

  const leafHead = (path, parent, x) => leafLabel(type, path, parent, x);

  // long text in one element: line by line inside it, like code
  function longText(x, y, z, path) {
    const la = linesOf(sa, x), lb = linesOf(sb, y), s0 = sb.lineOf(y.start);
    const lf = z ? new Set(linesOf(sf, z).map(l => l.trim())) : new Set();
    const ch = D.changes(la.join(''), lb.join('')) || [];
    for (const c of ch) {
      // spaces only: formatting, not a change
      if (c.removed.map(l => l.trim()).join('\n') === c.added.map(l => l.trim()).join('\n')) continue;
      const bS = s0 + c.bStart, bE = s0 + c.bEnd;
      const fromFeature = c.added.length && c.added.filter(l => l.trim()).every(l => lf.has(l.trim()));
      const kind = !c.added.length ? 'removed' : !c.removed.length ? (fromFeature ? 'feature' : 'own') : (fromFeature ? 'changed-feature' : 'changed-own');
      add(kind, bS, bE, c.removed, c.added, null, { bStart: bS, bEnd: bE, expect: c.added, insert: la.slice(c.aStart, c.aEnd).join('') });
      out[out.length - 1].context = 'in ' + x.name;
    }
  }

  walk(sa.doc.root, sb.doc.root, sf && sf.ok ? sf.doc.root : null, []);
  const rank = k => k === 'removed' ? 0 : k === 'dropped' ? 1 : 2;
  out.sort((p, q) => p.bStart - q.bStart || rank(p.kind) - rank(q.kind));
  out.forEach((c, i) => { c.id = i; });
  const counts = { feature: 0, own: 0, removed: 0, dropped: 0 };
  for (const c of out) counts[c.kind === 'changed-feature' ? 'feature' : c.kind === 'changed-own' ? 'own' : c.kind]++;
  return { list: out, counts, tooMany: false, byElement: true };
}

/** A changed value inside a property: "uiBehavior"; inside a keyed entry: "Account.X__c editable"; the entry's own key: its tag. */
function leafLabel(type, path, parent, x) {
  const nameChild = kids(parent).find(k => k.name === 'name' && isLeaf(k));
  if (nameChild && nameChild !== x && (x.name === 'value' || x.name === 'stringValue')) return val(nameChild);
  const pid = identity(type, path.slice(0, -1), parent);
  if (pid && pid.split('|').some(p => p.replace(/^\w+\//, '').startsWith(x.name + '='))) return x.name;
  const shown = pid && pid[0] !== '=' ? pid.split('|').map(p => p.slice(p.indexOf('=') + 1)).join(' / ').replace(/^\w+\//, '') : null;
  return (shown && path.length ? shown + ' ' : '') + x.name;
}

const clip = t => { const s = String(t).replace(/\s+/g, ' '); return s.length > 40 ? s.slice(0, 39) + '\u2026' : s; };

module.exports = { compare, identity, describe, match, side, kids, isLeaf, val, leafLabel, clip };
