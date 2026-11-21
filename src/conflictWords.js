'use strict';

/**
 * A metadata conflict in plain words, worked out from where it is in the file - the element git's block sits in is
 * usually named outside the block: "Section Information › field Dispute_Amount__c: Behavior Required → Readonly".
 *
 *   annotate(conflictText, conflicts) -> each conflict given { about, sides: { target, feature }, both }:
 *     about  what the choice means, one line - what the promotion page lists (the editor's rows show their label alone)
 *     sides  each version in a few words - shown above its version, in its own panel
 *     both   B3.6: when the two stories each add their own entry at the same place, the text that keeps the two
 *            (git lined up the entries' wrapper tags, so it is the target's lines, the wrapper closed and opened
 *            again, then the feature's); otherwise absent - both versions of one element are rarely valid (B3.1)
 *
 * Each side is rebuilt from Copado's file, as the union join does: git's merge outside the blocks, each block's
 * version inside. A side that does not parse leaves the conflict with the words its own lines give.
 */
const X = require('./xmlParser');
const XC = require('./xmlCompare');
const { blocks } = require('./codeChecks');

const split = t => String(t == null ? '' : t).split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1);
const ACCESS = new Set(['PermissionSet', 'Profile', 'MutingPermissionSet']);

// what Setup calls an element - its tag in words otherwise
const ELEMENT_WORDS = {
  layoutItems: 'field', layoutSections: 'section', layoutColumns: 'column', fieldPermissions: 'field permission', objectPermissions: 'object permission',
  classAccesses: 'class access', pageAccesses: 'page access', userPermissions: 'user permission', tabSettings: 'tab', tabVisibilities: 'tab',
  recordTypeVisibilities: 'record type', applicationVisibilities: 'app', customPermissions: 'custom permission', layoutAssignments: 'layout assignment',
  decisions: 'decision', rules: 'rule', formulas: 'formula', assignments: 'assignment', assignmentItems: 'assignment', recordLookups: 'Get Records',
  recordUpdates: 'Update Records', recordCreates: 'Create Records', recordDeletes: 'Delete Records', screens: 'screen', variables: 'variable',
  constants: 'constant', loops: 'loop', actionCalls: 'action', subflows: 'subflow', textTemplates: 'text template', choices: 'choice', waits: 'wait',
  value: 'value', customValue: 'value', componentInstanceProperties: 'property', itemInstances: 'component', flexiPageRegions: 'region',
  validationRules: 'validation rule', fields: 'field', labels: 'label', listViews: 'list view', webLinks: 'button or link', recordTypes: 'record type',
  compactLayouts: 'compact layout', fieldSets: 'field set', platformActionListItems: 'action', quickActionListItems: 'action', relatedLists: 'related list',
  translations: 'translation', values: 'value', picklistValues: 'picklist', processMetadataValues: 'process value', inputAssignments: 'input',
  outputAssignments: 'output', filters: 'filter', conditions: 'condition', targets: 'target', properties: 'property', fieldInstance: 'field',
  componentInstance: 'component', customMetadataValues: 'value', categoryGroups: 'category group'
};
// a leaf that is the value itself - its element says what it is, the tag adds nothing
const VALUE_LEAVES = new Set(['value', 'stringValue', 'numberValue', 'booleanValue', 'dateValue', 'dateTimeValue', 'elementReference']);
const LEAF_WORDS = {
  editable: 'Edit access', readable: 'Read access', enabled: 'Enabled', visible: 'Visible', allowCreate: 'Create', allowRead: 'Read', allowEdit: 'Edit',
  allowDelete: 'Delete', viewAllRecords: 'View All', modifyAllRecords: 'Modify All', viewAllFields: 'View All Fields', visibility: 'Tab visibility',
  behavior: 'Behavior', expression: 'Formula', formula: 'Formula', errorConditionFormula: 'Error condition formula', errorMessage: 'Error message',
  errorDisplayField: 'Error location', description: 'Description', active: 'Active', label: 'Label', masterLabel: 'Label', dataType: 'Data type',
  fullName: 'API name', default: 'Default', operator: 'Operator', leftValueReference: 'Field', assignToReference: 'Variable', targetReference: 'Next element',
  inlineHelpText: 'Help text', required: 'Required', defaultValue: 'Default value', length: 'Length', precision: 'Precision', scale: 'Scale',
  type: 'Type', shortDescription: 'Short description', protected: 'Protected', language: 'Language', isActive: 'Active', processType: 'Flow type',
  status: 'Status', apiVersion: 'API version', defaultLabelValue: 'Default value', name: 'Name', object: 'Object', sortOrder: 'Sort order',
  value: 'Value', stringValue: 'Value', numberValue: 'Value', booleanValue: 'Value', elementReference: 'Value', visibleLines: 'Visible lines'
};
const cap = t => t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
const words = tag => ELEMENT_WORDS[tag] || String(tag).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const leafWord = tag => LEAF_WORDS[tag] || cap(String(tag).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
const decode = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
const flat = s => decode(s).replace(/\s+/g, ' ').trim();

/** One value, short: its first MAX characters. */
function clip(s, max) {
  const t = flat(s), n = max || 48;
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '\u2026' : t;
}
/** Two values, short - each shown from a little before where they start to differ, so the difference is what is seen. */
function clipPair(a, b, max) {
  const x = flat(a), y = flat(b), n = max || 48;
  if (x.length <= n && y.length <= n) return [x, y];
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let from = Math.max(0, p - 12); while (from > 0 && x[from - 1] !== ' ') from--;
  const cut = s => { const t = s.slice(from); return (from ? '\u2026' : '') + (t.length > n ? t.slice(0, n - 1).trimEnd() + '\u2026' : t); };
  return [cut(x), cut(y)];
}

/** The leaf values a version sets - the first of each tag - decoded. */
function leaves(text) {
  const v = {};
  for (const [, k, x] of String(text).matchAll(/<(\w+)>([^<]*|<!\[CDATA\[[\s\S]*?\]\]>)<\/\1>/g)) if (!(k in v)) v[k] = decode(x).trim();
  return v;
}

/** An identity, as it reads: "name=Check|label=X" -> "Check / X". */
const shown = id => String(id).replace(/^\w+\//, '').split('|').map(p => p.slice(p.indexOf('=') + 1)).filter(Boolean).join(' / ');
function idOf(type, path, el) {
  if (XC.isLeaf(el)) return null;
  // its own identity only - a layout column holding one field is not that field
  const id = XC.identity(type, path, el, false);
  return id && id[0] !== '=' ? id : null;
}
/**
 * An element in words: "field Dispute_Amount__c", "decision Check_Stage"; null when nothing names it. A permission
 * set's or profile's entry is its name alone - "Account.Revenue__c" - as Setup lists them, and as 5.0 said them.
 */
function named(type, path, el) {
  const id = idOf(type, path, el);
  if (!id) return null;
  return ACCESS.has(type) && path.length === 1 ? shown(id) : words(el.name) + ' ' + shown(id);
}

/** The elements a range [s, e) of a side sits in, root first, each with its path. */
function chainAt(root, s, e) {
  const out = [];
  let el = root, path = [];
  while (el) {
    out.push({ el, path });
    const inner = XC.kids(el).find(c => c.start <= s && c.end >= e && (c.start < s || c.end > e));
    if (!inner) break;
    path = path.concat(el.name);
    el = inner;
  }
  return out;
}
/** Where a range is, in words: the two innermost named elements it is in - "section Information › field Phone". */
function placeOf(type, chain) {
  const names = [];
  for (let i = chain.length - 1; i >= 1 && names.length < 2; i--) { const n = named(type, chain[i].path, chain[i].el); if (n) names.unshift(n); }
  return names.join(' \u203a ');
}

/** A version's lines as elements: [elements] when they are whole, null when git cut through one. */
function elementsOf(text) {
  if (!String(text).trim()) return [];
  const d = X.parse('<w>' + text + '</w>');
  if (!d.root || (d.errors && d.errors.length)) return null;
  return XC.kids(d.root);
}

function sidesOf(conflictText) {
  const lines = split(conflictText), T = [], F = [], at = [];
  let i = 0, tLen = 0, fLen = 0;
  const push = (arr, ls, side) => { for (const l of ls) { arr.push(l); if (side === 't') tLen += l.length; else fLen += l.length; } };
  for (const b of blocks(conflictText)) {
    const mid = lines.slice(i, b.b0);
    push(T, mid, 't'); push(F, mid, 'f');
    const t0 = tLen, f0 = fLen, tl0 = T.length, fl0 = F.length;
    push(T, b.ours, 't'); push(F, b.theirs, 'f');
    at.push({ t: [t0, tLen], f: [f0, fLen], tl: [tl0, T.length], fl: [fl0, F.length] });
    i = b.b1;
  }
  push(T, lines.slice(i), 't'); push(F, lines.slice(i), 'f');
  return { T, F, t: T.join(''), f: F.join(''), at };
}

/**
 * B3.6 - the two stories each added an entry here, and git lined up their wrapper tags: the block holds the two
 * entries' insides. Both kept: the target's, its wrapper closed and opened again, the feature's. The lines either
 * side of the block are git's - the same on both sides - so the wrapper is the same lines on both.
 */
function bothAdded(type, S, k, ct, cf, c) {
  const et = ct[ct.length - 1], ef = cf[cf.length - 1];
  if (ct.length < 2 || cf.length < 2 || et.el.name !== ef.el.name) return null;
  const it = idOf(type, et.path, et.el), iF = idOf(type, ef.path, ef.el);
  if (!it || !iF || it === iF) return null;
  // each is new: the target's entry is not on the feature's side, nor the feature's on the target's
  const parentT = ct[ct.length - 2].el, parentF = cf[cf.length - 2].el;
  if (XC.kids(parentF).some(x => x.name === et.el.name && idOf(type, ef.path, x) === it)) return null;
  if (XC.kids(parentT).some(x => x.name === ef.el.name && idOf(type, et.path, x) === iF)) return null;
  const a = S.at[k];
  const lineIn = (src, off) => { let n = 0; for (let i = src.indexOf('\n'); i >= 0 && i < off; i = src.indexOf('\n', i + 1)) n++; return n; };
  const pT = a.tl[0] - lineIn(S.t, et.el.start), pF = a.fl[0] - lineIn(S.f, ef.el.start);
  const qT = lineIn(S.t, et.el.end - 1) + 1 - a.tl[1], qF = lineIn(S.f, ef.el.end - 1) + 1 - a.fl[1];
  if (pT !== pF || qT !== qF || pT < 1 || qT < 1 || pT > 4 || qT > 4) return null;
  const prefix = S.F.slice(a.fl[0] - pF, a.fl[0]).join(''), suffix = S.T.slice(a.tl[1], a.tl[1] + qT).join('');
  const both = c.target + suffix + prefix + c.feature;
  const two = elementsOf(prefix + both + suffix);
  if (!two || two.length !== 2 || two.some(x => x.name !== et.el.name)) return null;
  return { both, target: words(et.el.name) + ' ' + shown(it), feature: words(ef.el.name) + ' ' + shown(iF) };
}

/** What changes between the two versions' leaves, in words - and each version's values, short. */
function leafChanges(target, feature, quiet, ownTag) {
  const a = leaves(target), b = leaves(feature);
  const changed = Object.keys(Object.assign({}, a, b)).filter(k => (k in a) && (k in b) && a[k] !== b[k]);
  if (!changed.length) return null;
  const parts = [], ts = [], fs = [];
  for (const k of changed.slice(0, 3)) {
    const [x, y] = clipPair(a[k], b[k], changed.length > 1 ? 32 : 48);
    // a value's own tag says nothing once its element is named
    // nor does one named as its element is - a formula's formula
    const w = (quiet && changed.length === 1 && VALUE_LEAVES.has(k)) || (ownTag && changed.length === 1 && leafWord(k).toLowerCase() === words(ownTag)) ? '' : leafWord(k) + ' ';
    parts.push(w + (x || '(blank)') + ' \u2192 ' + (y || '(blank)'));
    ts.push(w + (x || '(blank)')); fs.push(w + (y || '(blank)'));
  }
  const more = changed.length > 3 ? ' \u2026' : '';
  return { text: parts.join(', ') + more, target: ts.join(', ') + more, feature: fs.join(', ') + more };
}

/** The first line that says something, short - and how many more there are. */
function firstLine(text) {
  const ls = split(text).map(l => flat(l.replace(/<[^>]+>/g, ' '))).filter(Boolean);
  return ls.length ? clip(ls[0], 40) + (ls.length > 1 ? ' (+' + (ls.length - 1) + ' line' + (ls.length === 2 ? '' : 's') + ')' : '') : '';
}

function explain(type, S, k, c, ok) {
  const a = S.at[k];
  const ct = ok.t ? chainAt(ok.t, a.t[0], a.t[1]) : null, cf = ok.f ? chainAt(ok.f, a.f[0], a.f[1]) : null;
  const chain = ct || cf;
  const deepest = chain && chain[chain.length - 1];
  const inLeaf = !!(deepest && chain.length > 1 && XC.isLeaf(deepest.el));
  const holder = chain ? (inLeaf ? chain.slice(0, -1) : chain) : null;
  const place = holder ? placeOf(type, holder) : '';
  const at = place ? cap(place) + ': ' : '';
  const T = elementsOf(c.target), F = elementsOf(c.feature);
  const tEmpty = !String(c.target).trim(), fEmpty = !String(c.feature).trim();
  const cpath = holder ? holder[holder.length - 1].path.concat(holder[holder.length - 1].el.name) : [type];
  const whatIn = els => {
    if (!els || !els.length) return null;
    const ns = els.slice(0, 2).map(el => named(type, cpath, el) || (XC.isLeaf(el) ? leafWord(el.name).toLowerCase() : words(el.name)));
    const more = els.length > 2 ? ' and ' + (els.length - 2) + ' more' : '';
    // two of a kind said once: "fields NWL_Person_Source__c, NWL_Person_Status__c"
    const kind = /^([a-z]+) (.+)$/.exec(ns[0]);
    if (ns.length > 1 && kind && els.every(el => el.name === els[0].name) && ns.every(n => n.startsWith(kind[1] + ' '))) return kind[1] + 's ' + ns.map(n => n.slice(kind[1].length + 1)).join(', ') + more;
    return ns.join(', ') + more;
  };
  if (tEmpty || fEmpty) {
    const what = whatIn(tEmpty ? F : T) || 'these lines';
    return tEmpty ? { about: at + 'only the feature has ' + what + ' \u2013 Accept feature adds it', sides: { target: 'not here', feature: 'adds ' + what } }
      : { about: at + 'the feature removes ' + what + ' \u2013 Accept target keeps it', sides: { target: 'keeps ' + what, feature: 'removes it' } };
  }
  // B3.6: two new entries at the same place - whole in the block, or their insides with git's wrapper around them
  if (T && F && T.length && F.length && !T.some(XC.isLeaf) && !F.some(XC.isLeaf)) {
    const it = T.map(el => idOf(type, cpath, el)), iF = F.map(el => idOf(type, cpath, el));
    if (it.every(Boolean) && iF.every(Boolean) && !it.some(x => iF.includes(x))) {
      const tw = whatIn(T), fw = whatIn(F);
      return { about: at + (at ? 'b' : 'B') + 'oth stories add here \u2013 the target adds ' + tw + ', the feature adds ' + fw + '. Accept both keeps the two', sides: { target: 'adds ' + tw, feature: 'adds ' + fw }, both: c.target + c.feature };
    }
  }
  if (ct && cf && !inLeaf) {
    const two = bothAdded(type, S, k, ct, cf, c);
    if (two) {
      const outer = placeOf(type, ct.slice(0, -1));
      return { about: (outer ? cap(outer) + ': b' : 'B') + 'oth stories add here \u2013 the target adds ' + two.target + ', the feature adds ' + two.feature + '. Accept both keeps the two',
        sides: { target: 'adds ' + two.target, feature: 'adds ' + two.feature }, both: two.both };
    }
  }
  // the access types: what the feature grants against the target, in Setup's words
  const access = ACCESS.has(type) ? require('./unionMerge').explainChange(c.target, c.feature, type) : null;
  const verdict = access && / \u2013 the feature (removes|grants)[^\u2013]*$/.exec(access);
  const ownEl = T && T.length === 1 && !XC.isLeaf(T[0]) ? T[0] : null;
  const l = !inLeaf && leafChanges(c.target, c.feature, !!place, ownEl ? ownEl.name : holder && holder.length > 1 ? holder[holder.length - 1].el.name : null);
  if (l) {
    // an entry named inside the block itself - the place outside it otherwise
    const own = ownEl ? named(type, cpath, ownEl) : null;
    const accessWho = access && !own && !place ? /^([^:]+): /.exec(access) : null;
    const lead = own ? cap(own) + (place ? ' (' + place + ')' : '') + ': ' : accessWho ? decode(accessWho[1]) + ': ' : at;
    return { about: lead + l.text + (verdict ? verdict[0] : ''), sides: { target: l.target, feature: l.feature } };
  }
  // lines inside one value - a formula, a description: the value named, each version's first line
  const t1 = firstLine(c.target), f1 = firstLine(c.feature);
  const value = inLeaf ? leafWord(deepest.el.name) : null;
  const lead = place ? cap(place) + ' \u203a ' + (value ? value.toLowerCase() : 'these lines') : value || 'These lines';
  return { about: lead + ': both stories changed it \u2013 ' + t1 + ' \u2192 ' + f1, sides: { target: t1, feature: f1 } };
}

/** Each conflict of a metadata file in words - see above. The conflicts are given the words in place, and returned. */
function annotate(conflictText, conflicts) {
  if (!conflicts || !conflicts.length) return conflicts;
  let S, ok;
  try {
    S = sidesOf(conflictText);
    if (S.at.length !== conflicts.length) return conflicts;
    const dt = X.parse(S.t), df = X.parse(S.f);
    ok = { t: dt.root && !(dt.errors && dt.errors.length) ? dt.root : null, f: df.root && !(df.errors && df.errors.length) ? df.root : null };
  } catch (e) { return conflicts; }
  const type = (ok.t || ok.f || {}).name || null;
  conflicts.forEach((c, k) => {
    try {
      const w = explain(type, S, k, c, ok);
      if (!w) return;
      c.about = w.about;
      if (w.sides) c.sides = w.sides;
      if (w.both) c.both = w.both;
    } catch (e) { /* the conflict keeps the words its own lines give */ }
  });
  return conflicts;
}

module.exports = { annotate };

