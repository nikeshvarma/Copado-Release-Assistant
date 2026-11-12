'use strict';

const X = require('./xmlParser');

/**
 * Structural rules that a merge can break without creating a duplicate.
 *
 * These are the errors that get past the duplicate checker because the keys
 * are different, but still fail the deployment: a field that is editable but
 * not readable, two default record types on one object, the same field twice
 * on a layout. Merging two profiles child by child produces exactly this kind
 * of damage, so the merged result is checked before it is applied.
 *
 * Each finding: { id, severity, message, node }
 */

function check(parsed, options) {
  const o = Object.assign({ disabled: [] }, options || {});
  const out = [];
  if (!parsed.root) return out;
  const type = parsed.root.name;
  const off = new Set(o.disabled || []);

  for (const rule of RULES) {
    if (off.has(rule.id)) continue;
    if (rule.types.indexOf(type) === -1) continue;
    try { rule.run(parsed.root, out, type); } catch (e) { /* never block on a rule bug */ }
  }
  return out.sort((a, b) => a.node.start - b.node.start);
}

/* helpers */

const kids = (el, name) => X.elements(el).filter(c => c.name === name);
const val = (el, name) => {
  const c = X.childByName(el, name);
  return c ? X.textOf(c) : undefined;
};
const isTrue = v => v === 'true';
const nodeFor = (entry, name) => X.childByName(entry, name) || entry;
const objectOf = recordType => String(recordType || '').split('.')[0];

function add(out, id, severity, message, node) {
  out.push({ id, severity, message, node });
}

const PERMISSION_TYPES = ['Profile', 'PermissionSet', 'MutingPermissionSet'];

