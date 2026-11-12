'use strict';

/**
 * The fixed pair of conflict files - by default conflict/metadata/resolution.xml
 * (kept whole, the target) and feature.xml (merged in) - and when pasting new
 * content into them should open a merge by itself.
 */
const path = require('path');
const crypto = require('crypto');
const { insideProject } = require('./paths');

function pairPaths(root, o) {
  const folder = path.join(root, insideProject(o.folder, 'conflict/metadata'));
  const name = (v, d) => path.basename(String(v || d)) || d;   // a file name, never a path
  return {
    folder,
    target: path.join(folder, name(o.target, 'resolution.xml')),
    incoming: path.join(folder, name(o.incoming, 'feature.xml'))
  };
}

/** Identifies one file's content. */
function fileKey(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

/**
 * Should auto-merge run now? The two versions are pasted one after the other,
 * so it waits until BOTH files hold new XML since the last merge (the
 * baseline) - merging after the first paste would use the other file's old
 * content. Saving without a change, or the extension writing an applied result
 * into the target, never triggers it.
 */
function autoDecision(baseline, targetText, incomingText) {
  const t = String(targetText || ''), i = String(incomingText || '');
  if (!t.trim() || !i.trim()) return { run: false, reason: 'a file is empty' };
  if (!looksLikeXml(t) || !looksLikeXml(i)) return { run: false, reason: 'not complete XML yet' };
  const now = { target: fileKey(t), incoming: fileKey(i) };
  if (!baseline) return { run: false, reason: 'starting point recorded', baseline: now };
  const t2 = now.target !== baseline.target, i2 = now.incoming !== baseline.incoming;
  if (t2 && i2) return { run: true, baseline: now };
  if (t2 || i2) return { run: false, reason: 'waiting for the other file', waiting: t2 ? 'incoming' : 'target' };
  return { run: false, reason: 'unchanged since the last merge' };
}

function looksLikeXml(s) {
  const t = s.trim();
  return t.startsWith('<') && /<\/[A-Za-z][\w:.-]*>\s*$|\/>\s*$/.test(t);
}

module.exports = { pairPaths, fileKey, autoDecision };
