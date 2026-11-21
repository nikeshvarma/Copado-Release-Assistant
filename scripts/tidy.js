'use strict';
/**
 * npm run tidy - deletes what a clone still holds that the project has removed: files listed in
 * scripts/removed.txt, and README pictures the README does not show. Unzipping a new source over a clone
 * never deletes anything; this does, with git when it is a git checkout. Commit the result.
 * npm run tidy -- --check: only says what is left over, and fails - for CI.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { leftovers } = require('./ship');

const root = path.resolve(__dirname, '..');
const list = leftovers(root);
if (!list.length) { console.log('nothing left over'); process.exit(0); }
// --check (CI): say what is left over, and fail - nothing deleted, so the clone can be tidied and committed once
if (process.argv.includes('--check')) {
  console.error('Left over from earlier versions - the project no longer has them:\n  ' + list.join('\n  ') +
    '\nRun npm run tidy and commit the result. (Copying a new version over a clone never deletes anything; tidy does.)');
  process.exit(1);
}
for (const f of list) {
  try { execFileSync('git', ['rm', '-q', '--ignore-unmatch', '--', f], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }); } catch (e) { /* not a git checkout */ }
  try { fs.rmSync(path.join(root, f), { force: true }); } catch (e) { /* gone already */ }
  console.log('removed ' + f);
}
console.log(list.length + ' file(s) removed - commit them: git commit -m "remove what the project no longer has"');
