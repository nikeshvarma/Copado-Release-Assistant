'use strict';

/**
 * The release lifecycle as Copado records it, read-only: the pipeline's
 * environments and branches, who logs in where, a story's journey through the
 * stages, the components each story changed, back-promotions, hotfixes, the
 * feature branch and the repository's address.
 *
 * Every query goes through describe first and robustQuery after, because the
 * fields differ between Copado versions. The Copado access is injected:
 *   api.describe(sobject) -> [{ name, relationshipName, type?, referenceTo? }] | null
 *   api.query(soql)       -> [records]
 *   api.download(kind, id) -> Buffer
 * Nothing is ever written. Plain Node.js.
 */
const { robustQuery, available } = require('./copadoInspect');
const { limiter } = require('./copadoClient');

const OBJ = {
  flow: 'copado__Deployment_Flow__c', step: 'copado__Deployment_Flow_Step__c', promotion: 'copado__Promotion__c',
  promoted: 'copado__Promoted_User_Story__c', story: 'copado__User_Story__c', commit: 'copado__User_Story_Commit__c',
  metadata: 'copado__User_Story_Metadata__c', credential: 'copado__Org__c', repo: 'copado__Git_Repository__c'
};

const clean = id => String(id || '').replace(/[^A-Za-z0-9]/g, '');
const quote = ids => ids.map(i => "'" + clean(i) + "'").join(', ');
const get = (rec, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), rec);
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

/** A promotion or story status that is still moving: not completed, not cancelled. */
const isOpen = status => !/complet|cancel/i.test(String(status || ''));
/** A status that stops a story until someone acts: a merge conflict, a failure, an error. */
const isBlocking = status => /conflict|fail|error|reject/i.test(String(status || '')) && !/resolved/i.test(String(status || ''));

/** A query of the fields this org has; an object it does not have gives no rows, and a note. */
async function q(api, obj, wanted, where, tail, notes) {
  let fields = null;
  try { fields = await api.describe(obj); } catch (e) { (notes || []).push(obj + ': ' + e.message); return []; }
  if (!fields) { (notes || []).push(obj + ' is not in this org'); return []; }
  const sel = available(fields, wanted);
  if (!sel.length) return [];
  return robustQuery(api, sel, obj, where, tail, notes || []);
}

/** The field marking a back-promotion on copado__Promotion__c, if this Copado version has one. */
async function backPromotionField(api) {
  let fields = null;
  try { fields = await api.describe(OBJ.promotion); } catch (e) { return null; }
  const f = (fields || []).find(x => /(^|__)Back_?Promotion(__c)?$/i.test(x.name) && (!x.type || x.type === 'boolean'));
  return f ? f.name : null;
}

const PROMO_FIELDS = ['Id', 'Name', 'copado__Status__c', 'copado__Source_Environment__c', 'copado__Source_Environment__r.Name',
  'copado__Destination_Environment__c', 'copado__Destination_Environment__r.Name', 'CreatedDate', 'LastModifiedDate',
  'copado__Project__c', 'copado__Project__r.copado__Deployment_Flow__c', 'copado__Release__c', 'copado__Release__r.Name'];

function promotionOf(p, backField) {
  return { id: p.Id, name: p.Name, status: p.copado__Status__c || '', from: get(p, 'copado__Source_Environment__r.Name'), to: get(p, 'copado__Destination_Environment__r.Name'),
    fromId: p.copado__Source_Environment__c, toId: p.copado__Destination_Environment__c, created: p.CreatedDate, modified: p.LastModifiedDate || p.CreatedDate,
    pipelineId: get(p, 'copado__Project__r.copado__Deployment_Flow__c') || null, release: get(p, 'copado__Release__r.Name') || null,
    backFlag: backField ? !!p[backField] : null };
}

/* ------------------------------------------------------------ the pipeline */

async function pipelines(api, notes) {
  const rows = await q(api, OBJ.flow, ['Id', 'Name', 'copado__Active__c', 'copado__Git_Repository__c', 'copado__Main_Branch__c'], '', 'ORDER BY Name LIMIT 50', notes);
  return rows.map(r => ({ id: r.Id, name: r.Name, active: r.copado__Active__c !== false, repoId: r.copado__Git_Repository__c || null, mainBranch: r.copado__Main_Branch__c || null }));
}

