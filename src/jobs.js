'use strict';

/**
 * Following what Copado does after a promotion is deployed - read-only.
 *
 * Copado versions keep this in different records: newer ones run a
 * copado__JobExecution__c with copado__JobStep__c children and
 * copado__Result__c below them; older ones a copado__Deployment__c with
 * copado__Step__c and copado__Deployment_Job__c. A validation or deployment
 * can also be a copado__Deployment__c whose job execution hangs off the
 * deployment rather than the promotion - which is where its errors are.
 * Which of these exist, and which field links each to its parent, is found
 * by describe - nothing is assumed. Status, progress and error fields are
 * picked by name. A record found twice (under the promotion and under its
 * deployment) is shown once, under the deployment.
 *
 * Errors are read from the records' error and result fields and from JSON
 * attachments on them, whatever their shape: Metadata API deploy results
 * (componentFailures) and Copado's own message lists ([{ l, m, t }]) both
 * become { type, fullName, problem, line, column }, for the existing fix advice.
 * Plain Node.js; the Copado access is injected.
 */
const { robustQuery } = require('./copadoInspect');

const JOB = () => ({ obj: 'copado__JobExecution__c', label: 'Job', kids: [{ obj: 'copado__JobStep__c', label: 'Step', kids: [{ obj: 'copado__Result__c', label: 'Result', kids: [] }] }] });
const TREES = [
  JOB(),
  { obj: 'copado__Deployment__c', label: 'Deployment', deployment: true, kids: [{ obj: 'copado__Step__c', label: 'Step', kids: [{ obj: 'copado__Deployment_Job__c', label: 'Job', kids: [] }] }, JOB()] }
];

const clean = id => String(id || '').replace(/[^A-Za-z0-9]/g, '');
const quote = ids => ids.map(i => "'" + clean(i) + "'").join(', ');

/** The field of obj that points at parent: by what it references, else by its name. */
function linkField(fields, parent) {
  const byRef = fields.find(f => Array.isArray(f.referenceTo) && f.referenceTo.includes(parent));
  if (byRef) return byRef.name;
  const byName = fields.find(f => f.name.toLowerCase() === parent.toLowerCase());
  return byName ? byName.name : null;
}

/** Which display fields an object has: status, progress, errors, result data, order. */
function roles(fields) {
  const names = fields.map(f => f.name);
  const one = re => names.find(n => re.test(n)) || null;
  return {
    status: one(/^copado__Status__c$/i) || one(/Status__c$/i),
    progress: one(/Progress(_Status)?__c$/i) || one(/Percent/i),
    error: one(/Error_?Message__c$/i) || one(/Error/i),
    data: names.filter(n => /Result_?Data(_?Json)?__c$|Data_?Json__c$|^copado__Result__c$|Payload|Error_?Details/i.test(n)).slice(0, 3),
    order: one(/(^|_)Order__c$/i),
    type: one(/^copado__Type__c$/i)
  };
}

/** Which job records this Copado has, linked to promotions - found once per session. */
async function discover(api) {
  const out = [];
  for (const tree of TREES) {
    let fields = null;
    try { fields = await api.describe(tree.obj); } catch (e) { fields = null; }
    if (!fields) continue;
    const link = linkField(fields, 'copado__Promotion__c');
    if (!link) continue;
    const node = async (t, f) => {
      const kids = [];
      for (const k of t.kids) {
        let kf = null;
        try { kf = await api.describe(k.obj); } catch (e) { kf = null; }
        const kl = kf && linkField(kf, t.obj);
        if (kf && kl) { const child = await node(k, kf); child.link = kl; kids.push(child); }
      }
      return { obj: t.obj, label: t.label, roles: roles(f), kids };
    };
    const root = await node(tree, fields);
    root.link = link;
    root.deployment = !!tree.deployment;
    out.push(root);
  }
  return out;
}

const state = s => {
  const v = String(s || '');
  if (/fail|error|cancel|abort/i.test(v)) return 'failed';
  if (/success|succeed|complet|done|deployed/i.test(v) && !/not\s+started/i.test(v)) return 'done';
  if (/progress|running|pending|queued|scheduled|started|waiting|in_progress|validat|deploying/i.test(v)) return 'running';
  return v ? 'other' : 'unknown';
};

/** The fields to read for a node: what it has of Id, Name, dates and its roles. */
function select(n) {
  const r = n.roles;
  return [...new Set(['Id', 'Name', 'CreatedDate', 'LastModifiedDate', n.link, r.status, r.progress, r.error, r.order, r.type].concat(r.data).filter(Boolean))];
}

function row(n, rec) {
  const r = n.roles;
  return { id: rec.Id, name: rec.Name || rec.Id, kind: n.label, object: n.obj, status: r.status ? rec[r.status] || '' : '', progress: r.progress ? rec[r.progress] : null,
    error: r.error ? rec[r.error] || '' : '', type: r.type ? rec[r.type] || '' : '', created: rec.CreatedDate, modified: rec.LastModifiedDate,
    data: r.data.map(f => rec[f]).filter(v => typeof v === 'string' && v.trim()), state: state(r.status ? rec[r.status] : '') };
}

