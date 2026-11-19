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
  counter: document.getElementById('pos').textContent,
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
const ok = (name, fn) => { if (!process.env.ONLY || name.includes(process.env.ONLY)) checks.push([name, fn]); };

ok('a block moved and another removed: removed from its place and added at the new one, linked; the left pane is the target as it is; Restore puts it back in one step; Ctrl+S saves', async () => {
  const mine = page(REG + APP + TEAM());
  await run(Object.assign({}, base, { text: mine }), async (p, h) => {
    const a = await look(p);
    assert.strictEqual(a.chips, '1 your edit2 removed');
    // the kind, and nothing more after it
    assert.deepStrictEqual(a.rows, ['Removed', 'Removed', 'Added by you']);
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
    assert.deepStrictEqual(h.errors, []);
  });
});

// the highlights panel's actions: the target has five; the feature branch removed two
const act = (v, rule) => '                        <valueListItems>\n                            <value>' + v + '</value>\n' + (rule ? '                            <visibilityRule>\n                                <criteria>\n                                    <leftValue>{!Record.IsClosed}</leftValue>\n                                    <operator>EQUAL</operator>\n                                    <rightValue>false</rightValue>\n                                </criteria>\n                            </visibilityRule>\n' : '') + '                        </valueListItems>\n';
const panelPage = acts => '<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">\n    <flexiPageRegions>\n        <itemInstances>\n            <componentInstance>\n                <componentInstanceProperties>\n                    <name>actionNames</name>\n                    <valueList>\n' + acts.map(a => act(a[0], a[1])).join('') + '                    </valueList>\n                </componentInstanceProperties>\n                <componentName>force:highlightsPanel</componentName>\n                <identifier>force_highlightsPanel_with_a_rather_long_identifier_so_the_line_runs_off_to_the_right_of_the_pane_and_scrolls</identifier>\n            </componentInstance>\n        </itemInstances>\n        <name>header</name>\n    </flexiPageRegions>\n</FlexiPage>\n';
const PT = panelPage([['Edit'], ['NewCase', true], ['LogACall', true], ['Delete'], ['Clone']]), PF = panelPage([['Edit'], ['Delete'], ['Clone']]);
const both = PT;   // what merging keeps: everything the target has
const qa = Object.assign({}, base, { file: 'Case_Record_Page.flexipage-meta.xml', target: PT, incoming: PF, starts: { merged: both, feature: PF, target: PT } });

