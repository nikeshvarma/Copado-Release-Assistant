'use strict';

/**
 * The merge editor: a panel of the extension's own, in place of VS Code's
 * diff view. The target on the left, read-only and written in your order;
 * your resolution on the right, in a real editor (Monaco, the editor VS Code
 * is built on, shipped inside the extension); the two lined up piece by
 * piece (src/mergeAlign.js). What you type comes back here to be compared
 * again; saving goes through the caller's own save, so the checks before
 * applying are the same as ever.
 *
 *   open(vscode, extensionUri, {
 *     file, labels: { target, merged }, theirs, short, typeName,
 *     target, incoming, text,             // the target and the feature (formatted), your resolution
 *     savedText,                          // what is saved as your resolution, if anything
 *     applyOnly,                          // a plain merge: applied into the target once, not saved as you go
 *     start                                // where your resolution started
 *     hideIdentical, onPref(prefs)        // identical lines folded away; the choice, remembered
 *     conflictsFor(text),                 // what both branches changed, found in this text
 *     onText(text), save(text, close) -> { ok, message, warn }, discard(), onClose()
 *   }) -> { panel, reveal(line), apply(undo), dispose() }
 */
const { align, lineDiff } = require('./mergeAlign');
const MD = require('./mergeDuplicates');

const nonceOf = () => { let s = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };
const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The page. Scripts only from the extension's own folder, and the two of its own by nonce. */
function html(webview, media) {
  const nonce = nonceOf();
  const u = p => webview.asWebviewUri(media(p)).toString();
  const csp = webview.cspSource;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' + csp + ' data:; font-src ' + csp + ' data:; style-src ' + csp + ' \'unsafe-inline\'; script-src ' + csp + ' \'nonce-' + nonce + '\';">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="' + attr(u('merge.css')) + '"></head>' +
    '<body data-vs="' + attr(u('monaco/vs')) + '">' +
    '<div class="top"><span class="title" id="title"></span><span class="chips" id="chips"></span><span class="sp"></span>' +
    '<span class="navg"><button id="prev" title="Previous change (Shift+F7)" aria-label="Previous change"></button><span id="pos" aria-live="polite"></span><button id="next" title="Next change (F7)" aria-label="Next change"></button></span>' +
    '<span class="mwrap"><button id="viewBtn" class="tb" aria-haspopup="menu" aria-expanded="false" title="Start from, hide identical lines, the target\u2019s order"></button><div id="viewMenu" class="dmenu right" role="menu" hidden></div></span>' +
    '<button id="saveClose" class="pri" title="Save as your resolution and close \u2013 Ctrl+S saves and keeps it open">Save &amp; Close</button>' +
    '<span class="mwrap"><button id="moreBtn" class="tb ic" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More"></button><div id="moreMenu" class="dmenu right" role="menu" hidden></div></span></div>' +
    '<div id="help" hidden role="dialog" aria-label="Keyboard shortcuts"></div>' +
    '<div id="menu" hidden role="menu"></div>' +
    '<div class="heads"><div id="lefthead"></div><div></div><div id="righthead"></div><div class="g2"></div><div id="feathead"></div></div>' +
    '<div class="panes"><div id="left"></div><div id="gap"></div><div id="right"></div><div id="gap2"></div><div id="feat"></div></div>' +
    '<div class="status" role="status"><span id="stSaved"></span><span id="stMarks"></span><span id="stDups"></span><span id="note"></span><span class="sp"></span><span class="hints">F7 next change \u00b7 F8 next problem \u00b7 Ctrl+S save</span></div>' +
    '<script nonce="' + nonce + '" src="' + attr(u('monaco/vs/loader.js')) + '"></script>' +
    '<script nonce="' + nonce + '" src="' + attr(u('merge.js')) + '"></script></body></html>';
}

/** The pieces, without what the page does not need: the left pane's lines come once, as its text. */
/** Ordering and de-duplicating are for files whose entries add up - permission sets, profiles, labels, translations - never a layout's or a page's, whose order is what users see. */
function tidy(o) { return !o.language && require('./mergeStart').ADDITIVE.has(o.typeName); }