/**
 * The newest jobs of a promotion with their steps, as a tree:
 * { jobs: [{ ...row, children: [{ ...row, children }] }], running, finished, failed, objects }.
 */
async function snapshot(api, promotionId, known, opts) {
  const o = opts || {};
  const notes = [];
  const trees = known || await discover(api);
  const jobs = [];
  for (const t of trees) {
    const recs = await robustQuery(api, select(t), t.obj, t.link + " = '" + clean(promotionId) + "'", 'ORDER BY CreatedDate DESC LIMIT ' + (o.limit || 5), notes);
    const level = async (n, parents) => {
      if (!parents.length) return;
      for (const k of n.kids) {
        const kids = await robustQuery(api, select(k), k.obj, k.link + ' IN (' + quote(parents.map(p => p.id)) + ')', 'ORDER BY ' + (k.roles.order ? k.roles.order + ', ' : '') + 'CreatedDate LIMIT 500', notes);
        const rows = kids.map(x => Object.assign(row(k, x), { parent: x[k.link] }));
        for (const p of parents) p.children = (p.children || []).concat(rows.filter(x => x.parent === p.id));
        await level(k, rows);
      }
    };
    const rows = recs.map(x => Object.assign(row(t, x), { deployment: !!t.deployment }));
    await level(t, rows);
    jobs.push(...rows);
  }
  // a job execution found under the promotion and under its deployment: shown once, under the deployment
  const nested = new Set();
  (function walk(list, top) { for (const x of list) { if (!top) nested.add(x.id); walk(x.children || [], false); } })(jobs, true);
  for (let i = jobs.length - 1; i >= 0; i--) if (nested.has(jobs[i].id)) jobs.splice(i, 1);
  jobs.sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
  const all = [];
  (function walk(list) { for (const x of list) { all.push(x); walk(x.children || []); } })(jobs);
  const top = jobs[0] || null;
  return { jobs, objects: trees.map(t => t.obj), all, notes,
    running: !!top && (top.state === 'running' || (top.children || []).some(c => c.state === 'running')),
    failed: !!top && (top.state === 'failed' || all.some(x => x.state === 'failed')), finished: !!top && top.state === 'done' };
}

/** JSON attachments on the job records - where older Copado versions keep each job's result. */
async function attachmentTexts(api, ids, max) {
  if (!ids.length) return [];
  const out = [];
  try {
    const atts = await api.query('SELECT Id, Name, BodyLength FROM Attachment WHERE ParentId IN (' + quote(ids.slice(0, 200)) + ') ORDER BY CreatedDate DESC LIMIT ' + (max || 20));
    for (const a of atts.filter(x => /\.json$/i.test(x.Name || '') && !(x.BodyLength > 5e6))) {
      try { out.push((await api.download('Attachment', a.Id)).toString('utf8')); } catch (e) { /* the next one */ }
    }
  } catch (e) { /* no attachments */ }
  return out;
}

// metadata types an error line may start with, to tell a component error from any other message
const TYPES = 'ApexClass|ApexTrigger|ApexPage|ApexComponent|AuraDefinitionBundle|LightningComponentBundle|CustomObject|CustomField|CustomMetadata|CustomLabels|CustomTab|CustomApplication|CustomPermission|Flow|FlexiPage|Layout|ListView|PermissionSet|PermissionSetGroup|Profile|QuickAction|RecordType|StaticResource|ValidationRule|WebLink|CompactLayout|FieldSet|GlobalValueSet|StandardValueSet|Workflow|ApprovalProcess|EmailTemplate|Report|Dashboard|NamedCredential|RemoteSiteSetting|Group|Queue|Role|SharingRules';
const LINE = new RegExp('^\\s*\\[?(' + TYPES + ')\\]?[\\s:,]+([^\\s:,][^:,]*?)\\s*(?:[:\\-\\u2013]\\s+|\\s+-\\s+)(.+)$');
// Copado's own form: "Type:Name:problem", lines joined by a literal \n, often after a "Metadata Validation - " heading
const COLON = new RegExp('^\\s*(' + TYPES + '):([^:\\s,][^:,]*):\\s*(.+)$');
// "Type : Name, Type : Name, ..." - a component list, as Copado writes what it deployed
const LIST = new RegExp('(?:^|,)\\s*(?:' + TYPES + ')\\s*:\\s*[^,:]+(?=,|$)', 'g');
const isList = l => (String(l).match(LIST) || []).length >= 2;

