'use strict';

/**
 * Turns Copado's commit JSON into manifests.
 *
 * Each entry looks like { t: type, n: name, a: action, c: 'SFDX', m: '', j: '' }.
 * The action decides which manifest a component lands in:
 *
 *   deploy       retrieved AND deployed            (Copado "Add")
 *   retrieve     retrieved only, never deployed    (Copado "RetrieveOnly")
 *   destructive  goes in destructiveChanges.xml
 *   ignore       skipped
 *
 * RetrieveOnly exists so that, for example, an object and its fields can be
 * retrieved alongside a permission set - the permission set then comes back
 * with field permissions for them - while only the permission set deploys.
 */

const DEFAULT_ACTIONS = {
  Add: 'deploy',
  RetrieveOnly: 'retrieve',
  Delete: 'destructive',
  // Copado commits only the changes selected in the file and keeps that version
  // itself; the org has the whole file. Deploy it, but never retrieve over it.
  SelectiveCommit: 'selective'
};

function parseCommit(text, sourceName) {
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error((sourceName || 'File') + ' is not valid JSON: ' + e.message);
  }
  if (!Array.isArray(data)) throw new Error((sourceName || 'File') + ' is not a Copado commit list (expected a JSON array).');
  return data
    .filter(e => e && typeof e === 'object' && e.t && e.n)
    .map(e => ({
      type: String(e.t).trim(),
      rawName: String(e.n),
      name: decodeName(String(e.n)),
      action: String(e.a || '').trim(),
      format: e.c || '',
      source: sourceName || '',
      copadoFile: selectiveRef(e.j).file,
      copadoHash: selectiveRef(e.j).hash
    }));
}

/** The Copado file holding a selective commit's content, from the row's "j" field. */
function selectiveRef(j) {
  if (!j) return { file: '', hash: '' };
  try {
    const v = typeof j === 'string' ? JSON.parse(j) : j;
    return { file: v && v.selectiveCommitFileId ? String(v.selectiveCommitFileId) : '', hash: v && v.selectiveCommitHash ? String(v.selectiveCommitHash) : '' };
  } catch (e) { return { file: '', hash: '' }; }
}

function decodeName(n) {
  try { return decodeURIComponent(n); } catch (e) { return n; }
}

/**
 * rows: output of parseCommit (several files can be concatenated)
 * options.actions: action -> deploy | retrieve | destructive | ignore
 */
