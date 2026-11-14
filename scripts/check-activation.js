'use strict';
/**
 * Starts the extension on a stand-in VS Code and checks every command it declares is registered.
 *   node scripts/check-activation.js [extension-folder]      (default: this repository)
 * Exits 1 if activation fails or a command is missing.
 */
const fs = require('fs'), path = require('path'), os = require('os');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cra-activate-'));
const registered = new Set();
const any = () => { const store = {}; return new Proxy(function () {}, {
  get: (t, k) => k in store ? store[k] : k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : k === 'fsPath' || k === 'path' ? tmp : any(),
  set: (t, k, v) => { store[k] = v; return true; }, defineProperty: () => true, apply: () => any(), construct: () => any() }); };
const vs = new Proxy({}, { get: (t, k) => {
  if (k === 'commands') return { registerCommand: id => { registered.add(id); return { dispose() {} }; }, executeCommand: async () => {}, getCommands: async () => [] };
  if (k === 'workspace') return new Proxy({}, { get: (t2, k2) => k2 === 'getConfiguration' ? () => ({ get: (x, d) => d, update: async () => {}, inspect: () => undefined }) : k2 === 'workspaceFolders' ? [] : k2 === 'textDocuments' ? [] : k2 === 'isTrusted' ? true : any() });
  if (k === 'window') return new Proxy({}, { get: (t2, k2) => k2 === 'visibleTextEditors' ? [] : k2 === 'activeTextEditor' ? undefined : any() });
  if (k === 'EventEmitter') return class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} };
  return any();
} });
const Module = require('module'); const load = Module._load;
Module._load = function (r) { return r === 'vscode' ? vs : load.apply(this, arguments); };
const done = code => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a temp folder */ } process.exit(code); };
let ext;
try { ext = require(path.join(dir, p.main)); } catch (e) { console.error('LOADING FAILED: ' + e.stack); done(1); }
const ctx = { subscriptions: [], secrets: any(), workspaceState: { get: (k, d) => d, update: async () => {} }, globalState: { get: (k, d) => d, update: async () => {}, setKeysForSync() {} },
  extensionUri: { fsPath: dir, path: dir }, globalStorageUri: { fsPath: tmp, path: tmp }, storageUri: { fsPath: tmp, path: tmp }, extensionPath: dir };
Promise.resolve(ext.activate(ctx)).then(() => {
  const missing = p.contributes.commands.map(c => c.command).filter(c => !registered.has(c));
  console.log('activated ' + p.name + ' ' + p.version + ': ' + registered.size + ' commands registered, ' + p.contributes.commands.length + ' declared' + (missing.length ? ' - MISSING: ' + missing.join(', ') : ''));
  setTimeout(() => done(missing.length ? 1 : 0), 50);
}, e => { console.error('ACTIVATION FAILED: ' + (e && e.stack || e)); done(1); });