/**
 * Three panels, Copado's own: where the promotion branch's side, your resolution and the feature branch's side differ.
 * Each side is lined up with the resolution; where all three have the same line they run level, and between two such
 * lines is one place they differ: [{ l0, l1, r0, r1, f0, f1 }] - the promotion's lines, yours, the feature's.
 */
/**
 * Two texts compared line by line, as lineDiff does - but for a large file anchored first on the lines each has
 * exactly once (in a permission set, nearly every <field> and <apexClass>), the longest run of them in order, then
 * only the stretches between compared: the same answer in little memory, where comparing 60,000 lines at once
 * runs out of it. Small texts: lineDiff as it is.
 */
const onceOf = new WeakMap();
const linesMemo = new Map();
/** A text's lines - the same text, the same array, so what is worked out from it is kept (the two sides never change). */
function linesOf(t) {
  const k = String(t == null ? '' : t);
  let v = linesMemo.get(k);
  if (!v) { v = k.split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1); if (linesMemo.size > 6) linesMemo.delete(linesMemo.keys().next().value); linesMemo.set(k, v); }
  return v;
}
function linesApart(A, B) {
  if (A.length + B.length < 4000) return lineDiff(A, B, 0);
  const once = X => { let m = onceOf.get(X); if (m) return m; m = new Map(); X.forEach((l, i) => { const e = m.get(l); if (e) e.n++; else m.set(l, { n: 1, i }); }); onceOf.set(X, m); return m; };
  const ca = once(A), cb = once(B), pairs = [];
  for (const [l, ea] of ca) { if (ea.n !== 1) continue; const eb = cb.get(l); if (eb && eb.n === 1) pairs.push([ea.i, eb.i]); }
  pairs.sort((x, y) => x[0] - y[0]);
  // the longest run of them in the same order on both sides
  const tails = [], prev = new Array(pairs.length);
  pairs.forEach((p, k) => { let lo = 0, hi = tails.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < p[1]) lo = mid + 1; else hi = mid; } prev[k] = lo ? tails[lo - 1] : -1; tails[lo] = k; });
  const anchors = []; for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) anchors.unshift(pairs[k]);
  const out = [];
  let a = 0, b = 0;
  // a stretch between anchors: compared line by line when small; when either side is large - lineDiff's memory grows
  // with the square of the larger side - what both start and end with kept, the rest one changed piece: exact where a
  // side is empty
  const stretch = (a1, b1) => {
    if (a1 <= a && b1 <= b) return;
    if (Math.max(a1 - a, b1 - b) <= 1500) { for (const p of lineDiff(A.slice(a, a1), B.slice(b, b1), 0)) out.push(Object.assign({}, p, { b0: b + p.b0, b1: b + p.b1 })); return; }
    let x0 = a, y0 = b, x1 = a1, y1 = b1;
    while (x0 < x1 && y0 < y1 && A[x0] === B[y0]) { out.push({ kind: 'same', left: [A[x0]], b0: y0, b1: y0 + 1 }); x0++; y0++; }
    const tail = []; while (x1 > x0 && y1 > y0 && A[x1 - 1] === B[y1 - 1]) { x1--; y1--; tail.unshift({ kind: 'same', left: [A[x1]], b0: y1, b1: y1 + 1 }); }
    if (x1 > x0 || y1 > y0) out.push({ kind: x1 === x0 ? 'own' : y1 === y0 ? 'removed' : 'changed-own', left: A.slice(x0, x1), b0: y0, b1: y1, label: null, context: null });
    out.push(...tail);
  };
  for (const [x, y] of anchors) { stretch(x, y); out.push({ kind: 'same', left: [A[x]], b0: y, b1: y + 1 }); a = x + 1; b = y + 1; }
  stretch(A.length, B.length);
  // one piece for each unchanged stretch, not one for each of its lines: what draws and folds them walks far fewer
  const merged = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && last.kind === 'same' && p.kind === 'same' && last.b1 === p.b0) { for (const l of p.left) last.left.push(l); last.b1 = p.b1; } else merged.push(Object.assign({}, p, { left: p.left ? p.left.slice() : p.left }));
  }
  return merged;
}

/**
 * B2.11: each copy the union step took out - the target's lines t0..t1 - where it would be in your resolution: the
 * place its piece of the target's lines sits; none where you kept it (its lines there again). -> [{ b0, t0, t1, ghost }]
 */
