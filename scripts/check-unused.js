'use strict';
/**
 * Unused code: a function or a constant that nothing uses. A planted unused function proves the scan
 * still works - if it is not found, the scan is broken and that fails too.
 *   node scripts/check-unused.js
 */
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const files = ['extension.js', 'release.js', 'promotionUi.js', 'lifecycleUi.js', 'releasePage.js', 'quickMerge.js', 'treeView.js', 'media/page.js', 'media/merge.js']
  .concat(fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => 'src/' + f)).filter(f => fs.existsSync(path.join(root, f)));
const all = files.map(f => [f, read(f)]);
all.push(['(planted)', 'function plantedNeverUsed() {}\n']);
const code = all.map(x => x[1]).join('\n');
const count = (text, n) => (text.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length;
const found = [];
for (const [f, src] of all) {
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(/g)) if (count(code, m[1]) < 2) found.push('unused function ' + f + ' ' + m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*const (\w+) = (?:\(|async|\w+ =>|require)/g)) if (count(src, m[1]) < 2) found.push('unused const ' + f + ' ' + m[1]);
}
const control = 'unused function (planted) plantedNeverUsed';
const real = found.filter(x => x !== control);
if (!found.includes(control)) { console.error('the scan did not find its planted control - it is broken'); process.exit(1); }
console.log(real.length ? real.join('\n') : 'no unused code (' + files.length + ' files)');
process.exit(real.length ? 1 : 0);
