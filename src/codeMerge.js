'use strict';

/**
 * Code from a promotion: Copado's conflict file, as git merged it. Git had the common ancestor, so outside its conflict
 * blocks the merge is done - the feature's deletions applied, other stories' work kept - and taken as it is. Each block
 * is a conflict, never decided for you: neither version is in your resolution until you accept one.
 *
 *   fromConflictFile(text)        -> { text: git's merge, every block taken out; conflicts: [{ id, target, feature, before, after }] }
 *                                    metadata's conflicts also { about, sides, both? } - in words, from where each is (conflictWords)
 *   marks({ text, conflicts, language })
 *                                 -> { rows: [one per conflict: { kind: 'conflict', chosen: none|target|feature|both|edited, needs, ... }], counts }
 *   memberDiffs(a, b, language)   -> how many members differ between two versions (Compare's few words)
 */
const { units } = require('./mergeAlign');
const { blocks } = require('./codeChecks');

const split = t => String(t == null ? '' : t).split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1);
// alike as code: line endings, trailing spaces and the blank lines around do not count
const norm = t => String(t).replace(/\r/g, '').replace(/[ \t]+(?=\n|$)/g, '').replace(/^\n+|\n+$/g, '');
const same = (a, b) => norm(a) === norm(b);
const key = l => String(l).trim();

/** git's merge, each conflict block taken out - and what is either side of it, to find it again as you edit. */
function fromConflictFile(conflictText) {
  // git's blocks slid to whole elements first: a field added before another, never shown inside it (5.1.1)
  conflictText = require('./blockShift').tidy(conflictText);
  const lines = split(conflictText), out = [], conflicts = [];
  let i = 0;
  blocks(conflictText).forEach((b, k) => {
    out.push(...lines.slice(i, b.b0));
    // found again by the three lines either side of it, exactly, and by where it was
    const after = [];
    for (let j = b.b1; j < lines.length && after.length < 3; j++) { if (/^(<{7}|={7}|>{7}|\|{7})/.test(key(lines[j]))) break; after.push(key(lines[j])); }
    conflicts.push({ id: 'conflict:' + k, target: b.ours.join(''), feature: b.theirs.join(''), before: out.slice(-3).map(key), after, at: out.length });
    i = b.b1;
  });
  out.push(...lines.slice(i));
  // each branch as the file names it: <<<<<<< HEAD, >>>>>>> origin/feature/US-...
  const name = re => { const m = re.exec(String(conflictText)); return m ? m[1].trim() || null : null; };
  // metadata: each conflict said in words from the element it is in - which git's block rarely holds
  if (/^\s*(<\?xml|<[A-Za-z][\w]*[\s>])/.test(out.join('').replace(/^\uFEFF/, ''))) require('./conflictWords').annotate(conflictText, conflicts);
  return { text: out.join(''), conflicts, labels: { ours: name(/^<{7} ?([^\r\n]*)/m), theirs: name(/^>{7} ?([^\r\n]*)/m) } };
}
/** What Accept both puts in: the target's lines then the feature's - or, two entries added at one place (B3.6), the two whole. */
const bothOf = c => c.both != null ? c.both : c.target + c.feature;

/**
 * Where a conflict is now: [p, q) - its lines between the three before it and the three after it - nearest to where
 * it was (expected), or null. A neighbour you edited: its nearest line that is not blank stands in.
 */
function locate(lines, c, expected, reviewed) {
  const fits = (p, seq, back) => seq.every((t, k) => { const i = back ? p - seq.length + k : p + k; return i >= 0 && i < lines.length && key(lines[i]) === t; });
  const nearest = list => list.length ? list.reduce((a, b) => Math.abs(b - expected) < Math.abs(a - expected) ? b : a) : null;
  const starts = []; for (let p = 0; p <= lines.length; p++) if (fits(p, c.before, true)) starts.push(p);
  let p = nearest(starts);
  if (p == null) { const last = c.before.filter(Boolean).pop(); const loose = []; if (last) for (let i = 0; i < lines.length; i++) if (key(lines[i]) === last) loose.push(i + 1); p = nearest(loose); }
  if (p == null) return null;
  const isAfter = i => !c.after.length ? i >= lines.length : fits(i, c.after, false) || (c.after.filter(Boolean)[0] != null && i < lines.length && key(lines[i]) === c.after.filter(Boolean)[0] && !key(lines[i - 1] || 'x'));
  // what is there now: one of its versions, nothing yet, or what you made of it
  for (const [chosen, v] of [['feature', c.feature], ['target', c.target], ['both', bothOf(c)]]) {
    const n = split(v);
    if (n.length && n.every((l, k) => p + k < lines.length && same(l, lines[p + k])) && isAfter(p + n.length)) return { p, q: p + n.length, chosen };
  }
  if (isAfter(p)) return { p, q: p, chosen: reviewed && reviewed.get(c.id) || 'none' };
  let q = p;
  while (q < lines.length && q - p < 2000 && !isAfter(q)) q++;
  return q < lines.length || !c.after.length ? { p, q, chosen: lines.slice(p, q).every(l => !key(l)) ? 'none' : 'edited' } : { p, q: p, chosen: 'none' };
}

