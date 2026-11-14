'use strict';
/**
 * Draws the README's diagrams (media/readme/*.png) in one style, with the extension as it is now.
 * Needs Playwright: npm install --no-save playwright && npx playwright install chromium
 *   node scripts/readme-images.js            all of them
 *   node scripts/readme-images.js preflight  one
 * The merge editor's pictures come from the browser tests: node test/browser.js media/readme/shots
 * The settings groups are read from package.json, so that picture follows the settings.
 * Examples are generic (P12345, US-0012345) - never a real promotion, story, org or name.
 */
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'media', 'readme');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// icons: simple line drawings in the style of the rest
const ICON = {
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  redo: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  download: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  merge: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8 6h3a5 5 0 0 1 5 5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  upload: '<path d="M12 21V9m0 0-4 4m4-4 4 4"/><path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  eraser: '<path d="m7 21-4-4L14 6l7 7-8 8z"/><path d="M7 21h14"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'
};
const COLORS = { green: '#1fc17b', cyan: '#22c4ee', purple: '#8b5cf6', red: '#f0475c', orange: '#ffb14a', blue: '#3b82f6', teal: '#14b8a6', pink: '#ec4899' };
const icon = (name, color, size) => '<div class="ic" style="background:' + COLORS[color] + ';width:' + (size || 60) + 'px;height:' + (size || 60) + 'px"><svg viewBox="0 0 24 24" width="' + Math.round((size || 60) * 0.5) + '" height="' + Math.round((size || 60) * 0.5) + '" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg></div>';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CSS = `*{box-sizing:border-box}body{margin:0}
.page{position:relative;overflow:hidden;padding:44px 56px;color:#e8eefc;font-family:Inter,'Source Sans 3','Segoe UI','DejaVu Sans',sans-serif;
 background:radial-gradient(1200px 500px at 100% 0%,rgba(30,90,160,.45),transparent 60%),radial-gradient(900px 500px at 0% 100%,rgba(70,30,110,.35),transparent 60%),linear-gradient(160deg,#0a1a40,#071431 60%,#06102a)}
h1{margin:0;font-size:36px;font-weight:700;letter-spacing:-.3px;color:#fff}.sub{margin:8px 0 26px;font-size:18px;color:#aab6d3}
.card{background:rgba(18,32,80,.62);border:1px solid rgba(90,130,230,.42);border-radius:14px}
.ic{display:flex;align-items:center;justify-content:center;border-radius:12px;flex:0 0 auto}
.mono{font-family:'DejaVu Sans Mono',Consolas,monospace;color:#5cd2f5}
.dim{color:#aab6d3}.row{display:flex;align-items:center;gap:22px}
.steps{display:grid;gap:18px}.step{padding:24px 22px}.step h3{margin:16px 0 8px;font-size:22px;color:#fff}.step p{margin:0;font-size:16px;line-height:1.45;color:#b9c4e0}
.arrow{color:#6f86c7;font-size:26px;align-self:center}
.list .line{display:flex;align-items:center;gap:14px;padding:6px 0;font-size:17px}
.tag{font-size:14px;color:#aab6d3;margin-left:auto;text-align:right}
.grp{font-weight:700}.foot{margin-top:22px;font-size:15px;color:#9fb0d6}`;

function page(width, height, body) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body><div class="page" style="width:' + width + 'px;height:' + height + 'px">' + body + '</div></body></html>';
}

