'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rmTree = require('./rmTree');
const { execFileSync } = require('child_process');

const X = require('../src/xmlParser');
const { findDuplicates } = require('../src/duplicates');
const formatter = require('../src/formatter');
const merger = require('../src/merge');
const rules = require('../src/rules');
const manifest = require('../src/manifest');
const gitops = require('../src/gitops');
const sfcli = require('../src/sfcli');
const fixes = require('../src/fixes');

const FIX = p => path.join(__dirname, 'fixtures', p);
const tests = [];
const ok = (name, fn) => tests.push({ name, fn });
const section = name => tests.push({ section: name });
const fmt = (root, o) => formatter.format({ root, src: '' }, Object.assign({ indent: 4 }, o || {}));
const tags = text => X.elements(X.parse(text).root).map(e => e.name);

/* ------------------------------------------------------------ core */
section('parser and duplicates');

const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldPermissions><editable>false</editable><field>Account.Rating</field><readable>true</readable></fieldPermissions>
    <fieldPermissions><editable>true</editable><field>Account.Rating</field><readable>true</readable></fieldPermissions>
    <classAccesses><apexClass>ACME_Svc</apexClass><enabled>true</enabled></classAccesses>
    <classAccesses><apexClass>ACME_Svc</apexClass><enabled>true</enabled></classAccesses>
    <layoutAssignments><layout>Account-A</layout><recordType>Account.P</recordType></layoutAssignments>
    <layoutAssignments><layout>Account-A</layout><recordType>Account.C</recordType></layoutAssignments>
    <description>one</description>
    <description>two</description>
    <custom>false</custom>
