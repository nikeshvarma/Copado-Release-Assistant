/* The merge editor: the target on the left (read-only), your resolution on the right (yours to edit),
   lined up piece by piece. The extension works out the pieces (src/mergeAlign.js); this page draws them
   and sends back what you type. Runs inside a VS Code webview with Monaco loaded from the extension. */
(function () {
  'use strict';
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const S = { seq: 0, shown: 0, saved: null, mode: 'order', marks: null, conflicts: [], zones: { left: [], right: [] }, widgets: [], deco: { left: null, right: null }, lastRight: null, held: false,
    hide: false, expanded: [], hiddenRuns: [] };
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
    R.onDidChangeModelContent(() => { dirty(); typed(); });
    clipboard(L, true); clipboard(R, false);
    R.onDidChangeCursorPosition(e => openAt('right', e.position.lineNumber - 1));
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
    if (S.applyOnly) return;
    const d = S.saved != null && R.getValue() !== S.saved;
    $('save').classList.toggle('pri', d);
    api.postMessage({ type: 'dirty', dirty: d });
  }

  // ---- drawing the pieces ----
  const WORDS = {
    removed: ['\u21b6', 'Removed', 'Restore'], dropped: ['\u21b6', 'Left out from ' + 'THEIRS', 'Add it back'],
    feature: ['+', 'From ' + 'THEIRS', 'Undo'], own: ['\u270e', 'Your edit', 'Undo'],
    'changed-feature': ['\u0394', 'Changed by ' + 'THEIRS', 'Use target'], 'changed-own': ['\u270e', 'Your edit', 'Use target'],
    // what the feature branch has otherwise, though your resolution does not take it
    kept: ['\u2212', 'Not in ' + 'THEIRS' + ' \u00b7 still here', 'Remove'], differs: ['\u2260', 'THEIRS' + ' has another value', 'USEFEATURE'],
    notin: ['\u21b6', 'Not in ' + 'THEIRS', 'Restore']
  };
  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const say = (k, i) => { const w = WORDS[k][i].replace('USEFEATURE', 'Use ' + (/feature/i.test(S.theirs || '') ? 'feature' : 'incoming')); return (w.startsWith('THEIRS') ? cap(S.theirs || 'the incoming file') + w.slice(6) : w.replace('THEIRS', S.theirs || 'the incoming file')); };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function zoneNode(cls, html) { const d = document.createElement('div'); d.className = 'zone ' + cls; d.innerHTML = html || ''; return d; }
  function ghostNode(lines, cls) {
    const d = zoneNode('ghost ' + cls);
    d.style.fontFamily = fontFamily(); d.style.fontSize = fontSize() + 'px';
    d.style.lineHeight = R.getOption(monaco.editor.EditorOption.lineHeight) + 'px';
    d.innerHTML = lines.map(l => '<div class="gl">' + (esc(l.replace(/\r?\n$/, '')) || '&nbsp;') + '</div>').join('');
    return d;
  }

  function draw(m) {
    S.marks = m;
    const lh = R.getOption(monaco.editor.EditorOption.lineHeight);
    const items = { left: [], right: [] };
    const zone = (side, after, lines, node, buttons, move) => items[side].push({ after, lines, node, buttons, move });
    const ld = [], rd = [];
    const whole = (arr, l0, l1, cls, ruler) => { if (l1 > l0) arr.push({ range: new monaco.Range(l0 + 1, 1, l1, 1), options: { isWholeLine: true, className: cls, linesDecorationsClassName: cls + '-g', overviewRuler: ruler ? { color: ruler, position: monaco.editor.OverviewRulerLane.Full } : undefined } }); };
    const ORANGE = 'rgba(232,145,45,.9)', RED = 'rgba(241,76,76,.7)', GREEN = 'rgba(137,209,133,.8)', BLUE = 'rgba(55,148,255,.8)', PURPLE = 'rgba(177,128,215,.9)', YELLOW = 'rgba(204,167,0,.9)';

    // moves start where a piece starts; their header comes first there
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
      const label = mv.label + ' \u00b7 ' + ord(mv.from) + ' \u2192 ' + ord(mv.to) + (mv.inside ? '' : ' \u00b7 nothing inside changed');
      const [r, l] = header('move', '\u2195', 'Moved: ' + label, [['Move back', mv.undo]]);
      zone('right', mv.b0, 1, r, [['Move back', mv.undo]], mv); zone('left', leftOf(mv.b0), 1, l);
      whole(rd, mv.b0, mv.b1, 'mv', PURPLE); whole(ld, leftOf(mv.b0), leftOf(mv.b1 - 1) + 1, 'mv');
    };
    const header = (cls, icon, text, buttons, sideText) => {
      const html = '<span class="ic">' + icon + '</span><b>' + esc(text) + '</b>' + (sideText ? '<span class="dim"> \u00b7 ' + esc(sideText) + '</span>' : '');
      return [zoneNode('head ' + cls, html), zoneNode('head ' + cls + ' l', '<span class="ic">' + icon + '</span>' + esc(text.split(':')[0]))];
    };
    for (const p of m.pieces) {
      for (const mv of (movesAt.get(p) || [])) moveRow(mv);
      if (p.kind === 'same') {
        // moves that start partway through an unchanged run: their rows in line order
        for (const mv of m.moves) if (mv.b0 > p.b0 && mv.b0 < p.b1) moveRow(mv);
        continue;
      }
      const lc = p.a1 - p.a0, rc = p.b1 - p.b0;
      const name = p.label + (p.context ? ' \u00b7 ' + p.context : '');
      const word = p.kind === 'removed' && p.notInFeature ? 'notin' : p.kind;
      const [icon, title] = [say(word, 0), say(word, 1)];
      const action = [[say(word, 2), p.undo]];
      const [rh, lh2] = header(p.kind, icon, title + ': ' + name, action);
      zone('right', p.b0, 1, rh, action); zone('left', p.a0, 1, lh2);
      if (p.kind === 'removed' || p.kind === 'dropped') {
        // no lines on your side: the target's (or the feature's) lines, struck through, where they were
        const ghost = p.ghost || [];
        zone('right', p.b0, ghost.length, ghostNode(ghost, p.kind));
        if (p.kind === 'removed') whole(ld, p.a0, p.a1, 'del', RED); else zone('left', p.a0, ghost.length, zoneNode('pad'));
        continue;
      }
      if (p.kind === 'kept' || p.kind === 'differs') {
        // the target's, as you have it: nothing to shade on the left; orange on your side
        whole(rd, p.b0, p.b1, 'keep', ORANGE);
        continue;
      }
      if (lc) whole(ld, p.a0, p.a1, 'del', RED);
      whole(rd, p.b0, p.b1, /feature/.test(p.kind) ? 'feat' : 'own', /feature/.test(p.kind) ? GREEN : BLUE);
      if (rc > lc) zone('left', p.a1, rc - lc, zoneNode('pad'));
      if (lc > rc) zone('right', p.b1, lc - rc, zoneNode('pad'));
    }
    // both branches changed it: yours to settle
    for (const c of S.conflicts) {
      if (c.line == null) continue;
      whole(rd, c.line, c.line + 1, 'conf', YELLOW);
      const text = 'Both changed ' + c.tag + ' \u00b7 target: ' + clip(c.base) + ' \u00b7 ' + (S.theirs || 'incoming') + ': ' + clip(c.incoming);
      const buttons = c.multiline ? [] : [['Use target', { conflict: c, use: 'base' }], ['Use ' + (S.short || 'feature'), { conflict: c, use: 'incoming' }]];
      const [r, l] = header('conf', '!', text, buttons);
      zone('right', c.line, 1, r, buttons); zone('left', leftOf(c.line), 1, l);
    }

    // identical lines folded away - the same lines on both sides, so the panes stay level
    S.hiddenRuns = S.hide ? identicalRuns(m) : [];
    for (const run of S.hiddenRuns) {
      const n = run.b1 - run.b0, text = '\u22ef ' + n + ' identical line' + (n === 1 ? '' : 's');
      const show = [['Show', () => { S.expanded.push([run.b0, run.b1]); draw(S.marks); }]];
      // after the run's last line: Monaco hides a row whose next line is hidden, so the row goes at the run's end -
      // where it shows, in its place, since the lines before it take no room
      zone('right', run.b1, 1, zoneNode('fold', '<span class="ic">\u22ef</span>' + esc(text.slice(2))), show);
      zone('left', run.a1, 1, zoneNode('fold', '<span class="ic">\u22ef</span>' + esc(text.slice(2))));
    }
    L.setHiddenAreas(S.hiddenRuns.map(r => new monaco.Range(r.a0 + 1, 1, r.a1, 1)));
    R.setHiddenAreas(S.hiddenRuns.map(r => new monaco.Range(r.b0 + 1, 1, r.b1, 1)));

    // the zones: replaced as a whole, in order, the same rows on both sides
    for (const side of ['left', 'right']) {
      const ed = side === 'left' ? L : R;
      ed.changeViewZones(acc => {
        for (const id of S.zones[side]) acc.removeZone(id);
        S.zones[side] = items[side].map((it, i) => acc.addZone({
          afterLineNumber: it.after, heightInLines: it.lines, domNode: it.node, ordinal: i,
          onDomNodeTop: it.buttons ? top => place(it, top) : undefined
        }));
      });
    }
    // the buttons sit over the zones (a zone itself takes no clicks)
    for (const w of S.widgets) R.removeOverlayWidget(w);
    S.widgets = [];
    items.right.filter(it => it.buttons && it.buttons.length).forEach((it, i) => {
      const node = document.createElement('div');
      node.className = 'acts';
      node.style.height = lh + 'px';
      for (const [label, undo] of it.buttons) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
        b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (typeof undo === 'function') undo(); else act(undo); });
        node.appendChild(b);
      }
      const w = { getId: () => 'cmr.act.' + i, getDomNode: () => node, getPosition: () => null };
      it.widget = node;
      R.addOverlayWidget(w);
      S.widgets.push(w);
    });
    S.deco.left = S.deco.left ? (S.deco.left.set(ld), S.deco.left) : L.createDecorationsCollection(ld);
    S.deco.right = S.deco.right ? (S.deco.right.set(rd), S.deco.right) : R.createDecorationsCollection(rd);
    summary(m);
    drawJoins();
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
  const clip = t => { const s = String(t == null ? '' : t).replace(/\s+/g, ' '); return s.length > 40 ? s.slice(0, 39) + '\u2026' : s; };
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

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
    $('mode').textContent = S.mode === 'order' ? '\u21c5 Literal order' : '\u21c5 In your order';
    const folded = S.hiddenRuns.reduce((n, r) => n + r.b1 - r.b0, 0);
    $('hide').textContent = S.hide ? '\u2261 Show identical' : '\u2261 Hide identical';
    $('hide').setAttribute('aria-pressed', String(S.hide));
    $('hide').title = S.hide ? (folded ? folded + ' identical lines hidden \u2013 show them' : 'Show identical lines') : 'Hide lines that are the same on both sides, keeping ' + CONTEXT + ' around each change';
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
  function save(close) {
    if (S.applyOnly && !close) return note('Apply and close writes it into ' + S.file + ' \u2013 nothing is written before that.');
    api.postMessage({ type: 'save', close: !!close, text: R.getValue() });
  }
  function note(text, warn) { const n = $('note'); n.textContent = text; n.className = warn ? 'warn' : ''; clearTimeout(note.t); note.t = setTimeout(() => { n.textContent = ''; }, 6000); }

  // ---- messages from the extension ----
  window.addEventListener('message', e => {
    const m = e.data || {};
    if (m.type === 'init') {
      S.labels = m.labels; S.theirs = m.theirs; S.short = m.short; S.mode = m.mode || 'order'; S.conflicts = m.conflicts || [];
      S.hide = !!m.hideIdentical;
      S.saved = m.savedText != null ? m.savedText : null;
      S.applyOnly = !!m.applyOnly; S.file = m.file;
      if (S.applyOnly) { $('save').hidden = true; $('saveClose').textContent = 'Apply and close'; $('saveClose').title = 'Write it into ' + m.file + ' and close'; $('saveClose').classList.add('pri'); }
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
      if (m.hold) { S.held = true; $('held').hidden = false; return; }
      S.held = false; $('held').hidden = true;
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
  function starts(m) {
    const sel = $('startFrom');
    S.starts = m.starts || {};
    const names = { saved: 'Your saved resolution', feature: cap(S.theirs || 'the incoming file'), target: S.labels.target || 'The target', merged: 'Merged (both)' };
    if (m.savedText != null) S.starts.saved = m.savedText;
    const order = ['saved', 'feature', 'target', 'merged'].filter(k => S.starts[k] != null);
    if (!order.length) { sel.parentElement.hidden = true; return; }
    sel.innerHTML = order.map(k => '<option value="' + k + '">' + esc(names[k]) + '</option>').join('');
    sel.value = m.start && S.starts[m.start] != null ? m.start : order[0];
    S.startNow = sel.value;
    sel.addEventListener('change', () => {
      const text = S.starts[sel.value];
      if (text == null) return;
      const model = R.getModel();
      R.pushUndoStop();
      model.pushEditOperations(R.getSelections(), [{ range: model.getFullModelRange(), text }], () => null);
      R.pushUndoStop();
      note('Started again from ' + names[sel.value].replace(/^The /, 'the ') + ' \u2013 Ctrl+Z goes back to what you had.');
      S.startNow = sel.value;
      R.focus();
    });
  }
  function reveal(line) { R.revealLineInCenter(line + 1); R.setPosition({ lineNumber: line + 1, column: 1 }); R.focus(); }

  // ---- the toolbar ----
  $('save').addEventListener('click', () => save(false));
  $('saveClose').addEventListener('click', () => save(true));
  $('discard').addEventListener('click', () => api.postMessage({ type: 'discard' }));
  $('next').addEventListener('click', () => go(1));
  $('prev').addEventListener('click', () => go(-1));
  $('hide').addEventListener('click', () => {
    S.hide = !S.hide; S.expanded = [];
    if (S.hide) toFirstChange();
    if (S.marks) draw(S.marks);
    api.postMessage({ type: 'pref', hideIdentical: S.hide });
  });
  $('mode').addEventListener('click', () => { S.mode = S.mode === 'order' ? 'literal' : 'order'; S.seq++; api.postMessage({ type: 'mode', mode: S.mode, seq: S.seq, text: R.getValue() }); });
  window.addEventListener('resize', drawJoins);
  // the shortcuts: VS Code's own, with Cmd in place of Ctrl on a Mac
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const k = t => t.replace(/Ctrl/g, mac ? '\u2318' : 'Ctrl').replace(/Alt/g, mac ? '\u2325' : 'Alt').split(' / ').map(x => x.split('+').map(y => '<kbd>' + y + '</kbd>').join('+')).join(' / ');
  $('help').innerHTML = '<table>' + [
    ['Cut, copy, paste', 'Ctrl+X / Ctrl+C / Ctrl+V'], ['Select all', 'Ctrl+A'], ['Undo, redo', 'Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z'],
    ['Find, replace', 'Ctrl+F / Ctrl+H'], ['Go to line', 'Ctrl+G'], ['Move a line', 'Alt+\u2191 / Alt+\u2193'], ['Copy a line', 'Shift+Alt+\u2191 / Shift+Alt+\u2193'],
    ['Delete a line', 'Ctrl+Shift+K'], ['Comment out', 'Ctrl+/'], ['Indent, outdent', 'Tab / Shift+Tab'], ['Select the next match', 'Ctrl+D'],
    ['Another cursor', 'Alt+click'], ['Next, previous change', 'F7 / Shift+F7'], ['Save', 'Ctrl+S']
  ].map(r => '<tr><td>' + r[0] + '</td><td>' + k(r[1]) + '</td></tr>').join('') + '</table>';
  $('keys').addEventListener('click', () => { const h = $('help'); h.hidden = !h.hidden; $('keys').setAttribute('aria-expanded', String(!h.hidden)); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('help').hidden) { $('help').hidden = true; $('keys').setAttribute('aria-expanded', 'false'); } });

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
