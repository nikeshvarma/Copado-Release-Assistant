'use strict';

const X = require('./xmlParser');
const registry = require('./registry');
const { keyOf, specAt, labelOf } = require('./keys');

/**
 * Finds duplicates using Salesforce semantics:
 *  - duplicate-key    two <fieldPermissions> for the same <field>, etc.
 *  - duplicate-exact  two byte-identical entries with no identity key
 *  - duplicate-single a scalar element that may only appear once
 *
 * Returns findings sorted by source offset.
 */
function findDuplicates(parsed, options) {
  const opts = Object.assign({ warnRepeatedSingletons: true }, options || {});
  const findings = [];
  if (!parsed.root) return findings;
  const typeName = parsed.root.name;
  const strict = registry.isStrict(typeName);

  walk(parsed.root, []);

  function walk(parent, path) {
    const kids = X.elements(parent);
    const groups = new Map();
    for (const kid of kids) {
      if (!groups.has(kid.name)) groups.set(kid.name, []);
      groups.get(kid.name).push(kid);
    }

    for (const [tag, nodes] of groups) {
      const spec = specAt(typeName, path, tag);

      if (nodes.length > 1 && !spec.noDedupe) {
        const seen = new Map();
        const unkeyed = [];
        for (const node of nodes) {
          const k = keyOf(node, spec);
          if (k && k.value !== '') {
            const prev = seen.get(k.value);
            if (prev) {
              findings.push(make(node, prev, tag, spec, k.kind === 'text' ? 'duplicate-exact' : 'duplicate-key', typeName, path, X.canonical(node) === X.canonical(prev)));
            } else {
              seen.set(k.value, node);
            }
          } else {
            unkeyed.push(node);
          }
        }
        // No identity key available. For a collection the registry describes,
        // that means the entry is positional (an empty layout space, a column)
        // and repeats are legal. For anything else, byte-identical entries are
        // still worth reporting.
        const byContent = new Map();
        for (const node of spec.known ? [] : unkeyed) {
          const c = X.canonical(node);
          const prev = byContent.get(c);
          if (prev) findings.push(make(node, prev, tag, spec, 'duplicate-exact', typeName, path, true));
          else byContent.set(c, node);
        }

        if (strict && !spec.known && path.length === 0 && opts.warnRepeatedSingletons) {
          for (let i = 1; i < nodes.length; i++) {
            findings.push({
              node: nodes[i],
              first: nodes[0],
              tag,
              kind: 'duplicate-single',
              identical: X.canonical(nodes[i]) === X.canonical(nodes[0]),
              key: '',
              label: '',
              message: '<' + tag + '> appears ' + nodes.length + ' times. ' + typeName + ' allows it only once.',
              severity: 'error'
            });
          }
        }
      }

      for (const node of nodes) walk(node, path.concat(tag));
    }
  }

  const byOffset = new Map();
  for (const f of findings) {
    const prev = byOffset.get(f.node.start);
    if (!prev || rank(f.kind) > rank(prev.kind)) byOffset.set(f.node.start, f);
  }
  return Array.from(byOffset.values()).sort((a, b) => a.node.start - b.node.start);
}

function rank(kind) {
  return kind === 'duplicate-key' ? 3 : kind === 'duplicate-exact' ? 2 : 1;
}

function make(node, first, tag, spec, kind, typeName, path, identical) {
  const label = labelOf(node, spec);
  const where = path.length ? typeName + ' > ' + path.join(' > ') : typeName;
  let message;
  if (kind === 'duplicate-key') {
    message = 'Duplicate <' + tag + '> in ' + where + ': ' + label +
      (identical ? ' (identical entry).' : ' (same key, different values - pick one).');
  } else {
    message = 'Duplicate <' + tag + '> in ' + where + (label ? ': ' + label : '') + '.';
  }
  return {
    node, first, tag, kind, identical,
    key: (keyOf(node, spec) || {}).value || '',
    label,
    message,
    severity: identical ? 'warning' : 'error'
  };
}

/** Removes duplicate entries, keeping either the first or the last occurrence. */
function dedupeEdits(parsed, findings, keep) {
  const src = parsed.src;
  const victims = [];
  if (keep === 'last') {
    const seen = new Set();
    for (let i = findings.length - 1; i >= 0; i--) {
      const f = findings[i];
      const id = f.tag + '\u0000' + f.key + '\u0000' + f.first.start;
      if (seen.has(id)) { victims.push(f.node); continue; }
      seen.add(id);
      victims.push(f.first);
    }
  } else {
    for (const f of findings) victims.push(f.node);
  }

  const ranges = [];
  for (const node of victims) {
    let start = node.start;
    let lineStart = src.lastIndexOf('\n', start - 1) + 1;
    if (src.slice(lineStart, start).trim() === '') start = lineStart;
    let end = node.end;
    const after = src.slice(end);
    const m = after.match(/^[ \t]*\r?\n/);
    if (m) end += m[0].length;
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push(Object.assign({}, r));
  }
  return merged;
}

module.exports = { findDuplicates, dedupeEdits };
