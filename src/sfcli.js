'use strict';

const { spawn } = require('child_process');

/**
 * Thin wrapper over the Salesforce CLI. The extension never sees a password
 * or token: it uses whatever orgs you have already authorised with `sf`.
 *
 * Only two org-facing operations exist here, and neither changes an org:
 *   retrieve   reads metadata from the source org into the open project,
 *              the same way `sf project retrieve start` always does
 *   validate   a check-only deployment. `sf project deploy validate` when
 *              tests run; `sf project deploy start --dry-run` when they do
 *              not, because validate rejects NoTestRun.
 * There is deliberately no function that performs a real deployment: the
 * only place that builds a "deploy start" command always adds --dry-run.
 */

const NOISE = /update available from|@salesforce\/cli update/i;

function run(sfPath, args, options) {
  const o = Object.assign({ cwd: undefined, onLine: null, token: null }, options || {});
  return new Promise((resolve, reject) => {
    let child;
    const spec = commandFor(sfPath || 'sf', args.concat(['--json']));
    try {
      child = spawn(spec.command, spec.args, {
        cwd: o.cwd, shell: false, windowsHide: true, windowsVerbatimArguments: spec.verbatim,
        env: Object.assign({}, process.env, { SF_DISABLE_COLORS: 'true', FORCE_COLOR: '0', SF_AUTOUPDATE_DISABLE: 'true' })
      });
    } catch (e) { reject(e); return; }

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => {
      err += d;
      if (o.onLine) String(d).split(/\r?\n/).filter(l => l.trim() && !NOISE.test(l)).forEach(l => o.onLine(l));
    });
    if (o.token) o.token.onCancellationRequested(() => { try { child.kill(); } catch (e) { /* gone */ } });
    child.on('error', e => reject(e.code === 'ENOENT'
      ? new Error('The Salesforce CLI (' + (sfPath || 'sf') + ') was not found. Install it or set cmr.sf.path.')
      : e));
    child.on('close', code => {
      const json = parseJson(out);
      resolve({ code, json, stdout: out, stderr: err });
    });
  });
}

/**
 * How to launch the CLI. On Windows `sf` is a .cmd script, which Node only
 * runs through cmd.exe - and cmd.exe splits unquoted arguments at spaces, so
 * "C:\My Projects\manifest\package.xml" would arrive as two arguments. Every
 * argument is therefore quoted and its metacharacters escaped, following the
 * algorithm cross-spawn uses (https://qntm.org/cmd).
 */