function dupRowsOf(o, text, pieces) {
  if (!o.dupRemovedAt || !o.dupRemovedAt.length) return [];
  const TL = linesOf(o.target), RL = linesOf(text), out = [];
  pieces = pieces || piecesApart(o.target, text);
  const placeOf = t0 => { const p = pieces.find(x => x.a0 <= t0 && t0 < Math.max(x.a1, x.a0 + 1)); return !p ? RL.length : p.kind === 'same' ? p.b0 + (t0 - p.a0) : p.b0; };
  o.dupRemovedAt.forEach(([t0, t1], i) => {
    const ghost = TL.slice(t0, t1), b0 = placeOf(t0);
    // kept: its lines are at its place again (Keep) - otherwise still taken out
    if (ghost.every((l, k) => RL[b0 + k] === l)) return;
    const info = o.dupRemovedInfo && o.dupRemovedInfo[i];
    const row = { b0, t0, t1, ghost };
    // B2.12: the copy granting more kept - the other swapped in instead, while the kept one is still as it was
    if (info) {
      // the copy kept is the only one of its entry left: found by its own lines - near where it was, else anywhere
      const kept = TL.slice(info.kept[0], info.kept[1]), hint = placeOf(info.kept[0]);
      const at = k => kept.every((l, j) => RL[k + j] === l);
      let k0 = -1;
      for (let d = 0; d < 40 && k0 < 0; d++) { if (at(hint + d)) k0 = hint + d; else if (d && hint - d >= 0 && at(hint - d)) k0 = hint - d; }
      for (let k = 0; k0 < 0 && k < RL.length; k++) if (RL[k] === kept[0] && at(k)) k0 = k;
      row.kept = true; row.label = info.label;
      if (k0 >= 0) row.swap = [{ b0: k0, b1: k0 + kept.length, insert: ghost.join(''), expect: kept.map(l => l.replace(/\r?\n$/, '')) }];
      else if (RL.some((l, k) => l === ghost[0] && ghost.every((g, j) => RL[k + j] === g))) return;   // swapped already: the other is in
    }
    out.push(row);
  });
  return out;
}

/** The promotion side and yours, as the page's pieces - [{ kind, a0, a1, b0, b1 }]. */
function piecesApart(left, text) {
  let a = 0;
  return linesApart(linesOf(left), linesOf(text)).map(p => { const n = (p.left || []).length, x = Object.assign({}, p, { a0: a, a1: a + n, left: undefined, ghost: p.kind === 'removed' ? p.left : undefined }); a += n; return x; });
}

function threeWay(left, text, feature, leftPieces) {
  const R = linesOf(text);
  const mapOf = (side, given) => {
    const A = linesOf(side), m = new Array(R.length + 1).fill(-1);
    if (given) { for (const p of given) if (p.kind === 'same') for (let k = 0; k < p.b1 - p.b0; k++) m[p.b0 + k] = p.a0 + k; }
    else { let a = 0; for (const p of linesApart(A, R)) { if (p.kind === 'same') for (let k = 0; k < p.b1 - p.b0; k++) m[p.b0 + k] = a + k; a += (p.left || []).length; } }
    m[R.length] = A.length;
    return m;
  };
  const mL = mapOf(left, leftPieces), mF = mapOf(feature), out = [];
  let l = 0, f = 0, r = 0;
  while (r < R.length || l < mL[R.length] || f < mF[R.length]) {
    if (r < R.length && mL[r] === l && mF[r] === f) { r++; l++; f++; continue; }
    let e = r; while (e < R.length && !(mL[e] >= l && mF[e] >= f)) e++;
    if (mL[e] > l || e > r || mF[e] > f) out.push({ l0: l, l1: mL[e], r0: r, r1: e, f0: f, f1: mF[e] });
    l = mL[e]; f = mF[e]; r = e;
    if (e === R.length) break;
  }
  return out;
}