/**
 * The pipeline as a map: environments with their branch and stage (0 for the
 * first ones, rising towards production), and the steps between them.
 */
async function pipeline(api, id, notes) {
  const n = notes || [];
  const flow = (await q(api, OBJ.flow, ['Id', 'Name', 'copado__Git_Repository__c', 'copado__Git_Repository__r.Name', 'copado__Main_Branch__c'], "Id = '" + clean(id) + "'", 'LIMIT 1', n))[0];
  if (!flow) throw new Error('No Copado pipeline ' + id + ' in this org.');
  const steps = (await q(api, OBJ.step, ['Id', 'copado__Branch__c', 'copado__Destination_Branch__c', 'copado__Source_Environment__c', 'copado__Source_Environment__r.Name',
    'copado__Destination_Environment__c', 'copado__Destination_Environment__r.Name'], "copado__Deployment_Flow__c = '" + clean(flow.Id) + "'", 'LIMIT 200', n)).map(s => ({
    id: s.Id, fromId: s.copado__Source_Environment__c, from: get(s, 'copado__Source_Environment__r.Name'), branch: s.copado__Branch__c || null,
    toId: s.copado__Destination_Environment__c, to: get(s, 'copado__Destination_Environment__r.Name'), toBranch: s.copado__Destination_Branch__c || null
  })).filter(s => s.fromId && s.toId);
  return build({ id: flow.Id, name: flow.Name, repoId: flow.copado__Git_Repository__c || null, repo: get(flow, 'copado__Git_Repository__r.Name') || null, mainBranch: flow.copado__Main_Branch__c || null }, steps);
}

/** Pure: the map from the pipeline record and its steps. */
function build(flow, steps) {
  const envs = new Map();
  const env = (id, name) => { if (!envs.has(id)) envs.set(id, { id, name: name || id, branch: null, out: [], in: [], stage: 0 }); const e = envs.get(id); if (name && e.name === id) e.name = name; return e; };
  for (const s of steps) {
    const a = env(s.fromId, s.from), b = env(s.toId, s.to);
    if (s.branch) a.branch = s.branch;
    if (s.toBranch && !b.branch) b.branch = s.toBranch;
    a.out.push(s.toId); b.in.push(s.fromId);
  }
  // stage: the longest way from a starting environment; a cycle cannot loop forever
  for (let round = 0, changed = true; changed && round < envs.size + 1; round++) {
    changed = false;
    for (const s of steps) { const a = envs.get(s.fromId), b = envs.get(s.toId); if (b.stage < a.stage + 1) { b.stage = a.stage + 1; changed = true; } }
  }
  const finals = [...envs.values()].filter(e => !e.out.length);
  const production = finals.sort((a, b) => b.stage - a.stage || (b.in.length - a.in.length))[0] || null;
  if (production && !production.branch) production.branch = flow.mainBranch || null;
  const order = [...envs.values()].sort((a, b) => a.stage - b.stage || a.name.localeCompare(b.name));
  const stages = [];
  for (const e of order) (stages[e.stage] = stages[e.stage] || []).push(e.id);
  return Object.assign({}, flow, { steps, envs: Object.fromEntries([...envs].map(([k, v]) => [k, v])), order: order.map(e => e.id), stages, productionId: production ? production.id : null,
    productionBranch: production ? production.branch || flow.mainBranch : flow.mainBranch });
}

/** True when b can be reached from a along the pipeline's steps. */
function reaches(map, a, b) {
  if (!map || !map.envs[a] || !map.envs[b] || a === b) return false;
  const seen = new Set([a]), todo = [a];
  while (todo.length) { for (const n of map.envs[todo.shift()].out) { if (n === b) return true; if (!seen.has(n)) { seen.add(n); todo.push(n); } } }
  return false;
}

/** A back-promotion: Copado's own flag when it has one, otherwise a destination that sits before the source in the pipeline. */
function isBackPromotion(p, map) {
  if (p.backFlag === true) return true;
  if (p.backFlag === false) return false;
  return !!(map && reaches(map, p.toId, p.fromId));
}

