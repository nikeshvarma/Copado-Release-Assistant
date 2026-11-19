'use strict';

/**
 * Two branches compared, file by file - what the Compare tab lists:
 *
 *   groupOf(path)                  a file's metadata type and name, from its Salesforce DX folder
 *   inProject(path, dirs)          whether it is metadata of the project (its package directories)
 *   summarize(path, to, from)      what differs, in a few words: "4 elements differ \u00b7 1 duplicate"
 */
// folder -> what a person calls it
const TYPES = {
  classes: 'Apex classes', triggers: 'Apex triggers', lwc: 'Lightning web components', aura: 'Aura components', pages: 'Visualforce pages',
  components: 'Visualforce components', permissionsets: 'Permission sets', permissionsetgroups: 'Permission set groups', profiles: 'Profiles',
  flexipages: 'Lightning pages', layouts: 'Layouts', flows: 'Flows', objects: 'Objects', objectTranslations: 'Object translations',
  labels: 'Custom labels', customMetadata: 'Custom metadata records', globalValueSets: 'Global value sets', standardValueSets: 'Standard value sets',
  applications: 'Apps', tabs: 'Tabs', quickActions: 'Quick actions', staticresources: 'Static resources', email: 'Email templates',
  reports: 'Reports', dashboards: 'Dashboards', workflows: 'Workflows', approvalProcesses: 'Approval processes', sharingRules: 'Sharing rules',
  customPermissions: 'Custom permissions', namedCredentials: 'Named credentials', translations: 'Translations', genAiPlugins: 'Agentforce topics',
  genAiPlannerBundles: 'Agentforce planners', bots: 'Bots'
};
// inside an object's folder
const OBJECT_PARTS = { fields: 'Custom fields', recordTypes: 'Record types', listViews: 'List views', validationRules: 'Validation rules',
  fieldSets: 'Field sets', compactLayouts: 'Compact layouts', webLinks: 'Buttons and links', businessProcesses: 'Business processes' };

function groupOf(p) {
  const parts = String(p).split('/');
  const i = parts.lastIndexOf('default') >= 0 ? parts.lastIndexOf('default') + 1 : Math.max(0, parts.length - 2);
  const folder = parts[i] || '';
  const base = parts[parts.length - 1].replace(/-meta\.xml$/, '').replace(/\.(cls|trigger|js|html|css|page|component|cmp)$/, m => m);
  const name = base.replace(/\.[a-zA-Z]+$/, '');
  if (folder === 'objects' && parts.length - i >= 4 && OBJECT_PARTS[parts[i + 2]]) return { type: OBJECT_PARTS[parts[i + 2]], name: parts[i + 1] + '.' + name };
  if (folder === 'objects') return { type: 'Objects', name: parts[i + 1] || name };
  if (folder === 'lwc' || folder === 'aura') return { type: TYPES[folder], name: (parts[i + 1] || name) + (parts.length - i > 2 ? ' \u00b7 ' + parts[parts.length - 1] : '') };
  // inside a folder of its type: the path below it says which one - not five rows all called "schema"
  const below = parts.slice(i + 1, -1).join('/');
  return { type: TYPES[folder] || (folder ? folder[0].toUpperCase() + folder.slice(1) : 'Other files'), name: (below ? below + '/' : '') + (/\.(cls|trigger)$/.test(base) ? base : name) };
}

/** Metadata of the project: under one of its package directories (force-app by default). */
function inProject(p, dirs) {
  const list = (dirs && dirs.length ? dirs : ['force-app']).map(d => String(d).replace(/^\.?\/+|\/+$/g, '') + '/');
  return list.some(d => String(p).startsWith(d));
}

const languageOf = p => /\.(cls|trigger)$/.test(p) ? 'apex' : /\.js$/.test(p) ? 'javascript' : /\.css$/.test(p) ? 'css' : /\.(html|page|component|cmp|app|evt|intf|design|auradoc)$/.test(p) ? 'html' : null;

function summarize(p, toText, fromText) {
  if (toText == null) return 'only in the From branch';
  if (fromText == null) return 'only in the To branch';
  const lang = languageOf(p);
  try {
    if (lang) {
      // code: its members, if they can be read; otherwise its lines
      const n = lang === 'apex' || lang === 'javascript' ? require('./codeMerge').memberDiffs(toText, fromText, lang) : null;
      const lines = n == null ? require('./mergeAlign').lineDiff(String(toText).split(/(?<=\n)/), String(fromText).split(/(?<=\n)/), 0).filter(p => p.kind !== 'same' && p.kind !== 'blank').length : n;
      const what = n == null ? ' place' : ' member';
      return lines ? lines + what + (lines === 1 ? '' : 's') + ' differ' + (lines === 1 ? 's' : '') : 'only spacing differs';
    }
    // the file's metadata type - its root element - so each element is matched by what identifies it
    const type = (/<([A-Za-z][\w]*)[\s>]/.exec(String(fromText).replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '')) || [])[1] || null;
    const r = require('./mergeAlign').align(toText, fromText, fromText, { type });
    const n = r.pieces.filter(x => x.kind !== 'same' && x.kind !== 'blank').length;
    const dups = require('./mergeDuplicates').inText(fromText).length;
    return (n ? n + ' element' + (n === 1 ? '' : 's') + ' differ' + (n === 1 ? 's' : '') : 'only spacing or order differs') + (dups ? ' \u00b7 ' + dups + ' duplicate' + (dups === 1 ? '' : 's') : '');
  } catch (e) { return 'differs'; }
}

/** A summary that says the two are alike as Salesforce reads them: only spacing, or order where it does not count. */
const same = summary => /^only spacing( or order)? differs$/.test(String(summary || ''));

module.exports = { groupOf, inProject, summarize, languageOf, same };
