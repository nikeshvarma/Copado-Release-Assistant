'use strict';

/**
 * Duplicates in the merge editor, with the same engine as Find and Remove Duplicate Entries
 * (src/duplicates.js), so "a duplicate" means one thing everywhere.
 *
 *   inText(text)  the duplicates in your resolution as it is - each the later copy's lines, and the line
 *                 of the copy it repeats - for the editor to mark as you type
 *   dedupe(text)  the text without its identical duplicates - what merging always removes, now also for a
 *                 start from a branch's file; duplicates that differ are a choice, and are left
 */
const X = require('./xmlParser');
const { findDuplicates, dedupeEdits } = require('./duplicates');

const flat = s => String(s).replace(/>\s+</g, '><').trim();

function found(text) {
  const parsed = X.parse(String(text));
  if (!parsed.root || (parsed.errors && parsed.errors.length)) return null;
  return { parsed, findings: findDuplicates(parsed, { warnRepeatedSingletons: false }).filter(f => f.kind !== 'duplicate-single') };
}

/** [{ b0, b1, sameAs, label, identical }] - b0..b1 the duplicate's lines (0-based, end excluded), sameAs the first copy's line (1-based). */
function inText(text) {
  const f = found(text);
  if (!f) return [];
  const starts = X.lineStarts(String(text));
  const line = off => X.lineAt(starts, off);
  return f.findings.map(d => ({ b0: line(d.node.start), b1: line(d.node.end - 1) + 1, sameAs: line(d.first.start) + 1, label: d.label || d.tag, identical: !!d.identical }));
}

/** { text, removed: [each removed copy, flattened] } - only identical duplicates, the first copy kept. */
function dedupe(text) {
  const t = String(text);
  const f = found(t);
  const same = f ? f.findings.filter(d => d.identical) : [];
  if (!same.length) return { text: t, removed: [] };
  let out = '', at = 0;
  for (const r of dedupeEdits(f.parsed, same, 'first')) { out += t.slice(at, r.start); at = r.end; }
  return { text: out + t.slice(at), removed: same.map(d => flat(t.slice(d.node.start, d.node.end))) };
}

module.exports = { inText, dedupe, flat };
