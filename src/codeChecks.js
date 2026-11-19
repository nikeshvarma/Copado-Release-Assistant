'use strict';

/**
 * Code in the merge editor: Copado's conflict blocks, and the problems to show as you type.
 *
 *   blocks(text)            each <<<<<<< ... ======= ... >>>>>>> block: its lines, and both sides of it
 *   problems(text, lang)    conflict markers left, brackets that do not balance, a member defined twice -
 *                           [{ line, column, message, severity }], 1-based, severity 'error' or 'warning'
 */
const { units } = require('./mergeAlign');

/** [{ b0, b1, ours: [...], base: [...] | null, theirs: [...] }] - b0..b1 the block's lines, 0-based, end excluded. */
function blocks(text) {
  const lines = String(text).split(/(?<=\n)/), out = [];
  let cur = null;
  lines.forEach((l, i) => {
    const t = l.replace(/\r?\n$/, '');
    if (/^<{7}(\s|$)/.test(t)) cur = { b0: i, ours: [], base: null, theirs: [], part: 'ours' };
    else if (cur && /^\|{7}(\s|$)/.test(t)) { cur.base = []; cur.part = 'base'; }
    else if (cur && /^={7}$/.test(t)) cur.part = 'theirs';
    else if (cur && /^>{7}(\s|$)/.test(t)) { cur.b1 = i + 1; delete cur.part; out.push(cur); cur = null; }
    else if (cur) cur[cur.part].push(l);
  });
  return out;
}

/** The brackets of code, strings and comments skipped: the first that does not close, or the first left open. */
function brackets(text, js) {
  const t = String(text), open = [], pair = { ')': '(', ']': '[', '}': '{' };
  let line = 1, col = 1;
  const at = () => ({ line, column: col });
  for (let i = 0; i < t.length; i++) {
    const c = t[i], d = t[i + 1];
    const step = k => { for (let n = 0; n < k; n++) { if (t[i + n] === '\n') { line++; col = 1; } else col++; } };
    if (c === '/' && d === '/') { let k = 0; while (i + k < t.length && t[i + k] !== '\n') k++; step(k); i += k - 1; continue; }
    if (c === '/' && d === '*') { const e = t.indexOf('*/', i + 2); const k = (e < 0 ? t.length : e + 2) - i; step(k); i += k - 1; continue; }
    if (c === '\'' || c === '"' || (js && c === '`')) { let k = 1; while (i + k < t.length && t[i + k] !== c) { if (t[i + k] === '\\') k++; k++; } k++; step(k); i += k - 1; continue; }
    if ('([{'.includes(c)) open.push(Object.assign({ c }, at()));
    else if (')]}'.includes(c)) {
      const top = open.pop();
      if (!top) return Object.assign(at(), { message: 'A closing ' + c + ' with nothing open' });
      if (top.c !== pair[c]) return Object.assign(at(), { message: 'A closing ' + c + ' where ' + top.c + ' (line ' + top.line + ') is open' });
    }
    step(1);
  }
  const left = open.pop();
  return left ? { line: left.line, column: left.column, message: 'This ' + left.c + ' is never closed' } : null;
}

function problems(text, language) {
  const out = [];
  for (const b of blocks(text)) out.push({ line: b.b0 + 1, column: 1, severity: 'error', message: 'Conflict markers left: choose the target\u2019s, the feature\u2019s, or both' });
  const codeLike = language === 'apex' || language === 'javascript' || language === 'css';
  // with markers left, the brackets cannot balance: say only what is to be done first
  if (codeLike && !out.length) { const b = brackets(text, language === 'javascript'); if (b) out.push(Object.assign({ severity: 'error' }, b)); }
  if ((language === 'apex' || language === 'javascript') && !out.length) {
    const u = units(text, language);
    const seen = new Map();
    for (const m of (u ? u.members : []).filter(x => !x.comment)) {
      if (seen.has(m.id)) out.push({ line: m.l0 + 1, column: 1, severity: 'warning', message: 'Defined twice: ' + m.label + ' \u2013 also at line ' + (seen.get(m.id).l0 + 1) });
      else seen.set(m.id, m);
    }
  }
  return out;
}

module.exports = { blocks, problems, brackets };
