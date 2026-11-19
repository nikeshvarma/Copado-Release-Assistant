'use strict';

/**
 * The tests of 3.0: proxy, repository from Copado, stage rules, the
 * pipeline's steps, story journeys, back-promotions and hotfixes, Copado's
 * deployment followed, the readiness report, the page's views, and the
 * promotion branch validated end to end. Registered by smoke.js.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rmTree = require('./rmTree');
const http = require('http');
const https = require('https');
const net = require('net');

const FIX = p => path.join(__dirname, 'fixtures', p);

/** A local proxy: CONNECT tunnels to the fake TLS server, absolute-form requests to the fake web server, optional login. */
async function fakeProxy(o) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers['proxy-authorization'] || null });
    if (o.auth && req.headers['proxy-authorization'] !== o.auth) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic' }); return res.end(); }
    const u = new URL(req.url);
    const up = http.request({ host: '127.0.0.1', port: o.plainPort, path: u.pathname + u.search, method: req.method, headers: Object.assign({}, req.headers, { host: u.host }) }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  server.on('connect', (req, socket) => {
    seen.push({ method: 'CONNECT', url: req.url, auth: req.headers['proxy-authorization'] || null });
    if (o.auth && req.headers['proxy-authorization'] !== o.auth) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const up = net.connect(o.tlsPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy());
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: 'http://127.0.0.1:' + server.address().port, seen };
}

module.exports = function register(ok, section, h) {
  section('3.0: network, repository, stage rules');

  ok('through a corporate proxy: https by a CONNECT tunnel with its login, http in absolute form, the extra certificate trusted, loopback and NO_PROXY direct', async () => {
    const X = require('../src/http');
    const sfcli = require('../src/sfcli');
    const R = require('../src/repoHost');
    const hits = [];
    const handler = (req, res) => {
      hits.push({ host: req.headers.host, url: req.url, auth: req.headers.authorization || null });
      if (req.url === '/away') { res.writeHead(302, { Location: 'http://plain.test/landing' }); return res.end(); }
      if (req.url.startsWith('/api/v3/repos/owner/repo')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"name":"repo"}'); }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello from ' + req.headers.host + req.url);
    };
    const tls = https.createServer({ key: fs.readFileSync(FIX('proxy-test.key')), cert: fs.readFileSync(FIX('proxy-test.crt')) }, handler);
    const plain = http.createServer(handler);
    await new Promise(r => tls.listen(0, '127.0.0.1', r));
    await new Promise(r => plain.listen(0, '127.0.0.1', r));
    const auth = 'Basic ' + Buffer.from('jo:s3cret').toString('base64');
    const px = await fakeProxy({ tlsPort: tls.address().port, plainPort: plain.address().port, auth });
    try {
      X.configure({ proxy: px.url.replace('http://', 'http://jo:s3cret@'), ca: fs.readFileSync(FIX('proxy-test.crt'), 'utf8'), noProxy: '' });
      // Salesforce REST with the CLI's session, through the tunnel
      const body = await sfcli.httpGet('https://copado.test/services/data/v62.0/query', 'tok123');
      assert.strictEqual(body.toString(), 'hello from copado.test/services/data/v62.0/query');
      assert.deepStrictEqual(px.seen[0], { method: 'CONNECT', url: 'copado.test:443', auth }, 'a tunnel to the host, with the proxy login');
      assert.strictEqual(hits[0].auth, 'Bearer tok123', 'the token goes inside the tunnel, to Salesforce');
      // a Git host behind the same proxy
      const host = R.createHost(R.parseRepoUrl('https://git.test/owner/repo', 'github'), 'gh');
      assert.strictEqual((await host.check()).ok, true);
      // plain http: absolute form, not a tunnel
      assert.strictEqual((await X.request('http://plain.test/x')).body.toString(), 'hello from plain.test/x');
      assert.ok(px.seen.some(s => s.method === 'GET' && s.url === 'http://plain.test/x'));
      // a redirect to another host is followed without the token
      await sfcli.httpGet('https://copado.test/away', 'tok123');
      const landed = hits.find(x => x.url === '/landing');
      assert.ok(landed && landed.auth === null, 'the token never leaves the host it was meant for');
      // wrong proxy login: said plainly
      X.configure({ proxy: px.url });
      await assert.rejects(X.request('https://copado.test/x'), /needs a login \(407\)/);
      // NO_PROXY and loopback go direct
      X.configure({ proxy: px.url, noProxy: '.plain.test, copado.test:8443' });
      assert.strictEqual(X.bypass('api.plain.test', 80), true);
      assert.strictEqual(X.bypass('copado.test', 443), false, 'a port in NO_PROXY only matches that port');
      assert.strictEqual(X.bypass('localhost', 80) && X.bypass('127.0.0.1', 1) && X.bypass('[::1]', 1), true);
      assert.strictEqual(X.proxyFor('http://127.0.0.1:9/x'), null, 'this machine is never proxied');
      // without the extra certificate, the self-signed host is refused - with a hint
      X.configure({ proxy: px.url.replace('http://', 'http://jo:s3cret@'), ca: null, noProxy: '' });
      await assert.rejects(X.request('https://copado.test/x'), /not trusted .*HTTP CA file/);
    } finally {
      X.configure({ proxy: '', ca: null, noProxy: '', strictSSL: true });
      px.server.close(); tls.close(); plain.close();
    }
  });

  ok('the Copado client goes direct with a proxy set - the CLI is only the fallback', async () => {
    const { createClient } = require('../src/copadoClient');
    const old = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy.example:8080';
    try {
      const c = createClient({ sfcli: { loginFor: async () => ({ url: 'https://x', token: 't' }), httpGet: async () => Buffer.from('{"done":true,"records":[]}') }, org: 'copado' });
      assert.strictEqual(c.mode, 'direct');
      await c.query('SELECT Id FROM X');
      assert.strictEqual(c.mode, 'direct');
    } finally { if (old === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = old; }
  });

  ok('the repository address comes from Copado\u2019s Git Repository record - SSH forms become https', () => {
    const R = require('../src/repoHost');
    const cases = {
      'git@github.com:owner/repo.git': 'https://github.com/owner/repo',
      'git@ssh.dev.azure.com:v3/acme/Sales/crm': 'https://dev.azure.com/acme/Sales/_git/crm',
      'ssh://git@ssh.dev.azure.com/v3/acme/Sales/crm': 'https://dev.azure.com/acme/Sales/_git/crm',
      'acme@vs-ssh.visualstudio.com:v3/acme/Sales/crm': 'https://acme.visualstudio.com/Sales/_git/crm',
      'git@gitlab.com:group/sub/repo.git': 'https://gitlab.com/group/sub/repo',
      'git@bitbucket.org:ws/repo.git': 'https://bitbucket.org/ws/repo',
      'https://me:pw@bitbucket.org/ws/repo.git': 'https://bitbucket.org/ws/repo',
      'ssh://git@git.example.com:7999/team/repo.git': 'https://git.example.com/team/repo'
    };
    for (const [from, to] of Object.entries(cases)) {
      assert.strictEqual(R.fromCopadoUri(from), to, from);
      if (!/example\.com/.test(to)) assert.ok(R.parseRepoUrl(to), to + ' is one the connectors read');
    }
    for (const bad of ['', 'nonsense', 'file:///repo']) assert.strictEqual(R.fromCopadoUri(bad), null, bad);
  });

  ok('repository connectors say whether a branch exists - Azure DevOps, GitHub, GitLab and Bitbucket', async () => {
    const R = require('../src/repoHost');
    const g = await h.fakeGitHosts({ branches: ['feature/US-0012345', 'promotion/P10001'] });
    try {
      for (const [provider, url, token] of [['azure', g.base + '/org/Proj/_git/repo', 'az-token'], ['github', g.base + '/owner/repo', 'gh-token'],
        ['gitlab', g.base + '/group/repo', 'gl-token'], ['bitbucket', g.base + '/ws/repo', 'me@example.com:bb-token']]) {
        const host = R.createHost(R.parseRepoUrl(url, provider), token);
        assert.strictEqual(await host.branchExists('promotion/P10001'), true, provider);
        assert.strictEqual(await host.branchExists('promotion/P999999'), false, provider + ': a missing branch');
        assert.strictEqual(await host.branchExists('feature/US-0012345'), true, provider);
      }
      await assert.rejects(R.createHost(R.parseRepoUrl(g.base + '/owner/repo', 'github'), 'bad').branchExists('x'), /invalid or expired/);
    } finally { g.server.close(); }
  });

  ok('stage rules: each Copado environment its own login, test level and coverage', () => {
    const G = require('../src/guard');
    const { policy } = G.resolvePolicy(JSON.stringify({ environments: {
      QA: { minimumTestLevel: 'RunSpecifiedTests' },
      'UAT*': { minimumTestLevel: 'RunLocalTests', coverage: 85 },
      Production: { requiredTargetUser: ['release.user@*'], minimumTestLevel: 'RunLocalTests' },
      Broken: { minimumTestLevel: 'Sometimes', coverage: 140 } } }), {});
    const qa = { alias: 'qa', username: 'me@example.com.qa', isSandbox: true };
    const r1 = G.check(policy, qa, 'NoTestRun', { environment: 'qa' });
    assert.deepStrictEqual([r1.allowed, r1.testLevel, r1.raisedFrom, r1.rule], [true, 'RunSpecifiedTests', 'NoTestRun', 'environment QA'], 'names match regardless of case');
    const r2 = G.check(policy, qa, 'NoTestRun', { environment: 'UAT2', hasApex: true });
    assert.deepStrictEqual([r2.testLevel, r2.coverage], ['RunLocalTests', 85], 'a wildcard name');
    const prod = { alias: 'prod', username: 'me@example.com', isSandbox: false };
    const r3 = G.check(policy, prod, 'RunLocalTests', { environment: 'Production', username: 'me@example.com' });
    assert.ok(!r3.allowed && /must be validated as release\.user@\* - prod logs in as me@example\.com/.test(r3.reason), r3.reason);
    assert.strictEqual(G.check(policy, Object.assign({}, prod, { username: 'release.user@example.com' }), 'RunLocalTests', { environment: 'Production', username: 'release.user@example.com' }).allowed, true);
    assert.ok(/cannot say which user/.test(G.check(policy, { alias: 'prod', username: 'prod', isSandbox: false }, 'RunLocalTests', { environment: 'Production' }).reason), 'an unknown login is refused, not trusted');
    assert.strictEqual(G.check(policy, qa, 'NoTestRun', { environment: 'dev' }).testLevel, 'NoTestRun', 'a stage without rules is left alone');
    const broken = G.environmentRule(policy, 'Broken');
    assert.deepStrictEqual([broken.minimumTestLevel, broken.coverage], [null, null], 'invalid values are ignored, not guessed');
    // a coverage rule with Apex and no tests: tests are needed to measure it
    const cov = G.resolvePolicy(JSON.stringify({ environments: { SIT: { coverage: 80 } } }), {}).policy;
    assert.strictEqual(G.check(cov, qa, 'NoTestRun', { environment: 'SIT', hasApex: true }).testLevel, 'RunSpecifiedTests');
    assert.strictEqual(G.check(cov, qa, 'NoTestRun', { environment: 'SIT', hasApex: false }).testLevel, 'NoTestRun');
    assert.deepStrictEqual(G.belowCoverage([{ name: 'A', percent: 91 }, { name: 'b', percent: 70 }], 85, ['A', 'B', 'C']), { below: [{ name: 'B', percent: 70 }], unreported: ['C'] });
    // the same rules from settings
    assert.strictEqual(G.check(G.resolvePolicy(null, { environments: { QA: { minimumTestLevel: 'RunLocalTests' } } }).policy, qa, 'NoTestRun', { environment: 'QA' }).testLevel, 'RunLocalTests');
  });

  ok('a validation\u2019s per-class coverage is read from the deploy result', () => {
    const sfcli = require('../src/sfcli');
    const r = sfcli.parseDeploy({ status: 0, result: { id: '0Af000000000001AAA', success: true, checkOnly: true, numberComponentErrors: 0, details: { runTestResult: {
      codeCoverage: [{ name: 'AccountService', numLocations: '40', numLocationsNotCovered: '6' }, { name: 'Empty', numLocations: 0, numLocationsNotCovered: 0 }],
      codeCoverageWarnings: [] } } } });
    assert.deepStrictEqual(r.coverage, [{ name: 'AccountService', covered: 34, total: 40, percent: 85 }, { name: 'Empty', covered: 0, total: 0, percent: 100 }]);
  });

  ok('the validation history keeps the newest 500, and finds what concerns a story or a promotion', () => {
    const H = require('../src/history');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra history '));
    try {
      for (let i = 0; i < 503; i++) H.add(dir, { label: 'run ' + i, environment: i % 2 ? 'qa' : 'uat', stories: i === 502 ? ['us-0000101'] : [], promotion: i === 501 ? 'P0003' : null, success: true });
      const all = H.load(dir);
      assert.strictEqual(all.length, 500);
      assert.strictEqual(all[0].label, 'run 3');
      const mine = H.about(all, { stories: ['US-0000101'], promotion: 'P0003' });
      assert.deepStrictEqual(mine.map(e => e.label), ['run 502', 'run 501'], 'newest first; story names match regardless of case');
      fs.writeFileSync(path.join(dir, 'validations.json'), '{ broken');
      assert.deepStrictEqual(H.load(dir), [], 'a broken file is an empty history, not a crash');
    } finally { rmTree(dir); }
  });

  section('3.0: the lifecycle - pipeline steps, journeys, back-promotions');

  ok('the pipeline map: stages from the steps, each environment\u2019s branch, production at the end, the hotfix lane beside the first stage', async () => {
    const L = require('../src/lifecycle');
    const { lifeOrg } = require('./fixtures/life-org');
    const api = lifeOrg();
    const list = await L.pipelines(api);
    assert.deepStrictEqual(list.map(p => [p.name, p.active]), [['Old pipeline', false], ['Sales pipeline', true]]);
    const m = await L.pipeline(api, 'F1');
    const names = ids => ids.map(id => m.envs[id].name);
    assert.deepStrictEqual(m.stages.map(names), [['dev1', 'dev2', 'hotfix'], ['int'], ['qa'], ['uat'], ['prod']]);
    assert.deepStrictEqual([m.envs.E0D1.branch, m.envs.E0INT.branch, m.envs.E0UAT.branch, m.envs.E0PRD.branch], ['dev1', 'int', 'uat', 'main'], 'branches from the steps');
    assert.deepStrictEqual([m.productionId, m.productionBranch, m.repo], ['E0PRD', 'main', 'sales-repo']);
    assert.strictEqual(L.reaches(m, 'E0D1', 'E0PRD'), true);
    assert.strictEqual(L.reaches(m, 'E0PRD', 'E0UAT'), false);
    // a pipeline with a loop in it still ends
    const loop = L.build({ id: 'x', name: 'x' }, [{ fromId: 'a', toId: 'b' }, { fromId: 'b', toId: 'a' }]);
    assert.ok(loop.order.length === 2);
    await assert.rejects(L.pipeline(api, 'F9'), /No Copado pipeline F9/);
  });

  ok('who logs in where: the remembered login first, then an org credential matched to a CLI login, else the stage\u2019s default credential', async () => {
    const L = require('../src/lifecycle');
    const api = require('./fixtures/life-org').lifeOrg();
    const envs = [{ id: 'E0QA', name: 'qa' }, { id: 'E0UAT', name: 'uat' }, { id: 'E0INT', name: 'int' }, { id: 'E0D1', name: 'dev1' }];
    const local = [{ alias: 'qa', username: 'me@example.com.qa' }, { alias: 'integration', username: 'me@example.com.int' }];
    const r = await L.logins(api, envs, local, { int: 'integration' });
    assert.deepStrictEqual([r.E0QA.alias, r.E0QA.username, r.E0QA.how], ['qa', 'me@example.com.qa', 'credential'], 'matched by username, regardless of case');
    assert.deepStrictEqual([r.E0INT.alias, r.E0INT.how], ['integration', 'setting']);
    assert.deepStrictEqual([r.E0UAT.alias, r.E0UAT.username, r.E0UAT.credential], [null, 'release@example.com.uat', 'uat release'], 'no login here: the stage\u2019s default credential is shown');
    assert.deepStrictEqual([r.E0D1.alias, r.E0D1.username], [null, null]);
  });

  ok('back-promotions are recognised by Copado\u2019s flag - or, without one, by the pipeline\u2019s direction', async () => {
    const L = require('../src/lifecycle');
    const { lifeOrg } = require('./fixtures/life-org');
    for (const noBackField of [false, true]) {
      const api = lifeOrg({ noBackField });
      const m = await L.pipeline(api, 'F1');
      const back = await L.promotionById(api, 'P5'), forward = await L.promotionById(api, 'P3');
      assert.deepStrictEqual([back.name, back.backFlag, forward.backFlag], noBackField ? ['P0005', null, null] : ['P0005', true, false]);
      assert.deepStrictEqual([L.isBackPromotion(back, m), L.isBackPromotion(forward, m)], [true, false], noBackField ? 'from the pipeline: uat sits before prod' : 'Copado\u2019s flag');
      assert.strictEqual(await L.backPromotionField(api), noBackField ? null : 'copado__Back_Promotion__c');
    }
    assert.strictEqual(L.isBackPromotion({ backFlag: false, fromId: 'E0PRD', toId: 'E0UAT' }, null), false, 'Copado\u2019s flag wins');
    assert.deepStrictEqual([L.isBlocking('Merge Conflict'), L.isBlocking('Conflicts Resolved'), L.isBlocking('Validation Failed'), L.isBlocking('In Progress')], [true, false, true, false]);
  });
  ok('a story\u2019s journey: each stage with its promotion, where it is now, what comes next', async () => {
    const L = require('../src/lifecycle');
    const api = require('./fixtures/life-org').lifeOrg();
    const j = await L.storyJourney(api, 'US-0000101');
    assert.deepStrictEqual(j.stages.map(s => [s.env, s.state, s.promotion && s.promotion.name]),
      [['dev1', 'done', null], ['int', 'done', 'P0001'], ['qa', 'current', 'P0002'], ['uat', 'next', 'P0003'], ['prod', 'ahead', null]]);
    assert.strictEqual(j.stages[3].promotion.blocking, true, 'the promotion into the next stage is in conflict');
    assert.deepStrictEqual([j.next.env, j.next.branch, j.hotfix], ['uat', 'uat', false]);
    await assert.rejects(L.storyJourney(api, 'US-0009999'), /No user story US-0009999/);
    await assert.rejects(L.storyJourney(api, "US-1' OR Name LIKE '%"), /A user story such as/);
  });

  ok('a hotfix - a story based on the production branch - goes straight to production, then back down', async () => {
    const L = require('../src/lifecycle');
    const api = require('./fixtures/life-org').lifeOrg();
    const j = await L.storyJourney(api, 'US-0000104');
    assert.strictEqual(j.hotfix, true);
    assert.deepStrictEqual(j.stages.map(s => [s.env, s.state]), [['hotfix', 'done'], ['prod', 'current']], 'its own lane, not the pipeline\u2019s');
    assert.strictEqual(j.next, null);
    assert.deepStrictEqual(j.backPromotions.map(p => p.name), ['P0005']);
    assert.deepStrictEqual(j.backTo, ['dev1', 'dev2', 'int', 'qa', 'uat'], 'back-promoted to the environments before production - not to the hotfix lane it came from');
    assert.strictEqual(L.isHotfix({ baseBranch: 'int' }, j.pipeline), false);
  });

  ok('what each story changed - from its commit file, its commits\u2019 attachments or its metadata records - and the likely conflicts between them', async () => {
    const L = require('../src/lifecycle');
    const api = require('./fixtures/life-org').lifeOrg();
    const per = await L.storyComponents(api, [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }, { id: 'S4' }]);
    assert.deepStrictEqual(Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.source])), { S1: 'commit file', S2: 'commit attachments', S3: 'metadata records' });
    assert.deepStrictEqual(per.S3.rows, [{ t: 'PermissionSet', n: 'Sales', a: 'Add' }], 'Type.Name becomes the name');
    const f = L.forecast({ 'US-0000101': per.S1.rows, 'US-0000102': per.S2.rows, 'US-0000103': per.S3.rows });
    assert.deepStrictEqual(f.map(x => [x.type + ' ' + x.name, x.stories.join(','), x.severity]),
      [['ApexClass AccountService', 'US-0000101,US-0000102', 'high'], ['PermissionSet Sales', 'US-0000101,US-0000103', 'medium']], 'code first; a retrieve-only row changes nothing');
    assert.deepStrictEqual(L.forecast({ a: [{ t: 'X', n: 'A%20B', a: 'Add' }], b: [{ t: 'X', n: 'A B', a: 'Delete' }] })[0], { type: 'X', name: 'A B', stories: ['a', 'b'], actions: ['Add', 'Delete'], severity: 'high' }, 'encoded names match; a deletion is serious');
  });
  ok('a promotion\u2019s components come from Copado\u2019s change list on it, else from its stories', async () => {
    const L = require('../src/lifecycle');
    const api = require('./fixtures/life-org').lifeOrg();
    const stories = await L.promotionStories(api, 'P3');
    assert.deepStrictEqual(stories.map(s => s.name), ['US-0000101', 'US-0000102']);
    const c = await L.promotionComponents(api, 'P3', stories);
    assert.deepStrictEqual([c.source, c.rows.length], ['promotion change list', 3]);
    const c2 = await L.promotionComponents(api, 'P4', await L.promotionStories(api, 'P4'));
    assert.deepStrictEqual([c2.source, c2.rows.map(r => r.n)], ['the stories\u2019 commits', ['Sales']]);
  });

  ok('the feature branch: the one Copado\u2019s record names, else the pattern - and the repository\u2019s address from its record', async () => {
    const L = require('../src/lifecycle');
    const api = require('./fixtures/life-org').lifeOrg({ uri: 'git@github.com:acme/sales.git' });
    const a = await L.featureBranch(api, { id: 'S1', name: 'US-0000101' }, 'feature/{story}');
    assert.deepStrictEqual(a, { branch: 'feature/US-0000101', pattern: 'feature/{story}', source: 'the story\u2019s copado__Feature_Branch__c' });
    const b = await L.featureBranch(api, { id: 'S2', name: 'US-0000102' }, 'us/{story}');
    assert.deepStrictEqual([b.branch, b.source], ['us/US-0000102', 'the Feature branch setting']);
    const r = await L.repositoryUri(api, 'R1');
    assert.deepStrictEqual([r.name, r.uri, r.field], ['sales-repo', 'git@github.com:acme/sales.git', 'copado__URI__c'], 'not the pull request address beside it');
    assert.strictEqual(await L.pipelineIdFor(api, { toId: 'E0QA' }), 'F1', 'a pipeline found from an environment');
  });

  section('3.0: after Copado deploys, readiness');

  /** Copado's job records: the newer JobExecution tree, or the older Deployment one. */
  function jobOrg(kind) {
    const { createOrg } = require('./fixtures/fake-org');
    const t = (m, s) => '2026-11-12T10:' + String(m).padStart(2, '0') + ':' + String(s || 0).padStart(2, '0') + '.000+0000';
    if (kind === 'new') {
      return createOrg({
        copado__Promotion__c: { fields: ['Name'] },
        copado__JobExecution__c: { fields: ['Name', 'copado__Promotion__c', 'copado__Status__c', 'copado__ErrorMessage__c', 'copado__DataJson__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__Promotion__c: 'copado__Promotion__c' } },
        copado__JobStep__c: { fields: ['Name', 'copado__JobExecution__c', 'copado__Status__c', 'copado__Order__c', 'copado__Type__c', 'copado__ResultDataJson__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__JobExecution__c: 'copado__JobExecution__c' } },
        copado__Result__c: { fields: ['Name', 'copado__JobStep__c', 'copado__Progress_Status__c', 'copado__Status__c', 'copado__Error_Message__c', 'copado__Result_Data__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__JobStep__c: 'copado__JobStep__c' } },
        Attachment: { fields: ['Name', 'ParentId', 'BodyLength', 'CreatedDate'] }
      }, {
        copado__Promotion__c: [{ Id: 'P1', Name: 'P0003' }],
        copado__JobExecution__c: [{ Id: 'J1', Name: 'JE-0001', copado__Promotion__c: 'P1', copado__Status__c: 'Error', copado__ErrorMessage__c: 'Deployment failed', CreatedDate: t(1), LastModifiedDate: t(9) },
          { Id: 'J0', Name: 'JE-0000', copado__Promotion__c: 'P1', copado__Status__c: 'Successful', CreatedDate: t(0), LastModifiedDate: t(0, 30) }],
        copado__JobStep__c: [{ Id: 'S2', Name: 'Deploy', copado__JobExecution__c: 'J1', copado__Status__c: 'Failed', copado__Order__c: 2, copado__Type__c: 'Function', CreatedDate: t(2) },
          { Id: 'S1', Name: 'Prepare', copado__JobExecution__c: 'J1', copado__Status__c: 'Success', copado__Order__c: 1, copado__Type__c: 'Function', CreatedDate: t(3) }],
        copado__Result__c: [{ Id: 'RS', Name: 'R-1', copado__JobStep__c: 'S2', copado__Progress_Status__c: '100%', copado__Status__c: 'Failed', CreatedDate: t(4),
          copado__Result_Data__c: JSON.stringify([{ l: 'INFO', m: 'ApexClass Ignored: not an error', t: '' }, { l: 'ERROR', m: '[ApexClass] AccountService - Variable does not exist: rate (line 12, column 5)', t: '' }]) }],
        Attachment: [{ Id: 'AT9', Name: 'R-1.json', ParentId: 'RS', BodyLength: 10, CreatedDate: t(5) }]
      }, { AT9: JSON.stringify({ details: { componentFailures: [{ componentType: 'PermissionSet', fullName: 'Sales', problem: 'In field: field - no CustomField named Invoice__c.Region__c found', lineNumber: '3' }] } }) });
    }
    return createOrg({
      copado__Promotion__c: { fields: ['Name'] },
      copado__Deployment__c: { fields: ['Name', 'copado__Promotion__c', 'copado__Status__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__Promotion__c: 'copado__Promotion__c' } },
      copado__Step__c: { fields: ['Name', 'copado__Deployment__c', 'copado__Status__c', 'copado__Order__c', 'CreatedDate'], refs: { copado__Deployment__c: 'copado__Deployment__c' } },
      copado__Deployment_Job__c: { fields: ['Name', 'copado__Step__c', 'copado__Status__c', 'copado__Deployed__c', 'CreatedDate'], refs: { copado__Step__c: 'copado__Step__c' } }
    }, {
      copado__Promotion__c: [{ Id: 'P1', Name: 'P0003' }],
      copado__Deployment__c: [{ Id: 'D1', Name: 'Deploy P0003', copado__Promotion__c: 'P1', copado__Status__c: 'In progress', CreatedDate: t(1), LastModifiedDate: t(2) }],
      copado__Step__c: [{ Id: 'ST1', Name: 'Metadata', copado__Deployment__c: 'D1', copado__Status__c: 'In progress', copado__Order__c: 1, CreatedDate: t(1) }],
      copado__Deployment_Job__c: [{ Id: 'DJ1', Name: 'to uat', copado__Step__c: 'ST1', copado__Status__c: 'Pending', copado__Deployed__c: 40, CreatedDate: t(1) }]
    }, {});
  }

  ok('Copado\u2019s deployment, followed read-only: the job records found by describe, newest first, with their steps - either Copado shape', async () => {
    const J = require('../src/jobs');
    const api = jobOrg('new');
    const trees = await J.discover(api);
    assert.deepStrictEqual(trees.map(t => [t.obj, t.link, t.kids.map(k => [k.obj, k.link, k.kids.map(x => x.obj).join()])]),
      [['copado__JobExecution__c', 'copado__Promotion__c', [['copado__JobStep__c', 'copado__JobExecution__c', 'copado__Result__c']]]], 'the links come from what each field references');
    const snap = await J.snapshot(api, 'P1', trees);
    assert.deepStrictEqual(snap.jobs.map(j => [j.name, j.state]), [['JE-0001', 'failed'], ['JE-0000', 'done']]);
    assert.deepStrictEqual(snap.jobs[0].children.map(c => [c.name, c.state]), [['Prepare', 'done'], ['Deploy', 'failed']], 'steps in their order');
    assert.deepStrictEqual(snap.jobs[0].children[1].children.map(r => [r.name, r.progress]), [['R-1', '100%']]);
    assert.deepStrictEqual([snap.running, snap.failed, snap.finished], [false, true, false]);
    assert.ok(api.queries.every(q => /^SELECT /.test(q)), 'only reads');
    const errs = await J.errorsOf(api, snap);
    assert.deepStrictEqual(errs.map(e => [e.type, e.fullName, e.line, e.column]), [['ApexClass', 'AccountService', 12, 5], ['PermissionSet', 'Sales', 3, null]],
      'Copado\u2019s message list and a Metadata API result both become component errors; INFO lines are not errors');
    // the older shape: a deployment still running
    const old = jobOrg('old');
    const snap2 = await J.snapshot(old, 'P1');
    assert.deepStrictEqual([snap2.objects, snap2.running, snap2.jobs[0].children[0].children[0].name], [['copado__Deployment__c'], true, 'to uat']);
    // an org without any of these: nothing to follow, not an error
    const none = require('./fixtures/fake-org').createOrg({ copado__Promotion__c: { fields: ['Name'] } }, {}, {});
    assert.deepStrictEqual((await J.snapshot(none, 'P1')).jobs, []);
  });

  ok('component errors are read from Copado\u2019s text in its usual shapes - and other messages are left alone', () => {
    const J = require('../src/jobs');
    const e = J.componentErrors([
      'ApexClass AccountService: Variable does not exist: rate (line 12, column 5)',
      'Layout Account-Main Layout: Field Rating__c does not exist',
      'Deployment finished with 2 errors',
      JSON.stringify([{ l: 'ERROR', m: 'Flow Lead_Flow - The version of the flow is active' }, { l: 'DEBUG', m: 'Profile Admin: debug only' }]),
      JSON.stringify({ componentFailures: { componentType: 'CustomField', fullName: 'Invoice__c.Region__c', problem: 'Picklist value missing' } })
    ]);
    assert.deepStrictEqual(e.map(x => x.type + ' ' + x.fullName), ['ApexClass AccountService', 'Layout Account-Main Layout', 'Flow Lead_Flow', 'CustomField Invoice__c.Region__c']);
    assert.strictEqual(e[0].problem, 'Variable does not exist: rate (line 12, column 5)');
    assert.deepStrictEqual(J.componentErrors(['ApexClass A: x', 'ApexClass A: x']).length, 1, 'the same error once');
    assert.deepStrictEqual([J.state('Completed Successfully'), J.state('In progress'), J.state('Not started'), J.state('Cancelled'), J.state('')], ['done', 'running', 'running', 'failed', 'unknown']);
  });

  ok('the readiness report of a promotion: a verdict first, then stories, components, validations per stage, coverage and conflicts', () => {
    const R = require('../src/report');
    const base = { name: 'P0003', status: 'Merge Conflict', to: 'uat', at: '2026-11-12T10:00:00Z',
      stories: [{ name: 'US-0000101', title: 'Billing | access', status: 'In Progress', env: 'qa' }, { name: 'US-0000104', title: 'Tax', status: 'In Progress', env: 'qa', hotfix: true }],
      components: [{ t: 'ApexClass', n: 'AccountService', a: 'Add' }, { t: 'ApexClass', n: 'AccountService', a: 'Add' }, { t: 'Layout', n: 'Account-Main', a: 'RetrieveOnly' }, { t: 'Flow', n: 'Old', a: 'Delete' }],
      validations: [{ at: '2026-11-12T09:00:00Z', label: 'promotion branch of P0003', environment: 'uat', username: 'me@example.com.uat', testLevel: 'RunLocalTests', success: false, componentErrors: 1, testFailures: 0,
        coverage: [{ name: 'AccountService', percent: 70 }], coverageRule: 85, belowCoverage: [{ name: 'AccountService', percent: 70 }], branches: ['promotion/P0003'] },
        { at: '2026-11-11T09:00:00Z', label: 'US-0000101', environment: 'uat', success: true, testLevel: 'NoTestRun' }, { at: '2026-11-10T09:00:00Z', label: 'US-0000101', environment: 'qa', success: true, testLevel: 'NoTestRun' }],
      conflicts: [{ promotion: 'P0003', status: 'Merge Conflict', files: 2, open: true }], overlaps: [{ type: 'ApexClass', name: 'AccountService', stories: ['US-0000101', 'US-0000104'], severity: 'high' }], missing: ['US-0000105'] };
    const md = R.readiness(base);
    for (const re of [/^# Readiness: P0003/, /> Promotion \u00b7 Merge Conflict \u00b7 to uat/, /\u274c 1 promotion has unresolved conflicts: P0003 \(2 files\)/,
      /\u274c The latest validation failed/, /Coverage below the stage\u2019s 85% .*AccountService 70%/, /1 component is changed by more than one story \(1 code\)/,
      /No component list for US-0000105/, /\| Billing \\\| access \| qa \| In Progress \|/, /\| US-0000104 \(hotfix\) \|/, /## Components \(2\)/, /Deleted: `Flow Old`/, /\| uat \| 2026-11-12 09:00 \| promotion\/P0003 \|/, /\| qa \| 2026-11-10 09:00 \|/,
      /\| AccountService \| 70% \u274c \|/, /\| P0003 \| Merge Conflict \| 2 \| yes \|/, /### Likely conflicts/]) assert.ok(re.test(md), String(re));
    assert.strictEqual((md.match(/\| uat \|/g) || []).length, 1, 'the newest validation per stage only');
    assert.ok(!/Release readiness|behind the others|held up by/.test(md), 'nothing of the removed release view');
    const clean = R.verdict(Object.assign({}, base, { stories: [], conflicts: [], overlaps: [], missing: [], validations: [{ at: 'x', label: 'P1', environment: 'prod', success: true }] }));
    assert.deepStrictEqual(clean.map(x => x[0]), ['ok', 'ok']);
  });
  section('3.0: end to end through the extension');

  /** A stand-in VS Code with everything release.js and the pages use; answers are queued per kind and matched by text. */
  function fakeCode(root, settings) {
    const log = { info: [], warn: [], error: [], inputs: [], picks: [], opened: [], commands: [], progress: [] };
    const answers = { info: [], warn: [], error: [], input: [], pick: [] };
    const config = Object.assign({}, settings);
    const registered = {};
    const answer = (kind, msg, arg) => {
      const i = answers[kind].findIndex(a => !a.re || a.re.test(msg));
      if (i === -1) return undefined;
      const a = answers[kind].splice(i, 1)[0];
      return typeof a.v === 'function' ? a.v(arg !== undefined ? arg : msg) : a.v;
    };
    class Emitter { constructor() { this.fns = []; this.event = fn => { this.fns.push(fn); return { dispose() {} }; }; } fire(x) { this.fns.forEach(f => f(x)); } dispose() {} }
    const Uri = { file: p => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p }), joinPath: (u, ...x) => Uri.file(path.join(u.fsPath, ...x)), parse: v => ({ scheme: 'untitled', fsPath: v, toString: () => v }) };
    const vs = {
      log, answers, config, registered, Uri, EventEmitter: Emitter,
      TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } }, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: function (id) { this.id = id; }, ThemeColor: function (id) { this.id = id; }, MarkdownString: function (v) { this.value = v; },
      Range: function () {}, Position: function () {}, Selection: function () {}, WorkspaceEdit: function () { this.replace = () => {}; },
      Diagnostic: function (r, m) { this.message = m; }, DiagnosticSeverity: { Error: 0, Warning: 1 }, ProgressLocation: { Notification: 15 },
      ConfigurationTarget: { Global: 1, Workspace: 2 }, TextEditorRevealType: { InCenter: 2 }, FileType: { Directory: 2 }, ViewColumn: { One: 1 },
      RelativePattern: function (b, p) { this.base = b; this.pattern = p; },
      window: {
        createTreeView: () => ({ dispose() {} }), createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
        withProgress: async (o, fn) => { log.progress.push({ title: o.title, location: o.location }); return fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); },
        showInformationMessage: async (m) => { log.info.push(m); return answer('info', m); },
        showWarningMessage: async (m, o) => { log.warn.push(m); if (o && o.detail) (log.details = log.details || []).push(o.detail); return answer('warn', m); },
        showErrorMessage: async (m) => { log.error.push(m); return answer('error', m); },
        showInputBox: async o => { log.inputs.push(o); return answer('input', (o.title || '') + ' ' + (o.prompt || '')); },
        showQuickPick: async (items, o) => { log.picks.push({ items, o }); return answer('pick', (o && (o.title || o.placeHolder)) || '', items); },
        showTextDocument: async u => { log.opened.push(u && u.fsPath ? u.fsPath : u); return {}; }, showOpenDialog: async () => undefined,
        setStatusBarMessage: () => ({ dispose() {} }), activeTextEditor: undefined, visibleTextEditors: []
      },
      workspace: {
        isTrusted: true, workspaceFolders: [{ uri: Uri.file(root) }], textDocuments: [],
        getConfiguration: section => ({ get: (k, d) => { const key = (section ? section + '.' : '') + k; return key in config ? config[key] : d; },
          update: async (k, v) => { config[(section ? section + '.' : '') + k] = v; } }),
        onDidChangeConfiguration: () => ({ dispose() {} }), onDidSaveTextDocument: () => ({ dispose() {} }),
        createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
        asRelativePath: u => path.relative(root, u.fsPath || u).split(path.sep).join('/'), findFiles: async () => [],
        openTextDocument: async u => ({ getText: () => fs.readFileSync(u.fsPath, 'utf8'), positionAt: () => 0, uri: u }),
        applyEdit: async () => true,
        fs: { readFile: async u => fs.readFileSync(u.fsPath), writeFile: async (u, b) => { fs.mkdirSync(path.dirname(u.fsPath), { recursive: true }); fs.writeFileSync(u.fsPath, b); },
          createDirectory: async u => fs.mkdirSync(u.fsPath, { recursive: true }), stat: async u => fs.statSync(u.fsPath), readDirectory: async () => [], delete: async u => rmTree(u.fsPath) }
      },
      languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, delete() {}, dispose() {} }) },
      commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; }, executeCommand: async (...a) => { log.commands.push(a); } },
      env: { clipboard: { writeText: async t => { log.clipboard = t; } } }
    };
    return vs;
  }

  function loadWith(vs, modules) {
    const Module = require('module'); const load = Module._load;
    Module._load = function (req) { return req === 'vscode' ? vs : load.apply(this, arguments); };
    try {
      for (const m of modules) delete require.cache[require.resolve(m)];
      return modules.map(m => require(m));
    } finally { Module._load = load; }
  }

  ok('a promotion branch, end to end: the address from Copado and only a token, the stage\u2019s rules from the project, validated as the stage\u2019s login, recorded, re-validated, fixed in its own workspace', async () => {
    const sfcli = require('../src/sfcli');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra e2e '));
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cra e2e tools '));
    const g = await h.fakeGitHosts({ branches: ['promotion/P0003', 'feature/US-0000101'], files: {
      'force-app/main/default/classes/AccountService.cls': 'public class AccountService {}', 'force-app/main/default/classes/AccountService.cls-meta.xml': '<ApexClass/>',
      'force-app/main/default/classes/AccountServiceTest.cls': '@isTest class AccountServiceTest {}', 'force-app/main/default/classes/AccountServiceTest.cls-meta.xml': '<ApexClass/>',
      'force-app/main/default/permissionsets/Sales.permissionset-meta.xml': '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>Sales</label></PermissionSet>' } });
    try {
      fs.writeFileSync(path.join(root, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"62.0"}');
      const policy = rule => fs.writeFileSync(path.join(root, 'copado-policy.json'), JSON.stringify({ environments: { UAT: rule } }));
      policy({ minimumTestLevel: 'RunLocalTests', requiredTargetUser: 'me@example.com.*' });
      const api = require('./fixtures/life-org').lifeOrg({ uri: g.base + '/owner/repo' });
      const vs = fakeCode(root, { 'cmr.sf.path': h.fakeSf(tools), 'cmr.copado.org': 'copado', 'cmr.repo.provider': 'github', 'cmr.org.confirm': false,
        'cmr.copado.environmentOrgs': { uat: 'qa' }, 'cmr.validate.revealOutput': false });
      const [release] = loadWith(vs, ['../release', '../promotionUi', '../lifecycleUi', '../releasePage']);
      const out = [];
      const secrets = new Map(), state = new Map();
      const storageDir = async sub => { const d = path.join(root, '.copado', sub || ''); fs.mkdirSync(d, { recursive: true }); return vs.Uri.file(d); };
      release.activate({ subscriptions: { push() {} }, secrets: { get: async k => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async k => secrets.delete(k) },
        workspaceState: { get: (k, d) => state.has(k) ? state.get(k) : d, update: async (k, v) => state.set(k, v) }, extensionUri: vs.Uri.file(root) }, {
        output: { appendLine: l => out.push(l), show() {}, clear() {} }, storageDir, resolveProject: () => ({ root }), writeTemp: async (n, t) => { const f = path.join(root, '.copado', 'tmp', n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return vs.Uri.file(f); },
        startSession: async () => {}, promoMerge: async () => ({ ok: false }), copadoApi: () => api });
      const hp = release.helpers;
      // the repository is not connected: its address comes from Copado's Git Repository record; only a token is asked for
      vs.answers.info.push({ re: /^Connect .*owner\/repo - the address is from Copado/, v: 'Connect Repository' });
      vs.answers.input.push({ re: /^Token for repo/, v: 'gh-token' });
      // tests: the package's test class is offered and picked; no others
      vs.answers.pick.push({ re: /which test classes/, v: items => items.filter(i => i.picked) });
      vs.answers.input.push({ re: /other test classes/, v: '' });
      await hp.validatePromotionBranch({ id: 'P3', name: 'P0003', to: 'uat', toId: 'E0UAT', from: 'qa', fromId: 'E0QA' });
      assert.strictEqual(vs.log.inputs.filter(i => i.password).length, 1, 'only the token was asked for');
      assert.ok(!vs.log.inputs.some(i => /address/.test(i.prompt || '')), 'never the address');
      assert.strictEqual(vs.config['cmr.repo.url'], g.base + '/owner/repo');
      assert.strictEqual(secrets.get('cmr.repoToken:' + new URL(g.base).host), 'gh-token', 'the token in secret storage');
      const text = out.join('\n');
      assert.ok(/policy: the uat stage rules from copado-policy\.json apply - validate as me@example\.com\.\* - tests at least RunLocalTests/.test(text), 'the project\u2019s policy applies to a branch check');
      assert.ok(/tests raised from RunSpecifiedTests to RunLocalTests/.test(text));
      assert.ok(/validating as me@example\.com\.qa - Copado environment uat - from promotion\/P0003/.test(text), text);
      assert.ok(/project deploy validate --test-level RunLocalTests --target-org qa/.test(text), 'check-only, at the stage\u2019s level');
      const v = release.state.validation;
      assert.ok(v.pkg && v.pkg.workspace && /branch-check/.test(v.pkg.workspace), 'the validation keeps its own package');
      assert.deepStrictEqual([v.params.environment, v.params.username, v.failures.length], ['uat', 'me@example.com.qa', 1]);
      assert.deepStrictEqual(hp.validationStatus() && [hp.validationStatus().running, hp.validationStatus().success, hp.validationStatus().username], [false, false, 'me@example.com.qa'], 'what the page shows');
      const hist = () => JSON.parse(fs.readFileSync(path.join(root, '.copado', 'history', 'validations.json'), 'utf8'));
      assert.deepStrictEqual([hist().length, hist()[0].promotion, hist()[0].stories, hist()[0].environment, hist()[0].success, hist()[0].branches], [1, 'P0003', ['US-0000101', 'US-0000102'], 'uat', false, ['promotion/P0003']]);
      const wsDir = v.pkg.workspace;
      assert.ok(fs.existsSync(path.join(wsDir, 'force-app/main/default/classes/AccountService.cls')) && fs.existsSync(path.join(wsDir, '.forceignore')));
      assert.ok(!fs.existsSync(path.join(root, 'force-app')) && !fs.existsSync(path.join(root, 'manifest')), 'the project is never touched');
      // re-validate repeats this validation - its package, its workspace, its stage
      await vs.registered['cmr.validate.rerun']();
      assert.strictEqual(hist().length, 2);
      assert.strictEqual(release.state.validation.pkg.workspace, wsDir);
      // a package fix goes into the check workspace's manifest, never the project's
      const fix = release.state.validation.failures[0].suggestions.find(x => x.kind === 'package');
      assert.ok(fix, 'the missing field is offered');
      const before = fs.readFileSync(path.join(wsDir, 'manifest', 'package.xml'), 'utf8');
      await vs.registered['cmr.validate.applyFix']({ fix, failure: release.state.validation.failures[0] });
      assert.ok(vs.log.info.some(m => /to the user story in Copado and commit it/.test(m)), 'from a branch, the component has to be committed to the story');
      assert.strictEqual(fs.readFileSync(path.join(wsDir, 'manifest', 'package.xml'), 'utf8'), before, 'the check workspace is left as the branch made it');
      assert.ok(!fs.existsSync(path.join(root, 'manifest')), 'and nothing is written into the project');
      // the wrong login for the stage: blocked before the CLI runs
      policy({ requiredTargetUser: 'release@*' });
      await hp.validatePromotionBranch({ id: 'P3', name: 'P0003', to: 'uat', toId: 'E0UAT', from: 'qa', fromId: 'E0QA' });
      assert.ok(vs.log.error.some(m => /Validation blocked: the uat stage must be validated as release@\* - qa logs in as me@example\.com\.qa/.test(m)), vs.log.error.join(' | '));
      assert.strictEqual(hist().length, 2, 'nothing ran');
      // a promotion Copado has not merged yet: no promotion branch, said plainly
      fs.unlinkSync(path.join(root, 'copado-policy.json'));
      await assert.rejects(hp.validatePromotionBranch({ id: 'P4', name: 'P0004', to: 'int', toId: 'E0INT', from: 'dev2', fromId: 'E0D2' }), /promotion\/P0004 is not in the repository yet - Copado creates it when the promotion merges/);
      // a story from its feature branch, named by Copado's record, against the next stage
      vs.answers.pick.push({ re: /which test classes/, v: items => items });
      vs.answers.input.push({ re: /other test classes/, v: '' });
      await hp.validateFromBranch('US-0000101');
      assert.ok(/US-0000101 - its branch is feature\/US-0000101, from the story\u2019s copado__Feature_Branch__c/.test(out.join('\n')));
      assert.deepStrictEqual([hist().length, hist()[2].source, hist()[2].environment], [3, 'feature branch', 'uat']);
    } finally {
      g.server.close(); sfcli.resetRest();
      rmTree(root); rmTree(tools);
    }
  });

  section('3.0: the page');

  /** Runs media/page.js against a minimal DOM: what it draws, what it sends, and a way to click. */
  function runPage() {
    const vm = require('vm');
    const posted = [];
    let html = '', click = null, onMessage = null, saved = null;
    const app = { set innerHTML(v) { html = v; }, get innerHTML() { return html; }, addEventListener: (t, fn) => { if (t === 'click') click = fn; } };
    const sandbox = {
      acquireVsCodeApi: () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: x => { saved = x; } }),
      document: { getElementById: id => id === 'app' ? app : null, body: { dataset: { logo: 'logo.png' } }, activeElement: null, addEventListener() {} },
      window: { addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; } },
      setTimeout: (fn) => fn(), Date, JSON, Object, Array, String, Number, Math, Set, Map, RegExp, parseFloat
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'page.js'), 'utf8'), sandbox);
    const page = {
      posted, get html() { return html; }, get cls() { return app.className || ''; },
      state: data => onMessage({ data: { type: 'state', data } }),
      message: m => onMessage({ data: m }),
      click: dataset => click({ target: { closest: () => ({ dataset }) }, preventDefault() {} }),
      text: () => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;|&rsquo;/g, '\u2019').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
    };
    return page;
  }

  /** The lifecycle side, real, over the pipeline org - its snapshots are what the page draws. */
  async function lifeSide(extra) {
    const vs = fakeCode(os.tmpdir(), {});
    const [life] = loadWith(vs, ['../lifecycleUi']);
    const api = require('./fixtures/life-org').lifeOrg();
    const calls = [];
    life.activate({ subscriptions: { push() {} }, workspaceState: { get: () => null, update: async () => {} } }, Object.assign({
      rc: () => ({ copadoOrg: 'copado' }), requireTrust() {}, deps: { resolveProject: () => ({ root: os.tmpdir() }) }, copadoApi: () => api, apiVersion: async () => '62.0',
      validateFromBranch: async n => calls.push(['validate', n])
    }, extra || {}));
    return { life, calls, api, vs };
  }

  ok('the page\u2019s story journey - and opening a promotion from it', async () => {
    const { life, calls, vs } = await lifeSide();
    const page = runPage();
    const base = { copadoOrg: 'copado', recent: [], current: null, validation: null };
    await life.act('story.open', { ref: 'US-0000101' });
    assert.ok(vs.log.progress.some(p => p.title === 'Looking up where US-0000101 is' && p.location === 15), 'a notification at the bottom while the journey is read');
    page.state(Object.assign({}, base, { life: life.snapshot() }));
    page.click({ nav: 'Stories' });
    const t = page.text();
    assert.ok(/dev1 passed .*int passed .*P0001 .*qa here now .*P0002 .*uat next .*P0003 Merge Conflict .*prod later/.test(t), t);
    assert.ok(t.includes('Next: uat') && t.includes('Validate from the branch'));
    page.click({ l: 'story.validate' });
    await life.act(page.posted.pop().name, {});
    assert.deepStrictEqual(calls.pop(), ['validate', 'US-0000101']);
    page.click({ l: 'promotion.open', id: 'P3' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', scope: 'life', name: 'promotion.open', payload: { id: 'P3' } });
    page.message({ type: 'nav', nav: 'Promotions' });
    assert.ok(page.html.includes('class="nav on" data-nav="Promotions"'), 'the page switches to the promotion');
    // the hotfix
    await life.act('story.open', { ref: 'US-0000104' });
    page.click({ nav: 'Stories' });
    page.state(Object.assign({}, base, { life: life.snapshot() }));
    assert.ok(/US-0000104 .*hotfix/.test(page.text()) && /back-promoted to .*dev1/.test(page.text()));
    // a story that is not there
    await life.act('story.open', { ref: 'US-0009999' });
    page.state(Object.assign({}, base, { life: life.snapshot() }));
    assert.ok(page.text().includes('No user story US-0009999'));
    assert.ok(page.posted.every(m => !/^(pipeline|release|drift|forecast)/.test(m.name || '')), 'nothing of the removed views is ever asked for');
    assert.ok(!/data-nav="(Pipeline|Releases)"/.test(page.html) && /data-nav="Promotions"/.test(page.html) && /data-nav="Stories"/.test(page.html), 'two tabs: Promotions and Stories');
  });

  ok('the page\u2019s promotion without conflicts: validate the promotion branch as the stage\u2019s login, then follow Copado\u2019s deployment', () => {
    const page = runPage();
    const cur = { promotion: { id: 'P1', name: 'P0007', status: 'Ready to deploy', from: 'qa', to: 'uat' },
      state: { name: 'P0007', from: 'qa', to: 'uat', files: {}, events: [], syncedAt: new Date().toISOString() }, plan: { ready: [], held: [], last: false }, canUndo: false,
      info: { back: false, production: false, sides: { ours: 'Promotion branch', theirs: 'Feature' }, login: { alias: 'uatAlias', username: 'me@example.com.uat' }, promotionBranch: 'promotion/P0007' }, jobs: null };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: { running: false, label: 'promotion branch of P0007', target: 'uatAlias', username: 'me@example.com.uat', environment: 'uat', at: new Date().toISOString(), success: true } });
    const t = page.text();
    assert.ok(/No conflicts on P0007/.test(t) && /What Copado will deploy \u2013 promotion\/P0007 \u2013 validated against uat\. Nothing is deployed\./.test(t) && /title="Checked as me@example\.com\.uat"/.test(page.html), t);
    assert.ok(/uat as uatAlias \(me@example\.com\.uat\)/.test(t), 'the login in the header');
    assert.ok(/Validate branch validated/.test(t) && /Validated successfully \u00b7 Promotion branch of P0007 \u00b7 uat \u00b7/.test(t), 'the latest validation shown, in plain words');
    assert.ok(/title="Checked against uatAlias as me@example\.com\.uat \u2013 nothing was deployed"/.test(page.html), 'who it ran as, in the tooltip');
    page.click({ a: 'validateBranch' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'validateBranch', payload: { rel: null } });
    page.message({ type: 'busy', on: true });
    assert.ok(!/class="busy"/.test(page.html) && page.cls === 'is-busy', 'no loading line on top - VS Code\u2019s notification at the bottom shows the progress; the page only shows a busy cursor');
    page.message({ type: 'busy', on: false });
    assert.strictEqual(page.cls, '');
    assert.ok(/<ol class="track">/.test(page.html) && (page.html.match(/class="step done"/g) || []).length === 2 && /class="step now"/.test(page.html), 'the stages as a track: two passed, one current');
    page.click({ tab: 'Deployment' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'jobs', payload: {} }, 'Copado\u2019s deployment read when the tab opens');
    cur.jobs = { at: new Date().toISOString(), watching: true, error: null, objects: ['copado__JobExecution__c'], running: true, failed: true, finished: false, mapped: null,
      errors: [{ type: 'ApexClass', fullName: 'AccountService', problem: 'Variable does not exist: rate', line: 12 }],
      jobs: [{ id: 'J1', name: 'JE-0001', kind: 'Job', status: 'In progress', state: 'running', progress: 40, error: '', type: '', created: '', modified: '', children: [{ id: 'S1', name: 'Deploy', kind: 'Step', status: 'Failed', state: 'failed', progress: null, error: 'boom', type: 'Function', children: [] }] }] };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    const d = page.text();
    assert.ok(/Updating live/.test(d) && /Updated \d/.test(d) && !/read-only|checked \d/.test(d) && /JE-0001 Job In progress/.test(d) && /Deploy Step \u00b7 Function Failed/.test(d) && d.includes('boom'), d);
    assert.ok(/Show 1 error in Deploy Check/.test(d) && /ApexClass AccountService line 12 Variable does not exist: rate/.test(d));
    assert.ok(page.html.includes('style="width:40%"'), 'progress as a bar');
    page.click({ a: 'jobErrors' });
    assert.strictEqual(page.posted.pop().name, 'jobErrors');
  });

  ok('the page\u2019s back-promotion: both sides named for what they are', () => {
    const page = runPage();
    const rel = 'force-app/main/default/permissionsets/Ops.permissionset-meta.xml';
    const cur = { promotion: { id: 'P5', name: 'P0005', status: 'Merge Conflict', from: 'prod', to: 'uat' },
      state: { name: 'P0005', from: 'prod', to: 'uat', syncedAt: new Date().toISOString(), events: [], files: { [rel]: { state: 'review', kind: 'xml', story: 'US-0000104', note: '1 real conflict to review', labels: { ours: 'HEAD', theirs: 'main' },
        clashes: [{ line: 3, tag: 'description', target: 'uat text', incoming: 'prod text' }] } } }, plan: { ready: [], held: [], last: false }, canUndo: false,
      info: { back: true, sides: { ours: 'Promotion branch', theirs: 'Back-promoted from prod' }, login: null }, jobs: null };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    const t = page.text();
    assert.ok(/class="row sel" data-sel="force-app\/main\/default\/permissionsets\/Ops\.permissionset-meta\.xml"/.test(page.html), 'the file shown on the right is highlighted in the list from the start');
    assert.ok(t.includes('Back-promotion') && t.includes('Back-promoted from prod (main)') && t.includes('Target branch (HEAD)') && !/back-promoted from prod\u2019s/i.test(t) && !/Feature \(/.test(t), t);
    assert.ok(t.includes('no login for uat'));
  });

  ok('the Promotions tab over a pipeline: a back-promotion pre-checked from the source environment\u2019s branch, the branch validated, a promotion without conflicts opened', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra back '));
    const conflict = 'public class Tax {\n<<<<<<< HEAD\n  Decimal r = 0.1;\n=======\n  Decimal r = 0.2;\n>>>>>>> main\n}\n';
    const t = '2026-11-12T10:00:00.000+0000';
    const api = require('./fixtures/life-org').lifeOrg({ moreSchema: {
      copado__Deployment__c: { fields: ['Name', 'copado__Promotion__c', 'copado__Status__c', 'CreatedDate', 'LastModifiedDate'], refs: { copado__Promotion__c: 'copado__Promotion__c' } } },
      more: { copado__Deployment__c: [{ Id: 'DP4', Name: 'Deploy P0004', copado__Promotion__c: 'P4', copado__Status__c: 'In progress', CreatedDate: t, LastModifiedDate: t }], Attachment: [{ Id: 'AX1', Name: 'US-0000104 force-app/main/default/classes/Tax.cls', ParentId: 'P5', BodyLength: conflict.length,
      CreatedDate: '2026-11-08T11:00:00.000+0000', LastModifiedDate: '2026-11-08T11:00:00.000+0000' }] }, moreFiles: { AX1: conflict } });
    const vs = fakeCode(root, {});
    let saveHook = null;
    vs.workspace.onDidSaveTextDocument = fn => { saveHook = fn; return { dispose() {} }; };
    const [ui] = loadWith(vs, ['../promotionUi']);
    const calls = {};
    ui.activate({ subscriptions: { push() {} }, workspaceState: { get: (k, d) => d, update: async () => {} } }, {
      output: { appendLine() {} }, rc: () => ({ copadoOrg: 'copado', sfPath: 'sf', environmentOrgs: { uat: 'uatAlias' } }), cmd: (id, fn) => { vs.registered[id] = fn; },
      requireTrust() {}, projectRoot: () => root, apiVersion: async () => '62.0', copadoApi: () => api,
      deps: { storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), promoMerge: async () => ({ ok: false }), startSession: async () => {} },
      orgList: async () => [], credentialsFor: async () => [], orgForEnvironment: async (c, r, id, name) => name + 'Alias',
      runBranchCheck: async o => { calls.branch = o; }, validatePromotionBranch: async o => { calls.promoBranch = o; }, onValidation: () => ({ dispose() {} }), validationStatus: () => null,
      showCopadoErrors: async f => f, readinessReport: async o => { calls.readiness = o; }, sfcli: { openPath: async () => {} }
    });
    try {
      vs.answers.input.push({ v: 'P0005' });
      await vs.registered['cmr.promotion.open']();
      let snap = await ui.snapshot();
      const info = snap.current.info;
      assert.deepStrictEqual([info.back, info.sides.theirs, info.sourceBranch, info.destinationBranch, info.pipeline, info.promotionBranch], [true, 'Back-promoted from prod', 'main', 'uat', 'Sales pipeline', 'promotion/P0005']);
      assert.deepStrictEqual([info.login.alias, info.login.how], ['uatAlias', 'setting'], 'the destination\u2019s login, from the remembered one');
      // the code file, resolved in the editor and saved
      const file = path.join(root, '.copado', 'promotions', 'P0005', 'resolved', 'force-app', 'main', 'default', 'classes', 'Tax.cls');
      fs.writeFileSync(file, 'public class Tax {\n  Decimal r = 0.2;\n}\n');
      saveHook({ uri: vs.Uri.file(file), getText: () => fs.readFileSync(file, 'utf8') });
      await ui.act('precheck', {});
      assert.ok(vs.log.progress.some(p => p.title === 'Getting ready for the pre-check of P0005' && p.location === 15), 'a notification at the bottom while the pre-check reads');
      assert.deepStrictEqual([calls.branch.branches, calls.branch.environment, calls.branch.meta.source, calls.branch.target], [['main'], 'uat', 'pre-check', 'uatAlias'],
        'a back-promotion\u2019s side is the source environment\u2019s branch, not a feature branch');
      // the promotion branch, with a file not yet uploaded: asked first
      vs.answers.warn.push({ re: /still has 1 conflict file/, v: 'Validate the branch anyway' });
      await ui.act('validateBranch', {});
      assert.deepStrictEqual([calls.promoBranch.name, calls.promoBranch.toId, calls.promoBranch.pipelineId], ['P0005', 'E0UAT', 'F1']);
      // the readiness report and the deployment
      await ui.act('readiness', {});
      assert.strictEqual(calls.readiness.promotion.name, 'P0005');
      const before = vs.log.progress.length;
      await ui.act('jobs', {});
      assert.ok(vs.log.progress.slice(before).some(p => p.title === 'Checking how P0005 is going in Copado'), 'Check now shows a notification');
      snap = await ui.snapshot();
      assert.deepStrictEqual([snap.current.jobs.jobs, snap.current.jobs.error, snap.current.jobs.watching], [[], null, false], 'an org without job records: nothing to follow, not an error');
      // a promotion with no conflicts at all opens too
      calls.promoBranch = null;
      vs.answers.input.push({ v: 'P0004' });
      await ui.act('home', {});
      await ui.act('open', { ref: 'P0004' });
      snap = await ui.snapshot();
      assert.deepStrictEqual([snap.current.state.name, Object.keys(snap.current.state.files).length, snap.current.info.back], ['P0004', 0, false]);
      assert.ok(vs.log.info.some(m => /P0004 \(In Progress\) has no conflicts/.test(m)), vs.log.info.join(' | '));
      await ui.act('validateBranch', {});
      assert.strictEqual(calls.promoBranch.name, 'P0004', 'no question when nothing is open');
      // Copado is deploying P0004: Check now shows a notification; the polling that follows stays quiet
      const timers = [];
      const realTimeout = global.setTimeout;
      global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 0; };
      try {
        const n0 = vs.log.progress.length;
        await ui.act('jobs', {});
        assert.strictEqual(vs.log.progress.length, n0 + 1, 'one notification for the asked-for check');
        assert.ok((await ui.snapshot()).current.jobs.watching && timers.length === 1 && timers[0].ms === 15000, 'still running: read again in 15 seconds');
        await timers[0].fn();
        assert.strictEqual(vs.log.progress.length, n0 + 1, 'the polling shows no notification');
        assert.strictEqual(timers.length, 2, 'and keeps following while the job runs');
      } finally { global.setTimeout = realTimeout; }
      assert.ok(api.queries.every(q => /^SELECT /.test(q)), 'Copado is only read');
    } finally { await ui.act('stopWatch', {}); rmTree(root); }
  });

  ok('the readiness report and Copado\u2019s own errors, end to end through the extension', async () => {
    const sfcli = require('../src/sfcli');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra e2e2 '));
    try {
      fs.writeFileSync(path.join(root, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"62.0"}');
      const api = require('./fixtures/life-org').lifeOrg();
      const vs = fakeCode(root, { 'cmr.copado.org': 'copado' });
      const [release] = loadWith(vs, ['../release', '../promotionUi', '../lifecycleUi', '../releasePage']);
      release.activate({ subscriptions: { push() {} }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
        workspaceState: { get: (k, d) => d, update: async () => {} }, extensionUri: vs.Uri.file(root) }, {
        output: { appendLine() {}, show() {}, clear() {} }, resolveProject: () => ({ root }), startSession: async () => {}, promoMerge: async () => ({ ok: false }), copadoApi: () => api,
        storageDir: async sub => { const d = path.join(root, '.copado', sub || ''); fs.mkdirSync(d, { recursive: true }); return vs.Uri.file(d); },
        writeTemp: async (n, t) => { const f = path.join(root, '.copado', 'tmp', n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return vs.Uri.file(f); } });
      const hp = release.helpers;
      assert.ok(!hp.runDrift && !hp.openDriftFile, 'drift is gone');
      // the readiness report of a promotion, written under .copado/reports and opened
      const r = await hp.readinessReport({ promotion: { id: 'P3', name: 'P0003', status: 'Merge Conflict', to: 'uat' } });
      const md = fs.readFileSync(r.file, 'utf8');
      assert.ok(/^# Readiness: P0003/.test(md) && /\| US-0000101 \| Billing access \| qa \| In Progress \|/.test(md) && /## Components \(3\)/.test(md) && /ApexClass AccountService \(code\) \| US-0000101, US-0000102/.test(md), md);
      assert.ok(vs.log.opened.includes(r.file) && /\.copado[\\/]reports[\\/]readiness-P0003-/.test(r.file));
      // Copado's own deployment errors: in Deploy Check with the fix advice, and re-validate says why it cannot repeat them
      const mapped = await hp.showCopadoErrors([{ type: 'PermissionSet', fullName: 'Sales', problem: 'In field: field - no CustomField named Invoice__c.Region__c found', line: 3 }], { label: 'Copado\u2019s deployment of P0003', environment: 'uat' });
      assert.ok(mapped[0].fixes.some(f => /Add CustomField Invoice__c\.Region__c/.test(f)));
      assert.strictEqual(release.state.validation.params.mode, 'copado');
      await vs.registered['cmr.validate.rerun']();
      assert.ok(vs.log.info.some(m => /came from Copado\u2019s deployment of P0003/.test(m)));
    } finally {
      sfcli.resetRest();
      rmTree(root);
    }
  });

  section('3.0.3: after a failed validation');

  const libs = () => ({ X: require('../src/xmlParser'), duplicates: require('../src/duplicates'), rules: require('../src/rules') });

  ok('the upload gate: XML must be well-formed the way Salesforce reads it - also an XML file that was merged as text', async () => {
    const W = require('../src/promotionWork');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra gate '));
    try {
      const s = W.store(dir);
      const rel = 'force-app/main/default/permissionsets/Ops.permissionset-meta.xml';
      const check = (text, entry) => { s.write('resolved', rel, text); return W.gates(s, rel, entry || { kind: 'xml', state: 'auto' }, libs()); };
      const ps = inner => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + inner;
      assert.ok(/Element <PermissionSet> is never closed \(line 2\)/.test(check(ps('    <label>Ops</label>\n')).reason), 'the root never closed - what Copado reported');
      assert.ok(/Unexpected closing tag <\/fieldPermissions>/.test(check(ps('    <label>Ops</label>\n    </fieldPermissions>\n</PermissionSet>\n')).reason));
      assert.ok(/text after <\/PermissionSet> \(line 6\)/.test(check(ps('    <label>Ops</label>\n</PermissionSet>\n\n        Account.X__c\n')).reason), 'text after the root');
      assert.ok(/a second root element <fieldPermissions> \(line 6\)/.test(check(ps('    <label>Ops</label>\n</PermissionSet>\n\n<fieldPermissions><field>Account.X__c</field></fieldPermissions>\n')).reason), 'an element after the root');
      assert.ok(/a second root element/.test(check(ps('</PermissionSet>\n<PermissionSet></PermissionSet>\n')).reason));
      assert.strictEqual(check(ps('    <label>Ops</label>\n</PermissionSet>\n<!-- kept -->\n')).ok, true, 'a comment after the root is fine');
      // merged as text because a side was not valid XML: still XML to Salesforce, still checked
      assert.ok(/never closed/.test(check(ps('    <label>Ops</label>\n'), { kind: 'code', state: 'auto' }).reason), 'decided by the file, not by how it was merged');
      assert.strictEqual(W.gates(s, 'force-app/main/default/classes/A.cls', { kind: 'code' }, libs()).ok, false, 'no file, no upload');
      s.write('resolved', 'force-app/main/default/classes/A.cls', 'public class A {');
      assert.strictEqual(W.gates(s, 'force-app/main/default/classes/A.cls', { kind: 'code' }, libs()).ok, true, 'Apex is not XML');
      // the automatic pass: sides that are not valid XML fall back to text - and the gate holds the result back
      const conflicted = ps('<<<<<<< HEAD\n    <label>Ops</label>\n</PermissionSet>\n=======\n    <label>Ops 2</label>\n>>>>>>> feature\n');
      const r = await W.autoResolve(rel, conflicted, async () => ({ ok: false, error: 'not valid XML' }));
      assert.strictEqual(r.kind, 'code', 'merged as text');
      s.write('resolved', rel, r.merged.replace(/<<<<<<<[^\n]*\n|=======\n|>>>>>>>[^\n]*\n/g, '').replace('</PermissionSet>\n', ''));
      assert.ok(!W.gates(s, rel, { kind: r.kind, state: 'auto' }, libs()).ok, 'the old gate would have let this through to Copado');
    } finally { rmTree(dir); }
  });

  ok('resolutions already in Copado that are not well-formed are found - Copado would fail on them', () => {
    const W = require('../src/promotionWork');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra health '));
    try {
      const s = W.store(dir);
      const a = 'force-app/main/default/permissionsets/A.permissionset-meta.xml', b = 'force-app/main/default/permissionsets/B.permissionset-meta.xml';
      s.write('uploaded', a, '<PermissionSet><label>A</label>');
      s.write('resolved', b, '<PermissionSet><label>B</label></PermissionSet>');
      const st = { files: { [a]: { state: 'uploaded', kind: 'xml' }, [b]: { state: 'uploaded', kind: 'xml' }, 'force-app/main/default/classes/C.cls': { state: 'uploaded', kind: 'code' } } };
      assert.deepStrictEqual(W.uploadedHealth(s, st, libs()), [{ rel: a, reason: 'not valid XML: Element <PermissionSet> is never closed (line 1)' }]);
    } finally { rmTree(dir); }
  });

  ok('Copado\u2019s job watch finds the validation under its deployment, shows each record once, newest first - and only the newest run\u2019s errors count', async () => {
    const J = require('../src/jobs');
    const api = require('./fixtures/failed-org').failedOrg();
    const trees = await J.discover(api);
    const dep = trees.find(t => t.obj === 'copado__Deployment__c');
    assert.deepStrictEqual(dep.kids.map(k => [k.obj, k.link]), [['copado__JobExecution__c', 'copado__Deployment__c']], 'the job execution under the deployment, found by what its field references');
    const snap = await J.snapshot(api, 'P42', trees);
    assert.deepStrictEqual(snap.jobs.map(j => j.name), ['DEP-0042', 'JE-0200', 'JE-0100'], 'newest first; JE-0300 is shown once, under its deployment');
    assert.deepStrictEqual(snap.jobs[0].children.map(c => c.name), ['JE-0300']);
    const errs = await J.errorsOf(api, snap);
    assert.deepStrictEqual(errs.map(e => e.type + ' ' + e.fullName), ['PermissionSet Ops_Manager', 'PermissionSet Ops_Rep'], 'Copado\u2019s "Type:Name:problem" lines, from the Error Details file; the earlier run\u2019s error is history');
    assert.ok(/must be terminated by the matching end-tag/.test(errs[0].problem));
    // was it validated since the box was ticked? a merge job succeeding is not a validation
    const before = '2026-11-10T19:30:00.000Z';
    assert.deepStrictEqual(J.validationSince(snap, before).state, 'failed', 'the deployment after the tick failed');
    assert.deepStrictEqual(J.validationSince(snap, '2026-11-10T21:30:00.000Z').state, 'none', 'nothing after that');
    api.data.copado__JobExecution__c.push({ Id: 'JE400', Name: 'JE-0400', copado__Promotion__c: 'P42', copado__Status__c: 'Successful', CreatedDate: '2026-11-11T08:00:00.000+0000' });
    let s2 = await J.snapshot(api, 'P42', trees);
    assert.strictEqual(J.validationSince(s2, '2026-11-10T21:30:00.000Z').state, 'none', 'a merge job alone does not count');
    api.data.copado__Deployment__c.push({ Id: 'DEP43', Name: 'DEP-0043', copado__Promotion__c: 'P42', copado__Status__c: 'Completed Successfully', CreatedDate: '2026-11-11T09:00:00.000+0000' });
    s2 = await J.snapshot(api, 'P42', trees);
    assert.strictEqual(J.validationSince(s2, '2026-11-10T21:30:00.000Z').state, 'done');
  });

  ok('Re-create promotion branch: found by its label or its name, ticked and read back', async () => {
    const P = require('../src/promotion');
    const { failedOrg } = require('./fixtures/failed-org');
    assert.deepStrictEqual(await P.recreateBranchField(failedOrg()), { field: 'copado__Recreate_Promotion_Branch__c', label: 'Re-create Promotion Branch' });
    assert.deepStrictEqual((await P.recreateBranchField(failedOrg({ recreateField: 'copado__Rebuild_Branch_Flag__c', recreateLabel: 'Rebuild branch' }))).field, 'copado__Rebuild_Branch_Flag__c', 'another Copado version\u2019s name');
    assert.strictEqual(await P.recreateBranchField(failedOrg({ recreateField: null })), null, 'none here');
    assert.strictEqual((await P.recreateBranchField(failedOrg({ recreateField: 'copado__Odd__c', recreateLabel: 'Odd' }), 'copado__Odd__c')).field, 'copado__Odd__c', 'the setting names it');
    const api = failedOrg();
    assert.deepStrictEqual(await P.setPromotionFlag(api, 'P42', 'copado__Recreate_Promotion_Branch__c', true), { from: false, to: true });
    assert.strictEqual(await P.promotionFlag(api, 'P42', 'copado__Recreate_Promotion_Branch__c'), true);
    assert.deepStrictEqual(await P.setPromotionFlag(api, 'P42', 'copado__Recreate_Promotion_Branch__c', true), { from: true, to: true, unchanged: true }, 'nothing written when it already is');
    assert.strictEqual(api.writes.length, 1);
    await assert.rejects(P.setPromotionFlag(api, 'P42', "x' OR Id != '", true), /not a field name/);
  });

  ok('after a failed validation, end to end: the error points at the resolution, Edit again, upload replaces it, the box is ticked - and unticked once Copado validates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra again '));
    const api = require('./fixtures/failed-org').failedOrg();
    const vs = fakeCode(root, {});
    const [ui] = loadWith(vs, ['../promotionUi']);
    ui.activate({ subscriptions: { push() {} }, workspaceState: { get: (k, d) => d, update: async () => {} } }, {
      output: { appendLine() {} }, rc: () => ({ copadoOrg: 'copado', sfPath: 'sf', environmentOrgs: {} }), cmd: (id, fn) => { vs.registered[id] = fn; },
      requireTrust() {}, projectRoot: () => root, apiVersion: async () => '62.0', copadoApi: () => api,
      deps: { storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), promoMerge: async () => ({ ok: false }), startSession: async () => {} },
      orgList: async () => [], credentialsFor: async () => [], orgForEnvironment: async () => null, runBranchCheck: async () => {}, validatePromotionBranch: async () => {},
      onValidation: () => ({ dispose() {} }), validationStatus: () => null, showCopadoErrors: async f => f.map(x => Object.assign({ file: null, fixes: [] }, x)), readinessReport: async () => {}, sfcli: { openPath: async () => {} }
    });
    const realTimeout = global.setTimeout;
    global.setTimeout = () => 0;   // the watch does not wait in a test
    try {
      await ui.act('open', { ref: 'P0042' });
      let snap = await ui.snapshot();
      assert.deepStrictEqual(Object.values(snap.current.state.files).map(e => e.state), ['copado', 'copado'], 'resolved in Copado');
      assert.deepStrictEqual([snap.current.info.recreate.field, snap.current.info.recreate.value], ['copado__Recreate_Promotion_Branch__c', false]);
      // the Deployment tab: the real error, on one of this promotion's resolutions
      await ui.act('jobs', {});
      snap = await ui.snapshot();
      assert.deepStrictEqual(snap.current.jobs.errors.map(e => [e.fullName, e.resolution]), [['Ops_Manager', api.PS], ['Ops_Rep', null]]);
      assert.deepStrictEqual(Object.keys(snap.current.flagged), [api.PS]);
      // Edit again: what Copado holds now, to change
      await ui.act('revise', { rel: api.PS });
      const file = path.join(root, '.copado', 'promotions', 'P0042', 'resolved', ...api.PS.split('/'));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), api.BROKEN, 'the resolution as it is in Copado');
      assert.ok(vs.log.opened.includes(file), 'opened in the editor');
      snap = await ui.snapshot();
      assert.deepStrictEqual(snap.current.plan.held.map(x => x.reason), ['not valid XML: Element <PermissionSet> is never closed (line 2)'], 'still broken: held back');
      fs.writeFileSync(file, api.FIXED);
      snap = await ui.snapshot();
      assert.deepStrictEqual([snap.current.plan.ready.map(x => x.how), snap.current.plan.revised, snap.current.plan.last], [['replaces the one in Copado'], 1, false], 'a replacement, not a first upload');
      // a refresh does not take it away while it is being edited
      await ui.act('refresh', {});
      assert.strictEqual((await ui.snapshot()).current.state.files[api.PS].state, 'resolved');
      // upload: the body is replaced, the name kept, read back - and the box ticked
      await ui.act('upload', { recreate: true });
      assert.strictEqual(api.files.AT1, api.FIXED, 'Copado holds the fixed resolution');
      assert.deepStrictEqual(api.writes.filter(w => w[0] === 'Attachment'), [['Attachment', 'AT1', 'Body']], 'only the body - the RESOLVED name stays');
      assert.strictEqual(api.data.copado__Promotion__c[0].copado__Recreate_Promotion_Branch__c, true, 'ticked in Copado');
      snap = await ui.snapshot();
      assert.deepStrictEqual([snap.current.state.files[api.PS].state, snap.current.state.files[api.PS].revisions, !!snap.current.state.recreate], ['uploaded', 1, true]);
      assert.ok(snap.current.state.events.some(e => /Replaced 1 resolution in Copado/.test(e.text)) && snap.current.state.events.some(e => /Ticked Re-create Promotion Branch in Copado/.test(e.text)));
      // Copado merges again (not a validation): still ticked
      api.data.copado__JobExecution__c.push({ Id: 'JE500', Name: 'JE-0500', copado__Promotion__c: 'P42', copado__Status__c: 'Successful', CreatedDate: '2099-01-01T08:00:00.000+0000' });
      await ui.act('jobs', {});
      assert.strictEqual(api.data.copado__Promotion__c[0].copado__Recreate_Promotion_Branch__c, true, 'a merge job is not a validation');
      // Copado validates it successfully: unticked by itself
      api.data.copado__Deployment__c.push({ Id: 'DEP44', Name: 'DEP-0044', copado__Promotion__c: 'P42', copado__Status__c: 'Completed Successfully', CreatedDate: '2099-01-01T09:00:00.000+0000' });
      await ui.act('jobs', {});
      assert.strictEqual(api.data.copado__Promotion__c[0].copado__Recreate_Promotion_Branch__c, false, 'unticked once Copado validated it');
      snap = await ui.snapshot();
      assert.ok(!snap.current.state.recreate && snap.current.state.events.some(e => /Unticked Re-create Promotion Branch/.test(e.text) && /validated it successfully \(DEP-0044\)/.test(e.detail)));
      assert.ok(vs.log.info.some(m => /Copado validated it successfully - Re-create promotion branch is unticked again/.test(m)));
      // undo the replacement: the earlier resolution goes back into Copado
      vs.answers.warn.push({ re: /Undo the upload/, v: 'Undo' });
      await ui.act('undo', {});
      assert.strictEqual(api.files.AT1, api.BROKEN, 'undo puts back the resolution it replaced');
      assert.strictEqual((await ui.snapshot()).current.state.files[api.PS].state, 'copado');
      // ticked in Copado by someone else: counted from when it is seen, and unticked after the next successful validation
      api.data.copado__Promotion__c[0].copado__Recreate_Promotion_Branch__c = true;
      await ui.act('refresh', {});
      snap = await ui.snapshot();
      assert.ok(snap.current.state.recreate && snap.current.state.recreate.noticed, 'noticed');
      api.data.copado__Deployment__c.push({ Id: 'DEP45', Name: 'DEP-0045', copado__Promotion__c: 'P42', copado__Status__c: 'Completed Successfully', CreatedDate: '2099-02-01T09:00:00.000+0000' });
      await ui.act('jobs', {});
      assert.strictEqual(api.data.copado__Promotion__c[0].copado__Recreate_Promotion_Branch__c, false, 'unticked after the validation that followed');
    } finally { global.setTimeout = realTimeout; await ui.act('stopWatch', {}); rmTree(root); }
  });

  ok('a resolution changed in Copado while you edit it is not overwritten; Discard leaves Copado as it is', async () => {
    const W = require('../src/promotionWork');
    const api = require('./fixtures/failed-org').failedOrg();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra guard '));
    try {
      const s = W.store(dir);
      s.save({ id: 'P42', name: 'P0042', files: { [api.PS]: { state: 'copado', kind: 'xml', attachmentId: 'AT1', attachmentName: 'RESOLVED US-0000042 ' + api.PS } } });
      await W.startRevision(api, s, api.PS);
      s.write('resolved', api.PS, api.FIXED);
      api.files.AT1 = api.BROKEN + '<!-- someone in Copado -->';   // changed meanwhile
      const st = s.load();
      const r = await W.uploadAll(api, s, [{ rel: api.PS, entry: st.files[api.PS], text: api.FIXED }], {});
      assert.ok(/changed in Copado since you started editing it/.test(r.failed[0].reason), r.failed[0] && r.failed[0].reason);
      assert.ok(/someone in Copado/.test(api.files.AT1), 'their change stays');
      assert.strictEqual(W.cancelRevision(s, api.PS), true);
      assert.deepStrictEqual([s.load().files[api.PS].state, s.load().files[api.PS].revising], ['copado', undefined]);
      assert.strictEqual(s.read('resolved', api.PS), api.BROKEN, 'the file is back to what Copado held when you started');
      const P = require('../src/promotion');
      await assert.rejects(P.uploadResolution(api, { id: 'AT1' }, api.FIXED), /use Edit again to change that resolution/, 'a first upload never overwrites a resolution');
    } finally { rmTree(dir); }
  });

  ok('the page after a failed validation: what needs another look, Edit again, the switch, the newest run first', () => {
    const page = runPage();
    const PS = 'force-app/main/default/permissionsets/Ops_Manager.permissionset-meta.xml', CLS = 'force-app/main/default/classes/OpsService.cls';
    const now = new Date().toISOString();
    const cur = { promotion: { id: 'P42', name: 'P0042', status: 'Conflicts Resolved', from: 'qa', to: 'uat' },
      state: { name: 'P0042', from: 'qa', to: 'uat', syncedAt: now, events: [], files: { [PS]: { state: 'copado', kind: 'xml', story: 'US-0000042', note: 'resolved in Copado' }, [CLS]: { state: 'uploaded', kind: 'code', story: 'US-0000042' } } },
      plan: { ready: [], held: [], last: false, revised: 0 }, canUndo: false, health: [], flagged: { [PS]: ['Error parsing file: The element type "PermissionSet" must be terminated by the matching end-tag "</PermissionSet>".'] },
      info: { back: false, sides: { ours: 'Promotion branch', theirs: 'Feature' }, recreate: { field: 'copado__Recreate_Promotion_Branch__c', label: 'Re-create Promotion Branch', value: false } },
      jobs: { at: now, watching: false, error: null, objects: [], running: false, failed: true, finished: false, mapped: null,
        errors: [{ type: 'PermissionSet', fullName: 'Ops_Manager', problem: 'Error parsing file: must be terminated', resolution: PS }],
        jobs: [{ id: 'D', name: 'DEP-0042', kind: 'Deployment', status: 'Completed with Errors', state: 'failed', created: now, children: [] },
          { id: 'J1', name: 'JE-0100', kind: 'Job', status: 'Error', state: 'failed', error: 'Copado Merge : Conflict found while merging', created: now, children: [] }] } };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    let t = page.text();
    assert.ok(/data-sel="__overview"/.test(page.html) && /class="row overview sel"/.test(page.html), 'everything is in Copado: an overview, chosen first');
    assert.ok(/Needs another look 1 Ops_Manager\.permissionset-meta\.xml US-0000042 \u00b7 Error parsing file/.test(t), t);
    assert.ok(/1 resolution needs another look/.test(t) && /Re-create Promotion Branch Tick it after changing resolutions/.test(t));
    page.click({ a: 'revise', rel: PS });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'revise', payload: { rel: PS } });
    page.click({ a: 'recreate', value: '1' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'recreate', payload: { value: true } });
    // the file itself
    page.click({ sel: PS });
    t = page.text();
    assert.ok(/Needs another look/.test(t) && /Copado will trip on this resolution/.test(t) && /Edit again/.test(t) && !/Accept choices/.test(t), t);
    // being edited again: say so; upload offers the box
    cur.state.files[PS] = { state: 'resolved', kind: 'xml', story: 'US-0000042', revising: { from: 'copado' }, note: 'editing again' };
    cur.flagged = {};
    cur.plan = { ready: [{ rel: PS, how: 'replaces the one in Copado', revising: true }], held: [], last: false, revised: 1 };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    t = page.text();
    assert.ok(/Editing again/.test(t) && /Open the file/.test(t) && /Discard changes/.test(t), t);
    page.click({ a: 'uploadAsk' });
    assert.ok(/replaces the one in Copado/.test(page.text()) && /Tick Re-create promotion branch in Copado/.test(page.text()));
    page.click({ a: 'upload' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'upload', payload: { status: true, recreate: true } });
    // the switch when ticked by the extension
    cur.info.recreate.value = true; cur.state.recreate = { setAt: now };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    page.click({ tab: 'Deployment' });
    t = page.text();
    assert.ok(/Component errors in the newest run \u2013 DEP-0042/.test(t) && /Edit the resolution/.test(t), t);
    assert.ok(/1 earlier run \u2013 history, not the current problem/.test(t) && !/Conflict found while merging/.test(t), 'the earlier run is folded');
    page.click({ a: 'earlier' });
    assert.ok(/Conflict found while merging/.test(page.text()), 'and opens on request');
    page.click({ a: 'revise', rel: PS });
    assert.deepStrictEqual(page.posted.pop().payload, { rel: PS });
    assert.ok(/data-tab="Files"/.test(page.html) && /class="tab on" data-tab="Files"/.test(page.html), 'Edit the resolution goes to the file');
    // no such checkbox in this Copado
    cur.info.recreate = { missing: true };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
  });

  ok('from an open promotion, back to the start to open another: the back arrow, or Promotions again', () => {
    const page = runPage();
    const now = new Date().toISOString();
    const cur = { promotion: { id: 'P7', name: 'P0007', status: 'Merge Conflict', from: 'qa', to: 'uat' },
      state: { name: 'P0007', from: 'qa', to: 'uat', syncedAt: now, events: [], files: { 'force-app/main/default/classes/A.cls': { state: 'resolved', kind: 'code' } } },
      plan: { ready: [{ rel: 'force-app/main/default/classes/A.cls', how: 'yours' }], held: [], last: false, revised: 0 }, canUndo: false, health: [], flagged: {}, info: null, jobs: null };
    page.state({ copadoOrg: 'copado', recent: [{ name: 'P0003', status: 'Merge Conflict', from: 'qa', to: 'uat', total: 0, syncedAt: now }], current: cur, validation: null });
    assert.ok(/class="crumbback" data-a="home"/.test(page.html), 'a back arrow beside the promotion\u2019s name');
    page.click({ a: 'home' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'home', payload: {} });
    page.click({ a: 'uploadAsk' });
    assert.ok(/class="scrim"/.test(page.html), 'a dialog is open');
    page.click({ nav: 'Promotions' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'home', payload: {} }, 'Promotions, clicked while a promotion is open, goes back to the start');
    assert.ok(!/class="scrim"/.test(page.html), 'and the dialog is closed');
    page.state({ copadoOrg: 'copado', recent: [{ name: 'P0003', status: 'Merge Conflict', from: 'qa', to: 'uat', total: 0, syncedAt: now }], current: null, validation: null });
    assert.ok(/Open a promotion/.test(page.text()) && /id="href"/.test(page.html) && /data-a="openRecent" data-ref="P0003"/.test(page.html), 'the start: open another, or a recent one');
    const n = page.posted.length;
    page.click({ nav: 'Promotions' });
    assert.strictEqual(page.posted.length, n, 'on the start already, Promotions does nothing more');
    // the dialog sits above everything the page lifts - the track\u2019s stage circles included
    const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'page.css'), 'utf8');
    const z = sel => Number((new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*z-index: (\\d+)').exec(css) || [])[1]);
    const lifted = [...css.matchAll(/z-index: (\d+)/g)].map(m => Number(m[1]));
    assert.ok(z('.scrim') > 0 && lifted.every(v => v <= z('.scrim')), 'nothing paints over the dialog');
  });

  ok('a chosen value replaces the whole element - also a value that spans lines, which the earlier version left half behind', () => {
    const W = require('../src/promotionWork');
    const X = require('../src/xmlParser');
    const merged = '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>First line of the description\nand its second line\nand a third</description>\n' +
      '    <hasActivationRequired>false</hasActivationRequired>\n    <label>Ops</label>\n</PermissionSet>\n';
    const clashes = [{ line: 2, tag: 'description', target: 'Promotion text', incoming: 'Feature text\nover two lines & <more>' }, { line: 6, tag: 'label', target: 'Ops', incoming: 'Ops 2' }];
    const r = W.applyChoices(merged, clashes, { 0: 'incoming', 1: 'incoming' });
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(W.wellFormed(r.text, X), null, 'well-formed');
    assert.ok(r.text.includes('    <description>Feature text\nover two lines &amp; &lt;more&gt;</description>\n    <hasActivationRequired>') && r.text.includes('<label>Ops 2</label>') && !/second line|a third/.test(r.text), r.text);
    assert.deepStrictEqual(W.applyChoices(merged, [{ line: 4, tag: 'description', target: 'x', incoming: 'y' }], { 0: 'target' }).moved, [0], 'not on that line: left for the merge editor');
    assert.strictEqual(W.applyChoices(merged, clashes, {}).text, merged, 'no choice, no change');
  });

  ok('resolutions the one-line choices broke are rebuilt from your recorded choices - never a file you edited', () => {
    const W = require('../src/promotionWork');
    const X = require('../src/xmlParser');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra repair '));
    try {
      const s = W.store(dir);
      const merged = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>Line one\nline two</description>\n    <label>Ops</label>\n</PermissionSet>\n';
      const clashes = [{ line: 1, tag: 'description', target: 'Promotion text', incoming: 'Feature text' }];
      const choices = { 0: 'target' };
      const broken = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>Promotion text</description>\nline two</description>\n    <label>Ops</label>\n</PermissionSet>\n';
      const files = {};
      for (const [name, resolved, extra] of [['A', broken, {}], ['B', broken.replace('Ops', 'Ops edited by hand'), {}], ['C', merged, {}], ['D', broken, { revising: { from: 'copado' } }]]) {
        const rel = 'force-app/main/default/permissionsets/' + name + '.permissionset-meta.xml';
        s.write('merged', rel, merged); s.write('resolved', rel, resolved);
        files[rel] = Object.assign({ state: 'resolved', kind: 'xml', clashes, choices, note: 'your choices: promotion' }, extra);
      }
      const st = { files };
      assert.ok(W.wellFormed(broken, X), 'what the earlier version produced is broken');
      const fixed = W.repairChoices(s, st, X);
      assert.deepStrictEqual(fixed.map(r => path.basename(r)), ['A.permissionset-meta.xml'], 'only the file exactly as the old code left it');
      const a = s.read('resolved', fixed[0]);
      assert.strictEqual(W.wellFormed(a, X), null);
      assert.ok(a.includes('<description>Promotion text</description>\n    <label>Ops</label>') && !a.includes('line two'));
      assert.ok(/rebuilt: the earlier version broke a value that spans lines/.test(st.files[fixed[0]].note));
      assert.ok(s.read('resolved', 'force-app/main/default/permissionsets/B.permissionset-meta.xml').includes('edited by hand'), 'your edit is left alone');
      assert.deepStrictEqual(W.repairChoices(s, st, X), [], 'and once is enough');
    } finally { rmTree(dir); }
  });

  ok('opening a promotion rebuilds what the one-line choices broke, and says so', async () => {
    const W = require('../src/promotionWork');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra rebuild '));
    const api = require('./fixtures/failed-org').failedOrg();
    const vs = fakeCode(root, {});
    const [ui] = loadWith(vs, ['../promotionUi']);
    const out = [];
    ui.activate({ subscriptions: { push() {} }, workspaceState: { get: (k, d) => d, update: async () => {} } }, {
      output: { appendLine: l => out.push(l) }, rc: () => ({ copadoOrg: 'copado', sfPath: 'sf', environmentOrgs: {} }), cmd: (id, fn) => { vs.registered[id] = fn; },
      requireTrust() {}, projectRoot: () => root, apiVersion: async () => '62.0', copadoApi: () => api,
      deps: { storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), promoMerge: async () => ({ ok: false }), startSession: async () => {} },
      orgList: async () => [], credentialsFor: async () => [], orgForEnvironment: async () => null, runBranchCheck: async () => {}, validatePromotionBranch: async () => {},
      onValidation: () => ({ dispose() {} }), validationStatus: () => null, showCopadoErrors: async f => f, readinessReport: async () => {}, sfcli: { openPath: async () => {} }
    });
    const realTimeout = global.setTimeout;
    global.setTimeout = () => 0;
    try {
      // a resolution made with 3.0.5: your choice, written over one line of a two-line description
      const s = W.store(path.join(root, '.copado', 'promotions', 'P0042'));
      const rel = 'force-app/main/default/permissionsets/Ops_Seeded.permissionset-meta.xml';
      const merged = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>Line one\nline two</description>\n</PermissionSet>\n';
      s.write('merged', rel, merged);
      s.write('resolved', rel, '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>Chosen</description>\nline two</description>\n</PermissionSet>\n');
      s.save({ id: 'P42', name: 'P0042', files: { [rel]: { state: 'resolved', kind: 'xml', clashes: [{ line: 1, tag: 'description', target: 'Chosen', incoming: 'Other' }], choices: { 0: 'target' }, note: 'your choices: promotion' } } });
      await ui.act('open', { ref: 'P0042' });
      const snap = await ui.snapshot();
      assert.strictEqual(s.read('resolved', rel), '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>Chosen</description>\n</PermissionSet>\n');
      assert.ok(snap.current.plan.ready.some(x => x.rel === rel) && !snap.current.plan.held.some(x => x.rel === rel), 'ready to upload again, not held back');
      assert.ok(snap.current.state.events.some(e => /Rebuilt 1 resolution from your choices/.test(e.text) && /Ops_Seeded/.test(e.detail)));
      assert.ok(out.some(l => /rebuilt .*Ops_Seeded.* from your choices/.test(l)));
    } finally { global.setTimeout = realTimeout; await ui.act('stopWatch', {}); rmTree(root); }
  });

  ok('a run that succeeded shows no component errors - and a list of what was deployed is not an error', async () => {
    const J = require('../src/jobs');
    const api = require('./fixtures/failed-org').failedOrg();
    const list = 'Flow : Opportunity_After_Save, Flow : Quote_Stage, ApexClass : QuoteService, Layout : Account-Account Layout, PermissionSet : Ops_Manager';
    api.data.copado__Deployment__c.push({ Id: 'DEP50', Name: 'DEP-0050', copado__Promotion__c: 'P42', copado__Status__c: 'Completed Successfully', CreatedDate: '2099-03-01T09:00:00.000+0000' });
    api.data.copado__JobExecution__c.push({ Id: 'JE600', Name: 'JE-0600', copado__Deployment__c: 'DEP50', copado__Status__c: 'Successful', CreatedDate: '2099-03-01T09:00:00.000+0000' });
    api.data.copado__JobStep__c.push({ Id: 'JS600', Name: 'Deploy', copado__JobExecution__c: 'JE600', copado__Status__c: 'Success', copado__Order__c: 1, copado__Type__c: 'Function', CreatedDate: '2099-03-01T09:00:00.000+0000' });
    api.data.copado__Result__c.push({ Id: 'R600', Name: 'R-0600', copado__JobStep__c: 'JS600', copado__Status__c: 'Success', copado__Progress_Status__c: 'Completed', copado__Error_Message__c: list, CreatedDate: '2099-03-01T09:00:00.000+0000' });
    const snap = await J.snapshot(api, 'P42');
    assert.strictEqual(snap.jobs[0].name, 'DEP-0050');
    assert.deepStrictEqual(await J.errorsOf(api, snap), [], 'the newest run succeeded: nothing to fix');
    assert.deepStrictEqual(J.componentErrors([list]), [], 'a component list is not an error, wherever it appears');
    assert.deepStrictEqual(J.componentErrors([list + '\nApexClass QuoteService: Variable does not exist: rate']).map(e => e.fullName), ['QuoteService'], 'a real error beside it still is');
  });

  ok('loading and progress messages are in plain words - the CLI\u2019s own lines stay in the Output panel', () => {
    const { phase } = require('../src/plain');
    assert.deepStrictEqual(['\u280b Deploying Metadata  Components: 12/40', '\u2819 Running Tests  Successful: 3/10', '\u280b Waiting for the org to respond 3s', '\u2714 Preparing 1.2s', 'Status: Failed', 'Retrieving v62.0 metadata from x'].map(phase),
      ['Checking components (12 of 40)', 'Running tests (3 of 10)', 'Waiting for Salesforce', 'Getting started', 'Finishing up', 'Getting the files from Salesforce']);
    assert.strictEqual(phase('Elapsed Time: 12s'), null, 'anything else is not shown');
    const root = path.join(__dirname, '..');
    const titles = [];
    for (const f of ['release.js', 'promotionUi.js', 'lifecycleUi.js', 'extension.js']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      for (const m of src.matchAll(/withProgress\(\{[^}]*?title: ([^}]+?)(?:, cancellable[^}]*)?\}/g)) titles.push(f + ': ' + m[1]);
      for (const m of src.matchAll(/progress\.report\(\{ message: ('[^']*')/g)) titles.push(f + ': ' + m[1]);
    }
    assert.ok(titles.length > 15, 'found the notifications: ' + titles.length);
    const technical = /c\.copadoOrg|\(\s*' \+ c\.copadoOrg|testLevel \+|fetching|downloading in parallel|computing|copado__|JobExecution|read-only\)|parallel|attachment/i;
    assert.deepStrictEqual(titles.filter(t => technical.test(t)), [], 'no org alias, API name or internal step in a notification');
    const page = fs.readFileSync(path.join(root, 'media', 'page.js'), 'utf8');
    assert.ok(!/Reading Copado\\u2019s deployment records|following, read-only|did not validate|Looked in ' \+ esc/.test(page), 'the page\u2019s loading and status texts are plain');
  });

  section('3.0.8: nothing resolved without you; the pre-check on the page');

  ok('resolving automatically is off by default: a clean merge is only a suggestion, code keeps every block, earlier automatic ones come back to you', async () => {
    const W = require('../src/promotionWork');
    const xml = 'force-app/main/default/layouts/A.layout-meta.xml', cls = 'force-app/main/default/classes/A.cls';
    const conflicted = '<Layout>\n<<<<<<< HEAD\n<a>1</a>\n=======\n<a>1</a>\n>>>>>>> feature\n</Layout>\n';
    const clean = async () => ({ ok: true, mergedText: '<Layout>\n<a>1</a>\n</Layout>\n', conflicts: 0, clashes: [] });
    const off = await W.autoResolve(xml, conflicted, clean, false);
    assert.deepStrictEqual([off.state, off.suggestion, off.merged], ['review', true, '<Layout>\n<a>1</a>\n</Layout>\n'], 'the merge is offered, not taken');
    const on = await W.autoResolve(xml, conflicted, clean, true);
    assert.deepStrictEqual([on.state, !!on.suggestion], ['auto', false], 'with the setting on, as before');
    const code = '<<<<<<< HEAD\nx\n=======\nx\n>>>>>>> f\n';
    const c0 = await W.autoResolve(cls, code, clean, false);
    assert.deepStrictEqual([c0.state, c0.merged, c0.conflicts], ['code', code, 1], 'even a block both sides agree on stays for you');
    assert.strictEqual((await W.autoResolve(cls, code, clean, true)).state, 'auto');
    assert.deepStrictEqual([(await W.autoResolve(xml, '<Layout/>', clean, false)).state], ['review'], 'no markers: still yours to accept');
    // a promotion fetched before, with automatic results: back to review
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra auto '));
    try {
      const s = W.store(dir);
      s.save({ id: 'P1', files: { [xml]: { state: 'auto', attachmentId: 'X', modified: 'm' }, [cls]: { state: 'resolved' } } });
      const api = { query: async () => [], download: async () => Buffer.from('') };
      const r = await W.sync(api, s, { id: 'P1', name: 'P1' }, clean, { autoResolve: false });
      assert.deepStrictEqual([r.returned, r.state.files[xml].state, r.state.files[xml].suggestion, r.state.files[cls].state], [1, 'review', true, 'resolved'], 'your own resolution stays yours');
    } finally { rmTree(dir); }
    // the page: a suggestion to accept
    const page = runPage();
    const now = new Date().toISOString();
    page.state({ copadoOrg: 'copado', recent: [], validation: null, autoResolve: false, current: { promotion: { id: 'P1', name: 'P0001', status: 'Merge Conflict', from: 'a', to: 'b' },
      state: { name: 'P0001', from: 'a', to: 'b', syncedAt: now, events: [], files: { [xml]: { state: 'review', suggestion: true, kind: 'xml', blocks: 1, note: 'a suggested merge - review it and accept' } } },
      plan: { ready: [], held: [], last: false, revised: 0 }, canUndo: false, health: [], flagged: {}, info: null, jobs: null, precheck: null } });
    const t = page.text();
    assert.ok(/To review \u00b7 a suggested merge/.test(t) && /Accept the suggestion/.test(t) && /A suggested merge of both branches\. Accept it, or open Review in merge, change what you need and save\./.test(t), t);
    page.click({ a: 'accept' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'accept', payload: { rel: xml } });
    page.state({ copadoOrg: 'copado', recent: [], current: null, validation: null, autoResolve: false });
    assert.ok(/merged for you to review \u2013 nothing in Copado changes until you upload/.test(page.text()));
  });

  ok('the pre-check end to end: your resolution is checked, not the branch\u2019s; an unresolved file is left out; the page follows it - the Output panel never opens', async () => {
    const sfcli = require('../src/sfcli');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra pc '));
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cra pc tools '));
    const PS = 'force-app/main/default/permissionsets/Sales_User.permissionset-meta.xml', CLS = 'force-app/main/default/classes/AccountService.cls';
    const g = await h.fakeGitHosts({ branches: ['feature/US-0000103'], files: {
      [PS]: '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>THE BRANCH VERSION</label></PermissionSet>',
      [CLS]: 'public class AccountService { /* the branch version */ }', 'force-app/main/default/classes/AccountService.cls-meta.xml': '<ApexClass/>',
      'force-app/main/default/classes/AccountServiceTest.cls': '@isTest class AccountServiceTest {}', 'force-app/main/default/classes/AccountServiceTest.cls-meta.xml': '<ApexClass/>' } });
    const conflictPS = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n<<<<<<< HEAD\n    <label>Sales</label>\n=======\n    <label>Sales users</label>\n>>>>>>> feature/US-0000103\n</PermissionSet>\n';
    const conflictCLS = 'public class AccountService {\n<<<<<<< HEAD\n  Integer a = 1;\n=======\n  Integer a = 2;\n>>>>>>> feature/US-0000103\n}\n';
    const t = '2026-11-06T09:30:00.000+0000';
    const api = require('./fixtures/life-org').lifeOrg({ uri: g.base + '/owner/repo', more: {
      Attachment: [{ Id: 'AP1', Name: 'US-0000103 ' + PS, ParentId: 'P4', BodyLength: 10, CreatedDate: t, LastModifiedDate: t }, { Id: 'AP2', Name: 'US-0000103 ' + CLS, ParentId: 'P4', BodyLength: 10, CreatedDate: t, LastModifiedDate: t }],
      ContentDocument: [{ Id: 'DP4', Title: 'Copado Promotion changes', LatestPublishedVersionId: 'VP4', CreatedDate: t, LastModifiedDate: t }], ContentDocumentLink: [{ Id: 'CLP4', ContentDocumentId: 'DP4', LinkedEntityId: 'P4' }] },
      moreFiles: { AP1: conflictPS, AP2: conflictCLS, VP4: JSON.stringify([{ t: 'PermissionSet', n: 'Sales_User', a: 'Add' }, { t: 'ApexClass', n: 'AccountService', a: 'Add' }, { t: 'ApexClass', n: 'AccountServiceTest', a: 'Add' }]) } });
    try {
      fs.writeFileSync(path.join(root, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"62.0"}');
      const vs = fakeCode(root, { 'cmr.sf.path': h.fakeSf(tools), 'cmr.copado.org': 'copado', 'cmr.repo.provider': 'github', 'cmr.repo.url': g.base + '/owner/repo', 'cmr.org.confirm': false, 'cmr.copado.environmentOrgs': { int: 'qa' } });
      const [release, ui] = loadWith(vs, ['../release', '../promotionUi', '../lifecycleUi', '../releasePage']);
      let shown = 0;
      const secrets = new Map([['cmr.repoToken:' + new URL(g.base).host, 'gh-token']]);
      release.activate({ subscriptions: { push() {} }, secrets: { get: async k => secrets.get(k), store: async () => {}, delete: async () => {} },
        workspaceState: { get: (k, d) => d, update: async () => {} }, extensionUri: vs.Uri.file(root) }, {
        output: { appendLine() {}, show() { shown++; }, clear() {} }, resolveProject: () => ({ root }), startSession: async () => {}, promoMerge: async () => ({ ok: false }), copadoApi: () => api,
        storageDir: async sub => { const d = path.join(root, '.copado', sub || ''); fs.mkdirSync(d, { recursive: true }); return vs.Uri.file(d); },
        writeTemp: async (n, x) => { const f = path.join(root, '.copado', 'tmp', n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, x); return vs.Uri.file(f); } });
      await ui.act('open', { ref: 'P0004' });
      let snap = await ui.snapshot();
      assert.deepStrictEqual(Object.values(snap.current.state.files).map(e => e.state).sort(), ['code', 'code'], 'nothing resolved without you - not even the permission set');
      // you resolve the permission set; the class stays unresolved
      const store = path.join(root, '.copado', 'promotions', 'P0004', 'resolved');
      const mine = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>MY RESOLUTION</label>\n</PermissionSet>\n';
      fs.writeFileSync(path.join(store, ...PS.split('/')), mine);
      await ui.act('accept', { rel: PS });
      vs.answers.pick.push({ re: /which test classes/, v: items => items });
      vs.answers.input.push({ re: /other test classes/, v: '' });
      const commandsBefore = vs.log.commands.length;
      await ui.act('precheck', {});
      snap = await ui.snapshot();
      const pc = snap.current.precheck;
      const ws = path.join(root, '.copado', 'branch-check', 'P0004-precheck');
      assert.strictEqual(fs.readFileSync(path.join(ws, ...PS.split('/')), 'utf8'), mine, 'your resolution is checked - not the branch\u2019s version');
      const pkgXml = fs.readFileSync(path.join(ws, 'manifest', 'package.xml'), 'utf8');
      assert.ok(!/<members>AccountService<\/members>/.test(pkgXml) && /AccountServiceTest/.test(pkgXml) && /Sales_User/.test(pkgXml), 'the unresolved class is left out, not taken from the branch: ' + pkgXml);
      assert.deepStrictEqual([pc.state, pc.steps], ['failed', { gather: 'done', files: 'done', check: 'done', result: 'failed' }]);
      assert.deepStrictEqual(pc.used.map(u => [path.basename(u.rel), u.from]), [['Sales_User.permissionset-meta.xml', 'your resolution']]);
      assert.deepStrictEqual(pc.leftOut.map(u => [path.basename(u.rel), u.reason]), [['AccountService.cls', 'not resolved yet']]);
      assert.deepStrictEqual(pc.files.leftOut, ['ApexClass AccountService']);
      assert.deepStrictEqual(pc.result.failures.map(f => [f.type, f.fullName, f.resolution]), [['PermissionSet', 'Sales_User', PS]], 'the problem points at your resolution');
      assert.ok(pc.log.some(l => /Checking components \(\d of \d\)/.test(l.text)) && pc.log.some(l => /^Validation failed: 1 error\.$/.test(l.text)), pc.log.map(l => l.text).join(' | '));
      assert.ok(!pc.log.some(l => /\u280b|sf project|--target-org/.test(l.text)), 'plain words, not the CLI');
      const order = pc.log.map(l => l.text);
      assert.ok(order.indexOf('Getting started') < order.findIndex(x => /Checking components/.test(x)) && order.filter(x => x === 'Getting started').length <= 1, 'in order, never back to the start: ' + order.join(' | '));
      assert.ok(order.some(x => /^Prepared: \d+ files? from the branch, 1 resolved, 1 left out$/.test(x)), 'what was prepared, in plain words');
      assert.strictEqual(shown, 0, 'the Output panel never opened');
      assert.ok(!vs.log.commands.slice(commandsBefore).some(c => c[0] === 'cmrDeployView.focus'), 'nor did the Deploy Check panel take the focus');
      assert.ok(snap.current.state.events.some(e => e.text === 'Pre-check: validation failed'));
      // the page
      const page = runPage();
      page.state({ copadoOrg: 'copado', recent: [], current: snap.current, validation: null });
      page.click({ tab: 'Pre-check' });
      const text = page.text();
      assert.ok(/Validation failed/.test(text) && /\b1 error\b/.test(text) && /Open file/.test(text) && /Your resolution: Sales_User/.test(text) && /left out \u2013 not resolved yet/.test(text) && /from feature\/US-0000103/.test(text), text);
      page.click({ sel: PS, go: 'Files' });
      assert.ok(/class="tab on" data-tab="Files"/.test(page.html) && /class="row sel" data-sel="force-app\/main\/default\/permissionsets\/Sales_User/.test(page.html), 'Open your resolution goes to the file');
    } finally {
      g.server.close(); sfcli.resetRest();
      rmTree(root); rmTree(tools);
    }
  });

  ok('the Pre-check tab: before a run, while it runs, and when it passes', () => {
    const page = runPage();
    const now = new Date().toISOString();
    const rel = 'force-app/main/default/classes/A.cls';
    const cur = { promotion: { id: 'P1', name: 'P0001', status: 'Merge Conflict', from: 'a', to: 'uat' },
      state: { name: 'P0001', from: 'a', to: 'uat', syncedAt: now, events: [], files: { [rel]: { state: 'resolved', kind: 'code' } } },
      plan: { ready: [{ rel, how: 'yours' }], held: [], last: false, revised: 0 }, canUndo: false, health: [], flagged: {}, info: null, jobs: null, precheck: null };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    page.click({ tab: 'Pre-check' });
    assert.ok(/Validate your resolutions before uploading/.test(page.text()) && /Unresolved files are left out/.test(page.text()) && /data-a="precheck"[^>]*>[\s\S]*?Validate</.test(page.html));
    page.click({ tab: 'Files' });
    cur.precheck = { id: 'r1', at: now, state: 'running', steps: { gather: 'done', files: 'done', check: 'running', result: '' }, phase: 'Running tests (3 of 10)', log: [{ at: now, text: 'Running tests (3 of 10)', kind: 'info' }],
      used: [{ rel, from: 'your resolution' }], leftOut: [], target: { environment: 'uat', alias: 'uat', username: 'me@example.com.uat', tests: true }, files: { fromBranches: 4, resolved: 1, leftOut: [], branches: ['feature/US-1'] }, result: null, branches: ['feature/US-1'] };
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    assert.ok(/class="tab on" data-tab="Pre-check"/.test(page.html), 'a run starting brings its tab forward');
    let t = page.text();
    assert.ok(/Validating against uat/.test(t) && /Running tests \(3 of 10\)/.test(t) && /4 from the branch, 1 resolved/.test(t) && !/Validate again/.test(t), t);
    page.click({ tab: 'Files' });
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    assert.ok(/class="tab on" data-tab="Files"/.test(page.html), 'once seen, it stays where you put it');
    cur.precheck = Object.assign({}, cur.precheck, { state: 'passed', finishedAt: new Date(Date.now() + 65000).toISOString(), steps: { gather: 'done', files: 'done', check: 'done', result: 'done' }, message: 'It would deploy to uat.', result: { success: true, failures: [], tests: [], coverage: [] } });
    page.state({ copadoOrg: 'copado', recent: [], current: cur, validation: null });
    page.click({ tab: 'Pre-check' });
    t = page.text();
    assert.ok(/Validated successfully/.test(t) && /uat \u00b7 [\d:]+ (AM|PM)? ?\u00b7 1 min 5 s/.test(t) && /No errors, all tests passed\./.test(t) && /Validate again/.test(t), t);
    assert.ok(/title="Checked as me@example\.com\.uat"/.test(page.html));
    page.click({ a: 'precheck' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'precheck', payload: { rel: rel } });
  });

  section('3.0.10: Review in merge - what you save is your resolution');

  /** The real merge view of extension.js, on a stand-in VS Code: files on disk, positions and edits by range, its marks, rows and panel captured. */
  async function realMergeView(root, settings) {
    // VS Code's own diff view unless a test asks for the merge editor
    const vs = fakeCode(root, Object.assign({}, settings || {}));
    const kept = new Map();
    const saves = [], changes = [];
    const any = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any(), set: () => true, apply: () => any(), construct: () => any() });
    // an open document stays readable in VS Code; here, a file the test has cleaned up reads as empty
    const read = u => { try { return fs.readFileSync(u.fsPath, 'utf8'); } catch (e) { return ''; } };
    function Position(line, character) { this.line = line; this.character = character || 0; }
    function Range(a, b, c, d) { if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); } }
    const offsetOf = (text, pos) => { const ls = text.split(/(?<=\n)/); let o = 0; for (let i = 0; i < pos.line && i < ls.length; i++) o += ls[i].length; return Math.min(o + pos.character, text.length); };
    const posOf = (text, off) => { const before = text.slice(0, off).split('\n'); return new Position(before.length - 1, before[before.length - 1].length); };
    const doc = u => ({ uri: u, fileName: u.fsPath, languageId: 'xml', isDirty: false, getText: () => read(u), positionAt: i => posOf(read(u), i), offsetAt: p => offsetOf(read(u), p),
      lineAt: i => ({ text: (read(u).split(/\r?\n/)[i] || '') }), get lineCount() { return read(u).split('\n').length; }, save: async () => true });
    Object.assign(vs, { Position, Range, Selection: Range, CodeLens: function (range, command) { this.range = range; this.command = command; }, Hover: function (c, r) { this.contents = c; this.range = r; } });
    vs.WorkspaceEdit = class { constructor() { this.ops = []; } replace(u, r, t) { this.ops.push([u, r, t]); } };
    // the merge editor's panel: its page, what it is sent, and a way to answer as the page
    const webviews = [];
    vs.ViewColumn = vs.ViewColumn || { Active: -1, Beside: -2, One: 1 };
    Object.assign(vs.window, {
      createWebviewPanel: (id, title, column, options) => {
        const w = { id, title, options, posted: [], handler: null, closers: [], disposed: false, revealed: 0 };
        w.panel = {
          get title() { return w.title; }, set title(t) { w.title = t; },
          webview: { cspSource: 'vscode-resource:', html: '', asWebviewUri: u => ({ toString: () => 'vscode-resource:' + String(u.fsPath).replace(/\\/g, '/') }),
            onDidReceiveMessage: fn => { w.handler = fn; return { dispose() {} }; }, postMessage: m => { w.posted.push(m); return Promise.resolve(true); } },
          onDidDispose: fn => { w.closers.push(fn); return { dispose() {} }; },
          reveal: () => { w.revealed++; },
          dispose: () => { if (w.disposed) return; w.disposed = true; for (const f of w.closers) f(); }
        };
        w.send = async m => { await w.handler(m); await new Promise(r => setImmediate(r)); };
        w.last = type => w.posted.filter(m => m.type === type).pop();
        webviews.push(w);
        return w.panel;
      },
      createTextEditorDecorationType: o => ({ o, dispose() {} }),
      createTreeView: () => ({ dispose() {} }),
      setStatusBarMessage: m => { vs.log.status = (vs.log.status || []).concat([m]); return { dispose() {} }; }
    });
    // a real getter: the open editor is the merged file once the view is shown
    Object.defineProperty(vs.window, 'visibleTextEditors', { get: () => [] });
    Object.assign(vs.workspace, { onDidSaveTextDocument: fn => { saves.push(fn); return { dispose() {} }; }, onDidChangeTextDocument: fn => { changes.push(fn); return { dispose() {} }; }, openTextDocument: async u => doc(u),
      applyEdit: async e => { for (const [u, r, t] of e.ops) { const x = read(u); fs.writeFileSync(u.fsPath, x.slice(0, offsetOf(x, r.start)) + t + x.slice(offsetOf(x, r.end))); } return true; } });
    const withFallback = o => new Proxy(o, { get: (t, k) => k in t ? t[k] : any() });
    vs.window = withFallback(vs.window); vs.workspace = withFallback(vs.workspace); vs.languages = withFallback(vs.languages);
    const full = withFallback(vs);
    let deps = null; let api = null;
    const Module = require('module'); const load = Module._load;
    Module._load = function (req) {
      if (req === 'vscode') return full;
      if (req === './release') return { activate: (c, d) => { deps = d; } };
      return load.apply(this, arguments);
    };
    // the hook stays while extension.js activates: it loads the release side then, not when it is required
    try {
      delete require.cache[require.resolve('../extension')];
      const ext = require('../extension');
      const ws = new Map();
      api = await ext.activate({ subscriptions: { push() {} }, workspaceState: { get: (k, d) => ws.has(k) ? ws.get(k) : d, update: async (k, v) => { ws.set(k, v); } }, globalState: { get: (k, d) => kept.has(k) ? kept.get(k) : d, update: async (k, v) => { kept.set(k, v); } },
        extensionUri: vs.Uri.file(root), globalStorageUri: vs.Uri.file(path.join(root, '.g')), storageUri: vs.Uri.file(path.join(root, '.s')), extensionPath: root, secrets: any() });
    } finally { Module._load = load; }
    return { api,
      vs, deps: () => deps, webviews
    };
  }


  ok('reopened on a resolution you saved: the merge\u2019s conflicts are found again in it - the one you settled otherwise is not', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    const fn = new Function('return ' + /function remapConflicts\(marks, mergedText, startFrom\) \{[\s\S]*?\n\}/.exec(src)[0])();
    const merged = '<Layout>\n    <label>Feature label</label>\n    <showRunAssignmentRulesCheckbox>true</showRunAssignmentRulesCheckbox>\n</Layout>\n';
    const marks = [{ startLine: 1, endLine: 1, mark: { kind: 'conflict', conflict: { tag: 'label' } } }, { startLine: 2, endLine: 2, mark: { kind: 'conflict', conflict: { tag: 'showRunAssignmentRulesCheckbox' } } }, { startLine: 1, endLine: 1, mark: { kind: 'added' } }];
    const saved = '<Layout>\n    <fields>NEW</fields>\n    <label>Feature label</label>\n    <showRunAssignmentRulesCheckbox>false</showRunAssignmentRulesCheckbox>\n</Layout>\n';
    assert.deepStrictEqual(fn(marks, merged, saved).map(m => [m.mark.conflict.tag, m.startLine]), [['label', 2]], 'found by its text, a line further down; the checkbox you set otherwise is no longer a conflict');
  });

  ok('the Promotions tab opens Review in merge to save into the resolution, from what you saved, with the sides named - and offers no other choices', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra rv '));
    const REL = 'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml';
    const target = '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n    <relatedLists>\n        <fields>QUOTE.TOTALPRICE</fields>\n    </relatedLists>\n</Layout>\n';
    const feature = target.replace('<fields>QUOTE.TOTALPRICE</fields>\n', '<fields>QUOTE.TOTALPRICE</fields>\n        <fields>QUOTE.SUBTOTAL</fields>\n');
    const conflict = '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n<<<<<<< HEAD\n' + target.split('\n').slice(1, -2).join('\n') + '\n=======\n' + feature.split('\n').slice(1, -2).join('\n') + '\n>>>>>>> origin/feature/US-0000103\n</Layout>\n';
    const t = '2026-11-06T09:30:00.000+0000';
    const api = require('./fixtures/life-org').lifeOrg({ more: { Attachment: [{ Id: 'AK1', Name: 'US-0000103 ' + REL, ParentId: 'P4', BodyLength: 10, CreatedDate: t, LastModifiedDate: t }] }, moreFiles: { AK1: conflict } });
    const vs = fakeCode(root, {});
    const [ui] = loadWith(vs, ['../promotionUi']);
    const sessions = [];
    ui.activate({ subscriptions: { push() {} }, workspaceState: { get: (k, d) => d, update: async () => {} } }, {
      output: { appendLine() {} }, rc: () => ({ copadoOrg: 'copado', sfPath: 'sf', environmentOrgs: {} }), cmd: (id, fn) => { vs.registered[id] = fn; },
      requireTrust() {}, projectRoot: () => root, apiVersion: async () => '62.0', copadoApi: () => api,
      deps: { storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), promoMerge: async () => ({ ok: true, mergedText: feature, conflicts: 0, clashes: [] }), startSession: async (a, b, c, o) => { sessions.push(o); } },
      orgList: async () => [], credentialsFor: async () => [], orgForEnvironment: async () => null, runBranchCheck: async () => {}, validatePromotionBranch: async () => {},
      onValidation: () => ({ dispose() {} }), validationStatus: () => null, showCopadoErrors: async f => f, readinessReport: async () => {}, sfcli: { openPath: async () => {} }
    });
    try {
      await ui.act('open', { ref: 'P0004' });
      await ui.act('review', { rel: REL });
      let o = sessions.pop();
      assert.deepStrictEqual([o.applyOnSave, o.openAfterApply, o.startFrom, o.labels], [true, false, null, { target: 'Target branch (HEAD)', incoming: 'Feature branch (origin/feature/US-0000103)', ancestor: 'Common ancestor', merged: 'Your resolution (editable)' }],
        'a suggestion opens on the suggestion; saving applies it');
      // you save in the merge view: the file is yours, ready to upload
      const file = path.join(root, '.copado', 'promotions', 'P0004', 'resolved', ...REL.split('/'));
      fs.writeFileSync(file, target);
      o.onApplied();
      let snap = await ui.snapshot();
      assert.deepStrictEqual([snap.current.state.files[REL].state, snap.current.state.files[REL].note], ['resolved', 'your resolution from the merge view']);
      assert.ok(snap.current.plan.ready.some(x => x.rel === REL), 'ready to upload - here, the target exactly, with nothing added');
      // opened again: from what you saved
      await ui.act('review', { rel: REL });
      o = sessions.pop();
      assert.strictEqual(o.startFrom, target);
      await ui.act('compare', { rel: REL });
      assert.strictEqual(vs.log.commands.filter(x => x[0] === 'vscode.diff').pop()[3], 'Account-Account Layout.layout-meta.xml: Target branch (HEAD) \u2194 Feature branch (origin/feature/US-0000103)');
      // the page: no extra choices; the way on is Review in merge (or Accept for a suggestion)
      const page = runPage();
      page.state({ copadoOrg: 'copado', recent: [], current: snap.current, validation: null });
      const txt = page.text();
      assert.ok(!/Choose what to keep|Keep the target as it is|Change by change/.test(txt) && !/data-a="keep"|pickOpen/.test(page.html), 'none of the three options');
      assert.ok(/Review in merge starts from what you saved/.test(txt) && /Target branch HEAD Feature branch origin\/feature\/US-0000103/.test(txt), txt);
      snap.current.state.files[REL] = { state: 'review', suggestion: true, kind: 'xml', blocks: 1, labels: { ours: 'HEAD', theirs: 'origin/feature/US-0000103' } };
      page.state({ copadoOrg: 'copado', recent: [], current: snap.current, validation: null });
      assert.ok(/Accept the suggestion/.test(page.text()) && /Review in merge/.test(page.text()) && /change what you need and save\./.test(page.text()));
    } finally { await ui.act('stopWatch', {}); rmTree(root); }
  });

  section('3.1.0: the sidebar only for what the page does not do; steadier');

  ok('the sidebar: no Promotion view - the page does all of it; Deploy Check and Branch Conflicts only when they have something; otherwise one button to the page', () => {
    const root = path.join(__dirname, '..');
    const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const views = p.contributes.views.cmrContainer;
    assert.deepStrictEqual(views.map(v => [v.id, v.when]), [
      ['cmrStart', '!cmr.hasPackage && !cmr.hasValidation && !cmr.hasBranchCheck'],
      ['cmrDeployView', 'cmr.hasPackage || cmr.hasValidation'], ['cmrBranchView', 'cmr.hasBranchCheck']]);
    const all = JSON.stringify(p.contributes);
    assert.ok(!/cmrPromotionView|cmr\.promotion\.(refresh|review|accept|compare|reset|copy|uploadAll|undoUpload|precheck|validateBranch|openInCopado|close)\b|cmr\.copado\.(resolvePromotion|copyResolution|undoUpload)\b/.test(all), 'the Promotion view and its commands are gone');
    const declared = new Set(p.contributes.commands.map(c => c.command));
    const welcome = p.contributes.viewsWelcome;
    assert.deepStrictEqual(welcome.map(w => w.view), ['cmrStart']);
    const links = [...welcome[0].contents.matchAll(/\(command:([\w.]+)\)/g)].map(m => m[1]);
    assert.deepStrictEqual(links, ['cmr.page.open', 'cmr.validate.run', 'cmr.package.fromCommit', 'cmr.git.check']);
    assert.ok(links.every(c => declared.has(c)), 'every button runs a command that exists');
    // the views the code creates are the ones contributed - none more, none less
    const code = ['extension.js', 'release.js', 'promotionUi.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    const created = [...code.matchAll(/createTreeView\('(\w+)'/g)].map(m => m[1]).sort();
    assert.deepStrictEqual(created, views.map(v => v.id).sort());
    // the page runs only its own commands, and each of them is allowed
    const page = fs.readFileSync(path.join(root, 'media', 'page.js'), 'utf8');
    const used = new Set([...page.matchAll(/data-tool="([\w.]+)"/g)].map(m => m[1]).concat([...page.matchAll(/\['(cmr\.[\w.]+)'/g)].map(m => m[1])));
    const allowed = new Set(JSON.parse(/const TOOLS = new Set\((\[[^\]]+\])\)/.exec(fs.readFileSync(path.join(root, 'releasePage.js'), 'utf8'))[1].replace(/'/g, '"')));
    assert.deepStrictEqual([...used].filter(t => !allowed.has(t)), [], 'every button on the page is allowed to run');
    assert.ok([...allowed].every(t => used.has(t)), 'and nothing else is');
  });

  ok('the page runs only its own commands; busy stays on until every action is done', async () => {
    const vs = fakeCode(os.tmpdir(), {});
    let posted = [];
    let release;
    const gate = new Promise(r => { release = r; });
    vs.window.createWebviewPanel = () => ({ webview: { html: '', options: {}, cspSource: 'x', asWebviewUri: u => u, onDidReceiveMessage: fn => { vs.onMsg = fn; return { dispose() {} }; }, postMessage: m => { posted.push(m); return Promise.resolve(true); } },
      onDidDispose: () => ({ dispose() {} }), reveal() {}, iconPath: null });
    const [page] = loadWith(vs, ['../releasePage']);
    const ui = { onChange() {}, snapshot: async () => ({}), act: async n => { if (n === 'slow') await gate; }, openById: async () => {} };
    page.activate({ subscriptions: { push() {} }, extensionUri: vs.Uri.file(os.tmpdir()), workspaceState: { get: () => null, update: async () => {} } }, ui, null, (id, fn) => { vs.registered[id] = fn; });
    await vs.registered['cmr.page.open']();
    await vs.onMsg({ type: 'tool', id: 'workbench.action.files.delete' });
    await vs.onMsg({ type: 'tool', id: 'cmr.validate.run' });
    assert.deepStrictEqual(vs.log.commands.map(c => c[0]).filter(c => /^cmr|^workbench/.test(c)), ['cmr.validate.run'], 'a command the page does not use is not run');
    posted = [];
    const slow = vs.onMsg({ type: 'act', name: 'slow' });
    await vs.onMsg({ type: 'act', name: 'quick' });
    assert.ok(!posted.some(m => m.type === 'busy' && m.on === false), 'still busy while the slow one runs');
    release(); await slow;
    assert.ok(posted.some(m => m.type === 'busy' && m.on === false), 'and not after');
  });

  ok('one Copado action at a time: a second click while one runs is told so; an expired login while following a deployment shows on the tab', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra one '));
    const api = require('./fixtures/failed-org').failedOrg();
    const vs = fakeCode(root, {});
    const [ui] = loadWith(vs, ['../promotionUi']);
    let loginOk = true;
    ui.activate({ subscriptions: { push() {} }, workspaceState: { get: (k, d) => d, update: async () => {} } }, {
      output: { appendLine() {} }, rc: () => ({ copadoOrg: 'copado', sfPath: 'sf', environmentOrgs: {} }), cmd: (id, fn) => { vs.registered[id] = fn; },
      requireTrust() {}, projectRoot: () => root, apiVersion: async () => '62.0', copadoApi: () => { if (!loginOk) throw new Error('Your Salesforce session expired - log in again with sf org login web'); return api; },
      deps: { storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), promoMerge: async () => ({ ok: false }), startSession: async () => {} },
      orgList: async () => [], credentialsFor: async () => [], orgForEnvironment: async () => null, runBranchCheck: async () => {}, validatePromotionBranch: async () => {},
      onValidation: () => ({ dispose() {} }), validationStatus: () => null, showCopadoErrors: async f => f, readinessReport: async () => {}, sfcli: { openPath: async () => {} }
    });
    const realTimeout = global.setTimeout;
    global.setTimeout = () => 0;
    try {
      // two opens at once: the second is told to wait, the first finishes
      const first = ui.act('open', { ref: 'P0042' });
      await ui.act('open', { ref: 'P0042' });
      assert.ok(vs.log.info.some(m => m === 'Still busy with opening the promotion - one moment.'));
      await first;
      assert.strictEqual((await ui.snapshot()).current.promotion.name, 'P0042');
      // the login runs out while following Copado's deployment: said on the tab, nothing thrown away
      loginOk = false;
      await ui.act('jobs', {});
      const j = (await ui.snapshot()).current.jobs;
      assert.ok(j && /session expired/.test(j.error) && j.watching === false, JSON.stringify(j));
    } finally { global.setTimeout = realTimeout; await ui.act('stopWatch', {}); rmTree(root); }
  });

  section('3.2.0: simpler words');

  ok('results say "Validated successfully" or "Validation failed" - never "it would deploy" - in the page, notifications and logs', () => {
    const root = path.join(__dirname, '..');
    const said = ['media/page.js', 'release.js', 'promotionUi.js', 'lifecycleUi.js', 'extension.js'].map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]);
    const strings = ([f, src]) => [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map(m => [f, m[1]]);
    const left = said.flatMap(strings).filter(([, t]) => /would (not )?deploy/i.test(t));
    assert.deepStrictEqual(left, [], 'no "would deploy" left in what you read');
    const page = fs.readFileSync(path.join(root, 'media', 'page.js'), 'utf8');
    for (const w of ['Validated successfully', 'Validation failed', 'Validate again', 'Open file']) assert.ok(page.includes("'" + w) || page.includes(w + "'"), w);
  });

  section('3.3.0: XML compared element by element');

  // generic look-alikes of real metadata shapes - no names from any org
  const XC = () => require('../src/xmlCompare');
  const kindsOf = r => r.list.map(c => [c.kind, c.bStart + 1, c.label || (c.added[0] || c.removed[0] || '').trim()]);
  const fieldBlock = (beh, f, id) => '        <itemInstances>\n            <fieldInstance>\n                <fieldInstanceProperties>\n                    <name>uiBehavior</name>\n                    <value>' + beh + '</value>\n                </fieldInstanceProperties>\n                <fieldItem>Record.' + f + '</fieldItem>\n                <identifier>Record' + id + '</identifier>\n            </fieldInstance>\n        </itemInstances>\n';
  const flexi = body => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n' + body + '        <name>main</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
  /** Every change's action, applied to your resolution, must leave well-formed XML. */
  const actionsKeepXml = (mine, r) => {
    const W = require('../src/promotionWork'), X = require('../src/xmlParser');
    for (const c of r.list) {
      if (!c.undo) continue;
      const lines = mine.split(/(?<=\n)/);
      const at = lines.slice(c.undo.bStart, c.undo.bEnd).map(l => l.replace(/\r?\n$/, ''));
      assert.deepStrictEqual(at, c.undo.expect, 'the action finds its lines: ' + c.label);
      const after = lines.slice(0, c.undo.bStart).join('') + c.undo.insert + lines.slice(c.undo.bEnd).join('');
      assert.strictEqual(W.wellFormed(after, X), null, 'well-formed after "' + c.kind + ' ' + c.label + '"');
    }
  };

  ok('a deleted block is one change, where it was - not its lines paired with the next block\u2019s', () => {
    const T = flexi(fieldBlock('none', 'Team__c', 'Team_cField') + fieldBlock('readonly', 'Region__c', 'Region_cField') + fieldBlock('readonly', 'Data_App__c', 'Data_App_cField'));
    const mine = flexi(fieldBlock('none', 'Team__c', 'Team_cField') + fieldBlock('readonly', 'Data_App__c', 'Data_App_cField'));
    const r = XC().compare(T, T, mine, { type: 'FlexiPage' });
    assert.deepStrictEqual(kindsOf(r), [['removed', 14, 'fieldInstance RecordRegion_cField (10 lines)']]);
    assert.ok(require('../src/linediff').changes(T, mine).length > 1, 'the line comparison splits it - which is why');
    actionsKeepXml(mine, r);
    const back = mine.split(/(?<=\n)/); back.splice(r.list[0].undo.bStart, 0, r.list[0].undo.insert);
    assert.strictEqual(back.join(''), T, 'Restore puts the block back exactly');
  });

  ok('a value changed in a property is one change, named by the property - and from the feature or yours', () => {
    const T = flexi(fieldBlock('none', 'Team__c', 'Team_cField') + fieldBlock('readonly', 'Region__c', 'Region_cField'));
    const F = flexi(fieldBlock('required', 'Team__c', 'Team_cField') + fieldBlock('readonly', 'Region__c', 'Region_cField'));
    assert.deepStrictEqual(kindsOf(XC().compare(T, F, F, { type: 'FlexiPage' })), [['changed-feature', 8, 'uiBehavior: none \u2192 required']]);
    const mine = F.replace('<value>required</value>', '<value>edit</value>');
    assert.deepStrictEqual(kindsOf(XC().compare(T, F, mine, { type: 'FlexiPage' })), [['changed-own', 8, 'uiBehavior: none \u2192 edit']]);
    actionsKeepXml(mine, XC().compare(T, F, mine, { type: 'FlexiPage' }));
  });

  ok('what the feature added and you left out is marked where it would go; kept, it is from the feature', () => {
    const T = flexi(fieldBlock('none', 'Team__c', 'Team_cField') + fieldBlock('readonly', 'Region__c', 'Region_cField'));
    const F = flexi(fieldBlock('none', 'Team__c', 'Team_cField') + fieldBlock('readonly', 'Region__c', 'Region_cField') + fieldBlock('edit', 'New__c', 'New_cField'));
    const r = XC().compare(T, F, T, { type: 'FlexiPage' });
    assert.deepStrictEqual(kindsOf(r), [['dropped', 24, 'fieldInstance RecordNew_cField (10 lines)']]);
    actionsKeepXml(T, r);
    assert.deepStrictEqual(kindsOf(XC().compare(T, F, F, { type: 'FlexiPage' })), [['feature', 24, 'fieldInstance RecordNew_cField (10 lines)']]);
  });

  ok('lists whose order is their meaning - layout columns, flow conditions - are matched in order, identical ones first', () => {
    const col = items => '            <layoutColumns>\n' + items.map(f => '                <layoutItems>\n                    <behavior>Edit</behavior>\n                    <field>' + f + '</field>\n                </layoutItems>\n').join('') + '            </layoutColumns>\n';
    const layout = (c1, c2) => '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n    <layoutSections>\n        <label>Information</label>\n' + col(c1) + col(c2) + '    </layoutSections>\n</Layout>\n';
    const mine = layout(['Name'], ['Owner', 'Phone']);
    const r = XC().compare(layout(['Name', 'Phone'], ['Owner']), null, mine, { type: 'Layout' });
    assert.deepStrictEqual(kindsOf(r), [['removed', 9, 'layoutItems Phone (4 lines)'], ['own', 15, 'layoutItems Phone (4 lines)']], 'a column of one item is still a column, not that item');
    actionsKeepXml(mine, r);
    const cond = (l, v) => '            <conditions>\n                <leftValueReference>' + l + '</leftValueReference>\n                <operator>EqualTo</operator>\n                <rightValue>\n                    <stringValue>' + v + '</stringValue>\n                </rightValue>\n            </conditions>\n';
    const flow = cs => '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <decisions>\n        <name>Check</name>\n        <rules>\n            <name>Yes</name>\n' + cs.join('') + '        </rules>\n    </decisions>\n</Flow>\n';
    const fm = flow([cond('$Record.A', '1'), cond('$Record.B', '2'), cond('$Record.C', '3')]);
    const fr = XC().compare(flow([cond('$Record.A', '1'), cond('$Record.C', '3')]), null, fm, { type: 'Flow' });
    assert.deepStrictEqual(kindsOf(fr), [['own', 13, 'conditions (7 lines)']], 'a condition inserted in the middle is one added condition');
    actionsKeepXml(fm, fr);
  });

  ok('long text inside one element - a formula, a JSON schema - is compared line by line within it', () => {
    const vr = f => '<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Rule_1</fullName>\n    <errorConditionFormula>AND(\n  NOT(ISNEW()),\n  ' + f + '\n)</errorConditionFormula>\n</ValidationRule>\n';
    const r = XC().compare(vr('ISCHANGED(Stage__c)'), null, vr('ISCHANGED(Scenario__c)'), { type: 'ValidationRule' });
    assert.deepStrictEqual(r.list.map(c => [c.kind, c.bStart + 1, c.added[0].trim(), c.context]), [['changed-own', 5, 'ISCHANGED(Scenario__c)', 'in errorConditionFormula']]);
    const schema = extra => '<ExternalServiceRegistration xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>Ctx</label>\n    <schema>{\n  &quot;type&quot;:&quot;object&quot;,\n  &quot;properties&quot;:{\n    &quot;id&quot;:{&quot;type&quot;:&quot;string&quot;},\n' + extra + '    &quot;name&quot;:{&quot;type&quot;:&quot;string&quot;}\n  }\n}</schema>\n</ExternalServiceRegistration>\n';
    const sf = schema('    &quot;region&quot;:{&quot;type&quot;:&quot;string&quot;},\n');
    const sr = XC().compare(schema(''), sf, sf, { type: 'ExternalServiceRegistration' });
    assert.deepStrictEqual(sr.list.map(c => [c.kind, c.bStart + 1, c.context]), [['feature', 7, 'in schema']], 'one line of a long schema, from the feature');
    assert.deepStrictEqual(XC().compare(sf, sf, sf.replace('  }\n}', '  }   \n}'), { type: 'ExternalServiceRegistration' }).list, [], 'spaces only: not a change');
    actionsKeepXml(sf, sr);
  });

  ok('keyed entries are matched by their key - a permission set\u2019s field permission, named by its field; quick on a big file', () => {
    const fp = (f, e) => '    <fieldPermissions>\n        <editable>' + e + '</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
    const ps = n => '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + Array.from({ length: n }, (_, i) => fp('Account.F' + i + '__c', 'true')).join('') + '</PermissionSet>\n';
    const big = ps(3600), mine = big.replace(/(<editable>)true(<\/editable>\n        <field>Account\.F7__c<)/, '$1false$2');
    const t0 = Date.now();
    const r = XC().compare(big, big, mine, { type: 'PermissionSet' });
    const ms = Date.now() - t0;
    assert.deepStrictEqual(kindsOf(r), [['changed-own', 38, 'Account.F7__c editable: true \u2192 false']]);
    assert.ok(ms < 3000, big.split('\n').length + ' lines compared in ' + ms + ' ms');
    // a value that is the entry's own key is not said twice
    const rl = '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n    <relatedLists>\n        <relatedList>Quote.Account__c</relatedList>\n    </relatedLists>\n</Layout>\n';
    assert.deepStrictEqual(kindsOf(XC().compare(rl, null, rl.replace('Quote.Account__c', 'Quote.Opportunity__c'), { type: 'Layout' })), [['changed-own', 3, 'relatedList: Quote.Account__c \u2192 Quote.Opportunity__c']]);
  });

  ok('while your resolution is not valid XML the comparison holds', () => {
    const T = flexi(fieldBlock('none', 'Team__c', 'Team_cField'));
    assert.deepStrictEqual(XC().compare(T, T, T.replace('</fieldInstance>', ''), { type: 'FlexiPage' }), { hold: true, list: [], counts: {} });
  });

  section('3.4.0: the merge editor - our own panel, lined up element by element');

  const MA = () => require('../src/mergeAlign');
  const fBlock = (beh, f, id) => '        <itemInstances>\n            <fieldInstance>\n                <fieldInstanceProperties>\n                    <name>uiBehavior</name>\n                    <value>' + beh + '</value>\n                </fieldInstanceProperties>\n                <fieldItem>Record.' + f + '</fieldItem>\n                <identifier>Record' + id + '</identifier>\n            </fieldInstance>\n        </itemInstances>\n';
  const fPage = body => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n' + body + '        <name>main</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
  const TEAMb = (b = 'none') => fBlock(b, 'Team__c', 'Team_cField'), REGb = fBlock('readonly', 'Region__c', 'Region_cField'), APPb = fBlock('readonly', 'Data_App__c', 'Data_App_cField'), OWNb = fBlock('edit', 'Owner__c', 'Owner_cField');
  const T4 = fPage(TEAMb() + REGb + APPb + OWNb);
  /** Applies a button's line edits the way the page does: all at once, each only if its lines are still what was marked. */
  const applyOps = (text, ops) => {
    const L = text.split(/(?<=\n)/);
    for (const o of ops) assert.deepStrictEqual(L.slice(o.b0, o.b1).map(l => l.replace(/\r?\n$/, '')), o.expect, 'the lines are still what was marked');
    for (const o of [...ops].sort((p, q) => q.b0 - p.b0)) L.splice(o.b0, o.b1 - o.b0, ...(o.insert ? o.insert.split(/(?<=\n)/) : []));
    return L.join('');
  };
  /** The pieces cover your resolution - every line once, in order - and the left pane is their target lines. */
  const covers = (r, mine) => {
    assert.ok(r.ok, 'the pieces cover every line');
    let b = 0; for (const p of r.pieces) { assert.strictEqual(p.b0, b); b = p.b1; }
    assert.strictEqual(b, mine.split(/(?<=\n)/).length);
    assert.strictEqual(r.left, r.pieces.map(p => (p.left || []).join('')).join(''));
  };

  ok('a block moved and nothing else: removed from its place, added by you at the new one - linked, the left pane the target as it is, and either half puts it back in one step', () => {
    const mine = fPage(REGb + APPb + TEAMb() + OWNb);
    const r = MA().align(T4, T4, mine, { type: 'FlexiPage' });
    covers(r, mine);
    assert.deepStrictEqual(r.moves, [], 'no moves: what it is to the file');
    const ch = r.pieces.filter(p => p.kind !== 'same');
    assert.deepStrictEqual(ch.map(p => [p.kind, p.label.replace(/ \(\d+ lines\)$/, '')]).sort(), [['own', 'fieldInstance RecordTeam_cField'], ['removed', 'fieldInstance RecordTeam_cField']], 'yours: the feature branch did not move it');
    assert.strictEqual(r.left, T4, 'the left pane is the target, in its own order');
    const rem = ch.find(p => p.kind === 'removed'), add = ch.find(p => p.kind === 'own');
    assert.ok(rem.now > 0 && add.was > 0 && rem.now === add.b0 + 1 && add.was === rem.b0 + 1, 'linked: "now at line", "from line"');
    assert.strictEqual(applyOps(mine, rem.undo), T4, 'Restore: back, and the copy gone');
    assert.strictEqual(applyOps(mine, add.undo), T4, 'Undo: the same');
  });


  ok('moved and edited: removed from its place, added by you at the new one - not linked, as it is not the same - and undoing both gives the target', () => {
    const mine = fPage(REGb + TEAMb('required') + APPb + OWNb);
    const r = MA().align(T4, T4, mine, { type: 'FlexiPage' });
    covers(r, mine);
    const ch = r.pieces.filter(p => p.kind !== 'same');
    assert.deepStrictEqual(ch.map(p => p.kind).sort(), ['own', 'removed']);
    assert.ok(ch.every(p => p.now == null && p.was == null), 'not linked: it changed');
    const add = ch.find(p => p.kind === 'own');
    const once = applyOps(mine, add.undo);
    const r2 = MA().align(T4, T4, once, { type: 'FlexiPage' });
    assert.strictEqual(applyOps(once, r2.pieces.find(p => p.kind === 'removed').undo), T4);
  });


  ok('removed and left out: no lines on your side, the target\u2019s and the feature\u2019s shown where they were; Restore and Add it back put them back exactly', () => {
    const F = fPage(TEAMb() + REGb + APPb + OWNb + fBlock('edit', 'New__c', 'New_cField'));
    const mine = fPage(TEAMb() + REGb + APPb);
    const r = MA().align(T4, F, mine, { type: 'FlexiPage' });
    covers(r, mine);
    const gone = r.pieces.filter(p => p.kind !== 'same');
    assert.deepStrictEqual(gone.map(p => [p.kind, p.label, p.b1 - p.b0, (p.ghost || []).length]), [['removed', 'fieldInstance RecordOwner_cField (10 lines)', 0, 10], ['dropped', 'fieldInstance RecordNew_cField (10 lines)', 0, 10]]);
    assert.strictEqual(applyOps(mine, gone[0].undo), T4, 'Restore');
    assert.strictEqual(applyOps(mine, gone[1].undo), fPage(TEAMb() + REGb + APPb + fBlock('edit', 'New__c', 'New_cField')), 'Add it back');
    const kept = MA().align(T4, F, F, { type: 'FlexiPage' });
    assert.deepStrictEqual(kept.pieces.filter(p => p.kind !== 'same').map(p => p.kind), ['feature'], 'kept, it is from the feature');
  });

  ok('where order does not matter - a permission set\u2019s entries - a reorder is no move; literal order compares the target as it is; invalid XML holds', () => {
    const fp = f => '    <fieldPermissions>\n        <editable>true</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
    const ps = fs_ => '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + fs_.map(fp).join('') + '</PermissionSet>\n';
    const A = ps(['Account.A__c', 'Account.B__c', 'Account.C__c']), B = ps(['Account.C__c', 'Account.A__c', 'Account.B__c']);
    const r = MA().align(A, A, B, { type: 'PermissionSet' });
    covers(r, B);
    assert.deepStrictEqual([r.moves.length, r.pieces.filter(p => p.kind !== 'same').length], [0, 0]);
    const mine = fPage(REGb + APPb + TEAMb() + OWNb);
    const lit = MA().align(T4, T4, mine, { type: 'FlexiPage', mode: 'literal' });
    covers(lit, mine);
    assert.strictEqual(lit.left, T4, 'literal order: the target as it is');
    assert.ok(lit.pieces.some(p => p.kind !== 'same') && !lit.moves.length);
    assert.deepStrictEqual(MA().align(T4, T4, mine.replace('</fieldInstance>', ''), { type: 'FlexiPage' }), { hold: true });
  });

  ok('long text inside one element is lined up line by line; text that is not XML is compared by lines', () => {
    const vr = f => '<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Rule_1</fullName>\n    <errorConditionFormula>AND(\n  NOT(ISNEW()),\n  ' + f + '\n)</errorConditionFormula>\n</ValidationRule>\n';
    const mine = vr('ISCHANGED(Scenario__c)');
    const r = MA().align(vr('ISCHANGED(Stage__c)'), null, mine, { type: 'ValidationRule' });
    covers(r, mine);
    assert.deepStrictEqual(r.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, p.b0 + 1, p.label, p.context]), [['changed-own', 5, 'ISCHANGED(Scenario__c)', 'in errorConditionFormula']]);
    const code = 'a\nb\nc\n';
    const c = MA().align(code, code, 'a\nB\nc\n', {});
    assert.strictEqual(c.mode, 'literal'); covers(c, 'a\nB\nc\n');
  });

  ok('Review in merge opens the merge editor: its own panel under a strict content policy, the pieces sent to it, compared again as you type; Save keeps it open, Save and close applies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra me '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const T = '<?xml version="1.0" encoding="UTF-8"?>\n<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n    <relatedLists>\n        <fields>OPPORTUNITY.NAME</fields>\n        <fields>QUOTE.TOTALPRICE</fields>\n        <relatedList>Quote.Account__c</relatedList>\n    </relatedLists>\n</Layout>\n';
      const target = put('target.layout-meta.xml', T);
      const incoming = put('feature.layout-meta.xml', T.replace('<fields>QUOTE.TOTALPRICE</fields>\n', '<fields>QUOTE.TOTALPRICE</fields>\n        <fields>QUOTE.SUBTOTAL</fields>\n'));
      const resolved = put('resolved.layout-meta.xml', '');
      const mv = await realMergeView(root, {});
      const { vs } = mv;
      let applied = 0;
      const start = () => mv.deps().startSession(vs.Uri.file(target), vs.Uri.file(incoming), null, { labels: { target: 'Target branch (HEAD)', incoming: 'Feature branch', merged: 'Your resolution (editable)' },
        applyToUri: vs.Uri.file(resolved), applyOnSave: true, openAfterApply: false, theirs: 'the feature branch', onApplied: () => { applied++; } });
      await start();
      assert.strictEqual(mv.webviews.length, 1, 'the merge editor opened');
      assert.ok(!vs.log.commands.some(c => c[0] === 'vscode.diff'), 'in place of VS Code\u2019s diff view');
      assert.ok(!vs.log.commands.some(c => c[0] === 'setContext' && c[1] === 'cmr.activeMerge' && c[2] === true), 'the side bar\u2019s Merge view and its commands stay hidden: the panel is the one place for this merge');
      const w = mv.webviews[0];
      assert.strictEqual(w.title, 'Merge \u00b7 target.layout-meta.xml');
      const html = w.panel.webview.html;
      const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
      assert.ok(/default-src 'none'/.test(policy) && /script-src vscode-resource: 'nonce-[A-Za-z0-9]{32}'/.test(policy) && !/unsafe-eval/.test(policy), policy);
      assert.ok(/monaco\/vs\/loader\.js/.test(html) && /merge\.js/.test(html) && /data-vs="vscode-resource:[^"]*monaco\/vs"/.test(html));
      await w.send({ type: 'ready' });
      const init = w.last('init');
      assert.ok(init && init.text.includes('QUOTE.SUBTOTAL'), 'it opens on the suggestion');
      assert.deepStrictEqual(init.marks.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, p.label]), [['feature', 'fields QUOTE.SUBTOTAL']]);
      assert.deepStrictEqual([init.labels.target, init.theirs], ['Target branch (HEAD)', 'the feature branch']);
      assert.strictEqual(init.applyOnly, false, 'a promotion\u2019s merge saves as your resolution as you go');
      // you take the total out: compared again, with Restore
      const mine = init.text.replace('        <fields>QUOTE.TOTALPRICE</fields>\n', '');
      await w.send({ type: 'text', seq: 1, text: mine });
      const marks = w.last('marks');
      assert.strictEqual(marks.seq, 1);
      assert.deepStrictEqual(marks.marks.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, p.label]), [['removed', 'fields QUOTE.TOTALPRICE'], ['feature', 'fields QUOTE.SUBTOTAL']]);
      assert.strictEqual(applyOps(mine, marks.marks.pieces.find(p => p.kind === 'removed').undo), init.text, 'Restore');
      await w.send({ type: 'text', seq: 2, text: mine.replace('</relatedLists>', '') });
      const held = w.last('marks');
      assert.deepStrictEqual([held.seq, held.hold, held.xmlError && held.xmlError.line > 0, typeof (held.xmlError && held.xmlError.message)], [2, true, true, 'string'], 'not valid XML: the marks hold, and it says where');
      await w.send({ type: 'dirty', dirty: true });
      assert.strictEqual(w.title, '\u25cf Merge \u00b7 target.layout-meta.xml', 'unsaved');
      // Save: your resolution written, the promotion told, the panel still open
      await w.send({ type: 'save', close: false, text: mine });
      assert.strictEqual(fs.readFileSync(resolved, 'utf8'), mine);
      assert.strictEqual(applied, 1);
      assert.deepStrictEqual([w.last('saved').ok, w.last('saved').message, w.disposed], [true, 'Saved as your resolution', false]);
      // the side bar's reveal reaches the panel
      // Save and close: applied, and the merge ends with its panel
      await w.send({ type: 'save', close: true, text: mine });
      assert.ok(w.disposed, 'closed');
      assert.strictEqual(fs.readFileSync(resolved, 'utf8'), mine);
      assert.strictEqual(applied, 2);
      // Discard: nothing written; closing the tab ends the merge too
      await start();
      const w2 = mv.webviews[1];
      await w2.send({ type: 'ready' });
      // discarding asks first
      vs.answers.warn.push({ re: /^Discard this merge\?/, v: 'Discard' });
      await w2.send({ type: 'discard' });
      assert.ok(w2.disposed);
      assert.strictEqual(fs.readFileSync(resolved, 'utf8'), mine, 'discarding writes nothing');
      // a plain merge: applied into the target once, as before - not saved as you go
      await mv.deps().startSession(vs.Uri.file(target), vs.Uri.file(incoming), null, {});
      const wp = mv.webviews[2];
      await wp.send({ type: 'ready' });
      assert.strictEqual(wp.last('init').applyOnly, true);
      wp.panel.dispose();
      await start();
      const w3 = mv.webviews[3];
      w3.panel.dispose();
      await start();
      assert.strictEqual(mv.webviews.length, 5, 'a closed panel ended its merge: the next one opens');
    } finally { rmTree(root); }
  });

  section('3.5.0: nothing merged behind your back - what the feature branch removed is shown');

  // the highlights panel's actions: the target has five, the feature branch removed two
  const hAct = (v, rule) => '                        <valueListItems>\n                            <value>' + v + '</value>\n' + (rule ? '                            <visibilityRule>\n                                <criteria>\n                                    <leftValue>{!Record.IsClosed}</leftValue>\n                                    <operator>EQUAL</operator>\n                                    <rightValue>false</rightValue>\n                                </criteria>\n                            </visibilityRule>\n' : '') + '                        </valueListItems>\n';
  const hPage = (acts, beh) => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + acts.map(x => hAct(x[0], x[1])).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <componentInstanceProperties>\n                    <name>uiBehavior</name>\n                    <value>' + (beh || 'none') + '</value>\n                </componentInstanceProperties>\n                <componentName>force:highlightsPanel</componentName>\n                <identifier>force_highlightsPanel</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
  const HT = hPage([['Edit'], ['NewCase', true], ['LogACall', true], ['Delete'], ['Clone']]), HF = hPage([['Edit'], ['Delete'], ['Clone']]);
  const engine = (t, f) => require('../src/mergeJob').runMergeJob({ targetText: t, incomingText: f, ancestorText: null, merge: { dedupe: true, keep: 'first', keepTarget: [], winner: 'incoming' },
    format: { indent: 4, indentChar: ' ', eol: '\n', elementOrder: 'preserve', sortCollections: false, typeOrder: {}, leadingElements: {} }, normalize: true, rules: { enable: false } });

  ok('a page component the feature branch changed is merged inside it, matched by its identifier - never added a second time', () => {
    const job = engine(HT, HF);
    assert.strictEqual((job.mergedText.match(/<identifier>force_highlightsPanel</g) || []).length, 1, 'one highlights panel');
    assert.ok(/NewCase/.test(job.mergedText) && /LogACall/.test(job.mergedText), 'merging keeps what the target has - which is why it is marked');
  });

  ok('what the feature branch does not have, still in your resolution, is marked where order matters - Remove gives the feature branch\u2019s version', () => {
    const job = engine(HT, HF);
    let r = MA().align(job.targetText, job.incomingText, job.mergedText, { type: 'FlexiPage' });
    assert.deepStrictEqual(r.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, p.label]), [['kept', 'valueListItems NewCase (10 lines)'], ['kept', 'valueListItems LogACall (10 lines)']]);
    assert.strictEqual(r.counts.kept, 2);
    let t = job.mergedText;
    for (let i = 0; i < 2; i++) { r = MA().align(job.targetText, job.incomingText, t, { type: 'FlexiPage' }); t = applyOps(t, r.pieces.find(p => p.kind === 'kept').undo); }
    assert.strictEqual(t, job.incomingText);
    // started from the feature branch: the target's two, not in it, struck through with Restore
    const ff = MA().align(job.targetText, job.incomingText, job.incomingText, { type: 'FlexiPage' });
    assert.deepStrictEqual(ff.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, !!p.notInFeature]), [['removed', true], ['removed', true]]);
  });

  ok('a value the feature branch changed, where you have the target\u2019s, is marked - Use feature gives it', () => {
    const F = hPage([['Edit'], ['NewCase', true], ['LogACall', true], ['Delete'], ['Clone']], 'required');
    const r = MA().align(HT, F, HT, { type: 'FlexiPage' });
    const d = r.pieces.filter(p => p.kind !== 'same');
    assert.deepStrictEqual(d.map(p => [p.kind, p.label]), [['differs', 'uiBehavior: required (here: none)']]);
    assert.strictEqual(applyOps(HT, d[0].undo), F);
  });

  ok('where Salesforce sorts the entries itself - permission sets, profiles - an entry the feature file lacks is not marked: files are often retrieved in part', () => {
    const fp = f => '    <fieldPermissions>\n        <editable>true</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
    const ps = l => '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + l.map(fp).join('') + '</PermissionSet>\n';
    const r = MA().align(ps(['A.a', 'A.b', 'A.c']), ps(['A.a']), ps(['A.a', 'A.b', 'A.c']), { type: 'PermissionSet' });
    assert.deepStrictEqual(r.pieces.filter(p => p.kind !== 'same'), []);
  });

  ok('where your resolution starts: the merged result for permission sets, profiles, labels, translations, objects; the feature branch\u2019s file for everything else - or as set', () => {
    const { startFor } = require('../src/mergeStart');
    // an object's own file is like any other: the feature's version - only access and translations add up
    assert.strictEqual(startFor('CustomObject', 'auto'), 'feature');
    for (const t of ['Profile', 'PermissionSet', 'MutingPermissionSet', 'CustomLabels', 'Translations', 'CustomObjectTranslation']) assert.strictEqual(startFor(t, 'auto'), 'merged', t);
    for (const t of ['FlexiPage', 'Layout', 'Flow', 'ValidationRule', 'ExpressionSetDefinitionVersion', null]) assert.strictEqual(startFor(t, 'auto'), 'feature', String(t));
    for (const k of ['feature', 'target', 'merged']) assert.strictEqual(startFor('FlexiPage', k), k);
    const pkg = require('../package.json').contributes.configuration;
    const all = Object.assign({}, ...(Array.isArray(pkg) ? pkg : [pkg]).map(c => c.properties));
    assert.deepStrictEqual([all['cmr.merge.startFrom'].default, all['cmr.merge.startFrom'].enum], ['auto', ['auto', 'feature', 'target', 'merged']]);
  });

  ok('the promotion page: a merge that keeps what the feature branch does not have is never accepted in one click, nor resolved automatically; one it cannot check, neither', async () => {
    const W = require('../src/promotionWork');
    const conflicted = '<<<<<<< HEAD\n' + HT + '=======\n' + HF + '>>>>>>> feature/x\n';
    const merge = async (x, y, z) => { const j = engine(x, y); return { ok: j.ok, mergedText: j.mergedText, conflicts: 0 }; };
    for (const auto of [false, true]) {
      const r = await W.autoResolve('force-app/main/default/flexipages/Case.flexipage-meta.xml', conflicted, merge, auto);
      assert.deepStrictEqual([r.state, r.suggestion, r.featureLacks, r.note], ['review', false, 2, '2 blocks the feature branch does not have - review in merge'], 'auto ' + auto);
    }
    // nothing the feature lacks: a suggestion, as before
    const same = '<<<<<<< HEAD\n' + HF + '=======\n' + HT + '>>>>>>> feature/x\n';
    const s2 = await W.autoResolve('force-app/main/default/flexipages/Case.flexipage-meta.xml', same, merge, false);
    assert.deepStrictEqual([s2.state, s2.suggestion, s2.featureLacks], ['review', true, 0]);
  });

  ok('the merge editor opens where the rule says - a page on the feature branch\u2019s file, a permission set on the merge - with Start from offering the others', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra sf '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const mv = await realMergeView(root, {});
      const { vs } = mv;
      const open = async (name, t, f, extra) => {
        await mv.deps().startSession(vs.Uri.file(put('t-' + name, t)), vs.Uri.file(put('f-' + name, f)), null, Object.assign({ applyToUri: vs.Uri.file(put('r-' + name, '')), applyOnSave: true, openAfterApply: false, theirs: 'the feature branch' }, extra || {}));
        const w = mv.webviews[mv.webviews.length - 1];
        await w.send({ type: 'ready' });
        const init = w.last('init');
        w.panel.dispose();
        return init;
      };
      const page = await open('Case.flexipage-meta.xml', HT, HF);
      assert.strictEqual(page.start, 'feature');
      assert.ok(!/NewCase/.test(page.text), 'the feature branch\u2019s file: its removals count');
      assert.deepStrictEqual(Object.keys(page.starts).sort(), ['feature', 'merged', 'target']);
      assert.ok(/NewCase/.test(page.starts.merged) && /NewCase/.test(page.starts.target));
      assert.deepStrictEqual(page.marks.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, !!p.notInFeature]), [['removed', true], ['removed', true]], 'the target\u2019s two shown, with Restore');
      const fp = f => '    <fieldPermissions>\n        <editable>true</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
      const ps = l => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + l.map(fp).join('') + '</PermissionSet>\n';
      const perms = await open('Sales.permissionset-meta.xml', ps(['Account.A__c', 'Account.B__c']), ps(['Account.A__c', 'Account.C__c']));
      assert.strictEqual(perms.start, 'merged');
      assert.ok(['A__c', 'B__c', 'C__c'].every(f => perms.text.includes('Account.' + f)), 'both branches\u2019 permissions');
      // a resolution you saved before: where you left it
      const saved = await open('Saved.flexipage-meta.xml', HT, HF, { startFrom: HT.replace('Clone', 'CloneX') });
      assert.strictEqual(saved.start, 'saved');
      assert.ok(saved.text.includes('CloneX'));
    } finally { rmTree(root); }
  });

  section('3.5.2: CI on every system');

  ok('the VS Code tests find VS Code\u2019s program on macOS whatever the build names it; elsewhere, or where it is, the path stays', () => {
    const { vscodeExecutable } = require('./integration/vscodeExecutable');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra exe '));
    try {
      const mac = path.join(root, 'Visual Studio Code.app', 'Contents', 'MacOS');
      fs.mkdirSync(mac, { recursive: true });
      const asked = path.join(mac, 'Electron');
      fs.writeFileSync(path.join(mac, 'Code'), '');
      assert.strictEqual(vscodeExecutable(asked, 'darwin'), path.join(mac, 'Code'), 'renamed: the program that is there');
      assert.strictEqual(vscodeExecutable(asked, 'linux'), asked, 'not macOS: as given');
      fs.writeFileSync(asked, '');
      assert.strictEqual(vscodeExecutable(asked, 'darwin'), asked, 'there: as given');
      fs.rmSync(asked); fs.rmSync(path.join(mac, 'Code')); fs.writeFileSync(path.join(mac, 'Something Else'), '');
      assert.strictEqual(vscodeExecutable(asked, 'darwin'), path.join(mac, 'Something Else'), 'one program: that one');
      fs.writeFileSync(path.join(mac, 'Another'), Buffer.alloc(4096));
      assert.strictEqual(vscodeExecutable(asked, 'darwin'), path.join(mac, 'Another'), 'several, none named for VS Code: the largest - the app\u2019s main program');
      fs.writeFileSync(path.join(mac, 'VSCodeHelper'), '');
      assert.strictEqual(vscodeExecutable(asked, 'darwin'), path.join(mac, 'VSCodeHelper'), 'one with Code in its name');
      assert.strictEqual(vscodeExecutable(path.join(root, 'nowhere', 'Electron'), 'darwin'), path.join(root, 'nowhere', 'Electron'));
    } finally { rmTree(root); }
  });

  ok('VS Code\u2019s user data goes in a short folder: its socket path stays under macOS\u2019s 103 characters', () => {
    const { userDataBase, userDataDir } = require('./integration/vscodeExecutable');
    // the choice, for every system - without making anything: /tmp exists only on macOS and Linux
    assert.strictEqual(userDataBase('darwin'), '/tmp', 'macOS: /tmp - its own temp folder is itself long');
    assert.strictEqual(userDataBase('win32'), os.tmpdir());
    assert.strictEqual(userDataBase('linux'), os.tmpdir());
    // the socket VS Code 1.146 opens there on macOS - versions give it a few characters more, still well under
    assert.ok(('/tmp/cra-ud-XXXXXX/1.146-main.sock').length < 104 - 20);
    // made, for the system this runs on
    const d = userDataDir();
    try {
      assert.ok(fs.existsSync(d) && path.basename(d).startsWith('cra-ud-'), d);
      assert.strictEqual(path.dirname(d), path.resolve(userDataBase()));
    } finally { rmTree(d); }
    const run = fs.readFileSync(path.join(__dirname, 'integration', 'runTest.js'), 'utf8');
    assert.ok(/'--user-data-dir=' \+ data/.test(run), 'the runner passes it to VS Code');
    assert.ok(/process\.exitCode = 1/.test(run) && !/process\.exit\(1\)/.test(run), 'a failed run still tidies up before exiting');
  });

  ok('temporary folders are removed patiently and a folder that will not go never fails a test', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra rm '));
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'f.xml'), 'x');
    rmTree(root);
    assert.ok(!fs.existsSync(root));
    rmTree(root);   // already gone: nothing to do
    const src = fs.readFileSync(path.join(__dirname, 'rmTree.js'), 'utf8');
    assert.ok(/maxRetries: 20/.test(src) && /catch \(e\)/.test(src));
    for (const f of ['smoke.js', 'smoke3.js']) assert.ok(!/fs\.rmSync\([^)]*recursive/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')), f + ' cleans up through rmTree');
  });

  section('3.5.5: releases from CI');

  ok('a release: a push to main releases a version with no tag yet; a pushed tag must be the version; never without its notes', () => {
    const { decide, notesFor } = require('../scripts/release');
    const log = '# Changelog\n\n## 1.3.0\n\n- New thing.\n- Another.\n\n## 1.2.0\n\n- Older.\n';
    assert.deepStrictEqual(decide({ version: '1.3.0', ref: 'refs/heads/main', tags: ['v1.2.0'], changelog: log }),
      { release: true, tag: 'v1.3.0', version: '1.3.0', prerelease: false, why: 'v1.3.0 is not released yet' });
    const again = decide({ version: '1.3.0', ref: 'refs/heads/main', tags: ['v1.2.0', 'v1.3.0'], changelog: log });
    assert.deepStrictEqual([again.release, again.tag], [false, 'v1.3.0'], 'released already: a push without a new version does nothing');
    assert.strictEqual(decide({ version: '1.3.0', ref: 'refs/tags/v1.3.0', tags: ['v1.3.0'], changelog: log }).release, true, 'the tag pushed by hand');
    assert.throws(() => decide({ version: '1.3.0', ref: 'refs/tags/v1.3.1', tags: [], changelog: log }), /tag v1\.3\.1 does not match package\.json's version 1\.3\.0/);
    assert.throws(() => decide({ version: '1.4.0', ref: 'refs/heads/main', tags: [], changelog: log }), /no "## 1\.4\.0" section/);
    assert.throws(() => decide({ version: 'next', ref: 'refs/heads/main', tags: [], changelog: log }), /not a version/);
    assert.strictEqual(decide({ version: '2.0.0-beta.1', ref: 'refs/heads/main', tags: [], changelog: '## 2.0.0-beta.1\n\n- Try it.\n' }).prerelease, true);
    assert.strictEqual(notesFor(log, '1.3.0'), '- New thing.\n- Another.');
    assert.strictEqual(notesFor(log, '1.2.0'), '- Older.');
    assert.strictEqual(notesFor(log, '1.2'), null, 'the whole version, not a prefix');
    assert.strictEqual(notesFor(log.replace(/\n/g, '\r\n'), '1.2.0'), '- Older.', 'Windows line endings');
    // this repository: its version has its notes
    const pkg = require('../package.json');
    assert.ok(notesFor(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), pkg.version), 'CHANGELOG.md has a section for ' + pkg.version);
  });

  ok('the release workflow: tests first - the whole test workflow - then the .vsix, the tag and the release; the test workflow runs on branches and is callable', () => {
    const wf = f => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8');
    const rel = wf('release.yml'), tst = wf('test.yml');
    assert.ok(/tags: \['v\*'\]/.test(rel) && /branches: \[main, master\]/.test(rel));
    assert.ok(/contents: write/.test(rel) && /cancel-in-progress: false/.test(rel));
    assert.ok(/uses: \.\/\.github\/workflows\/test\.yml/.test(rel), 'the release runs the whole test workflow');
    assert.ok(/needs: \[plan, test\]/.test(rel) && /if: needs\.plan\.outputs\.release == 'true'/.test(rel), 'and publishes only after it');
    for (const step of ['node scripts/release.js plan', 'npm run package', 'npm run package:check', 'node scripts/release.js notes', 'gh release create']) assert.ok(rel.includes(step), step);
    assert.ok(/workflow_call:/.test(tst) && /branches: \['\*\*'\]/.test(tst), 'callable, and not run twice for a tag');
    assert.ok(/group: test-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/.test(tst), 'a release\u2019s tests are not cancelled by a push');
    assert.ok(!/\t/.test(rel + tst), 'YAML indented with spaces');
  });

  section('3.6.0: Hide identical');

  ok('Hide identical: the setting reaches the merge editor, and the toolbar\u2019s choice is kept in it for the next merge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra hide '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const mv = await realMergeView(root, { 'cmr.merge.hideIdentical': true });
      const { vs } = mv;
      await mv.deps().startSession(vs.Uri.file(put('t.flexipage-meta.xml', HT)), vs.Uri.file(put('f.flexipage-meta.xml', HF)), null,
        { applyToUri: vs.Uri.file(put('r.flexipage-meta.xml', '')), applyOnSave: true, openAfterApply: false, theirs: 'the feature branch' });
      const w = mv.webviews[mv.webviews.length - 1];
      await w.send({ type: 'ready' });
      assert.strictEqual(w.last('init').hideIdentical, true, 'the setting reaches the editor');
      assert.ok(/id="viewBtn"/.test(w.panel.webview.html) && /id="viewMenu"/.test(w.panel.webview.html), 'in the toolbar\u2019s View menu');
      await w.send({ type: 'pref', hideIdentical: false });
      assert.strictEqual(vs.config['cmr.merge.hideIdentical'], false, 'kept for the next merge');
      w.panel.dispose();
      const pkg = require('../package.json');
      const all = Object.assign({}, ...pkg.contributes.configuration.map(c => c.properties));
      assert.deepStrictEqual([all['cmr.merge.hideIdentical'].type, all['cmr.merge.hideIdentical'].default], ['boolean', false]);
    } finally { rmTree(root); }
  });

  section('3.7.0: names with special characters; what the stories committed');

  ok('a component whose name has special characters is found on the branch by its encoded file name - "[A] R&D Admin" is "%5BA%5D R%26D Admin" - whatever is encoded in it', async () => {
    const { buildWorkspace } = require('../src/branchCheck');
    const files = {
      'sfdx-project.json': '{"packageDirectories":[{"path":"force-app","default":true}]}',
      'force-app/main/default/profiles/%5BA%5D R%26D System Administrator.profile-meta.xml': '<Profile/>',
      'force-app/main/default/profiles/Custom%3A Sales.profile-meta.xml': '<Profile/>',
      'force-app/main/default/profiles/Admin.profile-meta.xml': '<Profile/>',
      // something no rule in the list encodes - found by its decoded name anyway
      'force-app/main/default/profiles/Ops %7E Lead.profile-meta.xml': '<Profile/>',
      'force-app/main/default/layouts/Account-Sales %28New%29 Layout.layout-meta.xml': '<Layout/>'
    };
    let lists = 0;
    const host = { readFile: async (b, p) => files[p] != null ? Buffer.from(files[p]) : null, listFiles: async (b, f) => { lists++; return Object.keys(files).filter(p => p.startsWith(f + '/')); } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cra bw '));
    try {
      const r = await buildWorkspace(host, 'feature/x', new Map([['Profile', ['[A] R&D System Administrator', '%5BA%5D R%26D System Administrator', 'Custom: Sales', 'Admin', 'Ops ~ Lead', 'Not There']], ['Layout', ['Account-Sales (New) Layout']]]), dir);
      assert.deepStrictEqual(r.missing, ['Profile Not There'], 'only what is not there');
      assert.deepStrictEqual(r.written.map(f => path.posix.basename(f)), ['Account-Sales %28New%29 Layout.layout-meta.xml', '%5BA%5D R%26D System Administrator.profile-meta.xml', 'Admin.profile-meta.xml', 'Custom%3A Sales.profile-meta.xml', 'Ops %7E Lead.profile-meta.xml'], 'each file once');
      assert.ok(fs.existsSync(path.join(dir, 'force-app', 'main', 'default', 'profiles', '%5BA%5D R%26D System Administrator.profile-meta.xml')), 'written under its own name');
      assert.ok(lists <= 4, 'a folder is listed once per branch and package folder, not once per component: ' + lists);
    } finally { rmTree(dir); }
    const { sourcePaths } = require('../src/manifest');
    assert.deepStrictEqual(sourcePaths('Profile', "[A] R&D's + Admin"), ["profiles/[A] R&D's + Admin.profile-meta.xml", 'profiles/%5BA%5D R%26D%27s %2B Admin.profile-meta.xml'], '& \u2019 and + encoded too');
  });

  ok('a file\u2019s component name is decoded - so a resolution matches the commit\u2019s component, and one not resolved yet is left out, not taken from the branch', () => {
    const W = require('../src/promotionWork');
    assert.deepStrictEqual(W.componentOf('force-app/main/default/profiles/%5BA%5D R%26D System Administrator.profile-meta.xml'), { type: 'Profile', name: '[A] R&D System Administrator' });
    assert.deepStrictEqual(W.componentOf('force-app/main/default/layouts/Account-Sales %28New%29 Layout.layout-meta.xml'), { type: 'Layout', name: 'Account-Sales (New) Layout' });
    assert.strictEqual(W.decodeName('100% done'), '100% done', 'not encoding: as it is');
    const M = require('../src/manifest');
    const pkg = M.build(M.parseCommit(JSON.stringify([{ t: 'Profile', n: '%5BA%5D R%26D System Administrator', a: 'Add' }]), 'c'), {});
    assert.ok(pkg.deploy.get('Profile').has(W.componentOf('force-app/main/default/profiles/%5BA%5D R%26D System Administrator.profile-meta.xml').name), 'the file and the package name the same component');
    const rel = fs.readFileSync(path.join(__dirname, '..', 'release.js'), 'utf8');
    assert.ok(/for \(const rel of o\.exclude \|\| \[\]\) \{\s*const comp = require\('\.\/src\/promotionWork'\)\.componentOf\(rel\)/.test(rel), 'the pre-check leaves out by the decoded name');
  });

  ok('what the stories committed: each component and where it stands - a conflict, resolved or not; from the branch; not on the branch', () => {
    const vs = fakeCode(os.tmpdir(), {});
    const [P] = loadWith(vs, ['../promotionUi']);
    const PRO = 'force-app/main/default/profiles/%5BA%5D R%26D System Administrator.profile-meta.xml', LAY = 'force-app/main/default/layouts/Account-Sales Layout.layout-meta.xml';
    const comps = { at: 1, source: 'promotion change list', rows: [
      { type: 'Profile', name: '[A] R&D System Administrator', action: 'Add', stories: ['US-0012345'] },
      { type: 'Layout', name: 'Account-Sales Layout', action: 'Add', stories: ['US-0012345'] },
      { type: 'ApexClass', name: 'OpsService', action: 'Add', stories: [] },
      { type: 'Profile', name: '[B] Other', action: 'Add', stories: [] }] };
    const st = { files: { [PRO]: { state: 'resolved' }, [LAY]: { state: 'review' } }, precheck: null };
    let v = P.componentsView(st, comps);
    assert.deepStrictEqual(v.rows.map(r => [r.name, r.where, r.rel]), [['[A] R&D System Administrator', 'conflict-resolved', PRO], ['Account-Sales Layout', 'conflict-open', LAY], ['OpsService', 'commit', null], ['[B] Other', 'commit', null]]);
    assert.deepStrictEqual([v.checked, v.counts], [false, { all: 4, conflicts: 2, missing: 0 }], 'no pre-check yet');
    st.precheck = { state: 'passed', files: { missing: ['Profile [B] Other'], branches: ['feature/US-0012345'] } };
    v = P.componentsView(st, comps);
    assert.deepStrictEqual(v.rows.map(r => r.where), ['conflict-resolved', 'conflict-open', 'branch', 'missing']);
    assert.deepStrictEqual([v.checked, v.branches, v.counts.missing], [true, ['feature/US-0012345'], 1]);
    assert.deepStrictEqual(P.componentsView(st, { loading: true }), { loading: true }, 'while it is read');
  });

  ok('the page\u2019s Components tab: read when first opened; filters with counts, a name filter; one line per component in columns; type groups that fold; a conflict opens its file', () => {
    const page = runPage();
    const PRO = 'force-app/main/default/profiles/%5BA%5D R%26D System Administrator.profile-meta.xml';
    const cur = { promotion: { id: 'P9', name: 'P12345', status: 'Merge Conflict', from: 'dev', to: 'qa' },
      state: { name: 'P12345', from: 'dev', to: 'qa', syncedAt: new Date().toISOString(), events: [], files: { [PRO]: { state: 'resolved', kind: 'xml', story: 'US-0012345', note: 'yours' } } },
      plan: { ready: [], held: [], last: false, revised: 0 }, canUndo: false, health: [], flagged: {}, info: null, jobs: null, components: null };
    const send = c => page.state({ copadoOrg: 'copado', recent: [], current: Object.assign({}, cur, { components: c }), validation: null });
    send(null);
    page.click({ tab: 'Components' });
    assert.ok(page.posted.some(m => m.type === 'act' && m.name === 'components'), 'read when first opened');
    const asked = page.posted.filter(m => m.name === 'components').length;
    send({ loading: true });
    assert.ok(/Reading what the stories committed/.test(page.text()));
    const rows = checked => [
      { type: 'Profile', name: '[A] R&D System Administrator', action: 'Add', stories: ['US-0012345'], where: 'conflict-resolved', rel: PRO },
      { type: 'Profile', name: '[B] Other', action: 'Add', stories: ['US-0012345'], where: checked ? 'missing' : 'commit', rel: null },
      { type: 'ApexClass', name: 'OpsService', action: 'SelectiveCommit', stories: ['US-0012346'], where: checked ? 'branch' : 'commit', rel: null },
      { type: 'Layout', name: 'Account-Sales Layout', action: 'Delete', stories: ['US-0012346'], where: 'conflict-open', rel: 'force-app/main/default/layouts/Account-Sales Layout.layout-meta.xml' }];
    send({ at: Date.now(), source: 'promotion change list', checked: false, branches: [], counts: { all: 4, conflicts: 2, missing: 0 }, rows: rows(false) });
    let t = page.text();
    assert.ok(/What the stories committed\s+4 components from promotion change list/.test(t), t.slice(0, 300));
    assert.ok(/Run Pre-check to see which components are on the stories\u2019 branches\.\s+Run Pre-check/.test(t), 'one line, with its button');
    assert.ok(/All\s+4\s+To resolve\s+1\s+Resolved\s+1\s+In the commit\s+2/.test(t) && !/On the branch/.test(t), 'filters with counts - the branch ones once a pre-check has run');
    assert.ok(/Component\s+Action\s+Story\s+Where it stands/.test(t), 'columns');
    assert.ok(/Profile\s+2\s+1 resolved/.test(t) && /Layout\s+1\s+1 to resolve/.test(t), 'each type, its count and what needs doing in it');
    assert.ok(/\[A\] R&D System Administrator\s+Add\s+US-0012345\s+Conflict \u00b7 resolved/.test(t) && /OpsService\s+Selective\s+US-0012346\s+In the commit/.test(t) && /Account-Sales Layout\s+Delete\s+US-0012346\s+Conflict \u00b7 to resolve/.test(t), t);
    assert.ok(/class="cact del">Delete/.test(page.html) && /class="cact sel">Selective/.test(page.html), 'the action as a tag');
    assert.ok(page.html.includes('class="crow opens" data-sel="' + PRO + '" data-go="Files"'), 'a conflict opens its file');
    assert.strictEqual(page.posted.filter(m => m.name === 'components').length, asked, 'read once, not on every redraw');
    send({ at: Date.now(), source: 'promotion change list', checked: true, branches: ['feature/US-0012345'], counts: { all: 4, conflicts: 2, missing: 1 }, rows: rows(true) });
    t = page.text();
    assert.ok(/On the branch\s+1\s+Not on the branch\s+1/.test(t) && /1 component was not found on feature\/US-0012345/.test(t), 'after a pre-check');
    page.click({ a: 'compFilter', v: 'open' });
    t = page.text();
    assert.ok(/Account-Sales Layout/.test(t) && !/OpsService/.test(t) && !/R&D System Administrator\s+Add/.test(t), 'filtered: to resolve');
    page.click({ a: 'compFilter', v: 'all' });
    page.click({ a: 'compFold', v: 'Profile' });
    assert.ok(!/\[B\] Other/.test(page.text()) && /class="cgrp folded"/.test(page.html), 'a type folds');
    page.click({ a: 'components' });
    assert.ok(page.posted.filter(m => m.name === 'components').length > asked, 'Read again');
  });


  section('3.8.0: the merge editor - duplicates, broken XML');

  ok('duplicates in the merge editor: found as you type with the line they repeat; only identical ones removed when the merge is prepared', () => {
    const D = require('../src/mergeDuplicates');
    const it = v => '                        <valueListItems>\n                            <value>' + v + '</value>\n                        </valueListItems>\n';
    const pg = acts => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + acts.map(it).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <identifier>hp</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
    const t = pg(['Edit', 'Share', 'Edit']);
    assert.deepStrictEqual(D.inText(t), [{ b0: 14, b1: 17, sameAs: 9, label: 'Edit', identical: true }]);
    const d = D.dedupe(t);
    assert.strictEqual(d.text, pg(['Edit', 'Share']), 'the later copy, its whole lines');
    assert.deepStrictEqual(d.removed, ['<valueListItems><value>Edit</value></valueListItems>']);
    const fp = (f, e) => '    <fieldPermissions>\n        <editable>' + e + '</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
    const ps = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + fp('A.x__c', 'true') + fp('A.x__c', 'false') + '</PermissionSet>\n';
    assert.strictEqual(D.inText(ps).length, 1, 'the same field twice, with different values: found');
    assert.deepStrictEqual([D.dedupe(ps).text, D.dedupe(ps).removed], [ps, []], 'and left - which to keep is your choice');
    assert.deepStrictEqual(D.inText('<a><b>'), [], 'not valid XML: nothing to say');
    // the editor's pieces: the duplicates, and where the XML breaks
    const MP = require('../src/mergePanel');
    const m = MP.marksFor({ target: pg(['Edit', 'Share']), incoming: pg(['Edit', 'Share']), typeName: 'FlexiPage' }, t, 'order');
    assert.deepStrictEqual(m.dups.map(x => [x.b0, x.sameAs]), [[14, 9]]);
    const held = MP.marksFor({ target: t, incoming: t, typeName: 'FlexiPage' }, t.replace('</valueList>', ''), 'order');
    assert.ok(held.hold && held.xmlError.line > 0 && held.xmlError.column > 0 && /valueList/.test(held.xmlError.message), JSON.stringify(held.xmlError));
    // a duplicate removed from a start, then removed in the target too: its row says so
    const removed = new Set(d.removed);
    const two = MP.marksFor({ target: t, incoming: t, typeName: 'FlexiPage', removedDups: removed }, d.text, 'order');
    assert.deepStrictEqual(two.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, !!p.dupRemoved]), [['removed', true]]);
  });

  ok('a merge that starts from a branch\u2019s file has its identical duplicates removed once, when it is prepared - and the merge editor is told how many', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra dd '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const it = v => '                        <valueListItems>\n                            <value>' + v + '</value>\n                        </valueListItems>\n';
      const pg = acts => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + acts.map(it).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <identifier>hp</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
      const mv = await realMergeView(root, {});
      await mv.deps().startSession(mv.vs.Uri.file(put('t.flexipage-meta.xml', pg(['Edit', 'Share']))), mv.vs.Uri.file(put('f.flexipage-meta.xml', pg(['Edit', 'Share', 'Clone', 'Clone']))), null,
        { applyToUri: mv.vs.Uri.file(put('r.flexipage-meta.xml', '')), applyOnSave: true, openAfterApply: false, theirs: 'the feature branch' });
      const w = mv.webviews[mv.webviews.length - 1];
      await w.send({ type: 'ready' });
      const init = w.last('init');
      assert.strictEqual(init.start, 'feature');
      assert.strictEqual((init.text.match(/<value>Clone</g) || []).length, 1, 'the feature branch\u2019s duplicate removed before you see it');
      assert.strictEqual(init.dupRemoved.feature, 1);
      assert.deepStrictEqual(init.marks.dups, [], 'nothing left to mark');
      w.panel.dispose();
    } finally { rmTree(root); }
  });

  section('3.8.0: the Manual tab');

  ok('the Manual tab: two versions pasted or chosen, what each is, merged in the merge editor as a manual merge; a package from a commit; shown while Copado is not connected, or always, or opened for a file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra man '));
    try {
      const vs = fakeCode(root, {});
      const [M] = loadWith(vs, ['../manualUi']);
      const started = [], packaged = [], pages = [];
      let org = '';
      const reg = {};
      M.activate({ subscriptions: [] }, { startSession: async (...a) => { started.push(a); }, generatePackage: async f => { packaged.push(f); },
        storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), copadoOrg: () => org, showPage: async nav => { pages.push(nav); } }, (id, fn) => { reg[id] = fn; });
      const T = '<?xml version="1.0" encoding="UTF-8"?>\n<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fields>A</fields>\n</Layout>\n';
      assert.strictEqual(M.snapshot().show, true, 'always there, with or without Copado');
      await M.act('manual.set', { side: 'target', text: T, name: 'Account-Sales.layout-meta.xml' });
      const s1 = M.snapshot();
      assert.deepStrictEqual([s1.target.type, s1.target.lines, s1.target.valid, s1.target.head.length, s1.incoming], ['Layout', 4, true, 5, null]);
      await M.act('manual.merge');
      assert.strictEqual(started.length, 0, 'not without both versions');
      await M.act('manual.set', { side: 'incoming', text: '<Layout><fields>' });
      assert.deepStrictEqual([M.snapshot().incoming.valid, typeof M.snapshot().incoming.problem], [false, 'string'], 'not valid: said, and why');
      await M.act('manual.merge');
      assert.strictEqual(started.length, 0, 'not while one is not valid XML');
      await M.act('manual.set', { side: 'incoming', text: T.replace('<fields>A</fields>', '<fields>A</fields>\n    <fields>B</fields>') });
      await M.act('manual.swap');
      assert.ok(/B/.test(M.snapshot().target.head.join('')), 'swapped');
      await M.act('manual.swap');
      await M.act('manual.merge');
      assert.strictEqual(started.length, 1);
      const [tUri, iUri, anc, so] = started[0];
      assert.strictEqual(fs.readFileSync(tUri.fsPath, 'utf8'), T, 'the target, as pasted');
      assert.ok(/<fields>B<\/fields>/.test(fs.readFileSync(iUri.fsPath, 'utf8')));
      assert.deepStrictEqual([anc, so.manual, so.applyOnSave, path.basename(tUri.fsPath)], [null, true, false, 'Account-Sales.layout-meta.xml'], 'a manual merge: copied or saved as a file, never written over anything');
      assert.strictEqual(M.snapshot().last.type, 'Layout');
      await M.act('manual.again');
      assert.strictEqual(started.length, 2, 'Open again');
      // the same two versions: the same folder - unsaved changes can come back for exactly them
      assert.strictEqual(started[1][0].fsPath, started[0][0].fsPath);
      // new versions under the same file name: a folder of their own - an earlier merge's file is never read in their place
      const T2 = T.replace('<fields>A</fields>', '<fields>C</fields>');
      await M.act('manual.set', { side: 'target', text: T2, name: 'Account-Sales.layout-meta.xml' });
      await M.act('manual.merge');
      const [t3, i3] = started[2];
      assert.notStrictEqual(t3.fsPath, started[0][0].fsPath, 'another folder');
      assert.deepStrictEqual([path.basename(t3.fsPath), fs.readFileSync(t3.fsPath, 'utf8')], ['Account-Sales.layout-meta.xml', T2], 'the new target, exactly');
      assert.ok(/<fields>B<\/fields>/.test(fs.readFileSync(i3.fsPath, 'utf8')));
      // Clear both: the two sides at once
      await M.act('manual.clearBoth');
      assert.deepStrictEqual([M.snapshot().target, M.snapshot().incoming], [null, null]);
      // a package from a commit file
      await M.act('manual.commitSet', { text: JSON.stringify([{ t: 'ApexClass', n: 'OpsService', a: 'Add' }, { t: 'Layout', n: 'Account-Sales', a: 'Add' }]) });
      assert.strictEqual(M.snapshot().commit.components, 2);
      await M.act('manual.package');
      assert.strictEqual(packaged.length, 1);
      assert.ok(/OpsService/.test(fs.readFileSync(packaged[0][0].fsPath, 'utf8')));
      // Merge in Release Assistant: the file as the target, the tab opened whatever the setting
      const f = path.join(root, 'Case.layout-meta.xml'); fs.writeFileSync(f, T.replace('A', 'C'));
      await reg['cmr.manual.mergeWith'](vs.Uri.file(f));
      assert.deepStrictEqual([M.snapshot().target.name, pages], ['Case.layout-meta.xml', ['Manual']]);
      const pkg = require('../package.json');
      assert.ok(pkg.contributes.menus['explorer/context'].some(m => m.command === 'cmr.manual.mergeWith' && /\.xml/.test(m.when)), 'on an XML file\u2019s right-click');
      assert.strictEqual(pkg.contributes.commands.find(c => c.command === 'cmr.manual.mergeWith').title, 'Merge in Release Assistant\u2026');
    } finally { rmTree(root); }
  });

  ok('the page\u2019s Manual tab: only when shown; each version with what it is; Compare only with both valid; no banner', () => {
    const page = runPage();
    const base = { copadoOrg: '', recent: [], current: null, validation: null };
    page.state(Object.assign({}, base, { manual: { show: true } }));
    assert.ok(/class="nav[^"]*" data-nav="Manual"/.test(page.html), 'always in the tab bar');
    assert.ok(!/data-nav="Home"/.test(page.html), 'no Home tab: Promotions is the start');
    const side = (type, valid) => ({ name: 'Account.layout-meta.xml', type, lines: 412, valid, problem: valid ? null : 'Element <a> is never closed', head: ['<?xml version="1.0" encoding="UTF-8"?>', '<Layout>'] });
    page.state(Object.assign({}, base, { manual: { show: true, target: side('Layout', true), incoming: null, commit: null, last: null } }));
    page.click({ nav: 'Manual' });
    let t = page.text();
    assert.ok(/Compare two versions/.test(t) && /Target\s+the target branch\s+Layout \u00b7 412 lines \u00b7 valid/.test(t), t.slice(0, 400));
    assert.ok(page.html.includes('class="mpaste" data-side="incoming"'), 'the other side: paste here');
    assert.ok(/data-m="manual.merge" disabled/.test(page.html), 'not yet');
    assert.ok(!/isn\u2019t connected|not connected/.test(t), 'no banner');
    page.state(Object.assign({}, base, { manual: { show: true, target: side('Layout', true), incoming: side('Layout', true), commit: { name: 'commit.json', components: 3 }, last: { type: 'Layout', at: new Date().toISOString() } } }));
    t = page.text();
    assert.ok(!/data-m="manual.merge" disabled/.test(page.html) && /Last comparison\s+Layout \u00b7 just now/.test(t) && /commit\.json\s+3 components/.test(t));
    page.click({ m: 'manual.merge' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', scope: 'manual', name: 'manual.merge', payload: {} });
    page.click({ m: 'manual.pick', side: 'incoming' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', scope: 'manual', name: 'manual.pick', payload: { side: 'incoming' } });
    page.state(Object.assign({}, base, { manual: { show: true, target: side('Layout', false), incoming: null, commit: null, last: null } }));
    assert.ok(/not valid/.test(page.text()) && /Element <a> is never closed/.test(page.text()), 'not valid: and why');
  });

  section('3.8.2: Home - one box, recent work, tools');

  ok('the page\u2019s Promotions tab with nothing open: first; one box opens a promotion or a story; recent work; tools - Compare versions opens the Manual tab; set the Copado org first when there is none', () => {
    const page = runPage();
    const base = { copadoOrg: 'copado', recent: [{ name: 'P12340', status: 'Completed', from: 'int', to: 'qa', total: 2, done: 2 }], current: null, validation: null };
    page.state(Object.assign({}, base, { life: { story: {} } }));
    assert.ok(/class="nav on" data-nav="Promotions"/.test(page.html) && !/data-nav="Home"/.test(page.html), 'Promotions first - Home and Promotions are one');
    const t = page.text();
    assert.ok(/Open a promotion/.test(t) && /Recent promotions\s+P12340\s+Completed\s+int\s+qa\s+Open/.test(t) && /Tools\s+Validate a deployment/.test(t) && /Compare versions/.test(t), t.slice(0, 400));
    page.click({ nav: 'Manual' });
    assert.ok(/class="nav on" data-nav="Manual"/.test(page.html) && /Compare two versions/.test(page.text()), 'Compare versions opens the Manual tab');
    page.click({ nav: 'Promotions' });
    page.click({ a: 'openRecent', ref: 'P12340' });
    assert.deepStrictEqual(page.posted.pop(), { type: 'act', name: 'open', payload: { ref: 'P12340' } }, 'opened like any promotion');
    page.state(Object.assign({}, base, { copadoOrg: '', recent: [], life: { story: {} } }));
    assert.ok(/Set the Copado org to open promotions and stories/.test(page.text()) && /Promotions you open appear here/.test(page.text()), 'not connected: what to do');
  });

  section('3.8.0: an open-source repository');

  ok('the README\u2019s badges point at the repository package.json names, and say the VS Code version it needs', () => {
    const root = path.join(__dirname, '..');
    const pkg = require('../package.json');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const repo = /github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository.url)[1];
    // a badge in Markdown or HTML: by its name
    const badge = b => readme.includes('[![' + b + ']') || readme.includes('alt="' + b + '"');
    for (const b of ['Latest release', 'CI', 'MIT licence', 'Salesforce CLI v2']) assert.ok(badge(b), b);
    assert.ok(readme.includes('img.shields.io/github/v/release/' + repo) && readme.includes('github.com/' + repo + '/actions/workflows/test.yml/badge.svg'), 'the release and CI badges are for ' + repo);
    const min = /\^(\d+\.\d+)/.exec(pkg.engines.vscode)[1];
    assert.ok(badge('VS Code ' + min + ' or later') && /Requirements:\*\* VS Code /.test(readme) && readme.includes('VS Code ' + min + ' or later,'), 'VS Code ' + min);
    // the settings the README names are settings
    const all = Object.assign({}, ...pkg.contributes.configuration.map(c => c.properties));
    for (const k of [...readme.matchAll(/`(cmr\.[\w.]+)`/g)].map(m => m[1])) assert.ok(k in all, 'the README names a setting that does not exist: ' + k);
    // every picture it shows is there - and a picture it does not show, left in a clone, never ships
    const ship = require('../scripts/ship');
    const pics = [...ship.shown(root)];
    assert.ok(pics.length >= 5, 'the pictures it shows');
    for (const f of pics) assert.ok(fs.existsSync(path.join(root, f)), f);
    const keep = ship.keep(root);
    for (const f of fs.readdirSync(path.join(root, 'media', 'readme')).filter(f => f.endsWith('.png')).map(f => 'media/readme/' + f)) assert.strictEqual(keep(f), pics.includes(f), f + (pics.includes(f) ? ' ships' : ' is left over: it does not ship'));
    assert.deepStrictEqual([pkg.bugs.url, pkg.homepage], ['https://github.com/' + repo + '/issues', 'https://github.com/' + repo + '#readme']);
    for (const f of ['SECURITY.md', 'CONTRIBUTING.md', 'LICENSE', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md', '.github/pull_request_template.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
  });

  section('3.8.3: the merge editor\u2019s edges');

  ok('unsaved changes are never lost: a merge closed or replaced keeps them as a draft and offers them back; discarding or saving clears it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra draft '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const T = '<?xml version="1.0" encoding="UTF-8"?>\n<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n    <relatedLists>\n        <fields>A</fields>\n    </relatedLists>\n</Layout>\n';
      const mv = await realMergeView(root, {});
      const { vs } = mv;
      const t = put('t.layout-meta.xml', T), f = put('f.layout-meta.xml', T.replace('<fields>A</fields>', '<fields>A</fields>\n        <fields>B</fields>')), r = put('r.layout-meta.xml', '');
      const start = () => mv.deps().startSession(vs.Uri.file(t), vs.Uri.file(f), null, { applyToUri: vs.Uri.file(r), applyOnSave: true, openAfterApply: false, theirs: 'the feature branch' });
      await start();
      let w = mv.webviews[mv.webviews.length - 1];
      await w.send({ type: 'ready' });
      const mine = w.last('init').text.replace('<fields>B</fields>', '<fields>B</fields>\n        <fields>MINE</fields>');
      await w.send({ type: 'text', seq: 1, text: mine });
      await w.send({ type: 'dirty', dirty: true });
      // the tab closed with that unsaved
      w.panel.dispose();
      await new Promise(res => setImmediate(res));
      assert.ok(vs.log.info.some(m => /unsaved changes to r\.layout-meta\.xml are kept/.test(m)), 'it says so');
      vs.answers.info.push({ re: /closed with changes you had not saved/, v: 'Restore my changes' });
      await start();
      w = mv.webviews[mv.webviews.length - 1];
      await w.send({ type: 'ready' });
      assert.strictEqual(w.last('init').text, mine, 'offered back, and restored');
      // another merge opened over it: kept again
      await w.send({ type: 'dirty', dirty: true });
      vs.answers.info.push({ re: /closed with changes you had not saved/, v: 'Start fresh' });
      await start();
      w = mv.webviews[mv.webviews.length - 1];
      await w.send({ type: 'ready' });
      assert.notStrictEqual(w.last('init').text, mine, 'start fresh: the merge as prepared');
      // discarded: nothing kept, nothing offered next time
      await w.send({ type: 'dirty', dirty: true });
      vs.answers.warn.push({ re: /^Discard this merge\?/, v: 'Discard' });
      await w.send({ type: 'discard' });
      const asked = vs.log.info.filter(m => /closed with changes you had not saved/.test(m)).length;
      await start();
      assert.strictEqual(vs.log.info.filter(m => /closed with changes you had not saved/.test(m)).length, asked, 'no draft after discarding');
      mv.webviews[mv.webviews.length - 1].panel.dispose();
    } finally { rmTree(root); }
  });

  ok('edges of the comparison: Windows line endings, an emptied file, comments between elements, identical blocks swapped, self-closing elements, CDATA, no XML declaration', () => {
    const lay = (fields, extra) => '<?xml version="1.0" encoding="UTF-8"?>\n<Layout xmlns="http://soap.sforce.com/2006/04/metadata">\n    <relatedLists>\n' + fields.map(f => '        <fields>' + f + '</fields>\n').join('') + (extra || '') + '        <relatedList>R</relatedList>\n    </relatedLists>\n</Layout>\n';
    // Windows line endings: lined up, and a button gives back exactly what was there
    const crlf = t => t.replace(/\n/g, '\r\n');
    const T1 = crlf(lay(['A', 'B', 'C'])), M1 = crlf(lay(['A', 'C']));
    const r1 = MA().align(T1, T1, M1, { type: 'Layout' });
    covers(r1, M1);
    const rm = r1.pieces.find(p => p.kind === 'removed');
    assert.ok(rm && applyOps(M1, rm.undo) === T1, 'Restore, CRLF kept');
    // an emptied file: held, and it says where
    const MP = require('../src/mergePanel');
    const empty = MP.marksFor({ target: lay(['A']), incoming: lay(['A']), typeName: 'Layout' }, '', 'order');
    assert.ok(empty.hold && empty.xmlError, 'held: ' + JSON.stringify(empty.xmlError));
    // a comment between elements: Restore puts the block back with it, exactly
    const T3 = lay(['A', 'B'], '        <!-- kept for the sales team -->\n        <fields>C</fields>\n'), M3 = lay(['A', 'B']);
    const r3 = MA().align(T3, T3, M3, { type: 'Layout' });
    covers(r3, M3);
    assert.strictEqual(applyOps(M3, r3.pieces.find(p => p.kind === 'removed').undo), T3);
    // two identical blocks swapped: nothing moved, nothing changed
    const item = v => '        <valueListItems>\n            <value>' + v + '</value>\n        </valueListItems>\n';
    const fx = items => '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + items.map(item).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <identifier>hp</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>main</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
    const r4 = MA().align(fx(['Edit', 'Share', 'Edit']), null, fx(['Edit', 'Edit', 'Share']), { type: 'FlexiPage' });
    assert.deepStrictEqual([r4.moves.length, r4.pieces.filter(p => p.kind !== 'same').map(p => p.kind).sort()], [0, ['own', 'removed']], 'one block taken out and added again - linked');
    assert.ok(r4.pieces.filter(p => p.kind !== 'same').every(p => p.now || p.was));
    // self-closing elements and attributes; a CDATA value changed; no XML declaration
    const T5 = '<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n    <labels>\n        <fullName>Hello</fullName>\n        <categories/>\n        <value><![CDATA[Hi & welcome]]></value>\n    </labels>\n</CustomLabels>\n';
    const M5 = T5.replace('Hi & welcome', 'Hello & welcome');
    const r5 = MA().align(T5, T5, M5, { type: 'CustomLabels' });
    covers(r5, M5);
    const ch = r5.pieces.filter(p => p.kind !== 'same');
    assert.strictEqual(ch.length, 1, JSON.stringify(ch.map(p => [p.kind, p.label])));
    assert.strictEqual(applyOps(M5, ch[0].undo), T5, 'Use target gives the CDATA back exactly');
  });

  section('3.9.1: a page\u2019s actions and fields are their values');

  ok('an action or a field in a FlexiPage list is matched by its value: a shortened visibility rule is that rule\u2019s edit, a replaced field is one out and one in - never a move', () => {
    const crit = r => '                                <criteria>\n                                    <leftValue>{!Record.StageName}</leftValue>\n                                    <operator>EQUAL</operator>\n                                    <rightValue>' + r + '</rightValue>\n                                </criteria>\n';
    const item = (v, crits) => '                        <valueListItems>\n                            <value>' + v + '</value>\n' + (crits ? '                            <visibilityRule>\n                                <booleanFilter>1 OR 2 OR 3</booleanFilter>\n' + crits.map(crit).join('') + '                            </visibilityRule>\n' : '') + '                        </valueListItems>\n';
    const pg = items => '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + items.join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <identifier>hp</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
    const say = r => r.pieces.filter(p => p.kind !== 'same').map(p => [p.kind, p.label.replace(/ \(\d+ lines?\)$/, '')]);
    // the rule shortened, two actions not in the feature
    const T = pg([item('Share'), item('Early_Quote', ['1 - Qualification', '2 - Discovery', '3 - Product']), item('Clone_Without'), item('Clone_With')]);
    const M2 = pg([item('Share'), item('Early_Quote', ['1 - Qualification', '2 - Discovery'])]);
    const r2 = MA().align(T, T, M2, { type: 'FlexiPage' });
    covers(r2, M2);
    assert.deepStrictEqual(say(r2), [['removed', 'criteria: {!Record.StageName}, EQUAL, 3 - Product'], ['removed', 'valueListItems Clone_Without'], ['removed', 'valueListItems Clone_With']]);
    assert.deepStrictEqual(r2.moves, [], 'nothing moved');
    for (const p of r2.pieces.filter(x => x.kind === 'removed')) assert.ok(applyOps(M2, p.undo).length > M2.length, 'Restore puts it back');
    // a field replaced by another
    const T6 = pg([item('ORDERS.ORDER_NUMBER'), item('ORDERS.TOTAL_AMOUNT'), item('ORDERS.STATUS')]), M6 = pg([item('ORDERS.ORDER_NUMBER'), item('ORDERS.EXPIRY'), item('ORDERS.STATUS')]);
    const r6 = MA().align(T6, T6, M6, { type: 'FlexiPage' });
    assert.deepStrictEqual([say(r6), r6.moves.length], [[['removed', 'valueListItems ORDERS.TOTAL_AMOUNT'], ['own', 'valueListItems ORDERS.EXPIRY']], 0]);
    assert.strictEqual(applyOps(applyOps(M6, r6.pieces.find(p => p.kind === 'own').undo), r6.pieces.find(p => p.kind === 'removed').undo), T6, 'Undo and Restore give the target back');
    // actions reordered: one move
    const TR = pg([item('A'), item('B'), item('C')]), MR = pg([item('C'), item('A'), item('B')]);
    const rr = MA().align(TR, TR, MR, { type: 'FlexiPage' });
    assert.deepStrictEqual([rr.moves.length, rr.pieces.filter(p => p.kind !== 'same').map(p => p.kind).sort()], [0, ['own', 'removed']], 'reordered actions: one out, one in, linked');
    // the same action twice with different rules: a duplicate to decide, not removed
    const D = require('../src/mergeDuplicates');
    const twice = pg([item('Share'), item('Share', ['1 - Qualification'])]);
    assert.deepStrictEqual([D.inText(twice).length, D.inText(twice)[0].identical, D.dedupe(twice).removed.length], [1, false, 0]);
  });

  section('3.9.2: the full width');

  ok('the page and the merge editor use the full width: VS Code\u2019s own padding on a webview\u2019s body is taken off', () => {
    for (const f of ['page.css', 'merge.css']) {
      const css = fs.readFileSync(path.join(__dirname, '..', 'media', f), 'utf8');
      const rule = /(?:^|\n)html, body \{([^}]*)\}/.exec(css);
      assert.ok(rule && /padding: 0/.test(rule[1]) && /margin: 0/.test(rule[1]), f + ': html, body { margin: 0; padding: 0 }');
    }
  });

  section('3.9.3: CI on every system');

  ok('the tests inside VS Code reach the extension\u2019s own modules through what it hands them - never by a path, which on Windows can name a second copy', async () => {
    const suite = fs.readFileSync(path.join(__dirname, 'integration', 'suite', 'extension.test.js'), 'utf8');
    assert.ok(!/require\(path\.join\([^)]*extensionPath/.test(suite), 'no module loaded by its path');
    assert.ok(/\(await vscode\.extensions\.getExtension\(ID\)\.activate\(\)\)\.manualUi/.test(suite));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra api '));
    try {
      const mv = await realMergeView(root, {});
      assert.ok(mv.api && typeof mv.api.manualUi.act === 'function' && typeof mv.api.manualUi.snapshot === 'function', 'activate hands over the Manual tab');
    } finally { rmTree(root); }
  });

  section('3.9.4: a clone with leftovers');

  ok('a clone still holding what the project removed: none of it ships, and npm run tidy deletes it - with git when it is a checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra tidy '));
    try {
      const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
      put('scripts/removed.txt', '# removed\nquickMerge.js\nmedia/readme/banner.png\n');
      put('README.md', '![Shown](media/readme/merge-editor.png)\n');
      for (const f of ['quickMerge.js', 'media/readme/banner.png', 'media/readme/old-unlisted.png', 'media/readme/merge-editor.png', 'extension.js']) put(f, 'x');
      const ship = require('../scripts/ship');
      const keep = ship.keep(root);
      assert.deepStrictEqual(['quickMerge.js', 'media/readme/banner.png', 'media/readme/old-unlisted.png', 'media/readme/merge-editor.png', 'extension.js', 'media\\readme\\banner.png'].map(keep), [false, false, false, true, true, false]);
      assert.deepStrictEqual(ship.leftovers(root), ['media/readme/banner.png', 'media/readme/old-unlisted.png', 'quickMerge.js']);
      // tidy, in the copy: its own ship.js beside it
      put('scripts/ship.js', fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ship.js'), 'utf8'));
      put('scripts/tidy.js', fs.readFileSync(path.join(__dirname, '..', 'scripts', 'tidy.js'), 'utf8'));
      const out = require('child_process').execFileSync(process.execPath, [path.join(root, 'scripts', 'tidy.js')], { encoding: 'utf8' });
      assert.ok(/3 file\(s\) removed/.test(out), out);
      assert.deepStrictEqual(['quickMerge.js', 'media/readme/banner.png', 'media/readme/old-unlisted.png', 'media/readme/merge-editor.png', 'extension.js'].map(f => fs.existsSync(path.join(root, f))), [false, false, false, true, true]);
      assert.ok(/nothing left over/.test(require('child_process').execFileSync(process.execPath, [path.join(root, 'scripts', 'tidy.js')], { encoding: 'utf8' })), 'then nothing');
    } finally { rmTree(root); }
    // this project's list names what it removed - a clone may still hold them: the package leaves them out
    const list = require('../scripts/ship').removed(path.join(__dirname, '..'));
    assert.ok(['quickMerge.js', 'treeView.js', 'src/liveMarks.js', 'media/readme/banner.png', 'media/readme/merge.png'].every(f => list.includes(f)), 'the removed files are listed');
    assert.ok(!list.some(f => /^(extension\.js|package\.json|README\.md|media\/readme\/(merge-editor|duplicates|promotion|precheck|manual|components)\.png)$/.test(f)), 'and nothing still used');
  });

  section('3.10.0: identities');

  ok('a list nothing identifies is paired by a name-like field unique on both sides - several changes at once read right; repeated values keep position', () => {
    const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
    const say = r => r.pieces.filter(p => p.kind !== 'same').map(p => p.kind + ': ' + p.label.replace(/ \(\d+ lines?\)$/, ''));
    // an Agentforce planner's topics (GenAiPlannerBundle): no rule - genAiPluginName inferred
    const gp = list => '<?xml version="1.0" encoding="UTF-8"?>\n<GenAiPlannerBundle ' + NS + '>\n' + list.map(([n, sc]) => '    <genAiPlugins>\n        <genAiPluginName>' + n + '</genAiPluginName>\n        <scope>' + sc + '</scope>\n    </genAiPlugins>\n').join('') + '    <masterLabel>Planner</masterLabel>\n</GenAiPlannerBundle>\n';
    const T = gp([['Billing', 'a'], ['Orders', 'b'], ['Returns', 'c']]), M = gp([['Billing', 'a2'], ['Returns', 'c2']]);
    const r = MA().align(T, T, M, { type: 'GenAiPlannerBundle' });
    covers(r, M);
    assert.deepStrictEqual(say(r).map(x => x.replace(/: .*?(scope)/, ': $1')), ['changed-own: scope: a \u2192 a2', 'removed: genAiPlugins: Orders, b', 'changed-own: scope: c \u2192 c2'], JSON.stringify(say(r)));
    // permission sets' newer lists: the documented identities
    const ps = (tag, key, list) => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet ' + NS + '>\n' + list.map(([v, e]) => '    <' + tag + '>\n        <' + key + '>' + v + '</' + key + '>\n        <enabled>' + e + '</enabled>\n    </' + tag + '>\n').join('') + '    <label>P</label>\n</PermissionSet>\n';
    for (const [tag, key] of [['agentAccesses', 'agentName'], ['genComputingSummaryDefAccess', 'configName'], ['emailRoutingAddressAccesses', 'name']]) {
      const TP = ps(tag, key, [['A', 'true'], ['B', 'true'], ['C', 'true']]), MP = ps(tag, key, [['A', 'false'], ['C', 'false']]);
      const rp = MA().align(TP, TP, MP, { type: 'PermissionSet' });
      assert.deepStrictEqual(say(rp), ['changed-own: A enabled: true \u2192 false', 'removed: ' + tag + ' B', 'changed-own: C enabled: true \u2192 false'], tag);
    }
    // two filters on one field (a list view's date range): nothing inferred - position is the identity, and right
    const lv = to => '<?xml version="1.0" encoding="UTF-8"?>\n<ListView ' + NS + '>\n    <fullName>Recent</fullName>\n    <filters>\n        <field>CREATED_DATE</field>\n        <operation>greaterOrEqual</operation>\n        <value>LAST_N_DAYS:30</value>\n    </filters>\n    <filters>\n        <field>CREATED_DATE</field>\n        <operation>lessOrEqual</operation>\n        <value>' + to + '</value>\n    </filters>\n    <label>Recent</label>\n</ListView>\n';
    assert.deepStrictEqual(say(MA().align(lv('TODAY'), lv('TODAY'), lv('YESTERDAY'), { type: 'ListView' })).map(x => x.replace(/: CREATED_DATE /, ': ')), ['changed-own: value: TODAY \u2192 YESTERDAY']);
  });

  section('3.10.0: no noise');

  ok('what is not a change is not shown: fields of an entry in another order, <x/> and <x></x>, &amp; and &#38;, line endings; order-free lists reordered', () => {
    const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
    const none = (T, M, type, what) => { const r = MA().align(T, T, M, { type }); covers(r, M); assert.deepStrictEqual(r.pieces.filter(p => p.kind !== 'same').map(p => p.label), [], what); };
    const ps = body => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet ' + NS + '>\n' + body + '    <label>P</label>\n</PermissionSet>\n';
    const fp = '    <fieldPermissions>\n        <editable>true</editable>\n        <field>A.x__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
    none(ps(fp), ps('    <fieldPermissions>\n        <field>A.x__c</field>\n        <editable>true</editable>\n        <readable>true</readable>\n    </fieldPermissions>\n'), 'PermissionSet', 'an entry\u2019s fields in another order');
    none(ps('    <description></description>\n' + fp), ps('    <description/>\n' + fp), 'PermissionSet', '<x></x> and <x/>');
    none(ps('    <description>R&amp;D</description>\n'), ps('    <description>R&#38;D</description>\n'), 'PermissionSet', 'entities');
    none(ps(fp), ps(fp).replace(/\n/g, '\r\n'), 'PermissionSet', 'line endings');
    // a flow\u2019s elements, and a component\u2019s properties, in another order
    const as = n => '    <assignments>\n        <name>' + n + '</name>\n        <label>' + n + '</label>\n    </assignments>\n';
    const fl = ns => '<?xml version="1.0" encoding="UTF-8"?>\n<Flow ' + NS + '>\n' + ns.map(as).join('') + '    <label>F</label>\n</Flow>\n';
    none(fl(['Set_A', 'Set_B']), fl(['Set_B', 'Set_A']), 'Flow', 'flow elements');
    const prop = (n, v) => '                    <componentInstanceProperties>\n                        <name>' + n + '</name>\n                        <value>' + v + '</value>\n                    </componentInstanceProperties>\n';
    const fx = props => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage ' + NS + '>\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n' + props.join('') + '                <componentName>force:relatedListSingleContainer</componentName>\n                <identifier>rl</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>main</name>\n        <type>Region</type>\n    </flexiPageRegions>\n    <masterLabel>P</masterLabel>\n</FlexiPage>\n';
    none(fx([prop('relatedListApiName', 'Orders'), prop('rowsToDisplay', '10')]), fx([prop('rowsToDisplay', '10'), prop('relatedListApiName', 'Orders')]), 'FlexiPage', 'component properties');
    // ...but a comment added inside an entry is a change, and where order is meaning it still counts
    const r = MA().align(ps(fp), ps(fp), ps(fp.replace('<editable>', '<!-- for the sales team -->\n        <editable>')), { type: 'PermissionSet' });
    assert.ok(r.pieces.some(p => p.kind !== 'same'), 'a comment added: a change');
  });

  ok('a flow element only dragged on the canvas is one quiet row - X and Y together, counted apart, undone alone', () => {
    const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
    const fl = (x, y, l) => '<?xml version="1.0" encoding="UTF-8"?>\n<Flow ' + NS + '>\n    <assignments>\n        <name>Set_A</name>\n        <label>' + l + '</label>\n        <locationX>' + x + '</locationX>\n        <locationY>' + y + '</locationY>\n    </assignments>\n    <label>F</label>\n</Flow>\n';
    const T = fl(176, 134, 'Set A'), M = fl(352, 290, 'Set A2');
    const r = MA().align(T, null, M, { type: 'Flow' });
    covers(r, M);
    const ch = r.pieces.filter(p => p.kind !== 'same');
    assert.deepStrictEqual(ch.map(p => p.kind), ['changed-own', 'position']);
    assert.strictEqual(ch[1].label, 'locationX: 176 \u2192 352, locationY: 134 \u2192 290');
    assert.deepStrictEqual([r.counts.position, r.counts.own], [1, 1]);
    assert.strictEqual(applyOps(M, ch[1].undo), fl(176, 134, 'Set A2'), 'Use target: the position, not the label');
  });

  section('3.10.0: decomposed formats and Winter \u201927 lists');

  ok('decomposed permission sets, custom labels and workflow rules; Flow groups (68.0); a duplicated agent access', () => {
    const D = require('../src/mergeDuplicates');
    const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
    const say = r => r.pieces.filter(p => p.kind !== 'same').map(p => p.kind + ': ' + p.label.replace(/ \(\d+ lines?\)$/, ''));
    const check = (name, got, ok) => assert.ok(ok, name + ': ' + JSON.stringify(got));
    // a decomposed permission set: objectSettings/Account.objectSettings-meta.xml - a PermissionSet root with one object's entries
    const os = (ed, extra) => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet ' + NS + '>\n    <fieldPermissions>\n        <editable>' + ed + '</editable>\n        <field>Account.Region__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n' + (extra || '') + '    <objectPermissions>\n        <allowCreate>true</allowCreate>\n        <allowDelete>false</allowDelete>\n        <allowEdit>true</allowEdit>\n        <allowRead>true</allowRead>\n        <modifyAllRecords>false</modifyAllRecords>\n        <object>Account</object>\n        <viewAllRecords>false</viewAllRecords>\n    </objectPermissions>\n</PermissionSet>\n';
    let r = MA().align(os('true'), null, os('false'), { type: 'PermissionSet' });
    check('decomposed objectSettings: one access changed', say(r), JSON.stringify(say(r)) === JSON.stringify(['changed-own: Account.Region__c editable: true \u2192 false']));
    r = MA().align(os('true'), null, os('true', '    <fieldPermissions>\n        <editable>true</editable>\n        <field>Account.Tier__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n'), { type: 'PermissionSet' });
    check('decomposed objectSettings: a field added', say(r), say(r).length === 1 && /own: fieldPermissions Account\.Tier__c/.test(say(r)[0]));
    // a decomposed custom label (labels/Greeting.label-meta.xml)
    const lab = v => '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabel ' + NS + '>\n    <fullName>Greeting</fullName>\n    <language>en_US</language>\n    <protected>false</protected>\n    <shortDescription>Greeting</shortDescription>\n    <value>' + v + '</value>\n</CustomLabel>\n';
    r = MA().align(lab('Hello'), null, lab('Hi'), { type: 'CustomLabel' });
    check('decomposed CustomLabel: its value changed', say(r), JSON.stringify(say(r)) === JSON.stringify(['changed-own: value: Hello \u2192 Hi']));
    // a decomposed workflow rule: two criteria on one field (a range), the second changed
    const wr = v => '<?xml version="1.0" encoding="UTF-8"?>\n<WorkflowRule ' + NS + '>\n    <fullName>Big_Deal</fullName>\n    <active>true</active>\n    <criteriaItems>\n        <field>Opportunity.Amount</field>\n        <operation>greaterThan</operation>\n        <value>1000</value>\n    </criteriaItems>\n    <criteriaItems>\n        <field>Opportunity.Amount</field>\n        <operation>lessThan</operation>\n        <value>' + v + '</value>\n    </criteriaItems>\n    <triggerType>onCreateOnly</triggerType>\n</WorkflowRule>\n';
    r = MA().align(wr('5000'), null, wr('9000'), { type: 'WorkflowRule' });
    check('decomposed WorkflowRule: the second of two criteria on one field', say(r), say(r).length === 1 && /value: 5000 \u2192 9000/.test(say(r)[0]));
    // Flow lists from 61.0 to 68.0: named, order-free
    const grp = ns => '<?xml version="1.0" encoding="UTF-8"?>\n<Flow ' + NS + '>\n' + ns.map(([n, l]) => '    <groups>\n        <name>' + n + '</name>\n        <label>' + l + '</label>\n    </groups>\n').join('') + '    <label>F</label>\n</Flow>\n';
    r = MA().align(grp([['G1', 'One'], ['G2', 'Two']]), null, grp([['G2', 'Two'], ['G1', 'Uno']]), { type: 'Flow' });
    check('Flow groups (68.0): reordered, one relabelled', say(r), say(r).length === 1 && /label: One \u2192 Uno/.test(say(r)[0]));
    // duplicates on a newly identified list
    const ag = list => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet ' + NS + '>\n' + list.map(([a, e]) => '    <agentAccesses>\n        <agentName>' + a + '</agentName>\n        <enabled>' + e + '</enabled>\n    </agentAccesses>\n').join('') + '    <label>P</label>\n</PermissionSet>\n';
    const d = D.inText(ag([['Sales_Agent', 'true'], ['Service_Agent', 'true'], ['Sales_Agent', 'false']]));
    check('agentAccesses: the same agent twice is a duplicate', d, d.length === 1 && d[0].identical === false);
  });

  section('3.10.1: translations, component configurations, sets');

  ok('translations pair by what they translate; a component\u2019s configurations by their targets, its properties by name; attribute changes say what changed; sets are order-free', () => {
    const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
    const X = (root, body) => '<?xml version="1.0" encoding="UTF-8"?>\n<' + root + ' ' + NS + '>\n' + body + '</' + root + '>\n';
    const say = (T, M, type) => { const r = MA().align(T, null, M, { type }); covers(r, M); return r.pieces.filter(p => p.kind !== 'same').map(p => p.kind + ': ' + p.label.replace(/ \(\d+ lines?\)$/, '')); };
    // 1 value-set and picklist translations: by masterLabel
    const vt = list => list.map(([m, t]) => '    <valueTranslation>\n        <masterLabel>' + m + '</masterLabel>\n        <translation>' + t + '</translation>\n    </valueTranslation>\n').join('');
    for (const type of ['GlobalValueSetTranslation', 'StandardValueSetTranslation']) {
      const g = say(X(type, vt([['Hot', 'Chaud'], ['Warm', 'Tiede'], ['Cold', 'Froid']])), X(type, vt([['Hot', 'Heiss'], ['Cold', 'Kalt']])), type);
      assert.ok(g.length === 3 && g.some(x => /^removed: .*Warm/.test(x)) && !g.some(x => /masterLabel/.test(x)), type + ': ' + JSON.stringify(g));
    }
    const pv = list => '    <label>Region</label>\n    <name>Region__c</name>\n' + list.map(([m, t]) => '    <picklistValues>\n        <masterLabel>' + m + '</masterLabel>\n        <translation>' + t + '</translation>\n    </picklistValues>\n').join('');
    const gf = say(X('CustomFieldTranslation', pv([['North', 'Nord'], ['South', 'Sud'], ['East', 'Est']])), X('CustomFieldTranslation', pv([['North', 'Norden'], ['East', 'Osten']])), 'CustomFieldTranslation');
    assert.ok(gf.length === 3 && gf.some(x => /^removed: .*South/.test(x)), JSON.stringify(gf));
    // 2 a layout section translation: by its section
    const secs = list => '    <layouts>\n        <layout>Account Layout</layout>\n' + list.map(([sec, t]) => '        <sections>\n            <label>' + t + '</label>\n            <section>' + sec + '</section>\n        </sections>\n').join('') + '    </layouts>\n';
    const gs = say(X('CustomObjectTranslation', secs([['Info', 'Infos'], ['System', 'Systeme'], ['Address', 'Adresse']])), X('CustomObjectTranslation', secs([['Info', 'Information'], ['Address', 'Anschrift']])), 'CustomObjectTranslation');
    assert.ok(gs.length === 3 && gs.filter(x => /^changed-own/.test(x)).length === 2 && gs.some(x => /^removed: sections System/.test(x)), JSON.stringify(gs));
    // 3 a quick action translation: by name and aspect
    const qa = list => list.map(([n, asp, l]) => '    <quickActions>\n' + (asp ? '        <aspect>' + asp + '</aspect>\n' : '') + '        <label>' + l + '</label>\n        <name>' + n + '</name>\n    </quickActions>\n').join('');
    const gq = say(X('CustomObjectTranslation', qa([['New_Case', null, 'Neuer Fall'], ['New_Case', 'Description', 'Einen Fall anlegen']])), X('CustomObjectTranslation', qa([['New_Case', 'Description', 'Fall anlegen']])), 'CustomObjectTranslation');
    assert.deepStrictEqual(gq, ['removed: quickActions New_Case', 'changed-own: New_Case / Description label: Einen Fall anlegen \u2192 Fall anlegen']);
    // 4, 5 a component's configurations: by their targets (a set), properties by name; attribute changes named
    const lwc = o => '<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle ' + NS + '>\n    <apiVersion>68.0</apiVersion>\n    <targets>\n        <target>lightning__RecordPage</target>\n        <target>lightning__AppPage</target>\n    </targets>\n    <targetConfigs>\n' + o.map(([t, d]) => '        <targetConfig targets="' + t + '">\n            <property name="title" type="String" default="' + d + '"/>\n        </targetConfig>\n').join('') + '    </targetConfigs>\n</LightningComponentBundle>\n';
    assert.deepStrictEqual(say(lwc([['lightning__RecordPage', 'Record'], ['lightning__AppPage, lightning__HomePage', 'App']]), lwc([['lightning__HomePage,lightning__AppPage', 'Application'], ['lightning__RecordPage', 'Record']]), 'LightningComponentBundle'),
      ['changed-own: property title default: App \u2192 Application'], 'swapped, targets in another order: only the default');
    assert.deepStrictEqual(say(lwc([['lightning__RecordPage', 'Record']]), lwc([['lightning__RecordPage, lightning__AppPage', 'Record']]), 'LightningComponentBundle').map(x => x.replace(/\u2026$/, '')),
      ['changed-own: targetConfig targets: lightning__RecordPage \u2192 lightning__RecordPage, lightning__AppPa']);
    assert.deepStrictEqual(say(lwc([['lightning__RecordPage', 'Record']]), lwc([['lightning__RecordPage', 'Record']]).replace('<target>lightning__RecordPage</target>\n        <target>lightning__AppPage</target>', '<target>lightning__AppPage</target>\n        <target>lightning__RecordPage</target>'), 'LightningComponentBundle'), [], 'targets: a set');
    // 6, 7 a dependent picklist's mappings, and each mapping's controlling values: sets
    const vs = list => '    <fullName>Region__c</fullName>\n    <valueSet>\n' + list.map(([v, cs]) => '        <valueSettings>\n' + cs.map(c => '            <controllingFieldValue>' + c + '</controllingFieldValue>\n').join('') + '            <valueName>' + v + '</valueName>\n        </valueSettings>\n').join('') + '    </valueSet>\n';
    assert.deepStrictEqual(say(X('CustomField', vs([['North', ['UK', 'IE']], ['South', ['UK']]])), X('CustomField', vs([['South', ['UK']], ['North', ['IE', 'UK']]])), 'CustomField'), [], 'mappings and controlling values in another order');
    assert.deepStrictEqual(say(X('CustomField', vs([['North', ['UK']]])), X('CustomField', vs([['North', ['UK', 'IE']]])), 'CustomField').length, 1, 'a controlling value added: one change');
    // concluded right as they were: a login range is both its addresses; approval steps run in order
    const ip = list => list.map(([s1, e]) => '    <loginIpRanges>\n        <endAddress>' + e + '</endAddress>\n        <startAddress>' + s1 + '</startAddress>\n    </loginIpRanges>\n').join('');
    const gi = say(X('Profile', ip([['10.0.0.0', '10.0.0.255'], ['192.168.0.0', '192.168.0.255']])), X('Profile', ip([['10.0.0.0', '10.0.0.127'], ['192.168.0.0', '192.168.0.255']])), 'Profile');
    assert.ok(gi.length >= 1 && gi.every(x => /10\.0\.0/.test(x)), 'only the range that changed: ' + JSON.stringify(gi));
    const ap = steps => steps.map(n => '    <approvalStep>\n        <label>' + n + '</label>\n        <name>' + n + '</name>\n    </approvalStep>\n').join('');
    assert.strictEqual(say(X('ApprovalProcess', ap(['Manager', 'Director'])), X('ApprovalProcess', ap(['Director', 'Manager'])), 'ApprovalProcess').length, 2, 'steps swapped: their order is the approval\u2019s');
  });

  section('3.10.2: the Node versions tested are the ones VS Code runs the extension on');

  ok('the oldest Node.js tested is the one the oldest supported VS Code runs extensions on - and none older', () => {
    const pkg = require('../package.json');
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');
    const tested = /node: \[([^\]]+)\]/.exec(wf)[1].split(',').map(n => +n.trim());
    // VS Code's own Node.js: 1.85-1.89 run extensions on Node 18, 1.90 on Node 20, the releases from 2025 on Node 22
    const minor = +/\^1\.(\d+)/.exec(pkg.engines.vscode)[1];
    const oldest = minor >= 101 ? 22 : minor >= 90 ? 20 : 18;
    assert.strictEqual(Math.min(...tested), oldest, 'VS Code 1.' + minor + ' runs extensions on Node ' + oldest + '; CI tests ' + tested.join(', '));
    assert.ok(tested.includes(22), 'and today\u2019s VS Code\u2019s');
  });

  section('3.11.0: the common ancestor');

  ok('the merge-base of two branches, and a file as it was there - for each provider, from the connected repository', async () => {
    const R = require('../src/repoHost');
    const file = 'force-app/main/default/flexipages/Account.flexipage-meta.xml';
    const g = await h.fakeGitHosts({ baseFiles: { [file]: '<FlexiPage>base</FlexiPage>' }, branches: ['feature/US-0012345', 'uat'] });
    try {
      for (const [provider, url, token] of [['azure', g.base + '/org/Proj/_git/repo', 'az-token'], ['github', g.base + '/owner/repo', 'gh-token'],
        ['gitlab', g.base + '/group/repo', 'gl-token'], ['bitbucket', g.base + '/ws/repo', 'me@example.com:bb-token']]) {
        const host = R.createHost(R.parseRepoUrl(url, provider), token);
        const sha = await host.mergeBase('feature/US-0012345', 'uat');
        assert.strictEqual(sha, 'b'.repeat(40), provider + ': the merge-base');
        assert.strictEqual((await host.readFileAt(sha, file)).toString(), '<FlexiPage>base</FlexiPage>', provider + ': the file at it');
        assert.strictEqual(await host.readFileAt(sha, 'force-app/main/default/classes/New.cls'), null, provider + ': a file that was not there');
      }
      await assert.rejects(R.createHost(R.parseRepoUrl(g.base + '/owner/repo', 'github'), 'gh-token').readFileAt('main', file), /not a commit/);
    } finally { g.server.close(); }
  });

  ok('with the common ancestor, what each branch did since: the target\u2019s own later addition or change is no mark; what the feature removed or changed says so', () => {
    const it = v => '                        <valueListItems>\n                            <value>' + v + '</value>\n                        </valueListItems>\n';
    const pg = items => '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + items.map(it).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <identifier>hp</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
    const say = (T, F, M, anc) => MA().align(T, F, M, { type: 'FlexiPage', ancestor: anc }).pieces.filter(p => p.kind !== 'same').map(p => p.kind + (p.byFeature ? ' by the feature' : ''));
    const T = pg(['Edit', 'Share', 'Clone']), F = pg(['Edit', 'Share']);
    assert.deepStrictEqual(say(T, F, T, null), ['kept'], 'no ancestor: not in the feature, kept');
    assert.deepStrictEqual(say(T, F, T, pg(['Edit', 'Share'])), [], 'the target added it since: keeping it is right - no mark');
    assert.deepStrictEqual(say(T, F, T, pg(['Edit', 'Share', 'Clone'])), ['kept by the feature'], 'the feature removed it: kept, and it says so');
    assert.deepStrictEqual(say(T, F, F, pg(['Edit', 'Share', 'Clone'])), ['removed by the feature'], 'removed, as the feature did');
    assert.deepStrictEqual(say(T, F, F, pg(['Edit', 'Share'])), ['removed'], 'the target\u2019s own addition removed: a plain removal');
    // values: the target changed it since - no mark; the feature changed it - says so
    const lv = (v) => pg(['Edit']).replace('<name>header</name>', '<name>' + v + '</name>');
    assert.deepStrictEqual(say(lv('header2'), lv('header'), lv('header2'), lv('header')), [], 'the target\u2019s own change kept: no mark');
    const d = MA().align(lv('header'), lv('top'), lv('header'), { type: 'FlexiPage', ancestor: lv('header') }).pieces.filter(p => p.kind !== 'same');
    assert.deepStrictEqual(d.map(p => [p.kind, !!p.byFeature]), [['differs', true]], 'the feature changed it, you kept the target\u2019s: it says so');
  });

  ok('the merge editor takes the ancestor from the session - and not when cmr.merge.useAncestor is off', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra anc '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const it = v => '        <valueListItems>\n            <value>' + v + '</value>\n        </valueListItems>\n';
      const pg = items => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + items.map(it).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <identifier>hp</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
      for (const on of [true, false]) {
        const mv = await realMergeView(root, on ? {} : { 'cmr.merge.useAncestor': false });
        await mv.deps().startSession(mv.vs.Uri.file(put('t.flexipage-meta.xml', pg(['Edit', 'Share', 'Clone']))), mv.vs.Uri.file(put('f.flexipage-meta.xml', pg(['Edit', 'Share']))), mv.vs.Uri.file(put('o.flexipage-meta.xml', pg(['Edit', 'Share']))),
          { applyToUri: mv.vs.Uri.file(put('r.flexipage-meta.xml', '')), applyOnSave: true, openAfterApply: false, theirs: 'the feature branch', startFrom: pg(['Edit', 'Share', 'Clone']) });
        const w = mv.webviews[mv.webviews.length - 1];
        await w.send({ type: 'ready' });
        const kinds = w.last('init').marks.pieces.filter(p => p.kind !== 'same').map(p => p.kind);
        assert.deepStrictEqual(kinds, on ? [] : ['kept'], on ? 'with the ancestor: the target\u2019s own addition, no mark' : 'off: compared as branches only');
        w.panel.dispose();
      }
    } finally { rmTree(root); }
  });

  ok('renamed: gone and come back alike but for its name is one change - not when only flags are alike, nor when it was only its name', () => {
    const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
    const say = (T, M, type) => { const r = MA().align(T, null, M, { type }); covers(r, M); return r.pieces.filter(p => p.kind !== 'same').map(p => p.kind + ': ' + p.label.replace(/ \(\d+ lines?\)$/, '')); };
    const lab = list => '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels ' + NS + '>\n' + list.map(([n, v]) => '    <labels>\n        <fullName>' + n + '</fullName>\n        <language>en_US</language>\n        <protected>false</protected>\n        <shortDescription>' + v + '</shortDescription>\n        <value>' + v + '</value>\n    </labels>\n').join('') + '</CustomLabels>\n';
    assert.deepStrictEqual(say(lab([['Bye', 'Bye'], ['Greeting', 'Hello'], ['Thanks', 'Thanks']]), lab([['Bye', 'Bye'], ['Thanks', 'Thanks'], ['Welcome', 'Hello']]), 'CustomLabels'), ['changed-own: Renamed labels: Greeting \u2192 Welcome']);
    assert.deepStrictEqual(say(lab([['Bye', 'Bye'], ['Greeting', 'Hello']]), lab([['Bye', 'Bye'], ['Welcome', 'Hi']]), 'CustomLabels'), ['removed: labels Greeting', 'own: labels Welcome'], 'renamed and changed: another label');
    const fp = f => '    <fieldPermissions>\n        <editable>true</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
    const ps = b => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet ' + NS + '>\n' + b + '    <label>P</label>\n</PermissionSet>\n';
    assert.deepStrictEqual(say(ps(fp('A.a__c') + fp('A.b__c')), ps(fp('A.a__c') + fp('A.c__c')), 'PermissionSet'), ['removed: fieldPermissions A.b__c', 'own: fieldPermissions A.c__c'], 'only flags alike: two fields, not a rename');
  });

  section('3.11.0: code');

  ok('a promotion\u2019s code is Copado\u2019s conflict file as git merged it: no markers, each conflict left out until one of its versions is accepted, named by what it is about', () => {
    const CM = require('../src/codeMerge'), M = MA();
    const f = 'public with sharing class InvoiceService {\n    private static final String SOURCE = \'Billing\';\n<<<<<<< HEAD\n    private static final Decimal TAX_RATE = 0.21;\n=======\n    private static final Decimal TAX_RATE = 0.20;\n    private static final Decimal MAX_DISCOUNT = 0.15;\n>>>>>>> feature/US-0012345\n    public static void refund(Id invoiceId) { issueCredit(invoiceId); }\n    public static Decimal total(Decimal amount) {\n<<<<<<< HEAD\n        return amount * (1 + TAX_RATE);\n=======\n        return (amount - discountOf(amount)) * 1.2;\n>>>>>>> feature/US-0012345\n    }\n}\n';
    const g = CM.fromConflictFile(f);
    assert.ok(!/^(<{7}|={7}|>{7})/m.test(g.text), 'no markers');
    assert.ok(!g.text.includes('TAX_RATE = 0.2') && !g.text.includes('discountOf') && g.text.includes('refund'), 'neither version in - git\u2019s merge kept');
    const look = t => CM.marks({ text: t, conflicts: g.conflicts, language: 'apex' });
    const k = look(g.text);
    assert.deepStrictEqual(k.rows.map(r => [r.label, r.chosen, r.needs, r.ghosts.map(x => x.title)]), [['properties TAX_RATE, MAX_DISCOUNT', 'none', true, ['Target', 'Feature']], ['method total(Decimal)', 'none', true, ['Target', 'Feature']]]);
    assert.deepStrictEqual([k.counts.needs, k.counts.conflicts], [2, 2]);
    assert.deepStrictEqual(k.rows[0].actions.map(a => a.label), ['Accept target', 'Accept feature', 'Accept both']);
    // accepted: that version in, ordinary text; the name stays; edited - yours
    const t1 = applyOps(g.text, [k.rows[1].actions[1].op]);
    assert.ok(t1.includes('discountOf(amount)) * 1.2;') && !t1.includes('TAX_RATE);'), 'the feature\u2019s lines');
    const t2 = applyOps(t1, [look(t1).rows[0].actions[2].op]);
    assert.deepStrictEqual(look(t2).rows.map(r => [r.label, r.chosen]), [['properties TAX_RATE, MAX_DISCOUNT', 'both'], ['method total(Decimal)', 'feature']]);
    assert.deepStrictEqual([look(t2).counts.needs, look(t2.replace('* 1.2;', '* 1.25;')).rows[1].chosen], [0, 'edited']);
    assert.deepStrictEqual(look(g.text).rows.map(r => r.chosen), ['none', 'none'], 'undone: to resolve again');
    // found again by what is either side - and where - not by the first '}' or '/**' that looks the same
    let many = 'public class B {\n';
    for (let i = 0; i < 6; i++) many += '    /**\n     * m' + i + '\n     */\n    void m' + i + '() {\n<<<<<<< HEAD\n        a' + i + '();\n=======\n        b' + i + '();\n>>>>>>> feature\n    }\n\n';
    const gm = CM.fromConflictFile(many + '}\n');
    const km = CM.marks({ text: gm.text, conflicts: gm.conflicts, language: 'apex' });
    assert.deepStrictEqual(km.rows.map(r => r.label + ' ' + r.chosen), ['method m0() none', 'method m1() none', 'method m2() none', 'method m3() none', 'method m4() none', 'method m5() none']);
    const t4 = applyOps(gm.text, [km.rows[3].actions[1].op]);
    assert.deepStrictEqual(CM.marks({ text: t4, conflicts: gm.conflicts, language: 'apex' }).rows.map(r => r.chosen), ['none', 'none', 'none', 'feature', 'none', 'none'], 'only the one accepted');
    // one version empty - Accept feature and Accept both are the same text: the one clicked is the one shown
    const ge = CM.fromConflictFile('public class C {\n<<<<<<< HEAD\n=======\n    // Setup helpers\n>>>>>>> feature\n    void a() {\n    }\n}\n');
    const ke = CM.marks({ text: ge.text, conflicts: ge.conflicts, language: 'apex' });
    assert.strictEqual(CM.marks({ text: applyOps(ge.text, [ke.rows[0].actions[1].op]), conflicts: ge.conflicts, language: 'apex' }).rows[0].chosen, 'feature');
    // an empty version accepted: remembered - resolved, the other's lines struck through
    const gz = CM.fromConflictFile('public class D {\n    void a() {\n<<<<<<< HEAD\n        retry();\n=======\n>>>>>>> feature\n    }\n}\n');
    const kz = CM.marks({ text: gz.text, conflicts: gz.conflicts, language: 'apex', reviewed: new Map([[gz.conflicts[0].id, 'feature']]) });
    assert.deepStrictEqual([kz.rows[0].chosen, kz.rows[0].needs, kz.rows[0].ghosts.map(x => x.cls + ':' + x.lines.join('').trim())], ['feature', false, ['struck:retry();']]);
    // a comparison: duplicates only where entries add up - a permission set's, never a page's
    const MP0 = require('../src/mergePanel');
    const dupPs = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <userPermissions>\n        <enabled>true</enabled>\n        <name>ViewSetup</name>\n    </userPermissions>\n    <userPermissions>\n        <enabled>true</enabled>\n        <name>ViewSetup</name>\n    </userPermissions>\n</PermissionSet>\n';
    assert.deepStrictEqual([MP0.marksFor({ plain: true, typeName: 'PermissionSet', target: dupPs }, dupPs, 'order').dups.length > 0, MP0.marksFor({ plain: true, typeName: 'FlexiPage', target: dupPs }, dupPs, 'order').dups.length], [true, 0]);
    // unresolved, the code is not whole: no bracket problems until it is
    const MP = require('../src/mergePanel');
    const open = MP.marksFor({ language: 'apex', target: '', incoming: '', code: { conflicts: gm.conflicts } }, gm.text, 'order');
    assert.deepStrictEqual([open.counts.needs, open.problems], [6, []]);
    // the members read - they name conflicts: methods by name and parameter types, overloads apart; a banner apart from a member
    const cls = ms => 'public class A {\n' + ms.join('') + '}\n', m = (sig, body) => '    void ' + sig + ' {\n        ' + body + '\n    }\n';
    assert.deepStrictEqual(M.units(cls([m('f(Integer a)', ''), m('f(String a)', '')]), 'apex').members.map(u => u.id), ['f(Integer)', 'f(String)']);
    const banner = 'public class B {\n    // ======\n    // Setup helpers\n    // ======\n\n    /** Makes one. */\n    static void make() {\n        x();\n    }\n}\n';
    assert.deepStrictEqual(M.units(banner, 'apex').members.map(u => [u.id, u.l0, u.l1]), [['comment Setup helpers', 1, 5], ['make()', 5, 9]]);
    assert.strictEqual(CM.memberDiffs(cls([m('a()', 'x();')]), cls([m('a()', 'y();'), m('b()', '')]), 'apex'), 2, 'Compare: members that differ');
  });



  ok('code checks: conflict markers left, brackets that do not balance (strings, comments, template literals skipped), a member defined twice; conflict blocks with both sides', () => {
    const C = require('../src/codeChecks');
    const conflict = 'public class A {\n<<<<<<< HEAD\n    Integer x = 1;\n=======\n    Integer x = 2;\n>>>>>>> feature/US-0012345\n}\n';
    assert.deepStrictEqual(C.blocks(conflict).map(b => [b.b0, b.b1, b.ours.join('').trim(), b.theirs.join('').trim()]), [[1, 6, 'Integer x = 1;', 'Integer x = 2;']]);
    assert.deepStrictEqual(C.problems(conflict, 'apex').map(p => [p.line, p.severity, /Conflict markers left/.test(p.message)]), [[2, 'error', true]]);
    assert.deepStrictEqual(C.problems('public class A {\n    void f() {\n    }\n    }\n}\n', 'apex').map(p => [p.line, p.message]), [[5, 'A closing } with nothing open']]);
    assert.deepStrictEqual(C.problems('public class A {\n    void f() {\n        String s = "}";\n}\n', 'apex').map(p => [p.line, p.message]), [[1, 'This { is never closed']], 'the brace in a string is not one');
    assert.deepStrictEqual(C.problems('public class A {\n    void f(Integer a) {\n    }\n    void f(Integer b) {\n    }\n}\n', 'apex').map(p => [p.line, p.severity]), [[4, 'warning']]);
    assert.deepStrictEqual(C.problems('export default class X {\n    // } not a brace\n    get t() { return `${this.a} }`; }\n}\n', 'javascript'), []);
    assert.deepStrictEqual(C.problems('<template><p>{x}</p></template>\n', 'html'), [], 'templates: no bracket checks');
  });

  ok('a promotion\u2019s code opens on Copado\u2019s conflict file - the conflict to resolve in one panel or two; saving with it unresolved warns first', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra code '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const T = 'public class A {\n    Integer x = 1;\n}\n', F = 'public class A {\n    Integer x = 2;\n}\n';
      const conflict = 'public class A {\n<<<<<<< HEAD\n    Integer x = 1;\n=======\n    Integer x = 2;\n>>>>>>> feature/US-0012345\n}\n';
      const mv = await realMergeView(root, {});
      const r = put('r.cls', conflict);
      await mv.deps().startSession(mv.vs.Uri.file(put('t.cls', T)), mv.vs.Uri.file(put('f.cls', F)), null, { applyToUri: mv.vs.Uri.file(r), applyOnSave: true, openAfterApply: false, theirs: 'the feature branch', startFrom: conflict });
      const w = mv.webviews[mv.webviews.length - 1];
      await w.send({ type: 'ready' });
      const init = w.last('init');
      assert.deepStrictEqual([init.language, init.text, init.marks.git, init.marks.rows.map(x => x.label + ' ' + x.chosen), init.marks.counts.needs], ['apex', 'public class A {\n}\n', true, ['property x none'], 1]);
      // two panels: the same conflict, the same count - and the choice is the setting
      await w.send({ type: 'codeView', view: 'twoPanes', seq: 5, text: init.text });
      const two = w.last('marks').marks;
      assert.deepStrictEqual([two.single, two.left, two.rows.length, two.counts.needs, mv.vs.config['cmr.merge.codeView']], [false, T, 1, 1, 'twoPanes']);
      await w.send({ type: 'codeView', view: 'onePane', seq: 6, text: init.text });
      // Save & Close with it unresolved: warned first - and No keeps it open
      mv.vs.answers.warn.push({ re: /not resolved yet/, v: undefined });
      await w.send({ type: 'save', close: true, text: init.text });
      assert.strictEqual(fs.readFileSync(r, 'utf8'), conflict, 'nothing written');
      // the feature's accepted: saved
      await w.send({ type: 'save', close: true, text: F });
      assert.strictEqual(fs.readFileSync(r, 'utf8'), F, 'saved');
    } finally { rmTree(root); }
  });



  section('3.11.2: blank lines');

  ok('blank lines and trailing spaces are no difference - in a comparison of code, and in metadata', () => {
    const cls = body => 'public class A {\n' + body + '}\n', f = (n, b) => '    void ' + n + '() {\n        ' + b + '\n    }\n';
    const T2 = cls(f('x', 'a();') + f('y', 'b();'));
    for (const Y of [T2.replace('a();', 'a();   '), cls(f('x', 'a();') + '\n' + f('y', 'b();'))]) assert.deepStrictEqual(MA().align(T2, null, Y, { type: null, mode: 'literal' }).pieces.filter(p => p.kind !== 'same' && p.kind !== 'blank'), []);
    const ps = '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fieldPermissions>\n        <editable>true</editable>\n        <field>Account.Region__c</field>\n        <readable>true</readable>\n    </fieldPermissions>\n    <label>P</label>\n</PermissionSet>\n';
    assert.deepStrictEqual(MA().align(ps, ps, ps.replace(/>\n/g, '>   \n'), { type: 'PermissionSet' }).pieces.filter(p => p.kind !== 'same'), [], 'trailing spaces in XML');
  });



  section('3.13.0: Clean Working Files');

  ok('Clean Working Files: what the working folder holds listed, promotions with resolutions not uploaded named, emptied only when you say - its .gitignore kept; not while a merge is open', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra clean '));
    try {
      const st = path.join(root, '.copado');
      const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(st, f)), { recursive: true }); fs.writeFileSync(path.join(st, f), t); };
      put('.gitignore', '*\n'); put('manual/abc123def456/target/x.xml', '<a/>'); put('reports/r.md', 'report');
      put('promotions/P12345/promotion.json', JSON.stringify({ files: { 'a.xml': { state: 'resolved' }, 'b.xml': { state: 'uploaded' } } }));
      const mv = await realMergeView(root, {});
      const run = mv.vs.registered['cmr.storage.clean'];
      // No: nothing removed - and it said what is there, and what would be lost
      mv.vs.answers.warn.push({ re: /Empty .copado\?/, v: undefined });
      await run();
      const asked = mv.vs.log.warn.find(w => /Empty .copado\?/.test(w));
      assert.ok(asked, 'asked first: ' + JSON.stringify(mv.vs.log.warn));
      assert.ok(/manual \(1 file/.test(asked) && /promotions/.test(asked), asked);
      assert.ok((mv.vs.log.details || []).some(d => /not uploaded to Copado yet will be lost: P12345 \(1\)/.test(d)), 'the promotion named');
      assert.ok(fs.existsSync(path.join(st, 'reports', 'r.md')), 'nothing removed');
      // Empty it: everything but its .gitignore
      mv.vs.answers.warn.push({ re: /Empty .copado\?/, v: 'Empty it' });
      await run();
      assert.deepStrictEqual(fs.readdirSync(st), ['.gitignore']);
    } finally { rmTree(root); }
  });

  section('3.13.0: Compare');

  ok('the branches, and what differs between two of them - for each provider, from the connected repository', async () => {
    const R = require('../src/repoHost');
    const changed = [{ path: 'force-app/main/default/permissionsets/Sales_Ops.permissionset-meta.xml', kind: 'changed' }, { path: 'force-app/main/default/classes/New.cls', kind: 'added' }, { path: 'force-app/main/default/flexipages/Old.flexipage-meta.xml', kind: 'removed' }];
    const g = await h.fakeGitHosts({ branches: ['feature/US-0012345', 'uat', 'main'], changed });
    try {
      for (const [provider, url, token] of [['azure', g.base + '/org/Proj/_git/repo', 'az-token'], ['github', g.base + '/owner/repo', 'gh-token'],
        ['gitlab', g.base + '/group/repo', 'gl-token'], ['bitbucket', g.base + '/ws/repo', 'me@example.com:bb-token']]) {
        const host = R.createHost(R.parseRepoUrl(url, provider), token);
        assert.deepStrictEqual(await host.listBranches(), ['feature/US-0012345', 'main', 'uat'], provider + ': the branches');
        assert.deepStrictEqual((await host.changedFiles('feature/US-0012345', 'uat')).map(f => f.kind + ' ' + f.path.split('/').pop()), ['changed Sales_Ops.permissionset-meta.xml', 'added New.cls', 'removed Old.flexipage-meta.xml'], provider);
      }
    } finally { g.server.close(); }
    // Azure DevOps a page at a time - two changes a page here, a folder among them: every page read, nothing missing
    const many = []; for (let i = 0; i < 7; i++) many.push({ path: 'force-app/main/default/' + (i < 5 ? 'objects/O' + i + '.object-meta.xml' : 'profiles/P' + i + '.profile-meta.xml'), kind: 'changed' });
    const g2 = await h.fakeGitHosts({ changed: many, azurePage: 2 });
    try {
      const az = R.createHost(R.parseRepoUrl(g2.base + '/org/Proj/_git/repo', 'azure'), 'az-token');
      const got = await az.changedFiles('feature/US-0012345', 'uat');
      assert.deepStrictEqual([got.length, got.incomplete, got.filter(f => /profiles/.test(f.path)).length], [7, undefined, 2], 'the profiles at the end are there');
    } finally { g2.server.close(); }
    // GitHub's first 300 files only: the list said to be cut short
    const lots = []; for (let i = 0; i < 300; i++) lots.push({ path: 'force-app/main/default/classes/C' + i + '.cls', kind: 'changed' });
    const g3 = await h.fakeGitHosts({ changed: lots });
    try { assert.strictEqual((await R.createHost(R.parseRepoUrl(g3.base + '/owner/repo', 'github'), 'gh-token').changedFiles('a', 'b')).incomplete, true); } finally { g3.server.close(); }
  });

  ok('a file\u2019s type and name from its folder; only the project\u2019s metadata; what differs, in a few words', () => {
    const CB = require('../src/compareBranches');
    const d = 'force-app/main/default/';
    assert.deepStrictEqual([d + 'permissionsets/Sales_Ops.permissionset-meta.xml', d + 'objects/Account/fields/Region__c.field-meta.xml', d + 'classes/TaxHelper.cls', d + 'lwc/opsCard/opsCard.js', d + 'objects/Account/Account.object-meta.xml'].map(CB.groupOf),
      [{ type: 'Permission sets', name: 'Sales_Ops' }, { type: 'Custom fields', name: 'Account.Region__c' }, { type: 'Apex classes', name: 'TaxHelper.cls' }, { type: 'Lightning web components', name: 'opsCard \u00b7 opsCard.js' }, { type: 'Objects', name: 'Account' }]);
    assert.deepStrictEqual([CB.inProject(d + 'classes/A.cls'), CB.inProject('README.md'), CB.inProject('src/x.cls', ['src'])], [true, false, true]);
    const fp = f => '    <fieldPermissions>\n        <editable>true</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
    const ps = b => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + b + '    <label>P</label>\n</PermissionSet>\n';
    assert.strictEqual(CB.summarize('x.permissionset-meta.xml', ps(fp('A.a__c')), ps(fp('A.a__c') + fp('A.b__c') + fp('A.a__c'))), '2 elements differ \u00b7 1 duplicate');
    assert.strictEqual(CB.summarize('x.permissionset-meta.xml', ps(fp('A.b__c') + fp('A.a__c')), ps(fp('A.a__c') + fp('A.b__c'))), 'only spacing or order differs', 'Salesforce sorts them');
    assert.strictEqual(CB.summarize('T.cls', 'public class T {\n    void a() {\n        x();\n    }\n}\n', 'public class T {\n    void a() {\n        y();\n    }\n}\n'), '1 member differs');
    assert.deepStrictEqual([CB.summarize('a.xml', null, '<a/>'), CB.summarize('a.xml', '<a/>', null)], ['only in the From branch', 'only in the To branch']);
    // only spacing, or order where it does not count: the same file
    assert.deepStrictEqual(['only spacing differs', 'only spacing or order differs', '1 element differs', '2 members differ', null].map(CB.same), [true, true, false, false, false]);
    assert.ok(CB.same(CB.summarize('x.permissionset-meta.xml', ps(fp('A.a__c')), ps(fp('A.a__c')).replace(/>\n/g, '>   \n').replace(/^    </gm, '  <'))), 'spacing only: the same');
  });

  ok('the Compare tab: the branches read, two compared, the files grouped with what differs; one opened in the merge editor - the To branch read-only, a copy of the From to work on; one only on one side opened to read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra cmp '));
    try {
      const vs = fakeCode(root, {});
      const opened = [];
      vs.workspace.openTextDocument = async o => { opened.push(o); return { uri: vs.Uri.file(path.join(root, 'x')), getText: () => o.content }; };
      vs.window.showTextDocument = async () => ({});
      const [C] = loadWith(vs, ['../compareUi']);
      const d = 'force-app/main/default/';
      const T = '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n    <labels>\n        <fullName>A</fullName>\n        <value>Hello</value>\n    </labels>\n</CustomLabels>\n';
      const files = { uat: { [d + 'labels/CustomLabels.labels-meta.xml']: T, [d + 'flexipages/Old.flexipage-meta.xml']: '<FlexiPage/>' }, 'feature/US-0012345': { [d + 'labels/CustomLabels.labels-meta.xml']: T.replace('Hello', 'Hi'), [d + 'classes/New.cls']: 'public class New {\n}\n' } };
      let host = null;
      const started = [];
      C.activate({ subscriptions: [] }, { host: async () => host, packageDirs: () => ['force-app'], storageDir: async sub => vs.Uri.file(path.join(root, '.copado', sub)), startSession: async (...a) => { started.push(a); } });
      // nothing connected: said, nothing asked
      await C.act('compare.load');
      assert.deepStrictEqual([C.snapshot().connected, C.snapshot().branches], [false, []]);
      host = { listBranches: async () => ['feature/US-0012345', 'main', 'uat'], readFile: async (b, p) => files[b][p] == null ? null : Buffer.from(files[b][p]),
        changedFiles: async () => [{ path: d + 'labels/CustomLabels.labels-meta.xml', kind: 'changed' }, { path: d + 'classes/New.cls', kind: 'added' }, { path: d + 'flexipages/Old.flexipage-meta.xml', kind: 'removed' }, { path: 'README.md', kind: 'changed' }] };
      await C.act('compare.refresh');
      assert.deepStrictEqual(C.snapshot().branches, ['feature/US-0012345', 'main', 'uat']);
      await C.act('compare.set', { side: 'from', value: 'feature/US-0012345' });
      await C.act('compare.set', { side: 'to', value: 'uat' });
      await C.act('compare.run');
      // removed or changed first, then what is new; a summary only once its row is shown and asked for
      assert.deepStrictEqual(C.snapshot().files.map(f => [f.type, f.name, f.kind, f.summary]), [['Lightning pages', 'Old', 'removed', null], ['Custom labels', 'CustomLabels', 'changed', null], ['Apex classes', 'New.cls', 'added', null]], 'README.md is not metadata');
      await C.act('compare.summaries', { paths: [d + 'labels/CustomLabels.labels-meta.xml'] });
      assert.deepStrictEqual([C.snapshot().files[1].summary, C.snapshot().files[1].same], ['1 element differs', false]);
      // opened: the merge editor, the To branch on the left, a copy of the From to work on
      await C.act('compare.open', { path: d + 'labels/CustomLabels.labels-meta.xml' });
      const [to, from, anc, so] = started[0];
      assert.deepStrictEqual([fs.readFileSync(to.fsPath, 'utf8'), fs.readFileSync(from.fsPath, 'utf8'), anc, so.compare, so.manual, so.applyOnSave, so.startFrom, so.labels.target], [T, T.replace('Hello', 'Hi'), null, true, true, false, T.replace('Hello', 'Hi'), 'uat']);
      // only on one side: opened to read
      await C.act('compare.open', { path: d + 'classes/New.cls' });
      assert.deepStrictEqual([opened.length, opened[0].content, started.length], [1, 'public class New {\n}\n', 1]);
      // Reset: the branches and what was found, at once
      await C.act('compare.reset');
      assert.deepStrictEqual([C.snapshot().from, C.snapshot().to, C.snapshot().files], [null, null, null]);
      await C.act('compare.set', { side: 'from', value: 'feature/US-0012345' });
      // a list the repository cut short: said
      const short = Object.assign([{ path: d + 'labels/CustomLabels.labels-meta.xml', kind: 'changed' }], { incomplete: true });
      const was = host.changedFiles; host.changedFiles = async () => short;
      await C.act('compare.set', { side: 'to', value: 'uat' });
      await C.act('compare.run');
      assert.ok(/listed only the first 1 changed files/.test(C.snapshot().error), C.snapshot().error);
      host.changedFiles = was;
      // the same branch twice: not compared
      await C.act('compare.set', { side: 'to', value: 'feature/US-0012345' });
      await C.act('compare.run');
      assert.strictEqual(C.snapshot().error, 'Choose two different branches.');
    } finally { rmTree(root); }
  });

  ok('the page\u2019s Compare tab: branches searched, Reset; the files grouped - removed or changed first - one chip, icon and button style; a Types filter with its own search; Search by name; nothing connected - Connect repository', () => {
    const page = runPage();
    const d = 'force-app/main/default/', CB = require('../src/compareBranches');
    const F = (p, kind, summary) => Object.assign({ path: d + p, kind, summary }, CB.groupOf(d + p));
    page.state({ copadoOrg: 'copado', recent: [], current: null, compare: { connected: false } });
    page.message({ type: 'nav', nav: 'Compare' });
    assert.ok(/No repository connected/.test(page.text()) && /data-c="compare.connect"/.test(page.html), 'nothing connected');
    const files = [F('classes/TaxHelper.cls', 'changed', '2 members differ'), F('permissionsets/Billing.permissionset-meta.xml', 'added', null), F('permissionsets/Sales_Ops.permissionset-meta.xml', 'changed', '4 elements differ \u00b7 1 duplicate'), F('objects/Account/fields/Old__c.field-meta.xml', 'removed', null)];
    page.state({ copadoOrg: 'copado', recent: [], current: null, compare: { connected: true, branches: ['feature/US-0012345', 'uat'], from: 'feature/US-0012345', to: 'uat', files } });
    const t = page.text();
    for (const w of ['Compare branches', '1 removed', '2 changed', '1 new', '1 with duplicates', 'Removed or changed', 'New in feature/US-0012345', 'Apex classes', 'Permission sets', 'Custom fields', '4 elements differ \u00b7 1 duplicate', 'All types', 'Reset']) assert.ok(t.includes(w), w);
    assert.ok(!/only in /.test(t) && !/Every file the From branch/.test(t), 'no detail a developer does not need');
    assert.ok(t.indexOf('Removed or changed') < t.indexOf('New in feature/US-0012345'), 'removed or changed first');
    assert.ok(/data-cq="to" value="uat"/.test(page.html) && /placeholder="Search"/.test(page.html), 'the branches in their search boxes; Search by name');
    assert.strictEqual((page.html.match(/data-c="compare.open"/g) || []).length, 4);
    assert.strictEqual((page.html.match(/class="btn secondary small" data-c="compare.open"/g) || []).length, 4, 'Compare and Open: the same button');
    // the Types filter: its list, with its own search; one type chosen - only it
    page.click({ ctopen: '1' });
    assert.ok(/placeholder="Search types"/.test(page.html) && /data-ctype="Permission sets"/.test(page.html));
    page.click({ ctype: 'Permission sets' });
    const t2 = page.text();
    assert.ok(t2.includes('Sales_Ops') && t2.includes('Billing') && !t2.includes('TaxHelper.cls'), 'only permission sets');
    page.click({ ctclear: '1' });
    assert.ok(page.text().includes('TaxHelper.cls'), 'all types again');
    page.click({ c: 'compare.reset' });
    assert.deepStrictEqual(page.posted.filter(m => m.scope === 'compare').pop(), { type: 'act', scope: 'compare', name: 'compare.reset', payload: {} });
  });


  ok('comparing code - Manual, Compare: the two versions side by side, nothing merged, no conflicts, no choices', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra cmpc '));
    try {
      const put = (n, t) => { const f = path.join(root, n); fs.writeFileSync(f, t); return f; };
      const T = 'public class A {\n    Integer x = 1;\n}\n', F = 'public class A {\n    Integer x = 2;\n}\n';
      const mv = await realMergeView(root, {});
      await mv.deps().startSession(mv.vs.Uri.file(put('t.cls', T)), mv.vs.Uri.file(put('f.cls', F)), null, { manual: true, compare: true, applyOnSave: false, openAfterApply: false, theirs: 'feature/US-0012345', startFrom: F, labels: { target: 'uat', incoming: 'feature/US-0012345', merged: 'feature/US-0012345' } });
      const w = mv.webviews[mv.webviews.length - 1];
      await w.send({ type: 'ready' });
      const init = w.last('init');
      assert.deepStrictEqual([init.plain, init.text, init.marks.plain, init.marks.counts.differs, init.marks.rows, init.marks.left], [true, F, true, 1, [], T]);
      // the other side edited: compared again
      await w.send({ type: 'text', side: 'left', seq: 3, text: F });
      assert.strictEqual(w.last('marks').marks.counts.differs, 0, 'the same now');
    } finally { rmTree(root); }
  });


  section('3.13.1: working files kept only so long');

  ok('old working files removed by themselves - never a promotion with resolutions not uploaded, never what is in use, never the history; 0 days: never', () => {
    const R = require('../src/retention');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cra keep '));
    try {
      const put = (f, t, daysAgo) => { const p = path.join(root, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t || 'x'); const when = new Date(Date.now() - daysAgo * 86400000); fs.utimesSync(p, when, when); fs.utimesSync(path.dirname(p), when, when); };
      put('compare/aaa/to/x.xml', '', 30);
      put('compare/bbb/to/x.xml', '', 2);
      put('promotions/P10001/promotion.json', JSON.stringify({ files: { 'a.xml': { state: 'uploaded' } } }), 40);
      put('promotions/P10002/promotion.json', JSON.stringify({ files: { 'a.xml': { state: 'resolved' } } }), 40);
      put('manual/ccc/target/x.xml', '', 30);
      put('history/v.json', '[]', 400);
      for (const d of ['compare/aaa', 'promotions/P10001', 'promotions/P10002', 'manual/ccc']) { const when = new Date(Date.now() - 30 * 86400000); fs.utimesSync(path.join(root, d), when, when); }
      assert.deepStrictEqual(R.prune(root, { days: 0 }), [], '0: never');
      const busy = p => p === path.join(root, 'manual', 'ccc');
      assert.deepStrictEqual(R.prune(root, { days: 14, busy }).sort(), ['compare/aaa', 'promotions/P10001']);
      for (const f of ['compare/bbb', 'promotions/P10002', 'manual/ccc', 'history/v.json']) assert.ok(fs.existsSync(path.join(root, f)), f + ' kept');
    } finally { rmTree(root); }
  });

  section('3.0: what is shipped');

  ok('the package: every command registered and contributed, every setting read, the Command Palette short, nothing removed left behind', () => {
    const root = path.join(__dirname, '..');
    const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const files = ['extension.js', 'release.js', 'promotionUi.js', 'lifecycleUi.js', 'releasePage.js', 'manualUi.js'].concat(fs.readdirSync(path.join(root, 'src')).map(f => 'src/' + f));
    const code = files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    const declared = p.contributes.commands.map(c => c.command);
    const registered = [...code.matchAll(/cmd\('(cmr\.[\w.]+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(declared.filter(c => !registered.includes(c)), [], 'contributed but never registered');
    assert.deepStrictEqual(registered.filter(c => !declared.includes(c)), [], 'registered but not contributed');
    const menus = Object.values(p.contributes.menus).flat().map(m => m.command);
    assert.deepStrictEqual(menus.filter(c => !declared.includes(c)), [], 'a menu points at a command that does not exist');
    const page = fs.readFileSync(path.join(root, 'media', 'page.js'), 'utf8');
    assert.deepStrictEqual([...page.matchAll(/'(cmr\.[\w.]+)'/g)].map(m => m[1]).filter(c => !declared.includes(c)), [], 'the page calls a command that does not exist');
    const hidden = p.contributes.menus.commandPalette.filter(m => m.when === 'false').map(m => m.command);
    const visible = declared.filter(c => !hidden.includes(c));
    // the starting points: preparing, inspecting and validating a story are on its page, merging two files on the Manual tab
    assert.deepStrictEqual(visible.sort(), ['cmr.git.check', 'cmr.openSettings', 'cmr.page.open', 'cmr.policy.create', 'cmr.promotion.open', 'cmr.repo.connect', 'cmr.repo.forget', 'cmr.storage.clean', 'cmr.writeWorkspaceSettings'],
      'the Command Palette keeps its starting points: ' + visible.join(', '));
    const settings = Object.assign({}, ...p.contributes.configuration.map(g => g.properties));
    const keys = Object.keys(settings).map(k => k.slice(4));
    const used = new Set([...code.matchAll(/\.get\('([a-zA-Z]+\.[a-zA-Z.]+)'/g)].map(m => m[1]));
    assert.deepStrictEqual(keys.filter(k => !used.has(k) && !code.includes("'cmr." + k + "'")), [], 'a setting nothing reads');
    assert.deepStrictEqual([...used].filter(k => !keys.includes(k) && !['lastTests', 'recentPromotions'].some(w => k.endsWith(w))), [], 'a setting read but not declared');
    for (const gone of ['cmr.selective.folder', 'cmr.selective.autoImport', 'cmr.selective.confirm', 'cmr.selective.import', 'cmr.selective.download', 'cmr.selective.undo']) {
      assert.ok(!(gone in settings) && !declared.includes(gone) && !code.includes("'" + gone.slice(4) + "'") && !code.includes("'" + gone + "'"), gone + ' is gone');
    }
    for (const k of ['cmr.http.proxy', 'cmr.http.caFile', 'cmr.repo.promotionBranch', 'cmr.guard.environments', 'cmr.copado.watchSeconds']) assert.ok(k in settings, k);
    assert.ok(p.capabilities.untrustedWorkspaces.restrictedConfigurations.includes('cmr.http.proxy'), 'a proxy is not taken from a folder you have not trusted');
    assert.deepStrictEqual(p.activationEvents, ['onLanguage:xml', 'onLanguage:json', 'onStartupFinished']);
    assert.ok(/^3\.\d+\.\d+$/.test(p.version));
    // what ships carries no one's real records: promotion and story numbers are only the extension's own examples
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
    const shipped = (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const rel = path.relative(root, path.join(d, e.name)).split(path.sep).join('/');
      if (/^(\.git|node_modules|test|\.github)(\/|$)/.test(rel)) return [];
      return e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|json|md|css|txt|xml)$/.test(e.name) ? [rel] : [];
    }); })(root);
    assert.ok(/^test\/\*\*$/m.test(ignore), 'tests are not shipped');
    const examples = new Set(['P12345', 'US-0012345']);
    const real = [];
    for (const f of shipped) for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/\b(P\d{5,}|US-\d{5,})\b/g)) if (!examples.has(m[1]) && !/^CHANGELOG\.md$/.test(f)) real.push(f + ': ' + m[1]);
    assert.deepStrictEqual(real, [], 'a real-looking promotion or story number in what ships');
    const css = fs.readFileSync(path.join(root, 'media', 'page.css'), 'utf8');
    assert.deepStrictEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g), ['#fff'], 'only theme colours on the page');
  });
};

