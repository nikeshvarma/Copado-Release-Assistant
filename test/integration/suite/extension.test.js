// Runs inside a real VS Code with the fixture project open.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vscode = require('vscode');

const ID = 'nikeshvarma.copado-release-assistant';
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(150); }
}

test('the extension activates', async () => {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, 'installed');
  await ext.activate();
  assert.ok(ext.isActive);
});

test('every command the extension declares is registered', async () => {
  const declared = vscode.extensions.getExtension(ID).packageJSON.contributes.commands.map(c => c.command);
  const all = new Set(await vscode.commands.getCommands(true));
  assert.deepStrictEqual(declared.filter(c => !all.has(c)), []);
});

test('the settings VS Code sees are the ones declared', async () => {
  const props = vscode.extensions.getExtension(ID).packageJSON.contributes.configuration.flatMap(s => Object.keys(s.properties));
  const cfg = vscode.workspace.getConfiguration();
  const missing = props.filter(k => cfg.inspect(k) === undefined);
  assert.deepStrictEqual(missing, []);
  assert.strictEqual(vscode.workspace.getConfiguration('cmr').get('repo.promotionBranch'), 'promotion/{promotion}');
  assert.strictEqual(vscode.workspace.getConfiguration('cmr').get('selective.folder'), undefined, 'removed in 3.0');
});

test('Format Document writes a permission set in Salesforce order', async () => {
  const uri = vscode.Uri.file(path.join(root(), 'force-app', 'main', 'default', 'permissionsets', 'Unsorted.permissionset-meta.xml'));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, { tabSize: 4, insertSpaces: true });
  assert.ok(edits && edits.length, 'the extension formats metadata');
  const we = new vscode.WorkspaceEdit();
  we.set(uri, edits);
  await vscode.workspace.applyEdit(we);
  const text = doc.getText();
  const order = ['<classAccesses>', '<description>', '<fieldPermissions>', '<hasActivationRequired>', '<label>'].map(t => text.indexOf(t));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'alphabetical, label in its place: ' + order.join(','));
  assert.ok(text.indexOf('APP_Field__c') < text.indexOf('Account_Field__c'), 'entries in plain character order, capitals first');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
});

test('duplicate entries are reported as problems', async () => {
  const uri = vscode.Uri.file(path.join(root(), 'force-app', 'main', 'default', 'permissionsets', 'Unsorted.permissionset-meta.xml'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const diags = await until(() => { const d = vscode.languages.getDiagnostics(uri); return d.length ? d : null; }, 'diagnostics');
  assert.ok(diags.some(d => /duplicate/i.test(d.message)), diags.map(d => d.message).join(' | '));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
});

// the merge editor: the extension's own panel (a webview tab), and the merged file it starts from
const editorTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputWebview && /cmrMergeEditor/.test(t.input.viewType));
const mergedFile = () => {
  const dir = path.join(root(), '.copado', 'merge');
  const s = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^s-/.test(n)) : [];
  const f = s.length ? path.join(dir, s[s.length - 1], 'MERGED__resolution.xml') : null;
  return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};

test('quick merge opens the merge editor on feature.xml merged into resolution.xml; Cancel merge closes it', async () => {
  await vscode.commands.executeCommand('cmr.quickMerge.run');
  const tab = await until(() => editorTabs()[0], 'the merge editor', 30000);
  assert.ok(/Merge \u00b7 resolution\.xml/.test(tab.label), tab.label);
  // a permission set starts from the merged result: both files' entries
  const text = await until(mergedFile, 'the merged file');
  assert.ok(text.includes('From_Feature_Class'), 'the incoming entry was added');
  assert.ok(text.includes('Resolution_Only_Class'), 'the target kept everything');
  await vscode.commands.executeCommand('cmr.cancelMerge');
  await until(() => !editorTabs().length, 'the merge editor to close');
});

test('with cmr.merge.editor set to "vscode", quick merge opens VS Code\u2019s diff view with the merged file on the right', async () => {
  const cmr = vscode.workspace.getConfiguration('cmr');
  await cmr.update('merge.editor', 'vscode', vscode.ConfigurationTarget.Workspace);
  try {
    await vscode.commands.executeCommand('cmr.quickMerge.run');
    const merged = await until(() => vscode.window.visibleTextEditors.find(e => /MERGED__resolution\.xml$/.test(e.document.fileName)), 'the merged view', 30000);
    const text = merged.document.getText();
    assert.ok(text.includes('From_Feature_Class'), 'the incoming entry was added');
    assert.ok(text.includes('Resolution_Only_Class'), 'the target kept everything');
    assert.strictEqual(editorTabs().length, 0, 'no merge editor');
    await vscode.commands.executeCommand('cmr.cancelMerge');
  } finally {
    await cmr.update('merge.editor', undefined, vscode.ConfigurationTarget.Workspace);
  }
});
