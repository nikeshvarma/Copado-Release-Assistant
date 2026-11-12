'use strict';

/**
 * Phase 0: a read-only look at what a Copado org holds for one user story -
 * the story, its commits and their files, its metadata records, its promotions
 * and their attachments, the pipeline and environments - so later features are
 * built on what is really there, not on guesses.
 *
 * The Salesforce access is injected:
 *   api.describe(sobject)  -> [{ name, relationshipName }]      (null if the object does not exist)
 *   api.query(soql)        -> [records]                           (throws { message } on errors)
 *   api.download(kind, id) -> Buffer   kind: 'Attachment' | 'ContentVersion'
 * Nothing is ever written.
 */

const { decodeFileName } = require('./selective');

// names that look like keys or secrets: never opened, whatever the limits
const SENSITIVE = /(^|[\/\s._-])(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$|\.(pem|key|p12|pfx|jks|keystore|ppk)$|(password|passwd|secret|credential|token|private[_ -]?key)/i;

/** The shape of a JSON value - key names and counts only, never values. */
function shapeOf(v, depth) {
  if (Array.isArray(v)) {
    const objs = v.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (!objs.length) return 'array of ' + v.length + (v.length ? ' ' + typeof v[0] + 's' : '');
    const keys = [...new Set(objs.slice(0, 25).flatMap(o => Object.keys(o)))];
    return 'array of ' + v.length + ' objects {' + keys.slice(0, 14).map(k => k + inner(objs.find(o => k in o)[k], depth)).join(', ') + (keys.length > 14 ? ', \u2026' : '') + '}';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return 'object {' + keys.slice(0, 14).map(k => k + inner(v[k], depth)).join(', ') + (keys.length > 14 ? ', \u2026 ' + keys.length + ' keys' : '') + '}';
  }
  return typeof v;
}
function inner(x, depth) {
  if ((depth || 0) >= 1) return Array.isArray(x) ? '[\u2026]' : x && typeof x === 'object' ? '{\u2026}' : '';
  return Array.isArray(x) || (x && typeof x === 'object') ? ': ' + shapeOf(x, (depth || 0) + 1) : '';
}

const WANT = {
  story: ['Id', 'Name', 'copado__User_Story_Title__c', 'copado__Status__c', 'copado__Environment__c', 'copado__Environment__r.Name',
    'copado__Org_Credential__c', 'copado__Project__c', 'copado__Project__r.Name', 'copado__Project__r.copado__Deployment_Flow__c',
    'copado__Release__c', 'copado__Release__r.Name', 'copado__Base_Branch__c', 'copado__Release__r.copado__Base_Branch__c', 'LastModifiedDate'],
  commit: ['Id', 'Name', 'CreatedDate', 'copado__External_Id__c', 'copado__Snapshot_Commit__c', 'copado__Snapshot_Commit__r.Name',
    'copado__Snapshot_Commit__r.copado__Commit_Id__c', 'copado__Snapshot_Commit__r.copado__Commit_Message__c',
    'copado__Snapshot_Commit__r.copado__Commit_Date__c', 'copado__Snapshot_Commit__r.copado__Status__c'],
  metadata: ['Id', 'Name', 'copado__Metadata_API_Name__c', 'copado__Type__c', 'copado__Action__c', 'copado__Status__c', 'copado__Last_Commit_Date__c'],
  promoted: ['Id', 'Name', 'CreatedDate', 'copado__Status__c', 'copado__Promotion__c', 'copado__Promotion__r.Name', 'copado__Promotion__r.copado__Status__c',
    'copado__Promotion__r.copado__Source_Environment__r.Name', 'copado__Promotion__r.copado__Destination_Environment__r.Name',
    'copado__Promotion__r.copado__Destination_Environment__c', 'copado__Promotion__r.copado__Source_Environment__c'],
  pipeline: ['Id', 'Name', 'copado__Git_Repository__c', 'copado__Git_Repository__r.Name', 'copado__Main_Branch__c'],
  step: ['Id', 'copado__Branch__c', 'copado__Destination_Branch__c', 'copado__Source_Environment__c', 'copado__Source_Environment__r.Name',
    'copado__Destination_Environment__c', 'copado__Destination_Environment__r.Name'],
  credential: ['Id', 'Name', 'copado__Username__c', 'copado__Environment__c', 'copado__Environment__r.Name', 'copado__Org_Type__c']
};

const OBJECTS = {
  story: 'copado__User_Story__c', commit: 'copado__User_Story_Commit__c', metadata: 'copado__User_Story_Metadata__c',
  promoted: 'copado__Promoted_User_Story__c', pipeline: 'copado__Deployment_Flow__c', step: 'copado__Deployment_Flow_Step__c',
  credential: 'copado__Org__c'
};

/** "US-0012345", "12345" or a record id; anything else is refused before it reaches a query. */
function parseStoryRef(input) {
  const s = String(input || '').trim();
  if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s) && /\d/.test(s) && !/^\d+$/.test(s)) return { kind: 'id', value: s };
  const m = /^(?:US-?)?0*(\d{1,9})$/i.exec(s);
  if (m) return { kind: 'number', value: Number(m[1]), digits: m[1] };
  return null;
}

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