/** C5: a conflict's lines known exactly - the editor tracks them as you type: which version is there, or none, or yours. */
function within(lines, c, p, q, reviewed) {
  const region = lines.slice(p, q);
  for (const [chosen, v] of [['feature', c.feature], ['target', c.target], ['both', bothOf(c)]]) {
    const n = split(v);
    if (n.length && n.length === region.length && n.every((l, k) => same(l, region[k]))) return { p, q, chosen };
  }
  if (q === p) return { p, q, chosen: reviewed && reviewed.get(c.id) || 'none' };
  return { p, q, chosen: region.every(l => !key(l)) ? 'none' : 'edited' };
}

function marks(o) {
  const lines = split(o.text), rows = [];
  const u = (o.language === 'apex' || o.language === 'javascript') ? units(o.text, o.language) : null;
  const where = (p, c) => memberOf(o, u, lines, p, c);
  // where each one was, moved by what the ones above it became
  let shift = 0;
  for (const c of o.conflicts || []) {
    // C5: where the editor says it is, when it says - otherwise found by its neighbouring lines, as when a file opens
    const g = o.regions && o.regions[c.id];
    const at = g && g[0] >= 0 && g[0] <= g[1] && g[1] <= lines.length ? within(lines, c, g[0], g[1], o.reviewed) : locate(lines, c, (c.at || 0) + shift, o.reviewed);
    if (!at) continue;
    shift = at.q - (c.at || 0);
    const op = text => ({ b0: at.p, b1: at.q, expect: lines.slice(at.p, at.q).map(l => l.replace(/\r?\n$/, '')), insert: text });
    const trimmed = t => { const ls = split(t); let a = 0, z = ls.length; while (a < z && !key(ls[a])) a++; while (z > a && !key(ls[z - 1])) z--; return ls.slice(a, z); };
    rows.push({ kind: 'conflict', id: c.id, label: where(at.p, c), b0: at.p, b1: at.q, at: at.p, chosen: at.chosen, needs: at.chosen === 'none',
      // metadata: what the two versions set, in plain words - "Account.Revenue__c: Edit access true \u2192 false \u2013 the feature removes access"
      about: u || o.language ? null : c.about || require('./unionMerge').explainChange(c.target, c.feature, o.typeName),
      sides: u || o.language ? null : c.sides || null,
      // B3.6: two entries added at one place - Accept both keeps the two (a metadata conflict offers both only then)
      bothOk: c.both != null,
      // nothing chosen yet: both versions shown, neither in the file - an empty feature version says it removes the lines.
      // An empty version chosen: the other's lines struck through - removed by the feature, or left out by you
      ghosts: at.chosen === 'none' ? [{ at: at.p, lines: trimmed(c.target), cls: 'alt', title: 'Target' }, { at: at.p, lines: trimmed(c.feature), cls: 'alt', title: 'Feature', removes: !trimmed(c.feature).length && !!trimmed(c.target).length }].filter(g => g.lines.length || g.removes)
        : at.q === at.p ? [{ at: at.p, lines: trimmed(at.chosen === 'target' ? c.feature : c.target), cls: 'struck' }].filter(g => g.lines.length) : [],
      positions: c.positions,
      outcome: at.q === at.p && at.chosen === 'feature' && !trimmed(c.feature).length ? 'removed' : at.q === at.p && at.chosen === 'target' && !trimmed(c.target).length ? 'leftout' : null,
      // lit only once a version is in - the blank line or two where it was are git's, not the conflict's
      hl: at.chosen !== 'none' && at.q > at.p ? [[at.p, at.q]] : [],
      actions: [{ label: 'Accept target', choice: 'target', op: op(c.target) }, { label: 'Accept feature', choice: 'feature', op: op(c.feature) }, { label: 'Accept both', choice: 'both', op: op(bothOf(c)) }] });
  }
  const needs = rows.filter(r => r.needs).length;
  return { rows, counts: { needs, conflicts: rows.length, resolved: rows.length - needs } };
}

/**
 * C10 - what a code conflict is about, whatever was chosen: the member it is inside; or what its versions declare -
 * "methods isReady(), count()"; in markup, the tag it is in - "<lightning-input> label"; or where it is in the file.
 */
