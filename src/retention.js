'use strict';

/**
 * Working files that are old removed, so they do not pile up: in each folder below, an entry whose newest file is
 * older than the days given. Never what is in use, never a promotion with resolutions not uploaded to Copado yet,
 * never the validations' history (the readiness report reads it).
 *
 *   prune(root, { days, now, busy }) -> [relative paths removed]
 */
const fs = require('fs');
const path = require('path');

const FOLDERS = ['compare', 'manual', 'merge', 'branch-check', 'inspect', 'stories', 'reports', 'promotions'];

/** The newest change anywhere inside: a file's own time, or the newest of a folder's. */
function newest(p) {
  let t = 0;
  const walk = q => { let st; try { st = fs.statSync(q); } catch (e) { return; } if (st.isDirectory()) { for (const n of fs.readdirSync(q)) walk(path.join(q, n)); t = Math.max(t, st.mtimeMs); } else t = Math.max(t, st.mtimeMs); };
  walk(p);
  return t;
}

/** A promotion's resolutions made here and not uploaded yet: they exist nowhere else. */
function pending(dir) {
  try { const st = JSON.parse(fs.readFileSync(path.join(dir, 'promotion.json'), 'utf8')); return Object.values((st && st.files) || {}).some(f => f.state === 'resolved'); } catch (e) { return false; }
}

function prune(root, o) {
  const days = o && o.days != null ? Number(o.days) : 14;
  if (!root || !(days > 0)) return [];
  const now = (o && o.now) || Date.now(), limit = now - days * 86400000, busy = (o && o.busy) || (() => false);
  const removed = [];
  for (const folder of FOLDERS) {
    const dir = path.join(root, folder);
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      if (busy(p) || newest(p) >= limit) continue;
      if (folder === 'promotions' && pending(p)) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); removed.push(folder + '/' + n); } catch (e) { /* in use: next time */ }
    }
  }
  return removed;
}

module.exports = { prune, FOLDERS };