function commandFor(cmd, args, platform) {
  if ((platform || process.platform) !== 'win32') return { command: cmd, args, verbatim: false };
  // the program is quoted like an argument, so an install path with spaces works too
  const line = [cmd].concat(args).map(escapeArgument).join(' ');
  return { command: process.env.comspec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
}

const META = /([()\][%!^"`<>&|;, *?])/g;

function escapeArgument(arg) {
  let a = String(arg);
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');   // backslashes before a quote: double them, escape the quote
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');       // trailing backslashes: double them (a quote follows)
  return ('"' + a + '"').replace(META, '^$1');
}

/** sf sometimes prints warnings before the JSON body; take the outermost object. */
function parseJson(text) {
  const s = String(text || '');
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { /* not json */ }
  }
  return null;
}

async function version(sfPath) {
  try {
    const r = await run(sfPath, ['version']);
    if (r.json && r.json.result) return r.json.result.cliVersion || r.json.result.version || 'sf';
    return r.code === 0 ? 'sf' : null;
  } catch (e) { return null; }
}

/** Every authorised org, from `sf org list`, regardless of which bucket it is in. */
function parseOrgs(json) {
  const out = [];
  const seen = new Set();
  walk(json && json.result, v => {
    if (v && typeof v === 'object' && typeof v.username === 'string' && !seen.has(v.username)) {
      seen.add(v.username);
      out.push({
        alias: v.alias || '',
        username: v.username,
        instanceUrl: v.instanceUrl || '',
        isSandbox: !!v.isSandbox || /sandbox|\.cs\d+\.|--/i.test(v.instanceUrl || ''),
        connected: !v.connectedStatus || /connected/i.test(v.connectedStatus)
      });
    }
  });
  return out.sort((a, b) => (a.alias || a.username).localeCompare(b.alias || b.username));
}

async function listOrgs(sfPath, cwd) {
  const r = await run(sfPath, ['org', 'list'], { cwd });
  if (!r.json) throw new Error('Could not read the org list from the Salesforce CLI.' + (r.stderr ? ' ' + r.stderr.trim() : ''));
  return parseOrgs(r.json);
}

/**
 * A standard source-format retrieve into the project's package directories.
 * --ignore-conflicts lets it overwrite local files, which is the intent here.
 */
function retrieveArgs(o) {
  return ['project', 'retrieve', 'start',
    '--manifest', o.manifest,
    '--target-org', o.org,
    '--ignore-conflicts',
    '--wait', String(o.wait || 33)];
}

/**
 * `deploy validate` only accepts RunSpecifiedTests, RunLocalTests and
 * RunAllTestsInOrg. Without tests the same check-only deployment is
 * `deploy start --dry-run`, which does accept NoTestRun.
 */
function validateArgs(o) {
  const noTests = !o.testLevel || o.testLevel === 'NoTestRun';
  const args = noTests
    ? ['project', 'deploy', 'start', '--dry-run', '--test-level', 'NoTestRun']
    : ['project', 'deploy', 'validate', '--test-level', o.testLevel];
  args.push('--target-org', o.org, '--wait', String(o.wait || 60), '--manifest', o.manifest);
  if (o.destructiveChanges) args.push('--post-destructive-changes', o.destructiveChanges);
  if (o.testLevel === 'RunSpecifiedTests') for (const t of o.tests || []) args.push('--tests', t);
  return args;
}

/* ------------------------------------------------------- live output */

/**
 * Runs a command the way a terminal does - without --json - and passes every
 * line the CLI prints to onLine as it arrives, so its own progress (stages,
 * component counts, test counts) is visible. Lines the CLI redraws in place
 * (spinners, elapsed time) go to onStatus instead of flooding the log.
 */
function stream(sfPath, args, options) {
  const o = Object.assign({ cwd: undefined, onLine: null, onStatus: null, token: null, progressIntervalMs: 0, env: null }, options || {});
  return new Promise((resolve, reject) => {
    const lines = [];
    const status = s => { if (o.onStatus) o.onStatus(s); };
    const filter = reprintFilter(l => { lines.push(l); if (o.onLine) o.onLine(l); }, status, { intervalMs: o.progressIntervalMs });
    const out = lineCleaner(l => filter.line(l), status);
    const err = lineCleaner(l => filter.line(l), status);
    let child;
    const spec = commandFor(sfPath || 'sf', args);
    try {
      child = spawn(spec.command, spec.args, {
        cwd: o.cwd, shell: false, windowsHide: true, windowsVerbatimArguments: spec.verbatim,
        env: Object.assign({}, process.env, { SF_DISABLE_COLORS: 'true', FORCE_COLOR: '0', SF_AUTOUPDATE_DISABLE: 'true' }, o.env || {})
      });
    } catch (e) { reject(e); return; }
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    if (o.token) o.token.onCancellationRequested(() => { try { child.kill(); } catch (e) { /* gone */ } });
    child.on('error', e => reject(e.code === 'ENOENT'
      ? new Error('The Salesforce CLI (' + (sfPath || 'sf') + ') was not found. Install it or set cmr.sf.path.')
      : e));
    child.on('close', code => { out.flush(); err.flush(); filter.flush(); resolve({ code, lines }); });
  });
}

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78]/g;

/**
 * Turns a raw output stream into clean lines: colour codes removed, a line the
 * CLI rewrote with carriage returns reduced to its final text, spinner glyphs
 * dropped, repeats and runs of blank lines collapsed.
 */
function lineCleaner(emit, status) {
  let buf = '';
  let last = null;
  const clean = s => s.replace(ANSI, '').replace(/\s+$/, '');
  const finalSegment = raw => {
    const parts = raw.split('\r').map(clean).filter(p => p.trim());
    return parts.length ? parts[parts.length - 1] : '';
  };
  const take = raw => {
    const line = finalSegment(raw);
    if (line === last || NOISE.test(line) || /^[\u2800-\u28ff\s]+$/.test(line)) return;
    last = line;
    emit(line);
  };
  return {
    push(chunk) {
      buf += String(chunk);
      let i;
      while ((i = buf.search(/\r?\n/)) !== -1) {
        const nl = buf[i] === '\r' ? 2 : 1;
        take(buf.slice(0, i));
        buf = buf.slice(i + nl);
      }
      // a line still being redrawn in place is a status, not a log line
      if (buf.indexOf('\r') !== -1 && status) {
        const s = finalSegment(buf);
        if (s.trim()) status(s.replace(SPIN, '').trim());
      }
    },
    flush() { if (buf) take(buf); buf = ''; }
  };
}

/**
 * When its output goes to a pipe rather than a terminal, the CLI cannot
 * redraw in place, so it reprints its whole progress block - a frame - on
 * every tick, dozens of times a second. This shows that as snapshots:
 *
 *   - until the CLI starts reprinting, lines are shown live as they come;
 *   - a frame starts at the CLI's ruled heading; once that heading comes round
 *     again, the CLI is reprinting, and each new frame
 *     is compared with the last one shown by its words only: spinner glyphs
 *     (| / - \ and the braille dots), stage symbols, timers and numbers are
 *     ignored;
 *   - a frame whose words changed - Pending becoming In Progress, Succeeded or
 *     Failed, a new stage, an error, the result table - is shown whole, as it
 *     stood at that moment;
 *   - an unchanged frame is not shown; its live line goes to the notification;
 *   - a frame that only adds lines to the one shown (the result table after
 *     the final status) prints just the added lines.
 *
 * With intervalMs above 0, an unchanged frame is also shown once per interval.
 */
function reprintFilter(emit, status, options) {
  const o = Object.assign({ intervalMs: 0, now: Date.now }, options || {});
  let head = null;          // the frame's heading - when it comes round again, a frame has ended
  let framed = false;       // has the CLI started reprinting?
  let frame = [];           // the frame being collected
  let shown = null;         // shapes of the last frame shown, line by line
  let shownAt = 0;
  let sinceHead = [];       // lines shown live since the heading first appeared - the first frame
  let lastEmitted = null;
  let blankHeld = false;

  const write = l => { lastEmitted = l; emit(l); };
  // blank lines are held until the next real line; runs become one
  const out = l => {
    if (!l.trim()) { if (lastEmitted !== null && lastEmitted.trim()) blankHeld = true; return; }
    if (blankHeld) { blankHeld = false; write(''); }
    if (l !== lastEmitted) write(l);
  };
  const shapes = lines => lines.filter(l => l.trim()).map(shapeOf);
  const endFrame = () => {
    if (!frame.length) return;
    const now = shapes(frame);
    const same = shown && now.length === shown.length && now.every((s, i) => s === shown[i]);
    // once the status is final, what follows (the result table) is printed on its own;
    // before that, a frame that grows is a new moment and is shown whole
    const final = shown && shown.some(s => /^Status: (Succeeded|Failed|Canceled|Cancelled|SucceededPartial|Error)\b/i.test(s));
    const extends_ = final && now.length > shown.length && shown.every((s, i) => s === now[i]);
    if (extends_) {
      // the same block with lines added after it (the result table): print only what is new
      let seen = 0;
      const rest = [];
      for (const l of frame) {
        if (seen < shown.length) { if (l.trim()) seen++; continue; }
        rest.push(l);
      }
      for (const l of rest) out(l);
      shown = now;
      shownAt = o.now();
    } else if (!same || (o.intervalMs > 0 && o.now() - shownAt >= o.intervalMs)) {
      if (lastEmitted !== null) blankHeld = true;      // a gap before each snapshot
      for (const l of frame) out(l);
      shown = now;
      shownAt = o.now();
    }
    frame = [];
  };

  return {
    line(raw) {
      const spinning = SPIN.test(raw) || SPIN_VALUE.test(raw);
      const l = shownLine(raw);
      if (isHeading(l)) {
        if (head === null) {                            // a framed block may be starting
          head = l;
          sinceHead = [l];
          out(l);
          return;
        }
        if (l === head) {                               // the block is being reprinted
          if (!framed) { framed = true; shown = shapes(sinceHead); shownAt = o.now(); }
          else endFrame();
          frame = [l];
          return;
        }
      }
      if (!framed) {
        if (head !== null) sinceHead.push(l);
        out(l);
        return;
      }
      frame.push(l);
      // the notification gets plain words: no in-progress marker
      if (status && l.trim() && (spinning || /^\s*status:/i.test(l))) status(l.replace(/^\s*\u00bb/, '').trim());
    },
    flush() { if (framed) endFrame(); }
  };
}

/** A spinner glyph at the start of a line, with or without a space after it. */
const SPIN = /^\s*(?:[\u2800-\u28ff]|[|\/\\-](?=\s*[A-Za-z]))\s*/;

/** A spinner standing in for a value that is not known yet - "Status: \". */
const SPIN_VALUE = /(^|\s)(?:[|\/\\-]|[\u2800-\u28ff])(?=\s*$)/;

/** The CLI's ruled title line, "──── Retrieving Metadata ────". */
function isHeading(l) {
  return /[\u2500\u2014\u2013=]{2,}|-{3,}/.test(l) && /[A-Za-z]/.test(l) && l.trim().length < 120;
}

/** A line as shown: the active stage marked, a spinner standing in for a value shown as "…". */
function shownLine(raw) {
  return String(raw)
    .replace(SPIN, m => m.match(/^\s*/)[0] + '\u00bb')
    .replace(SPIN_VALUE, '$1\u2026');
}

const DURATION = /\d+(?:\.\d+)?\s?(?:ms|s|m|h|min|sec)\b/gi;

/**
 * A line as compared: only its words count. Spinner glyphs, status symbols
 * (the tick, square and cross the CLI puts in front of a stage), timers and
 * every other number are blanked - so a turning spinner, a stage symbol, a
 * ticking clock or a moving counter is not a change, while "Pending" becoming
 * "Succeeded", a new stage or an error is.
 */
function shapeOf(l) {
  return String(l)
    .replace(SPIN, '')
    .replace(SYMBOLS, '')
    .replace(/(^|\s)(?:[|\/\\\-\u2026]|[\u2800-\u28ff])(?=\s|$)/g, '$1')
    .replace(DURATION, '#')
    .replace(/\d+(?:[.,]\d+)*/g, '#')
    .replace(/#(?:[\s:]*#)+/g, '#')        // '1m 2.5s' and '23s' both become one number
    .replace(/\s+/g, ' ')
    .trim();
}

/** Symbols at the start of a line that mark a stage's state rather than say anything. */
const SYMBOLS = /^[\s\u00bb\u221a\u2713\u2714\u2716\u2717\u2718\u00d7\u25a0\u25a1\u25cb\u25cf\u25ef\u25b8\u25ba\u2022\u26a0\u2026]+/;

/** What a frame says in words, ignoring spinners, symbols, numbers and blank lines. */
function signature(lines) {
  return lines.filter(l => l.trim()).map(shapeOf).join('\n');
}

/** "1m 19.83s" -> 79830 */
function durationMs(text) {
  let ms = 0;
  let found = false;
  String(text).replace(/(\d+(?:\.\d+)?)\s?(ms|s|m|h)\b/gi, (_, n, u) => {
    found = true;
    ms += parseFloat(n) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 })[u.toLowerCase()];
    return _;
  });
  return found ? Math.round(ms) : null;
}

