'use strict';

/**
 * The changes between two texts, line by line - how your resolution differs
 * from a branch, for the merge view to mark as you type.
 *
 *   changes(a, b, { maxEdits }) -> [{ id, aStart, aEnd, bStart, bEnd, removed: [lines], added: [lines], line, context }]
 *                                  or null when the texts differ in more than maxEdits lines
 *
 * Myers' O(ND) diff: quick when the texts are mostly the same, as a merge
 * and its target are; the limit keeps a file that differs a great deal from
 * holding up the editor. Added or removed runs are split per element, so each
 * element is its own change. Lines keep their own endings. Plain Node.js.
 */
const split = t => { const s = String(t); return s ? s.split(/(?<=\n)/) : []; };

/** The edit script: for each line of a and b, whether it is shared. */
function diff(a, b, maxEdits) {
  const n = a.length, m = b.length, max = Math.min(n + m, maxEdits == null ? Infinity : maxEdits);
  const v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) || 0) < (v.get(k + 1) || 0))) ? (v.get(k + 1) || 0) : (v.get(k - 1) || 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return null;   // more than maxEdits apart
}

function backtrack(trace, a, b, dEnd) {
  const pairs = [];   // [x, y] of shared lines, from the end
  let x = a.length, y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && (v.get(k - 1) || 0) < (v.get(k + 1) || 0))) ? k + 1 : k - 1;
    const prevX = v.get(prevK) || 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; pairs.push([x, y]); }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; pairs.push([x, y]); }
  return pairs.reverse();
}

/** The nearest element that opens before a line, less indented than it - where a change sits. */
function contextOf(lines, at, indent) {
  const here = indent != null ? indent : (lines[at] || lines[at - 1] || '').match(/^\s*/)[0].length;
  for (let i = Math.min(at, lines.length) - 1; i >= 0; i--) {
    const m = /^(\s*)<([A-Za-z_][\w.-]*)[\s>]/.exec(lines[i]);
    if (m && m[1].length < here && !/<\/\w/.test(lines[i])) return m[2];
  }
  return null;
}

/** Net elements a line opens: <a> +1, </a> -1, <a>x</a> and <a/> 0. */
const depthOf = l => (String(l).match(/<[A-Za-z_][^>]*?(?<!\/)>/g) || []).length - (String(l).match(/<\/[A-Za-z_][^>]*>/g) || []).length;

/** Lines grouped into whole elements: each group opens and closes what it starts. */
function elements(lines) {
  const groups = [];
  let cur = [], depth = 0;
  for (const l of lines) {
    cur.push(l);
    depth += depthOf(l);
    if (depth <= 0) { groups.push(cur); cur = []; depth = 0; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function changes(aText, bText, opts) {
  const a = split(aText), b = split(bText);
  const shared = diff(a, b, opts && opts.maxEdits);
  if (!shared) return null;
  const out = [];
  let ai = 0, bi = 0;
  const one = (aS, aE, bS, bE) => out.push({ id: out.length, aStart: aS, aEnd: aE, bStart: bS, bEnd: bE, removed: a.slice(aS, aE).map(l => l.replace(/\r?\n$/, '')),
    added: b.slice(bS, bE).map(l => l.replace(/\r?\n$/, '')), line: aS + 1,
    // where it sits: by the changed lines' own indentation, so an element added at the end still has its parent
    context: contextOf(a, aS, ((a.slice(aS, aE).concat(b.slice(bS, bE)).find(l => l.trim()) || '').match(/^\s*/) || [''])[0].length) });
  const push = (aEnd, bEnd) => {
    if (aEnd === ai && bEnd === bi) return;
    // only added, or only removed: one choice per whole element, so each can be kept or left out on its own
    if (aEnd === ai || bEnd === bi) {
      const added = aEnd === ai;
      let at = added ? bi : ai;
      for (const g of elements(added ? b.slice(bi, bEnd) : a.slice(ai, aEnd))) {
        if (added) one(ai, ai, at, at + g.length); else one(at, at + g.length, bi, bi);
        at += g.length;
      }
      return;
    }
    // changed: elements paired by tag, in order (a longest common run of tags), so a change next to an
    // added or removed element still pairs with its own counterpart; the rest are adds and removes
    const ra = elements(a.slice(ai, aEnd)), rb = elements(b.slice(bi, bEnd));
    const tag = g => ((/<([A-Za-z_][\w.-]*)/.exec(g.join('')) || [])[1]) || null;
    if (ra.length === 1 && rb.length === 1) { one(ai, aEnd, bi, bEnd); return; }
    const n = ra.length, m = rb.length, L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) L[x][y] = tag(ra[x]) && tag(ra[x]) === tag(rb[y]) ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
    let x = 0, y = 0, ap = ai, bp = bi;
    while (x < n || y < m) {
      if (x < n && y < m && tag(ra[x]) && tag(ra[x]) === tag(rb[y]) && L[x][y] === L[x + 1][y + 1] + 1) { one(ap, ap + ra[x].length, bp, bp + rb[y].length); ap += ra[x].length; bp += rb[y].length; x++; y++; }
      else if (x < n && (y >= m || L[x + 1][y] >= L[x][y + 1])) { one(ap, ap + ra[x].length, bp, bp); ap += ra[x].length; x++; }
      else { one(ap, ap, bp, bp + rb[y].length); bp += rb[y].length; y++; }
    }
  };
  for (const [x, y] of shared) { push(x, y); ai = x + 1; bi = y + 1; }
  push(a.length, b.length);
  return out;
}


module.exports = { changes };
