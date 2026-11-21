'use strict';
/**
 * Unused code: a function or a constant that nothing uses - an export is not a use: only the extension's own code
 * counts, not the tests - and a module nothing requires. Planted controls prove the scan still works: if one of
 * them is not found, the scan is broken and that fails too.
 *   node scripts/check-unused.js
 */
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
// files earlier versions had and this one does not (scripts/removed.txt): left over in a clone, not this version's code
const removed = new Set(fs.readFileSync(path.join(root, 'scripts', 'removed.txt'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')));
const leftovers = [...removed].filter(f => fs.existsSync(path.join(root, f)));
const files = ['extension.js', 'release.js', 'promotionUi.js', 'releasePage.js', 'manualUi.js', 'compareUi.js', 'media/page.js', 'media/merge.js']
  .concat(fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => 'src/' + f)).filter(f => fs.existsSync(path.join(root, f)) && !removed.has(f));
const all = files.map(f => [f, read(f)]);
// the controls: a function nothing calls; one only exported; a module nothing requires
all.push(['(planted)', 'function plantedNeverUsed() {}\n']);
all.push(['src/plantedExport.js', 'function plantedExported() {}\nmodule.exports = { plantedExported };\n']);
all.push(['src/plantedModule.js', 'const x = 1;\nmodule.exports = { x };\n']);
// used, though nothing in the code calls them - each with why
const ALLOWED = {
  'unused function extension.js deactivate': 'VS Code calls it when the extension stops',
  'unused function src/sfcli.js resetRest': 'the tests reset the CLI\u2019s remembered logins between them'
};
// an export is not a use
const noExports = t => t.replace(/module\.exports\s*=\s*\{[^}]*\};?/g, '');
const code = all.map(x => noExports(x[1])).join('\n');
const count = (text, n) => (text.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length;
const found = [];
for (const [f, src] of all) {
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(/g)) if (count(code, m[1]) < 2) found.push('unused function ' + f + ' ' + m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*const (\w+) = (?:\(|async|\w+ =>|require)/g)) if (count(src, m[1]) < 2) found.push('unused const ' + f + ' ' + m[1]);
}
// a module of src/ that no other file requires
for (const [f] of all.filter(([f]) => f.startsWith('src/'))) {
  const name = path.basename(f, '.js');
  const req = new RegExp("require\\(\\s*['\"](?:\\./|\\.\\./)?(?:src/)?" + name + "(?:\\.js)?['\"]\\s*\\)");
  // or started by its file name - a worker
  const byName = new RegExp("['\"]" + name + "\\.js['\"]");
  if (!all.some(([g, t]) => g !== f && (req.test(t) || byName.test(t)))) found.push('unused module ' + f);
}
const controls = ['unused function (planted) plantedNeverUsed', 'unused function src/plantedExport.js plantedExported', 'unused module src/plantedModule.js'];
const missed = controls.filter(c => !found.includes(c));
if (missed.length) { console.error('the scan did not find its planted controls - it is broken: ' + missed.join('; ')); process.exit(1); }
const real = found.filter(x => !controls.includes(x) && !/src\/planted(Export|Module)\.js/.test(x) && !ALLOWED[x]);
if (leftovers.length) console.log('left over from earlier versions, not checked: ' + leftovers.join(', ') + ' \u2013 npm run tidy removes them');
console.log(real.length ? real.join('\n') : 'no unused code (' + files.length + ' files)');
process.exit(real.length ? 1 : 0);
