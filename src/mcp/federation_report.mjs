// federation_report.mjs — what a federated answer SAYS about the crossings it
// made, and about the ones it could not.
//
// WHAT THIS MODULE OWNS. The wording, and only the wording:
//   block()         the `answer.federation` object — what crossed, what did not,
//                   and which registered project could not be asked
//   siblingBasis()  the packs this answer really walked, for `basis.siblings`
//   limits()        one scoped sentence per unmatched, ambiguous, hop-capped or
//                   skipped item, each of them ending in what a reader can DO
//   saysAnything()  whether a federated block belongs on this answer at all: a
//                   single-project server that calls nobody has to answer
//                   exactly as it did before federation existed, because an
//                   empty block is a field that says nothing in an answer whose
//                   shape other tools diff against
//
// WHAT IT MUST NEVER KNOW ABOUT: how a crossing is made, or how a sidecar is
// read. Every function here takes the federator's own state as `f` and reads the
// four lists the crossings appended to. Nothing here walks anything.
//
// EVERY SENTENCE NAMES A REMEDY. "None of the registered projects serves it" is
// half an answer; the other half is `cascade init` and `cascade analyze` in the
// project that does.

import { cmp } from './federation_routes.mjs';

const sortedSkipped = (f) => [...f.skippedById.values()]
  .map((s) => ({ project: s.project, reason: s.reason }))
  .sort((a, b) => cmp(a.project, b.project) || cmp(a.reason, b.reason));

const sortedUnmatched = (f) => f.unmatched.slice()
  .sort((a, b) => cmp(a.from.symbol, b.from.symbol) || cmp(a.route.path, b.route.path));

const sortedHopCapped = (f) => f.hopCapped.slice()
  .sort((a, b) => cmp(a.from.project, b.from.project) || cmp(a.from.symbol, b.from.symbol) || cmp(a.route.path, b.route.path));

/**
 * HAS THIS FEDERATOR ANYTHING TO SAY? A picture on a server that serves one
 * project and calls nobody must come back exactly as it did before federation
 * existed: an empty block on it would be a field that says nothing, in an
 * answer whose shape other tools diff against.
 */
export function saysAnything(f) {
  return f.wanted && (f.available || f.unmatched.length > 0 || f.hopCapped.length > 0 || f.offPicture.length > 0);
}

/** The `answer.federation` block. */
export function block(f) {
  if (!f.wanted) return { available: false, reason: 'turned-off', unmatched: [] };
  if (!f.available) {
    return { available: false, reason: 'single-project', unmatched: sortedUnmatched(f) };
  }
  return {
    crossed: f.crossed.slice().sort((a, b) => cmp(a.from.project, b.from.project)
      || cmp(a.from.symbol, b.from.symbol) || cmp(a.to.project, b.to.project) || cmp(a.to.endpoint, b.to.endpoint)),
    unmatched: sortedUnmatched(f),
    skipped: sortedSkipped(f),
  };
}

/** `basis.siblings`, or null when this answer walked no other pack. */
export function siblingBasis(f) {
  if (f.siblings.size === 0) return null;
  return [...f.siblings.values()].sort((a, b) => cmp(a.project, b.project));
}

/** The calls that left this project and landed nowhere this server can name. */
function unmatchedLimits(f, say) {
  for (const u of sortedUnmatched(f)) {
    say(!f.available
      ? `${u.route.method} ${u.route.path} leaves this project, and this server serves no other project, so where it lands is unknown rather than absent. Register the project that serves it (\`cascade init\` and then \`cascade analyze\` there) and ask again`
      : `${u.route.method} ${u.route.path} leaves this project and none of the ${u.checked} other registered project(s) serves it`
        + `${u.noIndex > 0 ? `, and ${u.noIndex} of them carries no route index, so it could not be asked` : ''}. `
        + 'The chain stops at the call. Register the project that serves this route and ask again');
  }
}

/**
 * The calls that leave from code NO route on this picture reaches: a scheduled
 * job, a startup listener, a tool function an AI model calls.
 */
function offPictureLimits(f, say) {
  const off = f.offPicture.slice().sort((a, b) => cmp(a.from.symbol, b.from.symbol) || cmp(a.route.path, b.route.path));
  if (!off.length) return;
  const routes = [...new Set(off.map((o) => `${o.route.method} ${o.route.path}`))].sort();
  const symbols = [...new Set(off.map((o) => o.from.symbol))].sort();
  say(`${routes.length} call(s) leave this project from ${symbols.length} method(s) that no route on this picture reaches (${symbols.slice(0, 3).join(', ')}${symbols.length > 3 ? `, and ${symbols.length - 3} more` : ''}): ${routes.join(', ')}. `
    + 'A picture drawn from routes cannot show them, and they are real calls: a scheduled job, a startup listener or a tool an AI model calls is code nothing upstream of it names. '
    + '`overview.federation` counts every call that leaves the pack, and `flow` from the method itself follows this one');
}

/** A route several registered projects serve, with nothing in the call to choose between them. */
function ambiguousLimits(f, say) {
  const amb = new Map();
  for (const c of f.crossed) {
    if (!c.ambiguous) continue;
    const key = `${c.from.symbol} ${c.route.method} ${c.route.path}`;
    if (!amb.has(key)) amb.set(key, { call: c, projects: [] });
    amb.get(key).projects.push(c.to.project);
  }
  for (const a of [...amb.values()].sort((x, y) => cmp(x.call.from.symbol, y.call.from.symbol))) {
    say(`${a.call.route.method} ${a.call.route.path} is served by ${a.projects.slice().sort().join(', ')}, and nothing in the call says which of them it goes to`
      + `${a.call.service ? `, because the service name it carries (${a.call.service}) matches none of them` : ', because the call carries no service name'}. `
      + 'All of them are on this answer at HEURISTIC, so the rows below that crossing are candidates rather than one measured chain');
  }
}

/** One scoped sentence per unmatched, ambiguous, hop-capped or skipped item. */
export function limits(f) {
  if (!f.wanted) return [];
  const out = [];
  const say = (reason) => out.push({ scope: 'federation', reason });
  unmatchedLimits(f, say);
  offPictureLimits(f, say);
  for (const h of sortedHopCapped(f)) {
    say(`${h.route.method} ${h.route.path} leaves ${h.from.project} and the crossing cap (federationHops ${f.maxCrossings}) was already spent, `
      + 'so this answer never asked which project serves it. That is a bound on this answer, not an absence. '
      + 'Raise federationHops and ask again');
  }
  ambiguousLimits(f, say);
  for (const s of sortedSkipped(f)) {
    say(s.reason === 'no-index'
      ? `${s.project} is registered and carries no route index, so this answer could not ask what it serves. Re-run \`cascade analyze\` for ${s.project}`
      : s.reason === 'stale-index'
        ? `${s.project} carries a route index built from a different pack than the one this server loads, so it was not crossed. Re-run \`cascade analyze\` for ${s.project}`
        : `${s.project} is registered and its pack could not be read, so it was not crossed. Re-run \`cascade analyze\` for ${s.project}`);
  }
  return out;
}