/** How long the org itself took, from the CLI's last "Waiting for the org to respond" line. */
function orgWaitFrom(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /Waiting for the org to respond\s+(.+)$/i.exec(lines[i]);
    if (m) return durationMs(m[1]);
  }
  return null;
}

/** The deploy id the CLI prints as soon as the org accepts the request. */
function deployIdFrom(lines) {
  for (const l of lines) {
    const m = /\b(0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)\b/.exec(l);
    if (m && /\bid\b/i.test(l)) return m[1];
  }
  return null;
}

/** The CLI's own error text from its output: the "Error" block, else the last lines. */
function errorFrom(lines) {
  const at = lines.findIndex(l => /^\s*(Error|ERROR)\b/.test(l));
  const pick = at !== -1 ? lines.slice(at, at + 6) : lines.filter(l => l.trim()).slice(-3);
  return pick.map(l => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 600);
}

/**
 * A retrieve, with the CLI's progress streamed. The current CLI has no
 * report command for retrieves, so the result is read from its own summary:
 * rows of the file table, and any row saying a component was not found.
 */
async function retrieve(sfPath, o) {
  const s = await stream(sfPath, retrieveArgs(o), o);
  if (o.token && o.token.isCancellationRequested) return null;
  if (s.code !== 0) throw new Error(errorFrom(s.lines) || 'Retrieve failed.');
  return Object.assign(parseRetrieveText(s.lines), { orgWaitMs: orgWaitFrom(s.lines) });
}

