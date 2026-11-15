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
  rows: [...document.querySelectorAll('#right .zone.head:not(.l)')].map(z => z.textContent),
  buttons: [...document.querySelectorAll('.acts button')].map(b => b.title),
  ghost: document.querySelectorAll('#right .zone.ghost .gl').length,
  level: (() => { const y = s => { const l = [...document.querySelectorAll(s + ' .view-line')].find(v => /RecordTeam_cField/.test(v.textContent)); return l ? Math.round(l.getBoundingClientRect().top) : null; }; return [y('#left'), y('#right')]; })(),
  held: /Marks paused/.test(document.getElementById('stMarks').textContent), status: document.querySelector('.status').textContent, left: document.getElementById('lefthead').textContent
}));
// as you would: F7 to the next change until its button is on screen, then click it
const click = async (p, label) => {
  const sel = '.acts button[title="' + label + '"]';
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
// a choice in the toolbar's View menu, or its \u22ef menu
const menu = async (p, btn, label) => { await p.click('#' + btn); await p.click('.dmenu:not([hidden]) .mi:has-text("' + label + '")'); };
const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

ok('a block moved and another removed: removed from its place and added at the new one, linked; the left pane is the target as it is; Restore puts it back in one step; Ctrl+S saves', async () => {
  const mine = page(REG + APP + TEAM());
  await run(Object.assign({}, base, { text: mine }), async (p, h) => {
    const a = await look(p);
    assert.strictEqual(a.chips, '1 your edit2 removed');
    assert.ok(/^Removed \u00b7 now at line \d+$/.test(a.rows[0]) && a.rows.includes('Removed') && a.rows.some(r => /^Added by you \u00b7 from line \d+$/.test(r)), JSON.stringify(a.rows));
    assert.ok(!a.rows.some(r => /Moved/.test(r)) && !a.buttons.includes('Move back'), 'no moves');
    assert.deepStrictEqual(a.buttons, ['Restore', 'Restore', 'Undo']);
    assert.strictEqual(await p.evaluate(() => window.monaco.editor.getEditors().find(e => e.getOption(window.monaco.editor.EditorOption.readOnly)).getValue()), T, 'the left pane is the target, as it is');
    await shot(p, 'merge-editor-dark.png');
    // the linked Restore: back at its place, and the copy gone - one step
    await p.click('.acts button[title="Restore"]');
    await eventually(() => assert.strictEqual(h.text(), page(TEAM() + REG + APP), 'back where it was, the copy gone'));
    await click(p, 'Restore');
    await eventually(() => assert.strictEqual(h.text(), T, 'the target exactly'));
    await eventually(async () => assert.strictEqual((await look(p)).chips, 'the same as the target'));
    await p.click('#right .view-lines');
    for (let i = 0; i < 2; i++) { await p.keyboard.press('Control+z'); await p.waitForTimeout(150); }
    await eventually(() => assert.strictEqual(h.text(), mine, 'Ctrl+Z twice: what you had'));
    await p.keyboard.press('Control+s');
    await eventually(() => assert.ok(h.sent.some(m => m.type === 'save' && m.text === mine && !m.close)));
    assert.deepStrictEqual(h.errors, []);
  });
});


ok('typing: compared again as you go; broken XML pauses the marks', async () => {
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
      assert.deepStrictEqual(a.rows, ['Edited']);
    });
    // break the XML: the marks hold, and it says so
    await p.keyboard.type('<');
    await eventually(async () => assert.ok((await look(p)).held, 'paused'));
    await p.keyboard.press('Backspace');
    await eventually(async () => { const a = await look(p); assert.ok(!a.held && a.chips === '1 your edit', JSON.stringify(a.chips)); });
    assert.ok(!/in your order|as it is/.test((await look(p)).left), 'the target is shown as it is - there is no other order');
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
    assert.deepStrictEqual(a.rows, ['Kept \u00b7 not in feature', 'Kept \u00b7 not in feature']);
    assert.deepStrictEqual(a.buttons, ['Remove', 'Remove']);
    await shot(p, 'merge-editor-not-in-feature.png');
    // the first taken out: now out of your resolution, and not in the feature branch either - Restore
    await click(p, 'Remove'); await eventually(async () => assert.deepStrictEqual((await look(p)).buttons, ['Restore', 'Remove']));
    await click(p, 'Remove');
    await eventually(() => assert.strictEqual(h.text(), PF, 'Remove twice: the feature branch\u2019s version'));
    // Start from: the target, in one step; Ctrl+Z goes back
    await menu(p, 'viewBtn', 'Target branch (HEAD)');
    await eventually(() => assert.strictEqual(h.text(), PT));
    // the menu leaves you in the editor: Ctrl+Z straight away
    assert.ok(await p.evaluate(() => !!document.activeElement.closest('#right')), 'still in the editor');
    await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), PF, 'Ctrl+Z: back to what you had'));
    assert.deepStrictEqual(h.errors, []);
  });
  await run(Object.assign({}, qa, { text: PF, start: 'feature' }), async (p, h) => {
    const a = await look(p);
    assert.deepStrictEqual(a.rows, ['Not in feature', 'Not in feature']);
    assert.deepStrictEqual(a.buttons, ['Restore', 'Restore']);
    await p.click('#viewBtn');
    assert.strictEqual(await p.$$eval('#viewMenu .mi', m => m.map(x => x.textContent).join(' | ')), '\u25cfThe feature branch | \u25cbTarget branch (HEAD) | \u25cbMerged (both) | Hide identical lines', 'Start from and the view, in one menu');
    await p.keyboard.press('Escape');
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
    await menu(p, 'moreBtn', 'Keyboard shortcuts'); await p.waitForTimeout(100);
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
    }));
    const level = id => p.evaluate(id => { const y = s => { const l = [...document.querySelectorAll(s + ' .view-line')].find(v => v.textContent.includes(id)); return l ? Math.round(l.getBoundingClientRect().top) : null; }; return [y('#left'), y('#right')]; }, id);
    assert.deepStrictEqual((await folds()).right, [], 'off to start with');
    await menu(p, 'viewBtn', 'Hide identical lines');
    await eventually(async () => {
      const f = await folds();
      assert.ok(f.right.length >= 2 && f.right.length === f.left, 'folded on both sides: ' + JSON.stringify(f));
      // every row actually shown, in its place - not only in the page
      const shown = await p.evaluate(() => ['#left', '#right'].map(s => [...document.querySelectorAll(s + ' .zone.fold')].filter(z => { const r = z.getBoundingClientRect(); return r.height > 0 && z.parentElement && getComputedStyle(z.parentElement).display !== 'none'; }).length));
      assert.deepStrictEqual(shown, [f.left, f.right.length], 'every fold row shown');
      assert.ok(f.right.every(t => /^\d+ hidden lines$/.test(t)), JSON.stringify(f.right));
      assert.strictEqual(await p.$$eval('#right .fold-m svg', x => x.length), f.right.length, 'the expand arrows in the line-number column');
    });
    await eventually(() => assert.ok(h.sent.some(m => m.type === 'pref' && m.hideIdentical === true), 'remembered'));
    // the first change, its rows and its context, level in both panes
    await eventually(async () => {
      const a = await look(p);
      assert.ok(a.rows.includes('Edited'), JSON.stringify(a.rows));
      const lv = await level('RecordF9_cField');
      assert.ok(lv[0] != null && lv[0] === lv[1], 'the changed field level in both panes: ' + lv);
    });
    const hidden = (await folds()).right.reduce((n, t) => n + +/(\d+) hidden/.exec(t)[1], 0);
    assert.ok(hidden > 300, hidden + ' lines folded of ' + LM.split('\n').length);
    // F7 to the second change: visible
    await p.click('#right .view-lines'); await p.keyboard.press('F7'); await p.keyboard.press('F7');
    await eventually(async () => { const lv = await level('RecordF32_cField'); assert.ok(lv[0] != null && lv[0] === lv[1], 'second change level: ' + lv); });
    // Show opens one run
    const before = (await folds()).right.length;
    // a click anywhere on the bar shows its lines
    await p.click('#right .rowclick');
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
    await menu(p, 'viewBtn', 'Hide identical lines');
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

