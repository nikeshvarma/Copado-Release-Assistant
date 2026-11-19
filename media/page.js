// Copado Release Assistant - the page. Draws everything from the state the extension sends; actions go back as messages.
(function () {
  const vscode = acquireVsCodeApi();
  const I = {"gitPull": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"18\" cy=\"18\" r=\"3\"></circle><circle cx=\"6\" cy=\"6\" r=\"3\"></circle><path d=\"M13 6h3a2 2 0 0 1 2 2v7\"></path><line x1=\"6\" x2=\"6\" y1=\"9\" y2=\"21\"></line></svg>", "search": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"11\" cy=\"11\" r=\"8\"></circle><path d=\"m21 21-4.3-4.3\"></path></svg>", "refresh": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"></path><path d=\"M21 3v5h-5\"></path><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"></path><path d=\"M8 16H3v5\"></path></svg>", "upload": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 13v8\"></path><path d=\"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242\"></path><path d=\"m8 17 4-4 4 4\"></path></svg>", "download": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 13v8l-4-4\"></path><path d=\"m12 21 4-4\"></path><path d=\"M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284\"></path></svg>", "check": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"m9 12 2 2 4-4\"></path></svg>", "warn": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"></path><path d=\"M12 9v4\"></path><path d=\"M12 17h.01\"></path></svg>", "code": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M10 12.5 8 15l2 2.5\"></path><path d=\"m14 12.5 2 2.5-2 2.5\"></path><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"></path><path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z\"></path></svg>", "file": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"></path><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"></path><path d=\"M10 9H8\"></path><path d=\"M16 13H8\"></path><path d=\"M16 17H8\"></path></svg>", "merge": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"18\" cy=\"18\" r=\"3\"></circle><circle cx=\"6\" cy=\"6\" r=\"3\"></circle><path d=\"M6 21V9a9 9 0 0 0 9 9\"></path></svg>", "diff": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"18\" cy=\"18\" r=\"3\"></circle><circle cx=\"6\" cy=\"6\" r=\"3\"></circle><path d=\"M13 6h3a2 2 0 0 1 2 2v7\"></path><path d=\"M11 18H8a2 2 0 0 1-2-2V9\"></path></svg>", "reset": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"></path><path d=\"M3 3v5h5\"></path></svg>", "copy": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"></rect><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"></path></svg>", "ext": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M15 3h6v6\"></path><path d=\"M10 14 21 3\"></path><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"></path></svg>", "beaker": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2\"></path><path d=\"M8.5 2h7\"></path><path d=\"M7 16h10\"></path></svg>", "history": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"></path><path d=\"M3 3v5h5\"></path><path d=\"M12 7v5l4 2\"></path></svg>", "sparkles": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\"></path><path d=\"M20 3v4\"></path><path d=\"M22 5h-4\"></path><path d=\"M4 17v2\"></path><path d=\"M5 18H3\"></path></svg>", "arrow": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M5 12h14\"></path><path d=\"m12 5 7 7-7 7\"></path></svg>", "chev": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m6 9 6 6 6-6\"></path></svg>", "chevR": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"m9 18 6-6-6-6\"></path></svg>", "clock": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><polyline points=\"12 6 12 12 16 14\"></polyline></svg>", "user": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"></path><circle cx=\"12\" cy=\"7\" r=\"4\"></circle></svg>", "lock": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"></rect><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"></path></svg>", "shield": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"></path><path d=\"m9 12 2 2 4-4\"></path></svg>", "x": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18 6 6 18\"></path><path d=\"m6 6 12 12\"></path></svg>", "dot": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle></svg>", "filter": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M3 6h18\"></path><path d=\"M7 12h10\"></path><path d=\"M10 18h4\"></path></svg>", "cloud": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"></path></svg>", "play": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><polygon points=\"6 3 20 12 6 21 6 3\"></polygon></svg>", "undo": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M9 14 4 9l5-5\"></path><path d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\"></path></svg>", "branch": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><line x1=\"6\" x2=\"6\" y1=\"3\" y2=\"15\"></line><circle cx=\"18\" cy=\"6\" r=\"3\"></circle><circle cx=\"6\" cy=\"18\" r=\"3\"></circle><path d=\"M18 9a9 9 0 0 1-9 9\"></path></svg>", "info": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M12 16v-4\"></path><path d=\"M12 8h.01\"></path></svg>", "done": "<svg stroke=\"currentColor\" fill=\"none\" stroke-width=\"2\" viewBox=\"0 0 24 24\" stroke-linecap=\"round\" stroke-linejoin=\"round\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18 6 7 17l-5-5\"></path><path d=\"m22 10-7.5 7.5L13 16\"></path></svg>"};
  const sv = d => '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' + d + '</svg>';
  Object.assign(I, {
    rocket: sv('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path>'),
    flash: sv('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path>'),
    key: sv('<circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6"></path><path d="m15.5 7.5 3 3L22 7l-3-3"></path>'),
    back: sv('<path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path>'),
    route: sv('<circle cx="6" cy="19" r="3"></circle><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"></path><circle cx="18" cy="5" r="3"></circle>'),
    chevD: sv('<path d="m6 9 6 6 6-6"></path>'),
    box: sv('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
    report: sv('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="m9 15 2 2 4-4"></path>')
  });
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  const NAVS = ['Promotions', 'Stories', 'Manual', 'Compare'];
  const navs = () => NAVS;
  const ui = { nav: NAVS.includes(saved.nav) ? saved.nav : 'Promotions', href: '', sel: saved.sel || null, tab: saved.tab || 'Files', filter: '', modal: false, setStatus: true, choices: saved.choices || {}, busy: false,
    ref: '', sref: saved.sref || '', asked: {}, earlier: false, setRecreate: true };
  let data = null;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const base = p => String(p).split('/').pop();
  const act = (name, payload) => vscode.postMessage({ type: 'act', name, payload: payload || {} });
  const lact = (name, payload) => vscode.postMessage({ type: 'act', scope: 'life', name, payload: payload || {} });
  const mact = (name, payload) => vscode.postMessage({ type: 'act', scope: 'manual', name, payload: payload || {} });
  const cact = (name, payload) => vscode.postMessage({ type: 'act', scope: 'compare', name, payload: payload || {} });
  const keep = () => vscode.setState({ nav: ui.nav, sel: ui.sel, tab: ui.tab, choices: ui.choices, sref: ui.sref });
  const ago = iso => { if (!iso) return ''; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  const time = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const day = iso => iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
  const kindOf = s => /conflict/i.test(s) && !/resolved/i.test(s) ? 'conflict' : /fail|error|cancel/i.test(s) ? 'bad' : /resolved/i.test(s) ? 'resolved' : /complet|success|done|deployed/i.test(s) ? 'done' : /progress|running|pending|queued|validat|scheduled/i.test(s) ? 'info' : 'neutral';
  const chip = (status, k) => { const s = String(status || ''); return s ? '<span class="chip ' + (k || kindOf(s)) + '">' + esc(s) + '</span>' : ''; };
  const plural = (n, w, ws) => n + ' ' + (n === 1 ? w : (ws || w + 's'));
  // a story reference - nothing else is sent
  const okRef = v => /^[\w .:\/-]{1,80}$/.test(v);

  const GROUPS = [['review', 'To review', 'warn', ['review']], ['code', 'Code to resolve', 'code', ['code', 'error']], ['ready', 'Ready to upload', 'check', ['auto', 'resolved']], ['done', 'Done', 'done', ['uploaded', 'copado']]];
  const groupOf = state => (GROUPS.find(g => g[3].includes(state)) || GROUPS[0])[0];

  /* ------------------------------------------------------------ the bar on top */

  function topbar(cur) {
    const p = cur && cur.promotion;
    const nav = navs().map(n => '<button class="nav ' + (ui.nav === n ? 'on' : '') + '" data-nav="' + n + '"' + (n === 'Promotions' && ui.nav === n && p ? ' title="All promotions - open another"' : '') + '>' + esc(n) + '</button>').join('');
    // the tab's own title names the page: the bar starts with its tabs
    return '<div class="globalbar"><span class="navs">' + nav + '</span>' +
      (ui.nav === 'Promotions' && p ? '<span class="crumb"><button class="crumbback" data-a="home" title="Back to all promotions - open another" aria-label="Back to all promotions">' + I.back + '</button><b>' + esc(p.name) + '</b></span>' : '') + '<span class="spacer"></span>' +
      (ui.nav === 'Promotions' && cur ? '<span class="muted updated">' + I.clock + ' Updated ' + esc(ago(cur.state.syncedAt)) + '</span>' : '') +
      '<span class="org" title="The Copado org"><span class="dot' + (data.copadoOrg ? '' : ' off') + '"></span><span class="orglbl">Copado org: </span><b>' + esc(data.copadoOrg || 'not set') + '</b></span>' +
      (ui.nav === 'Promotions' && cur ? '<button class="btn ghost small" data-a="refresh" title="Refresh from Copado">' + I.refresh + '<span class="lbl">Refresh</span></button><button class="btn ghost small" data-a="openInCopado" title="Open in Copado">' + I.ext + '<span class="lbl">Open in Copado</span></button>' : '') + '</div>';
  }

  function validationNote() {
    const v = data.validation;
    if (!v) return '';
    // plain words: what was validated and how it went; who it ran as is in the tooltip
    const where = v.environment || v.target;
    const what = esc(String(v.label || 'the project').replace(/^./, c => c.toUpperCase()));
    const tip = ' title="' + esc('Checked against ' + v.target + (v.username ? ' as ' + v.username : '') + ' \u2013 nothing was deployed') + '"';
    if (v.running) return '<div class="vnote running"' + tip + '>' + I.beaker + '<span>Validating <b>' + what + '</b> against ' + esc(where) + '\u2026</span></div>';
    if (v.copado) return '';
    const why = [v.errors ? plural(v.errors, 'component error') : '', v.tests ? plural(v.tests, 'test failed', 'tests failed') : '', v.below ? 'coverage too low' : ''].filter(Boolean).join(', ');
    return '<div class="vnote ' + (v.success ? 'ok' : 'bad') + '"' + tip + '>' + (v.success ? I.check : I.x) + '<span><b>' + (v.success ? 'Validated successfully' : 'Validation failed') + '</b> \u00b7 ' + what + ' \u00b7 ' + esc(where) +
      (v.success ? '' : ' \u2013 ' + (why || 'see the errors')) + ' \u00b7 ' + esc(time(v.at)) +
      '</span><button class="btn ghost small" data-tool="cmrDeployView.focus">' + (v.success ? 'Details' : 'See errors') + '</button></div>';
  }

  /* ------------------------------------------------------------ the pre-check, followed on the page */

  function precheckView(cur) {
    const pc = cur.precheck;
    const ready = cur.plan.ready.length + Object.values(cur.state.files).filter(e => e.state === 'uploaded' || e.state === 'copado').length;
    if (!pc) return '<div class="scroll"><div class="pcempty"><h2 class="vh">' + I.beaker + 'Validate your resolutions before uploading</h2><div class="muted lead2">Your resolved files, on top of the stories\u2019 branches, validated against ' + esc(cur.state.to || 'the destination') +
      '. Nothing is deployed. Unresolved files are left out.</div><button class="btn primary" data-a="precheck"' + (ready ? '' : ' disabled') + '>' + I.beaker + 'Validate</button>' +
      (ready ? '' : '<div class="muted" style="margin-top:8px">Resolve a file first.</div>') + '</div></div>';
    const where = esc((pc.target && pc.target.environment) || cur.state.to || '');
    const head = { running: [I.clock, 'info', 'Validating against ' + where + '\u2026'], passed: [I.check, 'ok', 'Validated successfully'], failed: [I.x, 'bad', 'Validation failed'], stopped: [I.info, 'neutral', 'Validation stopped'] }[pc.state];
    const took = pc.finishedAt ? Math.max(1, Math.round((Date.parse(pc.finishedAt) - Date.parse(pc.at)) / 1000)) : null;
    const dur = took == null ? '' : took < 60 ? took + ' s' : Math.floor(took / 60) + ' min ' + (took % 60) + ' s';
    const steps = [['gather', 'Collect', plural(pc.used.length, 'resolved file') + ' and the promotion\u2019s components'],
      ['files', 'Prepare files', pc.files ? pc.files.fromBranches + ' from the branch, ' + pc.files.resolved + ' resolved' + (pc.leftOut.length ? ', ' + pc.leftOut.length + ' left out' : '') : 'resolved files on the branch'],
      ['check', 'Validate', pc.steps.check === 'running' ? (pc.phase || 'Getting started') : pc.target ? (pc.target.tests ? 'with tests' : 'without tests') : 'check-only'],
      ['result', 'Result', pc.state === 'running' ? '' : pc.message || '']];
    const stepRow = ([k, t, sub], i) => { const v = pc.steps[k] || ''; const cls = v === 'done' ? 'done' : v === 'running' ? 'now' : v === 'failed' ? 'fail' : '';
      return '<li class="vstep ' + cls + '"><span class="node">' + (v === 'done' ? I.check : v === 'failed' ? I.x : i + 1) + '</span><span class="lbl"><b>' + t + '</b><small>' + esc(sub) + '</small></span></li>'; };
    const r = pc.result;
    const problems = r ? r.failures.length + r.tests.length + (r.coverage || []).length : 0;
    return '<div class="scroll pc"><div class="pchead"><span class="pcicon ' + head[1] + '">' + head[0] + '</span><div class="grow"><h2>' + head[2] + '</h2><div class="muted">' + where + ' \u00b7 ' + esc(time(pc.at)) + (dur ? ' \u00b7 ' + dur : '') +
        (pc.target && pc.target.alias ? '<span title="' + esc('Checked as ' + (pc.target.username || pc.target.alias)) + '"> \u00b7 as ' + esc(pc.target.alias) + '</span>' : '') + '</div></div>' +
        (pc.state === 'running' ? '' : '<button class="btn ' + (pc.state === 'passed' ? 'ghost' : 'primary') + '" data-a="precheck">' + I.refresh + 'Validate again</button>') + '</div>' +
      '<div class="pcgrid"><div><ol class="vtrack">' + steps.map(stepRow).join('') + '</ol>' +
        '<div class="sect">Files</div><div class="usedlist">' + pc.used.map(u => '<button class="usedrow" data-sel="' + esc(u.rel) + '" data-go="Files"><span class="okc">' + I.check + '</span><span class="grow"><b>' + esc(base(u.rel)) + '</b><small>' + esc(u.from) + '</small></span></button>').join('') +
        pc.leftOut.map(u => '<button class="usedrow off" data-sel="' + esc(u.rel) + '" data-go="Files"><span class="muted">' + I.dot + '</span><span class="grow"><b>' + esc(base(u.rel)) + '</b><small>left out \u2013 ' + esc(u.reason) + '</small></span></button>').join('') + '</div>' +
        '<div class="muted small" style="margin-top:6px">Everything else in the promotion comes from ' + esc((pc.branches || []).join(', ') || 'the stories\u2019 branches') + '.</div></div>' +
      '<div>' + (r ? (r.success ? '<div class="pcok">' + I.check + '<span>No errors' + (pc.target && pc.target.tests ? ', all tests passed' : '') + '.</span></div>'
        : '<div class="sect">' + (r.cliError ? 'Salesforce could not validate' : plural(problems, 'error')) + '</div>' +
          (r.cliError ? '<div class="card bad"><div>' + esc(r.cliError) + '</div></div>' : '') +
          '<div class="errs">' + r.failures.map(f => '<div class="err"><div class="errh"><b>' + esc(f.type + ' ' + f.fullName) + '</b>' + (f.line ? ' <span class="muted">line ' + f.line + '</span>' : '') + '<span class="spacer"></span>' +
            (f.resolution ? '<button class="btn small primary" data-sel="' + esc(f.resolution) + '" data-go="Files">' + I.code + 'Open file</button>' : '') + '</div><div>' + esc(f.problem) + '</div>' +
            (f.resolution ? '<div class="muted small">Your resolution: ' + esc(base(f.resolution)) + '</div>' : f.file ? '<div class="muted mono">' + esc(f.file) + ' \u2013 from the branch</div>' : '') +
            (f.fixes && f.fixes.length ? '<div class="fixes">' + f.fixes.map(x => '<span class="chip resolved">' + I.sparkles + esc(x) + '</span>').join('') + '</div>' : '') + '</div>').join('') +
          r.tests.map(t => '<div class="err"><div class="errh"><b>' + esc(t.name + (t.method ? '.' + t.method : '')) + '</b><span class="muted">test failed</span></div><div>' + esc(t.message) + '</div></div>').join('') +
          (r.coverage || []).map(x => '<div class="err"><div class="errh"><b>' + esc(x.name) + '</b><span class="muted">coverage ' + x.percent + '%' + (r.coverageRule != null ? ', the stage asks for ' + r.coverageRule + '%' : '') + '</span></div></div>').join('') + '</div>')
        : pc.state === 'running' ? '<div class="pcwait">' + I.clock + '<span>' + esc(pc.phase || 'Getting started') + '\u2026</span></div>' : '') +
        '<div class="sect">Log</div><div class="pclog">' + pc.log.slice().reverse().map(l => '<div class="pcl ' + esc(l.kind) + '"><span class="when">' + esc(time(l.at)) + '</span><span>' + esc(l.text) + '</span></div>').join('') + '</div></div></div></div>';
  }

  /* ------------------------------------------------------------ promotions: start */



  /* ------------------------------------------------------------ promotions: the open one */

  /** One stage on the track: done (filled), now (ringed), next (dashed) or later. */
  const step = (title, sub, state, i) => '<li class="step ' + (state || '') + '"><span class="node">' + (state === 'done' ? I.check : i + 1) + '</span><span class="lbl"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span></li>';

  function sides(cur) { const s = (cur.info && cur.info.sides) || {}; return { ours: s.ours === 'Promotion branch' ? 'Target branch' : s.ours || 'Target branch', theirs: s.theirs === 'Feature' ? 'Feature branch' : s.theirs || 'Feature branch' }; }

  function header(cur) {
    const st = cur.state, files = Object.values(st.files), n = files.length, info = cur.info || {};
    const count = k => files.filter(e => k.includes(e.state)).length;
    const ready = count(['auto', 'resolved']), review = count(['review']), code = count(['code', 'error']), done = count(['uploaded', 'copado']);
    const tabs = ['Files', 'Components', 'Pre-check', 'Deployment', 'Activity'];
    const login = info.login;
    const who = login && login.alias ? '<span title="The destination\u2019s login - validations run as this user">' + I.key + ' ' + esc(st.to || '') + ' as ' + esc(login.alias) + (login.username && login.username !== login.alias ? ' <span class="muted">(' + esc(login.username) + ')</span>' : '') + '</span>'
      : '<span class="warnc" title="No Salesforce CLI login for the destination yet - you pick one on the first validation">' + I.key + ' no login for ' + esc(st.to || '?') + '</span>';
    let stagesHtml;
    if (n) {
      const pc = cur.precheck;
      const preText = pc ? ({ running: 'validating', passed: 'validated \u00b7 ' + time(pc.finishedAt), failed: 'failed \u00b7 ' + time(pc.finishedAt), stopped: 'stopped' })[pc.state] : null;
      const stage = done === n ? 5 : (ready + done === n ? 4 : 2);
      const stages = [['Fetched', n + ' files'], ['Resolve', (ready + done) + ' of ' + n + ' ready'], ['Pre-check', preText || 'optional'], ['Upload', done + ' of ' + n], ['Continue in Copado', 'merge, validate, deploy']];
      const state = i => i === 0 ? 'done' : i + 1 === stage ? 'now' : i + 1 < stage ? 'done' : '';
      stagesHtml = stages.map(([t, s], i) => step(t, s, state(i), i)).join('');
    } else {
      const v = data.validation && !data.validation.copado && data.validation.label && data.validation.label.indexOf(st.name) !== -1 ? data.validation : null;
      const j = cur.jobs;
      const status = String(cur.promotion.status || st.status || '');
      const completed = /complet/i.test(status);
      const s3 = completed || (j && j.finished) ? 'done' : (j && (j.running || j.failed)) || (v && !v.running && v.success) ? 'now' : '';
      const s2 = v && !v.running && v.success ? 'done' : (v || !s3) ? 'now' : 'done';
      const stages = [['Promotion', 'no conflicts', 'done'], ['Validate branch', v ? (v.running ? 'running' : v.success ? 'validated ' + time(v.at) : 'failed ' + time(v.at)) : 'check-only', completed ? 'done' : s2],
        ['Deploy in Copado', j ? (j.running ? 'running' : j.failed ? 'failed' : j.finished ? 'finished' : 'not started') : 'follow it here', s3], ['Completed', completed ? status : 'when Copado finishes', completed ? 'done' : '']];
      stagesHtml = stages.map(([t, s, k], i) => step(t, s, k, i)).join('');
    }
    return '<div class="head"><div class="head-row"><h1>' + esc(st.name) + '</h1>' + chip(cur.promotion.status || st.status) + (info.back ? '<span class="chip info" title="Copado back-promotion: changes from ' + esc(st.from || '') + ' go back down the pipeline">' + I.back + 'Back-promotion</span>' : '') +
      (info.production ? '<span class="chip neutral">' + I.rocket + 'to production</span>' : '') +
      '<span class="spacer"></span><span class="seg" role="tablist">' + tabs.map(t => '<button class="tab ' + (ui.tab === t ? 'on' : '') + '" data-tab="' + t + '">' + t + '</button>').join('') + '</span></div>' +
      '<div class="meta"><span>' + I.branch + ' ' + esc(st.from || '?') + ' ' + I.arrow + ' ' + esc(st.to || '?') + '</span><span>' + I.user + ' ' + esc([...new Set(files.map(e => e.story).filter(Boolean))].join(', ') || (n ? '\u2014' : 'stories in Copado')) + '</span>' +
      (n ? '<span>' + I.file + ' ' + plural(n, 'conflict file') + '</span>' : '') + who + '<span class="opened">' + I.clock + ' fetched ' + esc(time(st.syncedAt)) + '</span></div>' +
      '<ol class="track">' + stagesHtml + '</ol></div>';
  }

  /** Why a resolution already in Copado needs another look: Copado's latest errors on it, or it is not well-formed. */
  const problems = (cur, rel) => [].concat(((cur.flagged || {})[rel]) || [], (cur.health || []).filter(x => x.rel === rel).map(x => x.reason));
  const needsLook = (cur, rel, e) => ['uploaded', 'copado'].includes(e.state) && problems(cur, rel).length > 0;

  function list(cur, overview) {
    const f = ui.filter.toLowerCase();
    const entries = Object.entries(cur.state.files).filter(([rel]) => !f || rel.toLowerCase().includes(f)).sort((a, b) => a[0].localeCompare(b[0]));
    const again = entries.filter(([rel, e]) => needsLook(cur, rel, e));
    const rowOf = (k, ic) => ([rel, e]) => '<button class="row ' + (rel === ui.sel ? 'sel' : '') + '" data-sel="' + esc(rel) + '"><span class="ic-' + k + '">' + (e.kind === 'code' ? I.code : I.file) + '</span><span class="grow"><span class="name">' + esc(base(rel)) +
      '</span><span class="sub">' + esc((e.story ? e.story + ' \u00b7 ' : '') + (k === 'again' ? problems(cur, rel)[0] : e.revising ? 'editing again' : (e.note || e.state))) + '</span></span></button>';
    return '<div class="list"><div class="filter">' + I.filter + '<input id="filter" placeholder="Filter files" value="' + esc(ui.filter) + '"></div>' +
      (overview ? '<button class="row overview ' + (ui.sel === OVERVIEW ? 'sel' : '') + '" data-sel="' + OVERVIEW + '"><span class="ic-done">' + I.done + '</span><span class="grow"><span class="name">Overview</span><span class="sub">validate, re-create the branch, follow Copado</span></span></button>' : '') +
      (again.length ? '<div class="group"><span class="ic-again">' + I.warn + '</span>Needs another look<span class="count">' + again.length + '</span></div>' + again.map(rowOf('again')).join('') : '') +
      GROUPS.map(([k, label, ic, states]) => {
        const rows = entries.filter(([rel, e]) => states.includes(e.state) && !needsLook(cur, rel, e));
        if (!rows.length) return '';
        return '<div class="group"><span class="ic-' + k + '">' + I[ic] + '</span>' + label + '<span class="count">' + rows.length + '</span></div>' + rows.map(rowOf(k)).join('');
      }).join('') + '</div>';
  }

  const groupOrder = s => GROUPS.findIndex(g => g[3].includes(s));
  /** The file shown on the right - chosen before the list is drawn, so the list highlights it too. */
  const OVERVIEW = '__overview';
  function pickSel(cur, allDone) {
    const files = cur.state.files;
    if (allDone && (!ui.sel || (!files[ui.sel] && ui.sel !== OVERVIEW))) { ui.sel = OVERVIEW; return; }
    if (!allDone && ui.sel === OVERVIEW) ui.sel = null;
    if (!ui.sel || !files[ui.sel]) ui.sel = Object.keys(files).sort((a, b) => groupOrder(files[a].state) - groupOrder(files[b].state) || a.localeCompare(b))[0] || null;
  }

  function detail(cur) {
    const files = cur.state.files;
    const rel = ui.sel, e = files[rel];
    if (!e) return '<div class="detail"><div class="empty">No conflict files.</div></div>';
    const g = groupOf(e.state);
    const why = problems(cur, rel);
    const inCopado = ['uploaded', 'copado'].includes(e.state);
    const chipText = why.length && inCopado ? 'Needs another look' : e.revising ? 'Editing again' : e.suggestion && e.state === 'review' ? 'To review \u00b7 a suggested merge' : { review: 'To review', code: 'Code to resolve', ready: 'Ready', done: 'Done' }[g] + (e.note ? ' \u00b7 ' + e.note : '');
    const chipKind = why.length && inCopado ? 'bad' : e.revising ? 'info' : { review: 'conflict', code: 'info', ready: 'resolved', done: 'done' }[g];
    const held = (cur.plan.held || []).find(x => x.rel === rel);
    const L = e.labels || {}, S = sides(cur);
    let body = '';
    if (e.state === 'review' && e.clashes && e.clashes.length) {
      const ch = ui.choices[rel] || {};
      body += e.clashes.map((c, i) => '<div class="clash"><div class="what">' + esc(c.where || c.tag) + (c.label ? ' \u203a ' + esc(c.label) : '') + ' \u203a ' + esc(c.tag) + '</div><div class="sides">' +
        '<div class="side ' + (ch[i] === 'target' ? 'pick' : '') + '" data-choose="' + i + '" data-side="target"><div class="lbl"><span class="radio"></span>' + esc(S.ours) + (L.ours ? ' (' + esc(L.ours) + ')' : '') + '</div><span class="mono">' + esc(c.target) + '</span></div>' +
        '<div class="side ' + ((ch[i] || 'incoming') === 'incoming' ? 'pick' : '') + '" data-choose="' + i + '" data-side="incoming"><div class="lbl"><span class="radio"></span>' + esc(S.theirs) + (L.theirs ? ' (' + esc(L.theirs) + ')' : '') + '</div><span class="mono">' + esc(c.incoming) + '</span></div></div>' +
        '<div class="muted" style="margin-top:8px;font-size:12px">Changed on both sides' + (e.hasBase ? ' since the common ancestor' : '') + ' \u2013 pick the value to keep.</div></div>').join('');
    } else {
      if (why.length) body += '<div class="card bad"><h3>' + I.warn + (inCopado ? 'Copado will trip on this resolution' : 'Found in Copado\u2019s latest run') + '</h3>' + why.slice(0, 6).map(w => '<div class="mono why">' + esc(w) + '</div>').join('') +
        (inCopado ? '<div class="muted" style="margin-top:8px">Edit again fetches the resolution as it is in Copado; uploading replaces it there. Then tick Re-create promotion branch so Copado uses it.</div>' : '') + '</div>';
      body += '<div class="card"><h3>' + I.sparkles + 'What happened</h3>' + esc(explain(e)) + '</div>';
    }
    body += '<div class="card"><h3>' + I.info + 'Details</h3><div class="kv"><span class="k">' + esc(S.ours) + '</span><span title="What the target environment has - Copado made the promotion branch from it">' + esc(L.ours || '\u2014') + '</span><span class="k">' + esc(S.theirs) + '</span><span>' + esc(L.theirs || '\u2014') +
      '</span><span class="k">Your resolution</span><span>becomes the promotion branch\u2019s file when you upload it' +
      '</span><span class="k">Merge</span><span>' + (e.kind === 'xml' ? (e.hasBase ? 'three-way, with the common ancestor' : 'two-way') : 'code blocks') + '</span><span class="k">Checks</span><span>' +
      (held ? '<span style="color:var(--vscode-charts-red)">' + I.x + ' ' + esc(held.reason) + '</span>' : g === 'ready' || g === 'done' ? '<span style="color:var(--vscode-charts-green)">' + I.check + ' ready to upload</span>' : '\u2014') + '</span></div></div>';
    const btns = inCopado ? '<button class="btn ' + (why.length ? 'primary' : 'secondary') + '" data-a="revise" title="Fetch the resolution as it is in Copado and change it - uploading replaces it there">' + I.code + 'Edit again</button>'
      : e.revising ? '<button class="btn primary" data-a="review">' + I.code + 'Open the file</button>'
      : e.state === 'review' && e.suggestion ? '<button class="btn primary" data-a="accept" title="Use the suggested merge as your resolution">' + I.check + 'Accept the suggestion</button><button class="btn secondary" data-a="review">' + I.merge + 'Review in merge</button>'
      : e.state === 'review' && e.clashes && e.clashes.length
      ? '<button class="btn primary" data-a="choose">' + I.check + 'Accept choices</button><button class="btn secondary" data-a="review">' + I.merge + 'Open in merge</button>'
      : e.state === 'code' || e.state === 'error' ? '<button class="btn primary" data-a="review">' + I.code + 'Resolve in editor</button>'
      : '<button class="btn secondary" data-a="review">' + I.merge + 'Review in merge</button>' + (e.state === 'auto' ? '<button class="btn ghost" data-a="accept">' + I.check + 'Accept</button>' : '');
    return '<div class="detail"><div class="grow-area"><h2>' + (e.kind === 'code' ? I.code : I.file) + esc(base(rel)) + ' <span class="chip ' + chipKind + '">' + esc(chipText) + '</span></h2>' +
      '<div class="path mono">' + esc(rel) + '</div><div class="actions">' + btns + '<button class="btn ghost" data-a="compare">' + I.diff + 'Compare sides</button><button class="btn ghost" data-a="copy">' + I.copy + 'Copy</button>' +
      (['review', 'code', 'resolved', 'error'].includes(e.state) ? '<button class="btn ghost" data-a="reset">' + I.reset + (e.revising ? 'Discard changes' : 'Reset') + '</button>' : '') + '</div>' + body + '</div>' + footer(cur) + '</div>';
  }

  function explain(e) {
    if (e.state === 'review' && e.suggestion) return 'A suggested merge of both branches. Accept it, or open Review in merge, change what you need and save.';
    if (e.state === 'auto' && e.kind === 'xml') return 'Git stopped on ' + plural(e.blocks || 0, 'conflict block') + '. Both branches only added or agreed on entries, so everything is kept \u2013 nothing needed deciding.';
    if (e.state === 'auto') return 'Every conflict block was settled: the sides agreed, or only one side changed.';
    if (e.state === 'code' || e.state === 'error') return (e.note || '') + '. Resolve the remaining blocks with VS Code\u2019s Accept Current / Incoming / Both, then save \u2013 the file moves to Ready.';
    if (e.revising) return 'Being edited again, from the resolution Copado holds now. Uploading replaces it in Copado \u2013 only if Copado still holds that one. Discard changes leaves Copado as it is.';
    if (e.state === 'resolved') return 'Resolved here' + (e.note ? ': ' + e.note : '') + '. It goes up with the next upload. To change it, Review in merge starts from what you saved.';
    if (e.state === 'uploaded') return (e.revisions ? 'Changed and uploaded again (' + plural(e.revisions, 'time') + ') to Copado as \u201c' : 'Uploaded to Copado as \u201c') + (e.uploadedName || 'RESOLVED \u2026') + '\u201d and read back. If a validation finds a problem in it, Edit again.';
    if (e.state === 'copado') return 'Resolved in Copado meanwhile \u2013 left as it is.';
    return e.note || '';
  }

  function footer(cur) {
    const n = cur.plan.ready.length;
    const files = Object.values(cur.state.files);
    const c = k => files.filter(e => k.includes(e.state)).length;
    return '<div class="footer"><span class="counts"><span style="--c:var(--ok)">' + c(['auto', 'resolved']) + ' ready</span><span style="--c:var(--warn)">' + c(['review']) + ' to review</span><span style="--c:var(--info)">' + c(['code', 'error']) + ' code to resolve</span>' +
      (cur.plan.held.length ? '<span style="--c:var(--bad)">' + cur.plan.held.length + ' held back</span>' : '') + '</span><span class="spacer"></span>' +
      (cur.canUndo ? '<button class="btn ghost" data-a="undo">' + I.undo + 'Undo upload</button>' : '') +
      '<button class="btn secondary" data-a="precheck"' + (n ? '' : ' disabled') + ' title="Validate your resolved files \u2013 nothing is deployed">' + I.beaker + 'Pre-check</button><button class="btn primary" data-a="uploadAsk"' + (n ? '' : ' disabled') + '>' + I.upload + (n && cur.plan.revised === n ? 'Replace ' + n + ' in Copado' : 'Upload ' + n + ' ready') + '</button></div>';
  }

  function activity(cur) {
    const icon = { fetch: ['download', 'blue'], auto: ['sparkles', 'green'], accept: ['check', 'green'], reset: ['reset', 'yellow'], upload: ['upload', 'purple'], status: ['done', 'green'], undo: ['undo', 'yellow'], precheck: ['beaker', 'purple'] };
    const ev = (cur.state.events || []).slice().reverse();
    return '<div class="timeline">' + (ev.length ? ev.map(e => { const [ic, c] = icon[e.kind] || ['info', 'blue'];
      return '<div class="ev"><span class="when">' + esc(time(e.at)) + '</span><span style="color:var(--vscode-charts-' + c + ')">' + I[ic] + '</span><span><b>' + esc(e.text) + '</b><br><span class="muted">' + esc(e.detail) + '</span></span></div>'; }).join('') : '<div class="empty">Nothing yet.</div>') + '</div>';
  }

  function recreateSwitch(cur) {
    const r = cur.info && cur.info.recreate;
    if (!r) return '';
    if (r.missing) return '<div class="switchrow off" title="Set Copado \u203a Re-create branch field if your Copado names it differently"><span class="switch"></span><span><b>Re-create promotion branch</b><br><span class="muted">This Copado version has no such checkbox on the promotion.</span></span></div>';
    const pending = cur.state.recreate && r.value;
    return '<button class="switchrow" data-a="recreate" data-value="' + (r.value ? '0' : '1') + '" role="switch" aria-checked="' + !!r.value + '"><span class="switch' + (r.value ? ' on' : '') + '"></span><span><b>' + esc(r.label || 'Re-create promotion branch') + '</b><br><span class="muted">' +
      (r.value ? (pending ? 'Ticked in Copado. Unticked by itself once Copado validates the promotion successfully.' : 'Ticked in Copado: it rebuilds the promotion branch from the stories next time.')
        : 'Tick it after changing resolutions, so Copado rebuilds the promotion branch with them.') + '</span></span></button>';
  }

  /** Everything is in Copado: what comes next, and anything that needs another look. */
  function overview(cur) {
    const st = cur.state, info = cur.info || {}, login = info.login;
    const again = Object.entries(st.files).filter(([rel, e]) => needsLook(cur, rel, e));
    // problems lead: no celebration while Copado has found something to fix
    return '<div class="grow-area">' + (again.length
      ? '<h2 class="vh bad">' + I.warn + plural(again.length, 'resolution needs', 'resolutions need') + ' another look</h2><div class="muted lead2">Change them with Edit again and upload \u2013 that replaces them in Copado. Then tick Re-create promotion branch so Copado uses them, and validate in Copado again.</div>'
      : '<div class="done-hero"><div class="big">' + I.done + '</div><h2>Every conflict is resolved in Copado</h2><div class="muted">' + plural(Object.keys(st.files).length, 'file') + ' in Copado. Next there: Merge Changes, Validate Changes or Deploy Changes.</div></div>') +
      (again.length ? '<div class="card bad">' + again.map(([rel]) => '<div class="againrow"><span class="grow"><b>' + esc(base(rel)) + '</b><span class="muted mono">' + esc(problems(cur, rel)[0]) + '</span></span><button class="btn small primary" data-a="revise" data-rel="' + esc(rel) + '">' + I.code + 'Edit again</button></div>').join('') + '</div>' : '') +
      '<div class="card"><h3>' + I.branch + 'In Copado</h3>' + recreateSwitch(cur) +
      '<div class="actions"><button class="btn secondary" data-a="openInCopado">' + I.ext + 'Open in Copado</button><button class="btn ghost" data-tab="Deployment">' + I.flash + 'Follow the deployment</button>' +
      '<button class="btn ghost" data-a="validateBranch" title="Its components from ' + esc(info.promotionBranch || 'the promotion branch') + ', check-only against ' + esc(st.to || 'the destination') + (login && login.username ? ' as ' + esc(login.username) : '') + '">' + I.beaker + 'Validate promotion branch</button>' +
      '<button class="btn ghost" data-a="readiness">' + I.report + 'Readiness report</button>' + (cur.canUndo ? '<button class="btn ghost" data-a="undo">' + I.undo + 'Undo the last upload</button>' : '') + '</div></div></div>';
  }

  /** A promotion with nothing to resolve: validate what Copado will deploy, then follow the deployment. */
  function branchView(cur, allDone) {
    const info = cur.info || {}, st = cur.state;
    const login = info.login;
    return '<div class="scroll"><div class="branchview">' + (allDone ? '<div class="done-hero"><div class="big">' + I.done + '</div><h2>Every conflict is resolved in Copado</h2><div class="muted">' + plural(Object.keys(st.files).length, 'file') + ' done' +
      ((st.events || []).filter(e => e.kind === 'status').pop() ? ' \u00b7 status set to ' + esc((st.events || []).filter(e => e.kind === 'status').pop().text.replace(/^Status: /, '')) : '') + '. Next in Copado: Merge Changes, Validate Changes or Deploy Changes.</div></div>'
      : '<h2 class="vh">' + I.check + 'No conflicts on ' + esc(st.name) + '</h2>') +
      '<div class="cards2"><div class="card"><h3>' + I.branch + 'Validate the promotion branch</h3><div class="muted"' + (login && login.alias ? ' title="' + esc('Checked as ' + (login.username || login.alias)) + '"' : '') + '>What Copado will deploy \u2013 <span class="mono">' + esc(info.promotionBranch || 'promotion/' + st.name) + '</span> \u2013 validated against ' + esc(st.to || 'the destination') + '. Nothing is deployed.</div>' +
      '<div class="actions"><button class="btn primary" data-a="validateBranch">' + I.beaker + 'Validate promotion branch</button>' + (allDone && cur.canUndo ? '<button class="btn ghost" data-a="undo">' + I.undo + 'Undo the upload</button>' : '') + '</div></div>' +
      '<div class="card"><h3>' + I.rocket + 'After that, in Copado</h3><div class="muted">Deploy in Copado and follow it here. Errors point to the file, with how to fix it.</div>' + recreateSwitch(cur) +
      '<div class="actions"><button class="btn secondary" data-a="openInCopado">' + I.ext + 'Open in Copado</button><button class="btn ghost" data-tab="Deployment">' + I.flash + 'Follow the deployment</button>' +
      '<button class="btn ghost" data-a="readiness" title="Stories, components, validations per stage, tests and coverage, open conflicts">' + I.report + 'Readiness report</button></div></div></div></div></div>';
  }

  function jobRow(j, depth) {
    const pct = typeof j.progress === 'number' ? j.progress : /^\d+(\.\d+)?%?$/.test(String(j.progress || '')) ? parseFloat(j.progress) : null;
    return '<div class="job d' + Math.min(depth, 2) + '"><span class="jn">' + (j.state === 'done' ? '<span class="okc">' + I.check + '</span>' : j.state === 'failed' ? '<span class="badc">' + I.x + '</span>' : j.state === 'running' ? '<span class="infoc">' + I.clock + '</span>' : '<span class="muted">' + I.dot + '</span>') +
      '<b>' + esc(j.name) + '</b><span class="muted">' + esc(j.kind + (j.type ? ' \u00b7 ' + j.type : '')) + '</span></span>' + chip(j.status || j.state) +
      (pct != null ? '<span class="pbar"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></span>' : typeof j.progress === 'string' && j.progress ? '<span class="muted">' + esc(j.progress) + '</span>' : '<span></span>') +
      '<span class="muted">' + esc(time(j.modified || j.created)) + '</span>' + (j.error ? '<div class="jerr mono">' + esc(j.error) + '</div>' : '') + '</div>' + (j.children || []).map(c => jobRow(c, depth + 1)).join('');
  }

  function deployment(cur) {
    const j = cur.jobs;
    if (!j) return '<div class="scroll"><div class="empty">Checking how the deployment is going\u2026</div></div>';
    const head = '<div class="toolbar"><b>Copado\u2019s deployment of ' + esc(cur.state.name) + '</b>' + (j.watching ? '<span class="chip info" title="Checked again every few seconds while Copado works \u2013 nothing in Copado is changed">' + I.clock + 'Updating live</span>' : '') +
      '<span class="muted">Updated ' + esc(time(j.at)) + '</span><span class="spacer"></span><button class="btn ghost small" data-a="jobs">' + I.refresh + 'Check now</button>' +
      (j.errors.length ? '<button class="btn primary small" data-a="jobErrors">' + I.warn + 'Show ' + plural(j.errors.length, 'error') + ' in Deploy Check</button>' : '') + '</div>';
    if (j.error) return '<div class="scroll">' + head + '<div class="card bad">' + esc(j.error) + '</div></div>';
    if (!j.jobs.length) return '<div class="scroll">' + head + '<div class="empty" title="' + esc('Looked in ' + ((j.objects || []).join(', ') || 'nothing this Copado version has')) + '">Nothing deployed yet. Validate or deploy ' + esc(cur.state.name) + ' in Copado to follow it here.</div></div>';
    const errs = j.mapped || j.errors.map(e => ({ type: e.type, fullName: e.fullName, problem: e.problem, line: e.line, file: null, fixes: [], resolution: e.resolution }));
    const [latest, ...earlier] = j.jobs;
    const mine = errs.filter(e => e.resolution).length;
    return '<div class="scroll">' + head +
      (errs.length ? '<div class="sect">Component errors in the newest run<span class="muted"> \u2013 ' + esc(latest.name) + ', ' + esc(time(latest.created || latest.modified)) + '</span></div>' +
        (mine ? '<div class="muted note2">' + plural(mine, 'error is', 'errors are') + ' in resolutions you can change: Edit again, upload, then tick Re-create promotion branch so Copado uses them.</div>' : '') +
        '<div class="errs">' + errs.slice(0, 60).map(e => '<div class="err"><div class="errh"><b>' + esc(e.type + ' ' + e.fullName) + '</b>' + (e.line ? ' <span class="muted">line ' + e.line + '</span>' : '') + '<span class="spacer"></span>' +
          (e.resolution ? '<button class="btn small primary" data-a="revise" data-rel="' + esc(e.resolution) + '">' + I.code + 'Edit the resolution</button>' : '') + '</div>' +
        '<div>' + esc(e.problem) + '</div>' + (e.file ? '<div class="muted mono">' + esc(e.file) + '</div>' : e.resolution ? '<div class="muted mono">' + esc(e.resolution) + ' \u2013 one of this promotion\u2019s resolutions</div>' : '') +
        (e.fixes && e.fixes.length ? '<div class="fixes">' + e.fixes.map(f => '<span class="chip resolved">' + I.sparkles + esc(f) + '</span>').join('') + '</div>' : '') + '</div>').join('') + '</div>' : '') +
      '<div class="sect">Newest run</div><div class="jobs">' + jobRow(latest, 0) + '</div>' +
      (earlier.length ? '<button class="earlier" data-a="earlier">' + (ui.earlier ? I.chevD : I.chevR) + plural(earlier.length, 'earlier run') + (ui.earlier ? '' : ' \u2013 history, not the current problem') + '</button>' +
        (ui.earlier ? '<div class="jobs dim">' + earlier.map(x => jobRow(x, 0)).join('') + '</div>' : '') : '') + '</div>';
  }

  // what the stories committed, and where each stands: a conflict, from the branch, not on the branch
  const CSTATE = {
    'conflict-open': ['open', 'warn', 'warn', 'Conflict \u00b7 to resolve'], 'conflict-resolved': ['resolved', 'ok', 'check', 'Conflict \u00b7 resolved'],
    'conflict-uploaded': ['resolved', 'ok', 'check', 'Resolved \u00b7 in Copado'], branch: ['branch', 'info', 'check', 'On the branch'],
    missing: ['missing', 'bad', 'ban', 'Not on the branch'], commit: ['commit', 'grey', 'dot', 'In the commit']
  };
  const CICON = {
    code: sv('<path d="m8 7-4 5 4 5M16 7l4 5-4 5"/>'), field: sv('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 12h5"/>'),
    page: sv('<rect x="3.5" y="3" width="17" height="18" rx="2"/><path d="M3.5 8h17M9 8v13"/>'), cube: sv('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/>'),
    person: sv('<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-4 3.6-6 7-6s6.2 2 7 6"/>'), flow: sv('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5"/>'),
    box: sv('<path d="M4 8 12 4l8 4v8l-8 4-8-4z"/><path d="m4 8 8 4 8-4M12 12v8"/>'),
    warn: sv('<path d="M12 3 2.5 20h19z"/><path d="M12 9.5v4.5M12 17.2h.01"/>'), check: sv('<path d="m5 12.5 4.5 4.5L19 7.5"/>'), ban: sv('<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>'),
    dot: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/></svg>', chev: sv('<path d="m6 9 6 6 6-6"/>'), chevR: sv('<path d="m9 6 6 6-6 6"/>')
  };
  const typeIcon = t => CICON[/^Apex|Trigger/.test(t) ? 'code' : /Field|Object|ValueSet|RecordType|ListView|CompactLayout/.test(t) ? 'field' : /FlexiPage|Layout|Tab|Application/.test(t) ? 'page'
    : /Lightning|Aura|Resource/.test(t) ? 'cube' : /Permission|Profile|Role|Group|Queue/.test(t) ? 'person' : /Flow|Process|Approval/.test(t) ? 'flow' : 'box'];
  const actionTag = a => { const t = String(a || 'Add'); const cls = /delete|destruct/i.test(t) ? 'del' : /selective/i.test(t) ? 'sel' : /retrieve/i.test(t) ? 'ret' : '';
    return '<span class="cact ' + cls + '">' + esc(/selective/i.test(t) ? 'Selective' : /retrieveonly/i.test(t) ? 'Retrieve only' : t) + '</span>'; };
  function componentsView(cur) {
    const c = cur.components;
    if (!c || c.loading) return '<div class="scroll"><div class="empty">Reading what the stories committed\u2026</div></div>';
    const head = '<div class="chead2"><div><h3>What the stories committed</h3><div class="muted">' + (c.rows ? plural(c.rows.length, 'component') + ' ' : '') + (c.source ? 'from ' + esc(c.source) : '') + (c.at ? ' \u00b7 read ' + esc(ago(new Date(c.at).toISOString())) : '') + '</div></div>' +
      '<span class="spacer"></span><button class="btn secondary small" data-a="components">' + I.refresh + 'Read again</button></div>';
    if (c.error) return '<div class="scroll">' + head + '<div class="card bad">' + esc(c.error) + '</div></div>';
    if (!c.rows.length) return '<div class="scroll">' + head + '<div class="empty">Copado has no list of this promotion\u2019s components, and its stories\u2019 commits list none.</div></div>';
    const key = r => (CSTATE[r.where] || CSTATE.commit)[0];
    const n = k => c.rows.filter(r => key(r) === k).length;
    const f = ui.compFilter || 'all', q = String(ui.compName || '').trim().toLowerCase();
    const filters = [['all', 'All', c.rows.length], ['open', 'To resolve', n('open')], ['resolved', 'Resolved', n('resolved')], ['commit', 'In the commit', n('commit')]]
      .concat(c.checked ? [['branch', 'On the branch', n('branch')], ['missing', 'Not on the branch', n('missing')]] : []);
    const shown = c.rows.filter(r => (f === 'all' || key(r) === f) && (!q || r.name.toLowerCase().includes(q) || r.type.toLowerCase().includes(q)));
    const note = !c.checked ? '<div class="cnote">' + I.branch + '<span>Run <b>Pre-check</b> to see which components are on the stories\u2019 branches.</span><button class="btn secondary small" data-tab="Pre-check">Run Pre-check</button></div>'
      : c.counts.missing ? '<div class="card warn">' + plural(c.counts.missing, 'component was', 'components were') + ' not found on ' + esc(c.branches.join(', ') || 'the branches') + '. Check that its file is on the branch, under its Salesforce name \u2013 names with special characters are written encoded, such as <span class="mono">%5BA%5D R%26D Admin</span> for <span class="mono">[A] R&amp;D Admin</span>.</div>' : '';
    const bar = '<div class="cfbar"><span class="cfsegs" role="tablist">' + filters.map(([v, l, k]) => '<button class="cfs' + (f === v ? ' on' : '') + (k ? '' : ' zero') + '" data-a="compFilter" data-v="' + v + '">' + l + '<span class="cfc">' + k + '</span></button>').join('') + '</span>' +
      '<span class="spacer"></span><span class="cfsearch">' + I.search + '<input id="cname" placeholder="Filter by name" value="' + esc(ui.compName || '') + '" aria-label="Filter by name"></span></div>';
    const groups = new Map();
    for (const r of shown) (groups.get(r.type) || groups.set(r.type, []).get(r.type)).push(r);
    const fold = ui.compFold || {};
    const row = r => {
      const [, cls, ic, label] = CSTATE[r.where] || CSTATE.commit;
      const cells = '<span class="ccn">' + esc(r.name) + '</span>' + actionTag(r.action) + '<span class="ccs">' + esc((r.stories || []).join(', ')) + '</span><span></span>' +
        '<span class="cst ' + cls + '">' + CICON[ic] + label + '</span><span class="cgo">' + (r.rel ? CICON.chevR : '') + '</span>';
      return r.rel ? '<button class="crow opens" data-sel="' + esc(r.rel) + '" data-go="Files" title="Open ' + esc(base(r.rel)) + '">' + cells + '</button>' : '<div class="crow">' + cells + '</div>';
    };
    const summary = rs => { const o = rs.filter(r => key(r) === 'open').length, d = rs.filter(r => key(r) === 'resolved').length, m = rs.filter(r => key(r) === 'missing').length;
      return (o ? '<span class="cs-open">' + o + ' to resolve</span>' : '') + (d ? '<span class="cs-done">' + d + ' resolved</span>' : '') + (m ? '<span class="cs-miss">' + m + ' not on the branch</span>' : ''); };
    const list = shown.length ? '<div class="ccols"><span>Component</span><span>Action</span><span>Story</span><span></span><span>Where it stands</span><span></span></div>' +
      [...groups].map(([t, rs]) => '<div class="cgrp' + (fold[t] ? ' folded' : '') + '"><button class="cgh2" data-a="compFold" data-v="' + esc(t) + '" aria-expanded="' + !fold[t] + '">' + CICON.chev + '<span class="cti">' + typeIcon(t) + '</span><b>' + esc(t) + '</b><span class="ccount">' + rs.length + '</span><span class="csum">' + summary(rs) + '</span></button>' +
        (fold[t] ? '' : rs.map(row).join('')) + '</div>').join('')
      : '<div class="empty">' + (q ? 'Nothing named like \u201c' + esc(q) + '\u201d here.' : 'None here.') + '</div>';
    return '<div class="scroll comps">' + head + note + bar + list + '</div>';
  }

  function modal(cur) {
    const p = cur.plan;
    const all = p.revised && p.revised === p.ready.length;
    const first = p.ready.length - (p.revised || 0);
    return '<div class="scrim"><div class="modal" role="dialog" aria-modal="true"><header>' + (all ? 'Replace ' + plural(p.ready.length, 'resolution') + ' in ' : 'Upload ' + plural(p.ready.length, 'resolution') + ' to ') + esc(cur.state.name) + '?</header><div class="mbody">' +
      '<div class="muted" style="margin-bottom:8px">' + (first ? 'Each conflict attachment is renamed <span class="mono">RESOLVED \u2026</span> with the resolved content \u2013 what Copado\u2019s editor does. ' : '') +
      (p.revised ? (first ? 'A replacement' : 'Each') + ' keeps its name in Copado and gets your changed content \u2013 only if Copado still holds the version you started from. ' : '') + 'Everything is read back byte for byte.</div>' +
      p.ready.map(x => '<div class="check ok">' + (x.revising ? I.refresh : I.check) + '<span>' + esc(base(x.rel)) + ' \u00b7 ' + x.how + '</span></div>').join('') +
      p.held.map(x => '<div class="check no">' + I.x + '<span>' + esc(base(x.rel)) + ' \u2013 held back: ' + esc(x.reason) + '</span></div>').join('') +
      (offerRecreate(cur) ? '<div class="opt" data-a="toggleRecreate"><span class="box ' + (ui.setRecreate ? '' : 'off') + '">' + (ui.setRecreate ? '\u2713' : '') + '</span><span><b>Tick Re-create promotion branch in Copado</b><br><span class="muted">Copado uses changed resolutions only when it rebuilds the promotion branch. Unticked by itself once Copado validates it successfully.</span></span></div>' : '') +
      (p.last ? '<div class="opt" data-a="toggleStatus"><span class="box ' + (ui.setStatus ? '' : 'off') + '">' + (ui.setStatus ? '\u2713' : '') + '</span><span><b>Set the status to Conflicts Resolved</b><br><span class="muted">These are the last conflicts \u2013 Copado\u2019s editor would set it now.</span></span></div>' : '') +
      '</div><footer><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" data-a="upload">' + I.upload + (all ? 'Replace ' : 'Upload ') + p.ready.length + '</button></footer></div></div>';
  }

  const offerRecreate = cur => cur.plan.revised > 0 && cur.info && cur.info.recreate && !cur.info.recreate.missing && !cur.info.recreate.value;

  function promotions() {
    const cur = data.current;
    if (!cur) return start();
    const files = Object.values(cur.state.files);
    const allDone = files.length && files.every(e => e.state === 'uploaded' || e.state === 'copado');
    if (ui.tab === 'Deployment' && !cur.jobs && !ui.asked['jobs' + cur.promotion.id]) { ui.asked['jobs' + cur.promotion.id] = true; setTimeout(() => act('jobs'), 0); }
    if (ui.tab === 'Components' && !cur.components && !ui.asked['comps' + cur.promotion.id]) { ui.asked['comps' + cur.promotion.id] = true; setTimeout(() => act('components'), 0); }
    pickSel(cur, allDone);
    if (cur.precheck && cur.precheck.state === 'running' && ui.seenRun !== cur.precheck.id) { ui.seenRun = cur.precheck.id; ui.tab = 'Pre-check'; keep(); }
    const body = ui.tab === 'Activity' ? activity(cur) : ui.tab === 'Deployment' ? deployment(cur) : ui.tab === 'Pre-check' ? precheckView(cur) : ui.tab === 'Components' ? componentsView(cur) : !files.length ? branchView(cur, false)
      : '<div class="split">' + list(cur, allDone) + (allDone && ui.sel === OVERVIEW ? '<div class="detail">' + overview(cur) + '</div>' : detail(cur)) + '</div>';
    return header(cur) + validationNote() + body + (ui.modal ? modal(cur) : '');
  }

  /* ------------------------------------------------------------ stories */

  function storiesView() {
    const S = (data.life || {}).story || {};
    const j = S.journey;
    const form = '<div class="toolbar">' + I.user + '<span class="field small"><input id="sref" placeholder="A user story, such as US-0012345" value="' + esc(ui.sref) + '"></span><button class="btn primary small" data-l="story.open"' + (data.copadoOrg ? '' : ' disabled') + '>Show journey</button>' +
      '<span class="muted">Where a story has been, where it is, and where it goes next.</span></div>';
    if (S.error) return '<div class="scroll">' + form + '<div class="card bad">' + esc(S.error) + '</div></div>';
    if (!j) return '<div class="scroll">' + form + '<div class="empty">Enter a story to see its promotions per stage.</div></div>';
    const s = j.story;
    const stage = (x, i) => '<li class="step ' + ({ done: 'done', current: 'now', next: 'next' }[x.state] || '') + '"><span class="node">' + (x.state === 'done' ? I.check : i + 1) + '</span>' +
      '<span class="lbl"><b>' + esc(x.env) + '</b><small>' + esc({ done: 'passed', current: 'here now', next: 'next', ahead: 'later' }[x.state]) + '</small></span><div class="stagecard">' +
      (x.branch ? '<div class="mono muted small">' + esc(x.branch) + '</div>' : '') +
      (x.promotion ? '<button class="pr" data-l="promotion.open" data-id="' + esc(x.promotion.id) + '"><span>' + esc(x.promotion.name) + '</span>' + chip(x.promotion.status) + '</button><div class="muted small">' + esc(day(x.promotion.created)) + '</div>' : '<div class="muted small">' + (x.state === 'done' || x.state === 'current' ? 'started here' : 'not promoted yet') + '</div>') + '</div></li>';
    return '<div class="scroll">' + form + '<div class="jhead"><h2>' + esc(s.name) + '</h2>' + chip(s.status) + (j.hotfix ? '<span class="chip conflict">' + I.flash + 'hotfix</span>' : '') + '<span class="muted">' + esc(s.title) + '</span></div>' +
      '<div class="meta">' + (j.pipeline ? '<span>' + I.route + esc(j.pipeline) + '</span>' : '') + '<span>' + I.dot + 'in ' + esc(s.env || '?') + '</span>' + (s.baseBranch ? '<span>' + I.branch + 'based on ' + esc(s.baseBranch) + '</span>' : '') + (s.release ? '<span>' + I.file + 'release ' + esc(s.release) + '</span>' : '') + '</div>' +
      '<ol class="track journey">' + j.stages.map(stage).join('') + '</ol>' +
      (j.next ? '<div class="card"><h3>' + I.arrow + 'Next: ' + esc(j.next.env) + '</h3><div class="muted">Validate ' + esc(s.name) + '\u2019s ' + (j.hotfix ? 'hotfix' : 'feature') + ' branch against ' + esc(j.next.env) + '. Nothing is deployed.</div>' +
        '<div class="actions"><button class="btn primary" data-l="story.validate" title="Check-only, from the story\u2019s feature branch">' + I.beaker + 'Validate from the branch</button>' +
        '<button class="btn secondary" data-l="story.package" title="The story\u2019s package.xml, from its commit">' + I.box + 'package.xml</button>' +
        '<button class="btn secondary" data-l="story.report" title="What Copado holds about this story \u2013 read-only">' + I.report + 'Story report</button></div></div>'
        : '<div class="card"><h3>' + I.check + 'At the end of the pipeline</h3><div class="muted">' + (j.backTo && j.backTo.length ? 'A hotfix in production is back-promoted to ' + esc(j.backTo.join(', ')) + '.' : 'Nothing further to promote.') + '</div></div>') +
      (j.promotions.length ? '<div class="sect">Promotions</div><table class="grid"><thead><tr><th>Promotion</th><th>From \u2192 to</th><th>Status</th><th>Date</th></tr></thead><tbody>' + j.promotions.map(p => '<tr><td><button class="link" data-l="promotion.open" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button>' + (p.back ? ' <span class="chip info">back</span>' : '') +
        '</td><td>' + esc((p.from || '?') + ' \u2192 ' + (p.to || '?')) + '</td><td>' + chip(p.status) + '</td><td class="muted">' + esc(day(p.created)) + '</td></tr>').join('') + '</tbody></table>' : '') + '</div>';
  }

  /* ------------------------------------------------------------ drawing */

  // ---- Promotions, with nothing open: one box to open a promotion or a story, recent work, tools ----
  function start() {
    const search = '<div class="hsearch">' + I.search + '<input id="href" placeholder="Open a promotion or a story \u2013 P12345, US-0012345, or a Copado link" value="' + esc(ui.href) + '"' + (data.copadoOrg ? '' : ' disabled') + '>' +
      '<button class="btn primary" data-a="homeOpen"' + (data.copadoOrg ? '' : ' disabled') + '>Open</button></div>';
    const hero = '<div class="hero"><h1>Open a promotion</h1><div class="lead">' + (data.copadoOrg
      ? 'Its conflicts are merged for you to review \u2013 nothing in Copado changes until you upload. A user story opens its journey.'
      : 'Set the Copado org to open promotions and stories: <a href="#" data-tool="workbench.action.openSettings">Settings</a> \u203a Copado org \u2013 or merge by hand on the Manual tab.') + '</div>' + search + '</div>';
    const recent = data.recent || [];
    const tools = [['cmr.validate.run', 'shield', 'Validate a deployment', 'Check-only, against an org'], ['cmr.git.check', 'branch', 'Branch conflicts', 'Two git branches, nothing changed']]
      .map(([id, ic, t, d]) => '<button class="htool" data-tool="' + id + '"><span class="ti">' + I[ic] + '</span><span class="tt"><b>' + t + '</b><small>' + d + '</small></span></button>').join('') +
      '<button class="htool" data-nav="Manual"><span class="ti">' + I.branch + '</span><span class="tt"><b>Compare versions</b><small>Two versions, pasted or chosen</small></span></button>';
    return '<div class="scroll home">' + hero + '<div class="hgrid"><div>' +
      (recent.length ? '<div class="section-title">Recent promotions</div><div class="card hrecent">' + recent.map(r => '<div class="hrow"><b>' + esc(r.name) + '</b>' + chip(r.status) + '<span class="muted">' + esc(r.from || '?') + ' ' + I.arrow + ' ' + esc(r.to || '?') + '</span><span class="spacer"></span>' +
        '<button class="btn ghost small" data-a="openRecent" data-ref="' + esc(r.name) + '">' + (r.total && r.done !== r.total ? 'Continue' : 'Open') + '</button></div>').join('') + '</div>'
        : '<div class="muted hnone">Promotions you open appear here.</div>') +
      '</div><div><div class="section-title">Tools</div>' + tools + '</div></div></div>';
  }

  // ---- Manual: two versions pasted, dropped or chosen, merged in the merge editor; a package from a commit ----
  function manualView() {
    const m = data.manual || {};
    const card = (side, title, sub) => {
      const d = m[side];
      const chip = d ? '<span class="chip ' + (d.valid ? 'resolved' : 'bad') + '">' + esc((d.type || 'not XML') + ' \u00b7 ' + d.lines + ' line' + (d.lines === 1 ? '' : 's') + ' \u00b7 ' + (d.valid ? 'valid' : 'not valid')) + '</span>' : '';
      const body = d ? '<div class="mcode">' + d.head.map((l, i) => '<div><span class="ln">' + (i + 1) + '</span>' + esc(l) + '</div>').join('') + (d.lines > d.head.length ? '<div class="more">\u2026 ' + (d.lines - d.head.length) + ' more lines</div>' : '') + '</div>' +
          (d.valid ? '' : '<div class="mbad">' + esc(d.problem) + '</div>')
        : '<textarea class="mpaste" data-side="' + side + '" aria-label="Paste the ' + title.toLowerCase() + ' here" placeholder="Paste here (Ctrl+V) \u00b7 or drop a file"></textarea>';
      return '<div class="card mside" data-drop="' + side + '"><div class="mhead"><b>' + title + '</b><span class="muted">' + sub + '</span><span class="spacer"></span>' + chip + '</div>' + body +
        '<div class="mfoot"><button class="link" data-m="manual.pick" data-side="' + side + '">' + (d ? 'Choose another file\u2026' : 'Choose a file\u2026') + '</button>' +
        (d ? '<button class="link" data-m="manual.clear" data-side="' + side + '">Clear</button>' + (d.name ? '<span class="muted mono">' + esc(d.name) + '</span>' : '') : '') + '</div></div>';
    };
    const ready = m.target && m.incoming && m.target.valid && m.incoming.valid;
    const c = m.commit;
    return '<div class="scroll"><div class="manual">' +
      '<div class="sect">Compare two versions</div>' +
      '<div class="mpair">' + card('target', 'Target', 'the target branch') +
      '<div class="mmid"><button class="btn secondary icon" data-m="manual.swap" title="Swap the two sides" aria-label="Swap the two sides"' + (m.target || m.incoming ? '' : ' disabled') + '>\u21c4</button></div>' +
      card('incoming', 'Incoming', 'the feature branch') + '</div>' +
      '<div class="actions"><button class="btn primary" data-m="manual.merge"' + (ready ? '' : ' disabled') + '>Compare</button><button class="btn secondary" data-m="manual.clearBoth"' + (m.target || m.incoming ? '' : ' disabled') + '>\u2715 Clear both</button><span class="muted">Side by side \u2013 both editable: format, sort, remove duplicates, save either as a file</span></div>' +
      (m.last ? '<div class="card mlast"><b>Last comparison</b><span class="muted">' + esc(m.last.type) + ' \u00b7 ' + esc(ago(m.last.at)) + '</span><span class="spacer"></span><button class="btn secondary small" data-m="manual.again">Open again</button></div>' : '') +
      '<div class="sect">Package from a Copado commit</div>' +
      '<div class="card mside" data-drop="commit">' + (c ? '<div class="mhead"><b>' + esc(c.name || 'Commit') + '</b><span class="muted">' + plural(c.components || 0, 'component') + '</span><span class="spacer"></span><button class="link" data-m="manual.commitClear">Clear</button></div>'
        : '<textarea class="mpaste small" data-side="commit" aria-label="Paste a Copado commit file here" placeholder="Paste or drop a Copado commit file \u2013 the \u201cCopado Commit changes\u201d of a story"></textarea>') +
      '<div class="mfoot">' + (c ? '' : '<button class="link" data-m="manual.commitPick">Choose a file\u2026</button>') +
      '<span class="spacer"></span><button class="btn secondary small" data-m="manual.package"' + (c ? '' : ' disabled') + '>Generate package.xml</button><button class="btn secondary small" data-m="manual.validate">Validate against an org\u2026</button></div></div>' +
      '</div></div>';
  }
  // pasting or dropping into a card: its text to the extension, which keeps it
  // ---- Compare: two branches, every file that differs - opened in the merge editor ----
  // ---- Compare: the same chips, icons and buttons throughout ----
  const CPLUS = sv('<path d="M12 5v14M5 12h14"/>');
  const KIND = { removed: ['bad', I.x, 'removed'], changed: ['info', I.diff, 'changed'], added: ['resolved', CPLUS, 'new'] };
  const kindChip = (k, text) => '<span class="chip ' + KIND[k][0] + ' ichip">' + KIND[k][1] + esc(text == null ? KIND[k][2] : text) + '</span>';
  const ctypeIcon = t => CICON[/^Apex/.test(t) ? 'code' : /field|object|value set|record type|list view|compact|label|metadata record/i.test(t) ? 'field'
    : /page|layout|tab|app/i.test(t) ? 'page' : /component|resource|agentforce|bot/i.test(t) ? 'cube' : /permission|profile|role|group|queue|sharing/i.test(t) ? 'person'
      : /flow|process|approval|workflow/i.test(t) ? 'flow' : 'box'];
  function compareView() {
    const c = data.compare || {};
    // a branch picker that searches: thousands of branches, the first 50 that match shown under it
    const pick = (side, label) => {
      const q = ui.cq && ui.cq[side] != null ? ui.cq[side] : (c[side] || '');
      const open = ui.copen === side;
      const all = c.branches || [], ql = q.toLowerCase();
      const hits = open ? all.filter(b => !ql || b.toLowerCase().includes(ql)) : [];
      return '<span class="cpick"><span class="muted">' + label + '</span><span class="cbox">' + I.branch + '<input class="cq mono" id=\"cq-' + side + '\" data-cq="' + side + '" value="' + esc(q) + '" placeholder="' + (all.length ? 'Search branches' : 'Reading the branches\u2026') + '"' + (all.length ? '' : ' disabled') + ' aria-label="' + label + ' branch" autocomplete="off" spellcheck="false">' +
        (open ? '<div class="clist" role="listbox">' + (hits.length ? hits.slice(0, 50).map(b => '<div class="copt mono' + (b === c[side] ? ' on' : '') + '" role="option" data-cpick="' + side + '" data-branch="' + esc(b) + '">' + esc(b) + '</div>').join('') +
          (hits.length > 50 ? '<div class="cmore muted">' + (hits.length - 50) + ' more \u2013 keep typing</div>' : '') : '<div class="cmore muted">No branch matches</div>') + '</div>' : '') + '</span></span>';
    };
    if (c.connected === false) return '<div class="scroll"><div class="manual"><div class="sect">Compare branches</div><div class="card cempty"><b>No repository connected</b><span class="spacer"></span><button class="btn primary" data-c="compare.connect">' + I.key + 'Connect repository</button></div></div></div>';
    // what differs only in spacing or order is the same as the other: not listed, not counted
    const files = (c.files || []).filter(f => !f.same);
    // the types, to choose from - with how many of each
    const types = [];
    for (const f of files) { const t = types.find(x => x.type === f.type); if (t) t.n++; else types.push({ type: f.type, n: 1 }); }
    types.sort((a, b) => a.type.localeCompare(b.type));
    const chosen = new Set((ui.ctypes || []).filter(t => types.some(x => x.type === t)));
    const q = (ui.cfilter || '').toLowerCase();
    const shown = files.filter(f => (!chosen.size || chosen.has(f.type)) && (!q || (f.name + ' ' + f.path).toLowerCase().includes(q)));
    const n = k => shown.filter(f => f.kind === k).length, dups = shown.filter(f => / duplicate/.test(f.summary || '')).length;
    const row = f => '<div class="crow2"><span class="ck">' + kindChip(f.kind) + '</span><span class="cn mono">' + esc(f.name) + '</span>' +
      (f.kind === 'changed' ? '<span class="muted">' + esc(f.summary || '\u2026') + '</span>' : '') + '<span class="spacer"></span>' +
      '<button class="btn secondary small" data-c="compare.open" data-path="' + esc(f.path) + '">' + (f.kind === 'changed' ? I.diff + 'Compare' : I.file + 'Open') + '</button></div>';
    // what was removed or changed first, then what is new - and only so many at once
    const limit = ui.climit || 50;
    let left = limit;
    const section = (title, list) => {
      if (!list.length || left <= 0) return '';
      const take = list.slice(0, left); left -= take.length;
      const groups = [];
      for (const f of take) { const g = groups.find(x => x.type === f.type); if (g) g.files.push(f); else groups.push({ type: f.type, files: [f] }); }
      return '<div class="csect">' + esc(title) + ' <span class="muted">' + list.length + '</span></div>' + groups.map(g => '<div class="cgroup"><div class="cgh">' + ctypeIcon(g.type) + esc(g.type) + ' <span class="muted">' + g.files.length + '</span></div>' + g.files.map(row).join('') + '</div>').join('');
    };
    const first = shown.filter(f => f.kind !== 'added'), later = shown.filter(f => f.kind === 'added');
    ui.cvisible = shown.slice(0, limit).filter(f => f.kind === 'changed' && !f.summary).map(f => f.path);
    // the types: a button, and under it a list with its own search
    const tq = (ui.ctq || '').toLowerCase();
    const typeMenu = ui.ctopen ? '<div class="clist ctlist"><div class="ctsearch">' + I.search + '<input class="ctq" id=\"ctq\" placeholder="Search types" value="' + esc(ui.ctq || '') + '" aria-label="Search types"></div>' +
      types.filter(t => !tq || t.type.toLowerCase().includes(tq)).map(t => '<div class="copt ctopt' + (chosen.has(t.type) ? ' on' : '') + '" data-ctype="' + esc(t.type) + '"><span class="cbx">' + (chosen.has(t.type) ? I.check : '') + '</span>' + ctypeIcon(t.type) + '<span>' + esc(t.type) + '</span><span class="spacer"></span><span class="muted">' + t.n + '</span></div>').join('') +
      (chosen.size ? '<div class="ctfoot"><button class="link" data-ctclear="1">Show all types</button></div>' : '') + '</div>' : '';
    const typeBtn = '<span class="cbox"><button class="btn secondary" data-ctopen="1" aria-expanded="' + !!ui.ctopen + '">' + I.filter + (chosen.size === 1 ? esc([...chosen][0]) : chosen.size ? chosen.size + ' types' : 'All types') + I.chevD + '</button>' + typeMenu + '</span>';
    return '<div class="scroll"><div class="manual">' +
      '<div class="sect">Compare branches</div>' +
      '<div class="card cbar">' + pick('from', 'From') + '<span class="muted">\u2192</span>' + pick('to', 'To') +
      '<button class="btn secondary icon" data-c="compare.swap" title="Swap" aria-label="Swap the branches">\u21c4</button>' +
      '<button class="btn primary" data-c="compare.run"' + (c.from && c.to && c.from !== c.to && !c.busy ? '' : ' disabled') + '>' + I.diff + 'Compare</button>' +
      '<button class="btn secondary" data-c="compare.reset"' + (c.from || c.to || c.files ? '' : ' disabled') + '>' + I.reset + 'Reset</button>' +
      '<span class="spacer"></span><span class="muted">' + esc(c.busy ? c.busy + '\u2026' : c.at ? ago(c.at) : '') + '</span><button class="btn secondary icon" data-c="compare.refresh" title="Read the branches again" aria-label="Read the branches again">' + I.refresh + '</button></div>' +
      (c.error ? '<div class="card cerr">' + esc(c.error) + '</div>' : '') +
      (c.files ? '<div class="csum">' + (n('removed') ? kindChip('removed', n('removed') + ' removed') : '') + (n('changed') ? kindChip('changed', n('changed') + ' changed') : '') + (n('added') ? kindChip('added', n('added') + ' new') : '') +
        (dups ? '<span class="chip warn ichip">' + I.warn + dups + ' with duplicates</span>' : '') + (files.length ? '' : '<span class="muted">No differences.</span>') +
        '<span class="spacer"></span>' + typeBtn + '<span class="csearch">' + I.search + '<input class="cfilter" id=\"cfilter\" placeholder="Search" value="' + esc(ui.cfilter || '') + '" aria-label="Search"></span></div>' +
        section('Removed or changed', first) + section('New in ' + c.from, later) +
        (shown.length > limit ? '<div class="cpage"><button class="btn secondary" data-cmore="1">' + I.chevD + 'Show ' + Math.min(50, shown.length - limit) + ' more</button><span class="muted">' + (shown.length - limit) + ' more</span></div>' : '') : '') +
      '</div></div>';
  }
  function compareEvents() {
    if (typeof document.querySelectorAll !== 'function') return;
    const c = data.compare || {};
    if (c.branches == null && !c.busy && c.connected !== false && !ui.cloading) { ui.cloading = true; cact('compare.load'); }
    // the rows shown: their summaries asked for, once
    ui.casked = ui.casked || new Set();
    const ask = (ui.cvisible || []).filter(p => !ui.casked.has(p));
    if (ask.length) { for (const p of ask) ui.casked.add(p); cact('compare.summaries', { paths: ask }); }
    const keepFocus = (sel, at) => { const g = document.querySelector(sel); if (g) { g.focus(); if (at != null && g.setSelectionRange) g.setSelectionRange(at, at); } };
    for (const inp of document.querySelectorAll('input[data-cq]')) {
      const side = inp.dataset.cq;
      inp.addEventListener('focus', () => { if (!ui.restoring && ui.copen !== side) { ui.copen = side; ui.cq = Object.assign({}, ui.cq, { [side]: '' }); render(); keepFocus('input[data-cq="' + side + '"]', 0); } });
      inp.addEventListener('input', () => { ui.cq = Object.assign({}, ui.cq, { [side]: inp.value }); const at = inp.selectionStart; render(); keepFocus('input[data-cq="' + side + '"]', at); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Escape') { ui.copen = null; ui.cq = {}; render(); }
        if (e.key === 'Enter') { const o = document.querySelector('.copt'); if (o) { e.preventDefault(); ui.copen = null; ui.cq = {}; cact('compare.set', { side, value: o.dataset.branch }); } }
      });
    }
    const f = document.querySelector('.cfilter');
    if (f) f.addEventListener('input', () => { ui.cfilter = f.value; ui.climit = 50; const at = f.selectionStart; render(); keepFocus('.cfilter', at); });
    const tq = document.querySelector('.ctq');
    if (tq) tq.addEventListener('input', () => { ui.ctq = tq.value; const at = tq.selectionStart; render(); keepFocus('.ctq', at); });
  }

  function manualEvents() {
    if (typeof document.querySelectorAll !== 'function') return;
    const send = (side, text, name) => side === 'commit' ? mact('manual.commitSet', { text, name }) : mact('manual.set', { side, text, name });
    for (const t of document.querySelectorAll('.mpaste')) {
      t.addEventListener('paste', e => { const text = e.clipboardData && e.clipboardData.getData('text'); if (text) { e.preventDefault(); send(t.dataset.side, text, null); } });
      t.addEventListener('input', () => { if (t.value.trim().length > 20) send(t.dataset.side, t.value, null); });
    }
    for (const c of document.querySelectorAll('[data-drop]')) {
      c.addEventListener('dragover', e => { e.preventDefault(); c.classList.add('over'); });
      c.addEventListener('dragleave', () => c.classList.remove('over'));
      c.addEventListener('drop', e => {
        e.preventDefault(); c.classList.remove('over');
        const side = c.dataset.drop, dt = e.dataTransfer;
        const f = dt && dt.files && dt.files[0];
        if (f && typeof FileReader !== 'undefined') { const r = new FileReader(); r.onload = () => send(side, String(r.result), f.name); r.readAsText(f); return; }
        // from VS Code's Explorer: the file's address
        const u = dt && (dt.getData('text/uri-list') || dt.getData('text/plain'));
        if (u && side !== 'commit') mact('manual.dropUri', { side, uri: u.split(/\r?\n/)[0] });
      });
    }
  }

  function render() {
    if (!data) { app.innerHTML = '<div class="empty">Loading\u2026</div>'; return; }
    // keep the caret where it was: a redraw replaces every element
    const a = document.activeElement, focus = a && a.id ? { id: a.id, pos: a.selectionStart } : null;
    const body = ui.nav === 'Stories' ? storiesView() : ui.nav === 'Manual' ? manualView() : ui.nav === 'Compare' ? compareView() : promotions();
    app.className = ui.busy ? 'is-busy' : '';
    app.innerHTML = topbar(ui.nav === 'Promotions' ? data.current : null) + body;
    const bind = (id, key, submit) => { const el = document.getElementById(id); if (!el) return; el.addEventListener('input', () => { ui[key] = el.value; keep(); }); el.addEventListener('keydown', ev => { if (ev.key === 'Enter') submit(); }); };
    bind('ref', 'ref', openRef); bind('sref', 'sref', openStory); bind('href', 'href', openAny);
    const cn = document.getElementById('cname'); if (cn) cn.addEventListener('input', () => { ui.compName = cn.value; render(); });
    if (ui.nav === 'Manual') manualEvents();
    if (ui.nav === 'Compare') compareEvents();
    const f = document.getElementById('filter'); if (f) f.addEventListener('input', () => { ui.filter = f.value; render(); });
    const back = focus && document.getElementById(focus.id);
    // putting the caret back is not a new focus: a branch list closed stays closed
    if (back) { ui.restoring = true; back.focus(); ui.restoring = false; if (focus.pos != null && back.setSelectionRange) back.setSelectionRange(focus.pos, focus.pos); }
    else if (ui.nav === 'Promotions' && !data.current) { const r = document.getElementById('ref'); if (r) r.focus(); }
  }
  const openRef = () => { if (ui.ref.trim()) act('open', { ref: ui.ref.trim() }); };
  const openStory = () => { const v = ui.sref.trim(); if (v && okRef(v)) lact('story.open', { ref: v }); };
  // Home's one box: a story opens its journey, anything else the promotion
  const openAny = () => {
    const v = ui.href.trim(); if (!v) return;
    if (/^US-\d+$/i.test(v)) { ui.nav = 'Stories'; ui.sref = v; keep(); render(); return lact('story.open', { ref: v }); }
    ui.nav = 'Promotions'; ui.ref = v; keep(); render(); act('open', { ref: v });
  };

  app.addEventListener('click', ev => {
    const t = ev.target.closest('[data-a],[data-sel],[data-tab],[data-tool],[data-choose],[data-nav],[data-l],[data-m],[data-c],[data-cpick],[data-cmore],[data-ctopen],[data-ctype],[data-ctclear]');
    // a click outside an open list closes it
    if ((ui.copen || ui.ctopen) && !ev.target.closest('.cbox')) { ui.copen = null; ui.cq = {}; ui.ctopen = false; if (!t) { render(); return; } }
    if (!t) return;
    ev.preventDefault();
    if (t.dataset.nav) {
      if (t.dataset.nav === 'Promotions' && ui.nav === 'Promotions' && data.current) { ui.sel = null; ui.modal = false; ui.tab = 'Files'; keep(); render(); return act('home'); }
      ui.nav = t.dataset.nav; keep(); return render();
    }
    if (t.dataset.tool) return vscode.postMessage({ type: 'tool', id: t.dataset.tool });
    if (t.dataset.m) { if (!t.disabled) mact(t.dataset.m, { side: t.dataset.side }); return; }
    if (t.dataset.cpick) { ui.copen = null; ui.cq = {}; cact('compare.set', { side: t.dataset.cpick, value: t.dataset.branch }); return; }
    if (t.dataset.cmore) { ui.climit = (ui.climit || 50) + 50; render(); return; }
    if (t.dataset.ctopen) { ui.ctopen = !ui.ctopen; ui.ctq = ''; render(); if (ui.ctopen && typeof document.querySelector === 'function') { const g = document.querySelector('.ctq'); if (g) g.focus(); } return; }
    if (t.dataset.ctype) { const set = new Set(ui.ctypes || []); if (set.has(t.dataset.ctype)) set.delete(t.dataset.ctype); else set.add(t.dataset.ctype); ui.ctypes = [...set]; ui.climit = 50; render(); return; }
    if (t.dataset.ctclear) { ui.ctypes = []; ui.climit = 50; render(); return; }
    if (t.dataset.c) { if (!t.disabled) { if (t.dataset.c === 'compare.run' || t.dataset.c === 'compare.reset') { ui.climit = 50; ui.casked = new Set(); ui.ctypes = []; ui.cfilter = ''; ui.cq = {}; ui.copen = null; ui.ctopen = false; } cact(t.dataset.c, { path: t.dataset.path }); } return; }
    if (t.dataset.l) {
      const n = t.dataset.l;
      if (n === 'story.open') return t.dataset.ref ? lact(n, { ref: t.dataset.ref }) : openStory();
      return lact(n, { id: t.dataset.id });
    }
    if (t.dataset.sel) { ui.sel = t.dataset.sel; if (t.dataset.go) ui.tab = t.dataset.go; keep(); return render(); }
    if (t.dataset.tab) { ui.tab = t.dataset.tab; keep(); return render(); }
    if (t.dataset.choose != null) { const m = ui.choices[ui.sel] = ui.choices[ui.sel] || {}; m[t.dataset.choose] = t.dataset.side; keep(); return render(); }
    const a = t.dataset.a, rel = ui.sel;
    if (a === 'precheck') { ui.tab = 'Pre-check'; keep(); render(); }
    if (a === 'open') return openRef();
    if (a === 'homeOpen') return openAny();
    if (a === 'openRecent') return act('open', { ref: t.dataset.ref });
    if (a === 'uploadAsk') { ui.modal = true; return render(); }
    if (a === 'cancel') { ui.modal = false; return render(); }
    if (a === 'toggleStatus') { ui.setStatus = !ui.setStatus; return render(); }
    if (a === 'upload') { ui.modal = false; render(); return act('upload', { status: ui.setStatus, recreate: offerRecreate(data.current) && ui.setRecreate }); }
    if (a === 'toggleRecreate') { ui.setRecreate = !ui.setRecreate; return render(); }
    if (a === 'earlier') { ui.earlier = !ui.earlier; return render(); }
    if (a === 'compFilter') { ui.compFilter = t.dataset.v; return render(); }
    if (a === 'compFold') { ui.compFold = Object.assign({}, ui.compFold, { [t.dataset.v]: !(ui.compFold || {})[t.dataset.v] }); return render(); }
    if (a === 'recreate') return act('recreate', { value: t.dataset.value === '1' });
    if (a === 'revise') { if (t.dataset.rel) { ui.sel = t.dataset.rel; ui.tab = 'Files'; keep(); render(); } return act('revise', { rel: t.dataset.rel || rel }); }
    if (a === 'choose') {
      const e = data.current.state.files[rel], m = Object.assign({}, ui.choices[rel] || {});
      (e.clashes || []).forEach((c, i) => { if (!m[i]) m[i] = 'incoming'; });
      return act('choose', { rel, choices: m });
    }
    if (a === 'home') { ui.sel = null; ui.modal = false; ui.tab = 'Files'; keep(); render(); return act('home'); }
    act(a, { rel });
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && ui.modal) { ui.modal = false; render(); } });

  window.addEventListener('message', ev => {
    const m = ev.data || {};
    if (m.type === 'state') {
      // a promotion just opened - from Home, a search, a recent one: shown on Promotions
      const was = data && data.current ? data.current.promotion.id : null;
      data = m.data;
      const now = data.current ? data.current.promotion.id : null;
      if (now && now !== was && ui.nav !== 'Promotions') { ui.nav = 'Promotions'; keep(); }
      render();
    }
    if (m.type === 'busy') { ui.busy = m.on; render(); }
    if (m.type === 'nav' && NAVS.includes(m.nav)) { ui.nav = m.nav; ui.tab = 'Files'; keep(); render(); }
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
