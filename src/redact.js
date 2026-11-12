'use strict';

/**
 * Masks sensitive values in text bound for the output panel or a copied report.
 * Session tokens are always masked; identities (usernames, emails, org and user
 * IDs, My Domain addresses) only when cmr.output.maskIdentities is on.
 */
// a Salesforce session id: an org id, "!", then a long opaque string
const TOKEN = /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-]{20,}/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._!\-]{20,}/gi;
const EMAIL = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+\b/g;
const ORG_OR_USER_ID = /\b(00D|005)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g;
const MY_DOMAIN = /\bhttps?:\/\/[A-Za-z0-9\-]+(?:--[A-Za-z0-9\-]+)?\.(?:sandbox\.)?(?:my|lightning)\.(?:salesforce|force)\.com\b/gi;

function redact(text, maskIdentities) {
  let s = String(text).replace(TOKEN, '[token]').replace(BEARER, '$1[token]');
  if (maskIdentities) {
    s = s.replace(MY_DOMAIN, 'https://[my-domain]')
      .replace(EMAIL, m => '[user@' + m.split('@')[1].split('.').slice(-1)[0] + ']')
      .replace(ORG_OR_USER_ID, (m, p) => p + '[id]');
  }
  return s;
}

module.exports = { redact };