const get = (rec, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), rec);
const quote = ids => ids.map(i => "'" + String(i).replace(/[^A-Za-z0-9]/g, '') + "'").join(', ');

/** What a downloaded file turns out to be - only a label, never its content. */
function classify(buf) {
  const text = buf.toString('utf8');
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const v = JSON.parse(t);
      const rows = Array.isArray(v) ? v : null;
      if (rows && rows.length && rows.every(r => r && typeof r === 'object' && 't' in r && 'n' in r)) {
        const actions = {};
        rows.forEach(r => { actions[r.a || '?'] = (actions[r.a || '?'] || 0) + 1; });
        const selective = rows.filter(r => r.a === 'SelectiveCommit').length;
        return { kind: 'commit-json', label: 'Copado commit file - ' + rows.length + ' rows (' + Object.entries(actions).map(([a, n]) => a + ' ' + n).join(', ') + ')', rows: rows.length, selective };
      }
      return { kind: 'json', label: 'JSON - ' + shapeOf(v, 0) };
    } catch (e) { return { kind: 'text', label: 'text (not valid JSON)' }; }
  }
  const markers = (text.match(/^<{7}( |$)/gm) || []).length;
  const root = /<([A-Za-z_][\w.:-]*)[\s>/]/.exec(t.replace(/<\?[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, ''));
  if (markers) {
    const a = /^<{7} (.*)$/m.exec(text), b = /^>{7} (.*)$/m.exec(text), base = /^\|{7}( |$)/m.test(text);
    return { kind: 'conflict', markers, label: 'conflicted file - ' + markers + ' git conflict block' + (markers === 1 ? '' : 's') + (root ? ' in <' + root[1] + '>' : '') +
      (a || b ? ' (sides "' + (a ? a[1].trim() : '?') + '" and "' + (b ? b[1].trim() : '?') + '"' + (base ? ', with the common ancestor' : '') + ')' : '') };
  }
  if (root && t.startsWith('<')) return { kind: 'xml', label: 'metadata XML <' + root[1] + '>' };
  return { kind: 'other', label: 'other content' };
}