const RULES = [
  {
    id: 'field.editableRequiresReadable',
    types: PERMISSION_TYPES,
    run(root, out) {
      for (const fp of kids(root, 'fieldPermissions')) {
        const field = val(fp, 'field') || '(unnamed field)';
        if (isTrue(val(fp, 'editable')) && val(fp, 'readable') === 'false') {
          add(out, this.id, 'error',
            field + ' is editable but not readable. Salesforce rejects this - set readable to true or editable to false.',
            nodeFor(fp, 'editable'));
        }
      }
    }
  },

  {
    id: 'object.permissionImplications',
    types: ['Profile', 'PermissionSet'],
    run(root, out) {
      const needs = [
        ['allowCreate', ['allowRead']],
        ['allowEdit', ['allowRead']],
        ['allowDelete', ['allowRead', 'allowEdit']],
        ['viewAllRecords', ['allowRead']],
        ['modifyAllRecords', ['allowRead', 'allowEdit', 'allowDelete', 'viewAllRecords']]
      ];
      for (const op of kids(root, 'objectPermissions')) {
        const object = val(op, 'object') || '(unnamed object)';
        for (const [flag, requires] of needs) {
          if (!isTrue(val(op, flag))) continue;
          const missing = requires.filter(r => val(op, r) === 'false');
          if (missing.length) {
            add(out, this.id, 'error',
              object + ': ' + flag + ' is true but ' + missing.join(' and ') + ' is false. Salesforce requires these together.',
              nodeFor(op, flag));
          }
        }
        if (isTrue(val(op, 'viewAllFields')) && val(op, 'viewAllRecords') === 'false') {
          add(out, this.id, 'warning',
            object + ': viewAllFields normally requires viewAllRecords.', nodeFor(op, 'viewAllFields'));
        }
      }
    }
  },

  {
    id: 'recordType.singleDefaultPerObject',
    types: ['Profile'],
    run(root, out) {
      const byObject = new Map();
      for (const rt of kids(root, 'recordTypeVisibilities')) {
        if (!isTrue(val(rt, 'default'))) continue;
        const obj = objectOf(val(rt, 'recordType'));
        if (!byObject.has(obj)) byObject.set(obj, []);
        byObject.get(obj).push(rt);
      }
      for (const [obj, entries] of byObject) {
        if (entries.length < 2) continue;
        const names = entries.map(e => val(e, 'recordType')).join(', ');
        for (let i = 1; i < entries.length; i++) {
          add(out, this.id, 'error',
            obj + ' has ' + entries.length + ' default record types (' + names + '). Only one can be the default.',
            nodeFor(entries[i], 'default'));
        }
      }
    }
  },

  {
    id: 'recordType.defaultMustBeVisible',
    types: ['Profile'],
    run(root, out) {
      for (const rt of kids(root, 'recordTypeVisibilities')) {
        if (isTrue(val(rt, 'default')) && val(rt, 'visible') === 'false') {
          add(out, this.id, 'error',
            (val(rt, 'recordType') || 'a record type') + ' is the default but not visible.',
            nodeFor(rt, 'visible'));
        }
      }
    }
  },

  {
    id: 'app.singleDefault',
    types: ['Profile'],
    run(root, out) {
      const defaults = kids(root, 'applicationVisibilities').filter(a => isTrue(val(a, 'default')));
      if (defaults.length > 1) {
        const names = defaults.map(a => val(a, 'application')).join(', ');
        for (let i = 1; i < defaults.length; i++) {
          add(out, this.id, 'error',
            defaults.length + ' applications are marked default (' + names + '). Only one can be.',
            nodeFor(defaults[i], 'default'));
        }
      }
      for (const a of defaults) {
        if (val(a, 'visible') === 'false') {
          add(out, this.id, 'error',
            (val(a, 'application') || 'an application') + ' is the default app but not visible.',
            nodeFor(a, 'visible'));
        }
      }
    }
  },

  {
    id: 'layoutAssignment.oneDefaultPerObject',
    types: ['Profile'],
    run(root, out) {
      const byObject = new Map();
      for (const la of kids(root, 'layoutAssignments')) {
        if (X.childByName(la, 'recordType')) continue;      // record-type specific, fine
        const layout = val(la, 'layout') || '';
        const obj = layout.split('-')[0];
        if (!byObject.has(obj)) byObject.set(obj, []);
        byObject.get(obj).push(la);
      }
      for (const [obj, entries] of byObject) {
        if (entries.length < 2) continue;
        const names = entries.map(e => val(e, 'layout')).join(', ');
        for (let i = 1; i < entries.length; i++) {
          add(out, this.id, 'error',
            obj + ' has ' + entries.length + ' layout assignments with no record type (' + names + '). Only one can be the default layout.',
            nodeFor(entries[i], 'layout'));
        }
      }
    }
  },

  {
    id: 'permissions.fieldWithoutObject',
    types: ['Profile', 'PermissionSet'],
    run(root, out) {
      const objects = new Set(kids(root, 'objectPermissions').map(op => val(op, 'object')));
      if (!objects.size) return;
      const reported = new Set();
      for (const fp of kids(root, 'fieldPermissions')) {
        const field = val(fp, 'field') || '';
        const obj = field.split('.')[0];
        if (!/__c$/.test(obj) || objects.has(obj) || reported.has(obj)) continue;
        reported.add(obj);
        add(out, this.id, 'warning',
          'Field permissions reference ' + obj + ' but there are no object permissions for it. Check whether the merge dropped the object entry.',
          nodeFor(fp, 'field'));
      }
    }
  },

  {
    id: 'layout.fieldAppearsOnce',
    types: ['Layout'],
    run(root, out) {
      const seen = new Map();
      walk(root);
      for (const [field, nodes] of seen) {
        if (nodes.length < 2) continue;
        for (let i = 1; i < nodes.length; i++) {
          add(out, this.id, 'error',
            field + ' appears ' + nodes.length + ' times on this layout. A field can only be placed once.',
            nodes[i]);
        }
      }
      function walk(el) {
        for (const c of X.elements(el)) {
          if (c.name === 'layoutItems') {
            const f = X.childByName(c, 'field');
            if (f) {
              const key = X.textOf(f);
              if (!seen.has(key)) seen.set(key, []);
              seen.get(key).push(f);
            }
          }
          walk(c);
        }
      }
    }
  },

  {
    id: 'picklist.singleDefault',
    types: ['CustomObject', 'CustomField', 'GlobalValueSet', 'StandardValueSet', 'RecordType'],
    run(root, out) {
      const VALUE_TAGS = new Set(['value', 'customValue', 'standardValue', 'values']);
      walk(root, []);
      function walk(el, path) {
        const groups = new Map();
        for (const c of X.elements(el)) {
          if (VALUE_TAGS.has(c.name)) {
            if (!groups.has(c.name)) groups.set(c.name, []);
            groups.get(c.name).push(c);
          }
          walk(c, path.concat(el.name));
        }
        for (const [, entries] of groups) {
          const defaults = entries.filter(e => isTrue(val(e, 'default')));
          if (defaults.length < 2) continue;
          const where = val(el, 'picklist') || val(el, 'fullName') || el.name;
          const names = defaults.map(e => val(e, 'fullName')).join(', ');
          for (let i = 1; i < defaults.length; i++) {
            add(out, 'picklist.singleDefault', 'error',
              where + ' has ' + defaults.length + ' default values (' + names + '). Only one can be the default.',
              nodeFor(defaults[i], 'default'));
          }
        }
      }
    }
  },

  {
    id: 'object.compactLayoutAssignmentExists',
    types: ['CustomObject'],
    run(root, out) {
      const assigned = X.childByName(root, 'compactLayoutAssignment');
      if (!assigned) return;
      const name = X.textOf(assigned);
      if (!name || name === 'SYSTEM') return;
      const names = kids(root, 'compactLayouts').map(c => val(c, 'fullName'));
      if (names.indexOf(name) === -1) {
        add(out, this.id, 'warning',
          'compactLayoutAssignment points at "' + name + '", which is not defined in this file.', assigned);
      }
    }
  },

  {
    id: 'app.defaultLandingTabExists',
    types: ['CustomApplication'],
    run(root, out) {
      const landing = X.childByName(root, 'defaultLandingTab');
      if (!landing) return;
      const name = X.textOf(landing);
      const tabs = kids(root, 'tabs').map(X.textOf);
      if (name && tabs.length && tabs.indexOf(name) === -1) {
        add(out, this.id, 'warning',
          'defaultLandingTab "' + name + '" is not in the tab list.', landing);
      }
    }
  },

  {
    id: 'package.typesHaveMembers',
    types: ['Package'],
    run(root, out) {
      for (const t of kids(root, 'types')) {
        if (!kids(t, 'members').length) {
          add(out, this.id, 'warning',
            (val(t, 'name') || 'a type') + ' has no members.', t);
        }
      }
      if (!X.childByName(root, 'version')) {
        add(out, this.id, 'warning', 'package.xml has no <version>.', root);
      }
    }
  }
];

module.exports = { check };