const DECL = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*((?:(?:public|private|protected|global|static|final|override|virtual|abstract|transient|with|without|inherited|sharing|testmethod|webservice|async|get|set|export|default|const|let|var|function)\s+)*)(?:([\w.<>,\[\] ]+?)\s+)?([A-Za-z_$][\w$]*)\s*(\(|=|;|\{)/;
const KEYWORDS = /^(if|for|while|switch|catch|return|else|try|do|new|throw|super|this|await|yield|case|typeof|delete|in|of|instanceof|void|insert|update|upsert|delete|merge|System)$/;
function memberOf(o, u, lines, p, c) {
  const m = u && u.members.find(x => !x.comment && x.l0 <= p - 1 && p < x.l1);
  if (m) return m.label;
  const names = [];
  if (o.language === 'apex' || o.language === 'javascript') {
    for (const l of split(c.target + c.feature)) {
      const d = DECL.exec(l);
      if (!d || KEYWORDS.test(d[3]) || (d[2] && KEYWORDS.test(d[2].trim().split(/\s+/)[0]))) continue;
      // a declaration: modifiers or a type before the name, or a method's head - "x = 1" alone is an assignment
      const declared = d[1].trim() || d[2] || (d[4] === '(' && /\)\s*\{\s*$/.test(l));
      if (!declared || names.some(n => n.name === d[3])) continue;
      names.push({ name: d[3], method: d[4] === '(' && !/^\s*(?:const|let|var)\b/.test(l) });
    }
  }
  if (names.length) return (names.every(n => n.method) ? 'method' + (names.length > 1 ? 's ' : ' ') : names.some(n => n.method) ? '' : (o.language === 'javascript' ? 'constant' : 'propert') + (names.length > 1 ? (o.language === 'javascript' ? 's ' : 'ies ') : (o.language === 'javascript' ? ' ' : 'y '))) + names.slice(0, 3).map(n => n.name + (n.method ? '()' : '')).join(', ') + (names.length > 3 ? '\u2026' : '');
  if (o.language === 'html') { const t = tagAt(lines, p, c); if (t) return t; }
  // JavaScript outside a class - a module's constants and imports: the declaration it is in
  if (o.language === 'javascript' && (!u || p < u.header[1] || p >= u.tail[0])) {
    for (let i = p - 1; i >= 0 && i >= p - 40; i--) { const d = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(lines[i]); if (d) return 'constant ' + d[1]; if (/^\S/.test(lines[i]) && !/^[}\])]/.test(lines[i])) break; }
  }
  if (u && p < u.header[1]) return o.language === 'javascript' ? 'the module\u2019s top' : 'the class header';
  if (u && p >= u.tail[0]) return 'the end of the class';
  return 'line ' + (p + 1);
}
/** Markup: the element a conflict is in - its tag, and the attributes the versions change. */
function tagAt(lines, p, c) {
  const attrs = t => { const v = {}; for (const [, k, x] of String(t).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) v[k] = x; return v; };
  const a = attrs(c.target), b = attrs(c.feature), changed = Object.keys(Object.assign({}, a, b)).filter(k => a[k] !== b[k]);
  const own = /<([a-zA-Z][\w:-]*)/.exec(c.target + c.feature);
  let tag = own && own[1];
  if (!tag) for (let i = p - 1; i >= 0 && i >= p - 30; i--) { const m = /<([a-zA-Z][\w:-]*)(?![^>]*>)/.exec(lines[i]) || /<([a-zA-Z][\w:-]*)[^>]*$/.exec(lines[i]); if (m) { tag = m[1]; break; } if (/>\s*$/.test(lines[i])) break; }
  if (!tag) return null;
  return '<' + tag + '>' + (changed.length ? ' ' + changed.slice(0, 3).join(', ') : '');
}

/** How many members differ - one only in either, or changed - between two versions; null when they cannot be read. */
function memberDiffs(a, b, language) {
  const ua = units(a, language), ub = units(b, language);
  if (!ua || !ub) return null;
  const text = (t, m) => split(t).slice(m.l0, m.l1).join('');
  const ma = new Map(ua.members.map(m => [m.id, text(a, m)])), mb = new Map(ub.members.map(m => [m.id, text(b, m)]));
  let n = 0;
  for (const [id, t] of ma) if (!mb.has(id) || !same(t, mb.get(id))) n++;
  for (const id of mb.keys()) if (!ma.has(id)) n++;
  const edge = (u, t, r) => split(t).slice(r[0], r[1]).join('');
  if (!same(edge(ua, a, ua.header), edge(ub, b, ub.header))) n++;
  return n;
}

module.exports = { fromConflictFile, marks, memberDiffs };