/** The pipeline a promotion, story or environment belongs to. */
async function pipelineIdFor(api, o, notes) {
  if (o.pipelineId) return o.pipelineId;
  const envs = [o.toId, o.fromId, o.envId].filter(Boolean);
  if (!envs.length) return null;
  const rows = await q(api, OBJ.step, ['Id', 'copado__Deployment_Flow__c'], 'copado__Destination_Environment__c IN (' + quote(envs) + ') OR copado__Source_Environment__c IN (' + quote(envs) + ')', 'LIMIT 5', notes);
  return rows[0] ? rows[0].copado__Deployment_Flow__c : null;
}

/* ------------------------------------------------------------ logins */

/**
 * Who logs in where. For each environment: the CLI login from
 * cmr.copado.environmentOrgs, else an org credential whose username is one of
 * your CLI logins. Returns { [envId]: { env, alias, username, credential, how } }.
 */
async function logins(api, envs, localOrgs, environmentOrgs, notes) {
  const list = envs.filter(e => e && e.id);
  const out = {};
  const creds = list.length ? await q(api, OBJ.credential, ['Id', 'Name', 'copado__Username__c', 'copado__Environment__c', 'copado__Default_Credential__c'],
    'copado__Environment__c IN (' + quote(list.map(e => e.id)) + ')', 'LIMIT 500', notes) : [];
  const local = localOrgs || [];
  for (const e of list) {
    const mine = creds.filter(c => c.copado__Environment__c === e.id);
    const named = environmentOrgs && environmentOrgs[e.name];
    if (named) {
      const l = local.find(o => o.alias === named || o.username === named);
      out[e.id] = { env: e.name, alias: named, username: l ? l.username : (/@/.test(named) ? named : null), credential: null, how: 'setting' };
      continue;
    }
    const match = mine.map(c => ({ c, l: local.find(o => c.copado__Username__c && o.username && o.username.toLowerCase() === String(c.copado__Username__c).toLowerCase()) })).find(x => x.l);
    if (match) { out[e.id] = { env: e.name, alias: match.l.alias || match.l.username, username: match.l.username, credential: match.c.Name, how: 'credential' }; continue; }
    const dflt = mine.find(c => c.copado__Default_Credential__c) || mine[0];
    out[e.id] = { env: e.name, alias: null, username: dflt ? dflt.copado__Username__c || null : null, credential: dflt ? dflt.Name : null, how: null };
  }
  return out;
}

/* ------------------------------------------------------------ promotions */

async function promotionById(api, id, notes) {
  const back = await backPromotionField(api);
  const r = (await q(api, OBJ.promotion, PROMO_FIELDS.concat(back ? [back] : []), "Id = '" + clean(id) + "'", 'LIMIT 1', notes))[0];
  return r ? promotionOf(r, back) : null;
}

/** The stories promoted together in a promotion. */
async function promotionStories(api, promotionId, notes) {
  const rows = await q(api, OBJ.promoted, ['Id', 'copado__User_Story__c', 'copado__User_Story__r.Name', 'copado__User_Story__r.copado__User_Story_Title__c'],
    "copado__Promotion__c = '" + clean(promotionId) + "'", 'LIMIT 5000', notes);
  const seen = new Set();
  return rows.filter(r => r.copado__User_Story__c && !seen.has(r.copado__User_Story__c) && seen.add(r.copado__User_Story__c))
    .map(r => ({ id: r.copado__User_Story__c, name: get(r, 'copado__User_Story__r.Name'), title: get(r, 'copado__User_Story__r.copado__User_Story_Title__c') || '' }));
}

/* ------------------------------------------------------------ stories and releases */

const STORY_FIELDS = ['Id', 'Name', 'copado__User_Story_Title__c', 'copado__Status__c', 'copado__Environment__c', 'copado__Environment__r.Name',
  'copado__Project__r.copado__Deployment_Flow__c', 'copado__Release__c', 'copado__Release__r.Name', 'copado__Base_Branch__c', 'copado__Release__r.copado__Base_Branch__c', 'LastModifiedDate'];

