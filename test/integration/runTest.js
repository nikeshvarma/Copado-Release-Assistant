// Runs the integration suite inside a real VS Code, downloaded by @vscode/test-electron.
//   npm install --no-save @vscode/test-electron
//   npm run test:vscode            (on Linux CI: xvfb-run -a npm run test:vscode)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

(async () => {
  // a fresh copy of the fixture project, so a run never changes the checked-in files
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cra-it-'));
  fs.cpSync(path.join(__dirname, 'workspace'), work, { recursive: true });
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
      launchArgs: [work, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
    });
  } catch (e) {
    console.error('Integration tests failed: ' + (e && e.message ? e.message : e));
    process.exit(1);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
