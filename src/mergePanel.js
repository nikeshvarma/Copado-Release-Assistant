'use strict';

/**
 * The merge editor: a panel of the extension's own, in place of VS Code's
 * diff view. The target on the left, read-only and written in your order;
 * your resolution on the right, in a real editor (Monaco, the editor VS Code
 * is built on, shipped inside the extension); the two lined up piece by
 * piece (src/mergeAlign.js). What you type comes back here to be compared
 * again; saving goes through the caller's own save, so the checks before
 * applying are the same as ever.
 *
 *   open(vscode, extensionUri, {
 *     file, labels: { target, merged }, theirs, short, typeName,
 *     target, incoming, text,             // the target and the feature (formatted), your resolution
 *     savedText,                          // what is saved as your resolution, if anything
 *     applyOnly,                          // a plain merge: applied into the target once, not saved as you go
 *     start                                // where your resolution started
 *     hideIdentical, onPref(prefs)        // identical lines folded away; the choice, remembered
 *     conflictsFor(text),                 // what both branches changed, found in this text
 *     onText(text), save(text, close) -> { ok, message, warn }, discard(), onClose()
 *   }) -> { panel, reveal(line), apply(undo), dispose() }
 */
const { align, lineDiff } = require('./mergeAlign');
const MD = require('./mergeDuplicates');

const nonceOf = () => { let s = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };
const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The page. Scripts only from the extension's own folder, and the two of its own by nonce. */
function html(webview, media) {
  const nonce = nonceOf();
  const u = p => webview.asWebviewUri(media(p)).toString();
  const csp = webview.cspSource;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' + csp + ' data:; font-src ' + csp + ' data:; style-src ' + csp + ' \'unsafe-inline\'; script-src ' + csp + ' \'nonce-' + nonce + '\';">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="' + attr(u('merge.css')) + '"></head>' +
    '<body data-vs="' + attr(u('monaco/vs')) + '">' +
    '<div class="top"><span class="title" id="title"></span><span class="chips" id="chips"></span><span class="sp"></span>' +
    '<span class="navg"><button id="prev" title="Previous change (Shift+F7)" aria-label="Previous change"></button><span id="pos" aria-live="polite"></span><button id="next" title="Next change (F7)" aria-label="Next change"></button></span>' +
    '<span class="mwrap"><button id="viewBtn" class="tb" aria-haspopup="menu" aria-expanded="false" title="Start from, hide identical lines, the target\u2019s order"></button><div id="viewMenu" class="dmenu right" role="menu" hidden></div></span>' +
    '<button id="saveClose" class="pri" title="Save as your resolution and close \u2013 Ctrl+S saves and keeps it open">Save &amp; Close</button>' +
    '<span class="mwrap"><button id="moreBtn" class="tb ic" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More"></button><div id="moreMenu" class="dmenu right" role="menu" hidden></div></span></div>' +
    '<div id="help" hidden role="dialog" aria-label="Keyboard shortcuts"></div>' +
    '<div id="menu" hidden role="menu"></div>' +
    '<div class="heads"><div id="lefthead"></div><div></div><div id="righthead"></div><div class="g2"></div><div id="feathead"></div></div>' +
    '<div class="panes"><div id="left"></div><div id="gap"></div><div id="right"></div><div id="gap2"></div><div id="feat"></div></div>' +
    '<div class="status" role="status"><span id="stSaved"></span><span id="stMarks"></span><span id="stDups"></span><span id="note"></span><span class="sp"></span><span class="hints">F7 next change \u00b7 F8 next problem \u00b7 Ctrl+S save</span></div>' +
    '<script nonce="' + nonce + '" src="' + attr(u('monaco/vs/loader.js')) + '"></script>' +
    '<script nonce="' + nonce + '" src="' + attr(u('merge.js')) + '"></script></body></html>';
}

/** The pieces, without what the page does not need: the left pane's lines come once, as its text. */
/** Ordering and de-duplicating are for files whose entries add up - permission sets, profiles, labels, translations - never a layout's or a page's, whose order is what users see. */
function tidy(o) { return !o.language && require('./mergeStart').ADDITIVE.has(o.typeName); }

/**
 * Three panels, Copado's own: where the promotion branch's side, your resolution and the feature branch's side differ.
 * Each side is lined up with the resolution; where all three have the same line they run level, and between two such
 * lines is one place they differ: [{ l0, l1, r0, r1, f0, f1 }] - the promotion's lines, yours, the feature's.
 */
