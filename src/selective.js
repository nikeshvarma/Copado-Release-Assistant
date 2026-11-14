'use strict';

/**
 * The names of Copado's selective-commit files. Copado stores the XML it
 * committed for a selective commit as a file named after the commit row's
 * selectiveCommitHash - base64 of "Type:Name" - with "_commit" after it. The
 * inspection uses this to say which component such a file is for. (Since 3.0
 * the files are not downloaded: validations read the committed versions from
 * the branch.)
 *
 * Plain Node.js.
 */
const path = require('path');

/**
 * A downloaded file's name -> { type, name, hash, copy } or null. Tolerates an
 * added extension, a browser's " (1)" suffix, missing "=" padding and the
 * URL-safe alphabet ("-" and "_" for "+" and "/", which cannot be in a file name).
 */
function decodeFileName(fileName) {
  // Copado names the files on a story "<hash>_commit"; downloads may add an extension or " (1)"
  let base = path.basename(String(fileName)).replace(/\.(xml|txt)$/i, '').replace(/_commit$/i, '');
  const m = /^(.*?)\s*\((\d+)\)$/.exec(base);
  const copy = m ? Number(m[2]) : 0;
  if (m) base = m[1];
  base = base.trim();
  if (!/^[A-Za-z0-9+/_=-]+$/.test(base)) return null;
  const std = base.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = std + '='.repeat((4 - std.length % 4) % 4);
  let text;
  try { text = Buffer.from(padded, 'base64').toString('utf8'); } catch (e) { return null; }
  // only a clean round trip counts - a random file name does not decode to Type:Name
  if (Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '') !== std) return null;
  const mm = /^([A-Za-z][A-Za-z0-9]*):([^\u0000-\u001f]+)$/.exec(text);
  if (!mm) return null;
  return { type: mm[1], name: mm[2], hash: Buffer.from(text, 'utf8').toString('base64'), copy };
}

/** The hash Copado would use for a component. */
function hashFor(type, name) {
  return Buffer.from(type + ':' + name, 'utf8').toString('base64');
}

/** The root element of an XML document, or null. */
function rootOf(text) {
  const s = String(text).replace(/^\uFEFF/, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const m = /<([A-Za-z_][\w.:-]*)/.exec(s);
  return m ? m[1].replace(/^.*:/, '') : null;
}

module.exports = { decodeFileName, hashFor, rootOf };