/**
 * A promotion's file lined up from its conflicts, not by comparing every line: outside them the promotion branch's side,
 * the feature branch's side and your resolution are git's merge, line for line - so each conflict's place on each side
 * follows from the ones before it, and only a stretch you edited is compared, that stretch alone. Exact, and fast on a
 * file of 30,000 lines. Null when the conflicts cannot all be found: then every line is compared, as before.
 *   -> { pieces: [{ kind, a0, a1, b0, b1 }] (the promotion side and yours), segs: [{ l0, l1, r0, r1, f0, f1 }] (all three) }
 */
function fromConflicts(o, text, rows) {
  const sp = t => String(t == null ? '' : t).split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1);
  const Ls = sp(o.target), Rs = sp(text), Fs = sp(o.incoming), cs = (o.code && o.code.conflicts) || [];
  if (!cs.length || rows.length !== cs.length || cs.some(c => c.at == null)) return null;
  const pieces = [], segs = [];
  let l = 0, r = 0, f = 0, g = 0;
  // a stretch between conflicts: the same on all three, or - where you edited it - compared, that stretch alone
  const between = (l1, r1, f1) => {
    const A = Ls.slice(l, l1), B = Rs.slice(r, r1), C = Fs.slice(f, f1);
    const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
    if (same(A, B) && same(A, C)) { if (B.length) pieces.push({ kind: 'same', a0: l, a1: l1, b0: r, b1: r1 }); return; }
    let a = l;
    for (const p of linesApart(A, B)) { const n = (p.left || []).length; pieces.push(Object.assign({}, p, { a0: a, a1: a + n, b0: r + p.b0, b1: r + p.b1, left: undefined })); a += n; }
    for (const x of threeWay(A.join(''), B.join(''), C.join(''))) segs.push({ l0: l + x.l0, l1: l + x.l1, r0: r + x.r0, r1: r + x.r1, f0: f + x.f0, f1: f + x.f1 });
  };
  for (let k = 0; k < cs.length; k++) {
    const c = cs[k], w = rows.find(x => x.id === c.id);
    if (!w) return null;
    const gap = c.at - g, nT = sp(c.target).length, nF = sp(c.feature).length;
    // where it is on each side: git's text since the last one, then the conflict's own lines
    const l0 = l + gap, f0 = f + gap, r0 = w.b0, r1 = w.b1;
    if (l0 + nT > Ls.length || f0 + nF > Fs.length || r0 < r) return null;
    between(l0, r0, f0);
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const A = Ls.slice(l0, l0 + nT), B = Rs.slice(r0, r1), C = Fs.slice(f0, f0 + nF);
    if (!(same(A, B) && same(A, C))) segs.push({ l0, l1: l0 + nT, r0, r1, f0, f1: f0 + nF });
    if (!same(A, B)) pieces.push({ kind: B.length ? (A.length ? 'changed-own' : 'own') : 'removed', a0: l0, a1: l0 + nT, b0: r0, b1: r1 });
    else if (B.length) pieces.push({ kind: 'same', a0: l0, a1: l0 + nT, b0: r0, b1: r1 });
    l = l0 + nT; f = f0 + nF; r = r1; g = c.at;
  }
  between(Ls.length, Rs.length, Fs.length);
  return { pieces, segs };
}

/**
 * Marks as the page gets them. A promotion's file can be 60,000 lines with conflicts of 18,000: every row carried its
 * versions' text three ways - what each button inserts, what is shown under it, what it checks before acting - and every
 * update carried both sides' text again: megabytes for each change. So the sides go in the first message only, each
 * conflict's two versions once in a table, and a row names its conflict and version; what it checks before acting is
 * its lines' count, first and last. The page puts the rows back together from the table.
 */
