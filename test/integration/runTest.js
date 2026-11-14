// Runs the integration suite inside a real VS Code, downloaded by @vscode/test-electron.
//   npm install --no-save @vscode/test-electron
//   npm run test:vscode            (on Linux CI: xvfb-run -a npm run test:vscode)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { vscodeExecutable } = require('./vscodeExecutable');

(async () => {
  // a fresh copy of the fixture project, so a run never changes the checked-in files
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cra-it-'));
  fs.cpSync(path.join(__dirname, 'workspace'), work, { recursive: true });
  try {
    // downloaded here, so the program can be found where this VS Code build keeps it (test/integration/vscodeExecutable.js)
    const exe = vscodeExecutable(await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable'));
    console.log('VS Code: ' + exe);
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
      launchArgs: [work, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
    });
  } catch (e) {
    console.error('Integration tests failed: ' + (e && e.message ? e.message : e));
    process.exit(1);
  } finally {
    // VS Code may still hold a file there for a moment on Windows: retried, and never failing a passed run
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.log('left behind: ' + work); }
  }
})();