function threeWay(left, text, feature) {
  const sp = t => String(t == null ? '' : t).split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1);
  const R = sp(text);
  const mapOf = side => {
    const A = sp(side), m = new Array(R.length + 1).fill(-1);
    let a = 0;
    for (const p of lineDiff(A, R, 0)) { if (p.kind === 'same') for (let k = 0; k < p.b1 - p.b0; k++) m[p.b0 + k] = a + k; a += (p.left || []).length; }
    m[R.length] = A.length;
    return m;
  };
  const mL = mapOf(left), mF = mapOf(feature), out = [];
  let l = 0, f = 0, r = 0;
  while (r < R.length || l < mL[R.length] || f < mF[R.length]) {
    if (r < R.length && mL[r] === l && mF[r] === f) { r++; l++; f++; continue; }
    let e = r; while (e < R.length && !(mL[e] >= l && mF[e] >= f)) e++;
    if (mL[e] > l || e > r || mF[e] > f) out.push({ l0: l, l1: mL[e], r0: r, r1: e, f0: f, f1: mF[e] });
    l = mL[e]; f = mF[e]; r = e;
    if (e === R.length) break;
  }
  return out;
}

/** Metadata that does not parse, once its conflicts are resolved: where it breaks. */
function xmlProblems(text) {
  const d = require('./xmlParser').parse(String(text));
  return (d.errors || []).slice(0, 20).map(e => { const before = String(text).slice(0, e.offset).split('\n'); return { line: before.length, column: before[before.length - 1].length + 1, severity: 'error', message: e.message }; });
}

function marksFor(o, text, mode) {
  // Manual and Compare: two versions compared line by line, nothing merged - both sides yours to edit, format, sort
  if (o.plain) {
    const r = align(o.target, null, text, { type: null, mode: 'literal' });
    const pieces = r.pieces.map(p => ({ kind: p.kind, a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, label: p.label, ghost: p.ghost || p.left }));
    return { plain: true, code: !!o.language, single: false, left: r.left, mode: 'literal', moves: [], rows: [], pieces,
      counts: { differs: pieces.filter(p => p.kind !== 'same' && p.kind !== 'blank').length }, dups: !o.language && tidy(o) ? MD.inText(text) : [],
      problems: o.language ? require('./codeChecks').problems(text, o.language) : [] };
  }
  // a promotion's code - and its metadata: Copado's conflict file, only its conflicts marked, none decided for you
  if (o.language || o.git) {
    const c = o.code || { conflicts: [] };
    const k = require('./codeMerge').marks({ text, conflicts: c.conflicts, language: o.language, reviewed: c.reviewed });
    // two panes, if chosen: the target beside your resolution line by line - the conflicts still choices, over it
    // three panels - Copado's: both branches' sides beside your resolution
    if (o.codeView === 'threePanes') {
      return { code: true, git: true, three: true, single: false, left: o.target, feat: o.incoming, segs: threeWay(o.target, text, o.incoming), counts: k.counts, rows: k.rows, moves: [], dups: [], pieces: [],
        problems: k.counts.needs ? [] : o.language ? require('./codeChecks').problems(text, o.language) : xmlProblems(text) };
    }
    if (o.codeView === 'twoPanes') {
      const r = align(o.target, o.incoming, text, { type: null, mode: 'literal' });
      // the counts are the merge's - its members - whichever layout shows them
      return { code: true, git: true, single: false, left: r.left, mode: 'literal', counts: k.counts, rows: k.rows, moves: [], dups: [],
        pieces: r.pieces.map(p => ({ kind: p.kind, a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, label: p.label, undo: p.kind === 'same' ? undefined : p.undo, ghost: p.ghost, notInFeature: p.notInFeature })),
        problems: k.counts.needs ? [] : o.language ? require('./codeChecks').problems(text, o.language) : xmlProblems(text) };
    }
    return { code: true, git: true, single: true, left: '', mode: 'code', counts: k.counts, rows: k.rows, moves: [], dups: [], pieces: [], problems: k.counts.needs ? [] : require('./codeChecks').problems(text, o.language) };
  }
  const r = align(o.target, o.incoming, text, { type: o.typeName, mode, ancestor: o.ancestor || null });
  if (r.hold) return Object.assign(r, { xmlError: xmlError(text) });
  const removed = o.removedDups || new Set();
  return {
    left: r.left, mode: r.mode, counts: r.counts, moves: r.moves,
    // duplicates in your resolution as it is - one you add is marked as you type
    dups: MD.inText(text),
    pieces: r.pieces.map(p => ({ kind: p.kind, a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, label: p.label, context: p.context, undo: p.kind === 'same' ? undefined : p.undo, ghost: p.ghost, notInFeature: p.notInFeature, byFeature: p.byFeature, now: p.now, was: p.was,
      dupRemoved: p.kind === 'removed' && removed.size && p.ghost ? removed.has(MD.flat(p.ghost.join(''))) || undefined : undefined }))
  };
}

/** Where your resolution stops being XML: { line, column, message }, 1-based - for the editor to underline. */
function xmlError(text) {
  const X = require('./xmlParser');
  const d = X.parse(String(text));
  const e = (d.errors || [])[0];
  if (!e) return d.root ? null : { line: 1, column: 1, message: String(text).trim() ? 'No root element' : 'The file is empty' };
  const starts = X.lineStarts(String(text));
  const off = e.offset != null ? e.offset : e.start != null ? e.start : 0;
  const line = X.lineAt(starts, off);
  return { line: line + 1, column: off - starts[line] + 1, message: String(e.message || e) };
}

