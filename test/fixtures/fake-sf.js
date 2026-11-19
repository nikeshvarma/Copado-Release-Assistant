// A stand-in for the Salesforce CLI, used by the tests. It answers the
// commands the extension sends, and in terminal mode (no --json) it prints
// progress over time the way the real CLI does: colour codes, a spinner line
// redrawn with carriage returns, stage lines, then a summary.
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
const flag = n => { const i = a.indexOf(n); return i === -1 ? undefined : a[i + 1]; };
const json = a.indexOf('--json') !== -1;
const cmd = a.filter(x => !x.startsWith('-')).slice(0, 3).join(' ');
const done = (o, code) => { if (json) process.stdout.write(JSON.stringify(o)); process.exit(code); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const say = t => process.stdout.write(t);

(async () => {
  process.stderr.write(' \u00bb   Warning: @salesforce/cli update available from 2.143.6 to 2.153.5.\n');
  if (cmd.startsWith('version')) return done({ status: 0, result: { cliVersion: '@salesforce/cli/2.143.6' } }, 0);
  // Salesforce REST, as the extension uses it for Copado's selective-commit files
  if (cmd === 'api request rest') {
    if (process.env.FAKE_SF_NO_API === 'wrapped') {
      // how a real CLI without the plugin answers: a warning wrapped across lines with »
      process.stderr.write(' \u00bb   Warning: api request rest\n \u00bb   ' + a[3] + ' is not a\n \u00bb   sf command.\n');
      process.exit(2);
    }
    if (process.env.FAKE_SF_NO_API) { process.stderr.write("Error: api is not a sf command.\n"); process.exit(2); }
    if (process.env.FAKE_SF_COUNT) require('fs').appendFileSync(process.env.FAKE_SF_COUNT, 'api\n');
    const m = /ContentVersion\/(068\w+)\/VersionData/.exec(a[3] || '');
    if (!m) { process.stderr.write('Error (404): NOT_FOUND\n'); process.exit(1); }
    process.stdout.write('<?xml version="1.0" encoding="UTF-8"?>\n<Layout xmlns="http://soap.sforce.com/2006/04/metadata">from ' + m[1] + ' via ' + flag('--target-org') + '</Layout>\n');
    process.exit(0);
  }
  if (cmd.startsWith('data query')) {
    const q = flag('--query') || '';
    if (/Bogus__c/.test(q)) return done({ status: 1, name: 'INVALID_FIELD', message: "No such column 'Bogus__c' on entity 'copado__User_Story__c'." }, 1);
    return done({ status: 0, result: { totalSize: 1, done: true, records: [{ Id: 'a0U000000000001AAA', Name: 'US-0012345', echoedQuery: q }] } }, 0);
  }
  if (cmd.startsWith('sobject describe')) {
    if (flag('--sobject') !== 'copado__User_Story__c') return done({ status: 1, name: 'NOT_FOUND', message: 'The requested resource does not exist' }, 1);
    return done({ status: 0, result: { name: 'copado__User_Story__c', fields: [{ name: 'Id' }, { name: 'copado__Project__c', relationshipName: 'copado__Project__r' }] } }, 0);
  }
  if (cmd.startsWith('org display') && process.env.FAKE_SF_COUNT) require('fs').appendFileSync(process.env.FAKE_SF_COUNT, 'display\n');
  if (cmd.startsWith('org display')) return done({ status: 0, result: { accessToken: process.env.FAKE_SF_TOKEN || '00D000000000001!fake', instanceUrl: process.env.FAKE_SF_INSTANCE || 'http://127.0.0.1:9', apiVersion: '62.0' } }, 0);
  // the components of a type an org has: the source org (qa) two fields more than the target (uat)
  if (cmd === 'org list metadata') {
    const org = flag('--target-org'), type = flag('--metadata-type');
    const has = { CustomField: org === 'uat' ? ['Invoice__c.Due_Date__c'] : ['Invoice__c.Due_Date__c', 'Invoice__c.Region__c', 'Invoice__c.Tax_Rate__c'], ApexClass: org === 'uat' ? ['InvoiceService'] : ['InvoiceService', 'TaxCalculator'] }[type] || [];
    return done({ status: 0, result: has.map(n => ({ fullName: n, type })) });
  }
  // a retrieve that writes what the manifest names, as source files - when a test asks for it
  if (cmd === 'project retrieve start' && process.env.FAKE_SF_WRITE) {
    const fs = require('fs'), path = require('path');
    const xml = fs.readFileSync(path.resolve(process.cwd(), flag('--manifest')), 'utf8');
    for (const [, body] of xml.matchAll(/<types>([\s\S]*?)<\/types>/g)) {
      const type = /<name>([^<]+)<\/name>/.exec(body)[1];
      for (const [, n] of body.matchAll(/<members>([^<]+)<\/members>/g)) {
        const base = path.join(process.cwd(), 'force-app', 'main', 'default');
        const put = (rel, text) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
        if (type === 'CustomField') { const [o, f] = n.split('.'); put('objects/' + o + '/fields/' + f + '.field-meta.xml', '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>' + f + '</fullName></CustomField>\n'); }
        else if (type === 'ApexClass') { put('classes/' + n + '.cls', 'public class ' + n + ' {}\n'); put('classes/' + n + '.cls-meta.xml', '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion></ApexClass>\n'); }
      }
    }
    process.stdout.write('Retrieved Source\n'); process.exit(0);
  }
  if (cmd === 'org list') return done({ status: 0, result: { nonScratchOrgs: [{ alias: 'qa', username: 'me@example.com.qa', isSandbox: true }] } }, 0);

  if (cmd === 'project retrieve start' && !json && process.env.FAKE_SF_STYLE === 'frames') {
    // what the CLI does when piped on Windows: the whole block, reprinted every tick
    const frame = (t, done) => [
      '\u2014\u2014\u2014\u2014\u2014 Retrieving Metadata \u2014\u2014\u2014\u2014\u2014', '',
      'Retrieving v62.0 metadata from me@example.com.dev using the', 'v62.0 SOAP API', '',
      '\u221aPreparing retrieve request 7ms', '\u221aSending request to org 444ms',
      (done ? '\u221aWaiting for the org to respond ' : '|/-\\'[Math.round(t * 100) % 4] + 'Waiting for the org to respond ') + t.toFixed(2) + 's',
      done ? '\u221aDone 2ms' : '\u25a0Done', '', 'Status: ' + (done ? 'Succeeded' : 'Pending'),
      'Elapsed Time: ' + (t + 0.5).toFixed(2) + 's', ''].join('\n') + '\n';
    for (let i = 0; i < 40; i++) { say(frame(22.5 + i * 0.03, false)); await wait(15); }
    say(frame(23.8, true));
    if (process.env.SF_DISABLE_SOURCE_MEMBER_POLLING !== 'true') say('Updating source tracking... done\n');
    say('Retrieved Source\n');
    for (const f of ['Field1__c', 'Field2__c', 'Field3__c']) say('Changed  Invoice__c.' + f + '  CustomField  force-app/main/default/objects/Invoice__c/fields/' + f + '.field-meta.xml\n');
    return done(null, 0);
  }

  if (cmd === 'project retrieve start' && !json) {
    say('\u001b[1m\u2500\u2500\u2500 Retrieving Metadata \u2500\u2500\u2500\u001b[22m\n\n');
    say('Retrieving v62.0 metadata from me@example.com.dev using the v62.0 SOAP API\n\n');
    say('\u001b[32m\u2714\u001b[39m Preparing retrieve request 7ms\n');
    for (const t of ['1s', '2s', '3s']) { say('\r\u280b Waiting for the org to respond ' + t); await wait(120); }
    say('\r\u2714 Waiting for the org to respond 3.1s\n');
    say('\u2714 Done 2ms\n\nStatus: Succeeded\n\nRetrieved Source\n');
    say('\u2502 State   \u2502 Name       \u2502 Type          \u2502 Path \u2502\n');
    say('\u2502 Changed \u2502 Sales_User \u2502 PermissionSet \u2502 force-app/main/default/permissionsets/Sales_User.permissionset-meta.xml \u2502\n');
    say('\u2502 Created \u2502 Region__c  \u2502 CustomField   \u2502 force-app/main/default/objects/Invoice__c/fields/Region__c.field-meta.xml \u2502\n');
    say('\nWarnings\n\u2502 Invoice__c.Gone__c \u2502 CustomField \u2502 Entity of type \'CustomField\' named \'Invoice__c.Gone__c\' cannot be found \u2502\n');
    return done(null, 0);
  }

  if ((cmd === 'project deploy validate' || cmd === 'project deploy start') && !json) {
    if (cmd === 'project deploy start' && a.indexOf('--dry-run') === -1) { process.stderr.write('REFUSING: real deployment\n'); process.exit(99); }
    if (cmd === 'project deploy validate' && flag('--test-level') === 'NoTestRun') {
      process.stderr.write('Error (1): Expected --test-level=NoTestRun to be one of: RunAllTestsInOrg, RunLocalTests, RunSpecifiedTests\nSee more help with --help\n');
      process.exit(2);
    }
    if (!flag('--manifest') || !fs.existsSync(path.resolve(process.cwd(), flag('--manifest')))) {
      process.stderr.write('Error (1): Parsing --manifest\n    No file found at ' + flag('--manifest') + '\n');
      process.exit(2);
    }
    say('\u2500\u2500\u2500 Validating Deployment \u2500\u2500\u2500\n\nDeploying v62.0 metadata to me@example.com.qa using the v62.0 SOAP API.\n');
    say('Deploy ID: 0Af000000000004AAA\n\n\u2714 Preparing 1.2s\n');
    for (const n of [1, 1, 2]) { say('\r\u280b Deploying Metadata  Components: ' + n + '/2'); await wait(120); }
    say('\r\u2718 Deploying Metadata  Components: 2/2 (1 error)\n\nStatus: Failed\n');
    return done(null, 1);
  }

  if (cmd === 'project deploy report' && json) {
    return done({ status: 1, name: 'FailedValidationError', message: 'Failed to validate', data: {
      id: flag('--job-id'), status: 'Failed', success: false, checkOnly: true, numberComponentErrors: 1,
      details: { componentFailures: [{ componentType: 'PermissionSet', fullName: 'Sales_User', lineNumber: '3',
        fileName: 'force-app/main/default/permissionsets/Sales_User.permissionset-meta.xml',
        problem: 'In field: field - no CustomField named Invoice__c.Region__c found', problemType: 'Error' }] } } }, 1);
  }
  process.stderr.write('Error: unknown command ' + a.join(' ') + '\n');
  done({ status: 1, name: 'UnknownCommand', message: 'unknown: ' + a.join(' ') }, 1);
})();
