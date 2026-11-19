'use strict';

/**
 * The merge editor's two panes, lined up. Your resolution is the right pane;
 * the left pane is the target written in your order - so a block you moved
 * sits level with itself - and every line of your resolution belongs to one
 * piece:
 *
 *   same            the target has it just so
 *   feature         the feature branch's, not the target's (green)
 *   own             in neither branch - your own edit (blue)
 *   changed-feature the target's value, replaced by the feature's
 *   changed-own     the target's value, replaced by yours
 *   removed         target lines you no longer have (no lines on the right: shown struck through)
 *   dropped         feature lines you left out (likewise)
 *   kept            the target's, still here, and not in the feature branch - where order matters
 *                   (a page's items, a layout's sections, a flow's elements): the feature may have
 *                   removed it. Not in lists Salesforce sorts itself (permissions, labels, fields),
 *                   where a missing entry is one the file was retrieved without
 *   differs         the target's value, still here, where the feature branch has another
 *
 * Moves are found apart from the pieces, only where order matters: the
 * longest run of elements still in the target's order stays; the rest moved.
 * XML is compared element by element (src/xmlCompare.js); 'literal' mode,
 * and anything that is not XML, line by line with the target as it is.
 *
 *   align(target, incoming, mine, { type, mode }) ->
 *     { left, pieces: [{ kind, a0, a1, b0, b1, left, label, undo }], moves: [{ b0, b1, label, undo }], counts }
 *     or { hold: true } while your resolution is not valid XML
 *
 * Every undo is a list of line edits on your resolution - { b0, b1, expect, insert } - that
 * apply only if those lines still are what was marked. Plain Node.js.
 */
const XC = require('./xmlCompare');

