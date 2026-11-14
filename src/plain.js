'use strict';

/**
 * What the Salesforce CLI is doing, in plain words, for the progress
 * notification. The CLI's own lines ("⠋ Deploying Metadata Components: 2/40",
 * "Waiting for the org to respond") stay in the Output panel; the notification
 * says what is happening for a person, not a terminal. A line that is not one
 * of the known phases gives null, and the notification keeps saying what it
 * said before. Plain Node.js.
 */
function phase(line) {
  const t = String(line || '');
  let m;
  if ((m = /running\s+tests?\D*(\d+)\s*\/\s*(\d+)/i.exec(t))) return 'Running tests (' + m[1] + ' of ' + m[2] + ')';
  if (/running\s+tests?/i.test(t)) return 'Running tests';
  if ((m = /(?:deploying|validating)\s+metadata\D*(\d+)\s*\/\s*(\d+)/i.exec(t)) || (m = /components:?\s*(\d+)\s*\/\s*(\d+)/i.exec(t))) return 'Checking components (' + m[1] + ' of ' + m[2] + ')';
  if (/(?:deploying|validating)\s+metadata/i.test(t)) return 'Checking components';
  if (/deploying\s+v?\d/i.test(t)) return 'Getting started';   // the CLI's opening line
  if (/retriev/i.test(t)) return 'Getting the files from Salesforce';
  if (/queued|pending|in\s*queue/i.test(t)) return 'Waiting its turn in Salesforce';
  if (/waiting\s+for\s+(?:the\s+)?(?:org|server|salesforce)/i.test(t)) return 'Waiting for Salesforce';
  if (/preparing|deploy\s+id|starting/i.test(t)) return 'Getting started';
  if (/status:\s*\w+|updating\s+source\s+tracking|\bdone\b|succeeded|failed/i.test(t)) return 'Finishing up';
  return null;
}

module.exports = { phase };