const DRAW = {
  'how-it-works': () => page(1600, 600, '<h1 style="text-align:center">How it works</h1><div class="sub" style="text-align:center">A user story, checked against an org before Copado does - nothing deploys</div>' +
    '<div class="row" style="justify-content:center;gap:14px;margin-top:10px">' + [
      ['file', 'cyan', 'User story', 'from Copado, or its commit JSON'], ['box', 'blue', 'package.xml', 'generated from the commit'],
      ['check', 'green', 'Validate', 'check-only - the project, or the story\u2019s feature branch'], ['wrench', 'purple', 'Fix', 'suggested fixes, one click each'], ['redo', 'orange', 'Re-validate', 'the project as it is now']
    ].map((s, i) => (i ? '<div class="arrow">\u2192</div>' : '') + '<div class="card step" style="width:250px;min-height:230px;text-align:center"><div style="display:flex;justify-content:center">' + icon(s[0], s[1], 72) + '</div><h3>' + s[2] + '</h3><p>' + s[3] + '</p></div>').join('') + '</div>' +
    '<div class="foot" style="text-align:center;margin-top:34px">Also: promotion conflicts on the Release Assistant page \u00b7 the merge editor \u00b7 branch conflicts with the git merge-base \u00b7 checks as you type</div>'),

  'promotion-flow': () => page(1600, 760, '<h1>Promotion conflicts, end to end</h1><div class="sub">From a promotion in Merge Conflict to Conflicts Resolved - then continue in Copado. Nothing is resolved without you.</div>' +
    '<div class="steps" style="grid-template-columns:repeat(5,1fr)">' + [
      ['download', 'cyan', '1  Open', 'Promotion, story or link - every conflict file fetched at once'],
      ['sparkle', 'green', '2  Suggested merges', 'Each metadata file merged for you to review - never resolved on its own'],
      ['merge', 'orange', '3  Review in merge', 'The merge editor: every change marked, every decision yours'],
      ['shield', 'purple', '4  Pre-check', 'Optional: validate your resolutions first'],
      ['upload', 'blue', '5  Upload all', 'One confirmation, read back, status set, undoable']
    ].map(s => '<div class="card step">' + icon(s[0], s[1]) + '<h3>' + s[2] + '</h3><p>' + s[3] + '</p></div>').join('') + '</div>' +
    '<div class="row" style="align-items:stretch;margin-top:26px;gap:22px">' +
    '<div class="card" style="flex:1.25;padding:22px 26px"><div class="dim" style="font-size:14px;letter-spacing:.08em;font-weight:600">PROMOTION</div><div class="list">' +
    '<div class="line"><b style="color:#fff">P12345 \u00b7 Merge Conflict</b><span class="tag">dev \u2192 qa</span></div>' +
    '<div class="line grp" style="color:#ffb14a">To review (3)</div>' +
    '<div class="line" style="padding-left:22px">Ops.permissionset-meta.xml<span class="tag">a suggested merge</span></div>' +
    '<div class="line" style="padding-left:22px">Case_Record_Page.flexipage-meta.xml<span class="tag">2 blocks the feature branch does not have</span></div>' +
    '<div class="line" style="padding-left:22px">Account-Sales Layout.layout-meta.xml<span class="tag">1 real conflict to review</span></div>' +
    '<div class="line grp" style="color:#22c4ee">Code to resolve (1)</div>' +
    '<div class="line" style="padding-left:22px">leadConvert.js<span class="tag">1 block to resolve</span></div>' +
    '<div class="line grp" style="color:#1fc17b">Ready to upload (2)</div></div></div>' +
    '<div class="card" style="flex:1;padding:22px 26px"><div class="dim" style="font-size:14px;letter-spacing:.08em;font-weight:600">STORED LOCALLY, BY REAL FILE NAME</div>' +
    '<pre class="mono" style="color:#dfe7fb;font-size:16px;line-height:1.75;margin:12px 0 0">.copado/promotions/P12345/\n  promotion.json   each file\u2019s state\n  conflicted/      as fetched, never edited\n  promotion/  feature/  base/\n  merged/          the suggested merge\n  resolved/        what you upload\n  uploads.json     batches, for undo</pre></div></div>'),

  'copado-actions': () => page(1600, 670, '<h1>Copado actions</h1><div class="sub">How each row of a commit JSON becomes part of the package</div>' + [
    ['box', 'green', 'Add', 'manifest/package.xml', 'Deployed.'],
    ['eye', 'cyan', 'RetrieveOnly', '.copado/package-retrieve.xml', 'Listed for retrieving only, as Copado does - never deployed.'],
    ['commit', 'purple', 'SelectiveCommit', 'manifest/package.xml \u00b7 not retrieved', 'Deployed as Copado committed it - from the story\u2019s feature branch; from the project, as it has it.'],
    ['eraser', 'red', 'Delete', 'manifest/destructiveChanges.xml', 'Deleted after the deployment.'],
    ['ban', 'orange', 'anything else', 'skipped, with a warning', 'Map it in Package \u203a Action mapping.']
  ].map(r => '<div class="card row" style="padding:14px 22px;margin-bottom:14px">' + icon(r[0], r[1]) + '<div style="width:300px;font-size:26px;font-weight:700;color:#fff">' + r[2] + '</div><div><div class="mono" style="font-size:19px">' + esc(r[3]) + '</div><div style="font-size:19px;color:#c9d3ea;margin-top:6px">' + r[4] + '</div></div></div>').join('')),

  preflight: () => page(1600, 606, '<h1>Pre-flight checks</h1><div class="sub">Shown in the Deploy Check panel before anything touches an org</div>' + [
    ['warn', 'orange', '12 standard fields will be deployed (no __c) - most cannot be'],
    ['info', 'blue', 'Decoded "%5BN%5D Sales Profile" to "[N] Sales Profile"'],
    ['info', 'blue', 'Profiles retrieve only the permissions related to the manifest - they come back partial'],
    ['info', 'blue', '4 Apex components - validation will ask for test classes (2 ending in Test suggested)'],
    ['warn', 'orange', '1 selective commit is deployed but not retrieved: Layout Account-Sales Layout - make sure the project has the committed version']
  ].map(r => '<div class="card row" style="padding:12px 20px;margin-bottom:12px">' + icon(r[0], r[1], 46) + '<div style="font-size:19px;color:#dfe7fb">' + esc(r[2]) + '</div></div>').join('')),

  'settings-overview': () => {
    const words = { 'Project folders': 'project (found automatically) \u00b7 manifest folder \u00b7 working folder', Merge: 'the merge editor \u00b7 start from \u00b7 conflict winner \u00b7 duplicates \u00b7 formatting \u00b7 keep-target sections',
      'Quick merge': 'button \u00b7 auto-merge after paste \u00b7 folder and file names', Formatting: 'element order \u00b7 sort collections \u00b7 type order \u00b7 indent',
      Checks: 'duplicate severity \u00b7 deploy rules \u00b7 large-file threshold', 'Package from Copado commit': 'API version \u00b7 action mapping \u00b7 standard-field warning',
      Copado: 'Copado org \u00b7 environment orgs \u00b7 auto resolve (off) \u00b7 re-create branch field \u00b7 keep finished', Repository: 'address \u00b7 provider \u00b7 feature and promotion branch names',
      'Git branches': 'target \u00b7 incoming (empty asks) \u00b7 remote \u00b7 fetch first', 'Org validation': 'CLI path \u00b7 target org \u00b7 test levels \u00b7 progress \u00b7 mask identities',
      Guardrails: 'allowed and blocked orgs \u00b7 production \u00b7 minimum test levels \u00b7 stages', Network: 'proxy \u00b7 extra CA file' };
    const groups = pkg.contributes.configuration.map(g => [g.title, words[g.title] || Object.keys(g.properties).length + ' settings']);
    return page(1600, 686, '<h1>Settings</h1><div class="sub">Copado: Open Settings - or the gear in any Copado panel</div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">' +
      groups.map(g => '<div class="card" style="padding:16px 18px;min-height:118px"><div style="font-size:20px;font-weight:700;color:#fff">' + esc(g[0]) + '</div><div style="font-size:15px;color:#b9c4e0;margin-top:8px;line-height:1.45">' + esc(g[1]) + '</div></div>').join('') + '</div>');
  },

  'validation-steps': () => page(1600, 886, '<h1>A validation, step by step</h1><div class="sub">Copado: Validate Deployment Against an Org - the project\u2019s files as they are, check-only</div>' + [
    ['list', 'cyan', 'Which components', 'From a Copado commit JSON, or an existing package.xml'],
    ['server', 'blue', 'Target org', 'Picked from sf org list - the list loads in the background while you answer'],
    ['shield', 'purple', 'Guardrails', 'The team policy may block the target or raise the test level - said before any question about tests'],
    ['flask', 'teal', 'Tests', 'If the package has Apex, pick test classes - ones ending in Test are pre-selected'],
    ['save', 'pink', 'Unsaved files', 'Offered to save first, so what is checked is what you see'],
    ['check', 'green', 'Validate', 'Check-only: deploy validate with tests, deploy start --dry-run without'],
    ['wrench', 'orange', 'Results', 'Problems at the right line, and the Deploy Check panel with suggested fixes']
  ].map((r, i) => '<div class="card row" style="padding:10px 18px;margin-bottom:10px"><div style="width:26px;font-size:20px;color:#8fa3d6">' + (i + 1) + '</div>' + icon(r[0], r[1], 46) + '<div><div style="font-size:21px;font-weight:700;color:#fff">' + r[2] + '</div><div style="font-size:16px;color:#b9c4e0;margin-top:3px">' + esc(r[3]) + '</div></div></div>').join(''))
};

(async () => {
  let chromium;
  try { ({ chromium } = require(process.env.PLAYWRIGHT || 'playwright')); } catch (e) { console.error('Needs Playwright: npm install --no-save playwright && npx playwright install chromium'); process.exit(1); }
  const only = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ deviceScaleFactor: 1 });
  for (const [name, draw] of Object.entries(DRAW)) {
    if (only.length && !only.includes(name)) continue;
    await p.setContent(draw());
    const el = await p.$('.page');
    await el.screenshot({ path: path.join(out, name + '.png') });
    console.log('drew media/readme/' + name + '.png');
  }
  await b.close();
})();
