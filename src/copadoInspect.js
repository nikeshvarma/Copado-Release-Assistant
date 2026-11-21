'use strict';

/**
 * Reading Copado's records robustly: which of a set of fields an org's Copado version has (available), and a
 * query that leaves out the fields it does not (robustQuery) - so one org's older Copado never breaks a read.
 * The Salesforce access is injected: api.describe(sobject), api.query(soql).
 */

const { decodeFileName } = require('./selective');

/** Keeps the wanted fields the object really has (relationship paths are checked by their first hop). */
function available(fields, wanted) {
  const names = new Set(fields.map(f => f.name));
  const rels = new Set(fields.map(f => f.relationshipName).filter(Boolean));
  return wanted.filter(p => {
    const first = p.split('.')[0];
    return p.includes('.') ? rels.has(first) : names.has(p);
  });
}

/** Runs a query, dropping any field the org rejects and trying again. */
async function robustQuery(api, select, from, where, tail, notes) {
  let fields = select.slice();
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!fields.length) return [];
    const soql = 'SELECT ' + fields.join(', ') + ' FROM ' + from + (where ? ' WHERE ' + where : '') + (tail ? ' ' + tail : '');
    try { return await api.query(soql); } catch (e) {
      const msg = String(e && e.message || e);
      const bad = /No such column '([\w.]+)'/i.exec(msg) || /Didn't understand relationship '([\w.]+)'/i.exec(msg);
      if (!bad) throw e;
      const token = bad[1].split('.').pop();
      const before = fields.length;
      fields = fields.filter(f => !f.split('.').includes(token));
      if (fields.length === before) throw e;
      notes.push('skipped ' + from + ' field ' + token + ' (not in this org)');
    }
  }
  throw new Error('could not query ' + from);
}

module.exports = { available, robustQuery };
