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
 *     starts: { merged, feature, target }, start   // where your resolution can start, and where it did
 *     hideIdentical, onPref(prefs)        // identical lines folded away; the choice, remembered
 *     conflictsFor(text),                 // what both branches changed, found in this text
 *     onText(text), save(text, close) -> { ok, message, warn }, discard(), onClose()
 *   }) -> { panel, reveal(line), apply(undo), dispose() }
 */
const { align } = require('./mergeAlign');

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
    '<div class="top"><span class="title" id="title"></span><span class="chips" id="chips"></span><span id="held" hidden>\u26a0 marks paused \u2013 not valid XML right now</span><span class="sp"></span><span id="note" role="status"></span>' +
    '<label class="start" title="Where your resolution starts - switching replaces the right pane in one step that Ctrl+Z undoes">Start from <select id="startFrom"></select></label>' +
    '<button id="prev" title="Previous change (Shift+F7)" aria-label="Previous change">\u2191</button><button id="next" title="Next change (F7)" aria-label="Next change">\u2193</button>' +
    '<button id="hide" aria-pressed="false"></button><button id="mode" title="Show the target in your order, or as it is"></button><button id="keys" title="Keyboard shortcuts" aria-expanded="false">\u2328</button><button id="discard">Discard</button>' +
    '<button id="save" title="Save as your resolution (Ctrl+S) \u2013 the merge stays open">\u2713 Save</button><button id="saveClose">Save and close</button></div>' +
    '<div id="help" hidden role="dialog" aria-label="Keyboard shortcuts"></div>' +
    '<div id="menu" hidden role="menu"></div>' +
    '<div class="heads"><div id="lefthead"></div><div></div><div id="righthead"></div></div>' +
    '<div class="panes"><div id="left"></div><div id="gap"><div id="joins"></div></div><div id="right"></div></div>' +
    '<div class="foot">Type in the right pane \u00b7 the buttons change whole elements, and Ctrl+Z undoes them \u00b7 F7 next change \u00b7 Ctrl+S saves</div>' +
    '<script nonce="' + nonce + '" src="' + attr(u('monaco/vs/loader.js')) + '"></script>' +
    '<script nonce="' + nonce + '" src="' + attr(u('merge.js')) + '"></script></body></html>';
}

/** The pieces, without what the page does not need: the left pane's lines come once, as its text. */
function marksFor(o, text, mode) {
  const r = align(o.target, o.incoming, text, { type: o.typeName, mode });
  if (r.hold) return r;
  return {
    left: r.left, mode: r.mode, counts: r.counts, moves: r.moves,
    pieces: r.pieces.map(p => ({ kind: p.kind, a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, label: p.label, context: p.context, undo: p.kind === 'same' ? undefined : p.undo, ghost: p.ghost, notInFeature: p.notInFeature }))
  };
}

function open(vscode, extensionUri, o) {
  const media = p => vscode.Uri.joinPath(extensionUri, 'media', ...p.split('/'));
  const title = 'Merge \u00b7 ' + o.file;
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
          starts: o.starts || null, start: o.start || null, hideIdentical: !!o.hideIdentical,
          marks: marksFor(o, text, mode), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
      } else if (m.type === 'text' || m.type === 'mode') {
        if (m.type === 'mode') mode = m.mode === 'literal' ? 'literal' : 'order';
        text = String(m.text);
        if (o.onText) o.onText(text);
        const marks = marksFor(o, text, mode);
        post(marks.hold ? { type: 'marks', seq: m.seq, hold: true } : { type: 'marks', seq: m.seq, mode, marks, conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
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
      } else if (m.type === 'discard') {
        if (o.discard) await o.discard();
      } else if (m.type === 'pref') {
        // remembered for the next merge (cmr.merge.hideIdentical)
        if (o.onPref) await o.onPref({ hideIdentical: !!m.hideIdentical });
      } else if (m.type === 'dirty') {
        panel.title = (m.dirty ? '\u25cf ' : '') + title;
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