/** What an element is: its identity, or for a list with none, what it holds - "quickActionList: NewCase, LogACall". */
function nameOf(type, path, el) {
  const said = XC.describe(type, path, el);
  const ks = XC.kids(el);
  if (said !== el.name || !ks.length || XC.isLeaf(el)) return said;
  const ids = ks.map(k => XC.identity(type, path.concat(el.name), k, true)).filter(Boolean)
    .map(id => id.replace(/^\w+\//, '').split('|').map(p => p.slice(p.indexOf('=') + 1)).join(' / '));
  if (ids.length) return el.name + ': ' + (ids.length > 3 ? ids.slice(0, 3).join(', ') + ' and ' + (ids.length - 3) + ' more' : ids.join(', '));
  // nothing that identifies it: the first value it holds - "valueListItems NewCase"
  const first = (function find(e) { for (const k of XC.kids(e)) { if (XC.isLeaf(k)) { const v = XC.val(k); if (v) return v; } else { const v = find(k); if (v) return v; } } return null; })(el);
  return first ? el.name + ' ' + XC.clip(first) : said;
}
const D = require('./linediff');
const registry = require('./registry');

const split = t => { const s = String(t); return s ? s.split(/(?<=\n)/) : []; };
const strip = ls => ls.map(l => l.replace(/\r?\n$/, ''));

/** Pieces from comparing two runs of lines - for literal mode, long text, and what is not XML. */
function lineRuns(leftLines, rightLines, b0, feature, out, context) {
  // a line's trailing spaces are not a change: compared without them, and without the line endings
  const bare = ls => ls.map(l => l.replace(/\r?\n$/, '').replace(/\s+$/, '') + '\n').join('');
  const raw = D.changes(bare(leftLines), bare(rightLines)) || null;
  if (!raw) { out.push({ kind: 'changed-own', left: leftLines, b0, b1: b0 + rightLines.length, label: null, context }); return; }
  // changes that touch - a line taken out, two put in its place - are one change, not three
  const list = [];
  for (const c of raw) {
    const last = list[list.length - 1];
    if (last && c.aStart === last.aEnd && c.bStart === last.bEnd) list[list.length - 1] = Object.assign({}, last, { aEnd: c.aEnd, bEnd: c.bEnd, removed: last.removed.concat(c.removed), added: last.added.concat(c.added) });
    else list.push(c);
  }
  const start = out.length;
  const inFeature = ls => feature && ls.filter(l => l.trim()).every(l => feature.has(l.trim()));
  let ai = 0, bi = 0;
  const same = (a1, b1) => { if (b1 > bi || a1 > ai) out.push({ kind: 'same', left: leftLines.slice(ai, a1), b0: b0 + bi, b1: b0 + b1 }); };
  for (const c of list) {
    same(c.aStart, c.bStart);
    const kind = !c.added.length ? 'removed' : !c.removed.length ? (inFeature(c.added) ? 'feature' : 'own') : (inFeature(c.added) ? 'changed-feature' : 'changed-own');
    out.push({ kind, left: leftLines.slice(c.aStart, c.aEnd), b0: b0 + c.bStart, b1: b0 + c.bEnd, label: null, context });
    ai = c.aEnd; bi = c.bEnd;
  }
  same(leftLines.length, rightLines.length);
  quietBlanks(out, start, rightLines, b0);
}

/**
 * Blank lines are not a change of their own: next to a change they join it (with any blank lines between, alike on
 * both sides); alone they are one quiet difference - no row, not counted, passed by F7.
 */
function quietBlanks(out, start, rightLines, b0) {
  const blank = ls => ls.every(l => !l.trim());
  const linesOf = p => (p.kind === 'removed' ? p.left : rightLines.slice(p.b0 - b0, p.b1 - b0)).concat(p.kind.startsWith('changed') ? p.left : []);
  const isBlankChange = p => p.kind !== 'same' && blank(linesOf(p));
  const run = out.splice(start);
  const merged = [];
  for (let i = 0; i < run.length; i++) {
    const p = run[i];
    if (p.kind === 'same') { merged.push(p); continue; }
    // a change, and what follows it: blank same lines and blank changes, up to the next real change
    let j = i, end = i;
    while (j + 1 < run.length && (isBlankChange(run[j + 1]) || (run[j + 1].kind === 'same' && blank(run[j + 1].left) && j + 2 < run.length && run[j + 2].kind !== 'same'))) { j++; if (run[j].kind !== 'same') end = j; }
    const group = run.slice(i, end + 1);
    if (group.length === 1) { merged.push(p.kind !== 'same' && isBlankChange(p) ? Object.assign({}, p, { kind: 'blank' }) : p); continue; }
    const real = group.filter(g => g.kind !== 'same' && !isBlankChange(g));
    const kinds = new Set(group.filter(g => g.kind !== 'same').map(g => g.kind));
    const any = k => [...kinds].some(x => x === k || x === 'changed-' + k);
    const kind = !real.length ? 'blank' : group.every(g => g.kind === 'same' || g.kind === 'removed') ? 'removed'
      : !kinds.has('removed') && !group.some(g => g.kind.startsWith('changed')) ? (any('own') ? 'own' : 'feature') : (any('own') ? 'changed-own' : 'changed-feature');
    merged.push({ kind, left: group.reduce((a, g) => a.concat(g.left || []), []), b0: group[0].b0, b1: group[group.length - 1].b1, label: null, context: p.context });
    i = end;
  }
  // a blank change that came first, before a real one: it joins the one after it
  for (let k = merged.length - 2; k >= 0; k--) {
    const a = merged[k], b = merged[k + 1];
    if (a.kind === 'blank' && b.kind !== 'same' && b.kind !== 'blank' && a.b1 === b.b0) { merged.splice(k, 2, Object.assign({}, b, { left: a.left.concat(b.left), b0: a.b0, kind: b.kind === 'removed' && a.b1 > a.b0 ? 'changed-own' : b.kind })); }
  }
  out.push(...merged);
}

function align(targetText, incomingText, mergedText, opts) {
  const o = opts || {};
  const type = o.type || null;
  const sa = XC.side(targetText), sb = XC.side(mergedText), sf = incomingText != null ? XC.side(incomingText) : null;
  // the common ancestor, when it is known (the merge-base from the repository, or Copado's own): what each branch
  // did since, not only how they differ - a target's own addition, or its own change, is then no mark at all
  const so = o.ancestor != null ? XC.side(o.ancestor) : null;
  const ancestorOk = !!(so && so.ok);
  const lines = { a: sa.lines, b: sb.lines, f: sf ? sf.lines : [] };
  const featureSet = new Set(lines.f.map(l => l.trim()).filter(Boolean));
  const pieces = [], moves = [];

  if (o.mode === 'literal' || !sa.ok) {
    lineRuns(lines.a, lines.b, 0, featureSet, pieces, null);
    return finish(pieces, moves, sb, 'literal');
  }
  if (!sb.ok) return { hold: true };

  const kids = XC.kids, isLeaf = XC.isLeaf, val = XC.val;
  const lineOf = (s, off) => s.lineOf(off);
  // an element whose children each start on their own line - the layout of formatted metadata
  const tidy = (s, el, ks) => ks.length && ks.every((k, i) => i === 0 ? lineOf(s, k.start) > lineOf(s, el.start) : lineOf(s, k.start) > lineOf(s, ks[i - 1].start)) &&
    el.closeStart != null && lineOf(s, el.closeStart) > lineOf(s, ks[ks.length - 1].end - 1);
  // a child's lines: from just after the one before it (or the parent's opening tag) to its own last line - the
  // comments and blank lines before an element belong to it, as a comment describes what follows
  const openEnd = (s, el) => lineOf(s, (el.openTagEnd != null ? el.openTagEnd : el.start + 1) - 1) + 1;
  const range = (s, el, ks, i) => [i ? lineOf(s, ks[i - 1].end - 1) + 1 : openEnd(s, el), lineOf(s, ks[i].end - 1) + 1];
  // the same element, and the same lines around it - a comment added or taken out is a change
  const notes = ls => ls.map(l => l.trim()).filter(l => /<!--|-->/.test(l)).join('\n');
  const sameLines = (a1, b1) => notes(a1) === notes(b1);
  // lines alike but for their line endings
  const eq = (x, y) => { const n = t => t.replace(/[ \t]+(?=\r?\n|$)/g, '').replace(/\r/g, ''); return n(x) === n(y); };
  const slice = (side, r) => lines[side].slice(r[0], r[1]);
  const flat = (s, el) => s.flat(el);
  // order is meaning unless the list is sortable (Salesforce sorts it) or order-free (read by name, run by connectors)
  const orderMatters = (path, tag) => { const spec = registry.specFor(type, path, tag); return !(spec && (spec.sortable === true || spec.orderFree === true)); };

  // two opening tags alike as Salesforce reads them: the same attributes - an identity attribute, such as a component
  // configuration's targets, as a set; any other exactly (a picklist property's datasource is in order)
  const sameOpenTag = (a, b, path) => {
    if (a.name !== b.name) return false;
    const spec = registry.specFor(type, path.slice(0, -1), a.name), keyed = new Set((spec && spec.key) || []);
    const norm = (n, v) => keyed.has(n) ? String(v).split(',').map(t => t.trim()).filter(Boolean).sort().join(',') : v;
    const am = new Map((a.attrs || []).map(t => [t.name, norm(t.name, t.value)])), bm = new Map((b.attrs || []).map(t => [t.name, norm(t.name, t.value)]));
    return am.size === bm.size && [...am].every(([n, v]) => bm.get(n) === v);
  };

  function walk(a, b, f, path, w0) {
    const A = kids(a), B = kids(b), F = f ? kids(f) : [];
    if (!tidy(sa, a, A) || !tidy(sb, b, B)) {
      // not one child per line: compare these lines as they are
      lineRuns(slice('a', [lineOf(sa, a.start), lineOf(sa, a.end - 1) + 1]), slice('b', [lineOf(sb, b.start), lineOf(sb, b.end - 1) + 1]), lineOf(sb, b.start), featureSet, pieces, 'in ' + b.name);
      return;
    }
    const ab = XC.match(type, path, A, B, sa, sb);
    // renamed: an element gone and one come in its place, alike but for the field that names them - one change, not two
    {
      const pairedA = new Set(ab.pairs.map(([x]) => x)), pairedB = new Set(ab.pairs.map(([, y]) => y));
      const renamedBy = (x, y) => {
        if (x.name !== y.name || isLeaf(x) || isLeaf(y)) return null;
        const kx = kids(x), ky = kids(y), nx = kx.map(k => k.name), ny = ky.map(k => k.name);
        // something besides the name must be alike: an element that is only its name, replaced, is another element
        if (nx.length < 2 || new Set(nx).size !== nx.length || nx.length !== ny.length || nx.slice().sort().join() !== ny.slice().sort().join()) return null;
        let field = null;
        for (const k of kx) {
          const m = ky.find(c => c.name === k.name);
          if (sa.flat(k) === sb.flat(m)) continue;
          if (field || !isLeaf(k) || !isLeaf(m) || !XC.identityField(type, path, x, k.name)) return null;
          field = k.name;
        }
        // and what is alike must say something: a text - a label's value, a field's item - not only flags or numbers,
        // or two permissions for two fields would read as one renamed
        const telling = kx.some(k => k.name !== field && isLeaf(k) && val(k).length >= 2 && !/^(true|false|-?\d+(\.\d+)?)$/i.test(val(k)));
        return field && telling ? field : null;
      };
      for (const y of B) {
        if (pairedB.has(y)) continue;
        const x = A.find(c => !pairedA.has(c) && renamedBy(c, y));
        if (x) { ab.pairs.push([x, y]); pairedA.add(x); pairedB.add(y); }
      }
    }
    const bf = f ? XC.match(type, path, B, F, sb, sf) : { pairs: [] };
    const af = f ? XC.match(type, path, A, F, sa, sf) : { pairs: [] };
    const W = w0 ? kids(w0) : [];
    const aw = w0 ? XC.match(type, path, A, W, sa, so) : { pairs: [] };
    const wOf = new Map(aw.pairs.map(([x, w]) => [x, w]));
    // with the ancestor: did the feature branch take x out (the ancestor had it), or did the target add it since?
    const featureRemoved = x => ancestorOk && w0 ? wOf.has(x) : null;
    const xOf = new Map(ab.pairs.map(([x, y]) => [y, x])), yOf = new Map(ab.pairs.map(([x, y]) => [x, y]));
    const zOf = new Map(bf.pairs.map(([y, z]) => [y, z])), yOfZ = new Map(bf.pairs.map(([y, z]) => [z, y]));
    const zInA = new Set(af.pairs.map(([, z]) => z)), xInF = new Set(af.pairs.map(([x]) => x));
    const idxA = new Map(A.map((x, i) => [x, i])), idxB = new Map(B.map((y, i) => [y, i]));

    // where order is meaning, the longest run still in the target's order stays paired; the rest were moved, which is
    // what it is to the file - removed from one place and added at another. Where two runs are as long, the one with
    // fewer unchanged elements is the one taken out: what you edited moved. An identical pair is linked, so either
    // half's Restore or Undo puts the original back, the copy gone
    const paired = B.filter(y => xOf.has(y));
    const keep = new Set();
    for (const tag of new Set(paired.map(y => y.name))) {
      const group = paired.filter(y => y.name === tag);
      for (const y of keptInOrder(group.map(y => idxA.get(xOf.get(y))), group.map(y => flat(sa, xOf.get(y)) === flat(sb, y)), group)) keep.add(y);
    }
    const links = new Map();
    // what the feature branch itself moved: out of the target's order there too
    const aOfZ = new Map(af.pairs.map(([x, z]) => [z, x]));
    const pairedF = F.filter(z => aOfZ.has(z));
    const keepF = f ? keptInOrder(pairedF.map(z => idxA.get(aOfZ.get(z))), pairedF.map(z => flat(sa, aOfZ.get(z)) === flat(sf, z)), pairedF) : new Set();
    const featureMoved = z => !!z && aOfZ.has(z) && !keepF.has(z);
    for (const y of paired) {
      if (keep.has(y) || !orderMatters(path, y.name)) continue;
      const x = xOf.get(y);
      xOf.delete(y); yOf.delete(x);
      if (flat(sa, x) === flat(sb, y)) { const l = { x, y }; links.set(x, l); links.set(y, l); }
    }

    // the parent's own opening lines
    const head = [lineOf(sa, a.start), openEnd(sa, a)], headB = [lineOf(sb, b.start), openEnd(sb, b)];
    pieces.push({ kind: eq(slice('a', head).join(''), slice('b', headB).join('')) || sameOpenTag(a, b, path) ? 'same' : 'changed-own', left: slice('a', head), b0: headB[0], b1: headB[1], label: attrDiff(a, b) ? b.name + ' ' + attrDiff(a, b) : b.name });

    // what the target has and you do not, and what the feature added and you left out: each after the sibling it followed
    const after = new Map(), atStart = [];
    const anchorOf = (list, i, partner) => { for (let j = i - 1; j >= 0; j--) { const y = partner(list[j]); if (y) return y; } return null; };
    A.forEach((x, i) => { if (yOf.has(x)) return; const y = anchorOf(A, i, e => yOf.get(e)); const item = { kind: 'removed', el: x, side: 'a', r: range(sa, a, A, i), byFeature: !!f && !xInF.has(x) && featureRemoved(x) === true, notInFeature: !!f && featureRemoved(x) !== false && !xInF.has(x) }; if (y) (after.get(y) || after.set(y, []).get(y)).push(item); else atStart.push(item); });
    F.forEach((z, i) => { if (yOfZ.has(z) || zInA.has(z)) return; const y = anchorOf(F, i, e => yOfZ.get(e)); const item = { kind: 'dropped', el: z, side: 'f', r: range(sf, f, F, i) }; if (y) (after.get(y) || after.set(y, []).get(y)).push(item); else atStart.push(item); });
    const gone = (items, at) => {
      for (const it of items) {
        const left = slice(it.side, it.r);
        const n = left.filter(l => l.trim()).length;
        const piece = { kind: it.kind, left: it.kind === 'removed' ? left : [], ghost: left, b0: at, b1: at, notInFeature: it.notInFeature || undefined, byFeature: it.byFeature || undefined, label: nameOf(type, path, it.el) + (n > 1 ? ' (' + n + ' lines)' : ''),
          undo: [{ b0: at, b1: at, expect: [], insert: left.join('') }] };
        const l = it.kind === 'removed' && links.get(it.el);
        if (l) { l.at = at; l.ghost = left; l.removed = piece; }
        pieces.push(piece);
      }
    };
    gone(atStart, headB[1]);

    B.forEach((y, i) => {
      const yr = range(sb, b, B, i), x = xOf.get(y), z = zOf.get(y);
      const yLines = slice('b', yr);
      if (!x) {
        // a moved one is yours unless the feature branch made the same move
        const kind = z && flat(sf, z) === flat(sb, y) && (!links.has(y) || featureMoved(z)) ? 'feature' : 'own';
        const n = yLines.filter(l => l.trim()).length;
        const piece = { kind, left: [], b0: yr[0], b1: yr[1], label: nameOf(type, path, y) + (n > 1 ? ' (' + n + ' lines)' : ''), undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: '' }] };
        const l = links.get(y);
        if (l) { l.yr = yr; l.yLines = yLines; l.added = piece; }
        pieces.push(piece);
      } else {
        const xr = range(sa, a, A, idxA.get(x));
        if (flat(sa, x) === flat(sb, y) && !sameLines(slice('a', xr), yLines)) {
          // the same element, with a comment or a blank line added or taken out around it: line by line
          lineRuns(slice('a', xr), yLines, yr[0], featureSet, pieces, null);
        } else if (flat(sa, x) === flat(sb, y)) {
          // the target's, unchanged by you - and what the feature branch did with it
          const n = yLines.filter(l => l.trim()).length;
          if (f && !z && !xInF.has(x) && orderMatters(path, y.name) && featureRemoved(x) === false) pieces.push({ kind: 'same', left: slice('a', xr), b0: yr[0], b1: yr[1] });
          else if (f && !z && !xInF.has(x) && orderMatters(path, y.name)) {
            pieces.push({ kind: 'kept', byFeature: featureRemoved(x) === true || undefined, left: slice('a', xr), b0: yr[0], b1: yr[1], label: nameOf(type, path, y) + (n > 1 ? ' (' + n + ' lines)' : ''), undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: '' }] });
          } else if (!z || flat(sf, z) === flat(sb, y)) pieces.push({ kind: 'same', left: slice('a', xr), b0: yr[0], b1: yr[1] });
          // the feature's value is the ancestor's: the target changed it since - keeping it is right
          else if (ancestorOk && wOf.has(x) && flat(so, wOf.get(x)) === flat(sf, z)) pieces.push({ kind: 'same', left: slice('a', xr), b0: yr[0], b1: yr[1] });
          else if (isLeaf(y) || isLeaf(z)) {
            const zl = slice('f', [lineOf(sf, z.start), lineOf(sf, z.end - 1) + 1]);
            const what = isLeaf(y) && isLeaf(z) ? XC.leafLabel(type, path, b, y) + ': ' + XC.clip(val(z)) + ' (here: ' + XC.clip(val(y)) + ')' : nameOf(type, path, y);
            pieces.push({ kind: 'differs', byFeature: (ancestorOk && wOf.has(x) && flat(so, wOf.get(x)) === flat(sa, x)) || undefined, left: slice('a', xr), b0: yr[0], b1: yr[1], label: what, undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: zl.join('') }] });
          } else walk(x, y, z, path.concat(x.name), wOf.get(x));
        } else if (isLeaf(x) && isLeaf(y)) {
          const ta = val(x), tb = val(y);
          // the same text, other attributes - a component property's default: say which, and how
          const attrsChanged = ta === tb && attrDiff(x, y);
          if (attrsChanged) pieces.push({ kind: z && flat(sf, z) === flat(sb, y) ? 'changed-feature' : 'changed-own', left: slice('a', xr), b0: yr[0], b1: yr[1],
            label: XC.describe(type, path, y) + ' ' + attrsChanged, undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: slice('a', xr).join('') }] });
          else if (/\n/.test(ta) || /\n/.test(tb)) lineRuns(slice('a', xr), yLines, yr[0], new Set(z ? slice('f', [lineOf(sf, z.start), lineOf(sf, z.end - 1) + 1]).map(l => l.trim()) : []), pieces, 'in ' + y.name);
          else if (type === 'Flow' && /^location[XY]$/.test(y.name)) pieces.push({ kind: 'position', left: slice('a', xr), b0: yr[0], b1: yr[1], owner: nameOf(type, path.slice(0, -1), b),
            label: y.name + ': ' + XC.clip(ta) + ' \u2192 ' + XC.clip(tb), undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: slice('a', xr).join('') }] });
          else pieces.push({ kind: z && val(z) === tb ? 'changed-feature' : 'changed-own', left: slice('a', xr), b0: yr[0], b1: yr[1],
            label: (path.length && XC.identityField(type, path.slice(0, -1), b, y.name) && XC.identity(type, path.slice(0, -1), b) !== XC.identity(type, path.slice(0, -1), a)
              ? 'Renamed ' + b.name + ': ' : XC.leafLabel(type, path, b, y) + ': ') + XC.clip(ta) + ' \u2192 ' + XC.clip(tb), undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: slice('a', xr).join('') }] });
        } else if (isLeaf(x) !== isLeaf(y)) {
          pieces.push({ kind: z && flat(sf, z) === flat(sb, y) ? 'changed-feature' : 'changed-own', left: slice('a', xr), b0: yr[0], b1: yr[1], label: nameOf(type, path, y),
            undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: slice('a', xr).join('') }] });
        } else walk(x, y, z || null, path.concat(x.name), wOf.get(x));
      }
      gone(after.get(y) || [], yr[1]);
    });

    for (const l of new Set(links.values())) {
      if (!l.removed || !l.added) continue;
      const both = [{ b0: l.yr[0], b1: l.yr[1], expect: strip(l.yLines), insert: '' }, { b0: l.at, b1: l.at, expect: [], insert: l.ghost.join('') }];
      l.removed.undo = both; l.added.undo = both;
      l.removed.now = l.yr[0] + 1; l.added.was = l.at + 1;
    }

    // the parent's closing lines
    // after the last child: what is left before the end tag, and the end tag
    const tail = [lineOf(sa, A[A.length - 1].end - 1) + 1, lineOf(sa, a.end - 1) + 1], tailB = [lineOf(sb, B[B.length - 1].end - 1) + 1, lineOf(sb, b.end - 1) + 1];
    pieces.push({ kind: eq(slice('a', tail).join(''), slice('b', tailB).join('')) ? 'same' : 'changed-own', left: slice('a', tail), b0: tailB[0], b1: tailB[1] });
  }

  // what comes before and after the root - the XML declaration, a trailing newline
  const rootA = sa.doc.root, rootB = sb.doc.root;
  const preA = [0, lineOf(sa, rootA.start)], preB = [0, lineOf(sb, rootB.start)];
  if (preB[1] || preA[1]) pieces.push({ kind: eq(slice('a', preA).join(''), slice('b', preB).join('')) ? 'same' : 'changed-own', left: slice('a', preA), b0: 0, b1: preB[1] });
  walk(rootA, rootB, sf && sf.ok ? sf.doc.root : null, [], ancestorOk ? so.doc.root : null);
  const postA = [lineOf(sa, rootA.end - 1) + 1, lines.a.length], postB = [lineOf(sb, rootB.end - 1) + 1, lines.b.length];
  if (postB[1] > postB[0] || postA[1] > postA[0]) pieces.push({ kind: 'same', left: slice('a', postA), b0: postB[0], b1: postB[1] });
  const r = finish(pieces, moves, sb, 'order');
  // the pieces must cover your resolution, every line once, in order - else the line comparison does it
  return r.ok ? r : align(targetText, incomingText, mergedText, Object.assign({}, o, { mode: 'literal' }));
}

