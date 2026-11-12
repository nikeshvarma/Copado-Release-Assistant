'use strict';

// Runs one merge job off the extension host. The result is plain data;
// structured cloning keeps the links between marks and report entries.
const { parentPort, workerData } = require('worker_threads');
const { runMergeJob } = require('./mergeJob');

try {
  parentPort.postMessage(runMergeJob(workerData));
} catch (e) {
  parentPort.postMessage({ ok: false, error: 'The merge failed: ' + (e && e.message ? e.message : String(e)) });
}