function parseRetrieveText(lines) {
  const row = l => l.replace(/[\u2502\u2503|]/g, ' ').replace(/\s+/g, ' ').trim();
  let files = 0;
  const warnings = [];
  const seen = new Set();
  const rows = new Set();
  for (const raw of lines) {
    const l = row(raw);
    if (/\b(Created|Changed|Unchanged|Deleted)\b/.test(l) && /[\\\/]\S+\.\w+/.test(l) && !rows.has(l)) { rows.add(l); files++; }
    if (/cannot be found|could not be retrieved|not available|no such|not found in/i.test(l) && !seen.has(l)) {
      seen.add(l);
      warnings.push({ fileName: '', problem: l });
    }
  }
  return { files, warnings };
}

/**
 * A check-only validation with the CLI's progress streamed. The structured
 * result - component failures, tests, coverage - is then fetched for the
 * deploy id the CLI printed, with `deploy report`, which only reads.
 */
async function validate(sfPath, o) {
  const s = await stream(sfPath, validateArgs(o), o);
  if (o.token && o.token.isCancellationRequested) return null;
  const id = deployIdFrom(s.lines);
  if (id) {
    if (o.onLine) o.onLine('(fetching the detailed result for ' + id + ')');
    const rep = await run(sfPath, ['project', 'deploy', 'report', '--job-id', id, '--target-org', o.org], { cwd: o.cwd });
    if (rep.json) {
      const r = parseDeploy(rep.json);
      if (!r.id) r.id = id;
      return r;
    }
  }
  // no deploy happened, or no detail could be fetched: the CLI's words are the result
  return {
    id, status: null, success: s.code === 0,
    componentFailures: [], testFailures: [], coverageWarnings: [],
    message: s.code === 0 ? '' : errorFrom(s.lines), errorName: '', actions: []
  };
}

