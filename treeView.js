'use strict';

const vscode = require('vscode');
const path = require('path');

const MAX_PER_SECTION = 400;

/**
 * The merge panel. For a profile with a thousand conflicting values the
 * CodeLens-per-line approach falls apart, so this is the surface that scales:
 * everything grouped by section, counts up front, one click to jump or flip.
 */
function createProvider(getSession) {
  const emitter = new vscode.EventEmitter();

  const provider = {
    onDidChangeTreeData: emitter.event,
    refresh: () => emitter.fire(),
    getTreeItem: item => item,
    getChildren(parent) {
      const session = getSession();
      if (!session) return [];
      if (!parent) return roots(session);
      if (parent.kind === 'group') return groupChildren(session, parent);
      if (parent.kind === 'section') return sectionChildren(session, parent);
      return [];
    }
  };
  return provider;
}

function node(label, kind, extra) {
  const item = new vscode.TreeItem(label,
    extra && extra.collapsed === false
      ? vscode.TreeItemCollapsibleState.Expanded
      : (extra && extra.leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed));
  item.kind = kind;
  return Object.assign(item, extra || {});
}

function roots(session) {
  const r = session.report;
  const unreviewed = session.conflicts.filter(c => !c.reviewed).length;
  const out = [];

  const L = session.labels || {};
  const header = node(L.target || path.basename(session.targetUri.fsPath), 'header', { leaf: true });
  header.description = '\u2190 ' + (L.incoming || path.basename(session.incomingUri.fsPath)) +
    '  \u00b7 ' + (session.threeWay ? '3-way' : '2-way');
  header.tooltip = new vscode.MarkdownString(
    '**Target** (keeps everything): `' + (L.target || session.targetUri.fsPath) + '`\n\n' +
    '**Incoming** (wins a real conflict): `' + (L.incoming || session.incomingUri.fsPath) + '`' +
    (session.ancestorUri ? '\n\n**Ancestor**: `' + (L.ancestor || session.ancestorUri.fsPath) + '`' : '\n\nNo ancestor - two-way merge.') +
    (session.applyToUri ? '\n\nApplies to `' + session.applyToUri.fsPath + '`' : ''));
  header.iconPath = new vscode.ThemeIcon('git-merge');
  header.contextValue = 'cmrHeader';
  header.command = { command: 'cmr.showTargetVsMerged', title: 'Open the merged diff' };
  out.push(header);

  out.push(group('Conflicts', 'conflicts', session.conflicts.length, 'git-pull-request', {
    description: unreviewed ? unreviewed + ' to review' : (session.conflicts.length ? 'all reviewed' : 'none'),
    contextValue: session.conflicts.length ? 'cmrConflictRoot' : 'cmrEmpty'
  }));
  // your resolution against the target, as you edit it - otherwise what the merge added
  const live = session.live && !session.live.tooMany ? session.live : null;
  if (live) {
    const n = kinds => live.list.filter(c => kinds.includes(c.kind)).length;
    out.push(group('Removed by you', 'live-removed', n(['removed']), 'discard'));
    out.push(group('Left out from ' + (session.theirs || 'the incoming file'), 'live-dropped', n(['dropped']), 'discard'));
    out.push(group('From ' + (session.theirs || 'the incoming file'), 'live-feature', n(['feature', 'changed-feature']), 'diff-added'));
    out.push(group('Your own edits', 'live-own', n(['own', 'changed-own']), 'edit'));
  } else out.push(group('Added from incoming', 'added', r.added.length, 'diff-added'));
  if (session.threeWay) {
    out.push(group('Auto-resolved', 'auto', r.auto.length, 'wand', {
      description: r.auto.length ? 'only one side changed' : undefined
    }));
    out.push(group('Deleted in incoming, kept', 'deletions', r.deletions.length, 'diff-removed'));
    if (r.skipped.length) out.push(group('Deleted in target, not restored', 'skipped', r.skipped.length, 'circle-slash'));
  }
  out.push(group('Duplicates removed', 'duplicates', r.duplicates.length, 'trash', {
    description: r.duplicates.filter(d => !d.identical).length
      ? r.duplicates.filter(d => !d.identical).length + ' need a look'
      : undefined
  }));
  out.push(group('Deploy checks', 'checks', (session.checks || []).length, 'law', {
    description: (session.checks || []).some(c => c.severity === 'error') ? 'would fail' : undefined,
    iconOverride: (session.checks || []).length
      ? new vscode.ThemeIcon((session.checks || []).some(c => c.severity === 'error') ? 'error' : 'warning')
      : new vscode.ThemeIcon('pass')
  }));
  if (r.policy && r.policy.length) {
    out.push(group('Kept by policy', 'policy', r.policy.length, 'lock'));
  }
  return out;
}

