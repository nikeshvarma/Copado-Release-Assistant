// A tiny test runner for the VS Code extension host - no mocha needed.
const path = require('path');
const fs = require('fs');

exports.run = async function () {
  const tests = [];
  global.test = (name, fn) => tests.push({ name, fn });
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok  ' + t.name); } catch (e) { failed++; console.log('  FAIL ' + t.name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); }
  }
  console.log('\n' + (tests.length - failed) + ' of ' + tests.length + ' integration checks passed');
  if (failed) throw new Error(failed + ' integration check(s) failed');
};