/** The command as you would type it, for the log. */
function display(sfPath, args) {
  return [sfPath || 'sf'].concat(args).map(a => /[\s"&|<>^%]/.test(a) ? '"' + a + '"' : a).join(' ');
}

/* ------------------------------------------------------- Salesforce REST */

/** Runs a command and returns its raw output, without --json. */
function runRaw(sfPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const spec = commandFor(sfPath || 'sf', args);
    let child;
    try {
      child = spawn(spec.command, spec.args, { cwd, shell: false, windowsHide: true, windowsVerbatimArguments: spec.verbatim,
        env: Object.assign({}, process.env, { SF_DISABLE_COLORS: 'true', FORCE_COLOR: '0', SF_AUTOUPDATE_DISABLE: 'true' }) });
    } catch (e) { reject(e); return; }
    const out = [], err = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => reject(e));
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

/**
 * GET a Salesforce REST path from an org the CLI is logged in to. Uses
 * `sf api request rest`, so the CLI handles the login, token refresh and any
 * proxy; with a CLI that has no such command, it falls back to a direct request
 * with the CLI's current token, which is kept in memory only.
 */
// whether this CLI has "sf api request rest" (null until known), and one login per org for direct requests
let apiCommand = null;
const logins = new Map();

/** True when the CLI's output says the command does not exist - its messages wrap lines with "»". */
function isMissingCommand(text) {
  const flat = String(text).replace(ANSI, '').replace(/\u00bb/g, ' ').replace(/\s+/g, ' ');
  return /is not a sf command|not a sf command|command .*not found|Unknown command/i.test(flat);
}

async function restGet(sfPath, org, restPath, cwd) {
  if (apiCommand !== false) {
    const viaCli = await runRaw(sfPath, ['api', 'request', 'rest', restPath, '--target-org', org], cwd);
    if (viaCli.code === 0) { apiCommand = true; return viaCli.stdout; }
    if (!isMissingCommand(viaCli.stderr + ' ' + viaCli.stdout.toString('utf8'))) {
      throw new Error(cleanError(viaCli.stderr) || 'The request to ' + org + ' failed.');
    }
    apiCommand = false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let login = logins.get(org);
    if (!login) {
      const shown = await run(sfPath, ['org', 'display', '--target-org', org], { cwd });
      const r = shown.json && shown.json.result;
      if (!r || !r.accessToken || !r.instanceUrl) throw new Error((shown.json && shown.json.message) || 'Could not read the login for ' + org + ' from the Salesforce CLI.');
      login = { token: r.accessToken, url: r.instanceUrl.replace(/\/+$/, '') };
      logins.set(org, login);
    }
    try { return await httpGet(login.url + restPath, login.token); } catch (e) {
      // an expired session: ask the CLI again (it refreshes the login), once
      if (/^HTTP 401/.test(e.message) && attempt === 0) { logins.delete(org); continue; }
      throw e;
    }
  }
}

/** Opens a path of an org in the browser, through the CLI's login. */
async function openPath(sfPath, org, p, cwd) {
  const r = await runRaw(sfPath, ['org', 'open', '--target-org', org, '--path', p], cwd);
  if (r.code !== 0) throw new Error(cleanError(r.stderr) || 'Could not open ' + org + '.');
}

/** Forget what was learned about the CLI and logins (tests, or after changing orgs). */
function resetRest() { apiCommand = null; logins.clear(); }

/** The CLI's session for an org, cached; fresh = ask the CLI again (it refreshes the login). */
async function loginFor(sfPath, org, cwd, fresh) {
  if (fresh) logins.delete(org);
  let login = logins.get(org);
  if (!login) {
    const shown = await run(sfPath, ['org', 'display', '--target-org', org], { cwd });
    const r = shown.json && shown.json.result;
    if (!r || !r.accessToken || !r.instanceUrl) throw new Error((shown.json && shown.json.message) || 'Could not read the login for ' + org + ' from the Salesforce CLI.');
    login = { token: r.accessToken, url: r.instanceUrl.replace(/\/+$/, '') };
    logins.set(org, login);
  }
  return login;
}

/**
 * PATCH a record through the REST API with the CLI's session. Bodies can be
 * hundreds of kilobytes - too long for a command line - so this always goes direct.
 */
async function restPatch(sfPath, org, restPath, fields, cwd) {
  const body = Buffer.from(JSON.stringify(fields), 'utf8');
  for (let attempt = 0; attempt < 2; attempt++) {
    const login = await loginFor(sfPath, org, cwd, attempt > 0);
    try { return await httpSend('PATCH', login.url + restPath, login.token, body); } catch (e) {
      if (/^HTTP 401/.test(e.message) && attempt === 0) continue;
      throw e;
    }
  }
}

function httpSend(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? require('http') : require('https');
    const req = lib.request(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + text.slice(0, 300)));
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('the request timed out')));
    req.end(body);
  });
}

