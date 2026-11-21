'use strict';

/**
 * Git lines up text, not elements. Every layout item starts with the same two lines - <layoutItems> and
 * <behavior>Edit</behavior> - so a field added before another often comes out as a block that starts inside the
 * existing item: the new field's lines, its close, the next item's open. The file it makes is right; what it shows
 * is not. Code does the same: a method added after another, its block starting at the brace that closes the one before.
 *
 *   tidy(conflictText) -> the same file, each block that only adds or only removes lines slid up or down over the
 *                         lines repeated either side of it, to the nearest place where it holds whole elements
 *                         (metadata) or balanced code - the earlier of two as near
 *
 * A slide moves a line across the block's edge only when it is the same line at both ends, so each side of the file,
 * and git's merge without the block, stay exactly as they were - character for character. Left where git put it: a
 * block both sides changed, one whose common ancestor had lines, one already whole, one with no whole place near.
 */
const { blocks, brackets } = require('./codeChecks');
const X = require('./xmlParser');

const RANGE = 200;
const blank = l => !String(l).trim();

/** Whole elements: they parse, with nothing between them but blank text - no element cut through, no value cut from its tags. */
function wholeXml(lines) {
  if (!lines.some(l => !blank(l))) return false;
  const d = X.parse('<w>' + lines.join('') + '</w>');
  if (!d.root || (d.errors && d.errors.length) || !X.elements(d.root).length) return false;
  return d.root.children.every(c => c.type !== X.TEXT || !c.value.trim());
}
/** Balanced code: every bracket it opens it closes, and it starts with no closing one. */
function wholeCode(lines) {
  const ls = lines.filter(l => !blank(l));
  if (!ls.length || /^\s*[}\])]/.test(ls[0])) return false;
  const text = lines.join('');
  return !brackets(text, text.includes('`'));
}

/** Each place the block's lines can be slid to: [{ off, before, lines, after }], nearest first, up before down. */
function places(before, Xs, after) {
  const up = [], down = [];
  let B = before.slice(), L = Xs.slice(), A = after.slice();
  for (let n = 1; n <= RANGE && B.length && B[B.length - 1] === L[L.length - 1]; n++) {
    const last = B.pop(); A = [L.pop()].concat(A); L = [last].concat(L);
    up.push({ off: -n, before: B.slice(), lines: L.slice(), after: A.slice() });
  }
  B = before.slice(); L = Xs.slice(); A = after.slice();
  for (let n = 1; n <= RANGE && A.length && A[0] === L[0]; n++) {
    const first = A.shift(); B = B.concat([L.shift()]); L = L.concat([first]);
    down.push({ off: n, before: B.slice(), lines: L.slice(), after: A.slice() });
  }
  const out = [];
  for (let k = 0; k < Math.max(up.length, down.length); k++) { if (up[k]) out.push(up[k]); if (down[k]) out.push(down[k]); }
  return out;
}

function tidy(conflictText) {
  const text = String(conflictText == null ? '' : conflictText);
  const bs = blocks(text);
  if (!bs.length) return text;
  const lines = text.split(/(?<=\n)/);
  const xml = /^\s*(<\?xml|<[A-Za-z][\w]*[\s>])/.test(text.replace(/^\uFEFF/, '').replace(/^(?:<{7}|={7}|>{7}|\|{7})[^\n]*\n/gm, ''));
  const whole = xml ? wholeXml : wholeCode;
  // git's lines between the blocks, and each block: [shared, block, shared, block, ..., shared]
  const parts = [];
  let i = 0;
  for (const b of bs) {
    parts.push(lines.slice(i, b.b0));
    const raw = lines.slice(b.b0, b.b1);
    const baseAt = raw.findIndex(l => /^\|{7}(\s|$)/.test(l)), mid = raw.findIndex(l => /^={7}\r?\n?$/.test(l));
    parts.push({ open: raw[0], baseOpen: baseAt >= 0 ? raw[baseAt] : null, mid: raw[mid], close: raw[raw.length - 1], ours: b.ours, base: b.base, theirs: b.theirs });
    i = b.b1;
  }
  parts.push(lines.slice(i));
  let moved = 0;
  for (let k = 1; k < parts.length; k += 2) {
    const b = parts[k];
    if (!b.ours.length === !b.theirs.length || (b.base && b.base.length)) continue;
    const side = b.ours.length ? 'ours' : 'theirs';
    // a closing line with no newline - the file's last - cannot cross the block's edge
    if (b[side].some(l => !/\n$/.test(l))) continue;
    if (whole(b[side])) continue;
    const to = places(parts[k - 1], b[side], parts[k + 1]).find(p => whole(p.lines));
    if (!to) continue;
    parts[k - 1] = to.before; b[side] = to.lines; parts[k + 1] = to.after;
    moved++;
  }
  if (!moved) return text;
  return parts.map((p, k) => k % 2 ? p.open + p.ours.join('') + (p.baseOpen ? p.baseOpen + (p.base || []).join('') : '') + p.mid + p.theirs.join('') + p.close : p.join('')).join('');
}

module.exports = { tidy };

