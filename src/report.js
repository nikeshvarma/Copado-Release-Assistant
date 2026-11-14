'use strict';

/**
 * The readiness report of a promotion: one Markdown page with its stories
 * and where each stands, the components, the validations run per stage (from
 * this project's validation history), tests and coverage, open conflicts and
 * likely ones. Written under .copado/reports/. Plain Node.js - the data is
 * gathered by the caller.
 *
 * o: { name, status, to, stories: [{ name, title, status, env, hotfix }], components: [{ t, n, a }],
 *      validations: [history entries, newest first], conflicts: [{ promotion, status, files, open }],
 *      overlaps: [{ type, name, stories, severity }], missing: [story names without a component list], at }
 */
const md = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const when = iso => iso ? String(iso).slice(0, 16).replace('T', ' ') : '';

function verdict(o) {
  const out = [];
  const open = (o.conflicts || []).filter(c => c.open);
  if (open.length) out.push(['no', open.length + ' promotion' + (open.length === 1 ? ' has' : 's have') + ' unresolved conflicts: ' + open.map(c => c.promotion + ' (' + c.files + ' file' + (c.files === 1 ? '' : 's') + ')').join(', ')]);
  const last = o.validations[0];
  if (!last) out.push(['warn', 'No validation from this project is recorded for it.']);
  else if (!last.success) out.push(['no', 'The latest validation failed: ' + last.label + ' against ' + (last.environment || last.targetOrg) + ' on ' + when(last.at) + '.']);
  else out.push(['ok', 'The latest validation passed: ' + last.label + ' against ' + (last.environment || last.targetOrg) + ' on ' + when(last.at) + '.']);
  const low = o.validations.filter(v => (v.belowCoverage || []).length);
  if (low[0]) out.push(['no', 'Coverage below the stage\u2019s ' + low[0].coverageRule + '% in the latest check of ' + (low[0].environment || low[0].targetOrg) + ': ' + low[0].belowCoverage.map(c => c.name + ' ' + c.percent + '%').join(', ')]);
  const high = (o.overlaps || []).filter(x => x.severity === 'high');
  if ((o.overlaps || []).length) out.push(['warn', o.overlaps.length + ' component' + (o.overlaps.length === 1 ? ' is' : 's are') + ' changed by more than one story' + (high.length ? ' (' + high.length + ' code)' : '') + ' - likely conflicts.']);
  if ((o.missing || []).length) out.push(['warn', 'No component list for ' + o.missing.join(', ') + ' - commit in Copado first.']);
  if (!out.some(x => x[0] !== 'ok')) out.push(['ok', 'Nothing found that would hold this up.']);
  return out;
}

function readiness(o) {
  const icon = k => ({ ok: '\u2705', warn: '\u26a0\ufe0f', no: '\u274c' })[k] || '\u2022';
  const L = [];
  L.push('# Readiness: ' + o.name, '', '> Promotion' + (o.status ? ' \u00b7 ' + o.status : '') + (o.to ? ' \u00b7 to ' + o.to : '') +
    ' \u00b7 generated ' + when(o.at || new Date().toISOString()) + ' by Copado Release Assistant. Read-only: nothing in Copado was changed.', '');
  L.push('## Summary', '', ...verdict(o).map(([k, t]) => '- ' + icon(k) + ' ' + t), '');
  L.push('## Stories (' + o.stories.length + ')', '');
  if (o.stories.length) {
    L.push('| Story | Title | Stage | Status |', '| --- | --- | --- | --- |');
    for (const s of o.stories) L.push('| ' + md(s.name) + (s.hotfix ? ' (hotfix)' : '') + ' | ' + md(s.title) + ' | ' + md(s.env || '') + ' | ' + md(s.status) + ' |');
  }
  const comps = new Map();
  for (const r of o.components || []) { if (/^RetrieveOnly$/i.test(r.a || '')) continue; const k = r.t + '|' + r.n; if (!comps.has(k)) comps.set(k, r); }
  const byType = {};
  for (const r of comps.values()) byType[r.t] = (byType[r.t] || 0) + 1;
  L.push('', '## Components (' + comps.size + ')', '');
  if (comps.size) {
    L.push(Object.entries(byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => t + ' ' + n).join(' \u00b7 '), '');
    const deletes = [...comps.values()].filter(r => /^Delete$/i.test(r.a || ''));
    if (deletes.length) L.push('Deleted: ' + deletes.map(r => '`' + r.t + ' ' + r.n + '`').join(', '), '');
  }
  L.push('## Validations per stage', '');
  if (o.validations.length) {
    const seen = new Set();
    L.push('| Stage | When | From | As | Tests | Result |', '| --- | --- | --- | --- | --- | --- |');
    for (const v of o.validations) {
      const stage = v.environment || v.targetOrg || '?';
      if (seen.has(stage)) continue;
      seen.add(stage);
      L.push('| ' + md(stage) + ' | ' + when(v.at) + ' | ' + md((v.branches || []).join(', ') || v.source || '') + ' | ' + md(v.username || v.targetOrg || '') + ' | ' + md(v.testLevel) +
        ' | ' + (v.success ? '\u2705 passed' : '\u274c ' + (v.componentErrors || 0) + ' error' + (v.componentErrors === 1 ? '' : 's') + ', ' + (v.testFailures || 0) + ' test failure' + (v.testFailures === 1 ? '' : 's')) + ' |');
    }
    L.push('', '_The newest validation per stage. ' + o.validations.length + ' recorded in all._');
  } else L.push('None recorded from this project yet.');
  const cov = o.validations.find(v => (v.coverage || []).length);
  L.push('', '## Tests and coverage', '');
  if (cov) {
    L.push('From the validation against ' + (cov.environment || cov.targetOrg) + ' on ' + when(cov.at) + (cov.coverageRule != null ? ', stage minimum ' + cov.coverageRule + '%' : '') + ':', '');
    L.push('| Class | Coverage |', '| --- | --- |');
    for (const c of cov.coverage.slice().sort((a, b) => a.percent - b.percent)) L.push('| ' + md(c.name) + ' | ' + c.percent + '%' + (cov.coverageRule != null && c.percent < cov.coverageRule ? ' \u274c' : '') + ' |');
  } else L.push('No coverage recorded - validate with tests to see it here.');
  L.push('', '## Conflicts', '');
  const conf = o.conflicts || [];
  if (conf.length) { L.push('| Promotion | Status | Files | Open |', '| --- | --- | --- | --- |'); for (const c of conf) L.push('| ' + md(c.promotion) + ' | ' + md(c.status) + ' | ' + c.files + ' | ' + (c.open ? 'yes' : 'no') + ' |'); }
  else L.push('No promotion conflicts found.');
  if ((o.overlaps || []).length) {
    L.push('', '### Likely conflicts', '', '| Component | Stories |', '| --- | --- |');
    for (const x of o.overlaps) L.push('| ' + md(x.type + ' ' + x.name) + (x.severity === 'high' ? ' (code)' : '') + ' | ' + md(x.stories.join(', ')) + ' |');
  }
  return L.join('\n') + '\n';
}

module.exports = { readiness, verdict };