function httpGet(url, token, redirects) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? require('http') : require('https');
    const req = lib.get(url, { headers: { Authorization: 'Bearer ' + token, Accept: '*/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 3) {
        res.resume(); resolve(httpGet(new URL(res.headers.location, url).toString(), token, (redirects || 0) + 1)); return;
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + body.toString('utf8').slice(0, 300)));
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('the request timed out')));
  });
}

function cleanError(text) {
  return String(text).replace(ANSI, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !NOISE.test(l)).slice(0, 3).join(' ');
}

/** Records for a SOQL query. Read-only. Errors keep Salesforce's own message, e.g. "No such column". */
async function query(sfPath, org, soql, cwd) {
  const r = await run(sfPath, ['data', 'query', '--query', soql, '--target-org', org], { cwd });
  if (r.json && r.json.status === 0) return (r.json.result && r.json.result.records) || [];
  const e = new Error((r.json && r.json.message) || cleanError(r.stderr) || 'The query failed.');
  e.name = (r.json && r.json.name) || 'QueryError';
  throw e;
}

/** The fields of an object, or null when the org has no such object. */
async function describe(sfPath, org, sobject, cwd) {
  const r = await run(sfPath, ['sobject', 'describe', '--sobject', sobject, '--target-org', org], { cwd });
  if (r.json && r.json.status === 0) return (r.json.result.fields || []).map(f => Object.assign({ name: f.name, relationshipName: f.relationshipName || null },
    Array.isArray(f.picklistValues) && f.picklistValues.length ? { picklist: f.picklistValues.filter(v => v.active !== false).map(v => v.value) } : {}));
  const msg = (r.json && r.json.message) || cleanError(r.stderr) || '';
  if (/NOT_FOUND|INVALID_TYPE|not supported|does not exist/i.test(msg + ' ' + ((r.json && r.json.name) || ''))) return null;
  throw new Error(msg || 'Could not describe ' + sobject + '.');
}

