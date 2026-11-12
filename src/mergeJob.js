'use strict';

/**
 * The whole merge computation for one session, as plain data in and out, so
 * it can run in a worker thread and keep the extension host responsive.
 *
 * In:  { targetText, incomingText, ancestorText?, merge: {...}, format: {...},
 *        normalize, rules: { enable, disabled } }
 * Out: { ok, error?, warning?, typeName, threeWay, report, marks, mergedText,
 *        targetText, incomingText, checks, lines, timings }
 */
const X = require('./xmlParser');
const merger = require('./merge');
const formatter = require('./formatter');
const rules = require('./rules');

function runMergeJob(job) {
  const timings = {};
  const time = (key, fn) => {
    const start = Date.now();
    const out = fn();
    timings[key] = (timings[key] || 0) + (Date.now() - start);
    return out;
  };

  const target = time('parse', () => X.parse(job.targetText));
  const incoming = time('parse', () => X.parse(job.incomingText));
  let ancestor = job.ancestorText ? time('parse', () => X.parse(job.ancestorText)) : null;
  if (!target.root || !incoming.root) return { ok: false, error: 'One of the files has no XML root element.' };
  if (target.root.name !== incoming.root.name) {
    return { ok: false, error: 'These are different metadata types: ' + target.root.name + ' and ' + incoming.root.name + '.' };
  }
  let warning = null;
  if (ancestor && (!ancestor.root || ancestor.root.name !== target.root.name)) {
    warning = 'The ancestor is not the same metadata type, so this will be a two-way merge.';
    ancestor = null;
  }

  const result = time('merge', () => merger.merge(target, incoming, Object.assign({}, job.merge, { ancestor })));
  const marks = [];
  const mergedText = time('format', () => formatter.format({ root: result.merged, src: '' }, Object.assign({}, job.format, { marks })));
  const targetText = job.normalize ? time('format', () => formatter.format(target, job.format)) : job.targetText;
  const incomingText = job.normalize ? time('format', () => formatter.format(incoming, job.format)) : job.incomingText;

  let checks = [];
  if (job.rules && job.rules.enable) {
    checks = time('checks', () => {
      const parsed = X.parse(mergedText);
      const starts = X.lineStarts(mergedText);
      return rules.check(parsed, { disabled: job.rules.disabled || [] }).map(v => ({
        id: v.id, severity: v.severity, message: v.message, line: X.lineAt(starts, v.node.start)
      }));
    });
  }

  return {
    ok: true, warning,
    typeName: result.typeName, threeWay: result.threeWay,
    report: result.report, marks,
    mergedText, targetText, incomingText, checks,
    lines: Math.max(countLines(job.targetText), countLines(job.incomingText)),
    timings
  };
}

function countLines(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

module.exports = { runMergeJob };