function group(label, id, count, icon, extra) {
  const item = node(label, 'group', Object.assign({ leaf: count === 0, group: id }, extra || {}));
  item.description = [count, extra && extra.description].filter(v => v !== undefined && v !== null).join(' \u00b7 ');
  item.iconPath = (extra && extra.iconOverride) || new vscode.ThemeIcon(icon);
  if (!item.contextValue) item.contextValue = 'cmrGroup';
  return item;
}

function groupChildren(session, parent) {
  if (/^live-/.test(parent.group) && session.live) {
    const kinds = { 'live-removed': ['removed'], 'live-dropped': ['dropped'], 'live-feature': ['feature', 'changed-feature'], 'live-own': ['own', 'changed-own'] }[parent.group];
    return session.live.list.filter(c => kinds.includes(c.kind)).slice(0, MAX_PER_SECTION).map(c => {
      const text = ((c.kind === 'removed' || c.kind === 'dropped' ? c.removed : c.added).find(l => l.trim()) || '').trim();
      const name = c.label || text;
      const item = node(name.length > 60 ? name.slice(0, 57) + '\u2026' : name, 'live', { leaf: true });
      item.description = 'line ' + (c.bStart + 1) + (c.kind === 'removed' ? ' \u00b7 from the target' : /^changed/.test(c.kind) ? ' \u00b7 changed' : '');
      item.iconPath = new vscode.ThemeIcon({ removed: 'discard', dropped: 'discard', feature: 'diff-added', 'changed-feature': 'diff-modified', own: 'edit', 'changed-own': 'edit' }[c.kind]);
      item.command = { command: 'cmr.mergeReveal', title: 'Go to it', arguments: [c.bStart] };
      // its action as a button on the item: Restore, Add it back, Undo or Use target
      item.contextValue = c.undo ? 'cmrLiveChange' : 'cmrLiveChangeNoAction';
      item.change = c;
      item.tooltip = { removed: 'Restore', dropped: 'Add it back', feature: 'Undo', own: 'Undo', 'changed-feature': 'Use target', 'changed-own': 'Use target' }[c.kind] + ' - the button on the right';
      return item;
    });
  }
  if (parent.group === 'conflicts') return sections(session.conflicts.map((c, i) => ({ c, i })), e => sectionOf(e.c.path, e.c.tag), 'conflicts');
  if (parent.group === 'added') return sections(session.report.added.map((a, i) => ({ a, i })), e => sectionOf(e.a.path), 'added');
  if (parent.group === 'duplicates') return session.report.duplicates.map(duplicateItem);
  if (parent.group === 'auto') return session.report.auto.slice(0, MAX_PER_SECTION).map(autoItem);
  if (parent.group === 'deletions') return session.report.deletions.map(e => deletionItem(e, session));
  if (parent.group === 'skipped') return session.report.skipped.map(skippedItem);
  if (parent.group === 'checks') return (session.checks || []).map(checkItem);
  if (parent.group === 'policy') return session.report.policy.map(policyItem);
  return [];
}

function sectionOf(p, fallback) {
  const first = String(p || '').split(' > ')[0] || fallback || 'other';
  return first.replace(/\s*\[.*$/, '');
}

/** Groups entries by metadata section so a big profile stays navigable. */
function sections(entries, keyOf, group) {
  const map = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  const out = [];
  for (const [key, list] of map) {
    const item = node(key, 'section', { group, entries: list });
    item.description = String(list.length);
    item.iconPath = new vscode.ThemeIcon('symbol-field');
    item.contextValue = group === 'conflicts' ? 'cmrConflictSection' : 'cmrSection';
    item.sectionKey = key;
    out.push(item);
  }
  out.sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label));
  return out;
}

function sectionChildren(session, parent) {
  const list = parent.entries.slice(0, MAX_PER_SECTION);
  const items = parent.group === 'conflicts'
    ? list.map(e => conflictItem(e.c, e.i, session))
    : list.map(e => addedItem(e.a, session));
  if (parent.entries.length > list.length) {
    const more = node((parent.entries.length - list.length) + ' more not shown', 'more', { leaf: true });
    more.description = 'see the output panel';
    more.iconPath = new vscode.ThemeIcon('ellipsis');
    more.command = { command: 'cmr.showReport', title: 'Show the full report' };
    items.push(more);
  }
  return items;
}

