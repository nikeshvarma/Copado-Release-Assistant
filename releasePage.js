'use strict';

/**
 * The Copado Release Assistant page: one place to start. Two views - a
 * promotion (its conflicts, Copado's deployment and activity) and a story's
 * journey - drawn from the state the two sides send: the Promotion workspace
 * (promotionUi), Manual and Compare. Styled only with VS
 * Code's theme variables, so it follows the user's theme.
 */
const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');

let panel = null;
let ui = null;
let manual = null;
let compare = null;
let ctx = null;

function activate(context, promotionUi, cmd, manualUi, compareUi) {
  ui = promotionUi;
  manual = manualUi || null;
  ctx = context;
  if (manual) manual.onChange(() => push());
  compare = compareUi || null;
  if (compare) compare.onChange(() => push());
  cmd('cmr.page.open', () => show());
  ui.onChange(() => push());
}

/** The page - on a tab of it, when one is named (Compare in Release Assistant opens Manual). */
function show(nav) {
  if (panel) { panel.reveal(); if (nav) panel.webview.postMessage({ type: 'nav', nav }); return push(); }
  pendingNav = nav || null;
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  panel = vscode.window.createWebviewPanel('cmrPage', 'Copado Release Assistant', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
  panel.iconPath = vscode.Uri.joinPath(media, 'logo.png');
  panel.webview.html = html(panel.webview, media);
  panel.webview.onDidReceiveMessage(onMessage);
  panel.onDidDispose(() => { panel = null; ui.act('stopWatch', {}); });
}

function html(webview, media) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = f => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' + webview.cspSource + ' data:; style-src ' + webview.cspSource + '; script-src \'nonce-' + nonce + '\';">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="' + uri('page.css') + '"><title>Copado Release Assistant</title></head>' +
    '<body data-logo="' + uri('logo.png') + '"><div id="app"></div><script nonce="' + nonce + '" src="' + uri('page.js') + '"></script></body></html>';
}

async function push(extra) {
  if (!panel) return;
  try {
    const data = await ui.snapshot();
    if (manual) data.manual = manual.snapshot();
    if (compare) data.compare = compare.snapshot();
    panel.webview.postMessage(Object.assign({ type: 'state', data }, extra || {}));
  } catch (e) { /* the page will ask again */ }
}

// the commands the page's buttons run - nothing else is run from it
const TOOLS = new Set(['cmr.validate.run', 'cmr.git.check', 'cmrDeployView.focus', 'workbench.action.openSettings']);
let running = 0;
let pendingNav = null;

async function onMessage(m) {
  if (!m) return;
  if (m.type === 'ready') { await push(); if (pendingNav && panel) { panel.webview.postMessage({ type: 'nav', nav: pendingNav }); pendingNav = null; } return; }
  if (m.type === 'tool') {
    if (!TOOLS.has(m.id)) return;
    return Promise.resolve(vscode.commands.executeCommand(m.id)).catch(e => vscode.window.showErrorMessage(e && e.message ? e.message : String(e)));
  }
  if (m.type !== 'act') return;
  // busy while any action runs - two at once keep it on until both are done
  running++;
  panel.webview.postMessage({ type: 'busy', on: true, what: m.name });
  try {
    if (m.scope === 'manual' && manual) await manual.act(m.name, m.payload || {});
    else if (m.scope === 'compare' && compare) await compare.act(m.name, m.payload || {});
    else await ui.act(m.name, m.payload || {});
  } catch (e) {
    vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
  } finally {
    running = Math.max(0, running - 1);
    if (panel && !running) panel.webview.postMessage({ type: 'busy', on: false });
    push();
  }
}

module.exports = { activate, show, html };
