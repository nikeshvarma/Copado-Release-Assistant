'use strict';
/**
 * The VS Code program to start, from where @vscode/test-electron says it is. On macOS that is
 * "<app>/Contents/MacOS/Electron" - but newer VS Code builds name it otherwise, so when that file is not
 * there, the program actually in Contents/MacOS is used: the one named for VS Code, else the largest.
 * Anywhere else, or when the file is there, the path is returned as it is.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAMES = ['Electron', 'Code', 'Visual Studio Code', 'Code - Insiders'];

function vscodeExecutable(exe, platform) {
  if ((platform || process.platform) !== 'darwin' || fs.existsSync(exe)) return exe;
  const dir = path.dirname(exe);
  let names;
  try { names = fs.readdirSync(dir).filter(n => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch (e) { return false; } }); } catch (e) { return exe; }
  const named = NAMES.find(n => names.includes(n)) || names.find(n => /code/i.test(n));
  if (named) return path.join(dir, named);
  if (!names.length) return exe;
  // the app's main program is by far its largest file there
  const size = n => { try { return fs.statSync(path.join(dir, n)).size; } catch (e) { return 0; } };
  return path.join(dir, names.slice().sort((a, b) => size(b) - size(a))[0]);
}

/**
 * A short folder for VS Code's user data. VS Code opens a socket in it ("<dir>/1.14-main.sock"), and on
 * macOS a socket path may be at most 103 characters - the test runner's default, inside the checkout,
 * is longer on CI. So under /tmp on macOS (its os.tmpdir() is itself long), the system's temp folder elsewhere.
 */
function userDataDir(platform) {
  const base = (platform || process.platform) === 'darwin' ? '/tmp' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'cra-ud-'));
}

module.exports = { vscodeExecutable, userDataDir };