function build(rows, options) {
  const o = Object.assign({ actions: {}, warnStandardFields: true, testPattern: 'Test$' }, options || {});
  const actions = Object.assign({}, DEFAULT_ACTIONS, o.actions || {});

  const deploy = new Map();       // type -> Set(name)
  const retrieveOnly = new Map();
  const destructive = new Map();
  const selective = new Map();     // deployed, never retrieved
  const copadoFiles = new Map();   // type|name -> Copado file id
  const copadoHashes = new Map();  // type|name -> selectiveCommitHash, the downloaded file's name
  const notes = [];
  const seen = new Map();          // type|name -> role
  const unknownActions = new Map();

  for (const r of rows) {
    const role = actions[r.action];
    if (!role) {
      unknownActions.set(r.action || '(blank)', (unknownActions.get(r.action || '(blank)') || 0) + 1);
      continue;
    }
    if (role === 'ignore') continue;
    const key = r.type + '|' + r.name;
    const before = seen.get(key);
    if (r.copadoFile) copadoFiles.set(key, r.copadoFile);
    if (r.copadoHash) copadoHashes.set(key, r.copadoHash);
    if (before === role) continue;
    // a selective commit wins over plain deploy or retrieve: retrieving would overwrite what was committed
    if (before && role === 'selective' && (before === 'deploy' || before === 'retrieve')) {
      if (before === 'retrieve') { remove(retrieveOnly, r); addTo(deploy, r); }
      addTo(selective, r);
      seen.set(key, 'selective');
      continue;
    }
    if (before === 'selective' && (role === 'deploy' || role === 'retrieve')) continue;
    if (before) {
      // deploy implies retrieve, so it wins over retrieve-only
      if (before === 'deploy' && role === 'retrieve') continue;
      if (before === 'retrieve' && role === 'deploy') { remove(retrieveOnly, r); }
      else if (before !== role) {
        notes.push(note('warning', 'conflicting-actions', r.type + ' ' + r.name + ' is marked both ' + before + ' and ' + role + '. Keeping ' + before + '.', r));
        continue;
      }
    }
    seen.set(key, role);
    if (role === 'deploy') addTo(deploy, r);
    else if (role === 'selective') { addTo(deploy, r); addTo(selective, r); }
    else if (role === 'retrieve') addTo(retrieveOnly, r);
    else if (role === 'destructive') addTo(destructive, r);
  }

  for (const [action, count] of unknownActions) {
    notes.push(note('warning', 'unknown-action',
      count + ' entr' + (count === 1 ? 'y has' : 'ies have') + ' action "' + action + '", which has no mapping. They were skipped - map it in cmr.package.actionMapping.'));
  }

  // pre-flight on what will actually deploy
  for (const r of rows) {
    if (r.rawName !== r.name && seen.has(r.type + '|' + r.name)) {
      notes.push(note('info', 'decoded-name', 'Decoded "' + r.rawName + '" to "' + r.name + '".', r));
    }
  }
  const deployFields = Array.from(deploy.get('CustomField') || []);
  const standard = deployFields.filter(isStandardField);
  if (o.warnStandardFields && standard.length) {
    notes.push(note('warning', 'standard-fields',
      standard.length + ' standard field' + (standard.length === 1 ? '' : 's') + ' will be deployed (no __c suffix), e.g. ' +
      standard.slice(0, 4).join(', ') + '. Many standard fields cannot be deployed or have nothing deployable - expect validation errors for these.',
      null, { components: standard.map(n => ({ type: 'CustomField', name: n })) }));
  }
  if (deploy.has('Profile')) {
    notes.push(note('info', 'partial-profile',
      'Profiles retrieve only the permissions that relate to other components in the same manifest, so ' +
      Array.from(deploy.get('Profile')).join(', ') + ' will come back partial. That is how Copado works too.'));
  }
  const apex = []
    .concat(Array.from(deploy.get('ApexClass') || []))
    .concat(Array.from(deploy.get('ApexTrigger') || []));
  let pattern;
  try { pattern = new RegExp(o.testPattern || 'Test$', 'i'); } catch (e) { pattern = /Test$/i; }
  const testClasses = Array.from(deploy.get('ApexClass') || []).filter(n => pattern.test(n)).sort();
  if (apex.length) {
    notes.push(note('info', 'apex',
      apex.length + ' Apex component' + (apex.length === 1 ? '' : 's') + ' in the deploy - validation will ask for test classes' +
      (testClasses.length ? ' (suggesting ' + testClasses.join(', ') + ').' : '.')));
  }

  if (selective.size) {
    const items = [];
    for (const [t, set] of selective) for (const n of set) items.push({ type: t, name: n, copadoFile: copadoFiles.get(t + '|' + n) || '', copadoHash: copadoHashes.get(t + '|' + n) || '' });
    notes.push(note('warning', 'selective-commit',
      items.length + ' selective commit' + (items.length === 1 ? ' is' : 's are') + ' deployed but not retrieved: ' +
      items.map(i => i.type + ' ' + i.name).join(', ') + '. Copado commits only the changes selected in ' + (items.length === 1 ? 'it' : 'them') +
      ' and keeps that version' + (items.some(i => i.copadoFile) ? ' (Copado file ' + items.map(i => i.copadoFile).filter(Boolean).join(', ') + ')' : '') +
      '; the org has the whole file. Validation uses the version in your project - make sure it is the committed one, for example from the user story\'s feature branch.',
      null, { components: items }));
  }

  // what to retrieve: everything deployed except selective commits, plus retrieve-only
  const retrieve = new Map();
  for (const [t, set] of deploy) for (const n of set) if (!(selective.get(t) && selective.get(t).has(n))) addTo(retrieve, { type: t, name: n });
  for (const [t, set] of retrieveOnly) for (const n of set) addTo(retrieve, { type: t, name: n });

  return {
    deploy, retrieve, retrieveOnly, destructive, selective, notes,
    hasApex: apex.length > 0,
    testClasses,
    counts: {
      deploy: size(deploy), retrieve: size(retrieve), retrieveOnly: size(retrieveOnly), destructive: size(destructive), selective: size(selective)
    }
  };
}

function isStandardField(fullName) {
  const field = String(fullName).split('.').slice(1).join('.');
  return !!field && !/__c$/i.test(field);
}

function addTo(map, r) {
  if (!map.has(r.type)) map.set(r.type, new Set());
  map.get(r.type).add(r.name);
}

function remove(map, r) {
  const s = map.get(r.type);
  if (s) { s.delete(r.name); if (!s.size) map.delete(r.type); }
}

function size(map) {
  let n = 0;
  for (const s of map.values()) n += s.size;
  return n;
}