async function inspect(ref, api, opts) {
  const o = Object.assign({ peekLimit: 15, peekMaxBytes: 3 * 1024 * 1024, localOrgs: [] }, opts || {});
  const notes = [];
  const out = { ref, notes, objects: {}, files: [], story: null };

  // which Copado objects exist here, and with which of the fields we would like
  const sel = {};
  for (const [k, obj] of Object.entries(OBJECTS)) {
    let fields = null;
    try { fields = await api.describe(obj); } catch (e) { notes.push(obj + ': ' + e.message); }
    out.objects[k] = fields ? { name: obj, fields: fields.length, all: fields.map(f => f.name).sort() } : { name: obj, missing: true };
    sel[k] = fields ? available(fields, WANT[k]) : null;
  }
  if (!sel.story) throw new Error('This org has no Copado user stories (' + OBJECTS.story + ' is not available). Is cmr.copado.org the org where Copado runs?');

  // the story
  const where = ref.kind === 'id' ? "Id = '" + ref.value.replace(/[^A-Za-z0-9]/g, '') + "'" : "Name LIKE '%" + ref.digits + "'";
  const stories = (await robustQuery(api, sel.story, OBJECTS.story, where, 'ORDER BY Name LIMIT 20', notes))
    .filter(s => ref.kind === 'id' || Number(String(s.Name).replace(/\D/g, '')) === ref.value);
  if (!stories.length) throw new Error('No user story ' + (ref.kind === 'id' ? ref.value : 'number ' + ref.value) + ' in this org.');
  const s = stories[0];
  out.story = {
    id: s.Id, name: s.Name, title: get(s, 'copado__User_Story_Title__c'), status: get(s, 'copado__Status__c'),
    environment: get(s, 'copado__Environment__r.Name'), environmentId: get(s, 'copado__Environment__c'),
    project: get(s, 'copado__Project__r.Name'), pipelineId: get(s, 'copado__Project__r.copado__Deployment_Flow__c'),
    release: get(s, 'copado__Release__r.Name'), baseBranch: get(s, 'copado__Base_Branch__c') || get(s, 'copado__Release__r.copado__Base_Branch__c')
  };

  // commits
  out.commits = sel.commit ? (await robustQuery(api, sel.commit, OBJECTS.commit, "copado__User_Story__c = '" + s.Id + "'", 'ORDER BY CreatedDate DESC LIMIT 20', notes)).map(c => ({
    id: c.Id, name: c.Name, created: c.CreatedDate, snapshotId: get(c, 'copado__Snapshot_Commit__c'),
    sha: get(c, 'copado__Snapshot_Commit__r.copado__Commit_Id__c'), message: get(c, 'copado__Snapshot_Commit__r.copado__Commit_Message__c'),
    status: get(c, 'copado__Snapshot_Commit__r.copado__Status__c')
  })) : [];

  // metadata records
  if (sel.metadata) {
    const md = await robustQuery(api, sel.metadata, OBJECTS.metadata, "copado__User_Story__c = '" + s.Id + "'", 'LIMIT 2000', notes);
    const byType = {};
    md.forEach(r => { const t = get(r, 'copado__Type__c') || '?'; byType[t] = (byType[t] || 0) + 1; });
    out.metadata = { count: md.length, byType, sample: md.slice(0, 5).map(r => ({ name: get(r, 'copado__Metadata_API_Name__c') || r.Name, type: get(r, 'copado__Type__c'), action: get(r, 'copado__Action__c'), status: get(r, 'copado__Status__c') })) };
  }

  // promotions
  out.promotions = sel.promoted ? (await robustQuery(api, sel.promoted, OBJECTS.promoted, "copado__User_Story__c = '" + s.Id + "'", 'ORDER BY CreatedDate DESC LIMIT 10', notes)).map(p => ({
    id: get(p, 'copado__Promotion__c'), name: get(p, 'copado__Promotion__r.Name'), status: get(p, 'copado__Promotion__r.copado__Status__c') || get(p, 'copado__Status__c'),
    from: get(p, 'copado__Promotion__r.copado__Source_Environment__r.Name'), to: get(p, 'copado__Promotion__r.copado__Destination_Environment__r.Name'),
    fromId: get(p, 'copado__Promotion__r.copado__Source_Environment__c'), toId: get(p, 'copado__Promotion__r.copado__Destination_Environment__c'), created: p.CreatedDate
  })).filter(p => p.id) : [];

  // pipeline, its branches, and the Git repository
  if (out.story.pipelineId && sel.pipeline) {
    const pl = await robustQuery(api, sel.pipeline, OBJECTS.pipeline, "Id = '" + out.story.pipelineId + "'", 'LIMIT 1', notes);
    if (pl[0]) out.pipeline = { id: pl[0].Id, name: pl[0].Name, repoId: get(pl[0], 'copado__Git_Repository__c'), repo: get(pl[0], 'copado__Git_Repository__r.Name'), mainBranch: get(pl[0], 'copado__Main_Branch__c') };
    if (out.pipeline && sel.step) {
      out.pipeline.steps = (await robustQuery(api, sel.step, OBJECTS.step, "copado__Deployment_Flow__c = '" + out.pipeline.id + "'", 'LIMIT 50', notes)).map(st => ({
        from: get(st, 'copado__Source_Environment__r.Name'), fromId: get(st, 'copado__Source_Environment__c'), branch: get(st, 'copado__Branch__c'),
        to: get(st, 'copado__Destination_Environment__r.Name'), toId: get(st, 'copado__Destination_Environment__c'), toBranch: get(st, 'copado__Destination_Branch__c')
      }));
    }
  }

  // where the story goes next: the pipeline step leaving its environment
  const next = out.pipeline && out.pipeline.steps && out.pipeline.steps.find(st => st.fromId && st.fromId === out.story.environmentId);
  if (next) out.story.next = { id: next.toId, name: next.to, branch: next.branch };

  // environments -> org credentials -> logins on this machine
  const envIds = [...new Set([out.story.environmentId, next && next.toId].concat(out.promotions.flatMap(p => [p.fromId, p.toId])).filter(Boolean))];
  out.credentials = envIds.length && sel.credential
    ? (await robustQuery(api, sel.credential, OBJECTS.credential, 'copado__Environment__c IN (' + quote(envIds) + ')', 'LIMIT 50', notes)).map(c => {
        const user = get(c, 'copado__Username__c');
        const local = o.localOrgs.find(l => user && l.username && l.username.toLowerCase() === String(user).toLowerCase());
        return { name: c.Name, environment: get(c, 'copado__Environment__r.Name'), environmentId: get(c, 'copado__Environment__c'), username: user, type: get(c, 'copado__Org_Type__c'), localAlias: local ? (local.alias || local.username) : null };
      })
    : [];

  // files and attachments on the story, its commits, its promotions and the repository
  const owners = [['User Story', [s.Id]], ['User Story Commit', out.commits.map(c => c.id)], ['Snapshot Commit', out.commits.map(c => c.snapshotId).filter(Boolean)],
    ['Promotion', out.promotions.map(p => p.id)], ['Git Repository', out.pipeline && out.pipeline.repoId ? [out.pipeline.repoId] : []]];
  for (const [label, ids] of owners) {
    if (!ids.length || (o.only && !o.only.includes(label))) continue;
    const limit = label === 'Git Repository' ? 20 : 200;
    try {
      for (const a of await api.query('SELECT Id, Name, ContentType, BodyLength, ParentId, CreatedDate FROM Attachment WHERE ParentId IN (' + quote(ids) + ') ORDER BY CreatedDate DESC LIMIT ' + limit)) {
        out.files.push({ on: label, parentId: a.ParentId, store: 'Attachment', id: a.Id, name: a.Name, size: a.BodyLength, created: a.CreatedDate });
      }
    } catch (e) { notes.push('attachments on ' + label + ': ' + e.message); }
    try {
      for (const l of await api.query('SELECT ContentDocumentId, LinkedEntityId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.ContentSize, ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId IN (' + quote(ids) + ') LIMIT ' + limit)) {
        const d = l.ContentDocument || {};
        out.files.push({ on: label, parentId: l.LinkedEntityId, store: 'File', id: d.LatestPublishedVersionId, name: d.Title + (d.FileExtension ? '.' + d.FileExtension : ''), size: d.ContentSize, created: d.CreatedDate });
      }
    } catch (e) { notes.push('files on ' + label + ': ' + e.message); }
  }

  // look inside a few small files - to label them, nothing more
  // which record each file is on
  const recordName = new Map([[s.Id, s.Name]].concat(out.commits.map(c => [c.id, c.name]), out.promotions.map(p => [p.id, p.name]), out.pipeline && out.pipeline.repoId ? [[out.pipeline.repoId, out.pipeline.repo]] : []));
  out.files.forEach(f => { f.record = recordName.get(f.parentId) || ''; });
  // the files that explain the rest are opened first: one resolution manifest and one promotion change list
  const firstOf = re => out.files.find(f => re.test(f.name || ''));
  const order = [firstOf(/GitConflictsResolution/i), firstOf(/Promotion changes/i)].filter(Boolean);
  order.push(...out.files.filter(f => !order.includes(f)));
  let peeked = 0;
  for (const f of order) {
    if (SENSITIVE.test(f.name || '')) { f.what = { kind: 'sensitive', label: 'never opened - the name looks like a key or credential' }; continue; }
    const sel = decodeFileName(f.name || '');
    if (sel) f.selective = sel.type + ' ' + sel.name;
    if (peeked >= o.peekLimit || !f.id || (f.size && f.size > o.peekMaxBytes)) continue;
    peeked++;
    try {
      const buf = await api.download(f.store === 'File' ? 'ContentVersion' : 'Attachment', f.id);
      f.what = classify(buf);
      if (f.selective) f.what = { kind: 'selective', label: 'selective-commit file for ' + f.selective + ' (' + f.what.label + ')', root: f.what.label };
      if (o.keepContent && (f.what.kind === 'commit-json' || f.what.kind === 'selective')) f.content = buf;
    } catch (e) { f.what = { kind: 'error', label: 'could not read: ' + String(e.message).replace(/\s+/g, ' ').slice(0, 160) }; }
  }

  out.findings = findings(out);
  return out;
}

