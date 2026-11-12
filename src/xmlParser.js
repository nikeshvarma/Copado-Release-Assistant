'use strict';

/**
 * Minimal, dependency-free XML parser that keeps source offsets so findings can
 * be mapped back to editor ranges. Not a validating parser - it is tolerant of
 * the malformed input you get mid merge conflict.
 */

const ELEMENT = 'element';
const TEXT = 'text';
const COMMENT = 'comment';
const CDATA = 'cdata';
const PI = 'pi';
const DOCTYPE = 'doctype';

function parse(src) {
  const errors = [];
  const doc = {
    type: ELEMENT,
    name: '#document',
    attrText: '',
    children: [],
    start: 0,
    end: src.length,
    openTagEnd: 0,
    selfClosing: false
  };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      addText(top(), src, i, src.length);
      break;
    }
    if (lt > i) addText(top(), src, i, lt);

    if (src.startsWith('<!--', lt)) {
      let e = src.indexOf('-->', lt + 4);
      if (e === -1) {
        errors.push({ offset: lt, length: 4, message: 'Unterminated comment' });
        e = src.length - 3;
      }
      top().children.push({ type: COMMENT, start: lt, end: e + 3, value: src.slice(lt + 4, e) });
      i = e + 3;
      continue;
    }

    if (src.startsWith('<![CDATA[', lt)) {
      let e = src.indexOf(']]>', lt + 9);
      if (e === -1) {
        errors.push({ offset: lt, length: 9, message: 'Unterminated CDATA section' });
        e = src.length - 3;
      }
      top().children.push({ type: CDATA, start: lt, end: e + 3, value: src.slice(lt + 9, e) });
      i = e + 3;
      continue;
    }

    if (src.startsWith('<?', lt)) {
      let e = src.indexOf('?>', lt + 2);
      if (e === -1) e = src.length - 2;
      top().children.push({ type: PI, start: lt, end: e + 2, value: src.slice(lt + 2, e) });
      i = e + 2;
      continue;
    }

    if (src.startsWith('<!', lt)) {
      let e = src.indexOf('>', lt);
      if (e === -1) e = src.length - 1;
      top().children.push({ type: DOCTYPE, start: lt, end: e + 1, value: src.slice(lt + 2, e) });
      i = e + 1;
      continue;
    }

    if (src[lt + 1] === '/') {
      let e = src.indexOf('>', lt);
      if (e === -1) e = src.length - 1;
      const name = src.slice(lt + 2, e).trim();
      let match = -1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { match = k; break; }
      }
      if (match === -1) {
        errors.push({ offset: lt, length: e + 1 - lt, message: 'Unexpected closing tag </' + name + '>' });
      } else {
        for (let k = stack.length - 1; k > match; k--) {
          const orphan = stack[k];
          errors.push({ offset: orphan.start, length: orphan.openTagEnd - orphan.start, message: 'Element <' + orphan.name + '> is never closed' });
          closeElement(orphan, src, lt, lt);
          stack.pop();
        }
        const el = stack.pop();
        closeElement(el, src, lt, e + 1);
      }
      i = e + 1;
      continue;
    }

    // Opening tag
    let j = lt + 1;
    while (j < src.length && !isNameEnd(src.charCodeAt(j))) j++;
    const name = src.slice(lt + 1, j);
    if (!name) { addText(top(), src, lt, lt + 1); i = lt + 1; continue; }

    let k = j;
    let quote = null;
    while (k < src.length) {
      const c = src[k];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      k++;
    }
    if (k >= src.length) {
      errors.push({ offset: lt, length: src.length - lt, message: 'Unterminated tag <' + name + '>' });
      k = src.length - 1;
    }
    let attrText = src.slice(j, k);
    const selfClosing = /\/\s*$/.test(attrText);
    if (selfClosing) attrText = attrText.replace(/\/\s*$/, '');

    const el = {
      type: ELEMENT,
      name,
      attrText,
      attrs: parseAttrs(attrText),
      children: [],
      parent: top(),
      start: lt,
      nameStart: lt + 1,
      nameEnd: j,
      openTagEnd: k + 1,
      selfClosing,
      end: selfClosing ? k + 1 : -1
    };
    top().children.push(el);
    if (selfClosing) {
      el.closeStart = k + 1;
      el.inner = '';
      el._els = [];
    } else {
      stack.push(el);
    }
    i = k + 1;
  }

  for (let k = stack.length - 1; k > 0; k--) {
    const orphan = stack[k];
    errors.push({ offset: orphan.start, length: orphan.openTagEnd - orphan.start, message: 'Element <' + orphan.name + '> is never closed' });
    closeElement(orphan, src, src.length, src.length);
  }

  const root = doc.children.find(n => n.type === ELEMENT) || null;
  return { doc, root, errors, src };
}

