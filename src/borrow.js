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
// the object an error is about, from the component that failed - "Account.Partner" for a record type, "Invoice__c" for an object
const objectOf = f => { const n = String((f && f.fullName) || ''); return /^(CustomObject|CustomObjectTranslation)$/i.test((f && f.type) || '') ? n : n.includes('.') ? n.split('.')[0] : null; };
const apexType = n => /^[A-Z]\w*$/.test(n) && !STANDARD_TYPES.has(n) && !/^(System|Schema|Database|ConnectApi|Messaging|Auth|Flow|Process)$/.test(n) ? { type: 'ApexClass', name: n } : null;

// Salesforce's messages when something is missing: what each one names. make(match, failure)
const RULES = [
  [/no CustomField named ([\w]+)\.([\w]+) found/i, m => field(m[1], m[2])],
  [/no CustomObject named ([\w]+) found/i, m => custom(m[1]) ? { type: 'CustomObject', name: m[1] } : null],
  [/no (ApexClass|ApexPage|ApexComponent|ApexTrigger|Flow|FlexiPage|Layout|RecordType|StaticResource|CustomPermission|CustomLabel|CustomTab|PermissionSet|LightningComponentBundle|AuraDefinitionBundle|ListView|ValidationRule|QuickAction|EmailTemplate|CustomMetadata|GlobalValueSet|CustomApplication|BusinessProcess|CompactLayout|FieldSet|WebLink) named ([\w.\-]+) found/i,
    m => ({ type: m[1], name: m[2] })],
  [/Entity of type '(\w+)' named '([^']+)' cannot be found/i, m => ({ type: m[1], name: m[2] })],
  [/No such column '(\w+)' on entity '(\w+)'/i, m => field(m[2], m[1])],
  [/The field "(\w+)" for the object "(\w+)" doesn['\u2019]?t exist/i, m => field(m[2], m[1])],
  [/Field does not exist: (\w+) on (\w+)/i, m => field(m[2], m[1])],
  [/\bfield ([\w]+)\.([\w]+__c) does not exist/i, m => field(m[1], m[2])],
  // a picklist value the target's field does not have yet: the field, from the source org, has it
  [/Picklist value: .+? in picklist: (\w+) not found/i, (m, f) => objectOf(f) ? field(objectOf(f), m[1]) : null],
  // a record type a layout assignment, a profile or a flow names
  [/(?:Invalid|unknown) record ?type:? '?([\w]+\.[\w]+)'?/i, m => ({ type: 'RecordType', name: m[1] })],
  // custom labels: Visualforce, Aura and Apex say $Label or Label.; a Lightning web component, c.<name> of type label
  [/\$Label\.(?:c\.)?(\w+) does not exist/i, m => ({ type: 'CustomLabel', name: m[1] })],
  [/Invalid reference c\.(\w+) of type label/i, m => ({ type: 'CustomLabel', name: m[1] })],
  [/(?:Variable|Field) does not exist: (?:System\.)?Label\.(\w+)/i, m => ({ type: 'CustomLabel', name: m[1] })],
  // a custom permission another permission, a profile or a validation rule depends on
  [/(?:custom permission:? '?|\$Permission\.)(\w+)\b.*(?:does not exist|not found|invalid)/i, m => ({ type: 'CustomPermission', name: m[1] })],
  [/depends on (?:the )?custom permission\(?s?\)?:? (\w+)/i, m => ({ type: 'CustomPermission', name: m[1] })],
  // a custom metadata record, or its type
  [/Invalid type: (?:Schema\.)?(\w+__mdt)\b/i, m => ({ type: 'CustomObject', name: m[1] })],
  [/(\w+__mdt\.\w+) (?:does not exist|not found)/i, m => ({ type: 'CustomMetadata', name: m[1] })],
  // components a page or another component uses
  [/No COMPONENT named markup:\/\/c:(\w+) found/i, m => ({ type: 'AuraDefinitionBundle', name: m[1] })],
  [/Unable to find Apex action class referenced as '(\w+)'/i, m => apexType(m[1])],
  // a class the target has, but older: a method or a property it does not have yet
  [/Method does not exist or incorrect signature: .* from the type (?:c\.)?(\w+)/i, m => apexType(m[1]) && Object.assign(apexType(m[1]), { outdated: true })],
  [/Invalid type: ([\w]+)/, m => /__c$/i.test(m[1]) ? { type: 'CustomObject', name: m[1] } : apexType(m[1])]
];
// Apex's own and common platform types: "Invalid type" for these is not a missing class of the project's
const STANDARD_TYPES = new Set(['String', 'Integer', 'Decimal', 'Double', 'Long', 'Boolean', 'Date', 'Datetime', 'Time', 'Id', 'Blob', 'Object', 'SObject', 'List', 'Set', 'Map', 'Exception', 'Database', 'Schema', 'System', 'Test', 'Account', 'Contact', 'Opportunity', 'Lead', 'Case', 'User']);

/** What one error says is missing in the target: { type, name, outdated? }, or null when it is not about something missing. */
function causeOf(failure) {
  const text = String((failure && failure.problem) || '');
  for (const [re, make] of RULES) {
    const m = re.exec(text);
    if (m) return make(m, failure) || null;
  }
  return null;
}

function missingFrom(failures) {
  const out = [];
  for (const f of failures || []) {
    const c = causeOf(f);
    if (!c) continue;
    const needs = f.fullName ? (f.type ? String(f.type).replace(/^Apex/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() + ' ' : '') + f.fullName : f.file || null;
    const seen = out.find(x => x.type === c.type && x.name.toLowerCase() === c.name.toLowerCase());
    if (seen) { if (needs && !seen.needs.includes(needs)) seen.needs.push(needs); } else out.push(Object.assign(c, { needs: needs ? [needs] : [] }));
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

/**
 * The pre-check's errors by what causes them: every error a missing component causes under that component, once,
 * with what to do; the rest on their own. -> { causes: [{ type, name, outdated, failures: [...] }], other: [...] }
 */
function byCause(failures) {
  const causes = [], other = [];
  for (const f of failures || []) {
    const c = causeOf(f);
    if (!c) { other.push(f); continue; }
    const at = causes.find(x => x.type === c.type && x.name.toLowerCase() === c.name.toLowerCase());
    if (at) at.failures.push(f); else causes.push(Object.assign({}, c, { failures: [f] }));
  }
  return { causes: causes.sort((a, b) => b.failures.length - a.failures.length || a.name.localeCompare(b.name)), other };
}

/**
 * What the promotion still needs in the target, to commit to a story: what was added to the pre-check from the
 * source org, and what the last pre-check found missing - each once. -> [{ type, name, why, needs }]
 */
function recommitList(borrowed, missing) {
  const out = [];
  const add = (x, why) => { if (!out.some(o => o.type === x.type && o.name.toLowerCase() === x.name.toLowerCase())) out.push({ type: x.type, name: x.name, why, needs: (x.needs || []).slice() }); };
  for (const b of borrowed || []) add(b, 'added to the pre-check from the source org');
  for (const m of missing || []) add(m, m.outdated ? 'older in the target than the promotion needs' : 'missing in the target');
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

module.exports = { missingFrom, manifestFor, collect, TYPES, byCause, recommitList };
