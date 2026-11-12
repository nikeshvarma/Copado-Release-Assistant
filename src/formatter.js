'use strict';

const X = require('./xmlParser');
const registry = require('./registry');
const { keyOf, specAt, compareKeys } = require('./keys');

// element names in plain character order, as the Metadata API writes them
const tieBreak = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const DEFAULT_OPTS = {
  indent: 4,
  eol: '\n',
  elementOrder: 'standard',   // standard | alphabetical | preserve
  sortCollections: true,
  typeOrder: null,            // { PermissionSet: ['label', ...] } - top-level order per type
  leadingElements: null,      // { PermissionSet: ['label', ...] } - just pull these to the top
  removeDuplicates: false,
  keep: 'first',
  marks: null                 // pass an array to receive { mark, startLine, endLine }
};

/**
 * Writes a metadata tree as text in one pass.
 *
 * Order rules, matching what Salesforce writes: at the top level, fullName
 * first and the rest alphabetically in plain character order (or the order in
 * typeOrder). Below the top level, tags keep their source order. Entries of a
 * collection are sorted, case-sensitively, only where the registry says order
 * is meaningless - so a retrieved file comes out unchanged.
 */
function format(parsed, options) {
  const o = Object.assign({}, DEFAULT_OPTS, options || {});
  if (!parsed.root) return null;
  const typeName = parsed.root.name;

  const pad = ' '.repeat(o.indent);
  const indents = [''];
  const indent = d => {
    while (indents.length <= d) indents.push(indents[indents.length - 1] + pad);
    return indents[d];
  };

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  emit(parsed.root, [], 0, null);
  return lines.join(o.eol) + o.eol;

  function emit(el, path, depth, leading) {
    const ind = indent(depth);
    if (leading) for (const c of leading) lines.push(ind + '<!--' + c + '-->');
    const at = el.attrText ? el.attrText.trim() : '';
    const open = '<' + el.name + (at ? ' ' + at : '');
    const ownStart = lines.length;
    const kids = X.elements(el);

    if (!kids.length) {
      let inner = el.inner;
      if (!inner) {
        const cs = el.children.filter(c => c.type === X.COMMENT);
        if (cs.length) inner = cs.map(c => '<!--' + c.value + '-->').join('');
      }
      if (el.selfClosing && !inner) {
        lines.push(ind + open + '/>');
      } else if (inner && (inner.indexOf('\n') !== -1)) {
        // multi-line values (formulas, long text) are kept exactly as written
        lines.push(ind + open + '>' + inner.replace(/^\s*\r?\n/, '').replace(/\s+$/, ''));
        lines.push(ind + '</' + el.name + '>');
      } else {
        lines.push(ind + open + '>' + (inner || '').trim() + '</' + el.name + '>');
      }
    } else {
      lines.push(ind + open + '>');

      // comments travel with the element that follows them
      let commentsFor = null;
      let trailing = null;
      if (el.children.length !== kids.length) {
        let pending = [];
        for (const c of el.children) {
          if (c.type === X.COMMENT) pending.push(c.value);
          else if (c.type === X.ELEMENT && pending.length) {
            (commentsFor || (commentsFor = new Map())).set(c, pending);
            pending = [];
          }
        }
        if (pending.length) trailing = pending;
      }

      const groups = new Map();
      const seenOrder = [];
      for (const k of kids) {
        let g = groups.get(k.name);
        if (!g) { g = []; groups.set(k.name, g); seenOrder.push(k.name); }
        g.push(k);
      }

      for (const tag of path.length === 0 ? topLevelOrder(seenOrder) : seenOrder) {
        let entries = groups.get(tag);
        if (entries.length > 1) {
          const spec = specAt(typeName, path, tag);
          if (!spec.noDedupe && o.removeDuplicates) entries = dedupe(entries, spec, o.keep);
          if (entries.length > 1 && spec.sortable && o.sortCollections) {
            entries = entries
              .map((e, i) => ({ e, i, k: sortKey(e, spec) }))
              .sort((a, b) => compareKeys(a.k, b.k) || a.i - b.i)
              .map(x => x.e);
          }
        }
        let childPath = null;
        for (const c of entries) {
          // a leaf never needs a path, so only build one for blocks
          if (!childPath && X.hasElementChildren(c)) childPath = path.concat(tag);
          emit(c, childPath || path, depth + 1, commentsFor ? commentsFor.get(c) : null);
        }
      }
      if (trailing) for (const c of trailing) lines.push(indent(depth + 1) + '<!--' + c + '-->');
      lines.push(ind + '</' + el.name + '>');
    }

    if (o.marks && el.mark) o.marks.push({ mark: el.mark, startLine: ownStart, endLine: lines.length - 1 });
  }

  function topLevelOrder(seenOrder) {
    let order = seenOrder.slice();
    if (o.elementOrder !== 'preserve') {
      const override = o.typeOrder ? o.typeOrder[typeName] : null;
      const spec = Array.isArray(override) && override.length ? override : registry.orderFor(typeName);
      const explicit = ((o.elementOrder === 'standard' || Array.isArray(override)) && Array.isArray(spec)) ? spec : null;
      if (explicit) {
        const rank = new Map(explicit.map((t, i) => [t, i]));
        order.sort((a, b) => {
          const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
          const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
          return ra !== rb ? ra - rb : tieBreak(a, b);
        });
      } else {
        order.sort((a, b) => {
          if (a === b) return 0;
          if (a === 'fullName') return -1;
          if (b === 'fullName') return 1;
          return tieBreak(a, b);
        });
      }
    }
    const lead = o.leadingElements && (o.leadingElements[typeName] || o.leadingElements['*']);
    if (Array.isArray(lead) && lead.length) {
      const rank = new Map(lead.map((t, i) => [t, i]));
      order = order.slice().sort((a, b) => {
        const ra = rank.has(a) ? rank.get(a) : -1;
        const rb = rank.has(b) ? rank.get(b) : -1;
        if (ra >= 0 && rb >= 0) return ra - rb;
        if (ra >= 0) return -1;
        if (rb >= 0) return 1;
        return 0;
      });
    }
    return order;
  }
}

function sortKey(el, spec) {
  const k = keyOf(el, spec);
  return k ? k.value : X.canonical(el);
}

function dedupe(entries, spec, keep) {
  const out = [];
  const index = new Map();
  for (const el of entries) {
    const k = keyOf(el, spec);
    const id = k && k.value !== '' ? k.value : X.canonical(el);
    if (index.has(id)) {
      if (keep === 'last') out[index.get(id)] = el;
    } else {
      index.set(id, out.length);
      out.push(el);
    }
  }
  return out;
}

module.exports = { format };