/** What the inspection means for the next features. */
function findings(out) {
  const f = [];
  const commitFiles = out.files.filter(x => x.what && x.what.kind === 'commit-json');
  if (commitFiles.length) f.push(['ok', 'Commit file: found as ' + commitFiles.map(x => (x.store === 'File' ? 'a File' : 'an Attachment') + ' "' + x.name + '" on the ' + x.on).join('; ') + '.']);
  else if (out.metadata && out.metadata.count) f.push(['warn', 'No commit file found; the ' + out.metadata.count + ' User Story Metadata records could be used to build the package instead.']);
  else f.push(['warn', 'No commit file and no metadata records found for this story.']);
  const sel = out.files.filter(x => x.selective);
  if (sel.length) f.push(['ok', 'Selective-commit files: ' + sel.length + ' on the ' + [...new Set(sel.map(x => x.on))].join(' and ') + ', named "<hash>_commit" - e.g. ' + sel[0].selective + '.']);
  const secrets = out.files.filter(x => x.what && x.what.kind === 'sensitive');
  if (secrets.length) f.push(['warn', secrets.length + ' attachment' + (secrets.length === 1 ? '' : 's') + ' on the ' + [...new Set(secrets.map(x => x.on))].join(' and ') + ' look like keys or credentials (' + secrets.map(x => x.name).join(', ') + '). They were not opened. Anyone who can read that record can download them - worth raising with your Copado admin.']);
  const conflicts = out.files.filter(x => x.what && x.what.kind === 'conflict');
  const resolved = out.files.filter(x => /resolved/i.test(x.name || ''));
  if (conflicts.length) f.push(['ok', 'Conflicted files: ' + conflicts.length + ' with git conflict markers, on the ' + [...new Set(conflicts.map(x => x.on))].join(' and ') + ' - e.g. "' + conflicts[0].name + '".']);
  if (resolved.length) f.push(['ok', 'Resolutions: ' + resolved.length + ' attachment' + (resolved.length === 1 ? '' : 's') + ' named like "' + resolved[0].name + '", on the ' + [...new Set(resolved.map(x => x.on))].join(' and ') + '.']);
  if (!conflicts.length && !resolved.length) f.push(['info', 'No conflict or resolution files on this story\u2019s promotions - inspect a story that had a merge conflict to see how Copado stores them.']);
  for (const c of out.credentials) f.push([c.localAlias ? 'ok' : 'warn', 'Environment ' + (c.environment || c.name) + ': ' + (c.localAlias ? 'logged in on this machine as ' + c.localAlias : 'no Salesforce CLI login on this machine for its org credential') + '.']);
  if (out.pipeline && out.pipeline.steps && out.pipeline.steps.length) f.push(['info', 'Pipeline ' + out.pipeline.name + ': ' + out.pipeline.steps.map(st => (st.from || '?') + ' (' + (st.branch || '?') + ') \u2192 ' + (st.to || '?')).join(', ') + '.']);
  return f;
}

