'use strict';

/**
 * A file's shape without its names - for a regression corpus, or a diagnostics bundle someone can share: every line,
 * line ending and indent kept, the conflict markers where they are, XML element names and the language's own words
 * kept; every other name renamed the same way everywhere (Acme_Invoice__c -> X12__c), long numbers - story and
 * ticket numbers - replaced, the branch a marker names replaced.
 *
 *   anonymise(text, shared?) -> { text, names }   names: how many were renamed; shared: the same names across texts
 */

// the language's own words, and Salesforce's - kept, so the code and the metadata read as what they are
const KEEP = new Set((
  'abstract after and any as asc before boolean break by case catch class const continue date datetime decimal default delete desc do double else enum ' +
  'export extends false final finally for from function get global id if implements import in insert instanceof integer interface let limit list long map ' +
  'new not null object of on or order override private protected public return select set sharing static string super switch this throw time trigger true ' +
  'try undefined update upsert var virtual void when where while with without yield async await testmethod istest testvisible auraenabled future invocablemethod ' +
  'system database schema test sobject blob exception debug assert assertequals starttest stoptest runas size add put contains isempty addall remove keyset values ' +
  'template lwc if:true if:false div span p button input label slot class style src href type value name id key for each item index ' +
  'xml xmlns version encoding utf http www w3 org schema soap sforce com metadata true false yes no').split(/\s+/));
const SUFFIX = /(__(c|r|mdt|e|x|b|share|history|feed|chatterfeed))$/i;

function anonymise(input, shared) {
  // several texts of one file - its conflict file, your resolution - renamed alike: a name means the same in each
  const st = shared || { map: new Map(), n: 0 }, map = st.map;
  const rename = w => {
    const k = w.toLowerCase();
    if (!map.has(k)) { const suffix = (SUFFIX.exec(w) || [''])[0]; map.set(k, 'X' + (++st.n) + suffix); }
    return map.get(k);
  };
  // the language's own words kept; every other one renamed, however short - an "S" or a "P" says something too
  const word = w => (KEEP.has(w.toLowerCase()) || /^\d/.test(w) ? w : rename(w));
  // markup - XML, an HTML template - keeps its element names; in code a "<" is a generic's, and what follows a name
  const markup = /^\s*</.test(String(input));
  const lines = String(input).split(/(?<=\n)/);
  const out = lines.map(line => {
    // a conflict marker: where it is, the branch it names replaced
    const m = /^(<{7}|>{7}|={7}|\|{7})( ?)([^\r\n]*)(\r?\n?)$/.exec(line);
    if (m) return m[1] + m[2] + (m[3] && m[3] !== 'HEAD' ? 'origin/feature/anonymised' : m[3]) + m[4];
    return line
      // long numbers - story, ticket, record ids - replaced, their length kept
      .replace(/\b\d{5,}\b/g, d => '9'.repeat(d.length))
      // an XML element's own name kept - <fieldPermissions>, </field> - everything else renamed
      .replace(/(<\/?|\b)([A-Za-z_][A-Za-z0-9_]*(?:__[a-z]+)?)/g, (all, pre, w) => markup && (pre === '<' || pre === '</') ? all : pre + word(w));
  });
  return { text: out.join(''), names: map.size };
}

module.exports = { anonymise };
