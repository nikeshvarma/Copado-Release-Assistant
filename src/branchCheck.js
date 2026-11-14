'use strict';

/**
 * Builds a separate check workspace from a feature branch: for each component
 * in the package, the files Copado committed are read from the branch and
 * written under <dir>, with the branch's sfdx-project.json - so a validation
 * deploys exactly what Copado committed, and the user's own project is never touched.
 */
const fs = require('fs');
const path = require('path');
const { sourcePaths } = require('./manifest');
const { packageDirsOf } = require('./paths');
const { limiter } = require('./copadoClient');

const FOLDER_TYPES = { LightningComponentBundle: 'lwc', AuraDefinitionBundle: 'aura', CustomObject: 'objects' };
const CODE = /\.(cls|trigger|page|component)$/;

/** The files a component may consist of, relative to a package directory root such as force-app/main/default. */
function candidates(type, name) {
  const out = [];
  for (const rel of sourcePaths(type, name)) { out.push(rel); if (CODE.test(rel)) out.push(rel + '-meta.xml'); }
  return out;
}

async function buildWorkspace(host, branch, deploy, dir, opts) {
  const o = opts || {};
  const limit = limiter(o.parallel || 6);
  if (!o.keep) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const projBuf = await host.readFile(branch, 'sfdx-project.json');
  const projText = projBuf ? projBuf.toString('utf8') : (o.fallbackProject || '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"62.0"}');
  fs.writeFileSync(path.join(dir, 'sfdx-project.json'), projText);
  // its own .forceignore - the branch's, or an empty one - so the CLI never climbs to a parent
  // project's .forceignore, which would judge these files by a path through a dot-folder and skip them all
  if (!o.keep) {
    const fi = await host.readFile(branch, '.forceignore');
    fs.writeFileSync(path.join(dir, '.forceignore'), fi || '# check workspace: the CLI uses this file, not a parent folder\'s\n');
  }
  let dirs = ['force-app'];
  try { dirs = packageDirsOf(projText); } catch (e) { /* default */ }
  const roots = dirs.flatMap(d => [d.replace(/\/+$/, '') + '/main/default', d.replace(/\/+$/, '')]);
  const written = [], missing = [];
  const put = (rel, buf) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); written.push(rel); };
  const jobs = [];
  for (const [type, names] of deploy) {
    for (const name of names) {
      jobs.push(limit(async () => {
        if (FOLDER_TYPES[type]) {
          for (const r of roots) {
            const files = await host.listFiles(branch, r + '/' + FOLDER_TYPES[type] + '/' + name);
            if (files.length) { await Promise.all(files.map(fp => limit(async () => { const b = await host.readFile(branch, fp); if (b) put(fp, b); }))); return; }
          }
          return missing.push(type + ' ' + name);
        }
        if (type === 'StaticResource') {
          for (const r of roots) {
            const files = (await host.listFiles(branch, r + '/staticresources')).filter(fp => path.posix.basename(fp).split('.')[0] === name || fp.includes('/staticresources/' + name + '/'));
            if (files.length) { for (const fp of files) { const b = await host.readFile(branch, fp); if (b) put(fp, b); } return; }
          }
          return missing.push(type + ' ' + name);
        }
        const rels = candidates(type, name);
        if (!rels.length) return missing.push(type + ' ' + name + ' (type not supported)');
        for (const r of roots) {
          const found = [];
          for (const rel of rels) { const b = await host.readFile(branch, r + '/' + rel); if (b) found.push([r + '/' + rel, b]); }
          if (found.length) { found.forEach(([fp, b]) => put(fp, b)); return; }
        }
        missing.push(type + ' ' + name);
      }));
    }
  }
  await Promise.all(jobs);
  return { written: written.sort(), missing: missing.sort(), dirs };
}

module.exports = { buildWorkspace, candidates };
