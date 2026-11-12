'use strict';

/**
 * Copado's selective-commit files. Copado stores the XML it committed for a
 * selective commit as a file named after the commit row's selectiveCommitHash -
 * base64 of "Type:Name". Downloaded into a drop folder (conflict/selective by
 * default), they are matched to the package, checked, and copied into the
 * project so a validation deploys exactly what Copado committed.
 *
 * Plain Node.js: no VS Code dependency, so all of it is unit-tested.
 */
const fs = require('fs');
const path = require('path');
const { sourcePaths } = require('./manifest');

// types that are one file in source format, so a selective file can be copied as is
const SINGLE_FILE = new Set(['Layout', 'FlexiPage', 'Profile', 'PermissionSet', 'PermissionSetGroup', 'CustomApplication',
  'CustomTab', 'QuickAction', 'Flow', 'CustomPermission', 'CustomMetadata', 'CustomField', 'RecordType', 'ListView',
  'CompactLayout', 'ValidationRule', 'WebLink', 'FieldSet', 'CustomObject']);
// a CustomObject file holding these is in Metadata API shape; source format splits them into their own files
const OBJECT_CHILDREN = /<(fields|listViews|recordTypes|validationRules|webLinks|compactLayouts|fieldSets|businessProcesses|sharingReasons|indexes)>/;

/**
 * A downloaded file's name -> { type, name, hash, copy } or null. Tolerates an
 * added extension, a browser's " (1)" suffix, missing "=" padding and the
 * URL-safe alphabet ("-" and "_" for "+" and "/", which cannot be in a file name).
 */
function decodeFileName(fileName) {
  // Copado names the files on a story "<hash>_commit"; downloads may add an extension or " (1)"
  let base = path.basename(String(fileName)).replace(/\.(xml|txt)$/i, '').replace(/_commit$/i, '');
  const m = /^(.*?)\s*\((\d+)\)$/.exec(base);
  const copy = m ? Number(m[2]) : 0;
  if (m) base = m[1];
  base = base.trim();
  if (!/^[A-Za-z0-9+/_=-]+$/.test(base)) return null;
  const std = base.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = std + '='.repeat((4 - std.length % 4) % 4);
  let text;
  try { text = Buffer.from(padded, 'base64').toString('utf8'); } catch (e) { return null; }
  // only a clean round trip counts - a random file name does not decode to Type:Name
  if (Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '') !== std) return null;
  const mm = /^([A-Za-z][A-Za-z0-9]*):([^\u0000-\u001f]+)$/.exec(text);
  if (!mm) return null;
  return { type: mm[1], name: mm[2], hash: Buffer.from(text, 'utf8').toString('base64'), copy };
}

/** The hash Copado would use for a component. */
function hashFor(type, name) {
  return Buffer.from(type + ':' + name, 'utf8').toString('base64');
}

/** The root element of an XML document, or null. */
function rootOf(text) {
  const s = String(text).replace(/^\uFEFF/, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const m = /<([A-Za-z_][\w.:-]*)/.exec(s);
  return m ? m[1].replace(/^.*:/, '') : null;
}

/**
 * What would happen to each selective commit:
 *   ready        a matching, valid file is in the drop folder
 *   missing      no file for it
 *   duplicate    more than one file for it - which is right cannot be guessed
 *   mismatch     the file's XML is a different type
 *   split        a CustomObject file in Metadata API shape
 *   unsupported  a type that is not a single file in source format
 * plus "extra": files in the drop folder that belong to no selective commit here.
 *
 * o: { root, folder, dirs, items: [{ type, name, copadoFile, copadoHash }] }
 */
function plan(o) {
  const files = listFolder(o.folder);
  const decoded = files.map(f => ({ file: f, id: decodeFileName(f) }));
  const index = buildIndex(o.root, o.dirs);
  const used = new Set();
  const items = o.items.map(it => {
    const hash = it.copadoHash || hashFor(it.type, it.name);
    const own = decoded.filter(d => d.id && (d.id.hash.replace(/=+$/, '') === hash.replace(/=+$/, '') ||
      (d.id.type === it.type && d.id.name === it.name)));
    own.forEach(d => used.add(d.file));
    const base = { type: it.type, name: it.name, copadoFile: it.copadoFile || '', hash };
    const target = targetFor(o.root, o.dirs, index, it.type, it.name);
    if (!SINGLE_FILE.has(it.type) || !target) return Object.assign(base, { status: 'unsupported', files: own.map(d => d.file) });
    if (!own.length) return Object.assign(base, { status: 'missing', target });
    if (own.length > 1) return Object.assign(base, { status: 'duplicate', files: own.map(d => d.file), target });
    const source = own[0].file;
    const text = fs.readFileSync(source, 'utf8');
    const root = rootOf(text);
    if (root !== it.type) return Object.assign(base, { status: 'mismatch', source, target, found: root });
    if (it.type === 'CustomObject' && OBJECT_CHILDREN.test(text)) return Object.assign(base, { status: 'split', source, target });
    return Object.assign(base, { status: 'ready', source, target, lines: text.split('\n').length });
  });
  const extra = decoded.filter(d => !used.has(d.file)).map(d => ({ file: d.file, id: d.id }));
  return { items, extra };
}

function listFolder(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('.')).map(e => path.join(folder, e.name)).sort();
  } catch (e) { return []; }
}