ok('what the feature branch removed is marked, whatever the start: still here - Remove; started from the feature - Restore; no Start from to choose - one start', async () => {
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
    assert.deepStrictEqual(h.errors, []);
  });
  await run(Object.assign({}, qa, { text: PF, start: 'feature' }), async (p, h) => {
    const a = await look(p);
    assert.deepStrictEqual(a.rows, ['Not in feature', 'Not in feature']);
    assert.deepStrictEqual(a.buttons, ['Restore', 'Restore']);
    await p.click('#viewBtn');
    assert.strictEqual(await p.$$eval('#viewMenu .mi', m => m.map(x => x.textContent).join(' | ')), 'Word wrap | Zoom in | Zoom out | Reset zoom | Hide identical lines', 'no Start from');
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
    // a stray closing tag: typing an opening tag would be closed for you
    await p.keyboard.type('</broken>');
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

ok('the find and replace boxes keep their own copy and paste: Ctrl+V pastes into the box, never into the file; Ctrl+C copies from it', async () => {
  await run(Object.assign({}, base, { text: T }), async (p, h) => {
    await p.click('#right .view-lines');
    await p.evaluate(() => navigator.clipboard.writeText('RecordRegion_cField'));
    await p.keyboard.press('Control+f');
    await p.waitForSelector('#right .find-widget.visible textarea, #right .find-widget.visible input');
    await p.keyboard.press('Control+v');
    const find = () => p.$eval('#right .find-widget .find-part textarea, #right .find-widget .find-part input', i => i.value);
    await eventually(async () => assert.strictEqual(await find(), 'RecordRegion_cField', 'pasted into the search box'));
    assert.strictEqual(h.text(), T, 'the file is untouched');
    // copy out of the box: select it, Ctrl+C
    await p.keyboard.press('Control+a');
    await p.evaluate(() => navigator.clipboard.writeText('-'));
    await p.keyboard.press('Control+c');
    await eventually(async () => assert.strictEqual(await p.evaluate(() => navigator.clipboard.readText()), 'RecordRegion_cField', 'copied from the box'));
    // and the replace box
    await p.keyboard.press('Escape');
    await p.click('#right .view-lines');
    await p.keyboard.press('Control+h');
    await p.waitForSelector('#right .find-widget.visible .replace-part textarea, #right .find-widget.visible .replace-part input');
    await p.focus('#right .find-widget .replace-part textarea, #right .find-widget .replace-part input');
    await p.evaluate(() => navigator.clipboard.writeText('RecordArea_cField'));
    await p.keyboard.press('Control+v');
    await eventually(async () => assert.strictEqual(await p.$eval('#right .find-widget .replace-part textarea, #right .find-widget .replace-part input', i => i.value), 'RecordArea_cField'));
    assert.strictEqual(h.text(), T, 'still untouched');
    // the buttons say nothing on hover: a title put on is taken off; the mouse's arrival never reaches them
    await p.evaluate(() => document.querySelector('#right .find-widget .codicon-widget-close').setAttribute('title', 'Close (Escape)'));
    await eventually(async () => assert.strictEqual(await p.$$eval('#right .find-widget [title]', n => n.length), 0, 'no titles in the search box'));
    const heard = await p.evaluate(() => { const b = document.querySelector('#right .find-widget .codicon-widget-close'); let n = 0; b.addEventListener('mouseover', () => n++); b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return n; });
    assert.strictEqual(heard, 0, 'the hover never starts');
    await p.click('#right .find-widget .codicon-widget-close');
    await eventually(async () => assert.strictEqual(await p.$('#right .find-widget.visible'), null, 'its buttons still work'));
    // and in the text, the editor's own paste still works
    await p.keyboard.press('Escape');
    await p.click('#right .view-lines');
    assert.deepStrictEqual(h.errors, []);
  }, { clipboard: true });
});

ok('the everyday editor: parents stay in view, an element folds (and the target with it), tags match and close, Format XML, zoom, word wrap that stays level, a divider to drag', async () => {
  const mine = page(TEAM('required') + REG + APP + OWN);
  await run(Object.assign({}, base, { text: mine }), async (p, h) => {
    const ed = side => `window.monaco.editor.getEditors().find(e => ${side === 'left' ? '' : '!'}e.getOption(window.monaco.editor.EditorOption.readOnly))`;
    const lineOf = (side, needle) => p.evaluate(([e, n]) => eval(e).getModel().getLinesContent().findIndex(l => l.includes(n)) + 1, [ed(side), needle]);
    const top = (side, needle) => p.evaluate(([e, n]) => { const x = eval(e); const i = x.getModel().getLinesContent().findIndex(l => l.includes(n)) + 1; return Math.round(x.getTopForLineNumber(i) - x.getScrollTop()); }, [ed(side), needle]);
    // sticky scroll: deep in an element, its parents pinned at the top
    await p.evaluate(e => eval(e).setScrollTop(30 * 19), ed('right'));
    await eventually(async () => assert.ok(/flexiPageRegions/.test(await p.$eval('#right .sticky-widget', w => w.textContent)), 'the parents pinned'));
    await p.evaluate(e => eval(e).setScrollTop(0), ed('right'));
    // fold the first field in your pane: the target folds with it, the panes stay level
    const before = await top('right', 'RecordRegion_cField');
    assert.strictEqual(before, await top('left', 'RecordRegion_cField'), 'level before');
    const at = await lineOf('right', '<itemInstances>');
    await p.evaluate(([e, l]) => { const x = eval(e); x.setPosition({ lineNumber: l, column: 10 }); x.focus(); x.trigger('t', 'editor.fold', {}); }, [ed('right'), at]);
    await eventually(async () => { const r = await top('right', 'RecordRegion_cField'), l = await top('left', 'RecordRegion_cField'); assert.ok(r < before && r === l, 'folded on both sides, level: ' + r + ' / ' + l); });
    await p.evaluate(e => eval(e).trigger('t', 'editor.unfoldAll', {}), ed('right'));
    // a matching tag lit up
    await p.evaluate(([e, l]) => { const x = eval(e); x.setPosition({ lineNumber: l, column: 10 }); x.focus(); }, [ed('right'), at]);
    await eventually(async () => assert.strictEqual(await p.$$eval('#right .tagmatch', n => n.length), 2, 'the tag and its partner'));
    // typing an opening tag closes it
    const endOf = await lineOf('right', '<name>main</name>');
    await p.evaluate(([e, l]) => { const x = eval(e); x.setPosition({ lineNumber: l, column: x.getModel().getLineMaxColumn(l) }); x.focus(); }, [ed('right'), endOf]);
    await p.keyboard.press('Enter'); await p.keyboard.type('<description>');
    await eventually(() => assert.ok(/<description><\/description>/.test(h.text()), 'closed for you'));
    await p.keyboard.type('Hello');
    await eventually(() => assert.ok(/<description>Hello<\/description>/.test(h.text()), 'typed between'));
    await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), mine, 'undone'));
    // a page: its order is what users see - neither ordered nor de-duplicated, in no menu
    await p.click('#right .view-lines', { button: 'right' });
    assert.ok(!(await p.$$eval('#menu .mi span:first-child', n => n.map(x => x.textContent))).some(t => /Format and Order|Remove Duplicate/.test(t)), 'not for a page');
    await p.keyboard.press('Escape');
    await p.click('#moreBtn');
    assert.ok(!(await p.$$eval('#moreMenu .mi', n => n.map(x => x.textContent))).some(t => /Format and Order|Remove Duplicate/.test(t)), 'nor in the more menu');
    await p.keyboard.press('Escape');
    // zoom: both panes the same size, still level
    const fs0 = await p.evaluate(e => eval(e).getOption(window.monaco.editor.EditorOption.fontSize), ed('right'));
    await p.click('#right .view-lines'); await p.keyboard.press('Control+Equal');
    await eventually(async () => assert.deepStrictEqual(await p.evaluate(([a, b]) => [eval(a), eval(b)].map(x => x.getOption(window.monaco.editor.EditorOption.fontSize)), [ed('left'), ed('right')]), [fs0 + 1, fs0 + 1]));
    await eventually(async () => assert.strictEqual(await top('right', 'RecordOwner_cField'), await top('left', 'RecordOwner_cField'), 'level when zoomed'));
    await p.keyboard.press('Control+0');
    // word wrap with a very long edited line: wrapped on one side only - still level after it
    const long = 'x'.repeat(400);
    await p.evaluate(([e, v]) => { const x = eval(e); const m = x.getModel(); const i = m.getLinesContent().findIndex(l => l.includes('<value>required</value>')) + 1; x.executeEdits('t', [{ range: new window.monaco.Range(i, 1, i, m.getLineMaxColumn(i)), text: '                    <value>' + v + '</value>' }]); }, [ed('right'), long]);
    await menu(p, 'viewBtn', 'Word wrap');
    await eventually(async () => { const r = await top('right', 'RecordTeam_cField'), l = await top('left', 'RecordTeam_cField'); assert.ok(Math.abs(r - l) <= 1, 'level after a wrapped line: ' + r + ' / ' + l); }, 6000);
    await menu(p, 'viewBtn', 'Word wrap');
    // the divider: dragged, the target\u2019s pane wider
    const w0 = await p.$eval('#left', e => e.getBoundingClientRect().width);
    const g = await p.$eval('#gap', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
    await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(g.x + 200, g.y, { steps: 5 }); await p.mouse.up();
    await eventually(async () => assert.ok(await p.$eval('#left', e => e.getBoundingClientRect().width) > w0 + 150, 'wider'));
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('a permission set: Format and Order Metadata and Remove Duplicate Entries in the right-click menu - one undoable step each', async () => {
  const fp = f => '    <fieldPermissions>\n        <editable>true</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
  const ps = b => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + b + '    <label>P</label>\n</PermissionSet>\n';
  const mine = ps(fp('A.a__c') + fp('A.b__c')), dupd = ps(fp('A.a__c') + fp('A.b__c') + fp('A.a__c'));
  await run({ labels: { target: 'Target branch (HEAD)', merged: 'Your resolution' }, theirs: 'the feature branch', typeName: 'PermissionSet', file: 'P.permissionset-meta.xml', target: mine, incoming: mine, text: dupd }, async (p, h) => {
    await p.click('#right .view-lines', { button: 'right' });
    assert.deepStrictEqual(await p.$$eval('#menu .mi span:first-child', n => n.map(x => x.textContent).slice(-2)), ['Format and Order Metadata', 'Remove Duplicate Entries']);
    await p.click('#menu .mi:last-child');
    await eventually(() => assert.strictEqual(h.text(), mine, 'the copy taken out'));
    await p.click('#right .view-lines'); await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), dupd, 'Ctrl+Z: back'));
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('a promotion\u2019s code: only the conflicts marked - both versions shown, neither in until accepted; Accept feature puts it in, Ctrl+Z takes it back; the same in two panels', async () => {
  const CM = require('../src/codeMerge');
  const f = 'public with sharing class InvoiceService {\n    private static final String SOURCE = \'Billing\';\n<<<<<<< HEAD\n    private static final Decimal TAX_RATE = 0.21;\n=======\n    private static final Decimal TAX_RATE = 0.20;\n>>>>>>> feature/US-0012345\n    public static void refund(Id invoiceId) { issueCredit(invoiceId); }\n    public static Decimal total(Decimal amount) {\n<<<<<<< HEAD\n        return amount * (1 + TAX_RATE);\n=======\n        return (amount - discountOf(amount)) * 1.2;\n>>>>>>> feature/US-0012345\n    }\n}\n';
  const T = f.replace(/<<<<<<< HEAD\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> feature\/US-0012345\n/g, '$1'), F = f.replace(/<<<<<<< HEAD\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> feature\/US-0012345\n/g, '$1');
  const g = CM.fromConflictFile(f);
  await run({ labels: { target: 'uat', merged: 'Your resolution' }, theirs: 'feature/US-0012345', short: 'the feature', typeName: null, file: 'InvoiceService.cls', language: 'apex', target: T, incoming: F, text: g.text, code: { conflicts: g.conflicts } }, async (p, h) => {
    const a = await look(p);
    assert.deepStrictEqual(a.rows, ['Conflict', 'Conflict'], 'only the conflicts - the tag, nothing after it');
    // the target's version greyed out, the feature's - replacing it - in the feature's colour
    assert.deepStrictEqual(await p.$$eval('#right .zone.alt', n => n.map(x => (x.classList.contains('tgt') ? 'tgt' : x.classList.contains('fea') ? 'fea' : '?') + ':' + x.querySelector('.alt-t').textContent.trim())), ['tgt:\u25be Target', 'fea:\u25be Feature', 'tgt:\u25be Target', 'fea:\u25be Feature']);
    assert.strictEqual(a.chips, '2 conflicts to resolve');
    assert.ok(!/discountOf|TAX_RATE = 0\.2/.test(h.text()), 'neither in the file');
    await p.$$eval('.acts button[title="Accept feature"]', b => b[1].click());
    await eventually(() => assert.ok(h.text().includes('discountOf(amount)) * 1.2;'), 'the feature\u2019s lines in'));
    await eventually(async () => { const b = await look(p); assert.deepStrictEqual([b.chips, b.rows[1]], ['1 conflict to resolve1 resolved', 'Resolved']); });
    assert.deepStrictEqual(await p.$$eval('.acts button.res.on', n => n.map(x => x.title)), ['Accept feature'], 'the one clicked, chosen - in the resolved colour');
    await p.click('#right .view-lines'); await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), g.text, 'Ctrl+Z: to resolve again'));
    await menu(p, 'viewBtn', 'Two panel');
    // two panels: the target beside it - the counts and the conflicts the same as in one
    await eventually(async () => assert.strictEqual(await p.evaluate(() => window.monaco.editor.getEditors().find(e => e.getOption(window.monaco.editor.EditorOption.readOnly)).getValue()), T, 'the target beside it'));
    await eventually(async () => { const b = await look(p); assert.deepStrictEqual([b.chips, b.rows.length], ['2 conflicts to resolve', 2], JSON.stringify(b.rows)); });
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('a conflict whose feature version is empty: it says it removes the lines; Accept feature removes them - Removed, the target\u2019s lines struck through in red; Accept all target and Accept all feature, one step each', async () => {
  const CM = require('../src/codeMerge');
  const f = 'public class A {\n    void a() {\n        x();\n<<<<<<< HEAD\n        // retry\n        retry();\n=======\n>>>>>>> feature\n    }\n    void b() {\n<<<<<<< HEAD\n        one();\n=======\n        two();\n>>>>>>> feature\n    }\n}\n';
  const g = CM.fromConflictFile(f);
  await run({ labels: { target: 'uat', merged: 'Your resolution' }, theirs: 'feature/US-0012345', short: 'the feature', typeName: null, file: 'A.cls', language: 'apex', target: f, incoming: f, text: g.text, code: { conflicts: g.conflicts, reviewed: new Map() } }, async (p, h) => {
    assert.strictEqual((await look(p)).chips, '2 conflicts to resolve');
    // before choosing: the feature's version says what it does
    assert.ok((await p.$$eval('#right .zone.alt .alt-t', n => n.map(x => x.textContent))).some(t => /Feature \u00b7 removes these lines/.test(t)));
    await p.$$eval('.acts button[title="Accept feature"]', b => b[0].click());
    await eventually(async () => { const a = await look(p); assert.deepStrictEqual([a.chips, a.rows], ['1 conflict to resolve1 resolved', ['Removed', 'Conflict']]); });
    assert.deepStrictEqual(await p.$$eval('#right .zone.ghost.gone .gl', n => n.map(x => x.textContent.trim())), ['// retry', 'retry();'], 'the target\u2019s lines, struck through in red - removed');
    assert.strictEqual(h.text(), g.text, 'nothing put in - the feature has nothing here');
    // every conflict at once: one step, Ctrl+Z undoes it
    await menu(p, 'moreBtn', 'Accept all target');
    await eventually(() => assert.ok(h.text().includes('retry();') && h.text().includes('one();') && !h.text().includes('two();')));
    await eventually(async () => assert.deepStrictEqual((await look(p)).rows, ['Resolved', 'Resolved']));
    await p.click('#right .view-lines'); await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), g.text, 'Ctrl+Z: one step back'));
    await menu(p, 'moreBtn', 'Accept all feature');
    await eventually(() => assert.ok(h.text().includes('two();') && !h.text().includes('retry();')));
    await eventually(async () => assert.strictEqual((await look(p)).chips, '2 conflicts resolved'));
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('three panels, Copado\u2019s own: the promotion branch\u2019s side, your resolution, the feature branch\u2019s side - named as Copado\u2019s file names them, level, the words that differ lit; \u2190 takes the feature\u2019s lines in, resolved', async () => {
  const CM = require('../src/codeMerge');
  const f = '<template>\n    <div>\n<<<<<<< HEAD\n=======\n        <p>{loadError}</p>\n        <p>{hint}</p>\n>>>>>>> origin/feature/US-0012345\n        <!-- READ -->\n<<<<<<< HEAD\n        <b class="old">Name</b>\n=======\n        <b class="new">Name</b>\n>>>>>>> origin/feature/US-0012345\n        <i>after</i>\n    </div>\n</template>\n';
  const T = f.replace(/<<<<<<< HEAD\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*\n/g, '$1'), F = f.replace(/<<<<<<< HEAD\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, '$1');
  const g = CM.fromConflictFile(f);
  await run({ labels: { target: 'Target branch (HEAD)', merged: 'Your resolution' }, theirs: 'feature', short: 'the feature', typeName: null, file: 'card.html', language: 'html', target: T, incoming: F, text: g.text,
    codeView: 'threePanes', gitLabels: g.labels, code: { conflicts: g.conflicts, reviewed: new Map() } }, async (p, h) => {
    assert.ok(await p.evaluate(() => document.body.classList.contains('three') && getComputedStyle(document.getElementById('feat')).display !== 'none'), 'three panels');
    assert.deepStrictEqual(await p.$$eval('#lefthead, #righthead, #feathead', n => n.map(x => x.textContent)), ['Conflicts in Promotion branch \u00b7 HEAD', 'Resolution \u00b7 editable', 'Conflicts in Feature branch \u00b7 origin/feature/US-0012345']);
    assert.strictEqual((await look(p)).chips, '2 conflicts to resolve');
    // level: the line after each conflict at the same height in all three
    const tops = () => p.evaluate(() => { const [Le, Re, Fe] = window.monaco.editor.getEditors(); const at = (e, t) => e.getTopForLineNumber(e.getModel().getLinesContent().findIndex(l => l.includes(t)) + 1); return ['READ', 'after'].map(t => [at(Le, t), at(Re, t), at(Fe, t)]); });
    for (const [a, b, c] of await tops()) assert.ok(a === b && b === c, JSON.stringify(await tops()));
    // the words that differ, lit on each side
    assert.ok(await p.$('#left .w3t') && await p.$('#feat .w3f'), 'the words that differ');
    // \u2190: the feature's lines in - resolved, its arrow shown chosen; still level
    await p.$$eval('.acts button[title="Accept feature"]', b => b[0].click());
    await eventually(() => assert.ok(h.text().includes('{loadError}') && h.text().includes('{hint}')));
    await eventually(async () => assert.deepStrictEqual((await look(p)).rows, ['Resolved', 'Conflict']));
    assert.strictEqual(await p.$$eval('.acts button.arw.on', n => n.map(x => x.title).join()), 'Accept feature');
    for (const [a, b, c] of await tops()) assert.ok(a === b && b === c, 'still level: ' + JSON.stringify(await tops()));
    await p.click('#right .view-lines'); await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), g.text, 'Ctrl+Z'));
    // the layout, chosen in View
    await p.click('#viewBtn');
    assert.ok((await p.$$eval('#viewMenu .mi', n => n.map(x => x.textContent))).includes('\u2713Three panel'));
    await p.keyboard.press('Escape');
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('two panels: each version once - the target\u2019s on the left, where it is, Accept target beside it; the feature\u2019s under the conflict, the words that differ lit; level; an addition left out says so, struck through in grey', async () => {
  const CM = require('../src/codeMerge');
  const f = 'public class A {\n    void a() {\n<<<<<<< HEAD\n        logic = \'and\';\n=======\n        logic = \'1 AND NOT 2\';\n>>>>>>> origin/feature/US-0012345\n    }\n<<<<<<< HEAD\n=======\n    // Setup helpers\n>>>>>>> origin/feature/US-0012345\n    void b() {\n    }\n}\n';
  const T = f.replace(/<<<<<<< HEAD\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*\n/g, '$1'), F = f.replace(/<<<<<<< HEAD\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, '$1');
  const g = CM.fromConflictFile(f);
  await run({ labels: { target: 'Target branch (HEAD)', merged: 'Your resolution' }, theirs: 'feature', short: 'the feature', typeName: null, file: 'A.cls', language: 'apex', target: T, incoming: F, text: g.text,
    codeView: 'twoPanes', gitLabels: g.labels, code: { conflicts: g.conflicts, reviewed: new Map() } }, async (p, h) => {
    // the feature's version only, on the right - the target's is on the left
    assert.deepStrictEqual(await p.$$eval('#right .zone.alt .alt-t b', n => n.map(x => x.textContent)), ['Feature', 'Feature']);
    assert.ok(await p.$('#left .w3t') && await p.$('#right .zone.alt .w3f'), 'the words that differ, lit on both sides');
    const level = () => p.evaluate(() => { const [Le, Re] = window.monaco.editor.getEditors(); const at = (e, t) => e.getTopForLineNumber(e.getModel().getLinesContent().findIndex(l => l.includes(t)) + 1); return [at(Le, 'void b()'), at(Re, 'void b()')]; });
    const [a, b] = await level(); assert.strictEqual(a, b, 'level after the conflicts');
    // each button once per conflict, and each does what it says: the feature's lines from Accept feature
    assert.deepStrictEqual(await p.$$eval('.acts button', n => { const c = {}; n.forEach(x => { c[x.title] = (c[x.title] || 0) + 1; }); return c; }), { 'Accept target': 2, 'Accept feature': 2, 'Accept both': 2 });
    await p.$$eval('.acts button[title="Accept feature"]', n => n[0].click());
    await eventually(() => assert.ok(h.text().includes("logic = '1 AND NOT 2';") && !h.text().includes("logic = 'and';"), 'Accept feature: the feature\u2019s line'));
    await p.click('#right .view-lines'); await p.keyboard.press('Control+z');
    await eventually(() => assert.strictEqual(h.text(), g.text));
    // Accept target: beside the target's lines, on the left
    await p.$$eval('.acts button[title="Accept target"]', n => n[0].click());
    await eventually(() => assert.ok(h.text().includes("logic = 'and';")));
    await eventually(async () => assert.deepStrictEqual((await look(p)).rows, ['Resolved', 'Conflict']));
    // the second: only the feature added lines - Accept target leaves them out: said, struck through in grey
    await p.$$eval('.acts button[title="Accept target"]', n => n[1].click());
    await eventually(async () => assert.deepStrictEqual((await look(p)).rows, ['Resolved', 'Left out']));
    assert.deepStrictEqual(await p.$$eval('#right .zone.ghost.leftout .gl', n => n.map(x => x.textContent.trim())), ['// Setup helpers']);
    const [a2, b2] = await level(); assert.strictEqual(a2, b2, 'still level');
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('three panels, a removal: the feature\u2019s side says it removes the lines; accepted, the resolution says Removed - struck through in red under its row; level throughout', async () => {
  const CM = require('../src/codeMerge');
  const f = 'public class A {\n    void a() {\n        x();\n<<<<<<< HEAD\n        // retry\n        retry();\n=======\n>>>>>>> origin/feature/US-0012345\n    }\n    void b() {\n    }\n}\n';
  const T = f.replace(/<<<<<<< HEAD\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*\n/g, '$1'), F = f.replace(/<<<<<<< HEAD\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, '$1');
  const g = CM.fromConflictFile(f);
  await run({ labels: { target: 'T', merged: 'R' }, theirs: 'feature', short: 'the feature', typeName: null, file: 'A.cls', language: 'apex', target: T, incoming: F, text: g.text, codeView: 'threePanes', gitLabels: g.labels, code: { conflicts: g.conflicts, reviewed: new Map() } }, async (p, h) => {
    const level = () => p.evaluate(() => window.monaco.editor.getEditors().map(e => e.getTopForLineNumber(e.getModel().getLinesContent().findIndex(l => l.includes('void b()')) + 1)));
    const flat = a => a.every(x => x === a[0]);
    assert.ok(flat(await level()), JSON.stringify(await level()));
    assert.strictEqual(await p.$$eval('#feat .zone.alt .alt-t', n => n.map(x => x.textContent.trim()).join()), '\u25be Feature \u00b7 removes these lines');
    await p.$$eval('.acts button[title="Accept feature"]', b => b[0].click());
    await eventually(async () => assert.deepStrictEqual(await p.$$eval('#right .zone.head b', n => n.map(x => x.textContent)), ['Removed']));
    assert.deepStrictEqual(await p.$$eval('#right .zone.ghost.gone .gl', n => n.map(x => x.textContent.trim())), ['// retry', 'retry();']);
    // under its row, not above it
    assert.ok(await p.evaluate(() => { const row = document.querySelector('#right .zone.head'), st = document.querySelector('#right .zone.ghost.gone'); return row.getBoundingClientRect().top < st.getBoundingClientRect().top; }));
    assert.ok(flat(await level()), 'still level: ' + JSON.stringify(await level()));
    assert.deepStrictEqual(h.errors, []);
  });
});

ok('a comparison - Manual, Compare: both sides editable, each formatted on its own, compared again as either changes; nothing saved, nothing merged', async () => {
  const fp = f => '    <fieldPermissions>\n        <editable>true</editable>\n        <field>' + f + '</field>\n        <readable>true</readable>\n    </fieldPermissions>\n';
  const ps = b => '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n' + b + '    <label>P</label>\n</PermissionSet>\n';
  const A = ps(fp('A.b__c') + fp('A.a__c')), B = ps(fp('A.a__c') + fp('A.b__c'));
  await run({ labels: { target: 'uat', incoming: 'feature/US-0012345', merged: 'feature/US-0012345' }, theirs: 'feature/US-0012345', typeName: 'PermissionSet', file: 'P.permissionset-meta.xml', plain: true, target: A, incoming: B, text: B }, async (p, h) => {
    const a = await look(p);
    assert.ok(/difference/.test(a.chips) && a.buttons.length === 0, 'differences, nothing to move across: ' + a.chips);
    // the two sides shown - the left and the right - both editable (the third, Copado's feature side, is not shown here)
    assert.deepStrictEqual(await p.evaluate(() => window.monaco.editor.getEditors().slice(0, 2).map(e => e.getOption(window.monaco.editor.EditorOption.readOnly))), [false, false], 'both sides editable');
    // the other side formatted - sorted as Salesforce writes it: the same as this one
    await p.click('#left .view-lines', { button: 'right' });
    await p.$$eval('#menu .mi', n => n.find(x => /Format and Order Metadata/.test(x.textContent)).click());
    await eventually(async () => assert.strictEqual((await look(p)).chips, 'no differences', 'only the order differed'));
    // called a comparison; no Save button - either side saved from the more menu; F7 goes through the differences
    assert.strictEqual(await p.$eval('#title', e => e.textContent), 'Compare \u00b7 P.permissionset-meta.xml');
    assert.strictEqual(await p.$eval('#saveClose', e => e.hidden), true);
    // what only the other side has: its lines here, struck through in red
    await p.evaluate(t => { const x = window.monaco.editor.getEditors()[1]; x.executeEdits('t', [{ range: x.getModel().getFullModelRange(), text: t }]); }, ps(fp('A.a__c')));
    await eventually(async () => assert.ok((await look(p)).rows.includes('Not here')));
    await eventually(async () => assert.ok((await p.$$eval('#right .zone.ghost.removed .gl', n => n.map(x => x.textContent))).some(t => /A\.b__c/.test(t)), 'struck through on the right'));
    // its View: nothing to start from, no layout - a comparison merges nothing
    await p.click('#viewBtn');
    const view = await p.$$eval('#viewMenu .mi, #viewMenu .mh', n => n.map(x => x.textContent));
    assert.ok(!view.some(t => /Start from|Layout|One panel|Merged/i.test(t)), JSON.stringify(view));
    await p.keyboard.press('Escape');
    await p.click('#moreBtn');
    const items = await p.$$eval('#moreMenu .mi', n => n.map(x => x.textContent));
    assert.ok(!items.some(t => /Save .* as file|Format and Order|Remove Duplicate/.test(t)), JSON.stringify(items));
    await p.keyboard.press('Escape');
    assert.deepStrictEqual(h.errors, []);
  });
  // code and a component's files: side by side, coloured, no errors
  for (const [file, language, a, b] of [['opsCard.js', 'javascript', 'export default class X {\n    a() { return 1; }\n}\n', 'export default class X {\n    a() { return 2; }\n}\n'], ['opsCard.html', 'html', '<template>\n    <p>{title}</p>\n</template>\n', '<template>\n    <p class="big">{title}</p>\n</template>\n'], ['opsCard.css', 'css', '.big {\n    color: red;\n}\n', '.big {\n    color: blue;\n}\n']]) {
    await run({ labels: { target: 'uat', incoming: 'feature/US-0012345', merged: 'feature/US-0012345' }, theirs: 'feature/US-0012345', typeName: null, file, language, plain: true, target: a, incoming: b, text: b }, async (p, h) => {
      await eventually(async () => assert.strictEqual(await p.evaluate(() => window.monaco.editor.getModels().slice(0, 2).map(x => x.getLanguageId()).join()), 'cmr-' + language + ',cmr-' + language));
      await eventually(async () => assert.ok(/1 difference/.test((await look(p)).chips), language));
      await eventually(async () => assert.strictEqual((await look(p)).counter, '1 of 1', language + ': F7 goes through the differences'));
      assert.deepStrictEqual((await look(p)).rows, ['Differs'], language + ': the kind alone');
      await p.waitForTimeout(400);
      assert.deepStrictEqual(h.errors, [], language + ': ' + JSON.stringify(h.errors).slice(0, 300));
    });
  }
});










ok('the Compare tab: a search box keeps its focus, text and caret while the list below loads or is read again; a branch list closed stays closed', async () => {
  const { runPage } = require('./browserHarness');
  const CB = require('../src/compareBranches'), d = 'force-app/main/default/';
  const F = (p, kind, summary) => Object.assign({ path: d + p, kind, summary }, CB.groupOf(d + p));
  const files = [F('classes/TaxHelper.cls', 'changed', null), F('classes/Billing.cls', 'changed', null), F('permissionsets/Sales.permissionset-meta.xml', 'changed', null)];
  const st = f => ({ copadoOrg: 'copado', recent: [], current: null, compare: { connected: true, branches: ['feature/US-0012345', 'uat', 'uat-hotfix'], from: 'feature/US-0012345', to: 'uat', files: f } });
  await runPage(st(files), async (p, h) => {
    const active = () => p.evaluate(() => { const a = document.activeElement; return a ? [a.id, a.value, a.selectionStart] : null; });
    // Search: typing, and a summary arrives - the box keeps it all
    await p.click('#cfilter'); await p.keyboard.type('Tax');
    await h.push(st([Object.assign({}, files[0], { summary: '2 members differ' }), files[1], files[2]]));
    await p.waitForTimeout(100);
    assert.deepStrictEqual(await active(), ['cfilter', 'Tax', 3], 'Search kept, after the list loaded');
    await p.keyboard.type('H');
    assert.strictEqual(await p.$eval('#cfilter', e => e.value), 'TaxH', 'and typing goes on in it');
    // a branch box: its list open, the branches read again - still there, still open
    await p.click('#cq-to'); await p.keyboard.type('ua');
    await h.push(st(files));
    await p.waitForTimeout(100);
    assert.deepStrictEqual((await active()).slice(0, 2), ['cq-to', 'ua'], 'the branch box kept');
    assert.ok(await p.$('.clist'), 'its list still open');
    // closed with Escape: an update does not open it again
    await p.keyboard.press('Escape');
    await h.push(st(files));
    await p.waitForTimeout(100);
    assert.strictEqual(await p.$('.clist'), null, 'closed stays closed');
    // what differs only in spacing is the same: not listed, not counted - the search cleared first
    await p.click('#cfilter'); await p.keyboard.press('Control+a'); await p.keyboard.press('Backspace');
    await h.push(st([Object.assign({}, files[0], { summary: 'only spacing differs', same: true }), files[1], files[2]]));
    await p.waitForTimeout(100);
    const t = await p.$eval('#app', e => e.textContent);
    assert.ok(!/TaxHelper/.test(t) && /2 changed/.test(t), 'spacing only: gone from the list and the count');
    assert.deepStrictEqual(h.errors, []);
  }, { saved: { nav: 'Compare' } });
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