function open(vscode, extensionUri, o) {
  const media = p => vscode.Uri.joinPath(extensionUri, 'media', ...p.split('/'));
  // a comparison is called one - it merges nothing
  const title = (o.plain ? 'Compare' : 'Merge') + ' \u00b7 ' + o.file;
  const panel = vscode.window.createWebviewPanel('cmrMergeEditor', title, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
  });
  panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'merge.svg');
  let mode = 'order', text = o.text, disposed = false;
  const post = m => { if (!disposed) panel.webview.postMessage(m); };
  panel.webview.html = html(panel.webview, media);
  panel.webview.onDidReceiveMessage(async m => {
    try {
      if (m.type === 'ready') {
        post({ type: 'init', title, file: o.file, applyOnly: !!o.applyOnly, labels: o.labels, theirs: o.theirs, short: o.short, mode, text, savedText: o.savedText != null ? o.savedText : null,
          start: o.start || null, hideIdentical: !!o.hideIdentical, dupRemoved: o.dupRemoved || null, manual: !!o.manual, plain: !!o.plain, tidy: tidy(o), gitLabels: o.gitLabels || null, ancestor: !!o.ancestor, language: o.language || 'xml',
          marks: marksFor(o, text, mode), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'codeView') {
        // one pane or two, for code: remembered - it is the setting
        o.codeView = ['onePane', 'twoPanes', 'threePanes'].includes(m.view) ? m.view : 'threePanes';
        if (o.setCodeView) o.setCodeView(o.codeView);
        if (typeof m.text === 'string') text = m.text;
        post({ type: 'marks', seq: m.seq, marks: marksFor(o, text, mode), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'review') {
        // a code conflict's empty version accepted: nothing in the text says so - remembered
        if (o.code) { o.code.reviewed = o.code.reviewed || new Map(); o.code.reviewed.set(String(m.id), String(m.choice || 'feature')); }
        text = typeof m.text === 'string' ? m.text : text;
        post({ type: 'marks', seq: m.seq, marks: marksFor(o, text, mode), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'text' && m.side === 'left') {
        // a comparison's other side, edited: compared again
        o.target = String(m.text);
        post({ type: 'marks', seq: m.seq, mode, marks: marksFor(o, text, mode), conflicts: [] });
      } else if (m.type === 'text') {
        text = String(m.text);
        if (o.onText) o.onText(text);
        const marks = marksFor(o, text, mode);
        post(marks.hold ? { type: 'marks', seq: m.seq, hold: true, xmlError: marks.xmlError } : { type: 'marks', seq: m.seq, mode, marks, conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'save') {
        text = String(m.text);
        if (o.onText) o.onText(text);
        const r = (await o.save(text, !!m.close)) || { ok: false, message: 'Not saved.' };
        post({ type: 'saved', ok: !!r.ok, warn: !!r.warn, message: r.message || '', text });
      } else if (m.type === 'clipboard') {
        // VS Code's clipboard: what you copy here pastes anywhere, and the other way round
        await vscode.env.clipboard.writeText(String(m.text));
      } else if (m.type === 'paste') {
        post({ type: 'pasted', id: m.id, text: await vscode.env.clipboard.readText() });
      } else if (m.type === 'dedupe') {
        const r = o.dedupe ? await o.dedupe(String(m.text)) : { error: 'Removing duplicates is not available here' };
        post(Object.assign({ type: 'formatted', seq: m.seq, side: m.side || 'right' }, r));
      } else if (m.type === 'format') {
        const r = o.format ? o.format(String(m.text)) : { error: 'Formatting is not available here' };
        post(Object.assign({ type: 'formatted', seq: m.seq, side: m.side || 'right' }, r));
      } else if (m.type === 'report') {
        // the \u22ef menu's report
        if (m.text != null) { text = String(m.text); if (o.onText) o.onText(text); }
        const r = o.report ? await o.report(text) : null;
        if (r && r.message) post({ type: 'saved', ok: !!r.ok, message: r.message, text });
      } else if (m.type === 'discard') {
        if (o.discard) await o.discard();
      } else if (m.type === 'pref') {
        // remembered for the next merge (cmr.merge.hideIdentical)
        if (o.onPref) await o.onPref({ hideIdentical: !!m.hideIdentical });
      } else if (m.type === 'dirty') {
        panel.title = (m.dirty ? '\u25cf ' : '') + title;
        if (o.onDirty) o.onDirty(!!m.dirty);
      }
    } catch (e) {
      post({ type: 'saved', ok: false, message: 'Something went wrong: ' + ((e && e.message) || e) });
    }
  });
  panel.onDidDispose(() => { disposed = true; if (o.onClose) o.onClose(); });
  return {
    panel,
    get text() { return text; },
    reveal: line => { panel.reveal(); post({ type: 'reveal', line }); },
    apply: undo => { panel.reveal(); post({ type: 'apply', undo }); },
    dispose: () => { if (!disposed) panel.dispose(); }
  };
}

module.exports = { open, html, marksFor };
