'use strict';

/**
 * B3.2 - a flow's conflict that only moves the canvas: both versions the same but for <locationX>/<locationY>, which
 * change nothing when the flow runs. The feature's is taken, marked, undoable; every other conflict stays yours.
 *
 *   onlyPositions(target, feature) -> whether the two versions differ in positions alone
 *   apply(g)                       -> Copado's file as fromConflictFile read it, those conflicts' feature lines in place
 */
const POS = /^\s*<location[XY]>-?\d+(\.\d+)?<\/location[XY]>\s*$/;
const lines = t => String(t || '').split(/\r?\n/).filter(l => l.trim());

function onlyPositions(target, feature) {
  const a = lines(target), b = lines(feature);
  if (!a.length || a.length !== b.length) return false;
  let moved = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!POS.test(a[i]) || !POS.test(b[i]) || a[i].replace(/>[^<]*</, '><') !== b[i].replace(/>[^<]*</, '><')) return false;
    moved = true;
  }
  return moved;
}

function apply(g) {
  const L = String(g.text).split(/(?<=\n)/);
  const moved = g.conflicts.filter(c => onlyPositions(c.target, c.feature));
  // from the last, so each one's place - git's text before it - is where it was
  for (const c of moved.slice().sort((x, y) => y.at - x.at)) L.splice(c.at, 0, ...String(c.feature).split(/(?<=\n)/).filter(Boolean));
  for (const c of moved) c.positions = true;
  return Object.assign({}, g, { text: L.join(''), moved: moved.length });
}

module.exports = { onlyPositions, apply };
