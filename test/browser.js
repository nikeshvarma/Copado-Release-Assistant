'use strict';
/**
 * The merge editor's page in a real browser, with the real Monaco: what you
 * see and what the buttons do. Needs Playwright (set PLAYWRIGHT to its path);
 * without it, says so and stops. Run: node test/browser.js [shots-folder]
 */
const assert = require('assert');
const fs = require('fs'), path = require('path');
let run;
try { run = require('./browserHarness').run; } catch (e) {
  // in CI the job installs it; anywhere else, say so rather than fail - unless asked to insist
  console.log('skipped: Playwright is not available (' + e.message.split('\n')[0] + ')');
  process.exit(process.env.CI_REQUIRE_BROWSER ? 1 : 0);
}
const shots = process.argv[2] || null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = (p, n) => shots ? p.screenshot({ path: path.join(shots, n) }) : null;

const blk = (beh, f, id) => '        <itemInstances>\n            <fieldInstance>\n                <fieldInstanceProperties>\n                    <name>uiBehavior</name>\n                    <value>' + beh + '</value>\n                </fieldInstanceProperties>\n                <fieldItem>Record.' + f + '</fieldItem>\n                <identifier>Record' + id + '</identifier>\n            </fieldInstance>\n        </itemInstances>\n';
const page = body => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n' + body + '        <name>main</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
const TEAM = (b = 'none') => blk(b, 'Team__c', 'Team_cField'), REG = blk('readonly', 'Region__c', 'Region_cField'), APP = blk('readonly', 'Data_App__c', 'Data_App_cField'), OWN = blk('edit', 'Owner__c', 'Owner_cField');
const T = page(TEAM() + REG + APP + OWN);
const base = { file: 'Account_Record_Page.flexipage-meta.xml', labels: { target: 'Target branch (HEAD)', merged: 'Your resolution' }, theirs: 'the feature branch', short: 'the feature', typeName: 'FlexiPage', target: T, incoming: T };
const look = p => p.evaluate(() => ({
  chips: document.querySelector('#chips').textContent,
  rows: [...document.querySelectorAll('#right .zone.head')].map(z => z.textContent),
  buttons: [...document.querySelectorAll('.acts button')].map(b => b.textContent),
  ghost: document.querySelectorAll('#right .zone.ghost .gl').length,
  level: (() => { const y = s => { const l = [...document.querySelectorAll(s + ' .view-line')].find(v => /RecordTeam_cField/.test(v.textContent)); return l ? Math.round(l.getBoundingClientRect().top) : null; }; return [y('#left'), y('#right')]; })(),
  held: !document.getElementById('held').hidden, mode: document.getElementById('mode').textContent, left: document.getElementById('lefthead').textContent
}));
// as you would: F7 to the next change until its button is on screen, then click it
const click = async (p, label) => {
  const sel = '.acts button:text-is("' + label + '")';
  for (let i = 0; i < 8; i++) {
    const seen = await p.$eval(sel, b => { const r = b.getBoundingClientRect(), e = document.getElementById('right').getBoundingClientRect(); return r.top >= e.top && r.bottom <= e.bottom; }).catch(() => false);
    if (seen) break;
    await p.click('#right .view-lines'); await p.keyboard.press('F7'); await p.waitForTimeout(200);
  }
  await p.click(sel); await p.waitForTimeout(700);
};
// what you do takes a moment to reach the extension and come back - longer on a busy CI machine: a check
// is tried again until it holds, or the time is up and its last failure is the answer
async function eventually(fn, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) {
    try { return await fn(); } catch (e) { if (Date.now() > end) throw e; }
    await new Promise(r => setTimeout(r, 100));
  }
}
const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

