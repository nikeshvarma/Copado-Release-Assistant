'use strict';

const X = require('./xmlParser');
const registry = require('./registry');
const { keyOf, specAt, labelOf } = require('./keys');

/**
 * Merges two versions of a metadata file, optionally using the common
 * ancestor so decisions can be made instead of guessed.
 *
 * Two-way (no ancestor):
 *   nothing in the target is dropped except duplicates, entries only in the
 *   incoming file are added, and a value both files set takes the incoming
 *   one and is reported as a conflict.
 *
 * Three-way (ancestor supplied):
 *   a value only the incoming side changed is taken silently; a value only
 *   the target changed is kept silently; only a value both sides changed is
 *   a conflict. An entry the incoming side deleted is still kept - the target
 *   never loses anything - but it is reported so you can drop it yourself.
 *   An entry the target deleted is not resurrected.
 *
 * options:
 *   ancestor    parsed common ancestor, or null for two-way
 *   winner      'incoming' (default) or 'target' - who wins a real conflict
 *   dedupe      remove duplicate entries while merging (default true)
 *   keep        'first' or 'last' occurrence when deduplicating
 *   keepTarget  paths that must always come from the target
 */
function merge(targetParsed, incomingParsed, options) {
  const o = Object.assign({
    winner: 'incoming', dedupe: true, keep: 'first', keepTarget: [], ancestor: null
  }, options || {});
  if (o.winner === 'base') o.winner = 'target';

  const report = {
    added: [], updated: [], conflicts: [], duplicates: [], reviews: [],
    policy: [], auto: [], deletions: [], skipped: []
  };

  if (!targetParsed.root || !incomingParsed.root) {
    const only = targetParsed.root || incomingParsed.root;
    return { merged: only ? clone(only) : null, report, typeName: only ? only.name : null, threeWay: false };
  }

  const typeName = targetParsed.root.name;
  const ancestorRoot = o.ancestor && o.ancestor.root && o.ancestor.root.name === typeName ? o.ancestor.root : null;
  const merged = mergeEl(targetParsed.root, incomingParsed.root, ancestorRoot, [], []);
  return { merged, report, typeName, threeWay: !!ancestorRoot };

  function mergeEl(a, b, c, path, crumbs) {
    const complexA = X.hasElementChildren(a);
    const complexB = X.hasElementChildren(b);
    const where = crumbs.join(' > ') || a.name;

    if (!complexA && !complexB) {
      const ta = X.textOf(a);
      const tb = X.textOf(b);
      if (ta === tb) return a;

      const tc = c && !X.hasElementChildren(c) ? X.textOf(c) : undefined;
      if (tc !== undefined) {
        if (tc === ta) {                      // only the incoming side moved
          const auto = { path: where, tag: a.name, from: ta, to: tb, side: 'incoming' };
          report.auto.push(auto);
          return marked(b, { kind: 'auto', auto });
        }
        if (tc === tb) {                      // only the target moved
          report.auto.push({ path: where, tag: a.name, from: tc, to: ta, side: 'target' });
          return a;
        }
      }

      const entry = {
        path: where, tag: a.name, base: ta, incoming: tb, ancestor: tc,
        kept: o.winner === 'incoming' ? tb : ta,
        multiline: /\r?\n/.test(ta) || /\r?\n/.test(tb)
      };
      report.conflicts.push(entry);
      return marked(o.winner === 'incoming' ? b : a, { kind: 'conflict', conflict: entry });
    }

    if (complexA !== complexB) {
      const entry = {
        path: where, tag: a.name, base: '(nested block)', incoming: '(single value)',
        kept: o.winner, multiline: true
      };
      report.conflicts.push(entry);
      return marked(o.winner === 'incoming' ? b : a, { kind: 'conflict', conflict: entry });
    }

    const out = shallow(a);
    const ga = groupOf(a);
    const gb = groupOf(b);
    const gc = c ? groupOf(c) : null;
    const tags = Array.from(ga.keys());
    for (const t of gb.keys()) if (!ga.has(t)) tags.push(t);

    for (const tag of tags) {
      const la = ga.get(tag) || [];
      const lb = gb.get(tag) || [];
      const lc = gc ? (gc.get(tag) || []) : [];
      const spec = specAt(typeName, path, tag);
      const childPath = path.concat(tag);
      const label = t => labelOf(t, spec);
      const pathText = childPath.join(' > ');

      // Environment-specific section: the incoming version is ignored outright.
      if (matchesPolicy(o.keepTarget, typeName, childPath)) {
        if (la.length || lb.length) {
          report.policy.push({ path: pathText, kept: la.length, ignored: lb.length });
        }
        for (const n of la) out.children.push(n);
        continue;
      }

      // A scalar the registry does not list as a collection.
      if (la.length <= 1 && lb.length <= 1 && !spec.known) {
        if (la[0] && lb[0]) {
          out.children.push(mergeEl(la[0], lb[0], lc[0] || null, childPath, crumbs.concat(tag)));
        } else if (la[0]) {
          if (lc.length) {
            const entry = { path: pathText, label: label(la[0]) };
            report.deletions.push(entry);
            out.children.push(marked(la[0], { kind: 'deleted', deletion: entry }));
          } else {
            out.children.push(la[0]);
          }
        } else if (lc.length) {
          report.skipped.push({ path: pathText, label: label(lb[0]) });   // target deleted it
        } else {
          const entry = { path: pathText, label: label(lb[0]) };
          report.added.push(entry);
          out.children.push(marked(lb[0], { kind: 'added', added: entry }));
        }
        continue;
      }

      // A scalar a strict type allows only once, duplicated by an earlier merge.
      if (o.dedupe && !spec.known && path.length === 0 && registry.isStrict(typeName) &&
        (la.length > 1 || lb.length > 1)) {
        const pool = (o.winner === 'incoming' && lb.length) ? lb : (la.length ? la : lb);
        const winnerNode = o.keep === 'last' ? pool[pool.length - 1] : pool[0];
        const wc = X.canonical(winnerNode);
        const dropped = la.concat(lb).filter(n => n !== winnerNode);
        for (const n of dropped) {
          report.duplicates.push({
            path: pathText, label: X.textOf(n), identical: X.canonical(n) === wc,
            side: la.indexOf(n) !== -1 ? 'target' : 'incoming', singleton: true
          });
        }
        out.children.push(dropped.length
          ? marked(winnerNode, { kind: 'dedup', dupes: report.duplicates.slice(-dropped.length) })
          : winnerNode);
        continue;
      }

      // keys are computed once per entry and reused below
      const ida = spec.noDedupe ? null : la.map(n => idOf(n, spec));
      const idb = spec.noDedupe ? null : lb.map(n => idOf(n, spec));
      const keyable = !spec.noDedupe && ida.every(Boolean) && idb.every(Boolean);

      if (keyable) {
        const ancestorKeys = new Map();
        for (const n of lc) {
          const id = idOf(n, spec);
          if (id && !ancestorKeys.has(id)) ancestorKeys.set(id, n);
        }

        const slots = [];
        const index = new Map();

        for (let ai = 0; ai < la.length; ai++) {
          const n = la[ai];
          const id = ida[ai];
          if (index.has(id)) {
            const slot = slots[index.get(id)];
            if (o.dedupe) {
              const entry = {
                path: pathText, label: label(n),
                identical: X.canonical(n) === X.canonical(slot.base), side: 'target'
              };
              report.duplicates.push(entry);
              (slot.dupes = slot.dupes || []).push(entry);
              if (o.keep === 'last') slot.base = n;
              continue;
            }
          }
          index.set(id, slots.length);
          slots.push({ base: n, id, incoming: null, ancestor: ancestorKeys.get(id) || null });
        }

        for (let bi = 0; bi < lb.length; bi++) {
          const n = lb[bi];
          const id = idb[bi];
          if (index.has(id)) {
            const slot = slots[index.get(id)];
            if (slot.incoming) {
              const entry = {
                path: pathText, label: label(n),
                identical: X.canonical(n) === X.canonical(slot.incoming), side: 'incoming'
              };
              report.duplicates.push(entry);
              (slot.dupes = slot.dupes || []).push(entry);
              if (o.keep === 'last') slot.incoming = n;
              continue;
            }
            slot.incoming = n;
            continue;
          }
          if (gc && ancestorKeys.has(id)) {
            report.skipped.push({ path: pathText, label: label(n) });     // the target deleted this
            continue;
          }
          const entry = { path: pathText, label: label(n) };
          report.added.push(entry);
          index.set(id, slots.length);
          slots.push({ base: null, incoming: n, addedEntry: entry, ancestor: null });
        }

        for (const slot of slots) {
          if (slot.base && slot.incoming) {
            let node = slot.base;
            const before = X.canonical(slot.base);
            if (before !== X.canonical(slot.incoming)) {
              node = mergeEl(slot.base, slot.incoming, slot.ancestor, childPath,
                crumbs.concat(tag + (label(slot.base) ? ' [' + label(slot.base) + ']' : '')));
              if (X.canonical(node) !== before) report.updated.push({ path: pathText, label: label(slot.base) });
            }
            out.children.push(slot.dupes ? marked(node, { kind: 'dedup', dupes: slot.dupes }) : node);
            continue;
          }
          const node = slot.base || slot.incoming;
          if (slot.addedEntry) out.children.push(marked(node, { kind: 'added', added: slot.addedEntry }));
          else if (slot.dupes) out.children.push(marked(node, { kind: 'dedup', dupes: slot.dupes }));
          else if (slot.base && gc && ancestorKeys.has(slot.id)) {
            const entry = { path: pathText, label: label(slot.base) };
            report.deletions.push(entry);                                  // incoming deleted it
            out.children.push(marked(node, { kind: 'deleted', deletion: entry }));
          } else {
            out.children.push(node);
          }
        }
        continue;
      }

      // Positional collection: every target entry keeps its place, and only
      // incoming entries that are not already there are appended.
      const seen = new Set();
      for (const n of la) {
        const canon = X.canonical(n);
        if (o.dedupe && seen.has(canon) && !spec.noDedupe) {
          report.duplicates.push({ path: pathText, label: label(n), identical: true, side: 'target' });
          continue;
        }
        seen.add(canon);
        out.children.push(n);
      }
      const ancestorCanon = new Set(lc.map(X.canonical));
      for (const n of lb) {
        const canon = X.canonical(n);
        if (seen.has(canon)) continue;
        if (gc && ancestorCanon.has(canon)) {
          report.skipped.push({ path: pathText, label: label(n) || '(positional entry)' });
          continue;
        }
        seen.add(canon);
        const entry = { path: pathText, label: label(n) || '(positional entry)', review: true };
        report.added.push(entry);
        report.reviews.push(entry);
        out.children.push(marked(n, { kind: 'added', added: entry }));
      }
    }
    return out;
  }
}