/** The committed XML of a Copado selective commit - a Salesforce File (ContentVersion). */
function selectiveFileGet(sfPath, org, fileId, apiVersion, cwd) {
  if (!/^068[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(String(fileId))) return Promise.reject(new Error('"' + fileId + '" is not a Salesforce File version id'));
  return restGet(sfPath, org, '/services/data/v' + (apiVersion || '62.0') + '/sobjects/ContentVersion/' + fileId + '/VersionData', cwd);
}

/**
 * Normalises a deploy/validate result. The shape differs between CLI
 * versions and between success and failure (result vs data), so this looks
 * for the Metadata API fields wherever they are rather than at one path.
 */
function parseDeploy(json) {
  const failures = [];
  const tests = [];
  const coverage = [];
  let id = null;
  let status = null;
  let success = null;

  walk(json, (v, key) => {
    if (!v || typeof v !== 'object') return;
    if (!id && typeof v.id === 'string' && /^0Af/.test(v.id)) id = v.id;
    if (status === null && typeof v.status === 'string' && /Succeeded|Failed|Canceled|SucceededPartial/.test(v.status)) status = v.status;
    if (success === null && typeof v.success === 'boolean' && ('numberComponentErrors' in v || 'checkOnly' in v)) success = v.success;
    if (key === 'componentFailures') for (const f of arr(v)) failures.push(component(f));
    if (key === 'failures' && arr(v).some(t => t && ('methodName' in t || 'stackTrace' in t))) {
      for (const t of arr(v)) tests.push({
        className: t.name || '', method: t.methodName || '', message: t.message || '', stack: t.stackTrace || ''
      });
    }
    if (key === 'codeCoverageWarnings') for (const c of arr(v)) coverage.push({ name: c.name || '', message: c.message || '' });
  });

  const dedup = new Map();
  for (const f of failures) dedup.set([f.type, f.fullName, f.problem, f.line].join('|'), f);
  const componentFailures = Array.from(dedup.values()).filter(f => f.problem);

  if (success === null) success = componentFailures.length === 0 && tests.length === 0 && (json.status === 0);
  if (json && json.status !== 0 && json.status !== undefined) success = false;
  return {
    id, status, success,
    componentFailures, testFailures: tests, coverageWarnings: coverage,
    message: json && json.message ? String(json.message) : '',
    errorName: json && json.name ? String(json.name) : '',
    actions: json && Array.isArray(json.actions) ? json.actions.map(String) : []
  };
}

function component(f) {
  return {
    type: f.componentType || f.type || '',
    fullName: decodeSafe(f.fullName || ''),
    fileName: f.fileName || '',
    problem: f.problem || f.error || '',
    problemType: f.problemType || 'Error',
    line: toInt(f.lineNumber),
    column: toInt(f.columnNumber)
  };
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function arr(v) { return Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []); }

function walk(v, fn, key, depth) {
  depth = depth || 0;
  if (depth > 12 || v === null || v === undefined) return;
  fn(v, key);
  // array items are not re-reported under the array's key
  if (Array.isArray(v)) { for (const x of v) walk(x, fn, undefined, depth + 1); return; }
  if (typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], fn, k, depth + 1);
}

module.exports = {
  version, listOrgs, retrieve, validate, restGet, selectiveFileGet, query, describe, resetRest, isMissingCommand, openPath, restPatch, loginFor, httpGet, display, commandFor, escapeArgument,
  parseJson, parseOrgs, parseDeploy, parseRetrieveText, lineCleaner, reprintFilter, shapeOf, signature, durationMs, orgWaitFrom, deployIdFrom, errorFrom, retrieveArgs, validateArgs
};
