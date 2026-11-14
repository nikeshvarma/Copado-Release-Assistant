'use strict';
/**
 * Checks a built .vsix: a valid package, the files that must ship and none that must not, and the
 * extension activating from it with every command.
 *   node scripts/check-package.js [file.vsix]      (default: the one dist/ holds for this version)
 */
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const zip = require('./zip');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const file = path.resolve(process.argv[2] || path.join(root, 'dist', pkg.name + '-' + pkg.version + '.vsix'));
const problems = [];
const entries = zip.read(fs.readFileSync(file));
const names = new Set(entries.map(e => e.name));
for (const must of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/README.md', 'extension/CHANGELOG.md', 'extension/LICENSE.txt', 'extension/' + pkg.main.replace(/^\.\//, ''),
  'extension/media/merge.js', 'extension/media/merge.css', 'extension/src/mergePanel.js', 'extension/src/mergeAlign.js',
  'extension/media/monaco/vs/loader.js', 'extension/media/monaco/vs/editor/editor.main.js', 'extension/media/monaco/vs/editor/editor.main.css', 'extension/media/monaco/LICENSE.txt', 'extension/media/monaco/ThirdPartyNotices.txt']) {
  if (!names.has(must)) problems.push('missing: ' + must);
}
for (const n of names) if (/^extension\/(test|\.github|scripts|dist)\//.test(n) || /\.(map|vsix)$/.test(n)) problems.push('should not ship: ' + n);
// nothing the project has removed, and no README picture the README does not show - whatever the clone held
const ship = require('./ship').keep(path.resolve(__dirname, '..'));
for (const n of names) if (n.startsWith('extension/') && !ship(n.slice('extension/'.length))) problems.push('left over, should not ship: ' + n);
const m = entries.find(e => e.name === 'extension.vsixmanifest').data.toString('utf8');
if (!m.includes('Version="' + pkg.version + '"') || !m.includes('Publisher="' + pkg.publisher + '"')) problems.push('the manifest does not match package.json');
const shipped = JSON.parse(entries.find(e => e.name === 'extension/package.json').data.toString('utf8'));
if (shipped.version !== pkg.version) problems.push('package.json inside is ' + shipped.version);
// every file Monaco loads is there: the files its loader names, relative to vs/
for (const e of entries.filter(e => /^extension\/media\/monaco\/vs\/editor\/editor\.main\.js$/.test(e.name))) {
  for (const dep of (/define\("vs\/editor\/editor\.main",\[([^\]]*)\]/.exec(e.data.toString('utf8')) || ['', ''])[1].split(',').map(s => s.replace(/"/g, '').trim()).filter(s => s.startsWith('../'))) {
    if (!names.has('extension/media/monaco/vs/' + dep.slice(3) + '.js')) problems.push('Monaco needs ' + dep + '.js');
  }
}
// unpacked, it activates with every command
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cra-vsix-'));
try {
  for (const e of entries) { const to = path.join(tmp, ...e.name.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, e.data); }
  try { process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, 'check-activation.js'), path.join(tmp, 'extension')], { encoding: 'utf8' })); }
  catch (e) { problems.push('activation from the package failed:\n' + (e.stdout || '') + (e.stderr || '')); }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(path.basename(file) + ': ' + entries.length + ' entries' + (problems.length ? '\n  ' + problems.join('\n  ') : ' - all good'));
process.exit(problems.length ? 1 : 0);
