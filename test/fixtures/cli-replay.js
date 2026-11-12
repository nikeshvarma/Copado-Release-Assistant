// A replay of the CLI output from a real retrieve and validation on Windows, frame by frame:
// the CLI reprints its whole block on every tick, animates a spinner on the active stage and
// in the status value, and prints a one-off line before the validation frames start.
function retrieveFrames() {
  const out = [];
  const head = ' \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Retrieving Metadata \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
  const intro = [' Retrieving v67.0 metadata from me@example.com.dev using the', ' v68.0 SOAP API', ''];
  const f = (body, status, el, withIntro) => out.push(head, '', ...(withIntro ? intro : []), ...body, '', ' Status: ' + status, ' Elapsed Time: ' + el, '');
  f([' \u25a0Preparing retrieve request', ' \u25a0Sending request to org', ' \u25a0Waiting for the org to respond', ' \u25a0Done'], '-', '0ms', false);
  const spins = ['-', '\\', '|', '/'];
  [7, 121, 276, 415].forEach((t, i) => f([' \u221aPreparing retrieve request 8ms', '|/-\\'[i] + 'Sending request to org ' + t + 'ms', ' \u25a0Waiting for the org to respond', ' \u25a0Done'], spins[i], (26 + i * 120) + 'ms', true));
  for (let t = 7; t < 365; t += 40) f([' \u221aPreparing retrieve request 8ms', ' \u221aSending request to org 439ms', '|/-\\'[t % 4] + 'Waiting for the org to respond ' + t + 'ms', ' \u25a0Done'], 'Pending', (480 + t) + 'ms', true);
  for (let t = 365; t < 5980; t += 300) f([' \u221aPreparing retrieve request 8ms', ' \u221aSending request to org 439ms', '|/-\\'[t % 4] + 'Waiting for the org to respond ' + (t / 1000).toFixed(2) + 's', ' \u25a0Done'], 'In Progress', ((t + 470) / 1000).toFixed(2) + 's', true);
  f([' \u221aPreparing retrieve request 8ms', ' \u221aSending request to org 439ms', ' \u221aWaiting for the org to respond 5.98s', '|Done 0ms'], 'Succeeded', '6.44s', true);
  f([' \u221aPreparing retrieve request 8ms', ' \u221aSending request to org 439ms', ' \u221aWaiting for the org to respond 5.99s', ' \u221aDone 0ms'], 'Succeeded', '6.44s', true);
  out.push('Retrieved Source',
    '\u2502 State   \u2502 Name             \u2502 Type          \u2502 Path \u2502',
    '\u2502 Changed \u2502 ACME_Controller  \u2502 ApexClass     \u2502 force-app\\main\\default\\classes\\ACME_Controller.cls \u2502',
    '\u2502 Changed \u2502 ACME_Billing_PS  \u2502 PermissionSet \u2502 force-app\\main\\default\\permissionsets\\ACME_Billing_PS.permissionset-meta.xml \u2502',
    '\u2502 Created \u2502 Invoice          \u2502 CustomObject  \u2502 force-app\\main\\default\\objects\\Invoice\\Invoice.object-meta.xml \u2502');
  return out;
}
function validateFrames() {
  const out = ['Validating Deployment of v67.0 metadata to me@example.com using the v67.0 SOAP API.', ''];
  const head = ' \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Validating Deployment \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
  const tail = [' \u25a0Running Tests', ' \u25a0Updating Source Tracking', ' \u25a0Done'];
  const ids = [' Deploy ID: 0Af000000000005AAA', ' Target Org: me@example.com'];
  const f = (stages, status, el, withIds) => out.push(head, '', ...stages, '', ' Status: ' + status, ...(withIds ? ids : []), ' Elapsed Time: ' + el, '');
  f([' \u25a0Preparing', ' \u25a0Waiting for the org to respond', ' \u25a0Deploying Metadata', ...tail], '-', '0ms', false);
  f(['|Preparing 18ms', ' \u25a0Waiting for the org to respond', ' \u25a0Deploying Metadata', ...tail], '-', '15ms', true);
  f(['/Preparing 50ms', ' \u25a0Waiting for the org to respond', ' \u25a0Deploying Metadata', ...tail], '-', '63ms', true);
  for (let t = 13; t < 9550; t += 40) f([' \u221aPreparing 68ms', '|/-\\'[t % 4] + 'Waiting for the org to respond ' + (t < 1000 ? t + 'ms' : (t / 1000).toFixed(2) + 's'), ' \u25a0Deploying Metadata', ...tail], 'Pending', ((t + 96) / 1000).toFixed(2) + 's', true);
  for (let t = 6; t < 2100; t += 40) f([' \u221aPreparing 68ms', ' \u221aWaiting for the org to respond 9.55s', '|/-\\'[t % 4] + 'Deploying Metadata ' + (t < 1000 ? t + 'ms' : (t / 1000).toFixed(2) + 's'), '   \u25b8 Components: ' + (t < 1050 ? '6/15 (40%)' : '10/15 (67%)'), ...tail], 'In Progress', ((t + 9640) / 1000).toFixed(2) + 's', true);
  f([' \u221aPreparing 68ms', ' \u221aWaiting for the org to respond 9.55s', ' \u00d7 Deploying Metadata 2.12s', '   \u25b8 Components: 6/12 (50%)', ...tail], 'Failed', '11.76s', true);
  out.push('Component Failures [2]',
    '\u2502 Layout        \u2502 Invoice-ACME Layout 02 \u2502 In field: field - no CustomField named Invoice.ACME_Field_033__c found (18:26) \u2502 18:26 \u2502',
    '\u2502 PermissionSet \u2502 ACME_Billing_PS             \u2502 In field: object - no CustomObject named AssetContractRelationship found     \u2502       \u2502',
    '', 'Test Results Summary', 'Passing: 0', 'Failing: 0', 'Total: 0',
    'Error (FailedValidationError): Failed to validate the deployment (0Af000000000005AAA). Due To:', '', '2 component error(s)');
  return out;
}
module.exports = { retrieveFrames, validateFrames };
