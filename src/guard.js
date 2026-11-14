'use strict';

/**
 * Guardrails for validation targets and test levels, from a team policy file
 * (copado-policy.json at the project root, committed and reviewed like code)
 * or, without one, from settings.
 *
 *   {
 *     "allowedTargetOrgs": ["qa", "uat", "*.qa"],      // empty or missing: any org
 *     "blockedTargetOrgs": ["prod*"],
 *     "allowProduction": true,                          // false: never validate against production
 *     "minimumTestLevel": { "production": "RunLocalTests", "uat": "RunSpecifiedTests" },
 *     "environments": {                                  // per Copado environment, by its name
 *       "UAT":        { "minimumTestLevel": "RunLocalTests", "coverage": 85 },
 *       "Production": { "requiredTargetUser": "release.user@*", "minimumTestLevel": "RunLocalTests" }
 *     }
 *   }
 *
 * Orgs are matched by alias or username, with * as a wildcard; the keys
 * "production" and "sandbox" match by org kind. Environment names match
 * case-insensitively, with * as a wildcard. requiredTargetUser is the login a
 * validation for that stage must use (a pattern, or a list of them); coverage
 * is the lowest per-class coverage, in percent, for the Apex in the package.
 */
const LEVELS = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];

function rank(level) { const i = LEVELS.indexOf(level); return i < 0 ? 0 : i; }

function matches(pattern, org) {
  const p = String(pattern || '').trim();
  if (!p) return false;
  if (p === '*') return true;
  if (p.toLowerCase() === 'production') return org.isSandbox === false;
  if (p.toLowerCase() === 'sandbox') return org.isSandbox === true;
  const re = new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return [org.alias, org.username].filter(Boolean).some(v => re.test(v));
}

/** Policy file text wins; otherwise the settings. Returns { policy, source, error }. */
function resolvePolicy(fileText, settings) {
  if (fileText != null) {
    try {
      const p = JSON.parse(fileText);
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('it must be a JSON object');
      return { policy: normalise(p), source: 'copado-policy.json' };
    } catch (e) {
      // a broken policy must not mean "no policy": block until it is fixed
      return { policy: { broken: true }, source: 'copado-policy.json', error: 'copado-policy.json cannot be read: ' + e.message };
    }
  }
  return { policy: normalise(settings || {}), source: 'settings' };
}

function normalise(p) {
  const list = v => (Array.isArray(v) ? v : []).map(String).map(s => s.trim()).filter(Boolean);
  const min = {};
  for (const [k, v] of Object.entries(p.minimumTestLevel || {})) if (LEVELS.includes(v)) min[k] = v;
  const envs = {};
  for (const [name, r] of Object.entries(p.environments && typeof p.environments === 'object' ? p.environments : {})) {
    if (!r || typeof r !== 'object') continue;
    const cov = Number(r.coverage);
    envs[name] = {
      minimumTestLevel: LEVELS.includes(r.minimumTestLevel) ? r.minimumTestLevel : null,
      requiredTargetUser: list([].concat(r.requiredTargetUser || [])),
      coverage: r.coverage != null && cov >= 0 && cov <= 100 ? cov : null
    };
  }
  return { allowed: list(p.allowedTargetOrgs), blocked: list(p.blockedTargetOrgs), allowProduction: p.allowProduction !== false, minimum: min, environments: envs };
}

/** The rule for a Copado environment, by name (case-insensitive, * as a wildcard), or null. */
function environmentRule(policy, name) {
  if (!name || !policy.environments) return null;
  const keys = Object.keys(policy.environments);
  const exact = keys.find(k => k.toLowerCase() === String(name).toLowerCase());
  const key = exact || keys.find(k => k.includes('*') && new RegExp('^' + k.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(name));
  return key ? Object.assign({ name: key }, policy.environments[key]) : null;
}

/**
 * May this org be validated against, and with which test level?
 * org: { alias, username, isSandbox }. Returns { allowed, reason?, testLevel, raisedFrom?, rule? }.
 */
function check(policy, org, testLevel, context) {
  const cx = context || {};
  const who = org.alias || org.username;
  if (policy.broken) return { allowed: false, reason: 'the team policy file is broken - fix copado-policy.json first' };
  if (policy.blocked.some(p => matches(p, org))) return { allowed: false, reason: who + ' is blocked by the team policy' };
  if (policy.allowed.length && !policy.allowed.some(p => matches(p, org))) {
    return { allowed: false, reason: who + ' is not in the policy\u2019s allowed target orgs (' + policy.allowed.join(', ') + ')' };
  }
  if (!policy.allowProduction && org.isSandbox === false) return { allowed: false, reason: who + ' is a production org, and the policy does not allow validating against production' };
  const env = environmentRule(policy, cx.environment);
  if (env && env.requiredTargetUser.length) {
    const user = cx.username || org.username;
    if (!user || user === org.alias) return { allowed: false, reason: 'the ' + cx.environment + ' stage must be validated as ' + env.requiredTargetUser.join(' or ') + ', and the Salesforce CLI cannot say which user ' + who + ' logs in as', environmentRule: env };
    if (!env.requiredTargetUser.some(p => matches(p, { username: user }))) {
      return { allowed: false, reason: 'the ' + cx.environment + ' stage must be validated as ' + env.requiredTargetUser.join(' or ') + ' - ' + who + ' logs in as ' + user, environmentRule: env };
    }
  }
  let level = testLevel, raisedFrom, rule;
  for (const [pattern, minLevel] of Object.entries(policy.minimum)) {
    if (matches(pattern, org) && rank(level) < rank(minLevel)) { raisedFrom = raisedFrom || level; level = minLevel; rule = pattern; }
  }
  if (env && env.minimumTestLevel && rank(level) < rank(env.minimumTestLevel)) { raisedFrom = raisedFrom || level; level = env.minimumTestLevel; rule = 'environment ' + env.name; }
  // a coverage rule needs tests to measure it
  if (env && env.coverage != null && cx.hasApex && level === 'NoTestRun') { raisedFrom = raisedFrom || level; level = 'RunSpecifiedTests'; rule = 'environment ' + env.name + ' coverage'; }
  return { allowed: true, testLevel: level, raisedFrom, rule, coverage: env ? env.coverage : null, environmentRule: env };
}

/**
 * Apex in the package below the stage's coverage. coverage: [{ name, percent }]
 * from the validation; names: the Apex classes and triggers deployed (test
 * classes left out by the caller). Returns { below: [{ name, percent }], unreported: [names] }.
 */
function belowCoverage(coverage, minimum, names) {
  const by = new Map((coverage || []).map(c => [String(c.name).toLowerCase(), c]));
  const below = [], unreported = [];
  for (const n of names || []) {
    const c = by.get(String(n).toLowerCase());
    if (!c) unreported.push(n);
    else if (c.percent < minimum) below.push({ name: n, percent: c.percent });
  }
  return { below, unreported };
}

module.exports = { LEVELS, rank, matches, resolvePolicy, check, environmentRule, belowCoverage };
