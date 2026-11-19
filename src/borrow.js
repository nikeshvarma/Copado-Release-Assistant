'use strict';

/**
 * A pre-check that stops at what the target does not have - a field, a class - only shows the next error once that
 * is there. These find what is missing in the errors, fetch it from the source org (read-only) and add it to the
 * pre-check's package only: never to the story, the resolution or the promotion; nothing is deployed.
 *
 *   missingFrom(failures)    -> [{ type, name, needs: [what needs it] }] - read from Salesforce's own messages
 *   manifestFor(items, api)  -> a package.xml for them
 *   collect(dir, root)       -> the files a retrieve wrote: [{ rel, file }], rel as in the project
 *   TYPES                    -> the types the picker offers
 */
const fs = require('fs');
const path = require('path');

// only what is the project's own - a custom name, or a class or a page - never a standard field taken for missing
const custom = n => /__(c|mdt|e|x|b)$/i.test(n) || /__/.test(n);
const field = (obj, f) => custom(f) ? { type: 'CustomField', name: obj + '.' + f } : null;

// Salesforce's messages when something is missing: what each one names
const RULES = [
  [/no CustomField named ([\w]+)\.([\w]+) found/i, m => field(m[1], m[2])],
  [/no CustomObject named ([\w]+) found/i, m => custom(m[1]) ? { type: 'CustomObject', name: m[1] } : null],
  [/no (ApexClass|ApexPage|ApexComponent|ApexTrigger|Flow|FlexiPage|Layout|RecordType|StaticResource|CustomPermission|CustomLabel|CustomTab|PermissionSet|LightningComponentBundle|AuraDefinitionBundle|ListView|ValidationRule|QuickAction|EmailTemplate) named ([\w.\-]+) found/i,
    m => ({ type: m[1], name: m[2] })],
  [/Entity of type '(\w+)' named '([^']+)' cannot be found/i, m => ({ type: m[1], name: m[2] })],
  [/No such column '(\w+)' on entity '(\w+)'/i, m => field(m[2], m[1])],
  [/The field "(\w+)" for the object "(\w+)" doesn['\u2019]?t exist/i, m => field(m[2], m[1])],
  [/\bfield ([\w]+)\.([\w]+__c) does not exist/i, m => field(m[1], m[2])],
  [/Invalid type: ([\w]+)/, m => /__c$/i.test(m[1]) ? { type: 'CustomObject', name: m[1] } : /^[A-Z]\w*$/.test(m[1]) && !STANDARD_TYPES.has(m[1]) ? { type: 'ApexClass', name: m[1] } : null]
];
// Apex's own and common platform types: "Invalid type" for these is not a missing class of the project's
const STANDARD_TYPES = new Set(['String', 'Integer', 'Decimal', 'Double', 'Long', 'Boolean', 'Date', 'Datetime', 'Time', 'Id', 'Blob', 'Object', 'SObject', 'List', 'Set', 'Map', 'Exception', 'Database', 'Schema', 'System', 'Test', 'Account', 'Contact', 'Opportunity', 'Lead', 'Case', 'User']);

function missingFrom(failures) {
  const out = [];
  for (const f of failures || []) {
    const text = String(f.problem || '');
    for (const [re, make] of RULES) {
      const m = re.exec(text);
      if (!m) continue;
      const c = make(m);
      if (!c) break;
      const needs = f.fullName ? (f.type ? String(f.type).replace(/^Apex/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() + ' ' : '') + f.fullName : f.file || null;
      const seen = out.find(x => x.type === c.type && x.name.toLowerCase() === c.name.toLowerCase());
      if (seen) { if (needs && !seen.needs.includes(needs)) seen.needs.push(needs); } else out.push(Object.assign(c, { needs: needs ? [needs] : [] }));
      break;
    }
  }
  return out;
}

function manifestFor(items, apiVersion) {
  const byType = new Map();
  for (const i of items) { if (!byType.has(i.type)) byType.set(i.type, new Set()); byType.get(i.type).add(i.name); }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    [...byType].sort(([a], [b]) => a.localeCompare(b)).map(([t, names]) => '    <types>\n' + [...names].sort().map(n => '        <members>' + esc(n) + '</members>\n').join('') + '        <name>' + esc(t) + '</name>\n    </types>\n').join('') +
    '    <version>' + esc(apiVersion || '62.0') + '</version>\n</Package>\n';
}

/** What a retrieve wrote into the scratch project: each file, at the project path it stands for. */
function collect(dir, root) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push({ rel: path.relative(dir, p).split(path.sep).join('/'), file: p }); } };
  const base = path.join(dir, root || 'force-app');
  if (fs.existsSync(base)) walk(base);
  return out;
}

// the picker's types - what a pre-check most often lacks
const TYPES = ['CustomField', 'CustomObject', 'ApexClass', 'ApexTrigger', 'Flow', 'Layout', 'FlexiPage', 'RecordType', 'ValidationRule', 'LightningComponentBundle', 'AuraDefinitionBundle',
  'PermissionSet', 'CustomPermission', 'CustomLabel', 'StaticResource', 'ApexPage', 'ApexComponent', 'QuickAction', 'CustomMetadata', 'ListView'];

module.exports = { missingFrom, manifestFor, collect, TYPES };
