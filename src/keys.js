'use strict';

const X = require('./xmlParser');
const registry = require('./registry');

/**
 * The Salesforce identity of a repeated element, e.g. a <fieldPermissions>
 * entry is identified by its <field>, a <layoutAssignments> entry by
 * <layout> + <recordType>. Returns null when the element has no usable
 * identity (then only an exact content match counts as a duplicate).
 */
function keyOf(el, spec) {
  if (!X.hasElementChildren(el)) {
    return { value: X.textOf(el), kind: 'text' };
  }
  const parts = [];
  for (const name of spec.key || []) {
    const c = X.childByName(el, name);
    if (c) parts.push(name + '=' + X.textOf(c));
  }
  if (!parts.length) return null;
  return { value: parts.join('|'), kind: 'key' };
}

function specAt(typeName, path, tag) {
  return registry.specFor(typeName, path, tag);
}

/** Human readable label for an entry, used in the compare view. */
function labelOf(el, spec) {
  if (!X.hasElementChildren(el)) {
    const t = X.textOf(el);
    return t.length > 60 ? t.slice(0, 57) + '\u2026' : t;
  }
  const k = keyOf(el, spec);
  if (!k) return '';
  return k.value.split('|').map(p => p.slice(p.indexOf('=') + 1)).join(' / ');
}

/**
 * Entry order the way Salesforce writes it: plain character order, case
 * sensitive - "ACME_Agreement__c" before "Account__c", because capitals come
 * before lowercase letters.
 */
function compareKeys(a, b) {
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = { keyOf, specAt, labelOf, compareKeys };
