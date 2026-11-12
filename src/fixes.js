'use strict';

const X = require('./xmlParser');
const { isStandardField } = require('./manifest');

/**
 * Maps a deployment failure to concrete fixes.
 *
 * A fix is one of:
 *   edit      change the failing metadata file (remove or add entries)
 *   package   change what is being deployed (add or remove a component)
 *   info      no metadata fix exists; explain what to do
 *
 * Anything the catalogue does not recognise gets no suggestion - the raw
 * message is shown at the right line rather than a guess.
 */

const PATTERNS = [
  {
    // In field: field - no CustomField named Lead.X__c found
    id: 'missing-reference',
    re: /In field:\s*(\w+)\s*-\s*no\s+(\w+)\s+named\s+(.+?)\s+found/i,
    build(m, f, ctx) {
      const childTag = m[1];
      const type = m[2];
      const name = m[3].trim();
      const out = [];
      const retrieveOnly = ctx.isRetrieveOnly && ctx.isRetrieveOnly(type, name);
      if (isStandard(type, name)) {
        // a standard object or field cannot be deployed: the target org lacks a feature or license
        out.push({
          kind: 'info',
          title: name + ' is a standard ' + (type === 'CustomObject' ? 'object' : 'component') + ' the target org does not have',
          detail: 'It cannot be deployed. A feature or license it belongs to is probably not enabled in the target org - enable it there, or remove the reference.'
        });
      } else out.push({
        kind: 'package',
        op: 'add',
        component: { type, name },
        title: retrieveOnly
          ? 'Deploy ' + type + ' ' + name + ' too - it is RetrieveOnly in the commit'
          : 'Add ' + type + ' ' + name + ' to the deployment',
        detail: retrieveOnly
          ? 'It is retrieved but not deployed. In Copado, change it from Retrieve Only to Add on the user story.'
          : 'It does not exist in the target org. Add it to the user story in Copado, or deploy it first.'
      });
      if (isPermissionContainer(f.type)) {
        out.push({
          kind: 'edit',
          op: 'removeEntries',
          childTag,
          value: name,
          title: 'Remove the ' + childTag + ' entries for ' + name + ' from ' + f.fullName,
          detail: 'The reference is dropped from this file. Use this when the ' + type + ' is not meant to be in this release.'
        });
      }
      return out;
    }
  },
  {
    // Custom metadata type Invoice_Field_Mapping__mdt is not available in this organization.
    id: 'missing-metadata-type',
    re: /Custom metadata type\s+(\w+__mdt)\s+is not available/i,
    build(m) {
      return [{
        kind: 'package', op: 'add', component: { type: 'CustomObject', name: m[1] },
        title: 'Add custom metadata type ' + m[1] + ' to the deployment',
        detail: 'The record needs its type. Deploy the type (CustomObject ' + m[1] + ') with it, or first.'
      }];
    }
  },
  {
    // Entity of type 'ApexClass' named 'X' cannot be found
    id: 'missing-entity',
    re: /Entity of type '([^']+)' named '([^']+)' cannot be found/i,
    build(m) {
      return [{
        kind: 'package', op: 'add', component: { type: m[1], name: m[2] },
        title: 'Add ' + m[1] + ' ' + m[2] + ' to the deployment',
        detail: 'It is referenced but does not exist in the target org.'
      }];
    }
  },
  {
    // The user license doesn't allow the permission: ManageUsers
    id: 'license-permission',
    re: /user license doesn't allow the permission:\s*(\w+)/i,
    build(m, f) {
      return [{
        kind: 'edit', op: 'removeEntries', collection: 'userPermissions', childTag: 'name', value: m[1],
        title: 'Remove user permission ' + m[1] + ' from ' + f.fullName,
        detail: 'The license on this permission set or profile cannot grant it.'
      }];
    }
  },
  {
    // Unknown user permission: X
    id: 'unknown-permission',
    re: /Unknown user permission:\s*(\w+)/i,
    build(m, f) {
      return [{
        kind: 'edit', op: 'removeEntries', collection: 'userPermissions', childTag: 'name', value: m[1],
        title: 'Remove unknown user permission ' + m[1] + ' from ' + f.fullName,
        detail: 'The target org does not know this permission - usually a feature or edition difference.'
      }];
    }
  },
  {
    // Permission ViewSetup depends on permission(s): ViewRoles, ViewAllUsers
    id: 'permission-dependency',
    re: /Permission\s+(\w+)\s+depends on permission\(s\):\s*([\w\s,]+)/i,
    build(m, f) {
      const needs = m[2].split(/[\s,]+/).filter(Boolean);
      return [
        {
          kind: 'edit', op: 'enableUserPermissions', names: needs,
          title: 'Enable ' + needs.join(', ') + ' in ' + f.fullName,
          detail: m[1] + ' cannot be granted without them.'
        },
        {
          kind: 'edit', op: 'removeEntries', collection: 'userPermissions', childTag: 'name', value: m[1],
          title: 'Remove ' + m[1] + ' instead',
          detail: 'Drop the permission that needs the others.'
        }
      ];
    }
  }
];

/** Standard objects and fields have no namespace suffix, so they can never be deployed. */
function isStandard(type, name) {
  if (type === 'CustomObject') return String(name).indexOf('__') === -1;
  if (type === 'CustomField') {
    const parts = String(name).split('.');
    return parts.length === 2 && parts[1].indexOf('__') === -1;
  }
  return false;
}