function storyOf(s) {
  return { id: s.Id, name: s.Name, title: s.copado__User_Story_Title__c || '', status: s.copado__Status__c || '', envId: s.copado__Environment__c || null, env: get(s, 'copado__Environment__r.Name') || null,
    pipelineId: get(s, 'copado__Project__r.copado__Deployment_Flow__c') || null, releaseId: s.copado__Release__c || null, release: get(s, 'copado__Release__r.Name') || null,
    baseBranch: s.copado__Base_Branch__c || get(s, 'copado__Release__r.copado__Base_Branch__c') || null };
}

/** A hotfix: a story based on the production branch rather than the pipeline's base branch. */
function isHotfix(story, map) {
  const prod = map && map.productionBranch;
  return !!(story && story.baseBranch && prod && story.baseBranch.toLowerCase() === String(prod).toLowerCase());
}

/**
 * A story's way through the pipeline: each stage on its path with the
 * promotion that brought it there, where it is now, and the next stage.
 */
function journey(story, promotions, map) {
  const forward = promotions.filter(p => !p.back);
  const earliest = forward.slice().sort((a, b) => String(a.created).localeCompare(String(b.created)))[0];
  const start = earliest ? earliest.fromId : story.envId;
  const path = [];
  if (map && map.envs[start]) {
    let cur = start;
    const seen = new Set();
    while (cur && map.envs[cur] && !seen.has(cur)) {
      seen.add(cur); path.push(cur);
      const outs = map.envs[cur].out;
      // where the story actually went beats the first step listed
      const went = forward.find(p => p.fromId === cur && outs.includes(p.toId));
      cur = went ? went.toId : outs.slice().sort((a, b) => map.envs[b].stage - map.envs[a].stage)[0];
    }
  } else if (start) path.push(start);
  const here = path.indexOf(story.envId);
  const stages = path.map((id, i) => {
    const into = forward.filter(p => p.toId === id);
    const latest = into[0] || null;
    const state = here === -1 ? (latest && !isOpen(latest.status) ? 'done' : 'ahead') : i < here ? 'done' : i === here ? 'current' : i === here + 1 ? 'next' : 'ahead';
    return { envId: id, env: map && map.envs[id] ? map.envs[id].name : (id === story.envId ? story.env : id), branch: map && map.envs[id] ? map.envs[id].branch : null,
      state, promotion: latest ? { id: latest.id, name: latest.name, status: latest.status, created: latest.created, open: isOpen(latest.status), blocking: isBlocking(latest.status) } : null };
  });
  const next = stages.find(s => s.state === 'next') || null;
  const hotfix = isHotfix(story, map);
  // after production, a hotfix is back-promoted to the environments before it
  // (not where it came from - those already have the change)
  const backTo = hotfix && map && story.envId === map.productionId
    ? map.order.filter(id => !path.includes(id) && !promotions.some(p => p.back && p.toId === id && !isOpen(p.status))).map(id => map.envs[id].name) : [];
  return { story, hotfix, stages, next, backPromotions: promotions.filter(p => p.back), backTo };
}

/** Stories by record id, with their stage fields. */
async function storiesByIds(api, ids, notes) {
  const out = [];
  for (const part of chunks(ids.filter(Boolean), 100)) out.push(...(await q(api, OBJ.story, STORY_FIELDS, 'Id IN (' + quote(part) + ')', 'ORDER BY Name LIMIT 500', notes)).map(storyOf));
  return out;
}

/* ------------------------------------------------------------ components */

const asRows = buf => {
  try { const v = JSON.parse(String(buf).replace(/^\uFEFF/, '')); return Array.isArray(v) && v.every(r => r && typeof r === 'object' && 't' in r && 'n' in r) ? v : null; } catch (e) { return null; }
};

/**
 * The components each story changed, from Copado's own records: the story's
 * "Copado Commit changes" file, else the commit files on its commits, else its
 * User Story Metadata records. Returns { [storyId]: { rows: [{ t, n, a }], source } }.
 */
