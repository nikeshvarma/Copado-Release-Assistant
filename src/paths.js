'use strict';

const path = require('path');

/**
 * A folder setting, as a path relative to the project that cannot point
 * outside it: absolute paths and ".." segments fall back to the default.
 */
function insideProject(value, fallback) {
  const raw = String(value || '');
  const rel = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || rel.split('/').some(seg => seg === '..')) return fallback;
  return rel;
}

/** True when the folder would put the extension's files inside a package directory. */
function insidePackageDir(rel, packageDirs) {
  const r = rel.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  return (packageDirs || []).some(p => r.indexOf(String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') + '/') === 0);
}

module.exports = { insideProject, insidePackageDir };

/** Package directories from sfdx-project.json text; force-app when it cannot be read. */
function packageDirsOf(projectJsonText) {
  try {
    const dirs = (JSON.parse(projectJsonText).packageDirectories || []).map(d => d && d.path).filter(Boolean);
    return dirs.length ? dirs : ['force-app'];
  } catch (e) { return ['force-app']; }
}

/**
 * A folder setting resolved for this project: inside the project, and never
 * inside a package directory - that is reserved for retrieved metadata.
 */
function projectFolder(value, fallback, projectJsonText) {
  const rel = insideProject(value, fallback);
  return insidePackageDir(rel, packageDirsOf(projectJsonText)) ? fallback : rel;
}

module.exports.packageDirsOf = packageDirsOf;
module.exports.projectFolder = projectFolder;

/**
 * Finds the Salesforce project to work in - the folder holding
 * sfdx-project.json. In order:
 *   1. cmr.project.path, if set (absolute, or relative to the first open folder)
 *   2. the project containing the file open in the editor
 *   3. an open folder that is itself a project
 *   4. a project one or two levels below an open folder, if there is exactly one
 * Returns { root, source } or { root: null, error, candidates }.
 */
function findProjectRoot(o) {
  const fs = require('fs');
  const folders = (o.folders || []).filter(Boolean);
  const has = d => { try { return fs.statSync(path.join(d, 'sfdx-project.json')).isFile(); } catch (e) { return false; } };

  if (o.configured && String(o.configured).trim()) {
    const raw = String(o.configured).trim();
    const p = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : (folders[0] ? path.resolve(folders[0], raw) : null);
    if (p && has(p)) return { root: path.resolve(p), source: 'cmr.project.path' };
    return { root: null, error: 'cmr.project.path is "' + raw + '", but there is no sfdx-project.json there.' };
  }

  if (o.activeFile) {
    const owner = folders.find(f => isInside(o.activeFile, f));
    if (owner) {
      let d = path.dirname(o.activeFile);
      for (;;) {
        if (has(d)) return { root: d, source: 'the project of the open file' };
        if (path.resolve(d) === path.resolve(owner)) break;
        const up = path.dirname(d);
        if (up === d || !isInside(up, owner)) break;
        d = up;
      }
    }
  }

  for (const f of folders) if (has(f)) return { root: f, source: 'the open folder' };

  const found = [];
  const skip = name => name.startsWith('.') || name === 'node_modules';
  const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !skip(e.name)).map(e => path.join(d, e.name)); } catch (e) { return []; } };
  for (const f of folders) {
    for (const child of dirs(f)) {
      if (has(child)) { found.push(child); continue; }
      for (const grandchild of dirs(child)) if (has(grandchild)) found.push(grandchild);
    }
  }
  if (found.length === 1) return { root: found[0], source: 'found inside the open folder' };
  if (found.length > 1) {
    return { root: null, candidates: found,
      error: 'The open folder contains ' + found.length + ' Salesforce projects. Open the one you want, or set cmr.project.path.' };
  }
  return { root: null, error: 'No Salesforce project (sfdx-project.json) found in the open folder. Open the project folder, or set cmr.project.path.' };
}

function isInside(p, dir) {
  const rel = path.relative(dir, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A path as the CLI should see it: relative to the project when it is inside, so no spaces or drive letters travel. */
function forCli(p, root) {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

module.exports.findProjectRoot = findProjectRoot;
module.exports.forCli = forCli;
