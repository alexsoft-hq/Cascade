// limit_titles.mjs — the words the page puts over a limit the engine wrote (RM67-U2f).
//
// A limit is `{scope, reason}`: which answer or which part of the pack it is
// about, and the engine's own sentence. The rail used to print the scope and
// the first words of that sentence, so a Korean page read "axis:jpa the jpa
// axis of this pack is not-shipped: ...". It now shows a short title in the
// reader's language and folds the sentence under it, word for word.
//
// Which title, most specific first:
//   1. a diagnostic's own title (`diagnostic:<KIND>`);
//   2. an axis that says what it is (`axis:<name>`, "the <name> axis of this
//      pack is <status>"): the same words Start and Analysis status use;
//   3. an overview gap the overview relays ("<kind> (<count>): ..."): its label;
//   4. a TOPIC: the words a sentence of one kind starts with, whichever tool
//      wrote it. A depth cap is a depth cap on a map, in a trace and in a matrix,
//      and a reader wants to know that before the scope;
//   5. an axis note on an axis that shipped;
//   6. the scope's own title, and for a scope that carries a name after its
//      colon (`runtime-only-columns:<table>`) the title of what comes before it.
// None of it rewrites the sentence. A scope the page has no words for keeps the
// scope as written, and test/i18n.test.mjs fails the suite on every scope the
// engine can emit that has no title.
//
// This file is also served to the page (src/mcp/http.mjs, minus `export `), and
// its keys are spelled as quoted prefixes so test/i18n.test.mjs sees them asked for.

/**
 * The topics, each with the openings of the sentences it covers. One regex per
 * opening, so the test can hold each against the engine's source on its own:
 * a sentence the engine rewords loses its title in a failing test, not quietly.
 */
export const LIMIT_TOPICS = Object.freeze({
  'depth-cap': [/^depth cap \d+ reached\b/],
  'walk-cap': [/^node cap reached\b/],
  'draw-cap': [/^node cap \d+ reached\b/, /^table cap \d+ reached\b/, /^the \d+-byte answer budget was reached\b/],
  'walk-empty': [/^the walk reached no statement at all\b/],
  'mode-floor': [/^\d+ link\(s\) below the grade floor of mode=/],
  'no-mode': [/^\d+ link\(s\) are RUNTIME_ONLY\/UNRESOLVED\b/],
  'handler-floor': [/^this route's handler is linked to it below the floor of mode=/],
  'handler-link': [/^this route's handler is linked to it only by a rule's guess\b/, /^this route's handler is linked to it by a candidate set\b/],
  'multi-handler': [/^\d+ route\(s\) are declared by more than one controller method\b/, /^this route is declared by \d+ controller methods\b/],
  'route-address': [/^this route's own address is graded\b/],
  generated: [/^\d+ step\(s\) from one generated symbol to another were not walked\b/],
  'walk-basis': [/^a table is on this map because a walk\b/, /^a screen reaches a route because a walk\b/,
    /^`endpoints` on a row counts the endpoints whose walk\b/, /^we attribute a statement to a group by following calls\b/],
  grouping: [/^a group is the first segment of an API path\b/, /^a group is the handler's package, cut to\b/],
  'grouping-breaks': [/^grouping by first path segment breaks down\b/],
  'no-code': [/^this pack has no code axis\b/],
  'no-frontend': [/^this pack has no frontend\b/],
  'other-project': [/^\d+ row\(s\) below come from another project\b/, /^\d+ node\(s\) on this map come from \d+ other registered project\(s\)/,
    /^\d+ other registered project\(s\) are on this answer\b/],
  'no-meta': [/^this server supplied no pack metadata\b/],
  'web-no-client': [/^\d+ of \d+ frontend call site\(s\) were traced to no client\b/],
  'code-outside-roots': [/^\d+ call\(s\) name a type from \d+ package\(s\) of this project that no analyzed source root holds\b/],
  'prisma-disagrees': [/^schema\.prisma and the SQL catalog this run read disagree\b/],
});

/** An axis limit's status, as the engine says it (src/core/lanes.mjs axisLimits). */
const AXIS_SAID = /^the (\S+) axis of this pack is (degraded|not-shipped)\b/;
/** The title of an axis by what it says of itself: the words Start and Analysis status use. */
export const LIMIT_AXIS_KEYS = Object.freeze({ 'not-shipped': 'ov.axis.notshipped', degraded: 'ov.axis.degraded', note: 'limit.axis.note' });
/** An overview gap relayed as a limit: "<kind> (<count>): <note>" (src/mcp/tools.mjs overview). */
const GAP_SAID = /^([a-z0-9]+(?:-[a-z0-9]+)*) \((?:\d+|unknown)\): /;

/** The topic a sentence opens with, or null. */
export function limitTopic(reason) {
  const s = String(reason ?? '');
  for (const [topic, openings] of Object.entries(LIMIT_TOPICS)) {
    if (openings.some((re) => re.test(s))) return topic;
  }
  return null;
}

/**
 * The keys a limit's title may come from, most specific first. The page takes
 * the first its catalogue has. An axis title carries `axis`, the axis whose
 * name fills its `{axis}`.
 * @param {{scope?:string, reason?:string}} limit
 * @returns {{key:string, axis?:string}[]}
 */
export function limitTitleKeys(limit) {
  const scope = String(limit?.scope ?? ''), reason = String(limit?.reason ?? '');
  const colon = scope.indexOf(':');
  const family = colon > 0 ? scope.slice(0, colon) : scope, name = colon > 0 ? scope.slice(colon + 1) : '';
  const out = [];
  if (family === 'diagnostic' && name) out.push({ key: 'diag.title.' + name });
  const said = family === 'axis' ? AXIS_SAID.exec(reason) : null;
  if (said && said[1] === name) out.push({ key: LIMIT_AXIS_KEYS[said[2]], axis: name });
  const gap = scope === 'overview' ? GAP_SAID.exec(reason) : null;
  if (gap) out.push({ key: 'ov.gap.' + gap[1] + '.label' });
  const topic = limitTopic(reason);
  if (topic) out.push({ key: 'limit.topic.' + topic });
  if (family === 'axis' && name && !said) out.push({ key: LIMIT_AXIS_KEYS.note, axis: name });
  if (scope) out.push({ key: 'limit.scope.' + scope });
  if (colon > 0) out.push({ key: 'limit.scope.' + family });
  return out;
}