async function storyComponents(api, stories, notes) {
  const n = notes || [];
  const out = {};
  const ids = stories.map(s => s.id).filter(Boolean);
  const limit = limiter(6);
  const pick = list => list.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  // 1. the File on the story
  const files = {};
  for (const part of chunks(ids, 100)) {
    try {
      for (const l of await api.query('SELECT LinkedEntityId, ContentDocument.Title, ContentDocument.LatestPublishedVersionId, ContentDocument.LastModifiedDate FROM ContentDocumentLink WHERE LinkedEntityId IN (' + quote(part) + ')')) {
        const d = l.ContentDocument || {};
        if (/commit[ _]changes/i.test(d.Title || '') && d.LatestPublishedVersionId) (files[l.LinkedEntityId] = files[l.LinkedEntityId] || []).push({ id: d.LatestPublishedVersionId, when: d.LastModifiedDate });
      }
    } catch (e) { n.push('files on the stories: ' + e.message); }
  }
  await Promise.all(Object.entries(files).map(([sid, list]) => limit(async () => {
    try { const rows = asRows(await api.download('ContentVersion', pick(list)[0].id)); if (rows) out[sid] = { rows, source: 'commit file' }; } catch (e) { n.push('commit file of ' + sid + ': ' + e.message); }
  })));
  // 2. commit files on the commits
  const left = ids.filter(id => !out[id]);
  if (left.length) {
    const commits = [];
    for (const part of chunks(left, 100)) commits.push(...await q(api, OBJ.commit, ['Id', 'copado__User_Story__c', 'CreatedDate'], 'copado__User_Story__c IN (' + quote(part) + ')', 'ORDER BY CreatedDate DESC LIMIT 2000', n));
    const storyOfCommit = new Map(commits.map(c => [c.Id, c.copado__User_Story__c]));
    const byStory = {};
    for (const part of chunks(commits.map(c => c.Id), 100)) {
      try {
        for (const a of await api.query('SELECT Id, Name, ParentId, CreatedDate FROM Attachment WHERE ParentId IN (' + quote(part) + ') ORDER BY CreatedDate DESC LIMIT 2000')) {
          if (!/commit/i.test(a.Name || '') || !/\.json$/i.test(a.Name || '')) continue;
          const sid = storyOfCommit.get(a.ParentId);
          (byStory[sid] = byStory[sid] || []).push({ id: a.Id, when: a.CreatedDate });
        }
      } catch (e) { n.push('commit attachments: ' + e.message); }
    }
    await Promise.all(Object.entries(byStory).map(([sid, list]) => limit(async () => {
      const merged = [];
      for (const f of pick(list)) { try { const rows = asRows(await api.download('Attachment', f.id)); if (rows) merged.push(...rows); } catch (e) { /* the next one */ } }
      if (merged.length) out[sid] = { rows: merged, source: 'commit attachments' };
    })));
  }
  // 3. the metadata records
  const still = ids.filter(id => !out[id]);
  for (const part of chunks(still, 100)) {
    for (const r of await q(api, OBJ.metadata, ['Id', 'copado__User_Story__c', 'copado__Metadata_API_Name__c', 'copado__Type__c', 'copado__Action__c'], 'copado__User_Story__c IN (' + quote(part) + ')', 'LIMIT 5000', n)) {
      const t = r.copado__Type__c, full = r.copado__Metadata_API_Name__c || '';
      if (!t || !full) continue;
      const name = full.startsWith(t + '.') ? full.slice(t.length + 1) : full;
      (out[r.copado__User_Story__c] = out[r.copado__User_Story__c] || { rows: [], source: 'metadata records' }).rows.push({ t, n: name, a: r.copado__Action__c || 'Add' });
    }
  }
  return out;
}

/** A promotion's components: Copado's "Promotion changes" file on it, else what its stories changed. */
async function promotionComponents(api, promotionId, stories, notes) {
  const n = notes || [];
  try {
    const links = await api.query("SELECT ContentDocument.Title, ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId = '" + clean(promotionId) + "'");
    const list = links.map(l => l.ContentDocument || {}).filter(d => /promotion changes/i.test(d.Title || '')).sort((x, y) => String(y.CreatedDate).localeCompare(String(x.CreatedDate)));
    if (list[0]) { const rows = asRows(await api.download('ContentVersion', list[0].LatestPublishedVersionId)); if (rows) return { rows, source: 'promotion change list' }; }
  } catch (e) { n.push('promotion change list: ' + e.message); }
  const per = await storyComponents(api, stories, n);
  const rows = [].concat(...Object.values(per).map(x => x.rows));
  return { rows, source: rows.length ? 'the stories\u2019 commits' : null };
}

