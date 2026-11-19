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
  let L, R, monaco;

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
    if (view.split) setSplit(view.split);
    divider(); watchFolds(); tags(); quietFindWidget();
    // a comparison: what you do to the other side is compared again too
    L.onDidChangeModelContent(() => { if (!S.plain || S.settingLeft) return; clearTimeout(S.leftT); S.leftT = setTimeout(() => { S.seq++; api.postMessage({ type: 'text', side: 'left', seq: S.seq, text: L.getValue() }); }, 250); });
    // both panes scroll together - they are lined up, so the same height is the same place
    let syncing = false;
    const sync = (from, to) => from.onDidScrollChange(e => {
      if (syncing || (!e.scrollTopChanged && !e.scrollLeftChanged)) return;
      syncing = true;
      if (e.scrollTopChanged) to.setScrollTop(e.scrollTop);
      if (e.scrollLeftChanged) to.setScrollLeft(e.scrollLeft);
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
    timer = setTimeout(() => { S.seq++; api.postMessage({ type: 'text', seq: S.seq, text: R.getValue() }); }, 250);
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
  // a conflict's row: the version accepted shown as chosen; nothing chosen yet, said
  function markChoice(it, r) {
    if (!it) return;
    const pick = { target: 0, feature: 1, both: 2 }[r.chosen];
    it.buttons.forEach((b, i) => { if (i === pick) b[3] = (b[3] || '') + ' on'; });
  }
  function altNode(title, lines) {
    const d = document.createElement('div');
    d.className = 'zone alt';
    // one line of the editor per line - the zone is that many lines high
    const lh = R.getOption(monaco.editor.EditorOption.lineHeight);
    d.style.fontFamily = fontFamily(); d.style.fontSize = fontSize() + 'px'; d.style.lineHeight = lh + 'px'; d.style.setProperty('--lh', lh + 'px');
    d.className += title === 'Target' ? ' tgt' : title === 'Feature' ? ' fea' : '';
    d.innerHTML = '<div class="alt-t">\u25be <b>' + esc(title) + '</b></div>' +
      lines.map(l => '<div class="alt-l">' + (esc(l.replace(/\r?\n$/, '')) || '&nbsp;') + '</div>').join('');
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
    dupRemoved: ['dupr', 'Duplicate removed', [['\u21b6', 'Put it back']]],
    // with the common ancestor: what the feature branch itself did
    byFeature: ['rem', 'Removed by the ' + side(), [['\u21b6', 'Restore']]],
    keptRemoved: ['keep', 'Kept \u00b7 removed by the ' + side(), [['\u2715', 'Remove']]],
    changedBy: ['keep', cap(side()) + ' changed it', [['\u21c4', 'Use ' + side()]]], dropped: ['rem', 'Left out', [['\u21b6', 'Add it back']]],
    kept: ['keep', 'Kept \u00b7 not in ' + side(), [['\u2715', 'Remove']]], differs: ['keep', cap(side()) + ' differs', [['\u21c4', 'Use ' + side()]]],
 // a value both branches changed: the same words as code's conflicts - counted until one is accepted
    conf: ['conf', 'Conflict', [['\u21b6', 'Accept target'], ['\u21c4', 'Accept feature']]],
    dup: ['dup', 'Duplicate', [['\u2715', 'Remove copy']]],
    // a promotion's code: a conflict git left - neither version in until one is accepted
    conflict: ['conf', 'Conflict', [['\u21b6', 'Accept target'], ['\u21c4', 'Accept feature'], ['\u2261', 'Accept both']]],
    resolved: ['res', 'Resolved', [['\u21b6', 'Accept target'], ['\u21c4', 'Accept feature'], ['\u2261', 'Accept both']]],
    // a comparison: what differs, said - nothing to move across
    plainDiff: ['mv', 'Differs', []],
    plainRight: ['mv', 'Only here', []],
    plainLeft: ['mv', 'Not here', []],
    // a flow element only dragged in Flow Builder: shown, quietly - F7 passes it by
    position: ['pos', 'Moved on the canvas', [['\u21b6', 'Use target']]]
  })[k];
  const rowNode = (cls, word) => zoneNode('head ' + cls, '<span class="dotk"></span><b>' + esc(word) + '</b>');

  function draw(m) {
    S.marks = m;
    document.body.classList.toggle('single', !!m.single);
    const lh = R.getOption(monaco.editor.EditorOption.lineHeight);
    const HEAD = Math.max(22, lh + 3), FOLD = lh + 4;
    const items = { left: [], right: [] };
    // a zone: lines, or a header row's pixels; buttons over it, or the whole of it a click
    const zone = (sd, after, lines, node, buttons, opts) => items[sd].push(Object.assign({ after, lines, node, buttons }, opts || {}));
    // a change's row on both sides: the word on your side, a wordless row on the target's, the same height
    const rowsAt = new Map();
    const row = (key, after, leftAfter, undos, word) => {
      const [cls, w, btns] = ROW(key);
      const buttons = btns.map((b, i) => [b[0], b[1], undos[i]]).filter(b => b[2]);
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
    const ld = [], rd = [];
    const whole = (arr, l0, l1, cls, ruler, glyph) => { if (l1 > l0) arr.push({ range: new monaco.Range(l0 + 1, 1, l1, 1), options: { isWholeLine: true, className: cls, linesDecorationsClassName: cls + '-g', glyphMarginClassName: glyph || undefined, overviewRuler: ruler ? { color: ruler, position: monaco.editor.OverviewRulerLane.Full } : undefined } }); };
    const ORANGE = 'rgba(232,145,45,.9)', RED = 'rgba(241,76,76,.7)', GREEN = 'rgba(137,209,133,.8)', BLUE = 'rgba(55,148,255,.8)', PURPLE = 'rgba(177,128,215,.9)', YELLOW = 'rgba(204,167,0,.9)';

    // a right-hand line's place on the left: line for line inside an unchanged piece, the piece's start otherwise
    const holding = b => m.pieces.find(p => p.b0 <= b && b < p.b1);
    const leftOf = b => { const p = holding(b); return p ? (p.kind === 'same' ? p.a0 + (b - p.b0) : p.a0) : (m.pieces.length ? m.pieces[m.pieces.length - 1].a1 : 0); };
    // code, one pane: each row - its words, its buttons, the other version's or the old lines under it, its lines lit
    if (m.single) for (const r of m.rows) {
      const done = !r.needs;
      const it = row(done ? 'resolved' : 'conflict', r.at, r.at, r.actions.map(a => Object.assign([a.op], { review: r.id, choice: a.choice })), null);
      markChoice(it, r);
      for (const g of r.ghosts) g.cls === 'struck' ? zone('right', g.at, g.lines.length, ghostNode(g.lines, 'dropped')) : zone('right', g.at, g.lines.length + 1, altNode(g.title, g.lines));
      for (const [h0, h1] of r.hl) whole(rd, h0, h1, done ? 'res' : 'conf', done ? GREEN : YELLOW);
    }
    const conflictRows = !m.single && m.code && !m.plain ? (m.rows || []) : [];
    // a line under a choice's row is the choice's - and a member left out is its row, not a removal as well
    const underConflict = p => conflictRows.some(r => (p.b0 < r.b1 && r.b0 < Math.max(p.b1, p.b0 + 1)) || (r.b0 === r.b1 && p.b1 === p.b0 && p.b0 === r.b0));
    for (const r of conflictRows) {
      const done = !r.needs;
      const it = row(done ? 'resolved' : 'conflict', r.at, leftOf(r.at), r.actions.map(a => Object.assign([a.op], { review: r.id, choice: a.choice })), null);
      markChoice(it, r);
      const h = r.ghosts.reduce((n, g) => n + g.lines.length + (g.cls === 'struck' ? 0 : 1), 0);
      for (const g of r.ghosts) g.cls === 'struck' ? zone('right', g.at, g.lines.length, ghostNode(g.lines, 'dropped')) : zone('right', g.at, g.lines.length + 1, altNode(g.title, g.lines));
      if (h) zone('left', leftOf(r.at), h, zoneNode('pad'));
      for (const [h0, h1] of r.hl) whole(rd, h0, h1, done ? 'res' : 'conf', done ? GREEN : YELLOW);
    }
    for (const p of (m.single ? [] : m.pieces)) {
      if (p.kind === 'same') continue;
      // under a conflict's row - or a promotion's code, where only conflicts are marked: colours, no row
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
    S.hiddenRuns = S.hide ? identicalRuns(m) : [];
    for (const run of S.hiddenRuns) {
      const n = run.b1 - run.b0, text = n + ' hidden line' + (n === 1 ? '' : 's');
      const open = () => { S.expanded.push([run.b0, run.b1]); draw(S.marks); };
      // after the run's last line: Monaco hides a row whose next line is hidden
      for (const [sd, after] of [['right', run.b1], ['left', run.a1]]) {
        const margin = document.createElement('div');
        margin.className = 'fold-m';
        // Monaco's margin zones have no width of their own: the icon is placed in pixels, under the line numbers
        const li = (sd === 'left' ? L : R).getLayoutInfo();
        // Monaco sizes a margin zone itself: the icon is placed inside it, exactly over the line-number column
        margin.innerHTML = '<span class="fx" style="left:' + li.lineNumbersLeft + 'px;width:' + li.lineNumbersWidth + 'px;height:' + FOLD + 'px">' + ICON.expand + '</span>';
        zone(sd, after, 0, zoneNode('fold', '<span class="ft">' + esc(text) + '</span><span class="rule"></span>'), null, { click: open, title: 'Show these ' + n + ' lines', px: FOLD, margin });
      }
    }
    applyHidden();

    // the zones: replaced as a whole, in order, the same rows on both sides
    for (const sd of ['left', 'right']) {
      const ed = sd === 'left' ? L : R;
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
      });
    }
    S.deco.left = S.deco.left ? (S.deco.left.set(ld), S.deco.left) : L.createDecorationsCollection(ld);
    S.deco.right = S.deco.right ? (S.deco.right.set(rd), S.deco.right) : R.createDecorationsCollection(rd);
    summary(m);
    where();
    balance();
    // the expand icon sits where the line numbers are, in each pane
    for (const ed of [L, R]) { const li = ed.getLayoutInfo(); const st = ed.getContainerDomNode().style; st.setProperty('--fold-w', li.contentLeft + 'px'); st.setProperty('--fold-pr', Math.max(0, li.contentLeft - (li.lineNumbersLeft + li.lineNumbersWidth)) + 'px'); }
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
    return runs;
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
        if (now.length !== o.expect.length || now.some((l, i) => l !== o.expect[i])) return note('Those lines have changed since they were marked - nothing was done.', true);
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
    if (undo && undo.review && undo.every(o => !o.insert)) { S.seq++; api.postMessage({ type: 'review', id: undo.review, choice: undo.choice, seq: S.seq, text: R.getValue() }); }
  }

  // ---- next and previous change ----
  // ---- what is hidden: the identical runs, and on the target's side what you folded in yours ----
  const leftLine = b => { const m = S.marks; if (!m) return b; const p = m.pieces.find(q => q.b0 <= b && b < q.b1); return p ? (p.kind === 'same' ? p.a0 + (b - p.b0) : p.a0) : b; };
  function applyHidden() {
    const runs = S.hiddenRuns || [];
    const mirror = (S.folds || []).map(([f0, f1]) => { const a0 = leftLine(f0), a1 = leftLine(f1 - 1) + 1; return a1 > a0 + 1 ? new monaco.Range(a0 + 2, 1, a1, 1) : null; }).filter(Boolean);
    L.setHiddenAreas(runs.map(r => new monaco.Range(r.a0 + 1, 1, r.a1, 1)).concat(mirror));
    R.setHiddenAreas(runs.map(r => new monaco.Range(r.b0 + 1, 1, r.b1, 1)));
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
    for (const ed of [L, R]) ed.updateOptions({ wordWrap: S.wrap ? 'on' : 'off' });
    keepView();
    setTimeout(() => { if (S.marks) draw(S.marks); }, 30);
  }

  // ---- zoom: both panes, the same size, remembered ----
  function zoom(step) {
    S.zoom = step === 0 ? 0 : Math.max(-6, Math.min(16, (S.zoom || 0) + step));
    for (const ed of [L, R]) ed.updateOptions({ fontSize: fontSize() + S.zoom });
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
      for (const ed of [L, R]) if (ed.getModel()) monaco.editor.setModelLanguage(ed.getModel(), id);
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
    for (const r of rows) { const a = r.actions.find(x => x.choice === choice); if (a && !a.op.insert) { S.seq++; api.postMessage({ type: 'review', id: r.id, choice, seq: S.seq, text: R.getValue() }); } }
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
  // a promotion's merge saves as your resolution (Ctrl+S) or saves and closes; one from the Manual tab is
  // copied, or saved as a file from the \u22ef menu; a branch's is applied into the file, once
  function save(close) {
    if (S.manual) return api.postMessage({ type: 'copyResult', text: R.getValue() });
    if (S.applyOnly && !close) return note('Apply and close writes it into ' + S.file + ' \u2013 nothing is written before that.', true);
    api.postMessage({ type: 'save', close: !!close, text: R.getValue() });
  }
  function note(text, warn) {
    if (!warn || !text) return;
    const n = $('note'); n.textContent = text; n.className = 'warn show';
    clearTimeout(note.t); note.t = setTimeout(() => { n.className = 'warn'; }, 6000);
  }

  // ---- the status bar: saved or not, the marks live or paused, duplicates ----
  function status() {
    const saved = $('stSaved');
    if (S.manual) saved.textContent = '';
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
      S.plain = !!m.plain; S.tidy = !!m.tidy;
      if (S.plain) {
        // both sides yours: editable, formatted, de-duplicated, saved each as a file
        L.updateOptions({ readOnly: false, domReadOnly: false });
        $('lefthead').innerHTML = '<b>' + esc(m.labels.target || 'Left') + '</b> \u00b7 <span class="ok">editable</span>';
        S.headRight = '';
        $('saveClose').hidden = true;
      }
      else if (S.manual) { $('saveClose').innerHTML = ICON.check + '<span>Copy result</span>'; $('saveClose').title = 'Copy the result, to paste into Copado (Ctrl+S) \u2013 or \u22ef \u203a Save as file\u2026'; }
      else if (S.applyOnly) { $('saveClose').innerHTML = ICON.check + '<span>Apply &amp; Close</span>'; $('saveClose').title = 'Write it into ' + m.file + ' and close'; }
      $('title').textContent = m.title;
      starts(m);
      // code: one pane - your resolution, every change marked in it
      document.body.classList.toggle('single', !!(m.marks && m.marks.single));
      $('righthead').innerHTML = S.plain ? '<b>' + esc(m.labels.incoming || m.labels.merged || 'Right') + '</b> \u00b7 <span class="ok">editable</span>' + (S.headRight || '')
        : '<b>' + esc(m.labels.merged || 'Your resolution') + '</b> \u00b7 ' + (m.marks && m.marks.git ? 'Copado\u2019s conflict file \u2013 git merged the rest \u00b7 ' : '') + '<span class="ok">editable</span>';
      S.language = m.language || 'xml';
      // JavaScript, HTML and CSS: Monaco's colours without its language services (they need a worker, and there is none here)
      const own = { javascript: 'vs/javascript-B_IYblwB', html: 'vs/html-BTio3wpy', css: 'vs/css-CaeNmE3S' }[S.language];
      const lang = own ? 'plaintext' : S.language;
      L.setModel(monaco.editor.createModel(m.marks.single ? m.text : m.marks.left, lang));
      R.setModel(monaco.editor.createModel(m.text, lang));
      if (own) colours(S.language, own);
      if (S.hide) { S.marks = m.marks; toFirstChange(); }
      draw(m.marks);
      dirty();
      R.focus();
      if (m.reveal != null) reveal(m.reveal);
    } else if (m.type === 'marks') {
      if (m.seq !== S.seq) return;                       // you have typed since: the newer answer is on its way
      if (m.conflicts) S.conflicts = m.conflicts;
      if (m.hold) return held(m.xmlError);
      S.held = false; S.xml = null;
      // a comparison's other side is yours: never written over by the marks
      if (!S.plain && L.getValue() !== m.marks.left) { const top = R.getScrollTop(); L.getModel().setValue(m.marks.left); L.setScrollTop(top); }
      draw(m.marks);
    } else if (m.type === 'formatted') { formatted(m);
    } else if (m.type === 'saved') {
      if (m.ok) { S.saved = m.text; dirty(); }
      note(m.message, !m.ok || m.warn);
    } else if (m.type === 'pasted') pasted(m);
    else if (m.type === 'reveal') reveal(m.line);
    else if (m.type === 'apply') act(m.undo);
  });
  const START_NAMES = () => ({ saved: 'Your saved resolution', feature: cap(S.theirs || 'the incoming file'), target: S.labels.target || 'The target', merged: 'Merged (both)' });
  function starts(m) {
    S.starts = m.starts || {};
    if (m.savedText != null) S.starts.saved = m.savedText;
    const order = ['saved', 'feature', 'target', 'merged'].filter(k => S.starts[k] != null);
    S.startOrder = order;
    S.startNow = m.start && S.starts[m.start] != null ? m.start : order[0] || null;
  }
  // a start, in one step that Ctrl+Z undoes
  function startFrom(k) {
    const text = S.starts[k];
    if (text == null || k === S.startNow) return;
    const model = R.getModel();
    R.pushUndoStop();
    model.pushEditOperations(R.getSelections(), [{ range: model.getFullModelRange(), text }], () => null);
    R.pushUndoStop();
    note('Started again from ' + START_NAMES()[k].replace(/^The /, 'the ') + ' \u2013 Ctrl+Z goes back to what you had.');
    S.startNow = k;
    status();
    R.focus();
  }

  // ---- the toolbar's two menus: View, and the rest ----
  function menuOf(id, items) {
    const m = $(id);
    m.innerHTML = items.map((it, i) => !it ? '<div class="sep"></div>' : it.head ? '<div class="mh">' + esc(it.head) + '</div>'
      : '<div class="mi' + (it.bad ? ' bad' : '') + '" role="menuitem' + (it.check != null ? 'checkbox" aria-checked="' + !!it.check : '') + '" data-i="' + i + '"><span class="rk">' + (it.check || it.radio ? '\u2713' : '') + '</span>' + esc(it.label) + '</div>').join('');
    m.onmousedown = e => e.preventDefault();
    m.onclick = e => { const d = e.target.closest('.mi'); if (!d) return; closeMenus(); items[+d.dataset.i].run(); };
  }
  function viewItems() {
    const names = START_NAMES();
    // code: one panel or two - remembered, it is the setting cmr.merge.codeView
    const view = S.marks && S.marks.single ? 'onePane' : 'twoPanes';
    const switchView = v => () => { if (v === view) return; S.seq++; api.postMessage({ type: 'codeView', view: v, seq: S.seq, text: R.getValue() }); };
    const layout = S.language && S.language !== 'xml' && !S.plain ? [{ head: 'Layout' }, { label: 'One panel', radio: view === 'onePane', run: switchView('onePane') }, { label: 'Two panel', radio: view === 'twoPanes', run: switchView('twoPanes') }, null] : [];
    return layout.concat(!S.plain && S.startOrder && S.startOrder.length > 1 ? [{ head: 'Start from' }].concat(S.startOrder.map(k => ({ label: names[k], radio: k === S.startNow, run: () => startFrom(k) }))).concat([null]) : [])
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
    return (S.marks && S.marks.git && S.marks.rows.length ? [{ label: 'Accept all target', run: () => acceptAll('target') }, { label: 'Accept all feature', run: () => acceptAll('feature') }, null] : []).concat([{ label: 'Keyboard shortcuts', run: () => { $('help').hidden = false; } }])
      .concat(S.plain ? []
        : S.manual ? [{ label: 'Save as file\u2026', run: () => api.postMessage({ type: 'saveAs', text: R.getValue() }) }, { label: 'Swap the two sides', run: () => api.postMessage({ type: 'swap', text: R.getValue() }) }] : [])
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
  $('saveClose').addEventListener('click', e => {
    if (!S.plain) return save(true);
    // a comparison: which side
    e.stopPropagation();
    toggleMenu('moreMenu', 'saveClose', () => [{ label: 'Save ' + (S.labels.target || 'the left side') + ' as file\u2026', run: () => api.postMessage({ type: 'saveAs', side: 'left', text: L.getValue() }) },
      { label: 'Save ' + (S.labels.incoming || S.labels.merged || 'the right side') + ' as file\u2026', run: () => api.postMessage({ type: 'saveAs', side: 'right', text: R.getValue() }) }]);
  });
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
