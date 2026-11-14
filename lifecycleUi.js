'use strict';

/**
 * The Stories view of the Release Assistant page: a story's journey through
 * the pipeline - each stage with the promotion that brought it there, where
 * it is now, and the next stage. Read from Copado on request and kept here
 * for the page; the logic lives in src/lifecycle.js. Read-only: nothing in
 * Copado is changed.
 */
const vscode = require('vscode');
const L = require('./src/lifecycle');

let h;
const changed = new vscode.EventEmitter();
const life = { story: { ref: '', journey: null, error: null } };

function activate(context, helpers) {
  h = helpers;
  context.subscriptions.push(changed);
}

async function api() {
  const c = h.rc();
  if (!c.copadoOrg) throw new Error('Set the Copado org first: Settings \u203a Copado org.');
  h.requireTrust('Reading Copado runs the Salesforce CLI');
  const p = h.deps.resolveProject();
  const root = p.root || p.fallback;
  if (!root) throw new Error('Open your project folder first.');
  return h.copadoApi(c, root, (await h.apiVersion()) || '62.0');
}

async function openStory(ref) {
  const a = await api();
  life.story = { ref, journey: null, error: null };
  try {
    life.story.journey = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking up where ' + ref + ' is' }, () => L.storyJourney(a, ref));
  } catch (e) { life.story.error = e.message; }
}

function snapshot() {
  const j = life.story.journey;
  return {
    story: { ref: life.story.ref, error: life.story.error, journey: j ? { story: j.story, hotfix: j.hotfix, stages: j.stages, next: j.next, backTo: j.backTo, pipeline: j.pipeline ? j.pipeline.name : null,
      promotions: j.promotions.slice(0, 30).map(p => ({ id: p.id, name: p.name, status: p.status, from: p.from, to: p.to, created: p.created, back: p.back })) } : null }
  };
}

async function act(name, p) {
  const x = p || {};
  try {
    switch (name) {
      case 'story.open': await openStory(String(x.ref || '').trim()); break;
      case 'story.validate': if (life.story.journey) await h.validateFromBranch(life.story.journey.story.name); break;
      default: return;
    }
  } finally {
    changed.fire();
  }
}

module.exports = { activate, snapshot, act, onChange: f => changed.event(f) };
