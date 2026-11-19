'use strict';

/**
 * Where your resolution starts in the merge editor - nothing is merged
 * behind your back. cmr.merge.startFrom:
 *
 *   auto     (the default) the merged result for metadata Salesforce writes
 *            as sorted entries, where a file is often retrieved in part and
 *            an entry it lacks is not a removal - permission sets, profiles,
 *            labels, translations, objects; the feature branch's file for
 *            everything else (pages, layouts, flows...), whose removals count
 *   merged   both branches combined: nothing of the target is dropped
 *   feature  the feature branch's file as it is
 *   target   the target branch's file as it is
 *
 * Whatever the start, the merge editor marks what the other side has.
 */
const ADDITIVE = new Set(['Profile', 'PermissionSet', 'MutingPermissionSet', 'CustomLabels', 'Translations', 'CustomObjectTranslation']);
const KINDS = ['merged', 'feature', 'target'];

function startFor(typeName, setting) {
  if (KINDS.includes(setting)) return setting;
  return ADDITIVE.has(typeName) ? 'merged' : 'feature';
}

module.exports = { startFor, ADDITIVE, KINDS };