function closeElement(el, src, closeStart, end) {
  el.closeStart = closeStart;
  el.end = end;
  el._els = el.children.filter(c => c.type === ELEMENT);
  if (!el._els.length) el.inner = src.slice(el.openTagEnd, closeStart);
}

/**
 * Whitespace between tags is not kept as a node: a 50,000-line file has as
 * many of those gaps as it has lines, and nothing reads them. Leaf values
 * are still exact - they come from the element's inner source.
 */
function addText(parent, src, start, end) {
  let i = start;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break;
    i++;
  }
  if (i === end) return;
  parent.children.push({ type: TEXT, start, end, value: src.slice(start, end) });
}

function isNameEnd(c) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 47 /* / */ || c === 62 /* > */;
}

function parseAttrs(attrText) {
  const attrs = [];
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText))) {
    attrs.push({ name: m[1], value: m[3] !== undefined ? m[3] : m[4] });
  }
  return attrs;
}

// Parsed elements carry their element children (_els). Elements built by the
// merge do not, because they are assembled piece by piece.
function elements(el) {
  return el._els || el.children.filter(c => c.type === ELEMENT);
}

function hasElementChildren(el) {
  return el._els ? el._els.length > 0 : el.children.some(c => c.type === ELEMENT);
}

function decode(s) {
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function textOf(el) {
  if (el._t !== undefined) return el._t;
  const kids = el.children;
  let out;
  if (kids.length === 1 && kids[0].type === TEXT) out = decode(kids[0].value).trim();
  else {
    out = '';
    for (const c of kids) {
      if (c.type === TEXT) out += decode(c.value);
      else if (c.type === CDATA) out += c.value;
    }
    out = out.trim();
  }
  if (el._els) el._t = out;          // parsed nodes never change, so cache
  return out;
}

function childByName(el, name) {
  const kids = elements(el);
  for (let i = 0; i < kids.length; i++) if (kids[i].name === name) return kids[i];
  return undefined;
}

function childText(el, name) {
  const c = childByName(el, name);
  return c ? textOf(c) : undefined;
}

/** Whitespace/comment-insensitive string used for "are these the same?" checks. */
function canonical(el) {
  if (el.type !== ELEMENT) return '';
  if (el._c !== undefined) return el._c;
  const out = buildCanonical(el);
  if (el._els) el._c = out;
  return out;
}

function buildCanonical(el) {
  const attrs = el.attrs && el.attrs.length
    ? el.attrs.map(a => a.name + '=' + a.value).sort().join(' ')
    : '';
  const kids = elements(el);
  if (!kids.length) return '<' + el.name + (attrs ? ' ' + attrs : '') + '>' + textOf(el) + '</' + el.name + '>';
  return '<' + el.name + (attrs ? ' ' + attrs : '') + '>' + kids.map(canonical).join('') + '</' + el.name + '>';
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

module.exports = {
  ELEMENT, TEXT, COMMENT, CDATA,
  parse, elements, hasElementChildren, textOf, childByName, childText,
  canonical, lineStarts, lineAt
};