function conflictItem(c, index, session) {
  const usingTarget = c.resolved === 'base';
  const item = node(c.tag, 'conflict', { leaf: true });
  item.description = (c.label ? c.label + '  ' : '') +
    'target "' + shorten(c.base) + '" / incoming "' + shorten(c.incoming) + '"  \u2192 ' + (usingTarget ? 'target' : 'incoming');
  item.tooltip = new vscode.MarkdownString(
    '`' + c.path + '`\n\n- target: `' + c.base + '`\n- incoming: `' + c.incoming + '`\n\n' +
    'Using the **' + (usingTarget ? 'target' : 'incoming') + '** value.' +
    (c.multiline ? '\n\nMulti-line value - edit it in the merged file.' : ''));
  item.iconPath = new vscode.ThemeIcon(c.reviewed ? 'pass-filled' : 'circle-outline');
  item.contextValue = usingTarget ? 'cmrConflictUsingTarget' : 'cmrConflictUsingIncoming';
  item.conflictIndex = index;
  item.command = { command: 'cmr.revealConflict', title: 'Go to it', arguments: [index] };
  return item;
}

function addedItem(entry, session) {
  const item = node(entry.label || entry.path, 'added', { leaf: true });
  item.description = entry.review ? 'appended - review position' : undefined;
  item.tooltip = entry.path + (entry.label ? '\n' + entry.label : '');
  item.iconPath = new vscode.ThemeIcon(entry.review ? 'warning' : 'diff-added');
  item.contextValue = 'cmrAdded';
  const mark = (session.marks || []).find(m => m.mark.kind === 'added' && m.mark.added === entry);
  if (mark) item.command = { command: 'cmr.revealLine', title: 'Go to it', arguments: [mark.startLine] };
  return item;
}

function autoItem(entry) {
  const item = node(entry.path, 'auto', { leaf: true });
  item.description = '"' + shorten(entry.from) + '" \u2192 "' + shorten(entry.to) + '"  (' + entry.side + ' changed it)';
  item.tooltip = 'Only the ' + entry.side + ' side changed this since the ancestor, so it was applied without asking.';
  item.iconPath = new vscode.ThemeIcon(entry.side === 'incoming' ? 'arrow-right' : 'arrow-left');
  item.contextValue = 'cmrAuto';
  return item;
}

function deletionItem(entry, session) {
  const item = node(entry.label || entry.path, 'deletion', { leaf: true });
  item.description = 'kept in the result';
  item.tooltip = entry.path + '\nThe incoming file deleted this. It is kept, because the target never loses anything.\nUse the trash icon to drop it.';
  item.iconPath = new vscode.ThemeIcon('diff-removed');
  item.contextValue = 'cmrDeletion';
  item.entryRef = entry;
  const mark = (session.marks || []).find(m => m.mark.kind === 'deleted' && m.mark.deletion === entry);
  if (mark) {
    item.markRef = mark.mark;
    item.command = { command: 'cmr.revealLine', title: 'Go to it', arguments: [mark.startLine] };
  }
  return item;
}

function skippedItem(entry) {
  const item = node(entry.label || entry.path, 'skipped', { leaf: true });
  item.description = 'not brought back';
  item.tooltip = entry.path + '\nThe target deleted this since the ancestor, so the incoming copy was not resurrected.';
  item.iconPath = new vscode.ThemeIcon('circle-slash');
  item.contextValue = 'cmrSkipped';
  return item;
}

function duplicateItem(entry) {
  const item = node(entry.label || entry.path, 'duplicate', { leaf: true });
  item.description = entry.identical ? 'identical copy' : 'same key, different values';
  item.tooltip = entry.path + '\nRemoved from the ' + entry.side + ' file.';
  item.iconPath = new vscode.ThemeIcon(entry.identical ? 'trash' : 'warning');
  item.contextValue = 'cmrDuplicate';
  return item;
}

function checkItem(entry) {
  const item = node(entry.message, 'check', { leaf: true });
  item.description = entry.id;
  item.tooltip = entry.message;
  item.iconPath = new vscode.ThemeIcon(entry.severity === 'error' ? 'error' : 'warning');
  item.contextValue = 'cmrCheck';
  if (typeof entry.line === 'number') {
    item.command = { command: 'cmr.revealLine', title: 'Go to it', arguments: [entry.line] };
  }
  return item;
}

function policyItem(entry) {
  const item = node(entry.path, 'policy', { leaf: true });
  item.description = 'kept ' + entry.kept + ', ignored ' + entry.ignored;
  item.tooltip = 'Always kept from the target by cmr.merge.alwaysKeepTarget.';
  item.iconPath = new vscode.ThemeIcon('lock');
  item.contextValue = 'cmrPolicy';
  return item;
}

function shorten(v) {
  v = String(v == null ? '' : v);
  return v.length > 24 ? v.slice(0, 21) + '\u2026' : v;
}

module.exports = { createProvider };