const decode = v => { try { return decodeURIComponent(v); } catch (e) { return v; } };
const CODE_TYPES = new Set(['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'LightningComponentBundle', 'AuraDefinitionBundle', 'Flow', 'StaticResource']);

/**
 * Components changed by more than one story of the same promotion - the
 * likely conflicts, for the readiness report. per: { [storyName]: rows }.
 * Retrieve-only rows do not count: they change nothing.
 */
function forecast(per) {
  const by = new Map();
  for (const [story, rows] of Object.entries(per)) {
    for (const r of rows || []) {
      if (/^RetrieveOnly$/i.test(r.a || '')) continue;
      const key = r.t + '|' + decode(String(r.n));
      if (!by.has(key)) by.set(key, { type: r.t, name: decode(String(r.n)), stories: new Set(), actions: new Set() });
      const x = by.get(key); x.stories.add(story); x.actions.add(r.a || 'Add');
    }
  }
  return [...by.values()].filter(x => x.stories.size > 1).map(x => ({ type: x.type, name: x.name, stories: [...x.stories].sort(), actions: [...x.actions].sort(),
    severity: CODE_TYPES.has(x.type) || x.actions.has('Delete') ? 'high' : 'medium' }))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) || b.stories.length - a.stories.length || (a.type + a.name).localeCompare(b.type + b.name));
}

/* ------------------------------------------------------------ branches and the repository */

/**
 * The story's feature branch, from a Copado record when one names it (a
 * branch field on the story or its commits that holds the story's number),
 * otherwise from the pattern. Returns { branch, pattern, source }.
 */
async function featureBranch(api, story, pattern, notes) {
  const dflt = String(pattern || 'feature/{story}');
  const tryObject = async (obj, where, label) => {
    let fields = null;
    try { fields = await api.describe(obj); } catch (e) { return null; }
    const names = (fields || []).map(f => f.name).filter(nm => /branch/i.test(nm) && !/base_?branch|destination|target|main/i.test(nm) && (!fields.find(f => f.name === nm).type || /string|textarea|url/.test(fields.find(f => f.name === nm).type)));
    if (!names.length) return null;
    const rows = await robustQuery(api, ['Id'].concat(names), obj, where, 'LIMIT 20', notes || []);
    for (const r of rows) for (const nm of names) {
      const v = r[nm];
      if (typeof v === 'string' && v.includes(story.name) && !/\s/.test(v)) return { branch: v.trim(), pattern: v.trim().split(story.name).join('{story}'), source: label + ' ' + nm };
    }
    return null;
  };
  const found = await tryObject(OBJ.story, "Id = '" + clean(story.id) + "'", 'the story\u2019s') ||
    await tryObject(OBJ.commit, "copado__User_Story__c = '" + clean(story.id) + "'", 'the story\u2019s commit');
  return found || { branch: dflt.split('{story}').join(story.name), pattern: dflt, source: 'the Feature branch setting' };
}

/** The address on Copado's Git Repository record, whichever field this Copado version keeps it in. */
async function repositoryUri(api, repoId, notes) {
  if (!repoId) return null;
  let fields = null;
  try { fields = await api.describe(OBJ.repo); } catch (e) { return null; }
  const names = (fields || []).map(f => f.name);
  const pickName = names.find(nm => /^copado__URI__c$/i.test(nm)) || names.find(nm => /(URI|URL)__c$/i.test(nm) && !/pull|commit|branch|template|tag|compare/i.test(nm));
  if (!pickName) return null;
  const r = (await robustQuery(api, ['Id', 'Name', pickName], OBJ.repo, "Id = '" + clean(repoId) + "'", 'LIMIT 1', notes || []))[0];
  return r && r[pickName] ? { name: r.Name, uri: String(r[pickName]).trim(), field: pickName } : null;
}

module.exports = {
  OBJ, isOpen, isBlocking, pipelines, pipeline, build, reaches, isBackPromotion, backPromotionField, pipelineIdFor, logins, promotionById,
  promotionStories, storiesByIds, isHotfix, journey, storyComponents, promotionComponents,
  forecast, featureBranch, repositoryUri
};
