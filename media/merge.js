/* The merge editor: the target on the left (read-only), your resolution on the right (yours to edit),
   lined up piece by piece. The extension works out the pieces (src/mergeAlign.js); this page draws them
   and sends back what you type. Runs inside a VS Code webview with Monaco loaded from the extension. */
(function () {
  'use strict';
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const S = { seq: 0, shown: 0, saved: null, mode: 'order', marks: null, conflicts: [], zones: { left: [], right: [] }, widgets: [], deco: { left: null, right: null }, lastRight: null, held: false,
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
      lightbulb: { enabled: 'off' }, contextmenu: false, unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false }, stickyScroll: { enabled: false }
    };
    L = monaco.editor.create($('left'), Object.assign({}, common, { readOnly: true, domReadOnly: true, renderValidationDecorations: 'off' }));
    R = monaco.editor.create($('right'), Object.assign({}, common));
    // both panes scroll together - they are lined up, so the same height is the same place
    let syncing = false;
    const sync = (from, to) => from.onDidScrollChange(e => {
      if (syncing || (!e.scrollTopChanged && !e.scrollLeftChanged)) return;
      syncing = true;
      if (e.scrollTopChanged) to.setScrollTop(e.scrollTop);
      if (e.scrollLeftChanged) to.setScrollLeft(e.scrollLeft);
      syncing = false;
      drawJoins();
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
  function clipboard(ed, readOnly) {
    const K = monaco.KeyMod.CtrlCmd, C = monaco.KeyCode;
    ed.addAction({ id: 'cmr.copy', label: 'Copy', keybindings: [K | C.KeyC, K | C.Insert], contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 2, run: () => { copyFrom(ed); } });
    if (readOnly) return;
    ed.addAction({ id: 'cmr.cut', label: 'Cut', keybindings: [K | C.KeyX, monaco.KeyMod.Shift | C.Delete], contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 1, run: () => { cutFrom(ed); } });
    ed.addAction({ id: 'cmr.paste', label: 'Paste', keybindings: [K | C.KeyV, monaco.KeyMod.Shift | C.Insert], contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 3, run: () => { pasteInto(ed); } });
  }

  function menu(ed, ev) {
    const m = $('menu'), ro = ed === L;
    ev.preventDefault();
    const items = (ro ? [] : [['Cut', 'Ctrl+X', () => cutFrom(ed)]]).concat([['Copy', 'Ctrl+C', () => copyFrom(ed)]])
      .concat(ro ? [] : [['Paste', 'Ctrl+V', () => pasteInto(ed)]])
      .concat([null, ['Select all', 'Ctrl+A', () => ed.setSelection(ed.getModel().getFullModelRange())], ['Find', 'Ctrl+F', () => ed.getAction('actions.find').run()]]);
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
    up: SVG('<path d="m4 10 4-4 4 4"/>'), down: SVG('<path d="m4 6 4 4 4-4"/>'),
    more: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>',
    // arrows opening away from a line: the hidden-lines row, in the line-number column
    expand: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M6 4l2-2 2 2M8 14v-4M6 12l2 2 2-2M3.5 8h9"/></svg>',
    eye: SVG('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
    check: SVG('<path d="m3 8.5 3 3 7-7"/>'),
    chev: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>'
  };
  const GLYPH = { '\u21b6': 'undo', '\u2715': 'x', '\u21c4': 'swap' };

  // the rows between lines: one word in the colour of the change, and icon buttons whose names are their tooltips
  const side = () => /feature/i.test(S.theirs || '') ? 'feature' : 'incoming';
  const ROW = k => ({
    feature: ['feat', 'Added', [['\u21b6', 'Undo']]], own: ['own', 'Added by you', [['\u21b6', 'Undo']]],
    'changed-feature': ['feat', 'Changed', [['\u21b6', 'Use target']]], 'changed-own': ['own', 'Edited', [['\u21b6', 'Use target']]],
    removed: ['rem', 'Removed', [['\u21b6', 'Restore']]], notin: ['rem', 'Not in ' + side(), [['\u21b6', 'Restore']]],
    dupRemoved: ['dupr', 'Duplicate removed', [['\u21b6', 'Put it back']]], dropped: ['rem', 'Left out', [['\u21b6', 'Add it back']]],
    kept: ['keep', 'Kept \u00b7 not in ' + side(), [['\u2715', 'Remove']]], differs: ['keep', cap(side()) + ' differs', [['\u21c4', 'Use ' + side()]]],
    move: ['mv', 'Moved', [['\u21b6', 'Move back']]], conf: ['conf', 'Both changed', [['\u21b6', 'Use target'], ['\u21c4', 'Use ' + side()]]],
    dup: ['dup', 'Duplicate', [['\u2715', 'Remove copy']]]
  })[k];
  const rowNode = (cls, word) => zoneNode('head ' + cls, '<span class="dotk"></span><b>' + esc(word) + '</b>');

  function draw(m) {
    S.marks = m;
    const lh = R.getOption(monaco.editor.EditorOption.lineHeight);
    const HEAD = Math.max(22, lh + 3), FOLD = lh + 4;
    const items = { left: [], right: [] };
    // a zone: lines, or a header row's pixels; buttons over it, or the whole of it a click
    const zone = (sd, after, lines, node, buttons, move, opts) => items[sd].push(Object.assign({ after, lines, node, buttons, move }, opts || {}));
    // a change's row on both sides: the word on your side, a wordless row on the target's, the same height
    const rowsAt = new Map();
    const row = (key, after, leftAfter, undos, word, move) => {
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
      const item = { after, lines: 0, node: rowNode(cls, word || w), buttons: buttons.map(b => b.concat(cls)), move, px: HEAD, cls };
      items.right.push(item);
      if (!move && !['removed', 'notin', 'dupRemoved', 'dropped'].includes(key)) rowsAt.set(after, item);
      zone('left', leftAfter, 0, zoneNode('head ' + cls + ' l'), null, null, { px: HEAD });
    };
    const ld = [], rd = [];
    const whole = (arr, l0, l1, cls, ruler, glyph) => { if (l1 > l0) arr.push({ range: new monaco.Range(l0 + 1, 1, l1, 1), options: { isWholeLine: true, className: cls, linesDecorationsClassName: cls + '-g', glyphMarginClassName: glyph || undefined, overviewRuler: ruler ? { color: ruler, position: monaco.editor.OverviewRulerLane.Full } : undefined } }); };
    const ORANGE = 'rgba(232,145,45,.9)', RED = 'rgba(241,76,76,.7)', GREEN = 'rgba(137,209,133,.8)', BLUE = 'rgba(55,148,255,.8)', PURPLE = 'rgba(177,128,215,.9)', YELLOW = 'rgba(204,167,0,.9)';

    // a right-hand line's place on the left: line for line inside an unchanged piece, the piece's start otherwise
    const holding = b => m.pieces.find(p => p.b0 <= b && b < p.b1);
    const leftOf = b => { const p = holding(b); return p ? (p.kind === 'same' ? p.a0 + (b - p.b0) : p.a0) : (m.pieces.length ? m.pieces[m.pieces.length - 1].a1 : 0); };
    // a move's row goes before its first line - after any piece that ends there, before any that starts there
    const movesAt = new Map();
    for (const mv of m.moves) {
      const p = holding(mv.b0);
      const key = p && p.kind === 'same' && p.b0 < mv.b0 ? 'inside:' + mv.b0 : p;
      if (key) (movesAt.get(key) || movesAt.set(key, []).get(key)).push(mv);
    }
    const moveRow = mv => {
      row('move', mv.b0, leftOf(mv.b0), [mv.undo], null, mv);
      whole(rd, mv.b0, mv.b1, 'mv', PURPLE); whole(ld, leftOf(mv.b0), leftOf(mv.b1 - 1) + 1, 'mv');
    };
    for (const p of m.pieces) {
      for (const mv of (movesAt.get(p) || [])) moveRow(mv);
      if (p.kind === 'same') {
        for (const mv of m.moves) if (mv.b0 > p.b0 && mv.b0 < p.b1) moveRow(mv);
        continue;
      }
      const lc = p.a1 - p.a0, rc = p.b1 - p.b0;
      const key = p.kind === 'removed' ? (p.dupRemoved ? 'dupRemoved' : p.notInFeature ? 'notin' : 'removed') : p.kind;
      row(key, p.b0, p.a0, [p.undo]);
      if (p.kind === 'removed' || p.kind === 'dropped') {
        // no lines on your side: the target's (or the feature's) lines, struck through, where they were
        const ghost = p.ghost || [];
        zone('right', p.b0, ghost.length, ghostNode(ghost, p.dupRemoved ? 'dupr' : p.kind));
        if (p.kind === 'removed') whole(ld, p.a0, p.a1, p.dupRemoved ? 'dupl-l' : 'del', p.dupRemoved ? null : RED); else zone('left', p.a0, ghost.length, zoneNode('pad'));
        continue;
      }
      if (p.kind === 'kept' || p.kind === 'differs') { whole(rd, p.b0, p.b1, 'keep', ORANGE); continue; }
      if (lc) whole(ld, p.a0, p.a1, 'del', RED);
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
        zone(sd, after, 0, zoneNode('fold', '<span class="ft">' + esc(text) + '</span><span class="rule"></span>'), null, null, { click: open, title: 'Show these ' + n + ' lines', px: FOLD, margin });
      }
    }
    L.setHiddenAreas(S.hiddenRuns.map(r => new monaco.Range(r.a0 + 1, 1, r.a1, 1)));
    R.setHiddenAreas(S.hiddenRuns.map(r => new monaco.Range(r.b0 + 1, 1, r.b1, 1)));

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
    drawJoins();
    where();
    // the expand icon sits where the line numbers are, in each pane
    for (const ed of [L, R]) { const li = ed.getLayoutInfo(); const st = ed.getContainerDomNode().style; st.setProperty('--fold-w', li.contentLeft + 'px'); st.setProperty('--fold-pr', Math.max(0, li.contentLeft - (li.lineNumbersLeft + li.lineNumbersWidth)) + 'px'); }
  }

  /**
   * The runs of identical lines to fold: inside an unchanged piece that is line for line the same on both
   * sides, away from every change, move and conflict by CONTEXT lines, at least RUN long, and not one you
   * opened. In your resolution's lines [b0, b1) and the target's [a0, a1).
   */
  function identicalRuns(m) {
    const total = R.getModel().getLineCount();
    const keep = new Uint8Array(total + 1);
    const near = (b0, b1) => { for (let i = Math.max(0, b0 - CONTEXT); i < Math.min(total, b1 + CONTEXT); i++) keep[i] = 1; };
    for (const p of m.pieces) if (p.kind !== 'same') near(p.b0, p.b1);
    for (const mv of m.moves) near(mv.b0, mv.b1);
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
    if (it.move) { it.move.top = top; drawJoins(); }
  }

  // a short purple join between the panes where a block moved
  function drawJoins() {
    const g = $('joins');
    if (!g || !S.marks) return;
    const box = $('gap').getBoundingClientRect(), rb = $('right').getBoundingClientRect();
    g.innerHTML = '';
    for (const mv of S.marks.moves) {
      if (mv.top == null) continue;
      const y = mv.top + rb.top - box.top + R.getOption(monaco.editor.EditorOption.lineHeight) / 2 - 1;
      if (y < 0 || y > box.height) continue;
      g.insertAdjacentHTML('beforeend', '<div class="join" style="top:' + y + 'px"></div>');
    }
  }

  function summary(m) {
    const c = m.counts || {};
    const chips = [['mv', c.moved, 'moved'], ['feat', (c.feature || 0), 'from ' + (S.short || 'the feature')], ['own', c.own, c.own === 1 ? 'your edit' : 'your edits'],
      ['del', (c.removed || 0) + (c.dropped || 0), 'removed'], ['keep', (c.kept || 0) + (c.differs || 0), 'not taken from ' + (S.short || 'the feature')],
      ['conf', S.conflicts.length, S.conflicts.length === 1 ? 'conflict' : 'conflicts']]
      .filter(x => x[1]).map(x => '<span class="chip ' + x[0] + '" title="' + x[1] + ' ' + x[2] + '">' + x[1] + ' ' + x[2] + '</span>');
    $('chips').innerHTML = chips.length ? chips.join('') : '<span class="chip">the same as the target</span>';
    status();
    $('lefthead').innerHTML = '<b>' + esc(S.labels.target) + '</b> \u00b7 ' + (S.mode === 'order' ? 'in your order' : 'as it is') + ' \u00b7 read-only';
  }

  // ---- the buttons: one edit, undone with Ctrl+Z ----
  function act(undo) {
    const model = R.getModel();
    let ops;
    if (undo && undo.conflict) {
      const c = undo.conflict, line = c.line + 1;
      if (line > model.getLineCount()) return note('That line has changed - nothing was done.');
      const text = model.getLineContent(line);
      const re = new RegExp('(<' + c.tag + '(?:\\s[^>]*)?>)([\\s\\S]*?)(</' + c.tag + '>)');
      if (!re.test(text)) return note('That line has changed - nothing was done.');
      const value = String(undo.use === 'base' ? c.base : c.incoming).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      ops = [{ range: new monaco.Range(line, 1, line, text.length + 1), text: text.replace(re, (all, a, b, z) => a + value + z) }];
    } else {
      const lines = model.getLinesContent();
      const count = model.getLineCount();
      for (const o of undo) {
        const now = lines.slice(o.b0, o.b1);
        if (now.length !== o.expect.length || now.some((l, i) => l !== o.expect[i])) return note('Those lines have changed since they were marked - nothing was done.');
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
  }

  // ---- next and previous change ----
  function stops() {
    if (!S.marks) return [];
    const s = S.marks.pieces.filter(p => p.kind !== 'same').map(p => p.b0).concat(S.marks.moves.map(m => m.b0)).concat(S.conflicts.map(c => c.line));
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
    if (S.applyOnly && !close) return note('Apply and close writes it into ' + S.file + ' \u2013 nothing is written before that.');
    api.postMessage({ type: 'save', close: !!close, text: R.getValue() });
  }
  function note(text, warn) { const n = $('note'); n.textContent = text || ''; n.className = warn ? 'warn' : ''; clearTimeout(note.t); note.t = setTimeout(() => { n.textContent = ''; }, 8000); }

  // ---- the status bar: saved or not, the marks live or paused, duplicates ----
  function status() {
    const saved = $('stSaved');
    if (S.manual) saved.textContent = '';
    else if (S.applyOnly) saved.textContent = 'Not applied yet';
    else saved.innerHTML = S.unsaved ? '<span class="dirty">\u25cf Not saved</span>' : '\u2713 Saved as your resolution';
    $('stMarks').innerHTML = S.held
      ? '<span class="paused">\u25cb Marks paused \u2013 not valid XML' + (S.xml ? ' at line ' + S.xml.line : '') + '</span>'
      : '<span class="ok">\u25cf Marks live</span>';
    const removed = S.dupRemoved && S.startNow ? S.dupRemoved[S.startNow] || 0 : 0;
    $('stDups').innerHTML = (removed ? '<span class="dupt">' + removed + ' duplicate' + (removed === 1 ? '' : 's') + ' removed when the merge was prepared</span>' : '') +
      (S.dups.length ? '<span class="warnt">\u26a0 ' + S.dups.length + ' duplicate' + (S.dups.length === 1 ? '' : 's') + '</span>' : '');
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
    const list = S.dups.map(d => d.b0).concat(S.xml ? [S.xml.line - 1] : []).sort((a, b) => a - b);
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
      S.labels = m.labels; S.theirs = m.theirs; S.short = m.short; S.mode = m.mode || 'order'; S.conflicts = m.conflicts || [];
      S.hide = !!m.hideIdentical;
      S.saved = m.savedText != null ? m.savedText : null;
      S.applyOnly = !!m.applyOnly; S.file = m.file; S.manual = !!m.manual; S.dupRemoved = m.dupRemoved || null;
      if (S.manual) { $('saveClose').innerHTML = ICON.check + '<span>Copy result</span>'; $('saveClose').title = 'Copy the result, to paste into Copado (Ctrl+S) \u2013 or \u22ef \u203a Save as file\u2026'; }
      else if (S.applyOnly) { $('saveClose').innerHTML = ICON.check + '<span>Apply &amp; Close</span>'; $('saveClose').title = 'Write it into ' + m.file + ' and close'; }
      $('title').textContent = m.title;
      starts(m);
      $('righthead').innerHTML = '<b>' + esc(m.labels.merged || 'Your resolution') + '</b> \u00b7 <span class="ok">editable</span>';
      L.setModel(monaco.editor.createModel(m.marks.left, 'xml'));
      R.setModel(monaco.editor.createModel(m.text, 'xml'));
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
      if (m.mode) S.mode = m.mode;
      if (L.getValue() !== m.marks.left) { const top = R.getScrollTop(); L.getModel().setValue(m.marks.left); L.setScrollTop(top); }
      draw(m.marks);
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
      : '<div class="mi' + (it.bad ? ' bad' : '') + '" role="menuitem' + (it.check != null ? 'checkbox" aria-checked="' + !!it.check : '') + '" data-i="' + i + '"><span class="rk">' + (it.check ? '\u2713' : it.radio ? '\u25cf' : it.radio === false ? '\u25cb' : '') + '</span>' + esc(it.label) + '</div>').join('');
    m.onmousedown = e => e.preventDefault();
    m.onclick = e => { const d = e.target.closest('.mi'); if (!d) return; closeMenus(); items[+d.dataset.i].run(); };
  }
  function viewItems() {
    const names = START_NAMES();
    return (S.startOrder && S.startOrder.length > 1 ? [{ head: 'Start from' }].concat(S.startOrder.map(k => ({ label: names[k], radio: k === S.startNow, run: () => startFrom(k) }))).concat([null]) : [])
      .concat([{ label: 'Hide identical lines', check: S.hide, run: () => {
        S.hide = !S.hide; S.expanded = [];
        if (S.hide) toFirstChange();
        if (S.marks) draw(S.marks);
        api.postMessage({ type: 'pref', hideIdentical: S.hide });
      } }, { label: 'Target in literal order', check: S.mode === 'literal', run: () => { S.mode = S.mode === 'order' ? 'literal' : 'order'; S.seq++; api.postMessage({ type: 'mode', mode: S.mode, seq: S.seq, text: R.getValue() }); } }]);
  }
  function moreItems() {
    return [{ label: 'Keyboard shortcuts', run: () => { $('help').hidden = false; } }]
      .concat(S.manual ? [{ label: 'Save as file\u2026', run: () => api.postMessage({ type: 'saveAs', text: R.getValue() }) }, { label: 'Swap the two sides', run: () => api.postMessage({ type: 'swap', text: R.getValue() }) }] : [])
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
  window.addEventListener('resize', drawJoins);
  // the shortcuts: VS Code's own, with Cmd in place of Ctrl on a Mac
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const k = t => t.replace(/Ctrl/g, mac ? '\u2318' : 'Ctrl').replace(/Alt/g, mac ? '\u2325' : 'Alt').split(' / ').map(x => x.split('+').map(y => '<kbd>' + y + '</kbd>').join('+')).join(' / ');
  $('help').innerHTML = '<table>' + [
    ['Cut, copy, paste', 'Ctrl+X / Ctrl+C / Ctrl+V'], ['Select all', 'Ctrl+A'], ['Undo, redo', 'Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z'],
    ['Find, replace', 'Ctrl+F / Ctrl+H'], ['Go to line', 'Ctrl+G'], ['Move a line', 'Alt+\u2191 / Alt+\u2193'], ['Copy a line', 'Shift+Alt+\u2191 / Shift+Alt+\u2193'],
    ['Delete a line', 'Ctrl+Shift+K'], ['Comment out', 'Ctrl+/'], ['Indent, outdent', 'Tab / Shift+Tab'], ['Select the next match', 'Ctrl+D'],
    ['Another cursor', 'Alt+click'], ['Next, previous change', 'F7 / Shift+F7'], ['Next, previous problem', 'F8 / Shift+F8'], ['Save', 'Ctrl+S']
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