/** Component errors in any text or JSON Copado keeps. */
function componentErrors(texts) {
  const out = [];
  const add = (type, fullName, problem, line, column) => {
    if (!type || !fullName || !problem) return;
    const m = /line[:\s]+(\d+)(?:[,\s]+col(?:umn)?[:\s]+(\d+))?/i.exec(problem);
    out.push({ type, fullName: String(fullName).trim(), problem: String(problem).trim(), problemType: 'Error', fileName: '',
      line: line != null ? Number(line) || null : m ? Number(m[1]) : null, column: column != null ? Number(column) || null : m && m[2] ? Number(m[2]) : null });
  };
  const fromLine = s => {
    for (const raw of String(s).replace(/\\n/g, '\n').split(/\r?\n/)) {
      const l = raw.replace(/^\s*[A-Z][\w ]{2,40}? - (?=\w+:)/, '');
      if (isList(l)) continue;
      const m = COLON.exec(l) || LINE.exec(l);
      if (m) add(m[1], m[2], m[3]);
    }
  };
  const walk = (v, depth) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') { fromLine(v); return; }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (typeof v !== 'object') return;
    if ((v.componentType || v.type) && v.fullName && (v.problem || v.error)) { add(v.componentType || v.type, v.fullName, v.problem || v.error, v.lineNumber, v.columnNumber); return; }
    if (typeof v.m === 'string' && ('l' in v || 't' in v)) { if (!/^(INFO|DEBUG)$/i.test(v.l || '')) fromLine(v.m); return; }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  for (const t of texts) {
    let parsed = null;
    try { parsed = JSON.parse(String(t).replace(/^\uFEFF/, '')); } catch (e) { parsed = null; }
    walk(parsed != null ? parsed : String(t), 0);
  }
  // the same error is often kept twice - cut short in a field, whole in a file: keep it once, with its fullest text
  const by = new Map();
  for (const f of out) {
    const k = [f.type, f.fullName, f.line].join('|').toLowerCase();
    const had = by.get(k);
    if (!had) by.set(k, f);
    else if (f.problem !== had.problem && !had.problem.startsWith(f.problem) && !f.problem.startsWith(had.problem)) by.set(k + '|' + f.problem, f);
    else if (f.problem.length > had.problem.length) by.set(k, f);
  }
  return [...by.values()];
}

/** Text files (Copado's "Error Details") linked to the records. */
async function fileTexts(api, ids, max) {
  if (!ids.length) return [];
  const out = [];
  try {
    const links = await api.query('SELECT LinkedEntityId, ContentDocument.Title, ContentDocument.LatestPublishedVersionId, ContentDocument.ContentSize FROM ContentDocumentLink WHERE LinkedEntityId IN (' + quote(ids.slice(0, 100)) + ')');
    for (const l of links.slice(0, max || 10)) {
      const d = l.ContentDocument || {};
      if (!d.LatestPublishedVersionId || d.ContentSize > 5e6) continue;
      try { out.push((await api.download('ContentVersion', d.LatestPublishedVersionId)).toString('utf8')); } catch (e) { /* the next one */ }
    }
  } catch (e) { /* no files */ }
  return out;
}

/** The records of one run, flat. */
const flat = run => { const all = []; (function walk(list) { for (const x of list) { all.push(x); walk(x.children || []); } })([run]); return all; };

/**
 * The errors of the newest run only - an earlier run's errors are history,
 * not the current problem: its records' error and data fields, their JSON
 * attachments and their linked files.
 */
async function errorsOf(api, snap) {
  const run = snap.jobs[0];
  if (!run) return [];
  // a run that succeeded has no errors, whatever its records say about what they deployed
  const failed = flat(run).filter(x => x.state === 'failed');
  if (!failed.length) return [];
  const ids = failed.map(x => x.id);
  const texts = failed.flatMap(x => [x.error].concat(x.data)).filter(Boolean);
  texts.push(...await attachmentTexts(api, ids), ...await fileTexts(api, ids));
  return componentErrors(texts);
}

/**
 * Whether Copado has validated (or deployed) the promotion since a moment:
 * the newest validation or deployment run created after it - a deployment
 * record, or a job whose name or type says deploy or validate. A merge job
 * succeeding is not a validation. Returns { state: done | failed | running | none, run }.
 */
function validationSince(snap, sinceIso) {
  const since = Date.parse(sinceIso) || 0;
  const says = x => /deploy|validat/i.test([x.name, x.type, x.kind].join(' '));
  const runs = snap.jobs.filter(j => (Date.parse(j.created) || 0) > since && (j.deployment || flat(j).some(says)));
  const run = runs[0];
  if (!run) return { state: 'none', run: null };
  const recs = flat(run);
  if (recs.some(x => x.state === 'failed')) return { state: 'failed', run };
  if (run.state === 'done' && !recs.some(x => x.state === 'running')) return { state: 'done', run };
  return { state: 'running', run };
}

module.exports = { discover, snapshot, errorsOf, validationSince, componentErrors, linkField, roles, state, TREES };
