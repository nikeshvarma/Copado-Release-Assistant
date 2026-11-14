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
  const list = D.changes(leftLines.join(''), rightLines.join('')) || null;
  if (!list) { out.push({ kind: 'changed-own', left: leftLines, b0, b1: b0 + rightLines.length, label: null, context }); return; }
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
}

function align(targetText, incomingText, mergedText, opts) {
  const o = opts || {};
  const type = o.type || null;
  const sa = XC.side(targetText), sb = XC.side(mergedText), sf = incomingText != null ? XC.side(incomingText) : null;
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
  const sameLines = (a1, b1) => a1.map(l => l.trim()).filter(Boolean).join('\n') === b1.map(l => l.trim()).filter(Boolean).join('\n');
  const slice = (side, r) => lines[side].slice(r[0], r[1]);
  const flat = (s, el) => s.flat(el);
  const orderMatters = (path, tag) => { const spec = registry.specFor(type, path, tag); return !(spec && spec.sortable === true); };

  function walk(a, b, f, path) {
    const A = kids(a), B = kids(b), F = f ? kids(f) : [];
    if (!tidy(sa, a, A) || !tidy(sb, b, B)) {
      // not one child per line: compare these lines as they are
      lineRuns(slice('a', [lineOf(sa, a.start), lineOf(sa, a.end - 1) + 1]), slice('b', [lineOf(sb, b.start), lineOf(sb, b.end - 1) + 1]), lineOf(sb, b.start), featureSet, pieces, 'in ' + b.name);
      return;
    }
    const ab = XC.match(type, path, A, B, sa, sb);
    const bf = f ? XC.match(type, path, B, F, sb, sf) : { pairs: [] };
    const af = f ? XC.match(type, path, A, F, sa, sf) : { pairs: [] };
    const xOf = new Map(ab.pairs.map(([x, y]) => [y, x])), yOf = new Map(ab.pairs.map(([x, y]) => [x, y]));
    const zOf = new Map(bf.pairs.map(([y, z]) => [y, z])), yOfZ = new Map(bf.pairs.map(([y, z]) => [z, y]));
    const zInA = new Set(af.pairs.map(([, z]) => z)), xInF = new Set(af.pairs.map(([x]) => x));
    const idxA = new Map(A.map((x, i) => [x, i])), idxB = new Map(B.map((y, i) => [y, i]));

    // moves: the longest run still in the target's order stays put; the rest moved. Where two runs are as
    // long - two neighbours swapped - the one with fewer unchanged elements moves: what you edited moved
    const paired = B.filter(y => xOf.has(y));
    const keep = keptInOrder(paired.map(y => idxA.get(xOf.get(y))), paired.map(y => flat(sa, xOf.get(y)) === flat(sb, y)), paired);
    const movedYs = new Set(paired.filter(y => !keep.has(y) && orderMatters(path, y.name)));

    // the parent's own opening lines
    const head = [lineOf(sa, a.start), openEnd(sa, a)], headB = [lineOf(sb, b.start), openEnd(sb, b)];
    pieces.push({ kind: slice('a', head).join('') === slice('b', headB).join('') ? 'same' : 'changed-own', left: slice('a', head), b0: headB[0], b1: headB[1], label: b.name });

    // what the target has and you do not, and what the feature added and you left out: each after the sibling it followed
    const after = new Map(), atStart = [];
    const anchorOf = (list, i, partner) => { for (let j = i - 1; j >= 0; j--) { const y = partner(list[j]); if (y) return y; } return null; };
    A.forEach((x, i) => { if (yOf.has(x)) return; const y = anchorOf(A, i, e => yOf.get(e)); const item = { kind: 'removed', el: x, side: 'a', r: range(sa, a, A, i), notInFeature: !!f && !xInF.has(x) }; if (y) (after.get(y) || after.set(y, []).get(y)).push(item); else atStart.push(item); });
    F.forEach((z, i) => { if (yOfZ.has(z) || zInA.has(z)) return; const y = anchorOf(F, i, e => yOfZ.get(e)); const item = { kind: 'dropped', el: z, side: 'f', r: range(sf, f, F, i) }; if (y) (after.get(y) || after.set(y, []).get(y)).push(item); else atStart.push(item); });
    const gone = (items, at) => {
      for (const it of items) {
        const left = slice(it.side, it.r);
        const n = left.filter(l => l.trim()).length;
        pieces.push({ kind: it.kind, left: it.kind === 'removed' ? left : [], ghost: left, b0: at, b1: at, notInFeature: it.notInFeature || undefined, label: nameOf(type, path, it.el) + (n > 1 ? ' (' + n + ' lines)' : ''),
          undo: [{ b0: at, b1: at, expect: [], insert: left.join('') }] });
      }
    };
    gone(atStart, headB[1]);

    B.forEach((y, i) => {
      const yr = range(sb, b, B, i), x = xOf.get(y), z = zOf.get(y);
      const yLines = slice('b', yr);
      if (movedYs.has(y)) {
        // where it was: straight after the sibling it followed in the target, which stayed put
        const xi = idxA.get(x);
        let to = null;
        for (let j = xi - 1; j >= 0 && to == null; j--) { const yy = yOf.get(A[j]); if (yy && keep.has(yy)) to = range(sb, b, B, idxB.get(yy))[1]; }
        for (let j = xi + 1; j < A.length && to == null; j++) { const yy = yOf.get(A[j]); if (yy && keep.has(yy)) to = range(sb, b, B, idxB.get(yy))[0]; }
        if (to == null) to = headB[1];
        const now = paired.indexOf(y) + 1, was = [...paired].sort((p, q) => idxA.get(xOf.get(p)) - idxA.get(xOf.get(q))).indexOf(y) + 1;
        moves.push({ b0: yr[0], b1: yr[1], label: nameOf(type, path, y), from: was, to: now, inside: flat(sa, x) !== flat(sb, y),
          undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: '' }, { b0: to, b1: to, expect: [], insert: yLines.join('') }] });
      }
      if (!x) {
        const kind = z && flat(sf, z) === flat(sb, y) ? 'feature' : 'own';
        const n = yLines.filter(l => l.trim()).length;
        pieces.push({ kind, left: [], b0: yr[0], b1: yr[1], label: nameOf(type, path, y) + (n > 1 ? ' (' + n + ' lines)' : ''), undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: '' }] });
      } else {
        const xr = range(sa, a, A, idxA.get(x));
        if (flat(sa, x) === flat(sb, y) && !sameLines(slice('a', xr), yLines)) {
          // the same element, with a comment or a blank line added or taken out around it: line by line
          lineRuns(slice('a', xr), yLines, yr[0], featureSet, pieces, null);
        } else if (flat(sa, x) === flat(sb, y)) {
          // the target's, unchanged by you - and what the feature branch did with it
          const n = yLines.filter(l => l.trim()).length;
          if (f && !z && !xInF.has(x) && orderMatters(path, y.name)) {
            pieces.push({ kind: 'kept', left: slice('a', xr), b0: yr[0], b1: yr[1], label: nameOf(type, path, y) + (n > 1 ? ' (' + n + ' lines)' : ''), undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: '' }] });
          } else if (!z || flat(sf, z) === flat(sb, y)) pieces.push({ kind: 'same', left: slice('a', xr), b0: yr[0], b1: yr[1] });
          else if (isLeaf(y) || isLeaf(z)) {
            const zl = slice('f', [lineOf(sf, z.start), lineOf(sf, z.end - 1) + 1]);
            const what = isLeaf(y) && isLeaf(z) ? XC.leafLabel(type, path, b, y) + ': ' + XC.clip(val(z)) + ' (here: ' + XC.clip(val(y)) + ')' : nameOf(type, path, y);
            pieces.push({ kind: 'differs', left: slice('a', xr), b0: yr[0], b1: yr[1], label: what, undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: zl.join('') }] });
          } else walk(x, y, z, path.concat(x.name));
        } else if (isLeaf(x) && isLeaf(y)) {
          const ta = val(x), tb = val(y);
          if (/\n/.test(ta) || /\n/.test(tb)) lineRuns(slice('a', xr), yLines, yr[0], new Set(z ? slice('f', [lineOf(sf, z.start), lineOf(sf, z.end - 1) + 1]).map(l => l.trim()) : []), pieces, 'in ' + y.name);
          else pieces.push({ kind: z && val(z) === tb ? 'changed-feature' : 'changed-own', left: slice('a', xr), b0: yr[0], b1: yr[1],
            label: XC.leafLabel(type, path, b, y) + ': ' + XC.clip(ta) + ' \u2192 ' + XC.clip(tb), undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: slice('a', xr).join('') }] });
        } else if (isLeaf(x) !== isLeaf(y)) {
          pieces.push({ kind: z && flat(sf, z) === flat(sb, y) ? 'changed-feature' : 'changed-own', left: slice('a', xr), b0: yr[0], b1: yr[1], label: nameOf(type, path, y),
            undo: [{ b0: yr[0], b1: yr[1], expect: strip(yLines), insert: slice('a', xr).join('') }] });
        } else walk(x, y, z || null, path.concat(x.name));
      }
      gone(after.get(y) || [], yr[1]);
    });

    // the parent's closing lines
    // after the last child: what is left before the end tag, and the end tag
    const tail = [lineOf(sa, A[A.length - 1].end - 1) + 1, lineOf(sa, a.end - 1) + 1], tailB = [lineOf(sb, B[B.length - 1].end - 1) + 1, lineOf(sb, b.end - 1) + 1];
    pieces.push({ kind: slice('a', tail).join('') === slice('b', tailB).join('') ? 'same' : 'changed-own', left: slice('a', tail), b0: tailB[0], b1: tailB[1] });
  }

  // what comes before and after the root - the XML declaration, a trailing newline
  const rootA = sa.doc.root, rootB = sb.doc.root;
  const preA = [0, lineOf(sa, rootA.start)], preB = [0, lineOf(sb, rootB.start)];
  if (preB[1] || preA[1]) pieces.push({ kind: slice('a', preA).join('') === slice('b', preB).join('') ? 'same' : 'changed-own', left: slice('a', preA), b0: 0, b1: preB[1] });
  walk(rootA, rootB, sf && sf.ok ? sf.doc.root : null, []);
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
    // neighbours of the same kind make one piece
    const last = out[out.length - 1];
    if (last && last.kind === 'same' && piece.kind === 'same') { last.left = last.left.concat(left); last.a1 = piece.a1; last.b1 = piece.b1; continue; }
    out.push(piece);
  }
  if (b !== sb.lines.length) ok = false;
  const counts = { feature: 0, own: 0, removed: 0, dropped: 0, kept: 0, differs: 0, moved: moves.length };
  for (const p of out) if (p.kind !== 'same') counts[p.kind === 'changed-feature' ? 'feature' : p.kind === 'changed-own' ? 'own' : p.kind]++;
  return { ok, mode, left: out.map(p => (p.left || []).join('')).join(''), pieces: out, moves, counts };
}

module.exports = { align };
