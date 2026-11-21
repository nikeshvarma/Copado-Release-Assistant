'use strict';

/**
 * Files whose entries add up - permission sets, profiles, muting permission sets, labels, translations: a file is
 * often retrieved in part, so an entry it lacks is not a removal. For a promotion they are the target with the
 * feature added (src/unionMerge); for a merge of two branches' files (Branch conflicts) the start is the merged
 * result for them, the feature branch's file for everything else - whose removals count.
 *
 * Whatever the start, the merge editor marks what the other side has.
 */
const ADDITIVE = new Set(['Profile', 'PermissionSet', 'MutingPermissionSet', 'CustomLabels', 'Translations', 'CustomObjectTranslation', 'GlobalValueSetTranslation', 'StandardValueSetTranslation']);
const KINDS = ['merged', 'feature', 'target'];

function startFor(typeName, setting) {
  if (KINDS.includes(setting)) return setting;
  return ADDITIVE.has(typeName) ? 'merged' : 'feature';
}

module.exports = { startFor, ADDITIVE, KINDS };