function note(severity, id, message, row, extra) {
  return Object.assign({ severity, id, message, source: row ? row.source : undefined }, extra || {});
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** Canonical package.xml: types sorted by name, members sorted, 4-space indent. */
function toPackageXml(map, version, eol) {
  eol = eol || '\n';
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<Package xmlns="http://soap.sforce.com/2006/04/metadata">'];
  const types = Array.from(map.keys()).sort(cmp);
  for (const t of types) {
    const members = Array.from(map.get(t)).sort(cmp);
    if (!members.length) continue;
    lines.push('    <types>');
    for (const m of members) lines.push('        <members>' + escapeXml(m) + '</members>');
    lines.push('        <name>' + escapeXml(t) + '</name>');
    lines.push('    </types>');
  }
  if (version) lines.push('    <version>' + escapeXml(version) + '</version>');
  lines.push('</Package>');
  return lines.join(eol) + eol;
}

function apiVersionFrom(projectJsonText) {
  try {
    const p = JSON.parse(projectJsonText);
    const v = p && p.sourceApiVersion;
    return v ? String(v) : null;
  } catch (e) { return null; }
}

/** Plain-text summary for the output panel. */
function summary(result, version) {
  const L = [];
  L.push('Deploy: ' + result.counts.deploy + ' component' + (result.counts.deploy === 1 ? '' : 's') +
    (result.counts.retrieveOnly ? '   Retrieve only: ' + result.counts.retrieveOnly : '') +
    (result.counts.selective ? '   Selective: ' + result.counts.selective : '') +
    (result.counts.destructive ? '   Destructive: ' + result.counts.destructive : '') +
    '   API ' + version);
  L.push('');
  for (const [label, map] of [['Deploy (package.xml)', result.deploy], ['Retrieve only (package-retrieve.xml)', result.retrieveOnly], ['Destructive (destructiveChanges.xml)', result.destructive], ['Selective commits (deployed, not retrieved)', result.selective || new Map()]]) {
    if (!map.size) continue;
    L.push(label + ':');
    for (const t of Array.from(map.keys()).sort(cmp)) L.push('  ' + t.padEnd(22) + map.get(t).size);
    L.push('');
  }
  if (result.notes.length) {
    L.push('Pre-flight:');
    for (const n of result.notes) L.push('  ' + (n.severity === 'warning' ? '!' : 'i') + ' ' + n.message);
    L.push('');
  }
  return L;
}

/**
 * Where a component's file lives in a source-format project, relative to a
 * package directory such as force-app/main/default. Null for types not listed.
 * Characters Salesforce encodes in file names ([ ] and friends) are tried both
 * ways by the caller.
 */
const SOURCE_PATHS = {
  Layout: n => 'layouts/' + n + '.layout-meta.xml',
  FlexiPage: n => 'flexipages/' + n + '.flexipage-meta.xml',
  Profile: n => 'profiles/' + n + '.profile-meta.xml',
  PermissionSet: n => 'permissionsets/' + n + '.permissionset-meta.xml',
  PermissionSetGroup: n => 'permissionsetgroups/' + n + '.permissionsetgroup-meta.xml',
  CustomObject: n => 'objects/' + n + '/' + n + '.object-meta.xml',
  CustomApplication: n => 'applications/' + n + '.app-meta.xml',
  CustomTab: n => 'tabs/' + n + '.tab-meta.xml',
  QuickAction: n => 'quickActions/' + n + '.quickAction-meta.xml',
  Flow: n => 'flows/' + n + '.flow-meta.xml',
  ApexClass: n => 'classes/' + n + '.cls',
  ApexTrigger: n => 'triggers/' + n + '.trigger',
  CustomPermission: n => 'customPermissions/' + n + '.customPermission-meta.xml',
  CustomMetadata: n => 'customMetadata/' + n + '.md-meta.xml',
  CustomField: n => child(n, 'fields', 'field'),
  RecordType: n => child(n, 'recordTypes', 'recordType'),
  ListView: n => child(n, 'listViews', 'listView'),
  CompactLayout: n => child(n, 'compactLayouts', 'compactLayout'),
  ValidationRule: n => child(n, 'validationRules', 'validationRule'),
  WebLink: n => child(n, 'webLinks', 'webLink'),
  FieldSet: n => child(n, 'fieldSets', 'fieldSet')
};

function child(n, folder, suffix) {
  const i = n.indexOf('.');
  return i < 1 ? null : 'objects/' + n.slice(0, i) + '/' + folder + '/' + n.slice(i + 1) + '.' + suffix + '-meta.xml';
}

/** The file names a component may have on disk: as named, and with Salesforce's percent-encoding. */
function sourcePaths(type, name) {
  const f = SOURCE_PATHS[type];
  if (!f) return [];
  const enc = String(name).replace(/[\[\]()%#?*:"<>|]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return [...new Set([f(name), f(enc)].filter(Boolean))];
}

module.exports = { DEFAULT_ACTIONS, parseCommit, build, toPackageXml, apiVersionFrom, isStandardField, summary, sourcePaths };
