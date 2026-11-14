'use strict';

/**
 * Your resolution, marked against both branches as you type:
 *
 *   feature         lines the feature branch has and the target does not (green)
 *   own             lines in neither branch - your own edit (blue)
 *   removed         target lines your resolution no longer has (red, where they were)
 *   dropped         feature lines your resolution left out (red, where they would go)
 *   changed-feature target lines replaced by the feature's
 *   changed-own     target lines replaced by your own
 *
 * Each change carries its undo - { bStart, bEnd, expect, insert }: the lines
 * of your resolution it covers, what they must still be, and what goes back in
 * their place - so every action (Restore, Undo, Use target, Add it back) is the
 * same safe edit. Both branches are compared written the same way as your
 * resolution (the merge view's normalised files), so formatting is never a
 * change. Plain Node.js.
 */
const D = require('./linediff');
const XC = require('./xmlCompare');

// the comparison's work grows with file size times differences: kept to about a few tenths of a second
const BUDGET = 2e7, MAX_EDITS = 1500;
const count = t => (String(t).match(/\n/g) || []).length + 1;
const split = t => { const s = String(t); return s ? s.split(/(?<=\n)/) : []; };

/**
 * XML is compared element by element (src/xmlCompare.js); while your
 * resolution is not valid XML the result is { hold: true } and the marks keep
 * their last good state. Anything else - or XML a branch does not parse as -
 * is compared line by line.
 */
function mark(targetText, incomingText, mergedText, opts) {
  if (!opts || opts.xml !== false) {
    const byElement = XC.compare(targetText, incomingText, mergedText, { type: opts && opts.type });
    if (byElement) return byElement;
  }
  return byLines(targetText, incomingText, mergedText);
}

function byLines(targetText, incomingText, mergedText) {
  const maxEdits = Math.max(50, Math.min(MAX_EDITS, Math.floor(BUDGET / (count(targetText) + count(mergedText)))));
  const list = D.changes(targetText, mergedText, { maxEdits });
  if (!list) return { list: [], counts: {}, tooMany: true };
  const T = split(targetText), F = split(incomingText);
  const inTarget = new Set(T.map(l => l.trim()).filter(Boolean));
  const inFeature = new Set(F.map(l => l.trim()).filter(Boolean));
  const allIn = (set, ls) => ls.filter(l => l.trim()).every(l => set.has(l.trim()));
  const out = [];
  const push = (c, kind, insert) => out.push(Object.assign({}, c, { kind, undo: { bStart: c.bStart, bEnd: c.bEnd, expect: c.added, insert } }));
  const fromTarget = c => T.slice(c.aStart, c.aEnd).join('');
  for (const c of list) {
    if (!c.added.length) { push(c, 'removed', fromTarget(c)); continue; }
    if (!c.removed.length) { push(c, allIn(inFeature, c.added) ? 'feature' : 'own', ''); continue; }
    // both still in the feature branch: two different elements side by side - one removed, one added - not one changed
    if (allIn(inFeature, c.removed) && allIn(inFeature, c.added)) {
      push(Object.assign({}, c, { added: [], bEnd: c.bStart }), 'removed', fromTarget(c));
      push(Object.assign({}, c, { removed: [], aStart: c.aEnd }), 'feature', '');
      continue;
    }
    push(c, allIn(inFeature, c.added) ? 'changed-feature' : 'changed-own', fromTarget(c));
  }
  // what the feature branch has that your resolution left out (lines the target never had)
  const vsFeature = D.changes(incomingText, mergedText, { maxEdits }) || [];
  for (const c of vsFeature) {
    if (c.added.length || !c.removed.some(l => l.trim() && !inTarget.has(l.trim()))) continue;
    out.push(Object.assign({}, c, { kind: 'dropped', bEnd: c.bStart, undo: { bStart: c.bStart, bEnd: c.bStart, expect: [], insert: F.slice(c.aStart, c.aEnd).join('') } }));
  }
  const rank = k => k === 'removed' ? 0 : k === 'dropped' ? 1 : 2;
  out.sort((a, b) => a.bStart - b.bStart || rank(a.kind) - rank(b.kind) || a.aStart - b.aStart);
  out.forEach((c, i) => { c.id = i; });
  const counts = { feature: 0, own: 0, removed: 0, dropped: 0 };
  for (const c of out) counts[c.kind === 'changed-feature' ? 'feature' : c.kind === 'changed-own' ? 'own' : c.kind]++;
  return { list: out, counts, tooMany: false };
}

module.exports = { mark, byLines, MAX_EDITS, BUDGET };