ok('moved and edited, and a block removed: lined up, struck through, every button one undoable edit; Ctrl+S saves', async () => {
  const mine = page(REG + APP + TEAM('required'));
  await run(Object.assign({}, base, { text: mine }), async (p, h) => {
    const a = await look(p);
    assert.strictEqual(a.chips, '1 moved1 your edit1 removed');
    assert.deepStrictEqual(a.rows, ['\u21b6Removed: fieldInstance RecordOwner_cField (10 lines)', '\u2195Moved: fieldInstance RecordTeam_cField \u00b7 1st \u2192 3rd', '\u270eYour edit: uiBehavior: none \u2192 required']);
    assert.deepStrictEqual(a.buttons, ['Restore', 'Move back', 'Use target']);
    assert.strictEqual(a.ghost, 10, 'the removed block, struck through, line for line');
    assert.ok(a.level[0] != null && a.level[0] === a.level[1], 'the moved block level in both panes: ' + a.level);
    await shot(p, 'merge-editor-dark.png');
    await click(p, 'Restore'); await eventually(async () => assert.ok((await look(p)).buttons.includes('Move back')));
    await click(p, 'Move back'); await eventually(async () => assert.deepStrictEqual((await look(p)).buttons, ['Use target']));
    await click(p, 'Use target');
    await eventually(() => assert.strictEqual(h.text(), T, 'the target exactly'));
    await eventually(async () => assert.strictEqual((await look(p)).chips, 'the same as the target'));
    await p.click('#right .view-lines');
    for (let i = 0; i < 3; i++) { await p.keyboard.press('Control+z'); await p.waitForTimeout(150); }
    await eventually(() => assert.strictEqual(h.text(), mine, 'Ctrl+Z three times: what you had'));
    await p.keyboard.press('Control+s');
    await eventually(() => assert.ok(h.sent.some(m => m.type === 'save' && m.text === mine && !m.close)));
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('typing: compared again as you go; broken XML pauses the marks; Literal order shows the target as it is', async () => {
  await run(Object.assign({}, base, { text: T }), async (p, h) => {
    assert.strictEqual((await look(p)).chips, 'the same as the target');
    // select a value and type over it
    await p.click('#right .view-lines');
    await p.keyboard.press('Control+Home');
    for (let i = 0; i < 7; i++) await p.keyboard.press('ArrowDown');
    await p.keyboard.press('End'); for (let i = 0; i < 8; i++) await p.keyboard.press('ArrowLeft');
    for (let i = 0; i < 4; i++) await p.keyboard.press('Backspace');
    await p.keyboard.type('edit');
    await eventually(async () => {
      const a = await look(p);
      assert.strictEqual(a.chips, '1 your edit', a.chips + ' ' + h.text().split('\n')[7]);
      assert.ok(a.rows.some(r => /uiBehavior: none \u2192 edit/.test(r)), JSON.stringify(a.rows));
    });
    // break the XML: the marks hold, and it says so
    await p.keyboard.type('<');
    await eventually(async () => assert.ok((await look(p)).held, 'paused'));
    await p.keyboard.press('Backspace');
    await eventually(async () => { const a = await look(p); assert.ok(!a.held && a.chips === '1 your edit', JSON.stringify(a.chips)); });
    await p.click('#mode');
    await eventually(async () => { const a = await look(p); assert.ok(/as it is/.test(a.left) && /In your order/.test(a.mode), a.left + ' / ' + a.mode); });
    assert.deepStrictEqual(h.errors, []);
  });
});

// the highlights panel's actions: the target has five; the feature branch removed two
const act = (v, rule) => '                        <valueListItems>\n                            <value>' + v + '</value>\n' + (rule ? '                            <visibilityRule>\n                                <criteria>\n                                    <leftValue>{!Record.IsClosed}</leftValue>\n                                    <operator>EQUAL</operator>\n                                    <rightValue>false</rightValue>\n                                </criteria>\n                            </visibilityRule>\n' : '') + '                        </valueListItems>\n';
const panelPage = acts => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + acts.map(a => act(a[0], a[1])).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <componentName>force:highlightsPanel</componentName>\n                <identifier>force_highlightsPanel_with_a_rather_long_identifier_so_the_line_runs_off_to_the_right_of_the_pane_and_scrolls</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
const PT = panelPage([['Edit'], ['NewCase', true], ['LogACall', true], ['Delete'], ['Clone']]), PF = panelPage([['Edit'], ['Delete'], ['Clone']]);
const both = PT;   // what merging keeps: everything the target has
const qa = Object.assign({}, base, { file: 'Case_Record_Page.flexipage-meta.xml', target: PT, incoming: PF, starts: { merged: both, feature: PF, target: PT } });

ok('what the feature branch removed is marked, whatever the start: still here - Remove; started from the feature - Restore; Start from switches in one undoable step', async () => {
  await run(Object.assign({}, qa, { text: both, start: 'merged' }), async (p, h) => {
    let a = await look(p);
    assert.strictEqual(a.chips, '2 not taken from the feature');
    assert.deepStrictEqual(a.rows, ['\u2212Not in the feature branch \u00b7 still here: valueListItems: NewCase (10 lines)', '\u2212Not in the feature branch \u00b7 still here: valueListItems: LogACall (10 lines)']);
    assert.deepStrictEqual(a.buttons, ['Remove', 'Remove']);
    await shot(p, 'merge-editor-not-in-feature.png');
    // the first taken out: now out of your resolution, and not in the feature branch either - Restore
    await click(p, 'Remove'); await eventually(async () => assert.deepStrictEqual((await look(p)).buttons, ['Restore', 'Remove']));
    await click(p, 'Remove');
    await eventually(() => assert.strictEqual(h.text(), PF, 'Remove twice: the feature branch\u2019s version'));
    // Start from: the target, in one step; Ctrl+Z goes back
    await p.selectOption('#startFrom', 'target');
    await eventually(() => assert.strictEqual(h.text(), PT));
    await p.click('#right .view-lines'); await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), PF, 'Ctrl+Z: back to what you had'));
    assert.deepStrictEqual(h.errors, []);
  });
  await run(Object.assign({}, qa, { text: PF, start: 'feature' }), async (p, h) => {
    const a = await look(p);
    assert.deepStrictEqual(a.rows, ['\u21b6Not in the feature branch: valueListItems: NewCase (10 lines)', '\u21b6Not in the feature branch: valueListItems: LogACall (10 lines)']);
    assert.deepStrictEqual(a.buttons, ['Restore', 'Restore']);
    assert.strictEqual(await p.$eval('#startFrom', s => [...s.options].map(o => o.textContent).join(' | ')), 'The feature branch | Target branch (HEAD) | Merged (both)');
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('cut, copy and paste through VS Code\u2019s clipboard - never twice, even when VS Code also passes the keystroke on; once each in the right-click menu', async () => {
  await run(Object.assign({}, base, { text: T }), async (p, h) => {
    await p.click('#right .view-lines');
    await p.keyboard.press('Control+Home');
    // nothing selected: Ctrl+C copies the whole line, as in VS Code
    await p.keyboard.press('Control+c');
    await eventually(() => assert.strictEqual(h.clip(), '<?xml version="1.0" encoding="UTF-8"?>\n'));
    // a selection: just that
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Home'); await p.keyboard.press('Shift+End');
    await p.keyboard.press('Control+c');
    await eventually(() => assert.strictEqual(h.clip(), '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">'));
    // paste once at the end of the line, even with a native paste arriving too
    await p.keyboard.press('End'); h.setClip('<!-- pasted -->');
    await p.keyboard.press('Control+v');
    await eventually(() => assert.strictEqual(h.text().split('\n')[1], '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata"><!-- pasted -->', 'pasted once'));
    await p.waitForTimeout(600);
    assert.strictEqual(h.text().split('\n')[1], '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata"><!-- pasted -->', 'and still once a moment later');
    // cut: the line goes to the clipboard and out of the file
    await p.keyboard.press('Control+x');
    await eventually(() => {
      assert.strictEqual(h.clip(), '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata"><!-- pasted -->\n');
      assert.ok(!h.text().includes('<!-- pasted -->') && h.text().split('\n')[1] === '    <flexiPageRegions>', 'cut one line, not two');
    });
    // the left pane copies too
    h.setClip(null);
    await p.click('#left .view-lines'); await p.keyboard.press('Control+Home'); await p.keyboard.press('Control+c');
    await eventually(() => assert.strictEqual(h.clip(), '<?xml version="1.0" encoding="UTF-8"?>\n'));
    // the right-click menu: Cut, Copy, Paste once each
    await p.click('#right .view-lines', { button: 'right' });
    await eventually(async () => assert.deepStrictEqual(await p.evaluate(() => [...document.querySelectorAll('#menu:not([hidden]) .mi span:first-child')].map(e => e.textContent)), ['Cut', 'Copy', 'Paste', 'Select all', 'Find']));
    // Paste from the menu, once
    h.setClip('<!-- menu -->');
    await p.click('#menu .mi:has-text("Paste")');
    await eventually(() => assert.strictEqual(h.text().split('\n').filter(l => l.includes('<!-- menu -->')).length, 1, 'pasted from the menu, once'));
    await p.keyboard.press('Escape');
    assert.deepStrictEqual(h.errors, []);
  }, { nativeToo: true });
});

ok('a click on a row between lines - struck-through lines, a change\u2019s header - puts you in the editor on the line after it', async () => {
  await run(Object.assign({}, qa, { text: PF, start: 'feature' }), async (p, h) => {
    const z = await (await p.$('#right .zone.ghost')).boundingBox();
    await p.mouse.click(z.x + 100, z.y + 10); await p.waitForTimeout(200);
    await p.keyboard.type('x');
    await eventually(() => assert.notStrictEqual(h.text(), PF, 'typing went into the file'));
  });
});

ok('horizontal scrolling in step, as vertical; and the editor\u2019s own keys: move a line, delete a line, comment out, find', async () => {
  await run(Object.assign({}, qa, { text: PF, start: 'feature' }), async (p, h) => {
    await p.mouse.move(1000, 400); await p.keyboard.down('Shift'); await p.mouse.wheel(0, 300); await p.keyboard.up('Shift');
    await eventually(async () => {
      const lefts = await p.evaluate(() => ['#left', '#right'].map(s => [...document.querySelectorAll(s + ' .lines-content')].map(e => e.style.left)[0]));
      assert.ok(lefts[0] === lefts[1] && lefts[1] && lefts[1] !== '0px', 'both panes scrolled across together: ' + JSON.stringify(lefts));
    });
    await p.click('#right .view-lines'); await p.waitForTimeout(200); await p.keyboard.press('Control+Home');
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
    const L = () => h.text().split('\n');
    const third = L()[2];
    await p.keyboard.press('Alt+ArrowDown');
    await eventually(() => assert.strictEqual(L()[3], third, 'Alt+Down moved the line'));
    await p.keyboard.press('Control+Shift+K');
    await eventually(() => assert.ok(!L().includes(third), 'Ctrl+Shift+K deleted it'));
    await p.keyboard.press('Control+/');
    await eventually(() => assert.ok(/^\s*<!--.*-->$/.test(L()[3]), 'Ctrl+/ commented it out: ' + L()[3]));
    await p.keyboard.press('Control+f');
    await eventually(async () => assert.ok(await p.$('#right .find-widget.visible'), 'Ctrl+F: find'));
    await p.keyboard.press('Escape');
    await p.click('#keys'); await p.waitForTimeout(100);
    assert.ok(/Ctrl.*X.*Ctrl.*C.*Ctrl.*V/.test(await p.$eval('#help', e => e.textContent)), 'the shortcuts list');
  });
});

ok('Hide identical: runs of identical lines folded on both sides, the panes level, context kept around each change; Show and the cursor open a run; remembered', async () => {
  // a long page: forty fields, two of them changed far apart
  const many = n => Array.from({ length: n }, (_, i) => blk(i === 9 || i === 32 ? 'required' : 'readonly', 'F' + i + '__c', 'F' + i + '_cField')).join('');
  const LT = page(Array.from({ length: 40 }, (_, i) => blk('readonly', 'F' + i + '__c', 'F' + i + '_cField')).join('')), LM = page(many(40));
  await run(Object.assign({}, base, { target: LT, incoming: LT, text: LM }), async (p, h) => {
    const folds = () => p.evaluate(() => ({
      right: [...document.querySelectorAll('#right .zone.fold')].map(z => z.textContent),
      left: document.querySelectorAll('#left .zone.fold').length,
      button: document.getElementById('hide').textContent
    }));
    const level = id => p.evaluate(id => { const y = s => { const l = [...document.querySelectorAll(s + ' .view-line')].find(v => v.textContent.includes(id)); return l ? Math.round(l.getBoundingClientRect().top) : null; }; return [y('#left'), y('#right')]; }, id);
    assert.deepStrictEqual((await folds()).right, [], 'off to start with');
    await p.click('#hide');
    await eventually(async () => {
      const f = await folds();
      assert.ok(f.right.length >= 2 && f.right.length === f.left, 'folded on both sides: ' + JSON.stringify(f));
      // every row actually shown, in its place - not only in the page
      const shown = await p.evaluate(() => ['#left', '#right'].map(s => [...document.querySelectorAll(s + ' .zone.fold')].filter(z => { const r = z.getBoundingClientRect(); return r.height > 0 && z.parentElement && getComputedStyle(z.parentElement).display !== 'none'; }).length));
      assert.deepStrictEqual(shown, [f.left, f.right.length], 'every fold row shown');
      assert.ok(f.right.every(t => /^\u22ef\d+ identical lines$/.test(t)), JSON.stringify(f.right));
      assert.strictEqual(f.button, '\u2261 Show identical');
    });
    await eventually(() => assert.ok(h.sent.some(m => m.type === 'pref' && m.hideIdentical === true), 'remembered'));
    // the first change, its rows and its context, level in both panes
    await eventually(async () => {
      const a = await look(p);
      assert.ok(a.rows.some(r => /uiBehavior: readonly \u2192 required/.test(r)), JSON.stringify(a.rows));
      const lv = await level('RecordF9_cField');
      assert.ok(lv[0] != null && lv[0] === lv[1], 'the changed field level in both panes: ' + lv);
    });
    const hidden = (await folds()).right.reduce((n, t) => n + +/\d+/.exec(t)[0], 0);
    assert.ok(hidden > 300, hidden + ' lines folded of ' + LM.split('\n').length);
    // F7 to the second change: visible
    await p.click('#right .view-lines'); await p.keyboard.press('F7'); await p.keyboard.press('F7');
    await eventually(async () => { const lv = await level('RecordF32_cField'); assert.ok(lv[0] != null && lv[0] === lv[1], 'second change level: ' + lv); });
    // Show opens one run
    const before = (await folds()).right.length;
    await click(p, 'Show');
    await eventually(async () => assert.strictEqual((await folds()).right.length, before - 1, 'one run opened'));
    // the cursor onto a folded line opens its run: Ctrl+G to a line near the end, inside the last run
    await p.click('#right .view-lines'); await p.keyboard.press('Control+g'); await p.waitForTimeout(300);
    await p.keyboard.type(String(LM.split('\n').length - 6)); await p.keyboard.press('Enter');
    await eventually(async () => assert.strictEqual((await folds()).right.length, before - 2, 'Ctrl+G opened the last run'));
    // and a find match inside a folded run opens it
    const left = (await folds()).right.length;
    await p.click('#right .view-lines'); await p.keyboard.press('Control+f'); await p.waitForTimeout(300);
    await p.keyboard.type('RecordF20_cField'); await p.keyboard.press('Enter'); await p.keyboard.press('Escape');
    await eventually(async () => assert.strictEqual((await folds()).right.length, left - 1, 'Ctrl+F opened the run holding the match'));
    // off again: nothing folded
    await p.click('#hide');
    await eventually(async () => assert.deepStrictEqual((await folds()).right, []));
    await eventually(() => assert.ok(h.sent.some(m => m.type === 'pref' && m.hideIdentical === false)));
    assert.deepStrictEqual(h.errors, []);
    await shot(p, 'merge-editor-hidden.png');
  });
  // opened with it on: folded from the start, from the first change
  await run(Object.assign({}, base, { target: LT, incoming: LT, text: LM, hideIdentical: true }), async (p, h) => {
    await eventually(async () => assert.ok((await p.evaluate(() => document.querySelectorAll('#right .zone.fold').length)) >= 2));
    await shot(p, 'merge-editor-hide-identical.png');
  });
});

ok('the light theme', async () => {
  const mine = page(REG + APP + TEAM('required'));
  await run(Object.assign({}, base, { text: mine }), async (p, h) => {
    const bg = await p.evaluate(() => getComputedStyle(document.querySelector('#right .monaco-editor-background, #right .monaco-editor')).backgroundColor);
    assert.ok(/255, 255, 255/.test(bg), 'Monaco takes VS Code\u2019s colours: ' + bg);
    await shot(p, 'merge-editor-light.png');
    assert.deepStrictEqual(h.errors, []);
  }, { light: true });
});

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n      ' + (e && e.message || e)); }
  }
  console.log((checks.length - failed) + ' browser checks passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})();