function isPermissionContainer(type) {
  return /^(PermissionSet|Profile|MutingPermissionSet)$/i.test(type || '');
}

/** Fixes for one component failure. */
function suggest(failure, ctx) {
  ctx = ctx || {};
  const out = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(failure.problem || '');
    if (m) {
      for (const s of p.build(m, failure, ctx)) out.push(Object.assign({ pattern: p.id }, s));
      break;
    }
  }
  // Standard fields fail in several wordings; recognise them by shape, not text.
  if (!out.length && /^CustomField$/i.test(failure.type) && isStandardField(failure.fullName)) {
    out.push({
      pattern: 'standard-field',
      kind: 'package', op: 'remove', component: { type: 'CustomField', name: failure.fullName },
      title: 'Remove standard field ' + failure.fullName + ' from the deployment',
      detail: 'Standard fields mostly cannot be deployed. Remove it from the user story in Copado.'
    });
  }
  return out;
}

/** Describes test and coverage problems; there is no metadata fix for these. */
function testAdvice(result) {
  const out = [];
  for (const t of result.testFailures || []) {
    out.push({
      kind: 'info',
      title: t.className + (t.method ? '.' + t.method : '') + ' failed',
      detail: t.message + (t.stack ? '\n' + t.stack : '')
    });
  }
  for (const c of result.coverageWarnings || []) {
    out.push({ kind: 'info', title: 'Coverage: ' + (c.name || 'org'), detail: c.message });
  }
  return out;
}

/* ---------- applying edits ---------- */

/**
 * Removes every top-level entry whose <childTag> equals value, optionally
 * only inside one collection. Everything else in the file is left byte for
 * byte as it was. Returns { text, removed }.
 */
function removeEntries(text, fix) {
  const parsed = X.parse(text);
  if (!parsed.root) return { text, removed: 0 };
  const ranges = [];
  for (const entry of X.elements(parsed.root)) {
    if (fix.collection && entry.name !== fix.collection) continue;
    const child = X.childByName(entry, fix.childTag);
    if (child && X.textOf(child) === fix.value) ranges.push(lineRange(text, entry));
  }
  return { text: cut(text, ranges), removed: ranges.length };
}

/** Adds (or switches on) userPermissions entries. Returns { text, changed }. */
function enableUserPermissions(text, fix) {
  const parsed = X.parse(text);
  if (!parsed.root) return { text, changed: 0 };
  let out = text;
  let changed = 0;
  const existing = X.elements(parsed.root).filter(e => e.name === 'userPermissions');

  // switch on entries that exist but are disabled - work from the end so offsets stay valid
  const edits = [];
  for (const name of fix.names) {
    const e = existing.find(x => X.childText(x, 'name') === name);
    if (e) {
      const enabled = X.childByName(e, 'enabled');
      if (enabled && X.textOf(enabled) !== 'true') {
        edits.push({ start: enabled.openTagEnd, end: enabled.closeStart, text: 'true' });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) { out = out.slice(0, e.start) + e.text + out.slice(e.end); changed++; }

  const missing = fix.names.filter(n => !existing.some(x => X.childText(x, 'name') === n));
  if (missing.length) {
    const reparsed = X.parse(out);
    const indent = detectIndent(out) || '    ';
    const block = missing.map(n =>
      indent + '<userPermissions>\n' +
      indent + indent + '<enabled>true</enabled>\n' +
      indent + indent + '<name>' + n + '</name>\n' +
      indent + '</userPermissions>\n').join('');
    const at = lineStartOf(out, reparsed.root.closeStart);
    out = out.slice(0, at) + block + out.slice(at);
    changed += missing.length;
  }
  return { text: out, changed };
}

function applyEdit(text, fix) {
  if (fix.op === 'removeEntries') {
    const r = removeEntries(text, fix);
    return { text: r.text, count: r.removed };
  }
  if (fix.op === 'enableUserPermissions') {
    const r = enableUserPermissions(text, fix);
    return { text: r.text, count: r.changed };
  }
  return { text, count: 0 };
}

function lineRange(src, node) {
  let start = node.start;
  const ls = src.lastIndexOf('\n', start - 1) + 1;
  if (src.slice(ls, start).trim() === '') start = ls;
  let end = node.end;
  const m = src.slice(end).match(/^[ \t]*\r?\n/);
  if (m) end += m[0].length;
  return { start, end };
}

function cut(text, ranges) {
  ranges.sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of ranges) out = out.slice(0, r.start) + out.slice(r.end);
  return out;
}

function lineStartOf(src, offset) {
  return src.lastIndexOf('\n', offset - 1) + 1;
}

function detectIndent(text) {
  const m = /\n([ \t]+)</.exec(text);
  return m ? m[1] : null;
}

/* ---------- locating the failing file ---------- */

/**
 * Candidate relative paths for a failure, most likely first. Validation
 * output names files in Metadata API form (permissionsets/X.permissionset)
 * or source form (force-app/.../X.permissionset-meta.xml).
 */
function candidatePaths(failure) {
  const f = String(failure.fileName || '').replace(/\\/g, '/');
  const out = [];
  if (f) {
    out.push(f);
    out.push(f.replace(/^unpackaged\//, ''));
    if (!/-meta\.xml$/.test(f)) out.push(f + '-meta.xml');
  }
  return Array.from(new Set(out.filter(Boolean)));
}

module.exports = { suggest, testAdvice, applyEdit, candidatePaths };
