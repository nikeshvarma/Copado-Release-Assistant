'use strict';

/**
 * A record of the validations run from this project - which stage, as whom,
 * from which branch, with what result - kept in .copado/history/validations.json
 * so the readiness report can say what was validated where. Newest last, at
 * most 500 entries. Plain Node.js.
 *
 * entry: { at, label, source, environment, targetOrg, username, testLevel, success,
 *          components, componentErrors, testFailures, coverage: [{ name, percent }],
 *          coverageRule, belowCoverage: [{ name, percent }], stories: [], promotion, branches: [], deployId }
 */
const fs = require('fs');
const path = require('path');

const MAX = 500;

function file(dir) { return path.join(dir, 'validations.json'); }

function load(dir) {
  try { const v = JSON.parse(fs.readFileSync(file(dir), 'utf8')); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

function add(dir, entry) {
  const all = load(dir).concat([Object.assign({ at: new Date().toISOString() }, entry)]).slice(-MAX);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(file(dir), JSON.stringify(all, null, 1));
  return all[all.length - 1];
}

/**
 * Writes a file through a temporary copy and a rename, so a crash never leaves
 * half a file. On Windows the rename can fail for a moment (EPERM, EBUSY,
 * EACCES) while a virus scanner or the indexer holds the target: it is tried
 * again, then the content is written in place and the temporary copy removed.
 */
function writeAtomic(target, text) {
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, target); return; } catch (e) {
      if (!/^(EPERM|EBUSY|EACCES|EEXIST)$/.test(e.code || '')) { try { fs.unlinkSync(tmp); } catch (x) { /* gone */ } throw e; }
      if (attempt < 4) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1)); continue; }
      try { fs.copyFileSync(tmp, target); } finally { try { fs.unlinkSync(tmp); } catch (x) { /* gone */ } }
      return;
    }
  }
}

/**
 * The entries about a set of stories or a promotion - newest first. An entry
 * counts when it names one of the stories, or the promotion.
 */
function about(entries, o) {
  const stories = new Set((o.stories || []).map(s => String(s).toUpperCase()));
  return entries.filter(e => (o.promotion && e.promotion === o.promotion) || (e.stories || []).some(s => stories.has(String(s).toUpperCase())))
    .slice().reverse();
}

module.exports = { load, add, about, writeAtomic };
