/* The merge editor: the target on the left (read-only), your resolution on the right (yours to edit),
   lined up piece by piece. The extension works out the pieces (src/mergeAlign.js); this page draws them
   and sends back what you type. Runs inside a VS Code webview with Monaco loaded from the extension. */
(function () {
  'use strict';
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const S = { seq: 0, shown: 0, saved: null, marks: null, conflicts: [], zones: { left: [], right: [] }, widgets: [], deco: { left: null, right: null }, lastRight: null, held: false,
    hide: false, expanded: [], hiddenRuns: [], dups: [], typed: new Set(), xml: null, dupRemoved: null };
  S.widgets = { left: [], right: [] };
  // identical lines folded away: this many stay around every change, and a run shorter than RUN stays
  const CONTEXT = 3, RUN = 4;
  let L, R, F, monaco;

  // ---- colours and fonts from VS Code's theme ----
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const hex = c => {
    if (!c) return null;
    if (/^#[0-9a-f]{3,8}$/i.test(c)) return c.length === 4 ? '#' + [...c.slice(1)].map(x => x + x).join('') : c;
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const [r, g, b, a] = m[1].split(',').map(x => parseFloat(x));
    const h = v => Math.round(v).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b) + (a != null && a < 1 ? h(a * 255) : '');
  };
  function theme() {
    const kind = document.body.classList.contains('vscode-high-contrast') ? 'hc-black' : document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark';
    const dark = kind !== 'vs';
    const colors = {};
    const put = (key, name) => { const v = hex(cssVar(name)); if (v) colors[key] = v; };
    put('editor.background', '--vscode-editor-background');
    put('editor.foreground', '--vscode-editor-foreground');
    put('editorLineNumber.foreground', '--vscode-editorLineNumber-foreground');
    put('editorLineNumber.activeForeground', '--vscode-editorLineNumber-activeForeground');
    put('editor.selectionBackground', '--vscode-editor-selectionBackground');
    put('editor.lineHighlightBackground', '--vscode-editor-lineHighlightBackground');
    put('editorCursor.foreground', '--vscode-editorCursor-foreground');
    put('editorIndentGuide.background1', '--vscode-editorIndentGuide-background1');
    put('scrollbarSlider.background', '--vscode-scrollbarSlider-background');
    monaco.editor.defineTheme('cmr', {
      base: kind, inherit: true, colors,
      rules: dark
        ? [{ token: 'tag', foreground: '569CD6' }, { token: 'delimiter', foreground: '808080' }, { token: 'attribute.name', foreground: '9CDCFE' }, { token: 'attribute.value', foreground: 'CE9178' }, { token: 'comment', foreground: '6A9955' }, { token: 'metatag', foreground: '569CD6' }]
        : [{ token: 'tag', foreground: '800000' }, { token: 'delimiter', foreground: '800000' }, { token: 'attribute.name', foreground: 'E50000' }, { token: 'attribute.value', foreground: '0000FF' }, { token: 'comment', foreground: '008000' }, { token: 'metatag', foreground: '800000' }]
    });
    monaco.editor.setTheme('cmr');
  }
  const fontSize = () => parseFloat(cssVar('--vscode-editor-font-size')) || 13;
  const fontFamily = () => cssVar('--vscode-editor-font-family') || 'Consolas, "Courier New", monospace';

  // ---- the two editors ----
  function editors() {
    const common = {
      language: 'xml', theme: 'cmr', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, folding: false,
      fontSize: fontSize(), fontFamily: fontFamily(), lineNumbersMinChars: 4, glyphMargin: true, renderWhitespace: 'none',
      wordWrap: 'off', overviewRulerBorder: false, renderLineHighlight: 'line', fixedOverflowWidgets: true,
      // features that would need a background worker are off: the merge editor needs none of them
      links: false, colorDecorators: false, wordBasedSuggestions: 'off', quickSuggestions: false, suggestOnTriggerCharacters: false,
      occurrencesHighlight: 'off', codeLens: false, hover: { enabled: false }, parameterHints: { enabled: false }, inlayHints: { enabled: 'off' },
      lightbulb: { enabled: 'off' }, contextmenu: false, unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
      // the parent elements stay at the top as you scroll - by indentation, which is how XML nests
      stickyScroll: { enabled: true, defaultModel: 'indentationModel', maxLineCount: 4 }
    };
    const view = (api.getState && api.getState()) || {};
    S.zoom = view.zoom || 0; S.wrap = !!view.wrap;
    common.fontSize = fontSize() + S.zoom; common.wordWrap = S.wrap ? 'on' : 'off';
    L = monaco.editor.create($('left'), Object.assign({}, common, { readOnly: true, domReadOnly: true, renderValidationDecorations: 'off' }));
    // folding in your pane, by element (indentation); each fold is mirrored on the target's lines, so the panes stay level
    R = monaco.editor.create($('right'), Object.assign({}, common, { folding: true, foldingStrategy: 'indentation', showFoldingControls: 'mouseover', foldingHighlight: false }));
    // the third panel - Copado's: the feature branch's side, read-only, beside your resolution
    F = monaco.editor.create($('feat'), Object.assign({}, common, { readOnly: true, domReadOnly: true, renderValidationDecorations: 'off' }));
    if (view.split) setSplit(view.split);
    divider(); watchFolds(); tags(); quietFindWidget();
    // a comparison: what you do to the other side is compared again too
    L.onDidChangeModelContent(() => { if (!S.plain || S.settingLeft) return; clearTimeout(S.leftT); S.leftT = setTimeout(() => { S.seq++; api.postMessage({ type: 'text', side: 'left', seq: S.seq, text: L.getValue() }); }, 250); });
    // both panes scroll together - they are lined up, so the same height is the same place
    let syncing = false;
    const sync = (from, to) => from.onDidScrollChange(e => {
      if (syncing || (!e.scrollTopChanged && !e.scrollLeftChanged)) return;
      syncing = true;
      for (const t of (to === F ? [F] : [to].concat(from === F ? [] : [F]))) { if (t === from) continue; if (e.scrollTopChanged) t.setScrollTop(e.scrollTop); if (e.scrollLeftChanged) t.setScrollLeft(e.scrollLeft); }
      syncing = false;
    });
    sync(L, R); sync(R, L);
    R.onDidChangeModelContent(e => { typedSince(e.changes); dirty(); typed(); });
    clipboard(L, true); clipboard(R, false);
    R.onDidChangeCursorPosition(e => { openAt('right', e.position.lineNumber - 1); where(); });
    L.onDidChangeCursorPosition(e => openAt('left', e.position.lineNumber - 1));
    for (const ed of [L, R]) {
      // a click on a row between lines - a change's header, struck-through lines - puts you on the line after it
      ed.onMouseDown(e => {
        const t = e.target, VZ = monaco.editor.MouseTargetType;
        if (t.type !== VZ.CONTENT_VIEW_ZONE && t.type !== VZ.GUTTER_VIEW_ZONE) return;
        const line = Math.min((t.detail && t.detail.afterLineNumber || 0) + 1, ed.getModel().getLineCount());
        ed.setPosition({ lineNumber: line, column: 1 });
        // Monaco takes the focus away again as it finishes the click: given back once it has - and the
        // cursor is never moved after a key you pressed in the meantime
        const keysThen = keyCount;
        setTimeout(() => { if (keyCount === keysThen) ed.setPosition({ lineNumber: line, column: 1 }); ed.focus(); }, 0);
      });
      // the right-click menu: ours, so Cut, Copy and Paste go through VS Code's clipboard and appear once
      ed.onContextMenu(e => menu(ed, e.event.browserEvent));
    }
    R.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save(false));
    R.addCommand(monaco.KeyCode.F7, () => go(1));
    R.addCommand(monaco.KeyCode.F8, () => nextProblem(1));
    for (const ed of [L, R]) {
      ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => setWrap(!S.wrap));
      if (ed === R) ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => { if ((S.language || 'xml') === 'xml') formatNow(); });
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal, () => zoom(1));
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus, () => zoom(-1));
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0, () => zoom(0));
    }
    R.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F8, () => nextProblem(-1));
    R.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => go(-1));
    L.addCommand(monaco.KeyCode.F7, () => go(1));
    L.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => go(-1));
  }

  // ---- cut, copy and paste, through VS Code's clipboard ----
  // Each is also guarded: if VS Code passes the same keystroke on as a native cut, copy or paste, it is
  // ignored - nothing pastes twice, and a second cut cannot take the next line with it.
  let ownClip = 0, keyCount = 0;
  document.addEventListener('keydown', () => { keyCount++; }, true);
  const pending = new Map();
  let pasteSeq = 0;
  for (const ev of ['copy', 'cut', 'paste']) document.addEventListener(ev, e => { if (Date.now() - ownClip < 800) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  function selectedText(ed) {
    const model = ed.getModel(), sels = ed.getSelections() || [];
    if (sels.every(x => x.isEmpty())) {
      // nothing selected: the whole line, as in VS Code
      return { text: sels.map(x => model.getLineContent(x.positionLineNumber) + model.getEOL()).join(''), lines: true };
    }
    return { text: sels.filter(x => !x.isEmpty()).map(x => model.getValueInRange(x)).join(model.getEOL()), lines: false };
  }
  function copyFrom(ed) {
    ownClip = Date.now();
    const t = selectedText(ed);
    api.postMessage({ type: 'clipboard', text: t.text });
    return t;
  }
  function cutFrom(ed) {
    const t = copyFrom(ed);
    const model = ed.getModel();
    const edits = (ed.getSelections() || []).map(x => {
      if (!t.lines) return { range: x, text: '' };
      const n = x.positionLineNumber, last = model.getLineCount();
      return { range: n < last ? new monaco.Range(n, 1, n + 1, 1) : new monaco.Range(Math.max(1, n - 1), n > 1 ? model.getLineMaxColumn(n - 1) : 1, n, model.getLineMaxColumn(n)), text: '' };
    });
    ed.pushUndoStop(); ed.executeEdits('cut', edits); ed.pushUndoStop();
  }
  function pasteInto(ed) {
    ownClip = Date.now();
    const id = ++pasteSeq;
    pending.set(id, ed);
    api.postMessage({ type: 'paste', id });
  }
  function pasted(m) {
    const ed = pending.get(m.id);
    pending.delete(m.id);
    if (!ed || m.text == null) return;
    ed.focus();
    ed.pushUndoStop();
    ed.trigger('keyboard', 'paste', { text: String(m.text), pasteOnNewLine: false, multicursorText: null });
    ed.pushUndoStop();
  }
  // the search box's buttons say nothing on hover: no native tooltip (a title is taken off as soon as it is put on),
  // and Monaco's own hover never starts (the mouse's arrival is stopped on its way to them). Clicks and keys are untouched
  function quietFindWidget() {
    const inFind = n => n && n.nodeType === 1 && n.closest && n.closest('.find-widget');
    new MutationObserver(list => { for (const m of list) if (m.type === 'attributes' && inFind(m.target) && m.target.hasAttribute('title')) m.target.removeAttribute('title');
      else if (m.type === 'childList') for (const n of m.addedNodes) if (n.nodeType === 1) for (const e of [n].concat([...n.querySelectorAll('[title]')])) if (inFind(e)) e.removeAttribute('title'); })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    for (const ev of ['mouseover', 'mouseenter', 'pointerover', 'pointerenter']) document.addEventListener(ev, e => { if (inFind(e.target) && !/input|textarea/i.test(e.target.tagName)) e.stopImmediatePropagation(); }, true);
  }

  // the editor's own clipboard, through VS Code's - bound to the text only (editorTextFocus), so the find and replace
  // boxes keep the browser's own copy, cut and paste
  function clipboard(ed, readOnly) {
    const K = monaco.KeyMod.CtrlCmd, C = monaco.KeyCode;
    ed.addAction({ id: 'cmr.copy', label: 'Copy', keybindings: [K | C.KeyC, K | C.Insert], keybindingContext: 'editorTextFocus', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 2, run: () => { copyFrom(ed); } });
    if (readOnly) return;
    ed.addAction({ id: 'cmr.cut', label: 'Cut', keybindings: [K | C.KeyX, monaco.KeyMod.Shift | C.Delete], keybindingContext: 'editorTextFocus', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 1, run: () => { cutFrom(ed); } });
    ed.addAction({ id: 'cmr.paste', label: 'Paste', keybindings: [K | C.KeyV, monaco.KeyMod.Shift | C.Insert], keybindingContext: 'editorTextFocus', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 3, run: () => { pasteInto(ed); } });
  }

  function menu(ed, ev) {
    const m = $('menu'), ro = ed === L && !S.plain;
    ev.preventDefault();
    const items = (ro ? [] : [['Cut', 'Ctrl+X', () => cutFrom(ed)]]).concat([['Copy', 'Ctrl+C', () => copyFrom(ed)]])
      .concat(ro ? [] : [['Paste', 'Ctrl+V', () => pasteInto(ed)]])
      .concat([null, ['Select all', 'Ctrl+A', () => ed.setSelection(ed.getModel().getFullModelRange())], ['Find', 'Ctrl+F', () => ed.getAction('actions.find').run()]])
      // the extension's own metadata commands, as in VS Code's editor: on your side, for metadata
      .concat((ro && !S.plain) || !S.tidy ? [] : [null, ['Format and Order Metadata', 'Shift+Alt+F', () => formatNow(ed === L ? 'left' : 'right')], ['Remove Duplicate Entries', '', () => dedupeNow(ed === L ? 'left' : 'right')]]);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    m.innerHTML = items.map((it, i) => it ? '<div class="mi" role="menuitem" tabindex="-1" data-i="' + i + '"><span>' + it[0] + '</span><span class="sc">' + it[1].replace('Ctrl', mac ? '\u2318' : 'Ctrl') + '</span></div>' : '<div class="sep"></div>').join('');
    m.hidden = false;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(ev.clientX, innerWidth - w - 4) + 'px';
    m.style.top = Math.min(ev.clientY, innerHeight - h - 4) + 'px';
    m.onmousedown = e => e.preventDefault();
    m.onclick = e => { const d = e.target.closest('.mi'); if (!d) return; m.hidden = true; ed.focus(); items[+d.dataset.i][2](); };
  }
  document.addEventListener('mousedown', e => { const m = $('menu'); if (m && !m.hidden && !m.contains(e.target)) m.hidden = true; }, true);
  document.addEventListener('keydown', e => { const m = $('menu'); if (e.key === 'Escape' && m && !m.hidden) m.hidden = true; }, true);

  // ---- what you type goes back to be compared again ----
  let timer = null;
  function typed() {
    clearTimeout(timer);
    // a very large file waits a little longer after the last keystroke: a burst of typing is one update, not one per key
    const wait = R.getModel() && R.getModel().getLineCount() > 20000 ? 600 : 250;
    timer = setTimeout(() => { S.seq++; api.postMessage({ type: 'text', seq: S.seq, text: R.getValue(), regions: regionsNow() }); }, wait);
  }
  function dirty() {
    if (S.applyOnly || S.manual) return status();
    const d = S.saved != null && R.getValue() !== S.saved;
    S.unsaved = d;
    api.postMessage({ type: 'dirty', dirty: d });
    status();
  }

  // ---- drawing the pieces ----
  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function zoneNode(cls, html) { const d = document.createElement('div'); d.className = 'zone ' + cls; d.innerHTML = html || ''; return d; }
  // ---- three panels, Copado's own: the promotion branch's side, your resolution, the feature branch's side ----
  function drawThree(m, items, ld, rd, fd, whole, zone, HEAD, colours) {
    const { GREEN, YELLOW } = colours;
    const sideOf = r => { let l = r, f = r; for (const x of m.segs || []) { if (x.r1 > r) break; l = r + (x.l1 - x.r1); f = r + (x.f1 - x.r1); } return { l, f }; };
    if (m.feat != null && F.getValue() !== m.feat) F.getModel().setValue(m.feat);
    const segs = m.segs || [];
    // the rows first: at the same line a row stands above the padding, so each conflict's row is level in all three
    for (const r of m.rows || []) {
      // its place: where it begins, or holding it - or, none such, where its line is on each side
      const s = segs.find(x => x.r0 === r.at) || segs.find(x => x.r0 <= r.at && r.at <= x.r1) || (() => { const p = sideOf(r.at); return { l0: p.l, l1: p.l, r0: r.at, r1: r.at, f0: p.f, f1: p.f, synthetic: true }; })();
      const done = !r.needs, tag = tagOf(r), cls = ROW(tag)[0];
      // what was removed or left out: struck through in the resolution; a feature version that removes: said on its side
      const act = c => { const a = r.actions.find(x => x.choice === c); return a ? Object.assign([a.op], { review: r.id, choice: c }) : null; };
      const mark = c => r.chosen === c ? ' on' : '';
      // the resolution's row: what it is, and both; each side's: its arrow into the resolution, the same height
      // each button only where its action is offered - a union type's conflict has no both; one that did not join, no feature
      const only = bs => bs.filter(b => b[2]);
      // the middle panel is a third of the width: a long explanation takes two lines - the three rows the same height,
      // the words clear of the button beside them
      const bothB = only([['\u2261', 'Accept both', act('both'), cls + mark('both')]]), PX = HEAD;
      items.right.push({ after: s.r0, lines: 0, px: PX, node: rowNode(cls, wordOf(tag)), buttons: bothB, cls });
      // each side's row: its arrow alone, level with the resolution's
      items.left.push({ after: s.l0, lines: 0, px: PX, node: zoneNode('head side3'), buttons: only([['\u2192', 'Accept promotion', act('target'), 'arw' + mark('target')]]), cls: 'arw' });
      items.feat.push({ after: s.f0, lines: 0, px: PX, node: zoneNode('head side3'), buttons: only([['\u2190', 'Accept feature', act('feature'), 'arw fea' + mark('feature')]]), cls: 'arw' });
      // under the rows - each at its line, after them: what was removed or left out, struck; that the feature removes
      const struck = (r.ghosts || []).find(g => g.cls === 'struck');
      if (struck && s.r1 === s.r0) { items.right.push({ after: s.r0, lines: struck.lines.length, node: struckNode(r, struck.lines) }); s.rExtra = struck.lines.length; }
      if ((r.ghosts || []).some(g => g.removes)) { const n = zoneNode('alt fea'); n.innerHTML = '<div class="alt-t">\u25be <b>Feature</b> \u00b7 removes these lines</div>'; items.feat.push({ after: s.f0, lines: 1, node: n }); s.fExtra = 1; }
      for (const [h0, h1] of r.hl) whole(rd, h0, h1, cls, done ? GREEN : YELLOW);
    }
    for (const s of segs) {
      const nL = s.l1 - s.l0, nR = s.r1 - s.r0 + (s.rExtra || 0), nF = s.f1 - s.f0 + (s.fExtra || 0), H = Math.max(nL, nR, nF);
      whole(ld, s.l0, s.l1, 'tgt3'); whole(fd, s.f0, s.f1, 'fea3');
      // each side padded to the tallest: the three stay level
      if (H > nL) zone('left', s.l1, H - nL, zoneNode('pad'));
      if (H > nR) zone('right', s.r1, H - nR, zoneNode('pad'));
      if (H > nF) zone('feat', s.f1, H - nF, zoneNode('pad'));
      // the words that differ, line for line
      if (nL === nF) for (let k = 0; k < nL; k++) wordsApart(s.l0 + k, s.f0 + k, ld, fd);
    }
    for (const d of m.dupRows || []) {
      const s = segs.find(x => x.l0 <= d.t0 && d.t0 < Math.max(x.l1, x.l0 + 1)), f = s ? s.f0 : sideOf(d.b0).f;
      items.right.push({ after: d.b0, lines: 0, px: HEAD, node: rowNode('dupr', ROW(dupKey(d))[1]), buttons: d.kept ? (d.swap ? [['\u21b6', 'Keep ' + d.label + ' instead', d.swap, 'dupr']] : []) : [['\u21b6', 'Keep', keepOp(d), 'dupr']], cls: 'dupr' });
      items.left.push({ after: d.t0, lines: 0, px: HEAD, node: zoneNode('head side3') });
      items.feat.push({ after: f, lines: 0, px: HEAD, node: zoneNode('head side3') });
      whole(ld, d.t0, d.t1, 'dupl-l', null);
    }
    // the headings: Copado's - each branch as Copado's file names it
    const lb = S.gitLabels || {};
    $('lefthead').innerHTML = '<b>Conflicts in Promotion branch</b>' + (lb.ours ? ' \u00b7 ' + esc(lb.ours) : '');
    $('righthead').innerHTML = '<b>Resolution</b> \u00b7 <span class="ok">editable</span>';
    $('feathead').innerHTML = '<b>Conflicts in Feature branch</b>' + (lb.theirs ? ' \u00b7 ' + esc(lb.theirs) : '');
  }
  // within a line both sides changed: only what differs lit - what comes before and after is the same
  // a row that names its conflict and version: what its buttons insert, and what is shown under it, from the table
  function hydrate(m) {
    if (!m || !m.git || !S.versions) return;
    // Accept both: the two one after the other - or, two entries added at one place, the two whole (B3.6)
    const textOf = (id, c) => { const v = S.versions[id] || { target: '', feature: '' }; return c === 'both' ? (v.both != null ? v.both : v.target + v.feature) : c === 'target' ? v.target : v.feature; };
    const trimmedLines = t => { const ls = String(t).split(/(?<=\n)/).filter((l, i, a) => l !== '' || i < a.length - 1); let a = 0, z = ls.length; while (a < z && !ls[a].trim()) a++; while (z > a && !ls[z - 1].trim()) z--; return ls.slice(a, z); };
    for (const r of m.rows || []) {
      for (const a of r.actions) if (a.op && a.op.insert == null) a.op.insert = textOf(r.id, a.choice);
      for (const g of r.ghosts || []) if (!g.lines) g.lines = trimmedLines(textOf(r.id, g.of));
    }
  }
  // ---- C5: each conflict's lines tracked by the editor itself, as you type - exact, never searched for ----
  // a range that grows at its edges: a version accepted into an empty conflict is in it; undo puts it back as it was
  const lineRange = (b0, b1) => { const md = R.getModel(), n = md.getLineCount();
    const at = l => l < n ? [l + 1, 1] : [n, md.getLineMaxColumn(n)];
    const [a1, a2] = at(b0), [z1, z2] = at(b1); return new monaco.Range(a1, a2, z1, z2); };
  function trackFrom(m) {
    if (!m || !m.git || m.tracked || !R.getModel()) return;
    const rows = m.rows || [];
    const ids = R.getModel().deltaDecorations((S.track || []).map(t => t[1]), rows.map(r => ({ range: lineRange(r.b0, r.b1), options: { stickiness: 0 } })));
    S.track = rows.map((r, i) => [r.id, ids[i]]);
  }
  function regionsNow() {
    if (!S.track || !R.getModel()) return null;
    const md = R.getModel(), n = md.getLineCount(), out = {};
    for (const [id, dec] of S.track) {
      const r = md.getDecorationRange(dec);
      if (!r) return null;
      const b0 = r.startLineNumber - 1 + (r.startColumn > 1 && r.startLineNumber === n && r.startColumn === md.getLineMaxColumn(n) ? 1 : 0);
      const b1 = r.endColumn === 1 ? r.endLineNumber - 1 : r.endLineNumber;
      out[id] = [b0, Math.max(b0, b1)];
    }
    return out;
  }

  function middle(a, b) {
    if (a === b) return [-1, -1];
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    return [p, q];
  }
  function wordsApart(l, f, ld, fd) {
    const a = L.getModel().getLineContent(l + 1), b = F.getModel().getLineContent(f + 1);
    if (a === b) return;
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    if (a.length - q > p) ld.push({ range: new monaco.Range(l + 1, p + 1, l + 1, a.length - q + 1), options: { inlineClassName: 'w3t' } });
    if (b.length - q > p) fd.push({ range: new monaco.Range(f + 1, p + 1, f + 1, b.length - q + 1), options: { inlineClassName: 'w3f' } });
  }
  // identical lines folded away in all three - where they agree, between the places they differ
  // C6: a row is never folded away - every conflict, every copy taken out, every position: the lines around it stay
  function keepRowsOut(runs, m) {
    const at = [];
    for (const r of m.rows || []) { at.push(r.at); for (let l = r.b0; l < r.b1; l++) at.push(l); for (const g of r.ghosts || []) at.push(g.at); }
    for (const d of m.dupRows || []) at.push(d.b0);
    if (!at.length) return runs;
    at.sort((x, y) => x - y);
    const ctx = 3, out = [];
    for (const run of runs) {
      let b = run.b0;
      for (const v of at) {
        if (v + ctx < b || v - ctx >= run.b1) continue;
        const e = Math.min(run.b1, Math.max(b, v - ctx));
        if (e - b >= 4) out.push(slice(run, b, e));
        b = Math.max(b, v + ctx + 1);
        if (b >= run.b1) break;
      }
      if (run.b1 - b >= 4) out.push(slice(run, b, run.b1));
    }
    return out;
    // a part of a run - every side moved alike, the run being the same lines on each
    function slice(run, b0, b1) { const d0 = b0 - run.b0, d1 = b1 - run.b0, o = { a0: run.a0 + d0, a1: run.a0 + d1, b0, b1 }; if (run.f0 != null) { o.f0 = run.f0 + d0; o.f1 = run.f0 + d1; } return o; }
  }
  function threeRuns(m) {
    const ctx = 3, out = [], segs = (m.segs || []).concat([{ l0: L.getModel().getLineCount(), r0: R.getModel().getLineCount(), f0: F.getModel().getLineCount(), end: true }]);
    let l = 0, r = 0, f = 0;
    for (const s of segs) {
      const n = s.r0 - r, a = r === 0 ? 0 : ctx, z = s.end ? 0 : ctx;
      if (n - a - z >= 4 && !(S.expanded || []).some(([e0, e1]) => e0 < s.r0 - z && r + a < e1)) out.push({ a0: l + a, a1: s.l0 - z, b0: r + a, b1: s.r0 - z, f0: f + a, f1: s.f0 - z });
      if (s.end) break;
      l = s.l1; r = s.r1; f = s.f1;
    }
    return keepRowsOut(out, m);
  }
  // what a conflict's row says: to resolve; resolved - its lines in the file; or, an empty version accepted, removed by
  // the feature or left out by you - lines not in the file, struck through in their colour
  const byChoice = (r, leave) => { const o = {}; for (const a of r.actions) if (a.choice !== leave) o[a.choice] = Object.assign([a.op], { review: r.id, choice: a.choice }); return o; };
  const keepOp = d => d.kept ? d.swap : [{ b0: d.b0, b1: d.b0, insert: d.ghost.join(''), expect: [] }];
  const dupKey = d => d.kept ? (d.swap ? 'dupKept' : 'dupGone') : 'dupRemoved';
  const dupButton = (it, d) => { if (it && d.kept) it.buttons = d.swap ? it.buttons.map(b => [b[0], 'Keep ' + d.label + ' instead'].concat(b.slice(2))) : []; return it; };
  const tagOf = r => r.positions && !r.needs && r.chosen === 'feature' ? 'positions' : r.needs ? 'conflict' : r.outcome === 'removed' ? 'removedRes' : r.outcome === 'leftout' ? 'leftOut' : 'resolved';
  const struckNode = (r, lines) => ghostNode(lines, r.outcome === 'leftout' ? 'leftout' : 'gone');
  // a conflict's row: the version accepted shown as chosen; nothing chosen yet, said
  function markChoice(it, r) {
    if (!it) return;
    // the chosen one, by its action's name - a duplicate's buttons say Keep first, Keep second
    it.buttons.forEach(b => { if (b[2] && b[2].choice === r.chosen) b[3] = (b[3] || '') + ' on'; });
  }
  const SHOWN = 300;
  const shownOf = lines => lines.length > SHOWN ? SHOWN + 1 : lines.length;
  function altNode(title, lines, removes) {
    const d = document.createElement('div');
    d.className = 'zone alt';
    // one line of the editor per line - the zone is that many lines high
    const lh = R.getOption(monaco.editor.EditorOption.lineHeight);
    d.style.fontFamily = fontFamily(); d.style.fontSize = fontSize() + 'px'; d.style.lineHeight = lh + 'px'; d.style.setProperty('--lh', lh + 'px');
    d.className += title === 'Target' ? ' tgt' : title === 'Feature' ? ' fea' : '';
    // the version's name alone - a version with no lines says it removes them, or its heading would stand over nothing
    d.innerHTML = '<div class="alt-t">\u25be <b>' + esc(title) + '</b>' + (removes ? ' \u00b7 removes these lines' : '') + '</div>' +
      lines.slice(0, SHOWN).map(l => '<div class="alt-l">' + (esc(l.replace(/\r?\n$/, '')) || '&nbsp;') + '</div>').join('') +
      (lines.length > SHOWN ? '<div class="alt-l alt-more">\u2026 ' + (lines.length - SHOWN).toLocaleString() + ' more lines \u2013 two or three panels show them all</div>' : '');
    return d;
  }
  function ghostNode(lines, cls) {
    const d = zoneNode('ghost ' + cls);
    d.style.fontFamily = fontFamily(); d.style.fontSize = fontSize() + 'px';
    d.style.lineHeight = R.getOption(monaco.editor.EditorOption.lineHeight) + 'px';
    d.innerHTML = lines.map(l => '<div class="gl">' + (esc(l.replace(/\r?\n$/, '')) || '&nbsp;') + '</div>').join('');
    return d;
  }

  // icons: drawn, one size and one weight everywhere - rows, toolbar, the hidden-lines bar
  const SVG = d => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ICON = {
    undo: SVG('<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/>'),
    x: SVG('<path d="m4 4 8 8M12 4l-8 8"/>'),
    swap: SVG('<path d="M2.5 5h10l-2.5-2.5M13.5 11h-10L6 13.5"/>'),
    both: SVG('<path d="M3 4.5h10M3 8h10M3 11.5h6"/>'),
    up: SVG('<path d="m4 10 4-4 4 4"/>'), down: SVG('<path d="m4 6 4 4 4-4"/>'),
    more: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>',
    // arrows opening away from a line: the hidden-lines row, in the line-number column
    expand: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M6 4l2-2 2 2M8 14v-4M6 12l2 2 2-2M3.5 8h9"/></svg>',
    eye: SVG('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
    check: SVG('<path d="m3 8.5 3 3 7-7"/>'),
    chev: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>'
  };
  const GLYPH = { '\u21b6': 'undo', '\u2715': 'x', '\u21c4': 'swap', '\u2261': 'both' };

  // the rows between lines: one word in the colour of the change, and icon buttons whose names are their tooltips
  const side = () => /feature/i.test(S.theirs || '') ? 'feature' : 'incoming';
  const ROW = k => ({
    feature: ['feat', 'Added', [['\u21b6', 'Undo']]], own: ['own', 'Added by you', [['\u21b6', 'Undo']]],
    'changed-feature': ['feat', 'Changed', [['\u21b6', 'Use target']]], 'changed-own': ['own', 'Edited', [['\u21b6', 'Use target']]],
    removed: ['rem', 'Removed', [['\u21b6', 'Restore']]], notin: ['rem', 'Not in ' + side(), [['\u21b6', 'Restore']]],
    dupRemoved: ['dupr', 'Duplicate', [['\u21b6', 'Keep']]],
    dupKept: ['dupr', 'Duplicate \u00b7 the copy granting more kept', [['\u21b6', 'Keep the other instead']]],
    // the copy kept is no longer as it was - the entry's own conflict, or your edit: nothing to swap
    dupGone: ['dupr', 'Duplicate \u00b7 the other copy taken out', []],
    // with the common ancestor: what the feature branch itself did
    byFeature: ['rem', 'Removed by the ' + side(), [['\u21b6', 'Restore']]],
    keptRemoved: ['keep', 'Kept \u00b7 removed by the ' + side(), [['\u2715', 'Remove']]],
    changedBy: ['keep', cap(side()) + ' changed it', [['\u21c4', 'Use ' + side()]]], dropped: ['rem', 'Left out', [['\u21b6', 'Add it back']]],
    kept: ['keep', 'Kept \u00b7 not in ' + side(), [['\u2715', 'Remove']]], differs: ['keep', cap(side()) + ' differs', [['\u21c4', 'Use ' + side()]]],
 // a value both branches changed: the same words as code's conflicts - counted until one is accepted
    conf: ['conf', 'Conflict', [['\u21b6', 'Accept target'], ['\u21c4', 'Accept feature']]],
    dup: ['dup', 'Duplicate', [['\u2715', 'Remove copy']]],
    // a promotion's code: a conflict git left - neither version in until one is accepted
    conflict: ['conf', 'Conflict', [['\u21b6', 'Accept target', 'target'], ['\u21c4', 'Accept feature', 'feature'], ['\u2261', 'Accept both', 'both']]],
    resolved: ['res', 'Resolved', [['\u21b6', 'Accept target', 'target'], ['\u21c4', 'Accept feature', 'feature'], ['\u2261', 'Accept both', 'both']]],
    positions: ['pos', 'Positions \u00b7 the feature\u2019s', [['\u21b6', 'Use target', 'target']]],
    removedRes: ['rem', 'Removed', [['\u21b6', 'Accept target', 'target'], ['\u21c4', 'Accept feature', 'feature'], ['\u2261', 'Accept both', 'both']]],
    leftOut: ['lo', 'Left out', [['\u21b6', 'Accept target', 'target'], ['\u21c4', 'Accept feature', 'feature'], ['\u2261', 'Accept both', 'both']]],
    // a comparison: what differs, said - nothing to move across
    plainDiff: ['mv', 'Differs', []],
    plainRight: ['mv', 'Only here', []],
    plainLeft: ['mv', 'Not here', []],
    // a flow element only dragged in Flow Builder: shown, quietly - F7 passes it by
    position: ['pos', 'Moved on the canvas', [['\u21b6', 'Use target']]]
  })[k];
  const rowNode = (cls, word) => { const n = zoneNode('head ' + cls, '<span class="dotk"></span><b>' + esc(word) + '</b>'); n.title = word; return n; };
  // a row says what it is - Conflict, Resolved, Removed, Left out - and nothing more
  const wordOf = tag => ROW(tag)[1];

  function draw(m) {
    S.marks = m;
    document.body.classList.toggle('single', !!m.single);
    const lh = R.getOption(monaco.editor.EditorOption.lineHeight);
    const HEAD = Math.max(22, lh + 3), FOLD = lh + 4;
    const items = { left: [], right: [], feat: [] };
    document.body.classList.toggle('three', !!m.three);
    // a zone: lines, or a header row's pixels; buttons over it, or the whole of it a click
    const zone = (sd, after, lines, node, buttons, opts) => items[sd].push(Object.assign({ after, lines, node, buttons }, opts || {}));
    // a change's row on both sides: the word on your side, a wordless row on the target's, the same height
    const rowsAt = new Map();
    const row = (key, after, leftAfter, undos, word) => {
      const [cls, w, btns] = ROW(key);
      // actions given by name go to the button of that name - a missing one is no button, never another's
      const named = undos && !Array.isArray(undos);
      const buttons = btns.map((b, i) => [b[0], b[1], named ? (b[2] ? undos[b[2]] : null) : undos[i]]).filter(b => b[2]);
      // only a duplicate joins a row already there - one for lines on your side (added, edited, kept), never a removed block's
      const at = key === 'dup' && rowsAt.get(after);
      if (at) {
        // a second mark on the same lines - a duplicate of something you added: the same row, both actions
        at.node.querySelector('b').insertAdjacentHTML('beforeend', ' <span class="also ' + cls + '">\u00b7 ' + esc(word || w) + '</span>');
        at.buttons.push(...buttons.map(b => b.concat(cls)));
        return;
      }
      const item = { after, lines: 0, node: rowNode(cls, word || w), buttons: buttons.map(b => b.concat(cls)), px: HEAD, cls };
      items.right.push(item);
      if (!['removed', 'notin', 'dupRemoved', 'dropped'].includes(key)) rowsAt.set(after, item);
      if (!m.single) zone('left', leftAfter, 0, zoneNode('head ' + cls + ' l'), null, { px: HEAD });
      return item;
    };
    const ld = [], rd = [], fd = [];
    const whole = (arr, l0, l1, cls, ruler, glyph) => { if (l1 > l0) arr.push({ range: new monaco.Range(l0 + 1, 1, l1, 1), options: { isWholeLine: true, className: cls, linesDecorationsClassName: cls + '-g', glyphMarginClassName: glyph || undefined, overviewRuler: ruler ? { color: ruler, position: monaco.editor.OverviewRulerLane.Full } : undefined } }); };
    const ORANGE = 'rgba(232,145,45,.9)', RED = 'rgba(241,76,76,.7)', GREEN = 'rgba(137,209,133,.8)', BLUE = 'rgba(55,148,255,.8)', PURPLE = 'rgba(177,128,215,.9)', YELLOW = 'rgba(204,167,0,.9)';

    // a right-hand line's place on the left: line for line inside an unchanged piece, the piece's start otherwise
    const holding = b => m.pieces.find(p => p.b0 <= b && b < p.b1);
    const leftOf = b => { const p = holding(b); return p ? (p.kind === 'same' ? p.a0 + (b - p.b0) : p.a0) : (m.pieces.length ? m.pieces[m.pieces.length - 1].a1 : 0); };
    // code, one pane: each row - its words, its buttons, the other version's or the old lines under it, its lines lit
    if (m.single) for (const r of m.rows) {
      const done = !r.needs;
      const it = row(tagOf(r), r.at, r.at, byChoice(r), wordOf(tagOf(r)));
      markChoice(it, r);
      for (const g of r.ghosts) g.cls === 'struck' ? zone('right', g.at, g.lines.length, struckNode(r, g.lines)) : zone('right', g.at, shownOf(g.lines) + 1, altNode(g.title, g.lines, g.removes));
      for (const [h0, h1] of r.hl) whole(rd, h0, h1, done ? 'res' : 'conf', done ? GREEN : YELLOW);
    }
    if (m.single) for (const d of m.dupRows || []) { dupButton(row(dupKey(d), d.b0, d.b0, [keepOp(d)], null), d); zone('right', d.b0, d.ghost.length, ghostNode(d.ghost, 'dupr')); }
    // two panels: the copy's lines on the left, greyed; the row level on both sides
    if (!m.single && !m.three && m.git) for (const d of m.dupRows || []) { dupButton(row(dupKey(d), d.b0, d.t0, [keepOp(d)], null), d); whole(ld, d.t0, d.t1, 'dupl-l', null); }
    const conflictRows = !m.single && m.code && !m.plain && !m.three ? (m.rows || []) : [];
    // a line under a choice's row is the choice's - and a member left out is its row, not a removal as well
    const underConflict = p => conflictRows.some(r => (p.b0 < r.b1 && r.b0 < Math.max(p.b1, p.b0 + 1)) || (r.b0 === r.b1 && p.b1 === p.b0 && p.b0 === r.b0));
    // the line piece a conflict sits on: the target's lines there, and what the resolution has there
    const conflictPieces = r => { const ps = m.pieces.filter(p => p.kind !== 'same' && ((p.b0 < r.b1 && r.b0 < Math.max(p.b1, p.b0 + 1)) || (r.b0 === r.b1 && p.b0 === r.b0))); if (!ps.length) return null;
      return { a0: Math.min(...ps.map(p => p.a0)), a1: Math.max(...ps.map(p => p.a1)), b0: Math.min(...ps.map(p => p.b0)), b1: Math.max(...ps.map(p => p.b1)) }; };
    // the words that differ between the target's lines and the feature's version shown beside them
    const wordsBeside = (piece, lines, node, ld) => {
      if (piece.a1 - piece.a0 !== lines.length) return;
      const rows = node.querySelectorAll('.alt-l');
      lines.forEach((b0, k) => { const a = L.getModel().getLineContent(piece.a0 + k + 1), b = String(b0).replace(/\r?\n$/, '');
        const [p, q] = middle(a, b); if (p < 0) return;
        if (a.length - q > p) ld.push({ range: new monaco.Range(piece.a0 + k + 1, p + 1, piece.a0 + k + 1, a.length - q + 1), options: { inlineClassName: 'w3t' } });
        if (rows[k] && b.length - q > p) rows[k].innerHTML = esc(b.slice(0, p)) + '<span class="w3f">' + esc(b.slice(p, b.length - q)) + '</span>' + esc(b.slice(b.length - q)); });
    };
    for (const r of conflictRows) {
      const done = !r.needs, tag = tagOf(r), cls = ROW(tag)[0];
      const pieceOf = conflictPieces(r);
      const la0 = pieceOf ? pieceOf.a0 : leftOf(r.at), la1 = pieceOf ? pieceOf.a1 : leftOf(r.at), rb1 = pieceOf ? pieceOf.b1 : r.at;
      // the resolution's row: the feature and both - the target's button stands beside its lines, on the left
      const it = row(tag, r.at, la0, byChoice(r, 'target'), wordOf(tag));
      markChoice(it, r);
      if (it) {
        const counterpart = items.left[items.left.length - 1], t = r.actions.find(a => a.choice === 'target');
        if (counterpart && t) counterpart.buttons = [['\u21b6', 'Accept target', Object.assign([t.op], { review: r.id, choice: 'target' }), 'arw' + (r.chosen === 'target' ? ' on' : '')]];
      }
      // under the row: the feature's version (or that it removes the lines) - or what was removed or left out, struck
      const shown = r.ghosts.filter(g => g.title !== 'Target');
      let rightH = 0;
      for (const g of shown) {
        if (g.cls === 'struck') { zone('right', g.at, g.lines.length, struckNode(r, g.lines)); rightH += g.lines.length; }
        else { const node = altNode(g.title, g.lines, g.removes); zone('right', g.at, shownOf(g.lines) + 1, node); rightH += shownOf(g.lines) + 1; if (pieceOf) wordsBeside(pieceOf, g.lines, node, ld); }
      }
      // the target's lines where they are, lit; the shorter side padded after its own
      whole(ld, la0, la1, 'tgt3');
      const leftH = la1 - la0, resH = (pieceOf ? pieceOf.b1 - pieceOf.b0 : 0) + rightH;
      if (resH > leftH) zone('left', la1, resH - leftH, zoneNode('pad'));
      else if (leftH > resH) zone('right', rb1, leftH - resH, zoneNode('pad'));
      for (const [h0, h1] of r.hl) whole(rd, h0, h1, done ? 'res' : 'conf', done ? GREEN : YELLOW);
    }
    if (m.three) drawThree(m, items, ld, rd, fd, whole, zone, HEAD, { GREEN, YELLOW });
    for (const p of (m.single || m.three ? [] : m.pieces)) {
      if (p.kind === 'same') continue;
      // under a conflict's row: the conflict draws it, its padding too
      if (m.git && underConflict(p)) continue;
      // a promotion's file elsewhere - where only conflicts are marked: colours, no row
      if (underConflict(p) || m.git) { const lc0 = p.a1 - p.a0, rc0 = p.b1 - p.b0; if (lc0) whole(ld, p.a0, p.a1, 'del'); if (rc0 > lc0) zone('left', p.a1, rc0 - lc0, zoneNode('pad')); if (lc0 > rc0) zone('right', p.b1, lc0 - rc0, zoneNode('pad')); continue; }
      // blank lines only: no row - the panes kept level, nothing more
      if (p.kind === 'blank') {
        const lc0 = p.a1 - p.a0, rc0 = p.b1 - p.b0;
        if (rc0 > lc0) zone('left', p.a1, rc0 - lc0, zoneNode('pad'));
        if (lc0 > rc0) zone('right', p.b1, lc0 - rc0, zoneNode('pad'));
        continue;
      }
      const lc = p.a1 - p.a0, rc = p.b1 - p.b0;
      const key = m.plain ? (/^changed/.test(p.kind) ? 'plainDiff' : p.kind === 'removed' || p.kind === 'dropped' ? 'plainLeft' : 'plainRight')
        : p.kind === 'removed' ? (p.dupRemoved ? 'dupRemoved' : p.byFeature ? 'byFeature' : p.notInFeature ? 'notin' : 'removed') : p.kind === 'kept' && p.byFeature ? 'keptRemoved' : p.kind === 'differs' && p.byFeature ? 'changedBy' : p.kind;
      // moved: removed from its place, added at the new one - each says where the other is
      const [, w0] = ROW(key);
      // code says which member: "Changed \u00b7 method tax(Decimal)"
      const member = m.code && p.label && !/^\s*$/.test(p.label) ? ' \u00b7 ' + p.label.replace(/ edited$/, '').replace(/ \(\d+ lines?\)$/, '') : '';
      row(key, p.b0, p.a0, [p.undo], !m.plain && member ? w0 + member : null);
      if (p.kind === 'removed' || p.kind === 'dropped') {
        // no lines on your side: the target's (or the feature's) lines, struck through, where they were
        const ghost = p.ghost || [];
        zone('right', p.b0, ghost.length, ghostNode(ghost, p.dupRemoved ? 'dupr' : p.kind));
        if (p.kind === 'removed') whole(ld, p.a0, p.a1, p.dupRemoved ? 'dupl-l' : 'del', p.dupRemoved ? null : RED); else zone('left', p.a0, ghost.length, zoneNode('pad'));
        continue;
      }
      if (p.kind === 'kept' || p.kind === 'differs') { whole(rd, p.b0, p.b1, 'keep', ORANGE); continue; }
      if (lc) whole(ld, p.a0, p.a1, 'del', RED);
      if (p.kind === 'position') { whole(rd, p.b0, p.b1, 'pos'); continue; }
      whole(rd, p.b0, p.b1, /feature/.test(p.kind) ? 'feat' : 'own', /feature/.test(p.kind) ? GREEN : BLUE);
      if (rc > lc) zone('left', p.a1, rc - lc, zoneNode('pad'));
      if (lc > rc) zone('right', p.b1, lc - rc, zoneNode('pad'));
    }
    // both branches changed it: yours to settle
    for (const c of S.conflicts) {
      if (c.line == null) continue;
      whole(rd, c.line, c.line + 1, 'conf', YELLOW);
      row('conf', c.line, leftOf(c.line), c.multiline ? [] : [{ conflict: c, use: 'base' }, { conflict: c, use: 'incoming' }]);
    }
    const lns = R.getModel().getLinesContent();
    // in-line: of an edited line, the characters that changed - on both sides
    for (const p of m.pieces) {
      if (!/^changed/.test(p.kind) || p.a1 - p.a0 !== p.b1 - p.b0) continue;
      const left = L.getModel().getLinesContent();
      for (let i = 0; i < p.b1 - p.b0; i++) {
        const a = left[p.a0 + i] || '', b = lns[p.b0 + i] || '';
        let s0 = 0; while (s0 < a.length && s0 < b.length && a[s0] === b[s0]) s0++;
        let e = 0; while (e < a.length - s0 && e < b.length - s0 && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
        if (a.length - e > s0) ld.push({ range: new monaco.Range(p.a0 + i + 1, s0 + 1, p.a0 + i + 1, a.length - e + 1), options: { inlineClassName: 'chg-l' } });
        if (b.length - e > s0) rd.push({ range: new monaco.Range(p.b0 + i + 1, s0 + 1, p.b0 + i + 1, b.length - e + 1), options: { inlineClassName: 'chg-r' } });
      }
    }
    // a duplicate in your resolution - one you added: marked on its lines, and removed with one click
    const lines = R.getModel().getLinesContent();
    S.dups = m.dups || [];
    for (const d of S.dups) {
      row('dup', d.b0, leftOf(d.b0), [[{ b0: d.b0, b1: d.b1, expect: lines.slice(d.b0, d.b1), insert: '' }]], 'Duplicate of line ' + d.sameAs);
      whole(rd, d.b0, d.b1, 'dupl', YELLOW, 'dup-glyph');
    }
    monaco.editor.setModelMarkers(R.getModel(), 'cmr-dups', S.dups.map(d => {
      const first = Math.max(1, (lines[d.b0] || '').search(/\S/) + 1);
      // its first line underlined - the tint and the margin mark the rest
      return { severity: monaco.MarkerSeverity.Warning, message: 'A duplicate of line ' + d.sameAs, startLineNumber: d.b0 + 1, startColumn: first, endLineNumber: d.b0 + 1, endColumn: (lines[d.b0] || '').length + 1 };
    }));
    monaco.editor.setModelMarkers(R.getModel(), 'cmr-xml', []);
    S.problems = m.problems || [];
    monaco.editor.setModelMarkers(R.getModel(), 'cmr-code', S.problems.map(q => ({ severity: q.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning, message: q.message,
      startLineNumber: q.line, startColumn: q.column || 1, endLineNumber: q.line, endColumn: R.getModel().getLineMaxColumn(Math.min(q.line, R.getModel().getLineCount())) })));
    S.typed.clear(); if (S.deco.typed) S.deco.typed.set([]);

    // identical lines folded away - the same lines on both sides, so the panes stay level
    S.hiddenRuns = S.hide ? (m.three ? threeRuns(m) : identicalRuns(m)) : [];
    for (const run of S.hiddenRuns) {
      const n = run.b1 - run.b0, text = n + ' hidden line' + (n === 1 ? '' : 's');
      const open = () => { S.expanded.push([run.b0, run.b1]); draw(S.marks); };
      // after the run's last line: Monaco hides a row whose next line is hidden
      for (const [sd, after] of [['right', run.b1], ['left', run.a1]].concat(m.three ? [['feat', run.f1]] : [])) {
        const margin = document.createElement('div');
        margin.className = 'fold-m';
        // Monaco's margin zones have no width of their own: the icon is placed in pixels, under the line numbers
        const li = (sd === 'left' ? L : sd === 'feat' ? F : R).getLayoutInfo();
        // Monaco sizes a margin zone itself: the icon is placed inside it, exactly over the line-number column
        margin.innerHTML = '<span class="fx" style="left:' + li.lineNumbersLeft + 'px;width:' + li.lineNumbersWidth + 'px;height:' + FOLD + 'px">' + ICON.expand + '</span>';
        zone(sd, after, 0, zoneNode('fold', '<span class="ft">' + esc(text) + '</span><span class="rule"></span>'), null, { click: open, title: 'Show these ' + n + ' lines', px: FOLD, margin });
      }
    }
    applyHidden();

    // the zones: replaced as a whole, in order, the same rows on both sides
    for (const sd of ['left', 'right', 'feat']) {
      const ed = sd === 'left' ? L : sd === 'feat' ? F : R;
      S.zones[sd] = S.zones[sd] || []; S.widgets[sd] = S.widgets[sd] || [];
      ed.changeViewZones(acc => {
        for (const id of S.zones[sd]) acc.removeZone(id);
        S.zones[sd] = items[sd].map((it, i) => acc.addZone(Object.assign({ afterLineNumber: it.after, domNode: it.node, ordinal: i, marginDomNode: it.margin || undefined,
          onDomNodeTop: (it.buttons && it.buttons.length) || it.click ? top => place(it, top) : undefined }, it.px ? { heightInPx: it.px } : { heightInLines: it.lines })));
      });
      // what is clickable sits over the zones (a zone itself takes no clicks): buttons, or a whole row
      for (const w of S.widgets[sd]) ed.removeOverlayWidget(w);
      S.widgets[sd] = [];
      items[sd].filter(it => (it.buttons && it.buttons.length) || it.click).forEach((it, i) => {
        const node = document.createElement('div');
        node.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
        if (it.click) {
          node.className = 'rowclick'; node.title = it.title || '';
          node.style.height = (it.px || it.lines * lh) + 'px';
          node.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); it.click(); });
          const hov = on => { it.node.classList.toggle('hov', on); if (it.margin) it.margin.classList.toggle('hov', on); };
          node.addEventListener('mouseenter', () => hov(true)); node.addEventListener('mouseleave', () => hov(false));
          if (it.margin) {
            it.margin.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
            it.margin.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); it.click(); });
            it.margin.addEventListener('mouseenter', () => hov(true)); it.margin.addEventListener('mouseleave', () => hov(false));
          }
        } else {
          node.className = 'acts'; node.style.height = (it.px || lh) + 'px';
          for (const [icon, title, undo, cls] of it.buttons) {
            const b = document.createElement('button');
            b.className = 'ib ' + (cls || it.cls || ''); b.innerHTML = (ICON[GLYPH[icon]] || ICON.undo) + '<span>' + esc(title) + '</span>'; b.title = title;
            b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
            b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); act(undo); });
            node.appendChild(b);
          }
        }
        const w = { getId: () => 'cmr.' + sd + '.' + i, getDomNode: () => node, getPosition: () => null };
        it.widget = node;
        ed.addOverlayWidget(w);
        S.widgets[sd].push(w);
        // the row's words stop short of its buttons, however many and however wide they are
        if (!it.click) it.node.style.setProperty('--btn-w', node.offsetWidth + 'px');
      });
    }
    S.deco.left = S.deco.left ? (S.deco.left.set(ld), S.deco.left) : L.createDecorationsCollection(ld);
    S.deco.right = S.deco.right ? (S.deco.right.set(rd), S.deco.right) : R.createDecorationsCollection(rd);
    S.deco.feat = S.deco.feat ? (S.deco.feat.set(fd), S.deco.feat) : F.createDecorationsCollection(fd);
    summary(m);
    where();
    balance();
    // the expand icon sits where the line numbers are, in each pane
    for (const ed of [L, R]) { const li = ed.getLayoutInfo(); const st = ed.getContainerDomNode().style; st.setProperty('--fold-w', li.contentLeft + 'px'); st.setProperty('--fold-pr', Math.max(0, li.contentLeft - (li.lineNumbersLeft + li.lineNumbersWidth)) + 'px'); }
    // a row's words fit the width you see - a row is as wide as the longest line, which may be far wider
    // measured on the page: the editor's own layout figures can lag behind a switch between two and three panels
    for (const ed of [L, R, F]) { const box = ed.getContainerDomNode(), li = ed.getLayoutInfo(); box.style.setProperty('--pane-w', Math.max(120, box.clientWidth - li.contentLeft - li.verticalScrollbarWidth) + 'px'); }
  }

  /**
   * The runs of identical lines to fold: inside an unchanged piece that is line for line the same on both
   * sides, away from every change, move and conflict by CONTEXT lines, at least RUN long, and not one you
   * opened. In your resolution's lines [b0, b1) and the target's [a0, a1).
   */
  function identicalRuns(m) {
    // one pane: the lines no row touches are the unchanged ones
    if (m.single) {
      const n = R.getModel().getLineCount(), busy = new Array(n + 1).fill(false);
      for (const r of m.rows) { busy[Math.min(r.at, n)] = true; for (let l = r.b0; l < r.b1; l++) busy[l] = true; for (const g of r.ghosts) busy[Math.min(g.at, n)] = true; }
      const pieces = [];
      for (let l = 0; l < n;) { const b = busy[l]; let e = l; while (e < n && busy[e] === b) e++; pieces.push({ kind: b ? 'chg' : 'same', a0: l, a1: e, b0: l, b1: e }); l = e; }
      return identicalRuns(Object.assign({}, m, { single: false, pieces }));
    }
    const total = R.getModel().getLineCount();
    const keep = new Uint8Array(total + 1);
    const near = (b0, b1) => { for (let i = Math.max(0, b0 - CONTEXT); i < Math.min(total, b1 + CONTEXT); i++) keep[i] = 1; };
    for (const p of m.pieces) if (p.kind !== 'same') near(p.b0, p.b1);
    for (const c of S.conflicts) if (c.line != null) near(c.line, c.line + 1);
    // what you opened stays open, and so does the run your cursor is in
    const here = R.getPosition() ? R.getPosition().lineNumber - 1 : -1;
    const opened = (b0, b1) => (here >= b0 && here < b1) || S.expanded.some(([x0, x1]) => b0 < x1 && x0 < b1);
    const runs = [];
    for (const p of m.pieces) {
      if (p.kind !== 'same' || p.a1 - p.a0 !== p.b1 - p.b0) continue;
      let i = p.b0;
      while (i < p.b1) {
        if (keep[i]) { i++; continue; }
        let j = i;
        while (j < p.b1 && !keep[j]) j++;
        if (j - i >= RUN && !opened(i, j)) runs.push({ b0: i, b1: j, a0: p.a0 + (i - p.b0), a1: p.a0 + (j - p.b0) });
        i = j;
      }
    }
    return keepRowsOut(runs, m);
  }
  // the cursor in a folded run - Ctrl+F, Ctrl+G, a click - opens it
  function openAt(side, line) {
    const run = S.hiddenRuns.find(r => side === 'right' ? line >= r.b0 && line < r.b1 : line >= r.a0 && line < r.a1);
    if (run) { S.expanded.push([run.b0, run.b1]); draw(S.marks); }
  }
  function place(it, top) {
    if (it.widget) { it.widget.style.top = top + 'px'; it.widget.style.display = ''; }
  }

  function summary(m) {
    const c = m.counts || {};
    if (m.plain) {
      $('chips').innerHTML = c.differs ? '<span class="chip mv">' + c.differs + ' difference' + (c.differs === 1 ? '' : 's') + '</span>' : '<span class="chip">no differences</span>';
      status();
      return;
    }
    if (m.code) {
      // two panels: the target's side of Copado's file beside it, named
      if (!m.single && !m.three) $('lefthead').innerHTML = '<b>' + esc(S.labels.target || 'Target') + '</b> \u00b7 read-only';
      $('chips').innerHTML = c.needs ? '<span class="chip conf">' + c.needs + ' conflict' + (c.needs === 1 ? '' : 's') + ' to resolve</span>' + (c.resolved ? '<span class="chip">' + c.resolved + ' resolved</span>' : '')
        : c.conflicts ? '<span class="chip">' + c.conflicts + ' conflict' + (c.conflicts === 1 ? '' : 's') + ' resolved</span>' : '<span class="chip">no conflicts</span>';
      status();
      return;
    }
    const conflicts = S.conflicts.length;
    const chips = [['feat', (c.feature || 0), 'from ' + (S.short || 'the feature')], ['own', c.own, c.own === 1 ? 'your edit' : 'your edits'],
      ['del', (c.removed || 0) + (c.dropped || 0), 'removed'], ['keep', (c.kept || 0) + (c.differs || 0), 'not taken from ' + (S.short || 'the feature')],
      ['conf', conflicts, conflicts === 1 ? 'conflict' : 'conflicts'], ['pos', c.position, 'on the canvas']]
      .filter(x => x[1]).map(x => '<span class="chip ' + x[0] + '" title="' + x[1] + ' ' + x[2] + '">' + x[1] + ' ' + x[2] + '</span>');
    $('chips').innerHTML = chips.length ? chips.join('') : '<span class="chip">the same as the target</span>';
    status();
    $('lefthead').innerHTML = '<b>' + esc(S.labels.target) + '</b> \u00b7 ' + 'read-only';
  }

  // ---- the buttons: one edit, undone with Ctrl+Z ----
  function act(undo) {
    const model = R.getModel();
    let ops;
    if (undo && undo.conflict) {
      const c = undo.conflict, line = c.line + 1;
      if (line > model.getLineCount()) return note('That line has changed - nothing was done.', true);
      const text = model.getLineContent(line);
      const re = new RegExp('(<' + c.tag + '(?:\\s[^>]*)?>)([\\s\\S]*?)(</' + c.tag + '>)');
      if (!re.test(text)) return note('That line has changed - nothing was done.', true);
      const value = String(undo.use === 'base' ? c.base : c.incoming).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      ops = [{ range: new monaco.Range(line, 1, line, text.length + 1), text: text.replace(re, (all, a, b, z) => a + value + z) }];
    } else {
      const lines = model.getLinesContent();
      const count = model.getLineCount();
      for (const o of undo) {
        const now = lines.slice(o.b0, o.b1);
        const changed = o.expect ? now.length !== o.expect.length || now.some((l, i) => l !== o.expect[i]) : now.length !== o.n || (o.n > 0 && (now[0] !== o.head || now[o.n - 1] !== o.tail));
        if (changed) return note('Those lines have changed since they were marked - nothing was done.', true);
      }
      const at = b => b < count ? model.getOffsetAt({ lineNumber: b + 1, column: 1 }) : model.getValueLength();
      ops = undo.map(o => {
        let insert = o.insert;
        // the end of a file with no line break: keep one between what is there and what comes back
        if (o.b0 >= count && insert && model.getValueLength() && !/\n$/.test(model.getValue())) insert = model.getEOL() + insert.replace(/\r?\n$/, '');
        return { range: monaco.Range.fromPositions(model.getPositionAt(at(o.b0)), model.getPositionAt(at(o.b1))), text: insert };
      });
    }
    R.pushUndoStop();
    model.pushEditOperations(R.getSelections(), ops, () => null);
    R.pushUndoStop();
    R.focus();
    // only an empty version needs remembering - every other choice is in the text, so Ctrl+Z takes it back
    if (undo && undo.review && undo.every(o => !o.insert)) { S.seq++; api.postMessage({ type: 'review', regions: regionsNow(), id: undo.review, choice: undo.choice, seq: S.seq, text: R.getValue() }); }
  }

  // ---- next and previous change ----
  // ---- what is hidden: the identical runs, and on the target's side what you folded in yours ----
  const leftLine = b => { const m = S.marks; if (!m) return b; const p = m.pieces.find(q => q.b0 <= b && b < q.b1); return p ? (p.kind === 'same' ? p.a0 + (b - p.b0) : p.a0) : b; };
  function applyHidden() {
    const runs = S.hiddenRuns || [];
    const mirror = (S.folds || []).map(([f0, f1]) => { const a0 = leftLine(f0), a1 = leftLine(f1 - 1) + 1; return a1 > a0 + 1 ? new monaco.Range(a0 + 2, 1, a1, 1) : null; }).filter(Boolean);
    L.setHiddenAreas(runs.map(r => new monaco.Range(r.a0 + 1, 1, r.a1, 1)).concat(mirror));
    R.setHiddenAreas(runs.map(r => new monaco.Range(r.b0 + 1, 1, r.b1, 1)));
    F.setHiddenAreas(runs.filter(r => r.f1 != null).map(r => new monaco.Range(r.f0 + 1, 1, r.f1, 1)));
  }
  function watchFolds() {
    const fc = R.getContribution && R.getContribution('editor.contrib.folding');
    if (!fc || !fc.getFoldingModel) return;
    const hook = () => Promise.resolve(fc.getFoldingModel()).then(fm => {
      if (!fm || fm.__cmr) return;
      fm.__cmr = true;
      fm.onDidChange(() => {
        const rg = fm.regions, out = [];
        for (let i = 0; i < rg.length; i++) if (rg.isCollapsed(i)) out.push([rg.getStartLineNumber(i) - 1, rg.getEndLineNumber(i)]);
        S.folds = out;
        applyHidden(); balance();
      });
    }).catch(() => {});
    hook(); R.onDidChangeModel(hook);
  }

  // ---- word wrap: a wrapped line is taller on one side - each piece is evened out, so the panes stay level ----
  const padIds = { left: [], right: [] };
  function balance() {
    for (const sd of ['left', 'right']) { const ed = sd === 'left' ? L : R; if (padIds[sd].length) { const ids = padIds[sd]; ed.changeViewZones(acc => { for (const id of ids) acc.removeZone(id); }); } padIds[sd] = []; }
    if (!S.wrap || !S.marks) return;
    const lh = R.getOption(monaco.editor.EditorOption.lineHeight);
    const span = (ed, l0, l1) => l1 > l0 ? ed.getBottomForLineNumber(l1) - ed.getTopForLineNumber(l0 + 1) : 0;
    const add = { left: [], right: [] };
    for (const p of S.marks.pieces) {
      if (p.a1 <= p.a0 && p.b1 <= p.b0) continue;
      const lc = p.a1 - p.a0, rc = p.b1 - p.b0, ghost = (p.ghost || []).length * lh;
      // the pads and ghost lines the piece already has count at their own height
      const hl = span(L, p.a0, p.a1) + (p.kind === 'dropped' ? ghost : p.kind !== 'removed' && rc > lc ? (rc - lc) * lh : 0);
      const hr = span(R, p.b0, p.b1) + (p.kind === 'removed' ? ghost : p.kind !== 'dropped' && lc > rc ? (lc - rc) * lh : 0);
      const d = Math.round(hl - hr);
      if (d > 1) add.right.push({ after: p.b1, px: d }); else if (d < -1) add.left.push({ after: p.a1, px: -d });
    }
    for (const sd of ['left', 'right']) {
      const ed = sd === 'left' ? L : R;
      ed.changeViewZones(acc => { padIds[sd] = add[sd].map(z => { const n = document.createElement('div'); n.className = 'zone wrappad'; return acc.addZone({ afterLineNumber: z.after, heightInPx: z.px, domNode: n }); }); });
    }
  }
  function setWrap(on) {
    S.wrap = !!on;
    for (const ed of [L, R, F]) ed.updateOptions({ wordWrap: S.wrap ? 'on' : 'off' });
    keepView();
    setTimeout(() => { if (S.marks) draw(S.marks); }, 30);
  }

  // ---- zoom: both panes, the same size, remembered ----
  function zoom(step) {
    S.zoom = step === 0 ? 0 : Math.max(-6, Math.min(16, (S.zoom || 0) + step));
    for (const ed of [L, R, F]) ed.updateOptions({ fontSize: fontSize() + S.zoom });
    keepView();
    note(S.zoom ? 'Zoom ' + (S.zoom > 0 ? '+' : '') + S.zoom : 'Zoom reset');
    setTimeout(() => { if (S.marks) draw(S.marks); }, 30);
  }
  function keepView() { if (api.setState) api.setState(Object.assign({}, (api.getState && api.getState()) || {}, { zoom: S.zoom || 0, wrap: !!S.wrap, split: S.split || null })); }

  // ---- the divider between the panes: dragged to give one pane more room, remembered ----
  function setSplit(pct) {
    S.split = Math.max(20, Math.min(80, pct));
    const cols = S.split + 'fr 26px ' + (100 - S.split) + 'fr';
    document.querySelector('.panes').style.gridTemplateColumns = cols;
    document.querySelector('.heads').style.gridTemplateColumns = cols;
  }
  function divider() {
    const g = $('gap');
    g.title = 'Drag to resize the panes \u2013 double-click to make them even';
    g.addEventListener('mousedown', e => {
      e.preventDefault();
      const box = document.querySelector('.panes').getBoundingClientRect();
      const move = ev => setSplit(((ev.clientX - box.left) / box.width) * 100);
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); keepView(); setTimeout(() => { if (S.marks) draw(S.marks); }, 30); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    g.addEventListener('dblclick', () => {
      S.split = null;
      document.querySelector('.panes').style.gridTemplateColumns = ''; document.querySelector('.heads').style.gridTemplateColumns = '';
      keepView(); setTimeout(() => { if (S.marks) draw(S.marks); }, 30);
    });
  }

  // ---- tags: the matching tag lit up; typing an opening tag's > closes it ----
  let closing = false;
  function tags() {
    R.onDidChangeModelContent(e => {
      if (closing || e.isUndoing || e.isRedoing || e.changes.length !== 1 || e.changes[0].text !== '>' || !/^(xml|html)$/.test(S.language || 'xml')) return;
      const c = e.changes[0], model = R.getModel(), ln = c.range.startLineNumber, col = c.range.startColumn + 1;
      const text = model.getLineContent(ln), before = text.slice(0, col - 1), after = text.slice(col - 1);
      const m = /<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?>$/.exec(before);
      if (!m || /\/>$/.test(before) || after.startsWith('</' + m[1] + '>')) return;
      closing = true;
      R.executeEdits('cmr.closeTag', [{ range: new monaco.Range(ln, col, ln, col), text: '</' + m[1] + '>' }], [new monaco.Selection(ln, col, ln, col)]);
      closing = false;
    });
    for (const ed of [L, R]) ed.onDidChangeCursorPosition(() => { clearTimeout(ed.__tagT); ed.__tagT = setTimeout(() => matchTag(ed), 120); });
  }
  function matchTag(ed) {
    const model = ed.getModel(), pos = ed.getPosition();
    if (!model || !pos) return;
    const line = model.getLineContent(pos.lineNumber);
    const re = /<(\/?)([A-Za-z_][\w:.-]*)/g;
    let hit = null, t;
    while ((t = re.exec(line))) if (pos.column >= t.index + 1 && pos.column <= t.index + 1 + t[0].length) { hit = t; break; }
    const decos = [];
    if (hit) {
      const text = model.getValue(), name = hit[2], isClose = hit[1] === '/';
      const at = model.getOffsetAt({ lineNumber: pos.lineNumber, column: hit.index + 1 });
      const all = new RegExp('<(/?)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s>/])[^<>]*?(/?)>', 'g');
      const list = []; let x;
      while ((x = all.exec(text))) if (!x[2]) list.push({ at: x.index, close: x[1] === '/' });
      const i = list.findIndex(l => l.at === at);
      let j = -1, depth = 0;
      if (i >= 0 && !isClose) { for (let k = i + 1; k < list.length; k++) { if (!list[k].close) depth++; else if (depth-- === 0) { j = k; break; } } }
      if (i >= 0 && isClose) { for (let k = i - 1; k >= 0; k--) { if (list[k].close) depth++; else if (depth-- === 0) { j = k; break; } } }
      if (i >= 0 && j >= 0) for (const k of [i, j]) {
        const o = list[k].at + 1 + (list[k].close ? 1 : 0), p0 = model.getPositionAt(o), p1 = model.getPositionAt(o + name.length);
        decos.push({ range: new monaco.Range(p0.lineNumber, p0.column, p1.lineNumber, p1.column), options: { inlineClassName: 'tagmatch' } });
      }
    }
    ed.__tag = ed.__tag ? (ed.__tag.set(decos), ed.__tag) : ed.createDecorationsCollection(decos);
  }

  function colours(language, module) {
    const id = 'cmr-' + language;
    require([module], def => {
      if (!monaco.languages.getLanguages().some(l => l.id === id)) {
        monaco.languages.register({ id });
        monaco.languages.setMonarchTokensProvider(id, def.language);
        if (def.conf) monaco.languages.setLanguageConfiguration(id, def.conf);
      }
      for (const ed of [L, R, F]) if (ed.getModel()) monaco.editor.setModelLanguage(ed.getModel(), id);
    });
  }

  // ---- \u22ef \u203a Format XML: as Format Document does it, in one step Ctrl+Z undoes ----
  // every conflict at once, from the bottom up so each one's place still holds: one step, then each empty version remembered
  function acceptAll(choice) {
    const model = R.getModel(), rows = (S.marks.rows || []).slice().sort((a, b) => b.b0 - a.b0);
    const lineAt = n => n < model.getLineCount() ? model.getOffsetAt({ lineNumber: n + 1, column: 1 }) : model.getValueLength();
    const edits = rows.map(r => r.actions.find(a => a.choice === choice)).filter(Boolean).map(a => a.op)
      .map(o => ({ range: monaco.Range.fromPositions(model.getPositionAt(lineAt(o.b0)), model.getPositionAt(lineAt(o.b1))), text: o.insert }));
    R.pushUndoStop(); model.pushEditOperations(R.getSelections(), edits, () => null); R.pushUndoStop(); R.focus();
    for (const r of rows) { const a = r.actions.find(x => x.choice === choice); if (a && !a.op.insert) { S.seq++; api.postMessage({ type: 'review', regions: regionsNow(), id: r.id, choice, seq: S.seq, text: R.getValue() }); } }
  }
  function formatNow(side) { const ed = side === 'left' ? L : R; S.seq++; api.postMessage({ type: 'format', side: side || 'right', seq: S.seq, text: ed.getValue() }); }
  function dedupeNow(side) { const ed = side === 'left' ? L : R; S.seq++; api.postMessage({ type: 'dedupe', side: side || 'right', seq: S.seq, text: ed.getValue() }); }
  function formatted(m) {
    const ed = m.side === 'left' ? L : R;
    if (m.error) return note(m.error, true);
    if (m.text == null) return note(m.note || 'Nothing to do.');
    if (m.text === ed.getValue()) return note(m.note || 'Already formatted.');
    const model = ed.getModel();
    ed.pushUndoStop(); model.pushEditOperations(ed.getSelections(), [{ range: model.getFullModelRange(), text: m.text }], () => null); ed.pushUndoStop();
    // back in the editor: Ctrl+Z undoes it straight away
    ed.focus();
    note(m.note || 'Formatted \u2013 Ctrl+Z undoes it.');
  }

  function stops() {
    if (!S.marks) return [];
    // code: once per member, in one panel or two
    const s = S.marks.code && !S.marks.plain ? S.marks.rows.map(r => r.at) : S.marks.pieces.filter(p => p.kind !== 'same' && p.kind !== 'position' && p.kind !== 'blank').map(p => p.b0)
      .concat(S.conflicts.map(c => c.line));
    return [...new Set(s)].sort((a, b) => a - b);
  }
  // the cursor on the first change - so folding starts from there, not from line 1
  function toFirstChange() {
    const list = stops();
    const here = R.getPosition() ? R.getPosition().lineNumber - 1 : 0;
    if (!list.length || list.some(l => Math.abs(l - here) <= CONTEXT)) return;
    const line = Math.min(list[0] + 1, R.getModel().getLineCount());
    R.setPosition({ lineNumber: line, column: 1 });
    R.revealLineInCenter(line);
  }
  function go(dir) {
    const list = stops();
    if (!list.length) return;
    const here = R.getPosition().lineNumber - 1;
    const next = dir > 0 ? list.find(l => l > here) : [...list].reverse().find(l => l < here);
    const line = (next != null ? next : dir > 0 ? list[0] : list[list.length - 1]) + 1;
    R.revealLineInCenter(Math.min(line, R.getModel().getLineCount()));
    R.setPosition({ lineNumber: Math.min(line, R.getModel().getLineCount()), column: 1 });
    R.focus();
  }

  // a promotion's merge saves as your resolution; a plain merge is applied into the target file, once, as before
  // a promotion's merge saves as your resolution (Ctrl+S) or saves and closes; a branch's is applied into the file,
  // once; a comparison saves nothing - it merges nothing
  function save(close) {
    if (S.plain) return;
    if (S.applyOnly && !close) return note('Apply and close writes it into ' + S.file + ' \u2013 nothing is written before that.', true);
    api.postMessage({ type: 'save', close: !!close, text: R.getValue(), regions: regionsNow() });
  }
  function note(text, warn) {
    if (!warn || !text) return;
    const n = $('note'); n.textContent = text; n.className = 'warn show';
    clearTimeout(note.t); note.t = setTimeout(() => { n.className = 'warn'; }, 6000);
  }

  // ---- the status bar: saved or not, the marks live or paused, duplicates ----
  function status() {
    const saved = $('stSaved');
    if (S.plain) saved.textContent = '';
    else if (S.applyOnly) saved.textContent = 'Not applied yet';
    else saved.innerHTML = S.unsaved ? '<span class="dirty">\u25cf Not saved</span>' : '\u2713 Saved as your resolution';
    $('stMarks').innerHTML = S.held
      ? '<span class="paused">\u25cb Marks paused \u2013 not valid XML' + (S.xml ? ' at line ' + S.xml.line : '') + '</span>'
      : '<span class="ok">\u25cf Marks live</span>' + (S.marks && S.marks.git && S.marks.counts.needs
        ? ' <span class="warnt">\u25cf ' + S.marks.counts.needs + ' conflict' + (S.marks.counts.needs === 1 ? '' : 's') + ' to resolve</span>' : '');
    const removed = S.dupRemoved && S.startNow ? S.dupRemoved[S.startNow] || 0 : 0;
    $('stDups').innerHTML = (removed ? '<span class="dupt">' + removed + ' duplicate' + (removed === 1 ? '' : 's') + ' removed when the merge was prepared</span>' : '') +
      (S.dups.length ? '<span class="warnt">\u26a0 ' + S.dups.length + ' duplicate' + (S.dups.length === 1 ? '' : 's') + '</span>' : '') +
      ((S.problems || []).length ? '<span class="' + (S.problems.some(q => q.severity === 'error') ? 'paused' : 'warnt') + '">\u26a0 ' + S.problems.length + ' problem' + (S.problems.length === 1 ? '' : 's') + ' \u2013 ' + esc(S.problems[0].message) + '</span>' : '');
  }

  // ---- where the cursor is among the changes: "2 of 7" between the arrows ----
  function where() {
    const list = stops(), el = $('pos');
    if (!list.length) { el.textContent = 'No changes'; return; }
    const here = R.getPosition() ? R.getPosition().lineNumber - 1 : 0;
    const i = list.filter(l => l <= here).length;
    el.textContent = Math.max(1, i) + ' of ' + list.length;
  }

  // ---- F8: the next problem - a duplicate, or where the XML stops being valid ----
  function nextProblem(dir) {
    const list = S.dups.map(d => d.b0).concat(S.xml ? [S.xml.line - 1] : []).concat((S.problems || []).map(q => q.line - 1)).sort((a, b) => a - b);
    if (!list.length) return note('No problems.');
    const here = R.getPosition().lineNumber - 1;
    const to = dir > 0 ? (list.find(l => l > here) ?? list[0]) : ([...list].reverse().find(l => l < here) ?? list[list.length - 1]);
    R.revealLineInCenter(to + 1); R.setPosition({ lineNumber: to + 1, column: 1 }); R.focus();
  }

  // ---- while the XML is not valid: where it breaks underlined, and what you type kept in view ----
  function held(xml) {
    S.held = true; S.xml = xml || null;
    const model = R.getModel();
    monaco.editor.setModelMarkers(model, 'cmr-xml', xml ? [{ severity: monaco.MarkerSeverity.Error, message: xml.message, startLineNumber: xml.line, startColumn: xml.column,
      endLineNumber: xml.line, endColumn: Math.max(xml.column + 1, model.getLineMaxColumn(Math.min(xml.line, model.getLineCount()))) }] : []);
    showTyped();
    status();
  }
  // the lines you changed since the marks were last good - shown dotted only while the XML is not valid,
  // so the keystroke that broke it is among them
  function typedSince(changes) {
    for (const c of changes) for (let l = c.range.startLineNumber; l <= c.range.startLineNumber + (c.text.match(/\n/g) || []).length; l++) S.typed.add(l);
    if (S.held) showTyped();
  }
  function showTyped() {
    const ds = [...S.typed].map(l => ({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, linesDecorationsClassName: 'typed-g' } }));
    S.deco.typed = S.deco.typed ? (S.deco.typed.set(ds), S.deco.typed) : R.createDecorationsCollection(ds);
  }

  // ---- messages from the extension ----
  window.addEventListener('message', e => {
    const m = e.data || {};
    if (m.type === 'init') {
      S.labels = m.labels; S.theirs = m.theirs; S.short = m.short; S.conflicts = m.conflicts || [];
      S.hide = !!m.hideIdentical;
      S.saved = m.savedText != null ? m.savedText : null;
      S.applyOnly = !!m.applyOnly; S.file = m.file; S.manual = !!m.manual; S.dupRemoved = m.dupRemoved || null;
      S.plain = !!m.plain; S.tidy = !!m.tidy; S.gitLabels = m.gitLabels || null; S.unionKind = m.unionKind || null;
      if (S.plain) {
        // both sides yours: editable, formatted, de-duplicated, saved each as a file
        L.updateOptions({ readOnly: false, domReadOnly: false });
        $('lefthead').innerHTML = '<b>' + esc(m.labels.target || 'Left') + '</b> \u00b7 <span class="ok">editable</span>';
        S.headRight = '';
        $('saveClose').hidden = true;
      }
      else if (S.applyOnly) { $('saveClose').innerHTML = ICON.check + '<span>Apply &amp; Close</span>'; $('saveClose').title = 'Write it into ' + m.file + ' and close'; }
      $('title').textContent = m.title;
      S.startNow = m.start || null;   // where it started - for what was taken out when it was prepared
      // code: one pane - your resolution, every change marked in it
      document.body.classList.toggle('single', !!(m.marks && m.marks.single));
      $('righthead').innerHTML = S.plain ? '<b>' + esc(m.labels.incoming || m.labels.merged || 'Right') + '</b> \u00b7 <span class="ok">editable</span>' + (S.headRight || '')
        : '<b>' + esc(m.labels.merged || 'Your resolution') + '</b> \u00b7 ' + (m.marks && m.marks.git ? 'Copado\u2019s conflict file \u2013 git merged the rest \u00b7 ' : '') + '<span class="ok">editable</span>';
      S.language = m.language || 'xml';
      // JavaScript, HTML and CSS: Monaco's colours without its language services (they need a worker, and there is none here)
      const own = { javascript: 'vs/javascript-B_IYblwB', html: 'vs/html-BTio3wpy', css: 'vs/css-CaeNmE3S' }[S.language];
      const lang = own ? 'plaintext' : S.language;
      // each conflict's two versions come once, here; every row after refers to them
      S.versions = m.versions || null;
      hydrate(m.marks);
      L.setModel(monaco.editor.createModel(m.marks.single ? m.text : m.marks.left, lang));
      R.setModel(monaco.editor.createModel(m.text, lang));
      if (own) colours(S.language, own);
      if (S.hide) { S.marks = m.marks; toFirstChange(); }
      trackFrom(m.marks);
      draw(m.marks);
      dirty();
      R.focus();
      if (m.reveal != null) reveal(m.reveal);
    } else if (m.type === 'marks') {
      if (m.seq !== S.seq) return;                       // you have typed since: the newer answer is on its way
      if (m.conflicts) S.conflicts = m.conflicts;
      if (m.hold) return held(m.xmlError);
      S.held = false; S.xml = null;
      hydrate(m.marks);
      // a comparison's other side is yours: never written over by the marks - and a side not sent is the one held
      if (!S.plain && m.marks.left != null && L.getValue() !== m.marks.left) { const top = R.getScrollTop(); L.getModel().setValue(m.marks.left); L.setScrollTop(top); }
      trackFrom(m.marks);
      draw(m.marks);
    } else if (m.type === 'formatted') { formatted(m);
    } else if (m.type === 'saved') {
      // what was saved, shown: the conflicts left kept as the target's - one step Ctrl+Z undoes
      if (m.ok && m.text != null && m.text !== R.getValue()) { const md = R.getModel(); R.pushUndoStop(); md.pushEditOperations([], [{ range: md.getFullModelRange(), text: m.text }], () => null); R.pushUndoStop(); S.track = null; S.seq++; api.postMessage({ type: 'text', seq: S.seq, text: R.getValue(), regions: null }); }
      if (m.ok) { S.saved = m.text; dirty(); }
      note(m.message, !m.ok || m.warn);
    } else if (m.type === 'pasted') pasted(m);
    else if (m.type === 'reveal') reveal(m.line);
    else if (m.type === 'apply') act(m.undo);
  });

  // ---- the toolbar's two menus: View, and the rest ----
  function menuOf(id, items) {
    const m = $(id);
    m.innerHTML = items.map((it, i) => !it ? '<div class="sep"></div>' : it.head ? '<div class="mh">' + esc(it.head) + '</div>'
      : '<div class="mi' + (it.bad ? ' bad' : '') + '" role="menuitem' + (it.check != null ? 'checkbox" aria-checked="' + !!it.check : '') + '" data-i="' + i + '"><span class="rk">' + (it.check || it.radio ? '\u2713' : '') + '</span>' + esc(it.label) + '</div>').join('');
    m.onmousedown = e => e.preventDefault();
    m.onclick = e => { const d = e.target.closest('.mi'); if (!d) return; closeMenus(); items[+d.dataset.i].run(); };
  }
  function viewItems() {
    // code: one panel or two - remembered, it is the setting cmr.merge.codeView
    const view = S.marks && S.marks.single ? 'onePane' : S.marks && S.marks.three ? 'threePanes' : 'twoPanes';
    const switchView = v => () => { if (v === view) return; S.seq++; api.postMessage({ type: 'codeView', view: v, seq: S.seq, text: R.getValue(), regions: regionsNow() }); };
    const layout = S.marks && S.marks.git ? [{ head: 'Layout' }, { label: 'One panel', radio: view === 'onePane', run: switchView('onePane') }, { label: 'Two panel', radio: view === 'twoPanes', run: switchView('twoPanes') }, { label: 'Three panel', radio: view === 'threePanes', run: switchView('threePanes') }, null] : [];
    // one start: Copado's conflict file - nothing to choose
    return layout
      .concat([{ label: 'Word wrap', check: S.wrap, run: () => setWrap(!S.wrap) }, { label: 'Zoom in', run: () => zoom(1) }, { label: 'Zoom out', run: () => zoom(-1) }, { label: 'Reset zoom', run: () => zoom(0) }, null])
      .concat([{ label: 'Hide identical lines', check: S.hide, run: () => {
        S.hide = !S.hide; S.expanded = [];
        if (S.hide) toFirstChange();
        if (S.marks) draw(S.marks);
        api.postMessage({ type: 'pref', hideIdentical: S.hide });
      } }]);
  }
  function moreItems() {
    // a promotion's code: every conflict at once - one step, Ctrl+Z undoes it
    // a permission set or profile that did not join: never the feature's for all - the target's access would go
    return (S.marks && S.marks.git && S.marks.rows.length ? [{ label: 'Accept all target', run: () => acceptAll('target') }].concat(S.unionKind === 'fallback' ? [] : [{ label: 'Accept all feature', run: () => acceptAll('feature') }]).concat([null]) : [])
      .concat([{ label: 'Save diagnostics\u2026', run: () => api.postMessage({ type: 'diagnostics', text: R.getValue() }) }]).concat([{ label: 'Keyboard shortcuts', run: () => { $('help').hidden = false; } }])
      .concat([{ label: 'Copy merge report', run: () => api.postMessage({ type: 'report' }) }, null, { label: 'Discard this merge\u2026', bad: true, run: () => api.postMessage({ type: 'discard' }) }]);
  }
  function closeMenus() { for (const id of ['viewMenu', 'moreMenu']) $(id).hidden = true; $('viewBtn').setAttribute('aria-expanded', 'false'); $('moreBtn').setAttribute('aria-expanded', 'false'); }
  function toggleMenu(id, btn, items) {
    const was = !$(id).hidden;
    closeMenus();
    if (was) return;
    menuOf(id, items());
    $(id).hidden = false;
    $(btn).setAttribute('aria-expanded', 'true');
  }
  function reveal(line) { R.revealLineInCenter(line + 1); R.setPosition({ lineNumber: line + 1, column: 1 }); R.focus(); }

  // ---- the toolbar ----
  $('saveClose').addEventListener('click', () => save(true));
  $('viewBtn').addEventListener('click', () => toggleMenu('viewMenu', 'viewBtn', viewItems));
  $('moreBtn').addEventListener('click', () => toggleMenu('moreMenu', 'moreBtn', moreItems));
  document.addEventListener('mousedown', e => { if (!e.target.closest('.mwrap')) closeMenus(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); }, true);
  $('next').addEventListener('click', () => go(1));
  $('prev').addEventListener('click', () => go(-1));
  $('prev').innerHTML = ICON.up; $('next').innerHTML = ICON.down; $('moreBtn').innerHTML = ICON.more;
  $('viewBtn').innerHTML = ICON.eye + '<span>View</span>' + ICON.chev;
  const saveLabel = t => { $('saveClose').innerHTML = ICON.check + '<span>' + esc(t) + '</span>'; };
  saveLabel('Save & Close');
  // the shortcuts: VS Code's own, with Cmd in place of Ctrl on a Mac
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const k = t => t.replace(/Ctrl/g, mac ? '\u2318' : 'Ctrl').replace(/Alt/g, mac ? '\u2325' : 'Alt').split(' / ').map(x => x.split('+').map(y => '<kbd>' + y + '</kbd>').join('+')).join(' / ');
  $('help').innerHTML = '<table>' + [
    ['Cut, copy, paste', 'Ctrl+X / Ctrl+C / Ctrl+V'], ['Select all', 'Ctrl+A'], ['Undo, redo', 'Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z'],
    ['Find, replace', 'Ctrl+F / Ctrl+H'], ['Go to line', 'Ctrl+G'], ['Move a line', 'Alt+\u2191 / Alt+\u2193'], ['Copy a line', 'Shift+Alt+\u2191 / Shift+Alt+\u2193'],
    ['Delete a line', 'Ctrl+Shift+K'], ['Comment out', 'Ctrl+/'], ['Indent, outdent', 'Tab / Shift+Tab'], ['Select the next match', 'Ctrl+D'],
    ['Another cursor', 'Alt+click'], ['Next, previous change', 'F7 / Shift+F7'], ['Next, previous problem', 'F8 / Shift+F8'], ['Fold, unfold an element', 'Ctrl+Shift+[ / ]'], ['Word wrap', 'Alt+Z'], ['Zoom in, out, reset', 'Ctrl+= / Ctrl+- / Ctrl+0'], ['Save', 'Ctrl+S']
  ].map(r => '<tr><td>' + r[0] + '</td><td>' + k(r[1]) + '</td></tr>').join('') + '</table>';
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('help').hidden) $('help').hidden = true; });
  document.addEventListener('mousedown', e => { if (!$('help').hidden && !e.target.closest('#help')) $('help').hidden = true; }, true);

  // ---- Monaco ----
  require.config({ paths: { vs: document.body.dataset.vs } });
  require(['vs/editor/editor.main'], function () {
    monaco = window.monaco;
    // set after Monaco's own setup, which installs one: no background worker - the work it needs runs on this page
    self.MonacoEnvironment = { getWorker: () => { throw new Error('the merge editor runs without a background worker'); } };
    theme();
    editors();
    api.postMessage({ type: 'ready' });
  });
})();