function forPage(m, first, o) {
  if (!m || !m.git) return m;
  // C5: tracked - the ranges were the editor's; otherwise found, for the editor to track from here
  const out = Object.assign({}, m, { tracked: !!(o && o.regions) });
  // what a conflict offers: a union type's choice never both (B2.7); one that did not join never the feature's (B2.14);
  // every other metadata's never both - both versions of an element are rarely valid (B3.1) - unless the two stories
  // each added an entry of their own at that place: then both keeps the two (B3.6)
  const leaveOf = r => o && o.unionKind === 'narrowed' ? 'both' : o && o.unionKind === 'fallback' ? 'feature' : o && o.git && !o.language && !r.bothOk ? 'both' : null;
  if (!first) { delete out.left; delete out.feat; }
  out.rows = (m.rows || []).map(r => { const leave = leaveOf(r); return Object.assign({}, r, {
    actions: r.actions.filter(a => a.choice !== leave).map(a => ({ label: a.label, choice: a.choice, op: { b0: a.op.b0, b1: a.op.b1, n: a.op.expect.length, head: a.op.expect[0], tail: a.op.expect[a.op.expect.length - 1] } })),
    ghosts: r.ghosts.map(g => ({ at: g.at, cls: g.cls, title: g.title, removes: g.removes, of: g.cls === 'struck' ? (r.chosen === 'target' ? 'feature' : 'target') : g.title === 'Target' ? 'target' : 'feature' }))
  }); });
  return out;
}
// each conflict's versions once - and what Accept both puts in, when that is not the two one after the other (B3.6)
const versionsOf = o => (o.git || o.language) && o.code ? Object.fromEntries((o.code.conflicts || []).map(c => [c.id, Object.assign({ target: c.target, feature: c.feature }, c.both != null ? { both: c.both } : {})])) : null;

/** Metadata that does not parse, once its conflicts are resolved: where it breaks. */
function xmlProblems(text) {
  const d = require('./xmlParser').parse(String(text));
  return (d.errors || []).slice(0, 20).map(e => { const before = String(text).slice(0, e.offset).split('\n'); return { line: before.length, column: before[before.length - 1].length + 1, severity: 'error', message: e.message }; });
}

function marksFor(o, text, mode) {
  // Manual and Compare: two versions compared line by line, nothing merged - both sides yours to edit, format, sort
  if (o.plain) {
    // two large files - permission sets of 60,000 lines - anchored first, as a promotion's are: in little memory
    const big = String(o.target || '').length + String(text || '').length > 400000;
    const r = big ? (() => { const sp = t => String(t == null ? '' : t).split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1); let a = 0;
      return { left: o.target, pieces: linesApart(sp(o.target), sp(text)).map(p => { const n = (p.left || []).length, x = Object.assign({}, p, { a0: a, a1: a + n }); a += n; return x; }) }; })()
      : align(o.target, null, text, { type: null, mode: 'literal' });
    const pieces = r.pieces.map(p => ({ kind: p.kind, a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, label: p.label, ghost: p.ghost || p.left }));
    return { plain: true, code: !!o.language, single: false, left: r.left, mode: 'literal', moves: [], rows: [], pieces,
      counts: { differs: pieces.filter(p => p.kind !== 'same' && p.kind !== 'blank').length }, dups: !o.language && tidy(o) ? MD.inText(text) : [],
      problems: o.language ? require('./codeChecks').problems(text, o.language) : [] };
  }
  // a promotion's code - and its metadata: Copado's conflict file, only its conflicts marked, none decided for you
  if (o.language || o.git) {
    const c = o.code || { conflicts: [] };
    const k = require('./codeMerge').marks({ text, conflicts: c.conflicts, language: o.language, reviewed: c.reviewed, regions: o.regions || null, typeName: o.typeName });
    // two panes, if chosen: the target beside your resolution line by line - the conflicts still choices, over it
    // three panels - Copado's: both branches' sides beside your resolution
    if (o.codeView === 'threePanes') {
      const fast = o.unionKind ? null : fromConflicts(o, text, k.rows);
      const lp = o.unionKind ? piecesApart(o.target, text) : null;
      const segs3 = fast ? fast.segs : threeWay(o.target, text, o.incoming, lp);
      return { code: true, git: true, three: true, single: false, left: o.target, feat: o.incoming, segs: segs3, dupRows: dupRowsOf(o, text, lp), counts: k.counts, rows: k.rows, moves: [], dups: [], pieces: [],
        problems: k.counts.needs ? [] : o.language ? require('./codeChecks').problems(text, o.language) : xmlProblems(text) };
    }
    if (o.codeView === 'twoPanes') {
      const fast = o.unionKind ? { pieces: piecesApart(o.target, text) } : fromConflicts(o, text, k.rows);
      const lp2 = o.unionKind ? fast.pieces : null;
      const r = fast ? { left: o.target, counts: {}, pieces: fast.pieces } : align(o.target, o.incoming, text, { type: null, mode: 'literal' });
      // the counts are the merge's - its members - whichever layout shows them
      return { code: true, git: true, single: false, left: r.left, mode: 'literal', counts: k.counts, rows: k.rows, moves: [], dups: [], dupRows: dupRowsOf(o, text, lp2),
        pieces: r.pieces.map(p => ({ kind: p.kind, a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, label: p.label, undo: p.kind === 'same' ? undefined : p.undo, ghost: p.ghost, notInFeature: p.notInFeature,
 })),
        problems: k.counts.needs ? [] : o.language ? require('./codeChecks').problems(text, o.language) : xmlProblems(text) };
    }
    return { code: true, git: true, single: true, left: '', mode: 'code', counts: k.counts, rows: k.rows, moves: [], dups: [], dupRows: dupRowsOf(o, text), pieces: [], problems: k.counts.needs ? [] : require('./codeChecks').problems(text, o.language) };
  }
  const r = align(o.target, o.incoming, text, { type: o.typeName, mode, ancestor: o.ancestor || null });
  if (r.hold) return Object.assign(r, { xmlError: xmlError(text) });
  const removed = o.removedDups || new Set();
  return {
    left: r.left, mode: r.mode, counts: r.counts, moves: r.moves,
    // duplicates in your resolution as it is - one you add is marked as you type
    dups: MD.inText(text),
    pieces: r.pieces.map(p => ({ kind: p.kind, a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, label: p.label, context: p.context, undo: p.kind === 'same' ? undefined : p.undo, ghost: p.ghost, notInFeature: p.notInFeature, byFeature: p.byFeature, now: p.now, was: p.was,
      dupRemoved: p.kind === 'removed' && removed.size && p.ghost ? removed.has(MD.flat(p.ghost.join(''))) || undefined : undefined }))
  };
}