</Profile>`;

ok('parses with offsets and keeps the namespace', () => {
  const p = X.parse(PROFILE);
  assert.strictEqual(p.root.name, 'Profile');
  assert.strictEqual(p.errors.length, 0);
  assert.strictEqual(p.root.attrs[0].value, 'http://soap.sforce.com/2006/04/metadata');
});

ok('tolerates unclosed tags', () => {
  const p = X.parse('<Profile><custom>true</Profile>');
  assert.ok(p.errors.length >= 1 && p.root.name === 'Profile');
});

ok('duplicates: same key different values, identical copy, repeated scalar - and composite keys are respected', () => {
  const d = findDuplicates(X.parse(PROFILE), { warnRepeatedSingletons: true });
  assert.strictEqual(d.length, 3);
  assert.ok(d.find(x => x.tag === 'fieldPermissions' && !x.identical && x.severity === 'error'));
  assert.ok(d.find(x => x.tag === 'classAccesses' && x.identical));
  assert.ok(d.find(x => x.tag === 'description' && x.kind === 'duplicate-single'));
  assert.ok(!d.some(x => x.tag === 'layoutAssignments'));
});

ok('empty layout spaces are never duplicates', () => {
  const L = `<Layout xmlns="x"><layoutSections><label>A</label><layoutColumns>
    <layoutItems><behavior>Readonly</behavior><emptySpace>true</emptySpace></layoutItems>
    <layoutItems><behavior>Readonly</behavior><emptySpace>true</emptySpace></layoutItems>
    </layoutColumns><layoutColumns/></layoutSections></Layout>`;
  assert.strictEqual(findDuplicates(X.parse(L), { warnRepeatedSingletons: true }).length, 0);
});

/* ------------------------------------------------------------ order */
section('section order');

ok('permission set: elements in plain alphabetical order, as Salesforce writes them', () => {
  const t = ['userPermissions', 'tabSettings', 'objectPermissions', 'userLicense', 'fieldPermissions', 'description',
    'classAccesses', 'hasActivationRequired', 'license', 'applicationVisibilities', 'label', 'flowAccesses'];
  const out = formatter.format(X.parse('<PermissionSet xmlns="x">' + t.map(n => '<' + n + '>x</' + n + '>').join('') + '</PermissionSet>'), { indent: 4 });
  const got = tags(out);
  assert.deepStrictEqual(got, ['applicationVisibilities', 'classAccesses', 'description', 'fieldPermissions', 'flowAccesses',
    'hasActivationRequired', 'label', 'license', 'objectPermissions', 'tabSettings', 'userLicense', 'userPermissions'],
    'label and hasActivationRequired sit in their alphabetical places, as in a retrieved permission set');
});

ok('profile: elements in plain alphabetical order, as Salesforce writes them', () => {
  const t = ['userPermissions', 'layoutAssignments', 'userLicense', 'loginHours', 'description', 'custom', 'applicationVisibilities'];
  const got = tags(formatter.format(X.parse('<Profile xmlns="x">' + t.map(n => '<' + n + '>x</' + n + '>').join('') + '</Profile>'), { indent: 4 }));
  assert.deepStrictEqual(got, ['applicationVisibilities', 'custom', 'description', 'layoutAssignments', 'loginHours', 'userLicense', 'userPermissions']);
});

ok('a file retrieved from Salesforce comes out of the formatter unchanged', () => {
  // Salesforce sorts entries in plain character order: capitals before lowercase,
  // underscore after capitals, digits before letters - "ACME_X" before "Account_X"
  const fields = ['ACME_Order__c.Status__c', 'ACME_Agreement__c.Deal__c', 'Account.AccountNumber', 'Account.Industry',
    'Account.NWX_Region__c', 'Account.Name2__c', 'Account.Name10__c', 'Account.name_lower__c', 'Case.Origin', 'aaa__Thing__c.Field__c'];
  const sorted = fields.slice().sort();
  const body = sorted.map(f => '    <fieldPermissions>\n        <editable>false</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>').join('\n');
  const file = '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    '    <classAccesses>\n        <apexClass>ZetaHandler</apexClass>\n        <enabled>true</enabled>\n    </classAccesses>\n' +
    '    <classAccesses>\n        <apexClass>alphaHelper</apexClass>\n        <enabled>true</enabled>\n    </classAccesses>\n' +
    '    <description>Retrieved as is</description>\n' + body + '\n' +
    '    <hasActivationRequired>false</hasActivationRequired>\n    <label>Billing User</label>\n' +
    '    <objectPermissions>\n        <allowRead>true</allowRead>\n        <object>Account</object>\n    </objectPermissions>\n' +
    '    <userPermissions>\n        <enabled>true</enabled>\n        <name>ApiEnabled</name>\n    </userPermissions>\n</PermissionSet>\n';
  assert.strictEqual(formatter.format(X.parse(file), { indent: 4 }), file, 'formatting changes nothing');
  // and a merge that adds one entry changes exactly that entry
  const incoming = file.replace('<field>Case.Origin</field>', '<field>Case.Origin</field>').replace('    <hasActivationRequired>',
    '    <fieldPermissions>\n        <editable>false</editable>\n        <field>Case.Subject</field>\n        <readable>true</readable>\n    </fieldPermissions>\n    <hasActivationRequired>');
  const merged = formatter.format({ root: merger.merge(X.parse(file), X.parse(incoming), {}).merged, src: '' }, { indent: 4 });
  const changed = merged.split('\n').filter((l, i, arr) => !file.includes(l + '\n') && l.trim());
  assert.deepStrictEqual(changed, ['        <field>Case.Subject</field>'], 'only the new entry differs from the original');
});

ok('a settings order wins, the remainder sorts alphabetically', () => {
  const xml = '<PermissionSet xmlns="x"><userPermissions>x</userPermissions><label>x</label><classAccesses>x</classAccesses><objectPermissions>x</objectPermissions></PermissionSet>';
  const got = tags(formatter.format(X.parse(xml), { indent: 4, typeOrder: { PermissionSet: ['objectPermissions', 'label'] } }));
  assert.deepStrictEqual(got, ['objectPermissions', 'label', 'classAccesses', 'userPermissions']);
});

ok('level 2 is never reordered, layout order is never sorted', () => {
  const out = formatter.format(X.parse('<PermissionSet xmlns="x"><fieldPermissions><readable>true</readable><field>F</field><editable>false</editable></fieldPermissions></PermissionSet>'), { indent: 4 });
  assert.deepStrictEqual(X.elements(X.elements(X.parse(out).root)[0]).map(e => e.name), ['readable', 'field', 'editable']);
  const L = '<Layout xmlns="x"><layoutSections><label>Zebra</label></layoutSections><layoutSections><label>Alpha</label></layoutSections></Layout>';
  assert.deepStrictEqual(formatter.format(X.parse(L), { indent: 4 }).match(/<label>\w+/g), ['<label>Zebra', '<label>Alpha']);
});

ok('formatting is idempotent', () => {
  const once = formatter.format(X.parse(PROFILE), { indent: 4 });
  assert.strictEqual(once, formatter.format(X.parse(once), { indent: 4 }));
});

/* ------------------------------------------------------------ merge */
section('merge');

const T2 = `<PermissionSet xmlns="x"><label>L</label><description>Base</description>
  <classAccesses><apexClass>Zeta</apexClass><enabled>true</enabled></classAccesses>
  <classAccesses><apexClass>Alpha</apexClass><enabled>true</enabled></classAccesses>
  <fieldPermissions><editable>false</editable><field>Lead.A__c</field><readable>true</readable></fieldPermissions>
  <fieldPermissions><editable>false</editable><field>Lead.A__c</field><readable>true</readable></fieldPermissions></PermissionSet>`;
const I2 = `<PermissionSet xmlns="x"><label>L</label><description>Incoming</description>
  <classAccesses><apexClass>Mid</apexClass><enabled>true</enabled></classAccesses>
  <fieldPermissions><editable>true</editable><field>Lead.A__c</field><readable>true</readable></fieldPermissions></PermissionSet>`;

ok('two-way: target keeps everything, incoming is added, incoming wins, duplicates go', () => {
  const r = merger.merge(X.parse(T2), X.parse(I2), {});
  const t = fmt(r.merged);
  for (const s of ['Zeta', 'Alpha', 'Mid']) assert.ok(t.indexOf(s) !== -1, s);
  assert.ok(t.indexOf('<description>Incoming</description>') !== -1);
  assert.strictEqual(t.split('Lead.A__c').length - 1, 1);
  assert.strictEqual(r.report.duplicates.length, 1);
  assert.strictEqual(r.report.conflicts.length, 2);
});

ok('conflict winner can be the target', () => {
  const r = merger.merge(X.parse(T2), X.parse(I2), { winner: 'target' });
  assert.ok(fmt(r.merged).indexOf('<description>Base</description>') !== -1);
  assert.ok(r.report.conflicts.every(c => c.kept === c.base));
});

ok('merge without formatting keeps the target order and appends new entries', () => {
  const r = merger.merge(X.parse(T2), X.parse(I2), {});
  const t = fmt(r.merged, { elementOrder: 'preserve', sortCollections: false });
  assert.deepStrictEqual(t.match(/<apexClass>\w+/g).map(s => s.slice(11)), ['Zeta', 'Alpha', 'Mid']);
  assert.deepStrictEqual(tags(t).slice(0, 2), ['label', 'description']);
});

const ANC = `<PermissionSet xmlns="x"><label>L</label><description>Orig</description><hasActivationRequired>false</hasActivationRequired>
  <classAccesses><apexClass>Shared</apexClass><enabled>true</enabled></classAccesses>
  <classAccesses><apexClass>GoneInIncoming</apexClass><enabled>true</enabled></classAccesses>
  <classAccesses><apexClass>GoneInTarget</apexClass><enabled>true</enabled></classAccesses>
  <fieldPermissions><editable>false</editable><field>Lead.Both__c</field><readable>true</readable></fieldPermissions></PermissionSet>`;
const T3 = `<PermissionSet xmlns="x"><label>L</label><description>Target changed</description><hasActivationRequired>false</hasActivationRequired>
  <classAccesses><apexClass>Shared</apexClass><enabled>true</enabled></classAccesses>
  <classAccesses><apexClass>GoneInIncoming</apexClass><enabled>true</enabled></classAccesses>
  <fieldPermissions><editable>true</editable><field>Lead.Both__c</field><readable>true</readable></fieldPermissions></PermissionSet>`;
const I3 = `<PermissionSet xmlns="x"><label>L</label><description>Incoming changed</description><hasActivationRequired>true</hasActivationRequired>
  <classAccesses><apexClass>Shared</apexClass><enabled>true</enabled></classAccesses>
  <classAccesses><apexClass>GoneInTarget</apexClass><enabled>true</enabled></classAccesses>
  <fieldPermissions><editable>false</editable><field>Lead.Both__c</field><readable>false</readable></fieldPermissions></PermissionSet>`;
const three = merger.merge(X.parse(T3), X.parse(I3), { ancestor: X.parse(ANC) });
const threeText = fmt(three.merged);

ok('three-way: one-sided changes resolve silently, only both-sided ones conflict', () => {
  assert.strictEqual(three.threeWay, true);
  assert.ok(threeText.indexOf('<hasActivationRequired>true</hasActivationRequired>') !== -1);
  assert.deepStrictEqual(three.report.conflicts.map(c => c.tag), ['description']);
  assert.strictEqual(three.report.conflicts[0].ancestor, 'Orig');
});

ok('three-way: incoming deletion kept and reported, target deletion not resurrected', () => {
  assert.ok(threeText.indexOf('GoneInIncoming') !== -1);
  assert.ok(three.report.deletions.some(d => d.label === 'GoneInIncoming'));
  assert.ok(threeText.indexOf('GoneInTarget') === -1);
  assert.ok(three.report.skipped.some(s => s.label === 'GoneInTarget'));
});

ok('three-way: two innocent halves can still break a deploy rule - and it is caught', () => {
  const found = rules.check(X.parse(threeText), {});
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].id, 'field.editableRequiresReadable');
  assert.strictEqual(findDuplicates(X.parse(threeText), {}).length, 0);
});

ok('merged lines are annotated for the editor', () => {
  const marks = [];
  const text = fmt(three.merged, { marks });
  const lines = text.split('\n');
  const c = marks.find(m => m.mark.kind === 'conflict');
  assert.ok(lines[c.startLine].indexOf('<description>') !== -1);
  assert.ok(marks.some(m => m.mark.kind === 'deleted') && marks.some(m => m.mark.kind === 'auto'));
});

ok('keep-target policy ignores the incoming version of a section', () => {
  const A = '<Profile xmlns="x"><loginIpRanges><endAddress>10.0.0.9</endAddress><startAddress>10.0.0.1</startAddress></loginIpRanges></Profile>';
  const B = '<Profile xmlns="x"><loginIpRanges><endAddress>1.1.1.9</endAddress><startAddress>1.1.1.1</startAddress></loginIpRanges></Profile>';
  const r = merger.merge(X.parse(A), X.parse(B), { keepTarget: ['loginIpRanges'] });
  const t = fmt(r.merged);
  assert.ok(t.indexOf('10.0.0.1') !== -1 && t.indexOf('1.1.1.1') === -1);
  assert.strictEqual(r.report.conflicts.length, 0);
});

/* ------------------------------------------------------------ rules */
section('deploy rules');

ok('object permission implications, record type and layout defaults, field twice on a layout', () => {
  const a = rules.check(X.parse('<Profile xmlns="x"><objectPermissions><allowDelete>true</allowDelete><allowEdit>false</allowEdit><allowRead>true</allowRead><object>Quote</object></objectPermissions></Profile>'), {});
  assert.strictEqual(a[0].id, 'object.permissionImplications');
  const b = rules.check(X.parse('<Profile xmlns="x"><recordTypeVisibilities><default>true</default><recordType>Lead.A</recordType><visible>true</visible></recordTypeVisibilities><recordTypeVisibilities><default>true</default><recordType>Lead.B</recordType><visible>true</visible></recordTypeVisibilities></Profile>'), {});
  assert.strictEqual(b[0].id, 'recordType.singleDefaultPerObject');
  const c = rules.check(X.parse('<Profile xmlns="x"><layoutAssignments><layout>Lead-A</layout></layoutAssignments><layoutAssignments><layout>Lead-B</layout></layoutAssignments></Profile>'), {});
  assert.strictEqual(c[0].id, 'layoutAssignment.oneDefaultPerObject');
  const d = rules.check(X.parse('<Layout xmlns="x"><layoutSections><layoutColumns><layoutItems><field>R</field></layoutItems></layoutColumns></layoutSections><layoutSections><layoutColumns><layoutItems><field>R</field></layoutItems></layoutColumns></layoutSections></Layout>'), {});
  assert.strictEqual(d[0].id, 'layout.fieldAppearsOnce');
});

ok('rules can be disabled by id', () => {
  const doc = X.parse('<PermissionSet xmlns="x"><fieldPermissions><editable>true</editable><field>F</field><readable>false</readable></fieldPermissions></PermissionSet>');
  assert.strictEqual(rules.check(doc, {}).length, 1);
  assert.strictEqual(rules.check(doc, { disabled: ['field.editableRequiresReadable'] }).length, 0);
});

/* ------------------------------------------------------------ manifest */
section('package.xml from Copado commit JSON');

const load = f => manifest.parseCommit(fs.readFileSync(FIX(f), 'utf8'), f);

ok('reads every real commit file', () => {
  const counts = ['Copado_Commit_changes.json', 'Copado_Commit_changes__1_.json', 'Copado_Commit_changes__2_.json', 'Copado_Commit_changes__3_.json']
    .map(f => load(f).length);
  assert.deepStrictEqual(counts, [25, 122, 50, 33]);
});

ok('RetrieveOnly is retrieved but never deployed', () => {
  const r = manifest.build(load('Copado_Commit_changes__3_.json'), {});
  assert.deepStrictEqual(r.counts, { deploy: 1, retrieve: 33, retrieveOnly: 32, destructive: 0, selective: 0 });
  const deployXml = manifest.toPackageXml(r.deploy, '62.0');
  assert.ok(deployXml.indexOf('ACME_PermissionSet_14') !== -1);
  assert.ok(deployXml.indexOf('ACME_Object_02__c') === -1, 'retrieve-only components stay out of the deploy');
  const retrieveXml = manifest.toPackageXml(r.retrieve, '62.0');
  assert.ok(retrieveXml.indexOf('ACME_Object_02__c.ACME_Field_101__c') !== -1 && retrieveXml.indexOf('ACME_PermissionSet_14') !== -1);
});

ok('URL-encoded names are decoded and standard fields are flagged', () => {
  const r = manifest.build(load('Copado_Commit_changes__1_.json'), {});
  assert.ok(r.deploy.get('Profile').has('[N] ACME Profile 01'));
  const std = r.notes.find(n => n.id === 'standard-fields');
  assert.strictEqual(std.components.length, 52);
  assert.ok(r.notes.some(n => n.id === 'partial-profile'));
  assert.ok(!r.notes.some(n => n.id === 'standard-fields' && n.components.some(c => /__c$/.test(c.name))));
});

ok('test classes in the package are suggested', () => {
  const r = manifest.build(load('Copado_Commit_changes__2_.json'), {});
  assert.strictEqual(r.hasApex, true);
  assert.deepStrictEqual(r.testClasses, ['ACME_Service01Test', 'ACME_Service02Test'], 'sorted by name');
  const none = manifest.build(load('Copado_Commit_changes.json'), {});
  assert.strictEqual(none.hasApex, false);
});

ok('several commits combine into one package without duplicates', () => {
  const rows = load('Copado_Commit_changes__1_.json').concat(load('Copado_Commit_changes__2_.json'));
  const r = manifest.build(rows, {});
  assert.strictEqual(r.deploy.get('PermissionSet').has('ACME_PermissionSet_14'), true);
  const xml = manifest.toPackageXml(r.deploy, '62.0');
  assert.strictEqual(xml.split('<members>ACME_PermissionSet_14</members>').length - 1, 1);
});

ok('Add beats RetrieveOnly for the same component; unknown actions are skipped with a warning', () => {
  const rows = manifest.parseCommit(JSON.stringify([
    { t: 'CustomField', n: 'A__c.F__c', a: 'RetrieveOnly' },
    { t: 'CustomField', n: 'A__c.F__c', a: 'Add' },
    { t: 'ApexClass', n: 'X', a: 'Mystery' },
    { t: 'ApexClass', n: 'Old', a: 'Delete' }
  ]));
  const r = manifest.build(rows, {});
  assert.ok(r.deploy.get('CustomField').has('A__c.F__c'));
  assert.ok(!r.retrieveOnly.has('CustomField'));
  assert.ok(r.notes.some(n => n.id === 'unknown-action' && /Mystery/.test(n.message)));
  assert.ok(r.destructive.get('ApexClass').has('Old'));
  assert.ok(!r.deploy.has('ApexClass'));
});

ok('action mapping is configurable', () => {
  const rows = manifest.parseCommit(JSON.stringify([{ t: 'ApexClass', n: 'X', a: 'Mystery' }]));
  const r = manifest.build(rows, { actions: { Mystery: 'deploy' } });
  assert.ok(r.deploy.get('ApexClass').has('X'));
});

ok('package.xml is canonical: sorted types and members, escaped, versioned', () => {
  const m = new Map([['Layout', new Set(['B & C', 'A'])], ['ApexClass', new Set(['Z', 'Y'])]]);
  const xml = manifest.toPackageXml(m, '61.0');
  assert.ok(xml.indexOf('<name>ApexClass</name>') < xml.indexOf('<name>Layout</name>'));
  assert.ok(xml.indexOf('<members>Y</members>') < xml.indexOf('<members>Z</members>'));
  assert.ok(xml.indexOf('B &amp; C') !== -1);
  assert.ok(xml.indexOf('<version>61.0</version>') !== -1);
  assert.strictEqual(findDuplicates(X.parse(xml), {}).length, 0);
  assert.strictEqual(manifest.apiVersionFrom('{"sourceApiVersion":"63.0"}'), '63.0');
});

ok('bad input is rejected with a clear message', () => {
  assert.throws(() => manifest.parseCommit('{nope', 'x.json'), /not valid JSON/);
  assert.throws(() => manifest.parseCommit('{"a":1}', 'x.json'), /expected a JSON array/);
});

/* ------------------------------------------------------------ git */
section('git branch conflicts (real repository)');

let repo;
function sh(args) { return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function setupRepo() {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cra-git-'));
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 't@t']);
  sh(['config', 'user.name', 't']);
  const dir = path.join(repo, 'force-app/main/default/permissionsets');
  fs.mkdirSync(dir, { recursive: true });
  const ps = path.join(dir, 'ACME_PermissionSet_14.permissionset-meta.xml');
  const block = c => '    <classAccesses>\n        <apexClass>' + c + '</apexClass>\n        <enabled>true</enabled>\n    </classAccesses>\n';
  const doc = extra => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>Billing</label>\n' +
    block('ACME_InvoiceService') + extra + '</PermissionSet>\n';
  fs.writeFileSync(ps, doc(''));
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
  sh(['add', '-A']); sh(['commit', '-qm', 'base']);
  sh(['checkout', '-qb', 'qa']);
  fs.writeFileSync(ps, doc(block('ACME_QaHotfix')));
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'a-qa\nb\nc\n');
  fs.appendFileSync(path.join(repo, 'README.md'), 'qa\n');
  sh(['commit', '-qam', 'qa']);
  sh(['checkout', '-q', 'main']); sh(['checkout', '-qb', 'dev']);
  fs.writeFileSync(ps, doc(block('ACME_Service01')));
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'a\nb\nc-dev\n');
  sh(['commit', '-qam', 'dev']);
  sh(['checkout', '-q', 'qa']);
}

ok('finds the git conflict and the both-changed file, without touching the working tree', async () => {
  setupRepo();
  const before = sh(['status', '--porcelain']) + sh(['rev-parse', 'HEAD']);
  const r = await gitops.analyse(repo, 'qa', 'dev', {});
  const after = sh(['status', '--porcelain']) + sh(['rev-parse', 'HEAD']);
  assert.strictEqual(before, after, 'read-only');
  assert.strictEqual(await gitops.currentBranch(repo), 'qa');
  const byPath = Object.fromEntries(r.files.map(f => [path.basename(f.path), f]));
  assert.strictEqual(byPath['ACME_PermissionSet_14.permissionset-meta.xml'].status, 'conflict');
  assert.strictEqual(byPath['ACME_PermissionSet_14.permissionset-meta.xml'].metadata, true);
  assert.strictEqual(byPath['shared.txt'].status, 'both', 'git merges it, but both branches changed it');
  assert.ok(!byPath['README.md'], 'changed on one side only');
});

ok('gives all three versions, and the semantic three-way merge resolves the git conflict by itself', async () => {
  const r = await gitops.analyse(repo, 'qa', 'dev', { metadataOnly: true });
  assert.strictEqual(r.files.length, 1);
  const p = r.files[0].path;
  const [anc, tgt, inc] = await Promise.all([gitops.show(repo, r.base, p), gitops.show(repo, r.target.sha, p), gitops.show(repo, r.incoming.sha, p)]);
  const m = merger.merge(X.parse(tgt), X.parse(inc), { ancestor: X.parse(anc) });
  const text = fmt(m.merged);
  for (const c of ['ACME_InvoiceService', 'ACME_QaHotfix', 'ACME_Service01']) assert.ok(text.indexOf(c) !== -1, c);
  assert.strictEqual(m.report.conflicts.length, 0, 'git calls it a conflict; by metadata key it is two additions');
  assert.strictEqual(await gitops.show(repo, r.base, 'does-not-exist.xml'), null);
});

ok('branches resolve locally or on the remote, and a missing one is a clear error', async () => {
  const all = await gitops.branches(repo);
  assert.ok(all.indexOf('qa') !== -1 && all.indexOf('dev') !== -1);
  await assert.rejects(gitops.analyse(repo, 'uat', 'dev', {}), /uat" was not found/);
  assert.deepStrictEqual(gitops.parseMergeTree('abc123\nfoo.xml\nbar.xml\n\nmessages'), ['foo.xml', 'bar.xml']);
});

/* ------------------------------------------------------------ sf cli */
section('Salesforce CLI output and safety');

const failed = sfcli.parseDeploy(JSON.parse(fs.readFileSync(FIX('validate-failed.json'), 'utf8')));

ok('reads a failed validation from the error envelope', () => {
  assert.strictEqual(failed.id, '0Af8d00000AbCdEF');
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.componentFailures.length, 4);
  assert.strictEqual(failed.componentFailures[0].line, 412);
  assert.strictEqual(failed.testFailures.length, 1);
  assert.strictEqual(failed.testFailures[0].method, 'testInsert');
  assert.strictEqual(failed.coverageWarnings.length, 1);
});

ok('reads a successful validation from the result envelope', () => {
  const ok2 = sfcli.parseDeploy({ status: 0, result: { id: '0Af000000000001', status: 'Succeeded', success: true, checkOnly: true, numberComponentErrors: 0, details: { componentFailures: [], runTestResult: { failures: [] } } } });
  assert.strictEqual(ok2.success, true);
  assert.strictEqual(ok2.componentFailures.length, 0);
  assert.strictEqual(ok2.id, '0Af000000000001');
});

ok('tolerates warnings printed before the JSON', () => {
  assert.deepStrictEqual(sfcli.parseJson('Warning: update available\n{"status":0}'), { status: 0 });
});

ok('lists orgs from every bucket of sf org list', () => {
  const orgs = sfcli.parseOrgs({ status: 0, result: {
    nonScratchOrgs: [{ alias: 'qa', username: 'me@acme.com.qa', instanceUrl: 'https://acme--qa.sandbox.my.salesforce.com', isSandbox: true }],
    sandboxes: [{ alias: 'qa', username: 'me@acme.com.qa' }],
    other: [{ username: 'me@acme.com', instanceUrl: 'https://acme.my.salesforce.com' }]
  } });
  assert.strictEqual(orgs.length, 2);
  assert.strictEqual(orgs.find(o => o.alias === 'qa').isSandbox, true);
  assert.strictEqual(orgs.find(o => !o.alias).isSandbox, false);
});

ok('validation is check-only and specified tests are passed through', () => {
  const a = sfcli.validateArgs({ org: 'qa', manifest: 'manifest/package.xml', testLevel: 'RunSpecifiedTests', tests: ['ATest', 'BTest'] });
  assert.deepStrictEqual(a.slice(0, 3), ['project', 'deploy', 'validate']);
  assert.deepStrictEqual(a.filter((x, i) => a[i - 1] === '--tests'), ['ATest', 'BTest']);
  assert.strictEqual(a[a.indexOf('--test-level') + 1], 'RunSpecifiedTests');
  const local = sfcli.validateArgs({ org: 'qa', manifest: 'manifest/package.xml', testLevel: 'RunLocalTests' });
  assert.deepStrictEqual(local.slice(0, 3), ['project', 'deploy', 'validate']);
  // deploy validate rejects NoTestRun, so no-test validation is a dry-run deploy
  const b = sfcli.validateArgs({ org: 'qa', manifest: 'p.xml', testLevel: 'NoTestRun', tests: ['ignored'] });
  assert.deepStrictEqual(b.slice(0, 4), ['project', 'deploy', 'start', '--dry-run']);
  assert.strictEqual(b[b.indexOf('--test-level') + 1], 'NoTestRun');
  assert.ok(b.indexOf('--tests') === -1 && b.indexOf('--manifest') !== -1);
  for (const level of ['NoTestRun', 'RunLocalTests', 'RunSpecifiedTests', 'RunAllTestsInOrg', undefined]) {
    const args = sfcli.validateArgs({ org: 'qa', manifest: 'manifest/package.xml', testLevel: level, tests: ['T'] });
    assert.ok(args[2] === 'validate' || (args[2] === 'start' && args[3] === '--dry-run'), 'check-only for ' + level);
    if (args[2] === 'validate') assert.notStrictEqual(args[args.indexOf('--test-level') + 1], 'NoTestRun');
  }
  const r = sfcli.retrieveArgs({ manifest: 'manifest/package.xml', org: 'dev' });
  // a standard source-format retrieve into the project, allowed to overwrite local files
  assert.ok(r.indexOf('--ignore-conflicts') !== -1);
  assert.ok(r.indexOf('--target-metadata-dir') === -1 && r.indexOf('--output-dir') === -1, 'into the project, not elsewhere');
  const d = sfcli.validateArgs({ org: 'qa', manifest: 'manifest/package.xml', destructiveChanges: 'manifest/destructiveChanges.xml', testLevel: 'NoTestRun' });
  assert.strictEqual(d[d.indexOf('--post-destructive-changes') + 1], 'manifest/destructiveChanges.xml');
  assert.strictEqual(d[d.indexOf('--manifest') + 1], 'manifest/package.xml');
  assert.deepStrictEqual(r.slice(0, 3), ['project', 'retrieve', 'start']);
});

ok('retrieve and validation use source format, from the project - never Metadata API format', () => {
  const mdapiFormat = ['--target-metadata-dir', '--metadata-dir', '--single-package', '--zip-file-name', '--unzip'];
  const commands = [
    sfcli.retrieveArgs({ manifest: 'manifest/package.xml', org: 'dev' }),
    sfcli.validateArgs({ org: 'qa', manifest: 'manifest/package.xml', testLevel: 'RunSpecifiedTests', tests: ['T'] }),
    sfcli.validateArgs({ org: 'qa', manifest: 'manifest/package.xml', testLevel: 'RunLocalTests' }),
    sfcli.validateArgs({ org: 'qa', manifest: 'manifest/package.xml', testLevel: 'NoTestRun' })
  ];
  for (const args of commands) {
    assert.ok(!args.some(a => mdapiFormat.includes(a)), 'no Metadata API format flag in: sf ' + args.join(' '));
    assert.strictEqual(args[args.indexOf('--manifest') + 1], 'manifest/package.xml', 'the manifest selects components from the project');
  }
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'sfcli.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'release.js'), 'utf8');
  assert.ok(!/'--(?:target-)?metadata-dir'|'convert',\s*'mdapi'|'mdapi'/.test(code), 'nothing builds a Metadata API format command');
});

ok('there is no code path that performs a real deployment', () => {
  const files = ['src/sfcli.js', 'release.js', 'extension.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  const code = files.join('\n').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const starts = code.match(/'deploy',\s*'start'[^\]]*/g) || [];
  assert.strictEqual(starts.length, 1, 'exactly one place builds "deploy start"');
  assert.ok(/^'deploy',\s*'start',\s*'--dry-run'/.test(starts[0]), '...and it is always --dry-run');
  assert.ok(!/'deploy',\s*'quick'/.test(code), 'no quick deploy');
  assert.ok(!/deploy\s+(start|quick)/.test(code.replace(/'[^'\n]*--dry-run[^'\n]*'/g, '')), 'no deploy command spelled out in a string');
});

ok('a CLI error that is not about a component keeps its message', () => {
  const r = sfcli.parseDeploy({ status: 1, name: 'FlagError', message: 'Expected --test-level=NoTestRun to be one of: RunAllTestsInOrg, RunLocalTests, RunSpecifiedTests', exitCode: 2 });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.componentFailures.length, 0);
  assert.ok(/NoTestRun/.test(r.message));
  assert.strictEqual(r.errorName, 'FlagError');
  const expired = sfcli.parseDeploy({ status: 1, name: 'AuthError', message: 'expired access/refresh token', actions: ['Run sf org login web'] });
  assert.deepStrictEqual(expired.actions, ['Run sf org login web']);
});

/* ------------------------------------------------------------ fixes */
section('error to fix');

const ctx3 = { isRetrieveOnly: (t, n) => t === 'CustomField' && n.indexOf('ACME_Object_02__c.') === 0 };

ok('a missing field in a permission set: deploy it (it is RetrieveOnly) or remove the reference', () => {
  const s = fixes.suggest(failed.componentFailures[0], ctx3);
  assert.strictEqual(s.length, 2);
  assert.strictEqual(s[0].kind, 'package');
  assert.ok(/RetrieveOnly/.test(s[0].title));
  assert.deepStrictEqual(s[0].component, { type: 'CustomField', name: 'ACME_Object_02__c.ACME_Field_101__c' });
  assert.strictEqual(s[1].kind, 'edit');
  assert.strictEqual(s[1].childTag, 'field');
});

ok('a missing Apex class, a standard field, and a permission dependency', () => {
  assert.strictEqual(fixes.suggest(failed.componentFailures[1], ctx3)[0].component.type, 'ApexClass');
  const std = fixes.suggest(failed.componentFailures[2], ctx3);
  assert.strictEqual(std[0].pattern, 'standard-field');
  assert.strictEqual(std[0].op, 'remove');
  const dep = fixes.suggest(failed.componentFailures[3], ctx3);
  assert.deepStrictEqual(dep[0].names, ['ViewRoles']);
});

ok('a missing standard object is advice, not something to deploy; a missing metadata type is', () => {
  const std = fixes.suggest({ type: 'PermissionSet', fullName: 'Billing_PS', problem: 'In field: object - no CustomObject named AssetContractRelationship found' }, {});
  assert.strictEqual(std[0].kind, 'info', 'a standard object cannot be deployed');
  assert.ok(!std.some(x => x.kind === 'package'));
  assert.strictEqual(std[1].op, 'removeEntries', 'removing the reference is still offered');
  const custom = fixes.suggest({ type: 'PermissionSet', fullName: 'Billing_PS', problem: 'In field: object - no CustomObject named Bill_Frequency__c found' }, {});
  assert.strictEqual(custom[0].kind, 'package');
  const mdt = fixes.suggest({ type: 'CustomMetadata', fullName: 'Field_Mapping.OrderNumber', problem: 'Custom metadata type Field_Mapping__mdt is not available in this organization.' }, {});
  assert.deepStrictEqual(mdt[0].component, { type: 'CustomObject', name: 'Field_Mapping__mdt' });
});

ok('an unrecognised error gets no guess', () => {
  assert.deepStrictEqual(fixes.suggest({ type: 'Flow', fullName: 'X', problem: 'Something entirely new happened' }, {}), []);
});

ok('removing entries changes only those entries, byte for byte', () => {
  const src = '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="x">\n' +
    '    <fieldPermissions>\n        <editable>false</editable>\n        <field>ACME_Object_02__c.ACME_Field_101__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n' +
    '    <fieldPermissions>\n        <editable>false</editable>\n        <field>Lead.Keep__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n' +
    '    <label>B</label>\n</PermissionSet>\n';
  const r = fixes.applyEdit(src, fixes.suggest(failed.componentFailures[0], ctx3)[1]);
  assert.strictEqual(r.count, 1);
  const expected = src.replace(/    <fieldPermissions>\n        <editable>false<\/editable>\n        <field>ACME_Object_02__c[\s\S]*?<\/fieldPermissions>\n/, '');
  assert.strictEqual(r.text, expected);
});

ok('enabling a dependent permission adds it once and is idempotent', () => {
  const src = '<PermissionSet xmlns="x">\n    <label>B</label>\n</PermissionSet>\n';
  const fix = fixes.suggest(failed.componentFailures[3], ctx3)[0];
  const once = fixes.applyEdit(src, fix);
  assert.strictEqual(once.count, 1);
  assert.ok(/<name>ViewRoles<\/name>/.test(once.text));
  assert.strictEqual(fixes.applyEdit(once.text, fix).count, 0);
  const disabled = '<PermissionSet xmlns="x">\n    <userPermissions>\n        <enabled>false</enabled>\n        <name>ViewRoles</name>\n    </userPermissions>\n</PermissionSet>\n';
  assert.ok(/<enabled>true<\/enabled>/.test(fixes.applyEdit(disabled, fix).text));
});

ok('failing files are located in either Metadata API or source layout', () => {
  assert.deepStrictEqual(fixes.candidatePaths({ fileName: 'unpackaged/permissionsets/A.permissionset' }),
    ['unpackaged/permissionsets/A.permissionset', 'permissionsets/A.permissionset', 'unpackaged/permissionsets/A.permissionset-meta.xml']);
});

/* ------------------------------------------------------------ project folders */
section('project folders');

ok('folder settings stay inside the project and out of package directories', () => {
  const paths = require('../src/paths');
  const proj = JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }, { path: 'unpackaged' }] });
  assert.strictEqual(paths.projectFolder('manifest', 'manifest', proj), 'manifest');
  assert.strictEqual(paths.projectFolder('.copado/', '.copado', proj), '.copado');
  assert.strictEqual(paths.projectFolder('tools\\copado', '.copado', proj), 'tools/copado', 'windows separators');
  for (const bad of ['/etc', 'C:\\temp', '../outside', 'a/../../b', '']) {
    assert.strictEqual(paths.projectFolder(bad, '.copado', proj), '.copado', 'rejected: ' + JSON.stringify(bad));
  }
  assert.strictEqual(paths.projectFolder('force-app/main/default/x', '.copado', proj), '.copado', 'never inside force-app');
  assert.strictEqual(paths.projectFolder('unpackaged', 'manifest', proj), 'manifest', 'never a package directory itself');
  assert.strictEqual(paths.projectFolder('force-application', '.copado', proj), 'force-application', 'a similar name is fine');
  assert.deepStrictEqual(paths.packageDirsOf('not json'), ['force-app']);
});

/* ------------------------------------------------------------ windows and projects */
section('windows command line and project detection');

/**
 * What Windows does to the command line we build: cmd.exe /s /c strips the
 * outer quotes and removes carets, then the program's runtime splits the
 * rest into arguments (MSVCRT rules). If the round trip gives back exactly
 * the arguments we started with, cmd.exe cannot split or mangle them.
 */
function windowsRoundTrip(spec) {
  assert.deepStrictEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  let line = spec.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  line = line.slice(1, -1);
  let unc = '';
  for (let i = 0; i < line.length; i++) unc += line[i] === '^' ? line[++i] : line[i];
  const argv = [];
  let cur = '', inQ = false, any = false;
  for (let i = 0; i < unc.length; i++) {
    const ch = unc[i];
    if (ch === '\\') {
      let n = 0;
      while (unc[i] === '\\') { n++; i++; }
      if (unc[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) { cur += '"'; } else { inQ = !inQ; any = true; } }
      else { cur += '\\'.repeat(n); i--; }
      continue;
    }
    if (ch === '"') { inQ = !inQ; any = true; continue; }
    if ((ch === ' ' || ch === '\t') && !inQ) { if (cur || any) argv.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) argv.push(cur);
  return argv;
}

ok('paths with spaces reach the CLI as one argument on Windows', () => {
  const nasty = [
    'C:\\ACME Release\\Release Work\\manifest\\package.xml',
    'C:\\Users\\me\\My Projects (work)\\manifest\\package.xml',
    'D:\\R&D\\100% done\\pkg.xml',
    'C:\\trailing\\slash\\',
    'say "hi"', 'a;b,c', '[N] Sales Profile', ''
  ];
  const spec = sfcli.commandFor('sf', ['project', 'retrieve', 'start', '--manifest'].concat(nasty), 'win32');
  assert.strictEqual(spec.verbatim, true);
  assert.deepStrictEqual(windowsRoundTrip(spec), ['sf', 'project', 'retrieve', 'start', '--manifest'].concat(nasty));
  // the configured CLI path can contain spaces too
  const custom = sfcli.commandFor('C:\\Program Files\\sf\\bin\\sf.cmd', ['org', 'list'], 'win32');
  assert.deepStrictEqual(windowsRoundTrip(custom), ['C:\\Program Files\\sf\\bin\\sf.cmd', 'org', 'list']);
  // elsewhere there is no shell at all
  assert.deepStrictEqual(sfcli.commandFor('sf', ['a b'], 'darwin'), { command: 'sf', args: ['a b'], verbatim: false });
});

ok('the project is found automatically, and the setting overrides it', () => {
  const paths = require('../src/paths');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cra proj '));        // a space on purpose
  const mk = (rel, project) => { const d = path.join(base, rel); fs.mkdirSync(d, { recursive: true }); if (project) fs.writeFileSync(path.join(d, 'sfdx-project.json'), '{}'); return d; };
  const single = mk('ACME Release/Release Work', true);
  mk('ACME Release/Release Work/force-app/main/default/permissionsets');
  const file = path.join(single, 'force-app/main/default/permissionsets/A.permissionset-meta.xml');
  fs.writeFileSync(file, '<PermissionSet/>');

  assert.strictEqual(paths.findProjectRoot({ folders: [single] }).root, single, 'the open folder');
  assert.strictEqual(paths.findProjectRoot({ folders: [path.join(base, 'ACME Release')] }).root, single, 'one level below');
  assert.strictEqual(paths.findProjectRoot({ folders: [base] }).root, single, 'two levels below');
  assert.strictEqual(paths.findProjectRoot({ folders: [base], activeFile: file }).root, single, 'from the open file');

  const second = mk('Other/Repo', true);
  const many = paths.findProjectRoot({ folders: [base] });
  assert.strictEqual(many.root, null);
  assert.strictEqual(many.candidates.length, 2);
  assert.ok(/cmr\.project\.path/.test(many.error));
  assert.strictEqual(paths.findProjectRoot({ folders: [base], activeFile: file }).root, single, 'the open file decides');
  assert.strictEqual(paths.findProjectRoot({ folders: [base], configured: 'Other/Repo' }).root, second, 'relative setting');
  assert.strictEqual(paths.findProjectRoot({ folders: [base], configured: single }).root, single, 'absolute setting');
  assert.ok(/no sfdx-project\.json/.test(paths.findProjectRoot({ folders: [base], configured: 'nope' }).error));
  assert.strictEqual(paths.findProjectRoot({ folders: [mk('empty')] }).root, null);

  assert.strictEqual(paths.forCli(path.join(single, 'manifest', 'package.xml'), single), 'manifest/package.xml');
  assert.strictEqual(paths.forCli(path.join(base, 'elsewhere.xml'), single), path.join(base, 'elsewhere.xml'));
  rmTree(base);
});

/* ------------------------------------------------------------ live output */
section('live CLI output');

ok('terminal output becomes clean lines: no colour codes, spinners or redraws', () => {
  const lines = [];
  const statuses = [];
  const c = sfcli.lineCleaner(l => lines.push(l), s => statuses.push(s));
  c.push('\u001b[1m\u2500\u2500 Retrieving \u2500\u2500\u001b[22m\n\n\n');
  c.push('\u001b[32m\u2714\u001b[39m Preparing 7ms\n');
  c.push('\r\u280b Waiting 1s');
  c.push('\r\u2819 Waiting 2s');
  assert.deepStrictEqual(statuses.slice(-1), ['Waiting 2s'], 'a line being redrawn is a status, not a log line');
  c.push('\r\u2714 Waiting 3s\n');
  c.push('Status: Done\nStatus: Done\n \u00bb   Warning: @salesforce/cli update available from 1 to 2.\n');
  c.flush();
  assert.deepStrictEqual(lines, ['\u2500\u2500 Retrieving \u2500\u2500', '', '\u2714 Preparing 7ms', '\u2714 Waiting 3s', 'Status: Done']);
});

ok('the deploy id and the error are read from what the CLI printed', () => {
  assert.strictEqual(sfcli.deployIdFrom(['Deploying v62.0 metadata', 'Deploy ID: 0Af000000000004AAA', '']), '0Af000000000004AAA');
  assert.strictEqual(sfcli.deployIdFrom(['nothing here']), null);
  assert.ok(/No file found at x/.test(sfcli.errorFrom(['Error (1): Parsing --manifest', '    No file found at x', '', 'See more help'])));
});

ok('a retrieve summary gives the file count and the components that were not found', () => {
  const plain = sfcli.parseRetrieveText([
    'State   Name        Type           Path',
    'Changed Sales_User  PermissionSet  force-app/main/default/permissionsets/Sales_User.permissionset-meta.xml',
    'Unchanged Region__c CustomField    force-app/main/default/objects/Invoice__c/fields/Region__c.field-meta.xml',
    "Invoice__c.Gone__c  CustomField  Entity of type 'CustomField' named 'Invoice__c.Gone__c' cannot be found"
  ]);
  assert.strictEqual(plain.files, 2);
  assert.strictEqual(plain.warnings.length, 1);
  const boxed = sfcli.parseRetrieveText(['\u2502 Changed \u2502 A \u2502 ApexClass \u2502 force-app/main/default/classes/A.cls \u2502', 'Status: Succeeded']);
  assert.strictEqual(boxed.files, 1);
  assert.strictEqual(sfcli.parseRetrieveText(['No results found']).files, 0);
});

ok('a real retrieve and validation log collapse to one snapshot per status', () => {
  const replay = require('./fixtures/cli-replay');
  for (const [gen, statuses, heading] of [
    [replay.retrieveFrames, ['\u2026', '\u2026', 'Pending', 'In Progress', 'Succeeded'], /Retrieving Metadata/],
    [replay.validateFrames, ['\u2026', '\u2026', 'Pending', 'In Progress', 'Failed'], /Validating Deployment \u2500/]
  ]) {
    const input = gen();
    const lines = [];
    const f = sfcli.reprintFilter(l => lines.push(l), null, {});
    input.forEach(l => f.line(l));
    f.flush();
    const frames = input.filter(l => heading.test(l)).length;
    assert.ok(frames >= 30, 'the replay has ' + frames + ' frames');
    assert.deepStrictEqual(lines.filter(l => /^\s*Status:/.test(l)).map(l => l.replace(/^\s*Status:\s*/, '')), statuses,
      'one snapshot per status from ' + frames + ' frames');
    assert.strictEqual(lines.filter(l => heading.test(l)).length, 5);
    assert.ok(!lines.some(l => /^\s*[|\/\\-]\S/.test(l)), 'no spinner glyph is printed');
    assert.ok(!lines.some(l => /Status:\s*[|\/\\-]\s*$/.test(l)), 'a spinning status value shows as \u2026');
    const real = lines.filter(l => l.trim());
    assert.ok(real.length <= 70, frames + ' frames became ' + real.length + ' lines');
  }
  const r = [];
  const g = sfcli.reprintFilter(l => r.push(l), null, {});
  replay.retrieveFrames().forEach(l => g.line(l));
  g.flush();
  assert.strictEqual(r.filter(l => /Retrieved Source/.test(l)).length, 1);
  assert.strictEqual(r.filter(l => /Status: Succeeded/.test(l)).length, 1, 'the CLI\'s repeated final frame is not shown twice');
  assert.strictEqual(sfcli.parseRetrieveText(r).files, 3);
});

function fakeSf(dir) {
  const script = path.join(__dirname, 'fixtures', 'fake-sf.js');
  if (process.platform === 'win32') {
    const p = path.join(dir, 'sf.cmd');
    fs.writeFileSync(p, '@"' + process.execPath + '" "' + script + '" %*\r\n');
    return p;
  }
  const p = path.join(dir, 'sf');
  fs.writeFileSync(p, '#!/bin/sh\nexec "' + process.execPath + '" "' + script + '" "$@"\n');
  fs.chmodSync(p, 0o755);
  return p;
}

ok('retrieve and validation stream the CLI output live, then return a structured result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra live '));     // a space on purpose
  fs.mkdirSync(path.join(dir, 'manifest'));
  fs.writeFileSync(path.join(dir, 'manifest', 'package.xml'), '<Package/>');
  const sf = fakeSf(dir);
  const seen = [];
  const statuses = [];
  const onLine = l => seen.push({ l, at: Date.now() });
  const t0 = Date.now();

  const r = await sfcli.retrieve(sf, { manifest: 'manifest/package.xml', org: 'dev', cwd: dir, onLine, onStatus: s => statuses.push(s) });
  const doneAt = Date.now();
  assert.strictEqual(r.files, 2);
  assert.strictEqual(r.warnings.length, 1);
  assert.ok(seen.some(x => /Preparing retrieve request/.test(x.l)), 'stage lines reach the panel');
  assert.ok(statuses.some(s => /Waiting for the org to respond/.test(s)), 'the redrawn wait line is reported as status');
  assert.ok(!seen.some(x => /\u001b|\r|update available/.test(x.l)), 'no colour codes, redraws or CLI noise');
  const first = seen.find(x => /Preparing/.test(x.l));
  assert.ok(doneAt - first.at >= 250, 'lines arrive while the command is still running, not all at the end (' + (doneAt - first.at) + ' ms early)');

  seen.length = 0;
  const v = await sfcli.validate(sf, { org: 'qa', manifest: 'manifest/package.xml', testLevel: 'NoTestRun', cwd: dir, onLine });
  assert.ok(seen.some(x => /Deploy ID: 0Af000000000004AAA/.test(x.l)));
  assert.ok(seen.some(x => /fetching the detailed result/.test(x.l)));
  assert.strictEqual(v.success, false);
  assert.strictEqual(v.id, '0Af000000000004AAA');
  assert.strictEqual(v.componentFailures.length, 1, 'details come from deploy report');
  assert.strictEqual(v.componentFailures[0].line, 3);

  const bad = await sfcli.validate(sf, { org: 'qa', manifest: 'manifest/missing.xml', testLevel: 'NoTestRun', cwd: dir, onLine: () => {} });
  assert.strictEqual(bad.success, false);
  assert.ok(/No file found at manifest\/missing\.xml/.test(bad.message), 'the CLI error text becomes the message');
  assert.ok(Date.now() - t0 < 20000);
  rmTree(dir);
});

ok('spinners and ticking timers are not changes; a real change prints the whole snapshot', () => {
  let clock = 0;
  const lines = [];
  const statuses = [];
  const f = sfcli.reprintFilter(l => lines.push(l), s => statuses.push(s), { now: () => clock });
  const frame = (t, i, done) => [
    '\u2014\u2014\u2014 Retrieving Metadata \u2014\u2014\u2014', '', 'Retrieving v62.0 metadata from me@example.com.dev', '',
    '\u221aPreparing retrieve request 7ms', '\u221aSending request to org 444ms',
    (done ? '\u221aWaiting for the org to respond ' : '|/-\\'[i % 4] + 'Waiting for the org to respond ') + t + 's',
    done ? '\u221aDone 2ms' : '\u25a0Done', '', 'Status: ' + (done ? 'Succeeded' : 'Pending'), 'Elapsed Time: ' + t + 's', ''];
  for (let i = 0; i < 3000; i++) { clock = i * 30; frame((22.5 + i * 0.03).toFixed(2), i, false).forEach(l => f.line(l)); }
  const duringWait = lines.slice();
  frame('112.40', 0, true).forEach(l => f.line(l));
  ['Retrieved Source', 'Changed  Invoice__c.Field1__c  CustomField  force-app/x/Field1__c.field-meta.xml',
   'Changed  Invoice__c.Field2__c  CustomField  force-app/x/Field2__c.field-meta.xml'].forEach(l => f.line(l));
  f.flush();

  const count = (arr, re) => arr.filter(l => re.test(l)).length;
  // the first frame is shown live; 2999 reprints that only spin and tick add nothing
  assert.strictEqual(count(duringWait, /Retrieving Metadata/), 1, 'one snapshot during a 90-second wait');
  assert.strictEqual(count(duringWait, /Waiting for the org/), 1);
  assert.ok(!duringWait.some(l => /^[|\/\\-]/.test(l)), 'spinner glyphs are not printed');
  // the moment something real changes, the whole block is shown as it stood
  const last = lines.slice(lines.lastIndexOf('\u2014\u2014\u2014 Retrieving Metadata \u2014\u2014\u2014'));
  for (const want of ['\u221aPreparing retrieve request 7ms', '\u221aWaiting for the org to respond 112.40s', '\u221aDone 2ms', 'Status: Succeeded', 'Elapsed Time: 112.40s', 'Retrieved Source']) {
    assert.ok(last.includes(want), 'the final snapshot is complete: ' + want);
  }
  assert.strictEqual(count(lines, /Retrieving Metadata/), 2, 'two snapshots in all: the start and the change');
  assert.ok(statuses.some(x => /^Waiting for the org to respond 1\d\d\.\d\ds$/.test(x)), 'the live timer reaches the notification, without its spinner');
  assert.strictEqual(count(lines, /Field2__c/), 1);
  assert.ok(!lines.some((l, i) => !l.trim() && i > 0 && !lines[i - 1].trim()), 'no runs of blank lines');
});

ok('only a change in words prints a snapshot: status, a new stage, an error', () => {
  const lines = [];
  const f = sfcli.reprintFilter(l => lines.push(l), null, {});
  const frame = (spin, n, status, extra) => ['\u2500\u2500 Validating Deployment \u2500\u2500', 'Deploy ID: 0Af000000000004AAA',
    spin + 'Deploying Metadata ' + n + '.2s', 'Components: ' + n + '/27 (' + Math.round(n / 27 * 100) + '%)', 'Status: ' + status].concat(extra || []);
  for (let n = 1; n <= 20; n++) frame('|/-\\'[n % 4], n, 'Pending').forEach(l => f.line(l));
  for (let n = 1; n <= 20; n++) frame('|/-\\'[n % 4], n, 'In Progress').forEach(l => f.line(l));
  for (let n = 20; n <= 27; n++) frame('\u221a', n, 'In Progress', ['Running Tests']).forEach(l => f.line(l));
  frame('\u221a', 27, 'Failed', ['Running Tests', 'Error: Component failures']).forEach(l => f.line(l));
  f.flush();
  const statuses = lines.filter(l => /^Status:/.test(l));
  assert.deepStrictEqual(statuses, ['Status: Pending', 'Status: In Progress', 'Status: In Progress', 'Status: Failed'],
    'one snapshot each: Pending, In Progress, a new stage (Running Tests), Failed - none for 47 counter and spinner ticks');
  assert.strictEqual(lines.filter(l => /^Components/.test(l)).length, 4, 'a counter only appears inside those snapshots');
  assert.ok(lines.includes('Error: Component failures'));

  // output that never reprints is shown live, line by line
  const live = [];
  const g = sfcli.reprintFilter(l => live.push(l), null, {});
  ['Deploying v62.0 metadata', 'Deploy ID: 0Af000000000004AAA', 'Status: Failed'].forEach(l => g.line(l));
  assert.deepStrictEqual(live, ['Deploying v62.0 metadata', 'Deploy ID: 0Af000000000004AAA', 'Status: Failed'], 'nothing waits for a frame');

  const same = (a, b) => sfcli.shapeOf(a) === sfcli.shapeOf(b);
  assert.ok(same('|Waiting 1m 19.83s', '/ Waiting 2m 3.1s') && same('|Waiting 59s', '\u221aWaiting 1m 2s'), 'spinners, symbols and timers are not words');
  assert.ok(same('Elapsed Time: 23.04s', 'Elapsed Time: 1h 2m 5s'));
  assert.ok(!same('Status: Pending', 'Status: Succeeded') && !same('Status: InProgress', 'Status: Failed'));
  assert.strictEqual(sfcli.durationMs('1m 19.83s'), 79830);
  assert.strictEqual(sfcli.orgWaitFrom(['|Waiting for the org to respond 2s', '\u221aWaiting for the org to respond 1m 50.2s']), 110200);
});

ok('with an interval, an unchanged snapshot is also shown once per interval', () => {
  let clock = 0;
  const lines = [];
  const f = sfcli.reprintFilter(l => lines.push(l), null, { intervalMs: 10000, now: () => clock });
  for (let t = 0; t <= 35000; t += 500) { clock = t; ['\u2500\u2500 Retrieving \u2500\u2500', '|Waiting for the org to respond ' + (t / 1000).toFixed(1) + 's'].forEach(l => f.line(l)); }
  assert.strictEqual(lines.filter(l => /Retrieving/.test(l)).length, 4, 'the first frame plus one every 10 seconds');
});

ok('a CLI reprinting its block every tick gives a short event log, and source tracking can be skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra frames '));
  const sf = fakeSf(dir);
  process.env.FAKE_SF_STYLE = 'frames';
  try {
    const lines = [];
    const r = await sfcli.retrieve(sf, { manifest: 'manifest/package.xml', org: 'dev', cwd: dir, onLine: l => lines.push(l) });
    assert.strictEqual(r.files, 3);
    assert.strictEqual(r.orgWaitMs, 23800, 'how long the org itself took, read from the CLI');
    assert.strictEqual(lines.filter(l => /Retrieving Metadata/.test(l)).length, 2, 'two snapshots - the start and the finish - not 41');
    assert.ok(!lines.some(l => /^[|\/\\-]Waiting/.test(l)), 'the rotating spinner never shows');
    assert.ok(lines.includes('Status: Pending') && lines.includes('Status: Succeeded'));
    assert.ok(lines.filter(l => l.trim()).length <= 30, '41 frames became ' + lines.filter(l => l.trim()).length + ' lines');
    assert.ok(lines.some(l => /Updating source tracking/.test(l)), 'by default the CLI tracks source');

    const quick = [];
    await sfcli.retrieve(sf, { manifest: 'manifest/package.xml', org: 'dev', cwd: dir, onLine: l => quick.push(l), env: { SF_DISABLE_SOURCE_MEMBER_POLLING: 'true' } });
    assert.ok(!quick.some(l => /Updating source tracking/.test(l)), 'the switch reaches the CLI');
  } finally { delete process.env.FAKE_SF_STYLE; }
  rmTree(dir);
});

/* ------------------------------------------------------------ selective commits */
section('Copado selective commits');

ok('a selective commit is deployed from the project and never retrieved over', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'Copado_Commit_selective.json'), 'utf8');
  const r = manifest.build(manifest.parseCommit(text, 'selective.json'), {});
  const has = (map, t, n) => !!(map.get(t) && map.get(t).has(n));
  assert.ok(has(r.deploy, 'FlexiPage', 'ACME_Account_Record_Page') && has(r.deploy, 'Layout', 'Account-ACME Account Layout'), 'both are in package.xml');
  assert.ok(!has(r.retrieve, 'FlexiPage', 'ACME_Account_Record_Page') && !has(r.retrieve, 'Layout', 'Account-ACME Account Layout'), 'neither is retrieved');
  assert.ok(has(r.retrieve, 'PermissionSet', 'ACME_Data_Migration_PS') && has(r.retrieve, 'CustomObject', 'Opportunity'), 'everything else is');
  assert.deepStrictEqual(r.counts, { deploy: 7, retrieve: 9, retrieveOnly: 4, destructive: 0, selective: 2 }, '7 deployed - 2 selective + 4 retrieve-only = 9 retrieved');
  assert.ok(!r.notes.some(n => n.id === 'unknown-action'), 'SelectiveCommit is a known action');
  const n = r.notes.find(x => x.id === 'selective-commit');
  assert.ok(n && n.severity === 'warning');
  assert.ok(/068000000000001AAA/.test(n.message) && /068000000000002AAA/.test(n.message), 'the Copado files are named');
  assert.deepStrictEqual(n.components.map(c => c.copadoFile), ['068000000000001AAA', '068000000000002AAA']);
  assert.ok(!r.notes.some(x => x.id === 'standard-fields'), 'retrieve-only standard fields are not deployed, so no warning');
  assert.ok(manifest.summary(r, '62.0').some(l => /Selective: 2/.test(l)));
});

ok('selective wins over a plain Add or RetrieveOnly of the same component', () => {
  const rows = [
    { t: 'Layout', n: 'Account-Main', a: 'Add' }, { t: 'Layout', n: 'Account-Main', a: 'SelectiveCommit', j: '{"selectiveCommitFileId":"068A"}' },
    { t: 'FlexiPage', n: 'Home', a: 'SelectiveCommit', j: '' }, { t: 'FlexiPage', n: 'Home', a: 'RetrieveOnly' },
    { t: 'Profile', n: 'Admin', a: 'RetrieveOnly' }, { t: 'Profile', n: 'Admin', a: 'SelectiveCommit' }
  ];
  const r = manifest.build(manifest.parseCommit(JSON.stringify(rows)), {});
  for (const [t, n] of [['Layout', 'Account-Main'], ['FlexiPage', 'Home'], ['Profile', 'Admin']]) {
    assert.ok(r.selective.get(t).has(n) && r.deploy.get(t).has(n), t + ' is selective and deployed');
    assert.ok(!(r.retrieve.get(t) && r.retrieve.get(t).has(n)), t + ' is not retrieved');
  }
  assert.strictEqual(r.counts.retrieveOnly, 0);
  // a package of selective commits only has nothing to retrieve
  const only = manifest.build(manifest.parseCommit(JSON.stringify([{ t: 'Layout', n: 'Case-Main', a: 'SelectiveCommit' }])), {});
  assert.strictEqual(only.counts.retrieve, 0);
  assert.strictEqual(only.counts.deploy, 1);
  // and it can be mapped differently, like any action
  const asDeploy = manifest.build(manifest.parseCommit(JSON.stringify([{ t: 'Layout', n: 'Case-Main', a: 'SelectiveCommit' }])), { actions: { SelectiveCommit: 'deploy' } });
  assert.strictEqual(asDeploy.counts.retrieve, 1);
});

ok('the story report recognises a selective-commit file by its name, however it was saved', () => {
  const sel = require('../src/selective');
  // Copado names it the base64 of Type:Name
  const hashFor = (type, name) => Buffer.from(type + ':' + name, 'utf8').toString('base64');
  const h = hashFor('Layout', 'Account-ACME Account Layout');
  assert.strictEqual(h, 'TGF5b3V0OkFjY291bnQtQUNNRSBBY2NvdW50IExheW91dA==', 'base64 of Type:Name, as Copado writes it');
  for (const name of [h, h + '.xml', h.replace(/=+$/, ''), h + ' (2)', h + ' (2).xml']) {
    const d = sel.decodeFileName(name);
    assert.ok(d && d.type === 'Layout' && d.name === 'Account-ACME Account Layout', name);
  }
  assert.strictEqual(sel.decodeFileName(h + ' (2)').copy, 2);
  // "+" and "/" in base64 cannot be in a file name; the URL-safe form decodes the same
  const odd = hashFor('Profile', '[N] Sales ~~~?');
  assert.ok(/[+/]/.test(odd));
  assert.deepStrictEqual(sel.decodeFileName(odd.replace(/\+/g, '-').replace(/\//g, '_')).name, '[N] Sales ~~~?');
  for (const junk of ['notes.txt', 'README', 'package.xml', 'QUJD', 'TGF5b3V0']) assert.strictEqual(sel.decodeFileName(junk), null, junk + ' is not a selective file');
});

ok('session tokens never reach the log; identities are masked when asked', () => {
  const { redact } = require('../src/redact');
  const line = 'from jane@acme.com.dev org 00D5e000000AbCdEAF at https://acme--dev.sandbox.my.salesforce.com token 00D5e000000AbCd!ARQAQH.abcdefghijklmnopqrstuvwx Bearer abcdefghijklmnopqrstuvwxyz123 Deploy ID: 0Af000000000004AAA';
  const off = redact(line, false);
  assert.ok(!/ARQAQH|abcdefghijklmnopqrstuvwxyz123/.test(off), 'tokens are always masked');
  assert.ok(/jane@acme\.com\.dev/.test(off), 'identities stay unless asked');
  const on = redact(line, true);
  assert.ok(!/jane|00D5e000000AbCdEAF|acme--dev/.test(on), on);
  assert.ok(/0Af000000000004AAA/.test(on), 'the deploy id stays - support needs it');
});

ok('the team policy decides which orgs can be validated against, and with what tests', () => {
  const G = require('../src/guard');
  const { policy, source } = G.resolvePolicy(JSON.stringify({ allowedTargetOrgs: ['qa', 'uat*', 'production'], blockedTargetOrgs: ['uat-old'],
    minimumTestLevel: { production: 'RunLocalTests', 'uat*': 'RunSpecifiedTests' } }), { allowedTargetOrgs: ['anything'] });
  assert.strictEqual(source, 'copado-policy.json', 'the committed file wins over personal settings');
  const c = (o, l) => G.check(policy, o, l);
  assert.deepStrictEqual(c({ alias: 'qa', isSandbox: true }, 'NoTestRun'), { allowed: true, testLevel: 'NoTestRun', raisedFrom: undefined, rule: undefined, coverage: null, environmentRule: null });
  assert.strictEqual(c({ alias: 'uat2', isSandbox: true }, 'NoTestRun').testLevel, 'RunSpecifiedTests');
  assert.strictEqual(c({ alias: 'uat-old', isSandbox: true }, 'RunLocalTests').allowed, false, 'blocked wins');
  assert.ok(/not in the policy/.test(c({ alias: 'dev', isSandbox: true }, 'NoTestRun').reason));
  const prod = c({ alias: 'prod', username: 'me@example.com', isSandbox: false }, 'RunSpecifiedTests');
  assert.deepStrictEqual([prod.allowed, prod.testLevel, prod.raisedFrom], [true, 'RunLocalTests', 'RunSpecifiedTests']);
  assert.strictEqual(c({ alias: 'qa', isSandbox: true }, 'RunAllTestsInOrg').testLevel, 'RunAllTestsInOrg', 'a higher level is never lowered');
  const noProd = G.resolvePolicy(JSON.stringify({ allowProduction: false }), {}).policy;
  assert.strictEqual(G.check(noProd, { alias: 'prod', isSandbox: false }, 'RunLocalTests').allowed, false);
  assert.ok(G.matches('*.qa', { username: 'me@example.com.qa' }) && !G.matches('*.qa', { username: 'me@example.com.uat' }));
  const broken = G.resolvePolicy('{ not json', {});
  assert.ok(broken.error && G.check(broken.policy, { alias: 'qa', isSandbox: true }, 'NoTestRun').allowed === false, 'a broken policy blocks instead of allowing everything');
  assert.strictEqual(G.resolvePolicy(null, {}).policy.allowed.length, 0, 'no file and no settings: no restrictions');
});

/** An in-memory Copado org: describe, query and download, answering the way Salesforce does. */
function fakeCopadoOrg() {
  const commitJson = JSON.stringify([{ t: 'PermissionSet', n: 'Sales_PS', a: 'Add' }, { t: 'Layout', n: 'Account-Main', a: 'SelectiveCommit', j: '{"selectiveCommitFileId":"068000000000001AAA"}' }]);
  const conflicted = '<?xml version="1.0"?>\n<Layout xmlns="x">\n<<<<<<< HEAD\n  <a>1</a>\n=======\n  <a>2</a>\n>>>>>>> feature/US-0012345\n</Layout>\n';
  const fields = {
    // an older Copado: no Base_Branch__c on the story, no Org_Type__c on credentials
    copado__User_Story__c: ['Id', 'Name', 'copado__User_Story_Title__c', 'copado__Status__c', 'copado__Environment__c', 'copado__Project__c', 'copado__Release__c', 'LastModifiedDate'],
    copado__User_Story_Commit__c: ['Id', 'Name', 'CreatedDate', 'copado__External_Id__c', 'copado__Snapshot_Commit__c'],
    copado__User_Story_Metadata__c: ['Id', 'Name', 'copado__Metadata_API_Name__c', 'copado__Type__c', 'copado__Status__c'],
    copado__Promoted_User_Story__c: ['Id', 'Name', 'CreatedDate', 'copado__Status__c', 'copado__Promotion__c'],
    copado__Deployment_Flow__c: ['Id', 'Name', 'copado__Git_Repository__c', 'copado__Main_Branch__c'],
    copado__Org__c: ['Id', 'Name', 'copado__Username__c', 'copado__Environment__c']
  };
  const rel = { copado__Environment__c: 'copado__Environment__r', copado__Project__c: 'copado__Project__r', copado__Release__c: 'copado__Release__r',
    copado__Snapshot_Commit__c: 'copado__Snapshot_Commit__r', copado__Promotion__c: 'copado__Promotion__r', copado__Git_Repository__c: 'copado__Git_Repository__r' };
  const queries = [];
  const api = {
    queries,
    describe: async o => fields[o] ? fields[o].map(n => ({ name: n, relationshipName: rel[n] || null })) : null,
    query: async soql => {
      queries.push(soql);
      // the org rejects a field that does not exist, as Salesforce does
      if (/copado__Main_Branch__c/.test(soql)) throw new Error("No such column 'copado__Main_Branch__c' on entity 'copado__Deployment_Flow__c'.");
      if (/FROM copado__User_Story__c /.test(soql)) return [{ Id: 'a0U000000000001AAA', Name: 'US-0012345', copado__User_Story_Title__c: 'Billing access', copado__Status__c: 'In Progress',
        copado__Environment__c: 'a0E00000000DEV1AAA', copado__Environment__r: { Name: 'dev' }, copado__Project__r: { Name: 'Billing', copado__Deployment_Flow__c: 'a0F000000000001AAA' } },
        { Id: 'a0U000000000009AAA', Name: 'US-0112345' }];
      if (/FROM copado__User_Story_Commit__c /.test(soql)) return [{ Id: 'a0C000000000001AAA', Name: 'C-01', CreatedDate: '2026-11-01T10:00:00Z', copado__Snapshot_Commit__c: 'a0S000000000001AAA',
        copado__Snapshot_Commit__r: { copado__Commit_Id__c: '0123456789abcdef', copado__Status__c: 'Complete' } }];
      if (/FROM copado__User_Story_Metadata__c /.test(soql)) return [{ Id: 'm1', Name: 'M1', copado__Metadata_API_Name__c: 'PermissionSet.Sales_PS', copado__Type__c: 'PermissionSet' },
        { Id: 'm2', Name: 'M2', copado__Metadata_API_Name__c: 'Layout.Account-Main', copado__Type__c: 'Layout' }];
      if (/FROM copado__Promoted_User_Story__c /.test(soql)) return [{ Id: 'pu1', copado__Promotion__c: 'a0P000000000001AAA', copado__Promotion__r: { Name: 'P-0099', copado__Status__c: 'Merge Conflict',
        copado__Source_Environment__r: { Name: 'dev' }, copado__Destination_Environment__r: { Name: 'qa' }, copado__Destination_Environment__c: 'a0E0000000000QAAAA' } }];
      if (/FROM copado__Deployment_Flow__c /.test(soql)) return [{ Id: 'a0F000000000001AAA', Name: 'Billing pipeline', copado__Git_Repository__c: 'a0G000000000001AAA', copado__Git_Repository__r: { Name: 'billing-repo' } }];
      if (/FROM copado__Org__c /.test(soql)) return [{ Name: 'dev credential', copado__Username__c: 'me@example.com.dev', copado__Environment__r: { Name: 'dev' } },
        { Name: 'qa credential', copado__Username__c: 'me@example.com.qa', copado__Environment__r: { Name: 'qa' } }];
      if (/FROM Attachment WHERE ParentId IN \('a0C000000000001AAA'\)/.test(soql)) return [{ Id: '00P000000000001AAA', Name: 'Copado_Commit_changes.json', BodyLength: commitJson.length, ParentId: 'a0C000000000001AAA' }];
      if (/FROM Attachment WHERE ParentId IN \('a0P000000000001AAA'\)/.test(soql)) return [
        { Id: '00P000000000002AAA', Name: 'force-app/main/default/layouts/Account-Main.layout-meta.xml', BodyLength: conflicted.length, ParentId: 'a0P000000000001AAA' },
        { Id: '00P000000000003AAA', Name: 'RESOLVED force-app/main/default/layouts/Account-Main.layout-meta.xml', BodyLength: 40, ParentId: 'a0P000000000001AAA' }];
      if (/FROM ContentDocumentLink WHERE LinkedEntityId IN \('a0U000000000001AAA'\)/.test(soql)) return [{ LinkedEntityId: 'a0U000000000001AAA',
        ContentDocument: { Title: 'notes', FileExtension: 'txt', ContentSize: 5, LatestPublishedVersionId: '068000000000005AAA' } }];
      return [];
    },
    download: async (kind, id) => Buffer.from({ '00P000000000001AAA': commitJson, '00P000000000002AAA': conflicted, '00P000000000003AAA': '<Layout xmlns="x"><a>2</a></Layout>', '068000000000005AAA': 'hello' }[id] || '', 'utf8')
  };
  return api;
}

ok('Phase 0: queries and describes go through the Salesforce CLI intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra query '));
  const sf = fakeSf(dir);
  const soql = "SELECT Id, Name FROM copado__User_Story__c WHERE Name LIKE '%12345' ORDER BY Name LIMIT 20";
  const recs = await sfcli.query(sf, 'copado', soql, dir);
  assert.strictEqual(recs[0].echoedQuery, soql, 'quotes, spaces and % arrive unchanged');
  await assert.rejects(sfcli.query(sf, 'copado', 'SELECT Bogus__c FROM copado__User_Story__c', dir), e => /No such column 'Bogus__c'/.test(e.message) && e.name === 'INVALID_FIELD');
  const f = await sfcli.describe(sf, 'copado', 'copado__User_Story__c', dir);
  assert.deepStrictEqual(f, [{ name: 'Id', relationshipName: null }, { name: 'copado__Project__c', relationshipName: 'copado__Project__r' }]);
  assert.strictEqual(await sfcli.describe(sf, 'copado', 'copado__Not_There__c', dir), null, 'a missing object is null, not an error');
  rmTree(dir);
});

ok('a CLI without "sf api request" is recognised once, however it words it, and one login serves every download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra wrapped '));
  const sf = fakeSf(dir);
  const http = require('http');
  let hits = 0, expire = 1;
  const server = http.createServer((req, res) => {
    hits++;
    if (expire > 0) { expire--; res.writeHead(401); res.end('[{"errorCode":"INVALID_SESSION_ID"}]'); return; }
    res.writeHead(200); res.end('<Layout>' + req.url.split('/')[6] + '</Layout>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const count = path.join(dir, 'count.txt');
  Object.assign(process.env, { FAKE_SF_NO_API: 'wrapped', FAKE_SF_COUNT: count, FAKE_SF_INSTANCE: 'http://127.0.0.1:' + server.address().port });
  sfcli.resetRest();
  try {
    for (const id of ['068000000000001AAA', '068000000000002AAA', '068000000000003AAA']) {
      const body = await sfcli.restGet(sf, 'copado', '/services/data/v62.0/sobjects/ContentVersion/' + id + '/VersionData', dir);
      assert.ok(body.toString('utf8').includes(id));
    }
    const calls = fs.readFileSync(count, 'utf8').trim().split('\n');
    assert.deepStrictEqual(calls.filter(c => c === 'display').length, 2, 'one login, plus one fresh login after the expired session');
    assert.strictEqual(hits, 4, 'the 401 is retried once with the fresh login, then every file goes direct');
  } finally {
    for (const k of ['FAKE_SF_NO_API', 'FAKE_SF_COUNT', 'FAKE_SF_INSTANCE']) delete process.env[k];
    sfcli.resetRest();
    server.close();
    rmTree(dir);
  }
});

ok('Phase 2a: a conflicted file splits into its two sides, the common ancestor too, and Copado\u2019s names are read', () => {
  const P = require('../src/promotion');
  const f = '<a>\r\n<<<<<<< HEAD\r\n  <x>qa</x>\r\n=======\r\n  <x>feature</x>\r\n>>>>>>> feature/US-0012345\r\n<b/>';
  const r = P.splitConflicts(f);
  assert.deepStrictEqual([r.ok, r.blocks, r.ours, r.theirs, r.base], [true, 1, '<a>\r\n  <x>qa</x>\r\n<b/>', '<a>\r\n  <x>feature</x>\r\n<b/>', null], 'CRLF kept, last line without a newline kept');
  assert.deepStrictEqual(r.labels, { ours: 'HEAD', base: null, theirs: 'feature/US-0012345' });
  const d3 = P.splitConflicts('x\n<<<<<<< ours\nA\n||||||| merged common ancestors\nO\n=======\nB\n>>>>>>> theirs\ny\n');
  assert.strictEqual(d3.base, 'x\nO\ny\n', 'diff3 markers give the ancestor - a three-way merge');
  assert.strictEqual(P.splitConflicts('<<<<<<< a\nA\n=======\nB\n').ok, false, 'an unclosed block is refused');
  assert.strictEqual(P.splitConflicts('<a/>\n').blocks, 0);
  assert.ok(P.hasMarkers('a\n=======\nb') && !P.hasMarkers('<a>==</a>'));
  assert.deepStrictEqual(P.parseConflictName('US-0012345 force-app/main/default/layouts/Account-Sales Layout.layout-meta.xml'),
    { story: 'US-0012345', path: 'force-app/main/default/layouts/Account-Sales Layout.layout-meta.xml', resolved: false, auto: false });
  assert.strictEqual(P.parseConflictName('AUTO RESOLVED US-1 force-app/main/default/classes/A.cls').auto, true);
  for (const n of ['GitConflictsResolution.json', 'Copado Promotion changes.json', 'id_rsa']) assert.strictEqual(P.parseConflictName(n), null, n);
});

ok('Phase 2a: two branches adding entries in the same place is a git conflict - the metadata merge keeps both', () => {
  const P = require('../src/promotion');
  const fp = f => '    <fieldPermissions>\n        <editable>false</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
  const conflicted = '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + fp('Account.A__c') +
    '<<<<<<< HEAD\n' + fp('Account.FromQa__c') + '=======\n' + fp('Account.FromFeature__c') + '>>>>>>> feature/US-0012345\n' + '    <label>Sales</label>\n</PermissionSet>\n';
  const r = P.splitConflicts(conflicted);
  const merged = formatter.format({ root: merger.merge(X.parse(r.ours), X.parse(r.theirs), {}).merged, src: '' }, { indent: 4 });
  assert.ok(merged.includes('Account.FromQa__c') && merged.includes('Account.FromFeature__c') && merged.includes('Account.A__c'), 'both additions kept');
  assert.ok(!P.hasMarkers(merged));
  assert.strictEqual(X.parse(merged).root.name, 'PermissionSet');
});

ok('Phase 2a: conflicts are found for a story or a promotion, newest per file, paired with any resolution', async () => {
  const P = require('../src/promotion');
  const fields = { copado__Promotion__c: ['Id', 'Name', 'copado__Status__c', 'copado__Source_Environment__c', 'copado__Destination_Environment__c', 'CreatedDate'],
    copado__Promoted_User_Story__c: ['copado__Promotion__c', 'copado__User_Story__c'] };
  const rel = { copado__Source_Environment__c: 'copado__Source_Environment__r', copado__Destination_Environment__c: 'copado__Destination_Environment__r', copado__User_Story__c: 'copado__User_Story__r' };
  const asked = [];
  const api = {
    describe: async o => (fields[o] || []).map(n => ({ name: n, relationshipName: rel[n] || null })),
    query: async q => {
      asked.push(q);
      if (/FROM copado__Promoted_User_Story__c /.test(q)) return [{ copado__Promotion__c: 'a0P000000000001AAA', copado__User_Story__r: { Name: 'US-0012345' } },
        { copado__Promotion__c: 'a0P000000000009AAA', copado__User_Story__r: { Name: 'US-0112345' } }];
      if (/FROM copado__Promotion__c /.test(q)) return [{ Id: 'a0P000000000001AAA', Name: 'P10001', copado__Status__c: 'Merge Conflict',
        copado__Source_Environment__r: { Name: 'dev' }, copado__Destination_Environment__r: { Name: 'qa' } }];
      if (/FROM Attachment WHERE ParentId = 'a0P000000000001AAA'/.test(q)) return [
        { Id: 'n1', Name: 'US-0012345 force-app/main/default/permissionsets/Sales.permissionset-meta.xml', BodyLength: 900, CreatedDate: '2026-11-12' },
        { Id: 'o1', Name: 'US-0012345 force-app/main/default/permissionsets/Sales.permissionset-meta.xml', BodyLength: 800, CreatedDate: '2026-11-10' },
        { Id: 'n2', Name: 'US-0012345 force-app/main/default/lwc/cmp/cmp.js', BodyLength: 300, CreatedDate: '2026-11-12' },
        { Id: 'r2', Name: 'RESOLVED US-0012345 force-app/main/default/lwc/cmp/cmp.js', BodyLength: 290, CreatedDate: '2026-11-12' },
        { Id: 'j', Name: 'GitConflictsResolution.json', BodyLength: 50, CreatedDate: '2026-11-12' }];
      return [];
    },
    download: async () => Buffer.alloc(0)
  };
  const byStory = await P.promotionConflicts(api, 'US-0012345');
  assert.strictEqual(byStory.promotions.length, 1, 'US-0112345 also ends in 12345 but is another story');
  const pr = byStory.promotions[0];
  assert.deepStrictEqual([pr.name, pr.status, pr.from, pr.to], ['P10001', 'Merge Conflict', 'dev', 'qa']);
  assert.deepStrictEqual(pr.conflicts.map(c => [c.path.split('/').pop(), c.id, c.resolution && c.resolution.id]),
    [['cmp.js', 'n2', 'r2'], ['Sales.permissionset-meta.xml', 'n1', null]], 'newest attachment per file; the resolution paired by path');
  const byPromotion = await P.promotionConflicts(api, 'P10001');
  assert.strictEqual(byPromotion.promotions[0].conflicts.length, 2);
  assert.ok(asked.every(q => /^SELECT /.test(q)), 'read-only');
  await assert.rejects(P.promotionConflicts(api, "x' OR Name != '"), /Give a promotion/);
});

/** A Copado org that keeps state: attachments with name, body and time, and a promotion's status. */
function statefulCopado(opts) {
  const o = opts || {};
  let clock = 1;
  const tick = () => '2026-11-12T07:00:' + String(clock++).padStart(2, '0') + '.000+0000';
  const conflict = '<Layout>\n<<<<<<< HEAD\n<a>1</a>\n=======\n<a>2</a>\n>>>>>>> feature/US-0012345\n</Layout>\n';
  const att = {
    A1: { Id: 'A1', ParentId: 'P1', Name: 'US-0012345 force-app/main/default/layouts/Account-Main.layout-meta.xml', Body: Buffer.from(conflict), LastModifiedDate: tick() },
    A2: { Id: 'A2', ParentId: 'P1', Name: 'US-0012345 force-app/main/default/classes/A.cls', Body: Buffer.from('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> f\n'), LastModifiedDate: tick() },
    A3: { Id: 'A3', ParentId: 'P1', Name: 'Copado Promotion changes', Body: Buffer.from('[]'), LastModifiedDate: tick() }
  };
  const promo = { Id: 'P1', copado__Status__c: 'Merge Conflict' };
  const patches = [];
  const api = {
    att, promo, patches,
    describe: async obj => obj === 'copado__Promotion__c' ? [{ name: 'Id' }, { name: 'copado__Status__c', picklist: o.picklist || ['Draft', 'Merge Conflict', 'Conflicts Resolved', 'Completed'] }] : [],
    query: async q => {
      let m;
      if ((m = /FROM Attachment WHERE Id = '(\w+)'/.exec(q))) return att[m[1]] ? [{ Id: att[m[1]].Id, Name: att[m[1]].Name, LastModifiedDate: att[m[1]].LastModifiedDate, BodyLength: att[m[1]].Body.length }] : [];
      if (/FROM Attachment WHERE ParentId = 'P1'/.test(q)) return Object.values(att).map(a => ({ Id: a.Id, Name: a.Name }));
      if (/FROM copado__Promotion__c WHERE Id = 'P1'/.test(q)) return [Object.assign({}, promo)];
      return [];
    },
    download: async (kind, id) => o.mangle ? Buffer.from(att[id].Body.toString('utf8').replace(/\n/g, '\r\n')) : att[id].Body,
    patch: async (sobject, id, fields) => {
      patches.push([sobject, id, Object.keys(fields).sort().join(',')]);
      if (sobject === 'Attachment') {
        if (fields.Name) att[id].Name = fields.Name;
        if (fields.Body) att[id].Body = Buffer.from(fields.Body, 'base64');
        att[id].LastModifiedDate = tick();
      } else if (sobject === 'copado__Promotion__c') promo.copado__Status__c = fields.copado__Status__c;
    }
  };
  return api;
}

ok('Phase 2b: an upload does what Copado\u2019s editor does - rename to RESOLVED, replace the content - and reads it back', async () => {
  const P = require('../src/promotion');
  const api = statefulCopado();
  const item = { id: 'A1', name: api.att.A1.Name, modified: api.att.A1.LastModifiedDate };
  const resolved = '<Layout>\n<a>2</a>\n</Layout>\n';
  const r = await P.uploadResolution(api, item, resolved);
  assert.strictEqual(api.att.A1.Name, 'RESOLVED US-0012345 force-app/main/default/layouts/Account-Main.layout-meta.xml');
  assert.strictEqual(api.att.A1.Body.toString('utf8'), resolved);
  assert.deepStrictEqual(api.patches, [['Attachment', 'A1', 'Body,Name']], 'one update of one attachment - nothing created or deleted');
  assert.strictEqual(Object.keys(api.att).length, 3);
  assert.strictEqual(r.previousName, item.name);
  // refused: already resolved, changed since fetched, markers left
  await assert.rejects(P.uploadResolution(api, Object.assign({}, item, { modified: api.att.A1.LastModifiedDate }), resolved), /already resolved in Copado/);
  const item2 = { id: 'A2', name: api.att.A2.Name, modified: '2026-01-01T00:00:00.000+0000' };
  await assert.rejects(P.uploadResolution(api, item2, 'y\n'), /changed in Copado since it was fetched/);
  await assert.rejects(P.uploadResolution(api, Object.assign({}, item2, { modified: api.att.A2.LastModifiedDate }), '<<<<<<< HEAD\nx\n'), /still has conflict markers/);
  assert.strictEqual(api.patches.length, 1, 'refusals write nothing');
  // a store that changes the content on the way is caught
  const bad = statefulCopado({ mangle: true });
  await assert.rejects(P.uploadResolution(bad, { id: 'A1', name: bad.att.A1.Name, modified: bad.att.A1.LastModifiedDate }, resolved), /read back: the stored content differs/);
});

ok('Phase 2b: the status changes only after the last file, only from a merge conflict, only to the org\u2019s own value - and undo puts it all back', async () => {
  const P = require('../src/promotion');
  const api = statefulCopado();
  const up = async id => P.uploadResolution(api, { id, name: api.att[id].Name, modified: api.att[id].LastModifiedDate }, id === 'A1' ? '<Layout/>\n' : 'y\n');
  const first = await up('A1');
  assert.deepStrictEqual(await P.markConflictsResolved(api, 'P1'), { skipped: 'files are still unresolved' });
  assert.strictEqual(await P.unresolvedCount(api, 'P1'), 1);
  await up('A2');
  assert.deepStrictEqual(await P.markConflictsResolved(api, 'P1', { dryRun: true }), { from: 'Merge Conflict', to: 'Conflicts Resolved', dryRun: true });
  assert.strictEqual(api.promo.copado__Status__c, 'Merge Conflict', 'a dry run writes nothing');
  const change = await P.markConflictsResolved(api, 'P1');
  assert.deepStrictEqual(change, { from: 'Merge Conflict', to: 'Conflicts Resolved' });
  assert.strictEqual(api.promo.copado__Status__c, 'Conflicts Resolved');
  assert.ok((await P.markConflictsResolved(api, 'P1')).already, 'never set twice');

  // undo: the status only if it is still ours, the attachment back to its conflict name and content
  assert.strictEqual(await P.restoreStatus(api, 'P1', change), true);
  assert.strictEqual(api.promo.copado__Status__c, 'Merge Conflict');
  await P.restoreAttachment(api, Object.assign({}, first, { original: '<Layout>\n<<<<<<< HEAD\n<a>1</a>\n=======\n<a>2</a>\n>>>>>>> feature/US-0012345\n</Layout>\n' }));
  assert.ok(/^US-0012345 /.test(api.att.A1.Name) && P.hasMarkers(api.att.A1.Body.toString('utf8')));
  api.promo.copado__Status__c = 'Validated';
  assert.strictEqual(await P.restoreStatus(api, 'P1', change), false, 'a status someone has since changed is left alone');

  // an org whose Status has no such value, or a promotion that is not in conflict, is left alone
  const other = statefulCopado({ picklist: ['Draft', 'Merge Conflict', 'Completed'] });
  for (const id of ['A1', 'A2']) await P.uploadResolution(other, { id, name: other.att[id].Name, modified: other.att[id].LastModifiedDate }, 'ok\n');
  assert.ok(/no "Conflicts Resolved" value/.test((await P.markConflictsResolved(other, 'P1')).skipped));
  other.promo.copado__Status__c = 'In Progress';
  other.describe = api.describe;
  assert.ok(/not a merge conflict/.test((await P.markConflictsResolved(other, 'P1')).skipped));
});

ok('Phase 2b: writes go straight to the REST API with the CLI\u2019s session - PATCH, token, JSON body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra patch '));
  const sf = fakeSf(dir);
  const http = require('http');
  let seen = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => { seen = { method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }; res.writeHead(204); res.end(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { FAKE_SF_TOKEN: '00D000000000001!patchtokenvalue1234567890', FAKE_SF_INSTANCE: 'http://127.0.0.1:' + server.address().port });
  sfcli.resetRest();
  try {
    await sfcli.restPatch(sf, 'copado', '/services/data/v62.0/sobjects/Attachment/00P000000000001AAA', { Name: 'RESOLVED x', Body: 'PExheW91dC8+' }, dir);
    assert.deepStrictEqual([seen.method, seen.url, seen.auth, seen.type], ['PATCH', '/services/data/v62.0/sobjects/Attachment/00P000000000001AAA', 'Bearer 00D000000000001!patchtokenvalue1234567890', 'application/json']);
    assert.deepStrictEqual(JSON.parse(seen.body), { Name: 'RESOLVED x', Body: 'PExheW91dC8+' });
  } finally {
    delete process.env.FAKE_SF_TOKEN; delete process.env.FAKE_SF_INSTANCE;
    sfcli.resetRest(); server.close(); rmTree(dir);
  }
});


function promoOrg() {
  const fp = f => '    <fieldPermissions>\n        <editable>false</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
  const ps = (mid) => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + mid + '    <label>Sales</label>\n</PermissionSet>\n';
  const api = statefulCopado();
  // an addition on each side: a git conflict the merge settles by itself
  api.att.A1.Name = 'US-0012345 force-app/main/default/permissionsets/Sales.permissionset-meta.xml';
  api.att.A1.Body = Buffer.from(ps(fp('Account.A__c') + '<<<<<<< HEAD\n' + fp('Account.FromQa__c') + '=======\n' + fp('Account.FromFeature__c') + '>>>>>>> feature/US-0012345\n'));
  // a real clash: the same value changed differently on each side
  api.att.A4 = { Id: 'A4', ParentId: 'P1', Name: 'US-0012345 force-app/main/default/permissionsets/Ops.permissionset-meta.xml', LastModifiedDate: '2026-11-12T06:49:00.000+0000',
    Body: Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n<<<<<<< HEAD\n    <description>qa text</description>\n=======\n    <description>feature text</description>\n>>>>>>> feature/US-0012345\n    <label>Ops</label>\n</PermissionSet>\n') };
  // code: one block both sides agree on, one real clash
  api.att.A2.Body = Buffer.from('class A {\n<<<<<<< HEAD\n  same();\n=======\n  same();\n>>>>>>> f\n<<<<<<< HEAD\n  qa();\n=======\n  feature();\n>>>>>>> f\n}\n');
  return api;
}

ok('D7 - refresh works out again what you have not touched when the rules have changed; what you resolved stays as it is', async () => {
  const W = require('../src/promotionWork');
  const api = promoOrg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra d7 '));
  try {
    const s = W.store(dir);
    const promotion = { id: 'P1', name: 'P10001', from: 'dev', to: 'qa' };
    await W.sync(api, s, promotion, { copadoOrg: 'copado' });
    const st = s.load(), ps = 'force-app/main/default/permissionsets/Sales.permissionset-meta.xml', cls = 'force-app/main/default/classes/A.cls';
    assert.strictEqual(st.files[ps].rules, W.RULES, 'each result says which rules worked it out');
    // the permission set: by older rules, untouched; the class: by older rules, but resolved by you
    st.files[ps].rules = W.RULES - 1;
    st.files[cls].rules = W.RULES - 1; st.files[cls].state = 'resolved';
    s.save(st);
    const again = await W.sync(api, s, promotion, {});
    assert.strictEqual(again.fetched, 1, 'only the untouched one worked out again');
    assert.deepStrictEqual([again.state.files[ps].rules, again.state.files[cls].state, again.state.files[cls].rules], [W.RULES, 'resolved', W.RULES - 1]);
  } finally { rmTree(dir); }
});

ok('promotion workspace: everything fetched at once, sorted into resolved automatically, to review, and code', async () => {
  const W = require('../src/promotionWork');
  const api = promoOrg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra promo '));
  const s = W.store(dir);
  const promotion = { id: 'P1', name: 'P10001', from: 'dev', to: 'qa' };
  const r = await W.sync(api, s, promotion, { copadoOrg: 'copado' });
  assert.strictEqual(r.fetched, 3, 'three conflict files, fetched together; the change list is not a conflict');
  const f = r.state.files;
  const ps = f['force-app/main/default/permissionsets/Sales.permissionset-meta.xml'];
  assert.deepStrictEqual([ps.state, ps.kind, ps.conflicts], ['auto', 'xml', 0], 'both branches adding entries needs no decision');
  const resolved = s.read('resolved', 'force-app/main/default/permissionsets/Sales.permissionset-meta.xml');
  assert.ok(resolved.includes('Account.FromQa__c') && resolved.includes('Account.FromFeature__c') && !resolved.includes('<<<<<<<'));
  assert.ok(s.read('promotion', 'force-app/main/default/permissionsets/Sales.permissionset-meta.xml').includes('FromQa__c'), 'the sides keep their real file names');
  const ops = f['force-app/main/default/permissionsets/Ops.permissionset-meta.xml'];
  // both changed its description: the target's entries kept, the feature's change applied - nothing to decide
  assert.deepStrictEqual([ops.state, ops.conflicts], ['auto', 0]);
  const code = f['force-app/main/default/classes/A.cls'];
  assert.deepStrictEqual([code.state, code.conflicts], ['code', 1]);
  const codeText = s.read('resolved', 'force-app/main/default/classes/A.cls');
  assert.ok(codeText.includes('  same();\n<<<<<<< HEAD\n  qa();'), 'the agreed block is settled, the clash keeps its markers');

  // nothing changed in Copado: a refresh fetches nothing and keeps local work
  s.write('resolved', 'force-app/main/default/classes/A.cls', 'class A {\n  same();\n  feature();\n}\n');
  const st = s.load(); st.files['force-app/main/default/classes/A.cls'].state = 'resolved'; s.save(st);
  const again = await W.sync(api, s, promotion, {});
  assert.strictEqual(again.fetched, 0);
  assert.strictEqual(again.state.files['force-app/main/default/classes/A.cls'].state, 'resolved');
  // resolved in Copado meanwhile: marked, never overwritten
  api.att.A4.Name = 'RESOLVED ' + api.att.A4.Name;
  const third = await W.sync(api, s, promotion, {});
  assert.strictEqual(third.state.files['force-app/main/default/permissionsets/Ops.permissionset-meta.xml'].state, 'copado');
  rmTree(dir);
});


ok('the page: only the extension\u2019s own script runs, and the stylesheet uses only VS Code\u2019s theme', () => {
  const Module = require('module'); const load = Module._load;
  const vs = { Uri: { joinPath: (u, ...p) => ({ fsPath: [u.fsPath].concat(p).join('/') }) } };
  Module._load = function (req) { return req === 'vscode' ? vs : load.apply(this, arguments); };
  delete require.cache[require.resolve('../releasePage')];
  const page = require('../releasePage');
  Module._load = load;
  const html = page.html({ cspSource: 'vscode-resource:', asWebviewUri: u => 'vscode-resource:' + u.fsPath }, { fsPath: '/ext/media' });
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
  assert.ok(/default-src 'none'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp), csp);
  assert.ok(html.includes('<script nonce="' + nonce + '" src="vscode-resource:/ext/media/page.js">'), 'the one script, with the nonce');
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'page.css'), 'utf8');
  const colours = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []);
  assert.deepStrictEqual(colours, ['#fff'], 'no fixed colours apart from the tick in a checked box');
  assert.ok(/font-family: var\(--vscode-font-family\)/.test(css), 'VS Code\u2019s own font');
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'page.js'), 'utf8');
  assert.ok(!/eval\(|new Function/.test(js), 'no eval in the page');
});

/** A local server that answers like Azure DevOps, GitHub, GitLab and Bitbucket Cloud. */
async function fakeGitHosts(opts) {
  const http = require('http');
  const FILES = { 'force-app/main/default/classes/A.cls': 'class A {}', 'force-app/main/default/classes/A.cls-meta.xml': '<ApexClass/>',
    'force-app/main/default/lwc/cmp/cmp.js': 'export default 1;', 'force-app/main/default/lwc/cmp/__tests__/cmp.test.js': 'test', 'sfdx-project.json': '{"packageDirectories":[{"path":"force-app","default":true}]}' };
  Object.assign(FILES, (opts && opts.files) || {});
  const BRANCH = 'feature/US-0012345';
  const BRANCHES = (opts && opts.branches) || [BRANCH];
  const under = dir => Object.keys(FILES).filter(f => f.startsWith(dir + '/'));
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), q = k => u.searchParams.get(k);
    const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'application/octet-stream' }); res.end(body); };
    seen.push(req.method + ' ' + u.pathname);
    // the merge-base of two branches, and files as they were at it - each provider's own call
    const SHA_B = 'b'.repeat(40), BASE = (opts && opts.baseFiles) || {};
    // what differs between two branches, and the branches - each provider's own shape
    const CH = (opts && opts.changed) || [];
    if (u.pathname.startsWith('/api/v3/repos/owner/repo/compare/')) return send(200, JSON.stringify({ merge_base_commit: { sha: SHA_B }, files: CH.map(c => ({ filename: c.path, status: { added: 'added', removed: 'removed', changed: 'modified' }[c.kind] })) }), 'application/json');
    if (u.pathname.endsWith('/repository/compare')) return send(200, JSON.stringify({ diffs: CH.map(c => ({ new_path: c.path, old_path: c.path, new_file: c.kind === 'added', deleted_file: c.kind === 'removed' })) }), 'application/json');
    if (u.pathname.includes('/diffstat/')) return send(200, JSON.stringify({ values: CH.map(c => ({ status: c.kind === 'changed' ? 'modified' : c.kind, new: c.kind === 'removed' ? null : { path: c.path }, old: { path: c.path } })) }), 'application/json');
    if (u.pathname.endsWith('/diffs/commits')) {
      const all = [{ item: { path: '/force-app', isFolder: true }, changeType: 'edit' }].concat(CH.map(c => ({ item: { path: '/' + c.path }, changeType: { added: 'add', removed: 'delete', changed: 'edit' }[c.kind] })));
      const page = (opts && opts.azurePage) || all.length, skip = +(u.searchParams.get('$skip') || 0);
      return send(200, JSON.stringify({ changes: all.slice(skip, skip + page), allChangesIncluded: skip + page >= all.length }), 'application/json');
    }
    const BR = (opts && opts.branches) || [];
    if (u.pathname === '/api/v3/repos/owner/repo/branches') return send(200, JSON.stringify(BR.map(b => ({ name: b }))), 'application/json');
    if (u.pathname.endsWith('/repository/branches')) return send(200, JSON.stringify(BR.map(b => ({ name: b }))), 'application/json');
    if (u.pathname.endsWith('/refs/branches')) return send(200, JSON.stringify({ values: BR.map(b => ({ name: b })) }), 'application/json');
    if (u.pathname.endsWith('/repository/merge_base')) return send(200, JSON.stringify({ id: SHA_B }), 'application/json');
    if (u.pathname.includes('/merge-base/')) return send(200, JSON.stringify({ hash: SHA_B }), 'application/json');
    if (u.pathname.endsWith('/mergebases')) return send(200, JSON.stringify({ value: [{ commitId: SHA_B }] }), 'application/json');
    const at = q('ref') === SHA_B || q('versionDescriptor.version') === SHA_B || u.pathname.includes('/src/' + SHA_B + '/');
    if (at) {
      const fp = q('path') ? q('path').replace(/^\//, '') : decodeURIComponent((u.pathname.split('/src/' + SHA_B + '/')[1] || u.pathname.split('/contents/')[1] || (u.pathname.split('/repository/files/')[1] || '').replace(/\/raw$/, '')));
      return BASE[fp] != null ? send(200, BASE[fp]) : send(404, '{}');
    }
    if (u.pathname.startsWith('/org/Proj/_apis/git/repositories/repo')) {                    // Azure DevOps
      if (req.headers.authorization !== 'Basic ' + Buffer.from(':az-token').toString('base64')) return send(203, '<html>sign in</html>', 'text/html');
      if (u.pathname.endsWith('/repo')) return send(200, '{"name":"repo"}', 'application/json');
      if (u.pathname.endsWith('/refs')) return send(200, JSON.stringify({ value: BRANCHES.filter(b => ('heads/' + b).startsWith(q('filter'))).map(b => ({ name: 'refs/heads/' + b, objectId: 'a'.repeat(40) })) }), 'application/json');
      if (!BRANCHES.includes(q('versionDescriptor.version'))) return send(404, '{}');
      if (q('scopePath')) return send(200, JSON.stringify({ value: [{ path: q('scopePath'), isFolder: true }].concat(under(q('scopePath').slice(1)).map(f => ({ path: '/' + f, isFolder: false }))) }), 'application/json');
      const f = FILES[q('path').slice(1)]; return f ? send(200, f) : send(404, '{}');
    }
    if (u.pathname.startsWith('/api/v3/repos/owner/repo')) {                                  // GitHub
      if (req.headers.authorization !== 'Bearer gh-token' || !req.headers['user-agent']) return send(401, '{"message":"Bad credentials"}', 'application/json');
      if (u.pathname.endsWith('/repo')) return send(200, '{"name":"repo"}', 'application/json');
      if (u.pathname.includes('/git/ref/heads/')) return BRANCHES.includes(decodeURIComponent(u.pathname.split('/git/ref/heads/')[1])) ? send(200, '{"ref":"x"}', 'application/json') : send(404, '{}', 'application/json');
      if (!BRANCHES.includes(q('ref'))) return send(404, '{}');
      const p2 = decodeURIComponent(u.pathname.split('/contents/')[1]);
      if (FILES[p2]) return send(200, FILES[p2]);
      const kids = under(p2); if (!kids.length) return send(404, '{}');
      const direct = [...new Set(kids.map(f => f.slice(p2.length + 1).split('/')[0]))].map(n => FILES[p2 + '/' + n] != null ? { type: 'file', path: p2 + '/' + n } : { type: 'dir', path: p2 + '/' + n });
      return send(200, JSON.stringify(direct), 'application/json');
    }
    if (u.pathname.startsWith('/api/v4/projects/group%2Frepo') || u.pathname.startsWith('/api/v4/projects/group/repo')) {   // GitLab
      if (req.headers['private-token'] !== 'gl-token') return send(401, '{"message":"401 Unauthorized"}', 'application/json');
      const rest = req.url.split('/api/v4/projects/group%2Frepo')[1] || '';
      if (rest === '' || rest.startsWith('?')) return send(200, '{"name":"repo"}', 'application/json');
      if (rest.startsWith('/repository/branches/')) return BRANCHES.includes(decodeURIComponent(rest.split('/repository/branches/')[1].split('?')[0])) ? send(200, '{}', 'application/json') : send(404, '{}', 'application/json');
      if (!BRANCHES.includes(q('ref'))) return send(404, '{}');
      if (rest.startsWith('/repository/tree')) {
        const all = under(q('path')).map(f => ({ type: 'blob', path: f }));
        const page = Number(q('page')); const slice = all.slice((page - 1) * 1, page * 1);   // one per page: paging is exercised
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, page < all.length ? { 'X-Next-Page': String(page + 1) } : {})); return res.end(JSON.stringify(slice));
      }
      const fp = decodeURIComponent(rest.split('/repository/files/')[1].split('/raw')[0]);
      return FILES[fp] ? send(200, FILES[fp]) : send(404, '{}');
    }
    if (u.pathname.startsWith('/2.0/repositories/ws/repo')) {                                // Bitbucket Cloud
      if (req.headers.authorization !== 'Basic ' + Buffer.from('me@example.com:bb-token').toString('base64')) return send(401, '', 'text/plain');
      const rest = u.pathname.slice('/2.0/repositories/ws/repo'.length);
      if (!rest) return send(200, '{"name":"repo"}', 'application/json');
      if (rest.startsWith('/refs/branches/')) return BRANCHES.includes(decodeURIComponent(rest.slice(15))) ? send(200, '{"target":{"hash":"abc123"}}', 'application/json') : send(404, '{}');
      if (rest.startsWith('/src/abc123/')) {
        const p2 = decodeURIComponent(rest.slice(12)).replace(/\/$/, '');
        if (FILES[p2]) return send(200, FILES[p2]);
        const kids = under(p2); if (!kids.length) return send(404, '{}');
        const direct = [...new Set(kids.map(f => f.slice(p2.length + 1).split('/')[0]))].map(n => FILES[p2 + '/' + n] != null ? { type: 'commit_file', path: p2 + '/' + n } : { type: 'commit_directory', path: p2 + '/' + n });
        return send(200, JSON.stringify({ values: direct }), 'application/json');
      }
      return send(404, '{}');
    }
    send(404, '');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: 'http://127.0.0.1:' + server.address().port, BRANCH, seen };
}

ok('repository connectors: Azure DevOps, GitHub, GitLab and Bitbucket each read a file and a folder at the feature branch', async () => {
  const R = require('../src/repoHost');
  assert.deepStrictEqual(R.parseRepoUrl('https://spexample.visualstudio.com/Digital%20Sales/_git/Crm').api, 'https://spexample.visualstudio.com/Digital%20Sales/_apis/git/repositories/Crm');
  assert.strictEqual(R.parseRepoUrl('https://me@dev.azure.com/acme/Sales/_git/crm').api, 'https://dev.azure.com/acme/Sales/_apis/git/repositories/crm');
  assert.strictEqual(R.parseRepoUrl('https://github.com/acme/crm.git').api, 'https://api.github.com/repos/acme/crm');
  assert.strictEqual(R.parseRepoUrl('https://gitlab.com/acme/sf/crm').api, 'https://gitlab.com/api/v4/projects/acme%2Fsf%2Fcrm');
  assert.strictEqual(R.parseRepoUrl('https://bitbucket.org/acme/crm').api, 'https://api.bitbucket.org/2.0/repositories/acme/crm');
  assert.strictEqual(R.parseRepoUrl('https://git.example.com/acme/crm'), null, 'an unknown host needs the provider set');
  const g = await fakeGitHosts();
  try {
    for (const [provider, url, token] of [['azure', g.base + '/org/Proj/_git/repo', 'az-token'], ['github', g.base + '/owner/repo', 'gh-token'],
      ['gitlab', g.base + '/group/repo', 'gl-token'], ['bitbucket', g.base + '/ws/repo', 'me@example.com:bb-token']]) {
      const host = R.createHost(R.parseRepoUrl(url, provider), token);
      assert.deepStrictEqual(await host.check(), { ok: true, message: 'the token can read repo' }, provider);
      assert.strictEqual((await host.readFile(g.BRANCH, 'force-app/main/default/classes/A.cls')).toString(), 'class A {}', provider + ': a file at the branch');
      assert.strictEqual(await host.readFile(g.BRANCH, 'force-app/main/default/classes/Missing.cls'), null, provider + ': a missing file is null');
      assert.deepStrictEqual((await host.listFiles(g.BRANCH, 'force-app/main/default/lwc/cmp')).sort(),
        ['force-app/main/default/lwc/cmp/__tests__/cmp.test.js', 'force-app/main/default/lwc/cmp/cmp.js'], provider + ': a bundle, subfolders included');
      const bad = await R.createHost(R.parseRepoUrl(url, provider), 'wrong').check();
      assert.ok(!bad.ok && /not accepted|invalid or expired/.test(bad.message), provider + ': ' + bad.message);
    }
  } finally { g.server.close(); }
});

ok('the branch check builds its own workspace from the branch - code with its meta file, bundles whole - and names what is missing', async () => {
  const R = require('../src/repoHost'), B = require('../src/branchCheck');
  const g = await fakeGitHosts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra branch '));
  try {
    const host = R.createHost(R.parseRepoUrl(g.base + '/owner/repo', 'github'), 'gh-token');
    const deploy = new Map([['ApexClass', new Set(['A', 'Gone'])], ['LightningComponentBundle', new Set(['cmp'])]]);
    const r = await B.buildWorkspace(host, g.BRANCH, deploy, dir);
    assert.deepStrictEqual(r.written, ['force-app/main/default/classes/A.cls', 'force-app/main/default/classes/A.cls-meta.xml',
      'force-app/main/default/lwc/cmp/__tests__/cmp.test.js', 'force-app/main/default/lwc/cmp/cmp.js']);
    assert.deepStrictEqual(r.missing, ['ApexClass Gone']);
    assert.ok(fs.existsSync(path.join(dir, 'sfdx-project.json')), 'the branch\u2019s own project file');
    assert.ok(fs.existsSync(path.join(dir, '.forceignore')), 'its own .forceignore, so a parent project\u2019s is never used');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'force-app/main/default/classes/A.cls'), 'utf8'), 'class A {}');
  } finally { g.server.close(); rmTree(dir); }
});


ok('promotion workspace: code blocks are settled when the sides agree or only one side changed', () => {
  const W = require('../src/promotionWork');
  const r = W.settleCodeBlocks('a\n<<<<<<< ours\nx\n||||||| base\nx\n=======\ny\n>>>>>>> theirs\nb\n<<<<<<< ours\np\n||||||| base\no\n=======\nq\n>>>>>>> theirs\n');
  assert.deepStrictEqual([r.settled, r.remaining], [1, 1]);
  assert.ok(r.text.startsWith('a\ny\nb\n<<<<<<< ours\np\n'), 'only the theirs side changed from the base: theirs is taken');
});

ok('promotion workspace: Upload all checks each file, uploads in parallel, sets the status after the last, and undoes as one batch', async () => {
  const W = require('../src/promotionWork');
  const libs = { X, duplicates: require('../src/duplicates'), rules: require('../src/rules') };
  const api = promoOrg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra upload '));
  const s = W.store(dir);
  await W.sync(api, s, { id: 'P1', name: 'P10001' }, { copadoOrg: 'copado' });
  // the review file accepted with a choice; the code file resolved by hand - but one is left broken
  const st = s.load();
  s.write('resolved', 'force-app/main/default/permissionsets/Ops.permissionset-meta.xml', s.read('merged', 'force-app/main/default/permissionsets/Ops.permissionset-meta.xml'));
  st.files['force-app/main/default/permissionsets/Ops.permissionset-meta.xml'].state = 'resolved';
  st.files['force-app/main/default/classes/A.cls'].state = 'resolved';
  s.save(st);
  let { ready, held } = W.readyFiles(s, s.load(), libs);
  assert.deepStrictEqual(held.map(h => [h.rel.split('/').pop(), h.reason]), [['A.cls', 'conflict markers left']], 'a file with markers is held back');
  assert.strictEqual(ready.length, 2);
  const first = await W.uploadAll(api, s, ready, { status: true });
  assert.strictEqual(first.uploaded.length, 2);
  assert.ok(!first.batch.statusChange, 'one file is still unresolved: the status stays');
  assert.ok(/^RESOLVED /.test(api.att.A1.Name) && /^RESOLVED /.test(api.att.A4.Name));
  // fix the code file, upload the rest: now the status changes
  s.write('resolved', 'force-app/main/default/classes/A.cls', 'class A {\n  same();\n  feature();\n}\n');
  ({ ready } = W.readyFiles(s, s.load(), libs));
  assert.deepStrictEqual(ready.map(x => x.rel.split('/').pop()), ['A.cls'], 'uploaded files are not sent again');
  const second = await W.uploadAll(api, s, ready, { status: true });
  assert.deepStrictEqual(second.batch.statusChange, { from: 'Merge Conflict', to: 'Conflicts Resolved' });
  // undo the last batch: the code file is a conflict again, the status goes back
  await W.undoBatch(api, s, W.lastBatch(s));
  assert.ok(/^US-0012345 /.test(api.att.A2.Name) && api.att.A2.Body.toString('utf8').includes('<<<<<<<'));
  assert.strictEqual(api.promo.copado__Status__c, 'Merge Conflict');
  assert.strictEqual(s.load().files['force-app/main/default/classes/A.cls'].state, 'resolved', 'kept as resolved here, ready to upload again');
  assert.strictEqual(W.lastBatch(s).id, first.batch.id, 'the earlier batch is next to undo');
  rmTree(dir);
});

ok('pre-check: file paths become the components they belong to', () => {
  const W = require('../src/promotionWork');
  const c = r => { const x = W.componentOf(r); return x ? x.type + ' ' + x.name : null; };
  assert.strictEqual(c('force-app/main/default/permissionsets/Sales.permissionset-meta.xml'), 'PermissionSet Sales');
  assert.strictEqual(c('force-app/main/default/layouts/Account-Sales Layout.layout-meta.xml'), 'Layout Account-Sales Layout');
  assert.strictEqual(c('force-app/main/default/lwc/leadConvert/leadConvertHelper.js'), 'LightningComponentBundle leadConvert');
  assert.strictEqual(c('force-app/main/default/classes/LeadService.cls'), 'ApexClass LeadService');
  assert.strictEqual(c('force-app/main/default/objects/Account/fields/Tier__c.field-meta.xml'), 'CustomField Account.Tier__c');
  assert.strictEqual(c('force-app/main/default/objects/Account/Account.object-meta.xml'), 'CustomObject Account');
  assert.strictEqual(c('force-app/main/default/flows/Lead_Flow.flow-meta.xml'), 'Flow Lead_Flow');
  assert.strictEqual(c('README.md'), null);
  assert.ok(true);
});

ok('the Copado client: direct REST in parallel, describes cached, and the CLI when the network refuses', async () => {
  const { createClient, limiter } = require('../src/copadoClient');
  let active = 0, peak = 0;
  const lim = limiter(3);
  await Promise.all(Array.from({ length: 10 }, () => lim(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; })));
  assert.strictEqual(peak, 3, 'never more than the limit at once');
  const calls = [];
  const fakeSf = {
    loginFor: async () => ({ url: 'https://x', token: 't' }),
    httpGet: async u => {
      calls.push('http ' + u.replace('https://x', ''));
      if (/describe/.test(u)) return Buffer.from(JSON.stringify({ fields: [{ name: 'Id' }, { name: 'copado__Status__c', picklistValues: [{ value: 'A', active: true }, { value: 'Old', active: false }] }] }));
      if (/query/.test(u)) return Buffer.from(JSON.stringify({ done: true, records: [{ attributes: { type: 'X' }, Id: '1', Rel__r: { attributes: {}, Name: 'n' } }] }));
      throw new Error('ECONNRESET');
    },
    query: async () => { calls.push('cli query'); return []; },
    restGet: async () => { calls.push('cli get'); return Buffer.from('via cli'); },
    describe: async () => null, restPatch: async () => {}
  };
  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cra cache ')), 'describe.json');
  const c = createClient({ sfcli: fakeSf, sfPath: 'sf', org: 'copado', version: '62.0', cacheFile: cache, direct: true });
  const f = await c.describe('copado__Promotion__c');
  assert.deepStrictEqual(f[1].picklist, ['A'], 'inactive picklist values are left out');
  await c.describe('copado__Promotion__c');
  const c2 = createClient({ sfcli: fakeSf, sfPath: 'sf', org: 'copado', version: '62.0', cacheFile: cache, direct: true });
  await c2.describe('copado__Promotion__c');
  assert.strictEqual(calls.filter(x => /describe/.test(x)).length, 1, 'described once - then from memory, then from the day\u2019s cache');
  assert.deepStrictEqual(await c.query('SELECT Id FROM X'), [{ Id: '1', Rel__r: { Name: 'n' } }], 'records without Salesforce\u2019s attributes');
  assert.strictEqual((await c.download('Attachment', '00P1')).toString(), 'via cli', 'a network failure switches to the CLI');
  assert.strictEqual(c.mode, 'cli');
  rmTree(path.dirname(cache));
});

ok('the Promotions tab, end to end: open, sorted groups, accept, save a code file, upload all with the status, undo - driven from the page, as there is no sidebar for it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra panel '));
  const api = promoOrg();
  const baseDescribe = api.describe, baseQuery = api.query;
  api.describe = async o => o === 'copado__Promotion__c'
    ? ['Id', 'Name', 'copado__Status__c', 'copado__Source_Environment__c', 'copado__Destination_Environment__c', 'CreatedDate'].map(n => Object.assign(
        { name: n, relationshipName: /Environment__c$/.test(n) ? n.replace('__c', '__r') : null },
        n === 'copado__Status__c' ? { picklist: ['Merge Conflict', 'Conflicts Resolved'] } : {}))
    : baseDescribe(o);
  api.query = async q => /FROM copado__Promotion__c WHERE Name LIKE/.test(q) || /FROM copado__Promotion__c WHERE Id = 'P1' LIMIT 1/.test(q)
    ? [{ Id: 'P1', Name: 'P10001', copado__Status__c: api.promo.copado__Status__c, copado__Source_Environment__r: { Name: 'dev' }, copado__Destination_Environment__r: { Name: 'qa' } }]
    : baseQuery(q);

  // a stand-in VS Code with the pieces the panel uses
  const registered = {}, events = {}, info = [];
  let treeViews = 0;
  const answers = { input: ['P10001'], warning: [] };
  class Emitter { constructor() { this.fns = []; this.event = fn => { this.fns.push(fn); return { dispose() {} }; }; } fire() { this.fns.forEach(f => f()); } dispose() {} }
  class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  const vs = {
    EventEmitter: Emitter, TreeItem, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ThemeIcon: function (id) { this.id = id; },
    MarkdownString: function (v) { this.value = v; }, ProgressLocation: { Notification: 15 },
    Uri: { file: p => ({ scheme: 'file', fsPath: p }) },
    window: {
      createTreeView: () => { treeViews++; return { dispose() {} }; },
      withProgress: async (o, fn) => fn({ report() {} }),
      showInputBox: async () => answers.input.shift(),
      showQuickPick: async items => items[0],
      showInformationMessage: async (m) => { info.push(m); return undefined; },
      showWarningMessage: async (m, o) => { info.push(m); return answers.warning.shift(); },
      setStatusBarMessage: () => ({ dispose() {} }),
      showTextDocument: async () => ({}), activeTextEditor: undefined
    },
    // this test is about resolving automatically, so it is on here; off is the default (tested in smoke3)
    workspace: { getConfiguration: () => ({ get: (k, d) => k === 'promotion.autoResolve' ? true : d }), onDidSaveTextDocument: fn => { events.save = fn; return { dispose() {} }; } },
    commands: { executeCommand: async () => {} },
    env: { clipboard: { writeText: async () => {} } }
  };
  const Module = require('module'); const load = Module._load;
  Module._load = function (req) { return req === 'vscode' ? vs : load.apply(this, arguments); };
  delete require.cache[require.resolve('../promotionUi')];
  const ui = require('../promotionUi');
  Module._load = load;
  const logs = [];
  const calls = {};
  const state = new Map();
  ui.activate({ subscriptions: { push() {} }, workspaceState: { get: (k, d) => state.has(k) ? state.get(k) : d, update: async (k, v) => state.set(k, v) } }, {
    output: { appendLine: l => logs.push(l) }, rc: () => ({ copadoOrg: 'copado', sfPath: 'sf' }), cmd: (id, fn) => { registered[id] = fn; },
    requireTrust() {}, projectRoot: () => root, apiVersion: async () => '62.0', copadoApi: () => api,
    deps: { storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), startSession: async () => {} },
    cmdValidate: async o => { calls.validate = o; }, runBranchCheck: async o => { calls.branch = o; },
    orgForEnvironment: async (c, r, id, name) => name === 'dev' ? 'devAlias' : name === 'qa' ? 'qaAlias' : null, orgList: async () => [], sfcli: { openPath: async () => {} },
    credentialsFor: async () => [], onValidation: () => ({ dispose() {} }), validationStatus: () => null, validatePromotionBranch: async o => { calls.promoBranch = o; },
    showCopadoErrors: async f => f, readinessReport: async o => { calls.readiness = o; }
  });

  const GROUP = [['To review', ['review']], ['Code to resolve', ['code', 'error']], ['Ready to upload', ['auto', 'resolved']], ['Done', ['uploaded', 'copado']]];
  const groups = async () => { const f = Object.values((await ui.snapshot()).current.state.files);
    return GROUP.map(([label, states]) => [label, f.filter(e => states.includes(e.state)).length]).filter(x => x[1]).map(([l, n]) => l + ' (' + n + ')'); };
  const opened = [];
  vs.commands.executeCommand = async (...a) => { opened.push(a[0]); };
  await registered['cmr.promotion.open']();
  assert.deepStrictEqual([opened[0], treeViews], ['cmr.page.open', 0], 'it opens on the page; there is no sidebar view for a promotion');
  const snap0 = await ui.snapshot();
  assert.deepStrictEqual([snap0.current.promotion.name, snap0.current.promotion.status], ['P10001', 'Merge Conflict']);
  // both permission sets: the target with the feature added - ready; the code file is yours
  assert.deepStrictEqual(await groups(), ['Code to resolve (1)', 'Ready to upload (2)']);
  // D6: whatever was stored, Reset works it out again from Copado's file by the current rules
  {
    const W = require('../src/promotionWork'), rel = 'force-app/main/default/permissionsets/Sales.permissionset-meta.xml';
    const store = W.store(ui.openDirs()[0]);
    store.write('merged', rel, 'stored by older rules');
    const want = await W.autoResolve(rel, store.read('conflicted', rel), true);   // this test has resolving automatically on
    await ui.act('reset', { rel });
    const after = (await ui.snapshot()).current.state.files[rel];
    assert.deepStrictEqual([after.state, after.rules, store.read('resolved', rel) === want.merged], [want.state, W.RULES, true], 'Reset: today\u2019s rules, not what was stored');
  }
  assert.ok(info.some(m => /2 resolved automatically, 1 code file to resolve/.test(m)), info.join(' | '));
  assert.ok(logs.some(l => /3 files fetched in/.test(l)));

  // the code file, finished in the editor and saved: it moves to Ready by itself
  const codeFile = path.join(root, '.copado', 'promotions', 'P10001', 'resolved', 'force-app', 'main', 'default', 'classes', 'A.cls');
  fs.writeFileSync(codeFile, 'class A {\n  same();\n  feature();\n}\n');
  events.save({ uri: vs.Uri.file(codeFile), getText: () => fs.readFileSync(codeFile, 'utf8') });
  assert.deepStrictEqual(await groups(), ['Ready to upload (3)']);

  // the page's dialog has been answered: upload, and set the status
  await ui.act('upload', { status: true });
  assert.ok(Object.values(api.att).filter(a => /^RESOLVED /.test(a.Name)).length === 3, 'all three uploaded');
  assert.strictEqual(api.promo.copado__Status__c, 'Conflicts Resolved');
  assert.deepStrictEqual(await groups(), ['Done (3)']);

  answers.warning.push('Undo');
  await ui.act('undo', {});
  assert.strictEqual(api.promo.copado__Status__c, 'Merge Conflict');
  assert.ok(Object.values(api.att).filter(a => /^RESOLVED /.test(a.Name)).length === 0);
  assert.deepStrictEqual(await groups(), ['Ready to upload (3)'], 'still resolved here, ready to upload again');
  assert.deepStrictEqual(state.get('cmr.recentPromotions'), ['P10001']);
  // the pre-check: the promotion's change list plus the resolved files, retrieve from the source, files on top, validate against the destination
  const q0 = api.query, d0 = api.download;
  api.query = async q => /FROM ContentDocumentLink WHERE LinkedEntityId = 'P1'/.test(q)
    ? [{ ContentDocument: { Title: 'Copado Promotion changes', LatestPublishedVersionId: '068000000000020AAA', CreatedDate: '2026-11-12' } }] : q0(q);
  api.download = async (k, id) => id === '068000000000020AAA' ? Buffer.from(JSON.stringify([{ t: 'Flow', n: 'Lead_Flow', a: 'Add' }])) : d0(k, id);
  await ui.act('precheck', {});
  const b = calls.branch;
  assert.deepStrictEqual(b.rows.map(r => r.t + ' ' + r.n).sort(), ['ApexClass A', 'Flow Lead_Flow', 'PermissionSet Ops', 'PermissionSet Sales'], 'the promotion\u2019s change list plus the resolved files');
  assert.deepStrictEqual(b.branches, ['feature/US-0012345'], 'the stories\u2019 feature branches - nothing from the source org');
  assert.deepStrictEqual([b.target, b.overlay.length], ['qaAlias', 3], 'validated against the destination, the resolutions on top');
  assert.ok(b.overlay.every(f => fs.existsSync(f.file)), 'the resolved files exist');
  assert.ok(!fs.existsSync(path.join(root, 'force-app')), 'the project is never touched');
  assert.ok(ui.promotionRef('https://x.lightning.force.com/lightning/r/copado__Promotion__c/a0P5e000001AbCdEAF/view') === 'a0P5e000001AbCdEAF');
  rmTree(root);
});

ok('a component\'s file is located in a source-format project', () => {
  assert.deepStrictEqual(manifest.sourcePaths('Layout', 'Account-ACME Account Layout'), ['layouts/Account-ACME Account Layout.layout-meta.xml']);
  assert.deepStrictEqual(manifest.sourcePaths('FlexiPage', 'ACME_Account_Record_Page'), ['flexipages/ACME_Account_Record_Page.flexipage-meta.xml']);
  assert.deepStrictEqual(manifest.sourcePaths('RecordType', 'Opportunity.ACME_Correction'), ['objects/Opportunity/recordTypes/ACME_Correction.recordType-meta.xml']);
  assert.deepStrictEqual(manifest.sourcePaths('Profile', '[N] Sales'), ['profiles/[N] Sales.profile-meta.xml', 'profiles/%5BN%5D Sales.profile-meta.xml'],
    'Salesforce percent-encodes some characters in file names');
  assert.deepStrictEqual(manifest.sourcePaths('SomethingElse', 'X'), []);
});

section('large files');

function bigPermissionSet(variant) {
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">'];
  for (let i = 0; i < 1500; i++) {
    if (variant === 'incoming' && i % 97 === 0) continue;
    L.push('    <classAccesses>', '        <apexClass>ACME_Class_' + i + '</apexClass>',
      '        <enabled>' + (variant === 'target' && i % 41 === 0 ? 'false' : 'true') + '</enabled>', '    </classAccesses>');
  }
  if (variant !== 'ancestor') for (let i = 0; i < 40; i++) L.push('    <classAccesses>', '        <apexClass>ACME_New_' + variant + '_' + i + '</apexClass>', '        <enabled>true</enabled>', '    </classAccesses>');
  L.push('    <description>Large permission set</description>');
  for (let i = 0; i < 7600; i++) {
    L.push('    <fieldPermissions>', '        <editable>' + (variant === 'incoming' && i % 53 === 0 ? 'true' : 'false') + '</editable>',
      '        <field>ACME_Obj_' + (i % 380) + '__c.ACME_Field_' + i + '__c</field>', '        <readable>true</readable>', '    </fieldPermissions>');
  }
  L.push('    <hasActivationRequired>false</hasActivationRequired>', '    <label>ACME Big PS</label>');
  for (let i = 0; i < 380; i++) {
    L.push('    <objectPermissions>', '        <allowCreate>true</allowCreate>', '        <allowDelete>false</allowDelete>', '        <allowEdit>true</allowEdit>',
      '        <allowRead>true</allowRead>', '        <modifyAllRecords>false</modifyAllRecords>', '        <object>ACME_Obj_' + i + '__c</object>',
      '        <viewAllFields>false</viewAllFields>', '        <viewAllRecords>false</viewAllRecords>', '    </objectPermissions>');
  }
  for (let i = 0; i < 300; i++) L.push('    <userPermissions>', '        <enabled>true</enabled>', '        <name>Perm' + i + '</name>', '    </userPermissions>');
  L.push('</PermissionSet>', '');
  return L.join('\n');
}
const BIG = { ancestor: bigPermissionSet('ancestor'), target: bigPermissionSet('target'), incoming: bigPermissionSet('incoming') };

ok('a 49,000-line permission set merges three-way, correctly, within budget', () => {
  assert.ok(BIG.target.split('\n').length > 49000);
  const t0 = Date.now();
  const pt = X.parse(BIG.target), pi = X.parse(BIG.incoming), pa = X.parse(BIG.ancestor);
  const r = merger.merge(pt, pi, { ancestor: pa });
  const marks = [];
  const out = fmt(r.merged, { marks });
  formatter.format(pt, { indent: 4 });
  formatter.format(pi, { indent: 4 });
  const checked = X.parse(out);
  const errs = rules.check(checked, {}).length + findDuplicates(checked, {}).length;
  const ms = Date.now() - t0;
  console.log('      (full session in ' + ms + ' ms)');
  assert.strictEqual(r.report.conflicts.length, 0, 'every difference here was made on one side only');
  assert.strictEqual(r.report.auto.length, 180);
  assert.strictEqual(r.report.added.length, 40, 'incoming additions');
  assert.strictEqual(errs, 0);
  assert.ok(out.indexOf('ACME_New_target_0') !== -1 && out.indexOf('ACME_New_incoming_39') !== -1);
  assert.ok(ms < 6000, 'took ' + ms + ' ms');
});

ok('a large merge runs in a worker, gives the same result, and leaves the main thread free', async () => {
  const { Worker } = require('worker_threads');
  const { runMergeJob } = require('../src/mergeJob');
  const job = {
    targetText: BIG.target, incomingText: BIG.incoming, ancestorText: BIG.ancestor,
    merge: { dedupe: true, keep: 'first', keepTarget: [], winner: 'incoming' },
    format: { indent: 4, eol: '\n', elementOrder: 'standard', sortCollections: true, typeOrder: {}, leadingElements: {} },
    normalize: true, rules: { enable: true, disabled: [] }
  };
  const direct = runMergeJob(job);
  assert.ok(direct.ok && direct.lines > 49000);
  for (const k of ['parse', 'merge', 'format', 'checks']) assert.ok(typeof direct.timings[k] === 'number', 'timing for ' + k);

  // the main thread keeps ticking while the worker merges
  let ticks = 0, longest = 0, last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; ticks++; }, 20);
  const viaWorker = await new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'src', 'mergeWorker.js'), { workerData: job });
    w.once('message', m => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
  clearInterval(timer);
  assert.ok(ticks >= 5, 'the main thread ran ' + ticks + ' timer ticks during the merge');
  assert.ok(longest < 400, 'the longest pause on the main thread was ' + longest + ' ms');

  assert.strictEqual(viaWorker.mergedText, direct.mergedText, 'same merged file');
  assert.strictEqual(viaWorker.targetText, direct.targetText);
  assert.deepStrictEqual(viaWorker.report, direct.report);
  assert.deepStrictEqual(viaWorker.checks, direct.checks);
  assert.strictEqual(viaWorker.marks.length, direct.marks.length);
  const m = viaWorker.marks.find(x => x.mark.kind === 'auto' || x.mark.kind === 'added');
  const listed = m.mark.kind === 'added' ? viaWorker.report.added : viaWorker.report.auto;
  assert.ok(listed.includes(m.mark[m.mark.kind]), 'a mark still points at its report entry after the hand-over');
});

ok('cancelling a merge stops its worker straight away', async () => {
  const { Worker } = require('worker_threads');
  const job = { targetText: BIG.target, incomingText: BIG.incoming, merge: {}, format: { indent: 4 }, normalize: true, rules: { enable: true } };
  const w = new Worker(path.join(__dirname, '..', 'src', 'mergeWorker.js'), { workerData: job });
  let answered = false;
  w.on('message', () => { answered = true; });
  await new Promise(r => setTimeout(r, 30));
  const t0 = Date.now();
  const code = await w.terminate();
  assert.ok(Date.now() - t0 < 1000, 'stopped in ' + (Date.now() - t0) + ' ms');
  assert.strictEqual(answered, false, 'no result arrives after cancelling');
  assert.strictEqual(typeof code, 'number');
});

ok('a merge job reports problems instead of throwing', () => {
  const { runMergeJob } = require('../src/mergeJob');
  const bad = runMergeJob({ targetText: '<PermissionSet/>', incomingText: '<Profile/>', merge: {}, format: {} });
  assert.strictEqual(bad.ok, false);
  assert.ok(/different metadata types/.test(bad.error));
  const anc = runMergeJob({ targetText: '<PermissionSet><label>a</label></PermissionSet>', incomingText: '<PermissionSet><label>b</label></PermissionSet>',
    ancestorText: '<Profile/>', merge: {}, format: { indent: 4 } });
  assert.ok(anc.ok && /two-way/.test(anc.warning) && anc.threeWay === false, 'a wrong ancestor falls back to two-way');
});

ok('merging never changes its input documents', () => {
  const pt = X.parse(BIG.target), pi = X.parse(BIG.incoming), pa = X.parse(BIG.ancestor);
  const before = [formatter.format(pt, { indent: 4 }), formatter.format(pi, { indent: 4 }), formatter.format(pa, { indent: 4 })];
  const r = merger.merge(pt, pi, { ancestor: pa });
  fmt(r.merged, { marks: [] });
  const after = [formatter.format(pt, { indent: 4 }), formatter.format(pi, { indent: 4 }), formatter.format(pa, { indent: 4 })];
  assert.deepStrictEqual(after, before);
  const marked = [];
  (function walk(el) { if (el.mark) marked.push(el.name); for (const c of X.elements(el)) walk(c); })(pt.root);
  assert.deepStrictEqual(marked, [], 'annotations go on copies, never on the parsed input');
});

ok('comments are kept, including the last one in a block', () => {
  const xml = '<Profile xmlns="x"><!-- head --><custom>true</custom><userPermissions><enabled>true</enabled><name>A</name><!-- inner tail --></userPermissions><!-- tail --></Profile>';
  const out = formatter.format(X.parse(xml), { indent: 4 });
  for (const c of ['head', 'inner tail', 'tail']) assert.ok(out.indexOf('<!-- ' + c + ' -->') !== -1, c);
  assert.strictEqual(out, formatter.format(X.parse(out), { indent: 4 }), 'still idempotent');
});

ok('a fix on a 49,000-line file removes one entry and nothing else', () => {
  const r = fixes.applyEdit(BIG.target, { op: 'removeEntries', childTag: 'field', value: 'ACME_Obj_7__c.ACME_Field_7__c' });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(BIG.target.length - r.text.length,
    '    <fieldPermissions>\n        <editable>false</editable>\n        <field>ACME_Obj_7__c.ACME_Field_7__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n'.length);
});

/* ------------------------------------------------------------ 3.0 */
require('./smoke3')(ok, section, { fakeGitHosts: (...a) => fakeGitHosts(...a), fakeSf: (...a) => fakeSf(...a), promoOrg: (...a) => promoOrg(...a) });

/* ------------------------------------------------------------ run */
(async () => {
  // a test file edited by hand can end up with a block pasted twice; refuse to run quietly over that
  const names = tests.filter(t => !t.section).map(t => t.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) { console.log('FAIL duplicate test names: ' + twice.join(' | ')); process.exitCode = 1; return; }
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    if (t.section) { console.log(t.section); continue; }
    try { await t.fn(); pass++; console.log('  ok  ' + t.name); }
    catch (e) { fail++; console.log('  FAIL ' + t.name + '\n      ' + String((e && e.message) || (e && e.stack) || JSON.stringify(e)).split('\n').join('\n      ')); }
  }
  if (repo) try { rmTree(repo); } catch (e) { /* tmp */ }
  console.log('\n' + pass + ' checks passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (fail) process.exitCode = 1;
})();