ok('a duplicate you add is marked on its lines - a row, a margin mark, an underline, no pop-up - and removed with one click; broken XML underlined while what you type stays marked', async () => {
  await run(Object.assign({}, base, { text: T }), async (p, h) => {
    // copy the Region block's value list item... here: a whole field block, pasted again below the last one
    const extra = blk('readonly', 'Region__c', 'Region_cField');
    await p.click('#right .view-lines'); await p.keyboard.press('Control+End');
    const lines = h.text().split('\n');
    const at = lines.findIndex(l => l.includes('<name>main</name>')) + 1;
    await p.keyboard.press('Control+g'); await p.waitForTimeout(200); await p.keyboard.type(String(at)); await p.keyboard.press('Enter');
    await p.keyboard.press('Home');
    await p.evaluate(t => { const ed = window.monaco.editor.getEditors().find(e => !e.getOption(window.monaco.editor.EditorOption.readOnly)); const pos = ed.getPosition(); ed.executeEdits('t', [{ range: new window.monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1), text: t }]); }, extra);
    await eventually(async () => {
      const a = await look(p);
      assert.ok(a.rows.some(r => /^Added by you \u00b7 Duplicate of line \d+$/.test(r)), 'one row for both: ' + JSON.stringify(a.rows));
      assert.deepStrictEqual(a.buttons, ['Undo', 'Remove copy'], 'both actions side by side');
      assert.ok(await p.$('#right .dup-glyph') && await p.$('#right .squiggly-warning'), 'a margin mark and an underline');
      assert.ok(/\u26a0 1 duplicate/.test(a.status), a.status);
    });
    assert.strictEqual(await p.$('.monaco-hover:not(.hidden)'), null, 'no pop-up');
    await p.evaluate(() => { const ed = window.monaco.editor.getEditors().find(e => !e.getOption(window.monaco.editor.EditorOption.readOnly)); const d = document.querySelector('#right .dup-glyph'); if (ed) ed.revealLineInCenter(ed.getModel().getLineCount() - 8); });
    await p.waitForTimeout(300);
    await shot(p, 'merge-editor-duplicate.png');
    await click(p, 'Remove copy');
    await eventually(() => assert.strictEqual(h.text(), T, 'removed: back to the target exactly'));
    // break the XML: underlined where it breaks, what you type keeps a dotted margin
    await p.click('#right .view-lines'); await p.keyboard.press('Control+Home'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('End');
    await p.keyboard.type('<broken>');
    await eventually(async () => {
      const a = await look(p);
      assert.ok(/Marks paused \u2013 not valid XML at line \d+/.test(a.status), a.status);
      assert.ok(await p.$('#right .squiggly-error'), 'underlined where it breaks');
      assert.ok(await p.$('#right .typed-g'), 'what you typed keeps a dotted margin');
    });
    await p.keyboard.press('Control+z');
    await eventually(async () => assert.ok(/Marks live/.test((await look(p)).status)));
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('a button whose lines you just changed does nothing, and says so; one Save and close; every button the same drawn icon', async () => {
  const mine = page(TEAM('required') + REG + APP + OWN);
  await run(Object.assign({}, base, { text: mine }), async (p, h) => {
    assert.deepStrictEqual(await p.$$eval('.top button', bs => bs.map(b => b.id)), ['prev', 'next', 'viewBtn', 'saveClose', 'moreBtn'], 'Save & Close, no Save button; More at the far right');
    assert.strictEqual(await p.$eval('#saveClose', b => b.textContent), 'Save & Close');
    assert.ok(/^\d+ of \d+$/.test(await p.$eval('#pos', e => e.textContent)), 'where you are among the changes');
    const icons = await p.$$eval('.acts .ib', bs => bs.map(b => { const s = b.querySelector('svg'); return s ? [s.getAttribute('width'), b.textContent] : null; }));
    assert.ok(icons.length && icons.every(i => i && i[0] === '14' && i[1]), 'an icon and its word: ' + JSON.stringify(icons));
    // change the edited line, and click its Use target before the marks catch up
    await p.evaluate(() => {
      const ed = window.monaco.editor.getEditors().find(e => !e.getOption(window.monaco.editor.EditorOption.readOnly));
      const m = ed.getModel(), n = m.getLinesContent().findIndex(l => l.includes('<value>required</value>')) + 1;
      ed.executeEdits('t', [{ range: new window.monaco.Range(n, 1, n, m.getLineMaxColumn(n)), text: '                    <value>edit</value>' }]);
      document.querySelector('.acts button[title="Use target"]').click();
    });
    await eventually(async () => assert.ok(/Those lines have changed since they were marked - nothing was done/.test(await p.$eval('#note', n => n.textContent))));
    assert.ok(h.text().includes('<value>edit</value>') || (await p.evaluate(() => window.monaco.editor.getEditors().some(e => e.getValue().includes('<value>edit</value>')))), 'nothing was done');
    assert.deepStrictEqual(h.errors, []);
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
