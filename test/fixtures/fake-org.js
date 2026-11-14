'use strict';

/**
 * An in-memory Salesforce org for the tests: describe, query and download,
 * answering the way Salesforce does. Each object has a schema - its fields,
 * and which object each lookup points at - so a field the org does not have is
 * rejected ("No such column"), a relationship it does not have too ("Didn't
 * understand relationship"), and describe reports types and references.
 *
 * The SOQL understood is what the extension sends: SELECT with relationship
 * paths, WHERE with = != IN, NOT IN, LIKE, AND, OR and parentheses, ORDER BY
 * (one or more fields, ASC or DESC) and LIMIT. Writes go through patch, as the
 * extension's few writes do: an Attachment's Body arrives base64 and becomes
 * its content; a field the object does not have is refused; each write moves
 * LastModifiedDate on. Labels come from schema.labels.
 *
 * schema: { Obj: { fields: ['Name', ...], refs: { Field__c: 'Target__c' }, types: { Field__c: 'boolean' } } }
 * data:   { Obj: [{ Id, ... }] }, files: { id: 'content' }
 */
function createOrg(schema, data, files) {
  files = files || {};
  const queries = [];
  const byId = new Map();
  for (const [obj, rows] of Object.entries(data)) for (const r of rows) byId.set(r.Id, Object.assign({ __obj: obj }, r));
  const fieldsOf = obj => ['Id'].concat((schema[obj] || {}).fields || []);
  const relField = rel => rel.endsWith('__r') ? rel.replace(/__r$/, '__c') : rel + 'Id';

  function resolve(obj, rec, pathStr) {
    const parts = pathStr.split('.');
    let o = obj, r = rec;
    for (let i = 0; i < parts.length - 1; i++) {
      const f = relField(parts[i]);
      const target = ((schema[o] || {}).refs || {})[f];
      if (!target) throw new Error("Didn't understand relationship '" + parts[i] + "' in field path. If you are attempting to use a custom relationship, be sure to append the '__r' after the custom entity name.");
      r = r && r[f] ? byId.get(r[f]) : null;
      o = target;
    }
    const last = parts[parts.length - 1];
    if (!fieldsOf(o).includes(last) && last !== 'Id') throw new Error("No such column '" + last + "' on entity '" + o + "'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name.");
    return r ? r[last] : undefined;
  }

  // WHERE: a tiny recursive-descent parser
  function tokens(s) {
    const out = [];
    const re = /\s*(?:('(?:[^'\\]|\\.)*')|(\()|(\))|(,)|(!=|=|<=|>=|<|>)|([A-Za-z_][\w.]*)|(-?\d+(?:\.\d+)?))/y;
    let m;
    re.lastIndex = 0;
    while (re.lastIndex < s.length && (m = re.exec(s))) {
      if (m[1]) out.push({ v: m[1].slice(1, -1).replace(/\\'/g, "'") });
      else if (m[2] || m[3] || m[4] || m[5]) out.push({ p: m[2] || m[3] || m[4] || m[5] });
      else if (m[6]) out.push({ w: m[6] });
      else if (m[7]) out.push({ v: Number(m[7]) });
      if (!m[0].length) break;
    }
    return out;
  }
  function parseWhere(s) {
    const t = tokens(s);
    let i = 0;
    const peekW = w => t[i] && t[i].w && t[i].w.toUpperCase() === w;
    const value = () => {
      if (t[i] && t[i].p === '(') { i++; const list = []; while (t[i] && t[i].p !== ')') { if (t[i].p === ',') { i++; continue; } list.push(t[i++].v); } i++; return list; }
      const x = t[i++];
      return x.w && /^(true|false|null)$/i.test(x.w) ? JSON.parse(x.w.toLowerCase()) : x.v;
    };
    const cond = () => {
      if (t[i] && t[i].p === '(') { i++; const e = or(); i++; return e; }
      const field = t[i++].w;
      let op;
      if (peekW('NOT')) { i++; i++; op = 'NOT IN'; } else if (peekW('IN')) { i++; op = 'IN'; } else if (peekW('LIKE')) { i++; op = 'LIKE'; } else op = t[i++].p;
      const v = value();
      return { field, op, v };
    };
    const and = () => { const list = [cond()]; while (peekW('AND')) { i++; list.push(cond()); } return list.length === 1 ? list[0] : { and: list }; };
    const or = () => { const list = [and()]; while (peekW('OR')) { i++; list.push(and()); } return list.length === 1 ? list[0] : { or: list }; };
    return or();
  }
  function test(obj, rec, e) {
    if (e.and) return e.and.every(x => test(obj, rec, x));
    if (e.or) return e.or.some(x => test(obj, rec, x));
    const have = resolve(obj, rec, e.field);
    if (e.op === '=') return have === e.v || (have == null && e.v == null);
    if (e.op === '!=') return have !== e.v;
    if (e.op === 'IN') return e.v.includes(have);
    if (e.op === 'NOT IN') return !e.v.includes(have);
    if (e.op === 'LIKE') return new RegExp('^' + String(e.v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(String(have == null ? '' : have));
    throw new Error('operator ' + e.op);
  }

  function shape(obj, rec, fields) {
    const out = {};
    for (const f of fields) {
      const v = resolve(obj, rec, f);
      const parts = f.split('.');
      let o = out;
      for (let i = 0; i < parts.length - 1; i++) {
        const ref = rec && i === 0 ? rec[relField(parts[0])] : true;
        if (!ref) { o = null; break; }
        o = o[parts[i]] = o[parts[i]] || {};
      }
      if (o) o[parts[parts.length - 1]] = v === undefined ? null : v;
    }
    return out;
  }

  const api = {
    queries,
    async describe(obj) {
      const s = schema[obj];
      if (!s) return null;
      return fieldsOf(obj).map(n => Object.assign({ name: n }, (s.labels || {})[n] ? { label: s.labels[n] } : {}, { relationshipName: (s.refs || {})[n] ? (n.endsWith('__c') ? n.replace(/__c$/, '__r') : n.replace(/Id$/, '')) : null },
        (s.types || {})[n] ? { type: s.types[n] } : {}, (s.refs || {})[n] ? { referenceTo: [s.refs[n]], type: 'reference' } : {}, (s.picklists || {})[n] ? { picklist: s.picklists[n] } : {}));
    },
    async query(soql) {
      queries.push(soql);
      const m = /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/is.exec(soql);
      if (!m) throw new Error('MALFORMED_QUERY: ' + soql);
      const [, sel, obj, where, order, limit] = m;
      if (!schema[obj]) throw new Error("sObject type '" + obj + "' is not supported.");
      const fields = sel.split(',').map(x => x.trim());
      let rows = (data[obj] || []).map(r => Object.assign({ __obj: obj }, r));
      fields.forEach(f => resolve(obj, rows[0] || {}, f));   // unknown fields fail even with no rows
      const cond = where ? parseWhere(where) : null;
      if (cond) rows = rows.filter(r => test(obj, r, cond));
      if (order) {
        const keys = order.split(',').map(x => x.trim().split(/\s+/));
        rows.sort((a, b) => { for (const [f, dir] of keys) { const x = resolve(obj, a, f), y = resolve(obj, b, f); const c = String(x == null ? '' : x).localeCompare(String(y == null ? '' : y)); if (c) return /desc/i.test(dir || '') ? -c : c; } return 0; });
      }
      if (limit) rows = rows.slice(0, Number(limit));
      return rows.map(r => shape(obj, r, fields));
    },
    writes: [],
    async patch(obj, id, fields) {
      const rec = (data[obj] || []).find(r => r.Id === id);
      if (!rec) throw new Error('HTTP 404: [{"errorCode":"NOT_FOUND","message":"' + obj + ' ' + id + ' does not exist"}]');
      for (const k of Object.keys(fields)) if (k !== 'Body' && !fieldsOf(obj).includes(k)) throw new Error('HTTP 400: [{"errorCode":"INVALID_FIELD","message":"No such column \'' + k + '\' on sobject of type ' + obj + '"}]');
      api.writes.push([obj, id, Object.keys(fields).sort().join(',')]);
      for (const [k, v] of Object.entries(fields)) { if (k === 'Body') files[id] = Buffer.from(v, 'base64').toString('utf8'); else rec[k] = v; }
      rec.LastModifiedDate = new Date(Date.now() + api.writes.length).toISOString().replace('Z', '+0000');
    },
    async download(kind, id) {
      if (!(id in (files || {}))) throw new Error('HTTP 404: [{"errorCode":"NOT_FOUND","message":"The requested resource does not exist"}]');
      return Buffer.from(files[id], 'utf8');
    }
  };
  return api;
}

module.exports = { createOrg };