/**
 * The elements that stay put: the longest run whose target positions rise,
 * each element worth 1 and an unchanged one a little more, so a tie keeps
 * what you did not touch. Weighted, for the lists where order matters - a
 * page's items, a flow's elements - which are short; a long one is ranked
 * by count alone.
 */
/** "default: Hello \u2192 Hi, label: (none) \u2192 Title" - the attributes that differ, or null. */
function attrDiff(x, y) {
  const a = new Map((x.attrs || []).map(t => [t.name, t.value])), b = new Map((y.attrs || []).map(t => [t.name, t.value]));
  const out = [];
  for (const n of [...new Set([...a.keys(), ...b.keys()])].sort()) if (a.get(n) !== b.get(n)) out.push(n + ': ' + (a.has(n) ? XC.clip(a.get(n)) : '(none)') + ' \u2192 ' + (b.has(n) ? XC.clip(b.get(n)) : '(none)'));
  return out.length ? out.join(', ') : null;
}

function keptInOrder(seq, unchanged, items) {
  const n = seq.length, keep = new Set();
  if (!n) return keep;
  if (n > 1500) {
    const tails = [], prev = new Array(n);
    seq.forEach((v, i) => { let lo = 0, hi = tails.length; while (lo < hi) { const m = (lo + hi) >> 1; if (seq[tails[m]] < v) lo = m + 1; else hi = m; } prev[i] = lo ? tails[lo - 1] : -1; tails[lo] = i; });
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(items[i]);
    return keep;
  }
  const best = new Array(n), prev = new Array(n).fill(-1);
  let top = 0;
  for (let i = 0; i < n; i++) {
    best[i] = 1 + (unchanged[i] ? 0.001 : 0);
    for (let j = 0; j < i; j++) if (seq[j] < seq[i] && best[j] + 1 + (unchanged[i] ? 0.001 : 0) > best[i]) { best[i] = best[j] + 1 + (unchanged[i] ? 0.001 : 0); prev[i] = j; }
    if (best[i] > best[top]) top = i;
  }
  for (let i = top; i >= 0; i = prev[i]) keep.add(items[i]);
  return keep;
}

