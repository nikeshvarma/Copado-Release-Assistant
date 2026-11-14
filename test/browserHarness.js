'use strict';
/* The real merge editor page in a browser (Playwright), with this script playing VS Code's part - for test/browser.js. */
// the real merge editor page in a browser, with this script playing VS Code's part
const path = require('path'), fs = require('fs');
const MP = require('../src/mergePanel');
// Playwright from npm (npm install --no-save playwright), or from where PLAYWRIGHT points
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const media = p => ({ fsPath: path.join(__dirname, '..', 'media', p) });
const webview = { cspSource: 'file:', asWebviewUri: u => ({ toString: () => 'file://' + u.fsPath }) };

async function run(o, script, opts) {
  opts = opts || {};
  const page = MP.html(webview, media);
  const file = path.join(require('os').tmpdir(), 'cra-merge-page' + (opts.light ? '-light' : '') + '.html');
  // VS Code's theme variables, as a dark (or light) theme sets them
  const vars = opts.light
    ? '--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-panel-border:#e5e5e5;--vscode-editor-font-family:\'DejaVu Sans Mono\',monospace;--vscode-editor-font-size:13px;--vscode-font-family:\'DejaVu Sans\',sans-serif;--vscode-font-size:13px;--vscode-editorLineNumber-foreground:#6e7681'
    : '--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-panel-border:#2b2b2b;--vscode-editor-font-family:\'DejaVu Sans Mono\',monospace;--vscode-editor-font-size:13px;--vscode-font-family:\'DejaVu Sans\',sans-serif;--vscode-font-size:13px;--vscode-editorLineNumber-foreground:#6e7681';
  fs.writeFileSync(file, page.replace('<html lang="en">', '<html lang="en" style="' + vars + '">').replace('<body ', '<body class="' + (opts.light ? 'vscode-light' : 'vscode-dark') + '" '));
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: opts.width || 1400, height: opts.height || 860 } });
  const errors = [], sent = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  let text = o.text;
  const state = { mode: 'order' };
  await p.exposeFunction('__toHost', async m => {
    sent.push(m);
    const reply = r => p.evaluate(r => window.postMessage(r, '*'), r);
    if (m.type === 'ready') await reply({ type: 'init', title: 'Merge \u00b7 ' + o.file, labels: o.labels, theirs: o.theirs, short: o.short, mode: 'order', text, savedText: o.savedText || null, starts: o.starts || null, start: o.start || null, marks: MP.marksFor(o, text, 'order'), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
    // VS Code's clipboard, as the extension answers it
    else if (m.type === 'clipboard') state.clip = m.text;
    else if (m.type === 'paste') {
      await reply({ type: 'pasted', id: m.id, text: state.clip });
      // and as VS Code may also pass the keystroke on as a native paste: it must not paste twice
      if (opts.nativeToo) await p.evaluate(t => { const d = new DataTransfer(); d.setData('text/plain', t); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); }, state.clip || '');
    }
    else if (m.type === 'text' || m.type === 'mode') { if (m.type === 'mode') state.mode = m.mode; text = m.text; const marks = MP.marksFor(o, text, state.mode); await reply(marks.hold ? { type: 'marks', seq: m.seq, hold: true } : { type: 'marks', seq: m.seq, mode: state.mode, marks, conflicts: o.conflictsFor ? o.conflictsFor(text) : [] }); }
    else if (m.type === 'save') { text = m.text; await reply({ type: 'saved', ok: true, message: 'Saved as your resolution', text }); }
  });
  await p.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: m => window.__toHost(m), setState() {}, getState() { return null; } }); });
  await p.goto('file://' + file);
  await p.waitForFunction(() => document.querySelectorAll('.monaco-editor').length === 2 && document.querySelector('#chips').textContent, null, { timeout: 30000 });
  await p.waitForTimeout(400);
  const out = await script(p, { sent, errors, text: () => text, clip: () => state.clip, setClip: t => { state.clip = t; } });
  await b.close();
  return out;
}
module.exports = { run };
