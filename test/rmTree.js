'use strict';
/**
 * Removes a test's temporary folder. On Windows a folder cannot be removed while another process still has
 * a file in it open - Windows Defender scanning a file just written, the search indexer - so it is retried
 * for a few seconds, and a folder that still will not go is left behind with a note: the temp folder is
 * tidied by the system, and a test whose checks passed does not fail on its clean-up.
 */
const fs = require('fs');

module.exports = function rmTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.log('      (left behind: ' + dir + ' - ' + e.code + ')'); }
};
