'use strict';
/**
 * What goes into the package, whatever else a clone holds: never a file this project has removed
 * (scripts/removed.txt - an unzipped source does not delete them), and of the README's pictures only those
 * the README shows. Used by package.js, check-package.js, tidy.js and the tests.
 */
const fs = require('fs');
const path = require('path');

function removed(root) {
  const f = path.join(root, 'scripts', 'removed.txt');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

/**
 * The README as packaged: its pictures linked over https, from the repository - VS Code's extension page loads no
 * image from the extension's own folder (its page allows only https), so a relative link shows a broken picture.
 * What vsce does when it packages; the README in the repository keeps its relative links, for GitHub.
 */
function readmeForPackage(text, repository) {
  const url = String((repository && repository.url) || repository || '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) throw new Error('package.json repository must be https://github.com/<owner>/<repo> - the README\u2019s pictures are linked from it');
  const base = url + '/raw/HEAD/';
  return String(text).replace(/(!\[[^\]]*\]\()(?!https?:|data:|#)\.?\/?([^)\s]+)/g, (m, a, p) => a + base + p).replace(/(<img\b[^>]*\bsrc=")(?!https?:|data:)\.?\/?([^"]+)/g, (m, a, p) => a + base + p);
}

/** The README's pictures: media/readme/<name>.png it shows. */
function shown(root) {
  const f = path.join(root, 'README.md');
  const readme = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  return new Set([...readme.matchAll(/\(?(media\/readme\/[\w.-]+\.png)/g)].map(m => m[1]));
}

/** A predicate on paths relative to root, with / - false for what must not ship. */
function keep(root) {
  const gone = new Set(removed(root)), pictures = shown(root);
  return rel => {
    const f = rel.replace(/\\/g, '/');
    if (gone.has(f)) return false;
    if (/^media\/readme\/[^/]+\.png$/.test(f) && !pictures.has(f)) return false;
    return true;
  };
}

/** What a clone still holds that is left over: removed files, and pictures the README does not show. */
function leftovers(root) {
  const k = keep(root), out = [];
  for (const f of removed(root)) if (fs.existsSync(path.join(root, f))) out.push(f);
  const dir = path.join(root, 'media', 'readme');
  if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) { const f = 'media/readme/' + n; if (/\.png$/.test(n) && !k(f) && !out.includes(f)) out.push(f); }
  return out.sort();
}

module.exports = { removed, shown, keep, leftovers, readmeForPackage };
