'use strict';
/**
 * The release, decided and described from package.json and CHANGELOG.md - used by
 * .github/workflows/release.yml, plain Node.
 *
 *   node scripts/release.js plan     whether to release: writes release, tag, version, prerelease to
 *                                    $GITHUB_OUTPUT (or prints them); fails with the reason when the
 *                                    tag and the version disagree, or the version has no notes
 *   node scripts/release.js notes    the CHANGELOG.md section of package.json's version, for the release
 *
 * A push to main releases a version that has no tag yet; a tag pushed by hand must be that version.
 */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');

/** The "## <version>" section of a changelog, without its heading - or null. */
function notesFor(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const at = lines.findIndex(l => l.trim() === '## ' + version);
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(at + 1, end).join('\n').trim();
  return body || null;
}

/**
 * { version, ref, tags: [existing tag names], changelog } -> { release, tag, version, prerelease, why }
 * Throws with the reason for a pushed tag that is not the version, a version that is not semver, or one
 * without notes.
 */
function decide(o) {
  const version = String(o.version || '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('package.json version "' + version + '" is not a version like 1.2.3');
  const tag = 'v' + version;
  const ref = String(o.ref || '');
  const pushedTag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : null;
  if (pushedTag && pushedTag !== tag) throw new Error('the tag ' + pushedTag + ' does not match package.json\'s version ' + version + ' - its tag is ' + tag);
  if (!pushedTag && (o.tags || []).includes(tag)) return { release: false, tag, version, prerelease: false, why: tag + ' is released already - bump the version in package.json to release again' };
  if (!notesFor(o.changelog, version)) throw new Error('CHANGELOG.md has no "## ' + version + '" section - the release notes come from it');
  return { release: true, tag, version, prerelease: version.includes('-'), why: pushedTag ? 'the pushed tag ' + tag : tag + ' is not released yet' };
}

function existingTags() {
  try {
    return execFileSync('git', ['ls-remote', '--tags', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(l => (l.split('refs/tags/')[1] || '').replace(/\^\{\}$/, '')).filter(Boolean);
  } catch (e) {
    // no remote (a local copy): its own tags
    return execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
  }
}

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const what = process.argv[2];
  try {
    if (what === 'notes') {
      const n = notesFor(changelog, pkg.version);
      if (!n) throw new Error('CHANGELOG.md has no "## ' + pkg.version + '" section');
      process.stdout.write(n + '\n\nInstall: download the .vsix below, then `code --install-extension ' + pkg.name + '-' + pkg.version + '.vsix --force`.\n');
    } else if (what === 'plan') {
      const r = decide({ version: pkg.version, ref: process.env.GITHUB_REF || '', tags: existingTags(), changelog });
      const out = ['release=' + r.release, 'tag=' + r.tag, 'version=' + r.version, 'prerelease=' + r.prerelease].join('\n') + '\n';
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out); else process.stdout.write(out);
      console.log((r.release ? 'release ' : 'no release: ') + r.why);
    } else {
      console.error('usage: node scripts/release.js plan | notes'); process.exit(2);
    }
  } catch (e) { console.error('::error::' + e.message); process.exit(1); }
}

module.exports = { notesFor, decide };
