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
  // SHOT_SIZE=1280x760 draws the pictures at the README's size
  const [sw, sh] = String(process.env.SHOT_SIZE || '1400x860').split('x').map(Number);
  // opts.clipboard: the real clipboard, for the find box's own copy and paste
  const ctx = await b.newContext(Object.assign({ viewport: { width: opts.width || sw, height: opts.height || sh } }, opts.clipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}));
  const p = await ctx.newPage();
  const errors = [], sent = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  p.on('requestfailed', r => errors.push('missing: ' + r.url().split('/').slice(-2).join('/')));
  let text = o.text;
  const state = { mode: 'order' };
  await p.exposeFunction('__toHost', async m => {
    sent.push(m);
    const reply = r => p.evaluate(r => window.postMessage(r, '*'), r);
    if (m.type === 'ready') await reply({ type: 'init', title: (o.plain ? 'Compare' : 'Merge') + ' \u00b7 ' + o.file, labels: o.labels, theirs: o.theirs, short: o.short, mode: 'order', text, savedText: o.savedText || null, starts: o.starts || null, start: o.start || null, hideIdentical: !!o.hideIdentical, language: o.language || 'xml', plain: !!o.plain, tidy: !o.language && require('../src/mergeStart').ADDITIVE.has(o.typeName), marks: MP.marksFor(o, text, 'order'), conflicts: o.conflictsFor ? o.conflictsFor(text) : [] });
    // VS Code's clipboard, as the extension answers it
    else if (m.type === 'clipboard') state.clip = m.text;
    else if (m.type === 'paste') {
      await reply({ type: 'pasted', id: m.id, text: state.clip });
      // and as VS Code may also pass the keystroke on as a native paste: it must not paste twice
      if (opts.nativeToo) await p.evaluate(t => { const d = new DataTransfer(); d.setData('text/plain', t); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); }, state.clip || '');
    }
    else if (m.type === 'text' && m.side === 'left') { o.target = m.text; await reply({ type: 'marks', seq: m.seq, marks: MP.marksFor(o, text, 'order'), conflicts: [] }); }
    else if (m.type === 'text') { text = m.text; const marks = MP.marksFor(o, text, state.mode); await reply(marks.hold ? { type: 'marks', seq: m.seq, hold: true, xmlError: marks.xmlError } : { type: 'marks', seq: m.seq, mode: state.mode, marks, conflicts: o.conflictsFor ? o.conflictsFor(text) : [] }); }
    else if (m.type === 'codeView') { o.codeView = m.view; state.codeView = m.view; if (typeof m.text === 'string') text = m.text; await reply({ type: 'marks', seq: m.seq, marks: MP.marksFor(o, text, 'order'), conflicts: [] }); }
    else if (m.type === 'review' && o.code && o.code.reviewed instanceof Map) { o.code.reviewed.set(String(m.id), String(m.choice)); await reply({ type: 'marks', seq: m.seq, marks: MP.marksFor(o, typeof m.text === 'string' ? (text = m.text) : text, 'order'), conflicts: [] }); }
    else if (m.type === 'review') { if (o.code) o.code.reviewed.add(String(m.id)); if (typeof m.text === 'string') text = m.text; await reply({ type: 'marks', seq: m.seq, marks: MP.marksFor(o, text, 'order'), conflicts: [] }); }
    else if (m.type === 'dedupe') {
      // as the extension does: the duplicates found, the copies taken out (identical ones - no question here)
      const X = require('../src/xmlParser'), D = require('../src/duplicates');
      const d = X.parse(String(m.text)), f = D.findDuplicates(d, {}).filter(x => x.kind !== 'duplicate-single');
      let out = String(m.text);
      for (const r of D.dedupeEdits(d, f, 'first').sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + out.slice(r.end);
      await reply(f.length ? { type: 'formatted', seq: m.seq, text: out, note: 'Removed ' + f.length } : { type: 'formatted', seq: m.seq, note: 'No duplicate entries to remove.' });
    }
    else if (m.type === 'format') {
      // as the extension does: Salesforce's order, duplicates left alone
      const X = require('../src/xmlParser'), F = require('../src/formatter');
      const d = X.parse(String(m.text));
      await reply(d.root && !(d.errors && d.errors.length) ? { type: 'formatted', seq: m.seq, side: m.side, text: F.format(d, { eol: '\n', removeDuplicates: false }) } : { type: 'formatted', seq: m.seq, side: m.side, error: 'Not valid XML - fix it first' });
    }
    else if (m.type === 'save') { text = m.text; await reply({ type: 'saved', ok: true, message: 'Saved as your resolution', text }); }
  });
  await p.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: m => window.__toHost(m), setState() {}, getState() { return null; } }); });
  await p.goto('file://' + file);
  await p.waitForFunction(() => document.querySelectorAll('.monaco-editor').length === 2 && document.querySelector('#chips').textContent, null, { timeout: 30000 });
  await p.waitForTimeout(400);
  const out = await script(p, { sent, errors, text: () => text, state, clip: () => state.clip, setClip: t => { state.clip = t; } });
  await b.close();
  return out;
}
/** The Release Assistant page itself (media/page.js) in a browser: what it sends, and new state pushed to it as the extension does. */
async function runPage(state, script, opts) {
  opts = opts || {};
  const b = await chromium.launch();
  try {
    const p = await (await b.newContext({ viewport: { width: opts.width || 1280, height: opts.height || 760 } })).newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(String(e)));
    await p.setContent('<!doctype html><html><head><style>' + fs.readFileSync(path.join(__dirname, '..', 'media', 'page.css'), 'utf8') + '</style></head><body data-logo=""><div id="app"></div>' +
      '<script>window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.sent.push(m), setState() {}, getState: () => (' + JSON.stringify(opts.saved || {}) + ') });</script>' +
      '<script>' + fs.readFileSync(path.join(__dirname, '..', 'media', 'page.js'), 'utf8') + '</script></body></html>');
    const push = d => p.evaluate(dd => window.postMessage({ type: 'state', data: dd }, '*'), d);
    await push(state);
    await p.waitForTimeout(150);
    return await script(p, { push, errors, sent: () => p.evaluate(() => window.sent) });
  } finally { await b.close(); }
}

module.exports = { run, runPage };