/** Every file in the package directories, by base name. */
function buildIndex(root, dirs) {
  const byName = new Map();
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else (byName.get(e.name) || byName.set(e.name, []).get(e.name)).push(p);
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return byName;
}

/** Where the file goes: where it already is in the project, else the standard place in the first package directory. */
function targetFor(root, dirs, index, type, name) {
  const candidates = sourcePaths(type, name);
  if (!candidates.length) return null;
  for (const rel of candidates) {
    const hits = (index.get(path.basename(rel)) || []).filter(p => p.split(path.sep).join('/').endsWith('/' + rel));
    if (hits.length) return hits[0];
  }
  return path.join(root, dirs[0] || 'force-app', 'main', 'default', ...candidates[0].split('/'));
}

/**
 * Imports every ready item: the current file is backed up, the selective file
 * is copied byte for byte, and the download moves out of the drop folder.
 * Returns the record that undo() reverses.
 */
function apply(items, o) {
  const stamp = o.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(o.storage, 'selective', 'backup', stamp);
  const importedDir = path.join(o.storage, 'selective', 'imported', stamp);
  const record = { stamp, root: o.root, items: [] };
  for (const it of items.filter(x => x.status === 'ready')) {
    const relTarget = path.relative(o.root, it.target);
    let backup = null;
    if (fs.existsSync(it.target)) {
      backup = path.join(backupDir, 'files', relTarget);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(it.target, backup);
    }
    fs.mkdirSync(path.dirname(it.target), { recursive: true });
    fs.copyFileSync(it.source, it.target);
    const moved = path.join(importedDir, path.basename(it.source));
    fs.mkdirSync(importedDir, { recursive: true });
    move(it.source, moved);
    record.items.push({ type: it.type, name: it.name, target: it.target, backup, download: it.source, moved });
  }
  if (record.items.length) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'import.json'), JSON.stringify(record, null, 2));
  }
  return record;
}

/** Reverses the most recent import: files restored (or removed if new), downloads put back. */
function undo(storage) {
  const dir = path.join(storage, 'selective', 'backup');
  let stamps = [];
  try { stamps = fs.readdirSync(dir).filter(s => fs.existsSync(path.join(dir, s, 'import.json'))).sort(); } catch (e) { /* none */ }
  if (!stamps.length) return null;
  const latest = path.join(dir, stamps[stamps.length - 1]);
  const record = JSON.parse(fs.readFileSync(path.join(latest, 'import.json'), 'utf8'));
  for (const it of record.items) {
    if (it.backup && fs.existsSync(it.backup)) fs.copyFileSync(it.backup, it.target);
    else if (!it.backup && fs.existsSync(it.target)) fs.unlinkSync(it.target);
    if (fs.existsSync(it.moved)) { fs.mkdirSync(path.dirname(it.download), { recursive: true }); move(it.moved, it.download); }
  }
  fs.renameSync(path.join(latest, 'import.json'), path.join(latest, 'undone.json'));
  return record;
}

function move(from, to) {
  try { fs.renameSync(from, to); } catch (e) { fs.copyFileSync(from, to); fs.unlinkSync(from); }
}

module.exports = { decodeFileName, hashFor, rootOf, plan, apply, undo, SINGLE_FILE };