/**
 * Policy entries may be a bare tag ("userLicense"), a path inside the file
 * ("fields/description") or a type-qualified path ("Profile/loginIpRanges").
 */
function matchesPolicy(list, typeName, path) {
  if (!list || !list.length) return false;
  const full = path.join('/');
  const tag = path[path.length - 1];
  for (const raw of list) {
    const rule = String(raw).replace(/^\/+|\/+$/g, '');
    if (!rule) continue;
    if (rule === tag || rule === full) return true;
    if (rule === typeName + '/' + full || rule === typeName + '/' + tag) return true;
    if (rule.indexOf('/') !== -1 && full.endsWith('/' + rule)) return true;
  }
  return false;
}

/**
 * Annotates a node for the editor. Parsed nodes are shared with the input
 * documents, so they are copied before being annotated - the merge never
 * changes its inputs.
 */
function marked(node, mark) {
  const n = node._els ? clone(node) : node;
  if (!n.mark) n.mark = mark;
  return n;
}

function idOf(n, spec) {
  const k = keyOf(n, spec);
  return k && k.value !== '' ? k.value : null;
}

function groupOf(parent) {
  const g = new Map();
  for (const c of X.elements(parent)) {
    if (!g.has(c.name)) g.set(c.name, []);
    g.get(c.name).push(c);
  }
  return g;
}

