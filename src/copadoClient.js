'use strict';

/**
 * One session per Copado org. Logs in once through the Salesforce CLI, then
 * sends queries, describes and downloads straight to the REST API, a few at a
 * time - far faster than one CLI process per call. Describes are cached on disk
 * for a day. Requests go through the configured proxy (src/http.js); when the
 * direct route fails anyway, it falls back to the CLI for the rest of the session.
 *
 * Same interface as before: describe, query, download, patch.
 */
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function createClient(o) {
  const sf = o.sfcli;
  const v = o.version || '62.0';
  const base = '/services/data/v' + v;
  const limit = limiter(o.parallel || 6);
  let direct = o.direct !== undefined ? o.direct : true;
  const memo = new Map();
  let disk = null;
  const cacheFile = o.cacheFile;

  const loadDisk = () => {
    if (disk || !cacheFile) return disk || {};
    try { disk = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { disk = {}; }
    return disk;
  };
  const saveDisk = () => {
    if (!cacheFile) return;
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(disk)); } catch (e) { /* a cache only */ }
  };

  async function get(restPath) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const login = await sf.loginFor(o.sfPath, o.org, o.cwd, attempt > 0);
      try { return await sf.httpGet(login.url + restPath, login.token); } catch (e) {
        if (/^HTTP 401/.test(e.message) && attempt === 0) continue;
        throw e;
      }
    }
  }
  // network trouble (not an answer from Salesforce) switches the session to the CLI
  const networkError = e => !/^HTTP \d+/.test(e.message);

  async function viaDirectOr(directFn, cliFn) {
    if (direct) {
      try { return await limit(directFn); } catch (e) {
        if (!networkError(e)) throw e;
        direct = false;
        if (o.onNote) o.onNote('direct requests failed (' + e.message + ') - using the Salesforce CLI for this session');
      }
    }
    return limit(cliFn);
  }

  const restError = e => {
    // Salesforce answers errors as [{ message, errorCode }]
    const m = /^HTTP \d+: (.*)$/s.exec(e.message);
    if (m) { try { const j = JSON.parse(m[1]); if (Array.isArray(j) && j[0]) { const err = new Error(j[0].message); err.name = j[0].errorCode || 'Error'; return err; } } catch (x) { /* not JSON */ } }
    return e;
  };

  return {
    get mode() { return direct ? 'direct' : 'cli'; },
    async describe(sobject) {
      if (memo.has(sobject)) return memo.get(sobject);
      const cache = loadDisk();
      const key = 'v3|' + o.org + '|' + sobject;   // v3: with labels, field types and references
      const hit = cache[key];
      if (hit && Date.now() - hit.at < DAY) { memo.set(sobject, hit.fields); return hit.fields; }
      const fields = await viaDirectOr(async () => {
        try {
          const d = JSON.parse((await get(base + '/sobjects/' + encodeURIComponent(sobject) + '/describe')).toString('utf8'));
          return (d.fields || []).map(fieldOf);
        } catch (e) { if (/^HTTP 404/.test(e.message)) return null; throw restError(e); }
      }, () => sf.describe(o.sfPath, o.org, sobject, o.cwd));
      memo.set(sobject, fields);
      loadDisk()[key] = { at: Date.now(), fields };
      saveDisk();
      return fields;
    },
    async query(soql) {
      return viaDirectOr(async () => {
        const records = [];
        let next = base + '/query?q=' + encodeURIComponent(soql);
        try {
          while (next) {
            const page = JSON.parse((await get(next)).toString('utf8'));
            records.push(...(page.records || []).map(stripAttributes));
            next = page.done === false && page.nextRecordsUrl ? page.nextRecordsUrl : null;
          }
        } catch (e) { throw restError(e); }
        return records;
      }, () => sf.query(o.sfPath, o.org, soql, o.cwd));
    },
    async download(kind, id) {
      const p = base + '/sobjects/' + kind + '/' + String(id).replace(/[^A-Za-z0-9]/g, '') + (kind === 'Attachment' ? '/Body' : '/VersionData');
      return viaDirectOr(() => get(p), () => sf.restGet(o.sfPath, o.org, p, o.cwd));
    },
    patch(sobject, id, fields) {
      return limit(() => sf.restPatch(o.sfPath, o.org, base + '/sobjects/' + sobject + '/' + String(id).replace(/[^A-Za-z0-9]/g, ''), fields, o.cwd));
    }
  };
}

/** What the extension keeps of a described field: name, relationship, type, what it references, active picklist values. */
function fieldOf(f) {
  return Object.assign({ name: f.name, relationshipName: f.relationshipName || null },
    f.label ? { label: f.label } : {},
    f.type ? { type: f.type } : {},
    Array.isArray(f.referenceTo) && f.referenceTo.length ? { referenceTo: f.referenceTo.slice() } : {},
    Array.isArray(f.picklistValues) && f.picklistValues.length ? { picklist: f.picklistValues.filter(x => x.active !== false).map(x => x.value) } : {});
}

function stripAttributes(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) if (k !== 'attributes') out[k] = v && typeof v === 'object' && !Array.isArray(v) ? stripAttributes(v) : v;
  return out;
}

module.exports = { createClient, limiter, fieldOf };
