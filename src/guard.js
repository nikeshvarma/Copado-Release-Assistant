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
 *     "minimumTestLevel": { "production": "RunLocalTests", "uat": "RunSpecifiedTests" }
 *   }
 *
 * Orgs are matched by alias or username, with * as a wildcard; the keys
 * "production" and "sandbox" match by org kind.
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
  return { allowed: list(p.allowedTargetOrgs), blocked: list(p.blockedTargetOrgs), allowProduction: p.allowProduction !== false, minimum: min };
}

/**
 * May this org be validated against, and with which test level?
 * org: { alias, username, isSandbox }. Returns { allowed, reason?, testLevel, raisedFrom?, rule? }.
 */
function check(policy, org, testLevel) {
  const who = org.alias || org.username;
  if (policy.broken) return { allowed: false, reason: 'the team policy file is broken - fix copado-policy.json first' };
  if (policy.blocked.some(p => matches(p, org))) return { allowed: false, reason: who + ' is blocked by the team policy' };
  if (policy.allowed.length && !policy.allowed.some(p => matches(p, org))) {
    return { allowed: false, reason: who + ' is not in the policy\u2019s allowed target orgs (' + policy.allowed.join(', ') + ')' };
  }
  if (!policy.allowProduction && org.isSandbox === false) return { allowed: false, reason: who + ' is a production org, and the policy does not allow validating against production' };
  let level = testLevel, raisedFrom, rule;
  for (const [pattern, minLevel] of Object.entries(policy.minimum)) {
    if (matches(pattern, org) && rank(level) < rank(minLevel)) { raisedFrom = raisedFrom || level; level = minLevel; rule = pattern; }
  }
  return { allowed: true, testLevel: level, raisedFrom, rule };
}

module.exports = { LEVELS, rank, matches, resolvePolicy, check };
