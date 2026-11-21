'use strict';
/**
 * npm run corpus -- add <file...> - a conflict file's shape, its names replaced (src/anonymise), added to test/corpus/
 * for every release to be checked against. The file's own name is not kept either - a fingerprint and its type instead.
 * Review what it wrote before committing it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { anonymise } = require('../src/anonymise');

const [cmd, ...files] = process.argv.slice(2);
if (cmd !== 'add' || !files.length) { console.error('npm run corpus -- add <conflict file...>'); process.exit(1); }
const dir = path.join(__dirname, '..', 'test', 'corpus');
fs.mkdirSync(dir, { recursive: true });
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  if (!/^<{7}/m.test(text)) { console.error('skipped - no conflict markers: ' + f); continue; }
  const a = anonymise(text);
  // its type, as its name ends: .cls, .js, .flexipage-meta.xml - nothing else of the name
  const kind = (/\.([a-z]+-meta\.xml|cls|trigger|js|html|css|page|cmp|xml)$/i.exec(path.basename(f)) || [, 'txt'])[1];
  const out = path.join(dir, 'case-' + crypto.createHash('sha1').update(a.text).digest('hex').slice(0, 8) + '.' + kind);
  fs.writeFileSync(out, a.text);
  console.log('added ' + path.relative(process.cwd(), out) + ' - ' + a.names + ' names replaced; review it before committing');
}