function shallow(el) {
  return {
    type: X.ELEMENT,
    name: el.name,
    attrText: el.attrText || '',
    attrs: el.attrs || [],
    selfClosing: false,
    children: []
  };
}

function clone(el) {
  const out = shallow(el);
  out.selfClosing = el.selfClosing;
  if (!X.hasElementChildren(el)) {
    out.inner = el.inner !== undefined ? el.inner : '';
    out.children = el.children.filter(c => c.type === X.TEXT || c.type === X.CDATA);
    return out;
  }
  for (const c of el.children) {
    if (c.type === X.ELEMENT) out.children.push(clone(c));
    else if (c.type === X.COMMENT) out.children.push({ type: X.COMMENT, value: c.value });
  }
  return out;
}

/** One line per change, for the output panel. */
function reportLines(report, targetName, incomingName, ancestorName) {
  const r = report;
  const lines = [];
  lines.push('Mode: ' + (ancestorName ? 'three-way, using the common ancestor' : 'two-way, no ancestor'));
  lines.push('Target (nothing removed): ' + targetName);
  lines.push('Incoming (wins a real conflict): ' + incomingName);
  if (ancestorName) lines.push('Ancestor: ' + ancestorName);
  lines.push('');
  lines.push('Added ' + r.added.length +
    ', updated ' + r.updated.length +
    (ancestorName ? ', auto-resolved ' + r.auto.length : '') +
    ', duplicates removed ' + r.duplicates.length +
    ', conflicts ' + r.conflicts.length +
    (ancestorName ? ', deleted in incoming ' + r.deletions.length + ', not resurrected ' + r.skipped.length : ''));
  lines.push('');

  if (r.added.length) {
    lines.push('Added from ' + incomingName + ':');
    for (const a of r.added) lines.push('  + ' + a.path + (a.label ? ' [' + a.label + ']' : '') + (a.review ? '   <- positional, please review' : ''));
    lines.push('');
  }
  if (r.auto.length) {
    lines.push('Resolved automatically - only one side had changed:');
    for (const a of r.auto) lines.push('  ' + (a.side === 'incoming' ? '>' : '<') + ' ' + a.path + ': "' + a.from + '" -> "' + a.to + '" (' + a.side + ' changed it)');
    lines.push('');
  }
  if (r.updated.length) {
    lines.push('Existing entries updated:');
    for (const u of r.updated) lines.push('  ~ ' + u.path + (u.label ? ' [' + u.label + ']' : ''));
    lines.push('');
  }
  if (r.conflicts.length) {
    lines.push('Real conflicts - both sides changed the same value:');
    for (const c of r.conflicts) {
      lines.push('  ! ' + c.path + ': target "' + c.base + '" vs incoming "' + c.incoming + '"' +
        (c.ancestor !== undefined ? ' (was "' + c.ancestor + '")' : '') + ' -> kept "' + c.kept + '"');
    }
    lines.push('');
  }
  if (r.deletions.length) {
    lines.push('Deleted on the incoming side, KEPT in the result - drop them from the panel if you want them gone:');
    for (const d of r.deletions) lines.push('  x ' + d.path + (d.label ? ' [' + d.label + ']' : ''));
    lines.push('');
  }
  if (r.skipped.length) {
    lines.push('Deleted on the target side, not brought back:');
    for (const sk of r.skipped) lines.push('  - ' + sk.path + (sk.label ? ' [' + sk.label + ']' : ''));
    lines.push('');
  }
  if (r.policy && r.policy.length) {
    lines.push('Kept from the target by policy (incoming version ignored):');
    for (const p of r.policy) lines.push('  = ' + p.path + ' - kept ' + p.kept + ', ignored ' + p.ignored + ' incoming');
    lines.push('');
  }
  if (r.duplicates.length) {
    lines.push('Duplicates removed:');
    for (const d of r.duplicates) {
      lines.push('  - ' + d.path + (d.label ? ' [' + d.label + ']' : '') +
        (d.identical ? ' (identical copy)'
          : d.singleton ? ' (this tag is only allowed once - check the value that went)'
            : ' (SAME KEY, DIFFERENT VALUES - check this one)') +
        ' from ' + d.side + ' file');
    }
    lines.push('');
  }
  if (!r.added.length && !r.updated.length && !r.duplicates.length && !r.conflicts.length && !r.auto.length) {
    lines.push('The two files already describe the same metadata.');
    lines.push('');
  }
  return lines;
}

module.exports = { merge, reportLines };