/** Line numbers on the left, names for what changed, undo for each, the counts - and a check that the pieces cover every line. */
/* ------------------------------------------------------------ code: Apex and JavaScript classes */

/**
 * A class's members, by what identifies them - so a member moved is no change, and an edit says which member:
 * { header: [l0, l1), members: [{ id, label, l0, l1 }], tail: [l0, l1) } in lines, or null when the code cannot be
 * read as a class (it is then compared line by line). Strings and comments are skipped; the comments and
 * annotations before a member belong to it.
 */
function units(text, language) {
  const t = String(text), js = language === 'javascript';
  // where each character is code (not a string or a comment), and the brace depth there
  let i = 0, depth = 0, bodyStart = -1, bodyEnd = -1;
  const ends = [];      // character offsets where a member ends, at depth 1
  let memberStartDepth1 = null;
  const lineAt = off => { let n = 0; for (let k = 0; k < off && k < t.length; k++) if (t[k] === '\n') n++; return n; };
  while (i < t.length) {
    const c = t[i], d = t[i + 1];
    if (c === '/' && d === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; continue; }
    if (c === '\'' || c === '"' || (js && c === '`')) { const q = c; i++; while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++; } i++; continue; }
    if (c === '{' || c === '(' || c === '[') {
      if (c === '{' && depth === 0 && bodyStart < 0 && /\b(class|interface|enum)\b[^{;]*$/.test(t.slice(Math.max(0, i - 300), i))) bodyStart = i;
      depth++;
    } else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth < 0) return null;
      if (c === '}' && depth === 1 && bodyStart >= 0 && bodyEnd < 0) ends.push(i + 1);
      if (c === '}' && depth === 0 && bodyStart >= 0 && bodyEnd < 0) bodyEnd = i;
    } else if (c === ';' && depth === 1 && bodyStart >= 0 && bodyEnd < 0) ends.push(i + 1);
    i++;
  }
  if (bodyStart < 0 || bodyEnd < 0 || depth !== 0) return null;
  const headerEnd = lineAt(bodyStart) + 1, tailStart = lineAt(bodyEnd);
  const members = [];
  let prev = headerEnd;
  for (const e of ends) {
    const l1 = lineAt(e - 1) + 1;
    if (l1 <= prev || l1 > tailStart) continue;
    const body = t.split('\n').slice(prev, l1).join('\n');
    const head = body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').replace(/@\w+(\([^)]*\))?/g, ' ').split(/[{;=]/)[0].replace(/\s+/g, ' ').trim();
    let id, label;
    const cls = /\b(class|interface|enum)\s+(\w+)/.exec(head);
    const meth = /(?:\b(get|set)\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*$/.exec(head);
    if (cls) { id = cls[1] + ' ' + cls[2]; label = id; }
    else if (meth && !/^(if|for|while|switch|catch|return)$/.test(meth[2])) {
      const types = js ? '' : meth[3].split(',').map(p => p.trim().split(/\s+/).slice(0, -1).join(' ')).filter(Boolean).join(', ');
      id = (meth[1] ? meth[1] + ' ' : '') + meth[2] + '(' + (js ? '' : types) + ')';
      label = (meth[1] ? (meth[1] === 'get' ? 'getter ' : 'setter ') + meth[2] : (js ? 'method ' : 'method ') + meth[2] + '(' + types + ')');
    } else {
      const name = (/([A-Za-z_$][\w$]*)\s*$/.exec(head) || [])[1];
      if (!name) { prev = l1; continue; }
      id = 'field ' + name; label = (js ? 'field ' : 'property ') + name;
    }
    // a comment kept apart from the member by a blank line - a section banner - is not the member's: a unit of its own
    const all = t.split('\n'), isNote = l => /^\s*(\/\/|\/\*|\*|@\w)/.test(l) || /\*\/\s*$/.test(l);
    let code = prev; while (code < l1 && (!all[code].trim() || isNote(all[code]))) code++;
    let own = code; while (own > prev && all[own - 1].trim() && isNote(all[own - 1])) own--;
    if (own > prev && all.slice(prev, own).some(l => l.trim())) {
      const words = (all.slice(prev, own).map(l => l.replace(/^\s*(\/\/+|\/\*+|\*+\/?|\*)/, '').replace(/\*\/\s*$/, '').replace(/[=\-_*#~]{3,}/g, '').trim()).find(l => /[A-Za-z]/.test(l)) || 'comment').slice(0, 60);
      let cid = 'comment ' + words, k = 2;
      while (members.some(m => m.id === cid)) cid = 'comment ' + words + ' #' + k++;
      members.push({ id: cid, label: 'comment \u201c' + words + '\u201d', l0: prev, l1: own, comment: true });
      prev = own;
    }
    members.push({ id, label, l0: prev, l1 });
    prev = l1;
  }
  return { header: [0, headerEnd], members, tail: [prev, t.split('\n').length - (t.endsWith('\n') ? 1 : 0)] };
}

function finish(pieces, moves, sb, mode) {
  let a = 0, b = 0, ok = true;
  const out = [];
  for (const p of pieces) {
    if (p.b0 !== b) ok = false;
    const left = p.left || [];
    const piece = Object.assign({}, p, { a0: a, a1: a + left.length });
    a += left.length; b = p.b1;
    if (piece.kind !== 'same' && !piece.undo) {
      const right = strip(sb.lines.slice(p.b0, p.b1));
      piece.undo = [{ b0: p.b0, b1: p.b1, expect: right, insert: left.join('') }];
    }
    if (piece.kind !== 'same' && !piece.label) piece.label = ((piece.kind === 'removed' || piece.kind === 'dropped' ? (piece.ghost || left) : sb.lines.slice(p.b0, p.b1)).find(l => l.trim()) || '').trim();
    // neighbours of the same kind make one piece - and an element's X and Y on the canvas, one move
    const last = out[out.length - 1];
    if (last && last.kind === 'same' && piece.kind === 'same') { last.left = last.left.concat(left); last.a1 = piece.a1; last.b1 = piece.b1; continue; }
    if (last && last.kind === 'position' && piece.kind === 'position' && last.b1 === piece.b0 && last.owner === piece.owner) {
      last.left = last.left.concat(left); last.a1 = piece.a1; last.b1 = piece.b1; last.undo = last.undo.concat(piece.undo); last.label += ', ' + piece.label; continue;
    }
    out.push(piece);
  }
  if (b !== sb.lines.length) ok = false;
  const counts = { feature: 0, own: 0, removed: 0, dropped: 0, kept: 0, differs: 0, position: 0, blank: 0, moved: moves.length };
  for (const p of out) if (p.kind !== 'same') counts[p.kind === 'changed-feature' ? 'feature' : p.kind === 'changed-own' ? 'own' : p.kind]++;
  return { ok, mode, left: out.map(p => (p.left || []).join('')).join(''), pieces: out, moves, counts };
}

/** Two runs of lines compared: their pieces - same, changed, added, removed, blank - with the target's lines of each. */
function lineDiff(leftLines, rightLines, b0) {
  const out = [];
  lineRuns(leftLines, rightLines, b0 || 0, new Set(), out, null);
  return out;
}

module.exports = { align, units, lineDiff };