/** The inspection as a Markdown report. */
function report(out) {
  const L = [];
  const icon = k => ({ ok: '\u2705', warn: '\u26a0\ufe0f', info: '\u2139\ufe0f' })[k] || '\u2022';
  const s = out.story;
  L.push('# Copado inspection: ' + s.name, '', '> Read-only. Generated by Copado Release Assistant. Nothing in Copado was changed.', '');
  L.push('## What this means', '', ...out.findings.map(([k, t]) => '- ' + icon(k) + ' ' + t), '');
  L.push('## User story', '', '| | |', '| --- | --- |');
  for (const [k, v] of [['Title', s.title], ['Status', s.status], ['Environment', s.environment], ['Project', s.project], ['Release', s.release], ['Base branch', s.baseBranch]]) if (v) L.push('| ' + k + ' | ' + v + ' |');
  L.push('', '## Commits (' + out.commits.length + ')', '');
  if (out.commits.length) { L.push('| Commit | Date | Git commit | Status |', '| --- | --- | --- | --- |'); out.commits.forEach(c => L.push('| ' + c.name + ' | ' + (c.created || '').slice(0, 10) + ' | ' + (c.sha ? c.sha.slice(0, 10) : '') + ' | ' + (c.status || '') + ' |')); }
  if (out.metadata) {
    L.push('', '## User Story Metadata (' + out.metadata.count + ' records)', '', Object.entries(out.metadata.byType).map(([t, n]) => t + ' ' + n).join(' \u00b7 ') || 'none');
  }
  L.push('', '## Promotions (' + out.promotions.length + ')', '');
  if (out.promotions.length) { L.push('| Promotion | Status | From | To |', '| --- | --- | --- | --- |'); out.promotions.forEach(p => L.push('| ' + p.name + ' | ' + (p.status || '') + ' | ' + (p.from || '') + ' | ' + (p.to || '') + ' |')); }
  L.push('', '## Files and attachments (' + out.files.length + ')', '');
  if (out.files.length) {
    L.push('| On | Record | Kind | Name | Size | What it is |', '| --- | --- | --- | --- | --- | --- |');
    out.files.forEach(x => L.push('| ' + x.on + ' | ' + (x.record || '') + ' | ' + x.store + ' | ' + String(x.name).replace(/\|/g, '\\|') + ' | ' + (x.size != null ? x.size + ' B' : '') + ' | ' + (x.what ? x.what.label : 'not opened') + ' |'));
  }
  if (out.pipeline) {
    L.push('', '## Pipeline ' + out.pipeline.name, '', 'Repository: ' + (out.pipeline.repo || '?') + (out.pipeline.mainBranch ? ' \u00b7 main branch ' + out.pipeline.mainBranch : ''), '');
    if (out.pipeline.steps && out.pipeline.steps.length) { L.push('| From | Branch | To |', '| --- | --- | --- |'); out.pipeline.steps.forEach(st => L.push('| ' + (st.from || '') + ' | ' + (st.branch || '') + ' | ' + (st.to || '') + ' |')); }
  }
  L.push('', '## Environments and logins', '');
  if (out.credentials.length) { L.push('| Environment | Org credential | Username | This machine |', '| --- | --- | --- | --- |'); out.credentials.forEach(c => L.push('| ' + (c.environment || '') + ' | ' + c.name + ' | ' + (c.username || '') + ' | ' + (c.localAlias || '\u2014') + ' |')); }
  L.push('', '## Copado objects in this org', '');
  for (const o of Object.values(out.objects)) L.push('- `' + o.name + '`: ' + (o.missing ? 'not available' : o.fields + ' fields'));
  if (out.notes.length) L.push('', '## Notes', '', ...out.notes.map(n => '- ' + n));
  return L.join('\n') + '\n';
}

module.exports = { parseStoryRef, available, inspect, report, classify, robustQuery, OBJECTS };
