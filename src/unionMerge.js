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

/** A block's side as whole entries: each with its text and what identifies it - or null when it is not whole. */
function entries(fragment, typeName) {
  const wrapped = '<r>' + fragment + '</r>';
  const d = X.parse(wrapped);
  if (!d.root || (d.errors && d.errors.length)) return null;
  const out = [];
  for (const c of d.root.children) {
    if (c.type === X.ELEMENT) {
      // a single value - a label, a description - is that element, whatever it says; an entry is what its key says
      const id = XC.isLeaf(c) ? c.name : (() => { const k = XC.identity(typeName, [typeName], c, true); return k == null ? null : c.name + ':' + k; })();
      out.push({ id, text: wrapped.slice(c.start, c.end), canon: X.canonical ? X.canonical(c) : wrapped.slice(c.start, c.end).replace(/\s+/g, ' ') });
    } else if (c.type === X.TEXT && c.text != null && String(c.text).trim()) return null;   // loose text: not whole entries
  }
  return out;
}

function resolve(conflictText, typeName) {
  const lines = split(conflictText), out = [];
  const eol = /\r\n/.test(conflictText) ? '\r\n' : '\n';
  let i = 0;
  for (const b of blocks(conflictText)) {
    out.push(...lines.slice(i, b.b0));
    const ours = b.ours.join(''), theirs = b.theirs.join('');
    const mine = entries(ours, typeName), feature = entries(theirs, typeName);
    if (!mine || !feature) return { ok: false, reason: 'git\u2019s conflict at line ' + (b.b0 + 1) + ' is not whole entries' };
    let text = ours;
    const added = [];
    for (const f of feature) {
      const t = f.id != null ? mine.find(m => m.id === f.id) : mine.find(m => m.canon === f.canon);
      if (!t) { if (!mine.some(m => m.canon === f.canon)) added.push(f); continue; }
      // the feature's change applied, in the target's place
      if (t.canon !== f.canon && text.includes(t.text)) text = text.replace(t.text, f.text);
    }
    // each one added after the target's last entry of its kind - where Salesforce keeps it - or at the end
    const indent = (/^([ \t]*)</m.exec(ours || theirs) || ['', '    '])[1];
    for (const f of added) {
      const name = /^<([\w:.-]+)/.exec(f.text)[1];
      const after = mine.filter(m => new RegExp('^<' + name + '[\\s>/]').test(m.text)).pop();
      const at = after ? text.lastIndexOf(after.text) : -1;
      if (at >= 0) { const end = at + after.text.length; text = text.slice(0, end) + eol + indent + f.text.trim() + text.slice(end); mine.push({ id: f.id, text: f.text.trim(), canon: f.canon }); }
      else text = (text.length && !/\n$/.test(text) ? text + eol : text) + indent + f.text.trim() + eol;
    }
    out.push(text);
    i = b.b1;
  }
  out.push(...lines.slice(i));
  return { ok: true, text: out.join('') };
}

module.exports = { resolve };