/** Where your resolution stops being XML: { line, column, message }, 1-based - for the editor to underline. */
function xmlError(text) {
  const X = require('./xmlParser');
  const d = X.parse(String(text));
  const e = (d.errors || [])[0];
  if (!e) return d.root ? null : { line: 1, column: 1, message: String(text).trim() ? 'No root element' : 'The file is empty' };
  const starts = X.lineStarts(String(text));
  const off = e.offset != null ? e.offset : e.start != null ? e.start : 0;
  const line = X.lineAt(starts, off);
  return { line: line + 1, column: off - starts[line] + 1, message: String(e.message || e) };
}

function open(vscode, extensionUri, o) {
  const media = p => vscode.Uri.joinPath(extensionUri, 'media', ...p.split('/'));
  // a comparison is called one - it merges nothing
  const title = (o.plain ? 'Compare' : 'Merge') + ' \u00b7 ' + o.file;
  const panel = vscode.window.createWebviewPanel('cmrMergeEditor', title, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
  });
  panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'merge.svg');
  let mode = 'order', text = o.text, disposed = false;
  const post = m => { if (!disposed) panel.webview.postMessage(m); };
  panel.webview.html = html(panel.webview, media);
  panel.webview.onDidReceiveMessage(async m => {
    try {
      if (m.type === 'ready') {
        post({ type: 'init', title, file: o.file, applyOnly: !!o.applyOnly, labels: o.labels, theirs: o.theirs, short: o.short, mode, text, savedText: o.savedText != null ? o.savedText : null,
          start: o.start || null, hideIdentical: !!o.hideIdentical, dupRemoved: o.dupRemoved || null, manual: !!o.manual, plain: !!o.plain, tidy: tidy(o), gitLabels: o.gitLabels || null, unionKind: o.unionKind || null, ancestor: !!o.ancestor, language: o.language || 'xml',
          marks: forPage(marksFor(o, text, mode), true, o), versions: versionsOf(o), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'codeView') {
        if ('regions' in m) o.regions = m.regions || null;
        // one pane or two, for code: remembered - it is the setting
        o.codeView = ['onePane', 'twoPanes', 'threePanes'].includes(m.view) ? m.view : 'threePanes';
        if (o.setCodeView) o.setCodeView(o.codeView);
        if (typeof m.text === 'string') text = m.text;
        post({ type: 'marks', seq: m.seq, marks: forPage(marksFor(o, text, mode), m.type === 'codeView', o), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'review') {
        if ('regions' in m) o.regions = m.regions || null;
        // a code conflict's empty version accepted: nothing in the text says so - remembered
        if (o.code) { o.code.reviewed = o.code.reviewed || new Map(); o.code.reviewed.set(String(m.id), String(m.choice || 'feature')); }
        text = typeof m.text === 'string' ? m.text : text;
        post({ type: 'marks', seq: m.seq, marks: forPage(marksFor(o, text, mode), m.type === 'codeView', o), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'text' && m.side === 'left') {
        // a comparison's other side, edited: compared again
        o.target = String(m.text);
        post({ type: 'marks', seq: m.seq, mode, marks: forPage(marksFor(o, text, mode), false, o), conflicts: [] });
      } else if (m.type === 'text') {
        text = String(m.text);
        if ('regions' in m) o.regions = m.regions || null;
        if (o.onText) o.onText(text, o.regions);
        const marks = marksFor(o, text, mode);
        post(marks.hold ? { type: 'marks', seq: m.seq, hold: true, xmlError: marks.xmlError } : { type: 'marks', seq: m.seq, mode, marks: forPage(marks, false, o), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'save') {
        if ('regions' in m) o.regions = m.regions || null;
        text = String(m.text);
        if (o.onText) o.onText(text, o.regions);
        const r = (await o.save(text, !!m.close)) || { ok: false, message: 'Not saved.' };
        // what was saved - the conflicts left kept as the target's, when you chose that (A6)
        if (r.text != null) text = String(r.text);
        post({ type: 'saved', ok: !!r.ok, warn: !!r.warn, message: r.message || '', text });
      } else if (m.type === 'clipboard') {
        // VS Code's clipboard: what you copy here pastes anywhere, and the other way round
        await vscode.env.clipboard.writeText(String(m.text));
      } else if (m.type === 'paste') {
        post({ type: 'pasted', id: m.id, text: await vscode.env.clipboard.readText() });
      } else if (m.type === 'dedupe') {
        const r = o.dedupe ? await o.dedupe(String(m.text)) : { error: 'Removing duplicates is not available here' };
        post(Object.assign({ type: 'formatted', seq: m.seq, side: m.side || 'right' }, r));
      } else if (m.type === 'format') {
        const r = o.format ? o.format(String(m.text)) : { error: 'Formatting is not available here' };
        post(Object.assign({ type: 'formatted', seq: m.seq, side: m.side || 'right' }, r));
      } else if (m.type === 'diagnostics') {
        const r = o.diagnostics ? await o.diagnostics(String(m.text)) : null;
        if (r && r.message) post({ type: 'saved', ok: !!r.ok, message: r.message, text });
      } else if (m.type === 'report') {
        // the \u22ef menu's report
        if (m.text != null) { text = String(m.text); if (o.onText) o.onText(text); }
        const r = o.report ? await o.report(text) : null;
        if (r && r.message) post({ type: 'saved', ok: !!r.ok, message: r.message, text });
      } else if (m.type === 'discard') {
        if (o.discard) await o.discard();
      } else if (m.type === 'pref') {
        // remembered for the next merge (cmr.merge.hideIdentical)
        if (o.onPref) await o.onPref({ hideIdentical: !!m.hideIdentical });
      } else if (m.type === 'dirty') {
        panel.title = (m.dirty ? '\u25cf ' : '') + title;
        if (o.onDirty) o.onDirty(!!m.dirty);
      }
    } catch (e) {
      post({ type: 'saved', ok: false, message: 'Something went wrong: ' + ((e && e.message) || e) });
    }
  });
  panel.onDidDispose(() => { disposed = true; if (o.onClose) o.onClose(); });
  return {
    panel,
    get text() { return text; },
    reveal: line => { panel.reveal(); post({ type: 'reveal', line }); },
    apply: undo => { panel.reveal(); post({ type: 'apply', undo }); },
    dispose: () => { if (!disposed) panel.dispose(); }
  };
}

module.exports = { open, html, marksFor, forPage, versionsOf, fromConflicts, threeWay, linesApart };
