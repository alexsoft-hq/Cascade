// base_url.mjs — what a base URL holds in each build, and what that rests on.
//
// WHAT THIS MODULE OWNS. A frontend rarely writes its server's address as one
// literal. It writes `process.env.VUE_APP_BASE_API`, `import.meta.env.VITE_API
// ?? '/api'`, `NODE_ENV === 'production' ? … : '/'` or
// `http://localhost:8080/api`, and what each of those holds depends on WHICH
// BUILD it is. Three things decide it, and all three are read here:
//   the build tool   which `.env` files it reads, in which order, per mode. That
//                    is each tool's documented rule, so it is a declaration
//                    (adapters/web/packs/build-env.json), chosen by the
//                    dependencies the package's own package.json names
//   the default      `X || 'lit'` holds the literal only where nothing sets X,
//                    and no file here can show that nothing does: a shell, a CI
//                    job or a container sets it as easily as a `.env` file. So
//                    a value that rests on the literal is a GUESS, and says so
//   the host         an absolute address on this machine is a backend's
//                    development server, whatever port it names; one anywhere
//                    else is a deployment, and which code runs there is not in
//                    the source
// The answer is a list of OUTCOMES, one per (branch, build mode): a path, a
// host, and what it rests on. prefix.mjs turns those into a client's prefix and
// calls.mjs into the text of a URL built on one.
//
// WHAT IT MUST NEVER KNOW ABOUT: proxy rules, gateway routes, the routes this
// pack serves. What of a base URL reaches the server is prefix.mjs's question,
// and this module only says what the base URL IS.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTail } from './shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let PACK = null;

/**
 * The build-env declaration pack, read once per process. A new build tool is a
 * row in that file, not a rule in here.
 * @returns {{localHosts:string[], tools:object[], default:object}}
 */
export function buildEnvPack() {
  if (PACK === null) {
    const file = path.join(HERE, '..', '..', '..', 'adapters', 'web', 'packs', 'build-env.json');
    PACK = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return PACK;
}

/** What each guess a value can rest on means, in one sentence. */
export const WEB_BASE_GUESS = Object.freeze({
  fallback: 'the value is the literal an environment value falls back to (`X || \'lit\'`), and no .env file this build tool reads sets X. The literal runs only where NOTHING sets X, and a shell, a CI job or a container can, so every edge built on it is HEURISTIC',
  'deployment-host': 'every build names a host that is not this machine, and which code answers there is not in the source. Its path is read as this pack\'s prefix only because this frontend was analyzed with this backend, which is a guess, so every edge built on it is HEURISTIC',
  'assumed-alias': 'the base URL was read from a module reached through an import alias this engine ASSUMED (`@` as `src`), so every edge built on it is HEURISTIC, the same as a call through that alias',
  'port-default': 'the address is this machine on a port no file of this pack states, and this pack\'s port rests on Spring Boot\'s default (8080), which whatever starts the application may change. That this pack answers it is an assumed default, so every edge built on it is HEURISTIC',
  'port-unknown': 'the address is this machine on a port no file of this pack states, and the port of at least one of its applications is not known, so whether this pack answers it is not settled, and every edge built on it is HEURISTIC',
});

/** `localhost:8080` -> `localhost`, `[::1]:3000` -> `[::1]`, `user@host` -> `host`, lower case. */
export function hostnameOf(host) {
  let h = String(host ?? '').toLowerCase();
  const at = h.lastIndexOf('@');
  if (at >= 0) h = h.slice(at + 1);
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon < 0 ? h : h.slice(0, colon);
}

/** Whether a host is this machine, whatever port it names. */
export function isLocalHost(host) {
  return (buildEnvPack().localHosts ?? []).includes(hostnameOf(host));
}

/** The port an address WRITES, or null: `localhost:8081` -> 8081, `localhost` -> null. */
export function portOf(host) {
  const h = String(host ?? '');
  const tail = h.startsWith('[') ? h.slice(h.indexOf(']') + 1) : h;
  const m = /:(\d{1,5})$/.exec(tail);
  return m ? Number(m[1]) : null;
}

/**
 * THIS MACHINE, BUT ANOTHER SERVICE: an address on this machine whose written
 * port no application of this pack listens on (`ports`, src/core/server_ports.mjs).
 * Null when the host is not this machine, writes no port, names one of this
 * pack's, or the pack's ports are not known or rest on a default: then
 * nothing is decided by port.
 *
 * @param {string} host
 * @param {{known:boolean, ports:number[], files:string[]}|null} ports
 * @returns {{host:string, called:number, served:number[], reason:string}|null}
 */
export function otherPortOf(host, ports) {
  // A port that rests on Spring Boot's default is itself a guess: whatever
  // starts the application may set another, so no call is another service's
  // on the strength of it (review 3, design 4).
  if (!ports || ports.known !== true || ports.defaulted === true || !isLocalHost(host)) return null;
  const called = portOf(host);
  if (called === null || ports.ports.includes(called)) return null;
  return {
    host, called, served: ports.ports,
    reason: `${host} is this machine on port ${called}, and this pack listens on ${ports.ports.join(', ')} (${portSources(ports)}), so another service answers it`,
  };
}

/** Where the ports came from, in words: the files that set server.port, and the profile's `servers` entries. */
function portSources(ports) {
  const said = [
    (ports.files ?? []).length > 0 ? `server.port in ${ports.files.join(', ')}` : null,
    ...(ports.declared ?? []).map((d) => `servers[${JSON.stringify(d.key)}] in the profile`),
  ].filter(Boolean);
  return said.length > 0 ? said.join('; ') : 'Spring Boot\'s default, as no file sets server.port';
}

/**
 * THIS MACHINE, ON A PORT NO FILE STATES (review 4, W-7): an address on this
 * machine whose written port no configuration or deployment file of this pack
 * states, while an application's port rests on Spring Boot's default or is
 * not known. That this pack answers it is then not settled, and not stated:
 * `port-default` when it rests on the default, `port-unknown` when a port is
 * not known. Null when the host is not this machine, writes no port, names a
 * stated one, or every port is stated (then `otherPortOf` decides).
 * @returns {('port-default'|'port-unknown'|null)}
 */
export function unsettledPortOf(host, ports) {
  if (!ports || !isLocalHost(host)) return null;
  const called = portOf(host);
  if (called === null || (ports.stated ?? []).includes(called)) return null;
  if (ports.known === true && ports.defaulted !== true) return null;
  return ports.known === true ? 'port-default' : 'port-unknown';
}

/** The port guess a value's builds rest on: the first build on this machine whose port no file states. */
export function portGuessOf(outcomes, ports) {
  for (const o of outcomes) {
    const guess = o.where === 'local' ? unsettledPortOf(o.host, ports) : null;
    if (guess !== null) return guess;
  }
  return null;
}

/**
 * The other service EVERY build of a value goes to, or null. One build that
 * reaches this pack (a relative address, this machine on one of its ports or on
 * none written) keeps the value here; a build on another host says nothing
 * about this machine at all.
 */
export function awayOf(outcomes, ports) {
  let away = null;
  for (const o of outcomes) {
    const other = o.where === 'local' ? otherPortOf(o.host, ports) : null;
    if (other === null && o.where !== 'remote') return null;
    if (away === null) away = other;
  }
  return away;
}

/**
 * One address read as a PATH, plus where it points: `local` (this machine),
 * `remote` (anywhere else) or `relative` (the page's own origin).
 */
export function splitAddress(raw) {
  const m = /^(https?:)?\/\/([^/]+)(\/.*)?$/.exec(String(raw ?? ''));
  if (!m) return { path: normalizeTail(raw), host: null, where: 'relative' };
  return { path: normalizeTail(m[3] ?? ''), host: m[2], where: isLocalHost(m[2]) ? 'local' : 'remote' };
}

/**
 * The environment NAME a summary reads, or null. `process.env.X` is how a
 * webpack-based build spells it and `import.meta.env.X` is Vite's; a deeper path
 * is a member of an environment value, not one.
 */
export function envNameOf(summary) {
  if (!summary || summary.kind !== 'member' || !Array.isArray(summary.path)) return null;
  if (summary.root !== 'process' && summary.root !== 'import.meta') return null;
  if (summary.path.length !== 2 || summary.path[0] !== 'env' || summary.path[1] === '*') return null;
  return summary.path[1];
}

/** The same question asked of a hole's spelling: `import.meta.env.X` -> `X`. */
export function envNameOfSpelling(name) {
  const m = /^(?:process\.env|import\.meta\.env)\.([^.]+)$/.exec(String(name ?? ''));
  return m && m[1] !== '*' ? m[1] : null;
}

/**
 * Every environment name an expression reads, joined the way a reader writes
 * them (`VITE_BASE_URL + VITE_API_URL`), or null when it reads none.
 */
export function envNamesOf(summary) {
  const names = [];
  const walk = (s) => {
    if (!s) return;
    const own = envNameOf(s);
    if (own !== null) { names.push(own); return; }
    if (s.kind === 'fallback') walk(s.left);
    else if (s.kind === 'ternary') (s.candidates ?? []).forEach(walk);
    else if (s.kind === 'template') {
      for (const h of s.holes ?? []) {
        if (h.kind === 'name') { const n = envNameOfSpelling(h.name); if (n !== null) names.push(n); } else if (h.kind === 'env-expr') walk(h.expr);
      }
    }
  };
  walk(summary);
  const uniq = [...new Set(names)];
  return uniq.length > 0 ? uniq.join(' + ') : null;
}

/** A hole's spelling as the member summary a base URL would carry, or null. */
export function envReadOfSpelling(name) {
  const m = /^(process|import\.meta)\.env\.([^.]+)$/.exec(String(name ?? ''));
  return m && m[2] !== '*' ? { kind: 'member', root: m[1], path: ['env', m[2]] } : null;
}

/** The build tool a package's dependencies name, or the pack's default row. */
export function buildToolOf(dependencies) {
  const deps = new Set(Array.isArray(dependencies) ? dependencies : []);
  const pack = buildEnvPack();
  return (pack.tools ?? []).find((t) => (t.dependencies ?? []).some((d) => deps.has(d))) ?? pack.default;
}

const baseName = (file) => String(file ?? '').slice(String(file ?? '').lastIndexOf('/') + 1);

/** The builds one package is made in: the tool's own modes, plus each `.env.<mode>` it reads a mode from. */
function modesOf(cfg, tool) {
  const modes = new Set(tool.modes ?? []);
  if (tool.customModes === true) {
    for (const rows of cfg.env.values()) for (const r of rows) if (r.mode) modes.add(r.mode);
  }
  return [...modes].sort();
}

/**
 * What ONE environment name holds in each build mode: the last file in the
 * tool's order that sets it, or nothing when no file this tool reads does.
 * @returns {{mode:string, value:(string|null), file:(string|null)}[]}
 */
export function envByMode(cfg, name) {
  const tool = buildToolOf(cfg.dependencies);
  const rows = cfg.env.get(name) ?? [];
  return modesOf(cfg, tool).map((mode) => {
    const order = (tool.files ?? []).map((f) => f.replace('{mode}', mode));
    let best = null;
    let rank = -1;
    for (const r of rows) {
      // A later line of the same file wins, the way dotenv assigns them.
      const at = order.indexOf(baseName(r.file));
      if (at >= 0 && at >= rank) { best = r; rank = at; }
    }
    return best === null ? { mode, value: null, file: null } : { mode, value: best.value, file: best.file };
  });
}

/** One outcome: a raw value read as an address, what it rests on, and where it came from. */
function outcome(raw, from, extra) {
  return {
    ...splitAddress(raw), raw: String(raw), from, mode: null, file: null, env: null, branch: null, ...extra,
  };
}

/**
 * Every value one environment read has: one per build mode a file sets it in,
 * and, when the source wrote a default, that literal for every mode no file
 * sets it in. With a default and no mode at all, the literal alone.
 */
/**
 * Whether a value read for `X` is SET, as the operator its default is written
 * with sees it (review 2, item 5): `X || 'lit'` takes the literal for the empty
 * string too, since `''` is falsy; `X ?? 'lit'` keeps `''`, which is neither
 * null nor undefined. A dotenv file writes `X=` as the empty string.
 */
const isSet = (value, operator) => value !== null && !(operator === '||' && value === '');

function envOutcomes(cfg, env, fallback, branch, operator = null) {
  const out = [];
  for (const m of envByMode(cfg, env)) {
    if (isSet(m.value, fallback === null ? null : operator)) out.push(outcome(m.value, 'env-file', { mode: m.mode, file: m.file, env, branch }));
    else if (fallback !== null) out.push(outcome(fallback, 'fallback', { mode: m.mode, env, branch }));
  }
  if (out.length === 0 && fallback !== null) out.push(outcome(fallback, 'fallback', { env, branch }));
  return out;
}

/** `process.env.X || 'lit'` and `?? 'lit'`, as the name and the literal; null for any other shape. */
function fallbackOf(summary) {
  const env = envNameOf(summary.left);
  const right = summary.right ?? null;
  return env !== null && right && right.kind === 'string' ? { env, fallback: right.value, operator: summary.operator ?? '||' } : null;
}

/**
 * What ONE hole of a template holds in one build: `{value, from, file, env}`,
 * null when this build sets it nowhere, undefined when it is not a build fact
 * at all (a parameter, a call), which no build can fill.
 */
function holeInMode(cfg, h, mode) {
  let env = h && h.kind === 'name' ? envNameOfSpelling(h.name) : null;
  let fallback = null;
  let operator = null;
  if (env === null && h && h.kind === 'env-expr' && h.expr && h.expr.kind === 'fallback') {
    const fb = fallbackOf(h.expr);
    if (fb !== null) ({ env, fallback, operator } = fb);
  }
  if (env === null) return undefined;
  const m = envByMode(cfg, env).find((x) => x.mode === mode);
  if (m && isSet(m.value, operator)) return { value: m.value, from: 'env-file', file: m.file, env };
  return fallback === null ? null : { value: fallback, from: 'fallback', file: null, env };
}

/**
 * TEXT MADE OF BUILD FACTS, `VITE_BASE_URL + VITE_API_URL`: read per build, both
 * halves from the SAME build, never one from each. A build that sets one of
 * them nowhere says nothing; a hole no build can fill makes it unreadable.
 */
function templateOutcomes(cfg, summary, branch) {
  const holes = Array.isArray(summary.holes) ? summary.holes : [];
  const parts = String(summary.template).split('{*}');
  if (holes.length === 0 || parts.length - 1 !== holes.length) return { outcomes: [], complete: false };
  const out = [];
  for (const mode of modesOf(cfg, buildToolOf(cfg.dependencies))) {
    const vals = holes.map((h) => holeInMode(cfg, h, mode));
    if (vals.some((v) => v === undefined)) return { outcomes: [], complete: false };
    if (vals.some((v) => v === null)) continue;
    const text = parts.map((p, i) => (i < vals.length ? `${p}${vals[i].value}` : p)).join('');
    const files = [...new Set(vals.map((v) => v.file).filter(Boolean))].sort();
    out.push(outcome(text, vals.some((v) => v.from === 'fallback') ? 'fallback' : 'env-file', {
      mode, branch, env: vals.map((v) => v.env).join(' + '), file: files.length > 0 ? files.join(', ') : null,
    }));
  }
  return { outcomes: out, complete: out.length > 0 };
}

/** A conditional: every candidate's outcomes, each marked with the branch it came from. */
function ternaryOutcomes(cfg, summary, branch) {
  const out = [];
  let complete = true;
  (summary.candidates ?? []).forEach((c, i) => {
    const got = outcomesOf(cfg, c, branch === null ? String(i) : `${branch}.${i}`);
    out.push(...got.outcomes);
    complete = complete && got.complete;
  });
  return { outcomes: out, complete };
}

/** What one summary can hold, and whether that is ALL it can hold. */
function outcomesOf(cfg, summary, branch) {
  const one = (list) => ({ outcomes: list, complete: list.length > 0 });
  switch (summary ? summary.kind : null) {
    case 'string': return one([outcome(summary.value, 'source', { branch })]);
    case 'template':
      return (summary.dynamicParts ?? 0) === 0
        ? one([outcome(summary.template, 'source', { branch })]) : templateOutcomes(cfg, summary, branch);
    case 'member': {
      const env = envNameOf(summary);
      return one(env === null ? [] : envOutcomes(cfg, env, null, branch));
    }
    case 'fallback': {
      const fb = fallbackOf(summary);
      return one(fb === null ? [] : envOutcomes(cfg, fb.env, fb.fallback, branch, fb.operator));
    }
    case 'ternary': return ternaryOutcomes(cfg, summary, branch);
    default: return one([]);
  }
}

/**
 * A base URL summary read into outcomes, in three states: `absent` (nothing was
 * declared), `known` (every outcome was read) and `unknown` (at least one part
 * could not be, and the outcomes that were are candidates only). `detailed`
 * says the summary had a default or a condition in it, which is when a reader
 * needs the outcomes on the edge to see which one was used.
 */
export function readBase(cfg, summary) {
  if (!summary) return { state: 'absent', outcomes: [], detailed: false };
  const got = outcomesOf(cfg, summary, null);
  const detailed = summary.kind === 'fallback' || summary.kind === 'ternary' || summary.kind === 'template';
  return { state: got.complete ? 'known' : 'unknown', outcomes: got.outcomes, detailed };
}

/**
 * THE BUILDS a value holds in (review 2, item 4): null when it holds in every
 * build the package's tool makes (a literal, a default, or a file for each), else
 * the modes a file sets it for. A value set only for development and another
 * set only for production are never one request: no build sends both.
 */
export function buildModesOf(cfg, outcomes) {
  if (outcomes.length === 0 || outcomes.some((o) => o.mode === null)) return null;
  const modes = [...new Set(outcomes.map((o) => o.mode))].sort();
  const all = modesOf(cfg, buildToolOf(cfg.dependencies));
  return all.every((m) => modes.includes(m)) ? null : modes;
}

/**
 * THE BUILDS NO FILE SETS the value in, when every value read came from a
 * build's own file (review 3, R4): there the client is made with nothing at
 * that key, and sends the path as written. Empty when a literal or a default
 * holds in every build, or when every build sets it.
 */
export function unsetModesOf(cfg, outcomes) {
  if (outcomes.length === 0 || outcomes.some((o) => o.mode === null)) return [];
  const set = new Set(outcomes.map((o) => o.mode));
  return modesOf(cfg, buildToolOf(cfg.dependencies)).filter((m) => !set.has(m));
}

/**
 * What the outcomes that give ONE path rest on, as the guess a reader has to
 * know about: a default literal, or a host that is not this machine in every
 * build. A local or relative outcome at the same path means some build reaches
 * this machine there, and the remote ones are the same backend deployed.
 */
export function guessOf(outcomes) {
  if (outcomes.some((o) => o.from === 'fallback')) return 'fallback';
  if (outcomes.length > 0 && outcomes.every((o) => o.where === 'remote')) return 'deployment-host';
  return null;
}

/** The outcomes as evidence: one row per distinct read, with the modes it holds in. */
export function readsOf(outcomes) {
  const rows = new Map();
  for (const o of outcomes) {
    const key = JSON.stringify([o.branch, o.from, o.raw, o.file, o.env]);
    if (!rows.has(key)) {
      rows.set(key, {
        ...(o.branch !== null ? { branch: o.branch } : {}), from: o.from, raw: o.raw,
        ...(o.env ? { env: o.env } : {}), ...(o.file ? { file: o.file } : {}), modes: [],
      });
    }
    if (o.mode) rows.get(key).modes.push(o.mode);
  }
  return [...rows.values()].map(({ modes, ...rest }) => (modes.length > 0 ? { ...rest, modes } : rest));
}

/**
 * The TEXT a value the build decides puts at the front of a URL, when every
 * build gives it one path; null when the builds disagree, or a part of it is
 * set nowhere and no default was written, because putting one of several paths
 * in would be a guess nobody could see. An address every build spells
 * absolutely keeps a host (this machine's, when one names it) so the caller can
 * tell it from a relative one.
 *
 * @param {object} summary  an environment read, a default, a template or a
 *        condition over those (adapters/web/lib/ast.mjs isEnvExpression)
 * @returns {{text:string, from:string, guess:(string|null), reads:object[]}|null}
 */
export function fillFromExpression(cfg, summary, ports = null) {
  const got = outcomesOf(cfg, summary, null);
  const outcomes = got.outcomes;
  if (!got.complete || outcomes.length === 0 || new Set(outcomes.map((o) => o.path)).size !== 1) return null;
  const shown = outcomes.find((o) => o.where === 'local') ?? outcomes[0];
  const absolute = outcomes.every((o) => o.host !== null);
  const away = awayOf(outcomes, ports);
  const modes = buildModesOf(cfg, outcomes);
  return {
    ...(modes ? { modes } : {}),
    text: absolute ? shown.raw.replace(/\/+$/, '') : shown.path,
    from: outcomes.some((o) => o.from === 'fallback') ? 'fallback' : 'env-file',
    guess: away === null ? (guessOf(outcomes) ?? portGuessOf(outcomes, ports)) : null,
    reads: readsOf(outcomes),
    ...(away ? { away } : {}),
  };
}

/**
 * What a NAME a base URL is written as holds, read where it is declared: a
 * constant's text, a value the build decides (`expr`), a member of an object
 * constant (`config.base_url`), or a binding to `process.env.X`. Null for
 * anything else, and for a member path deeper than one key.
 */
export function declaredValueOf(files, file, name, key) {
  const f = files.get(file);
  if (!f) return null;
  const rec = f.constants.get(name) ?? null;
  if (rec !== null) {
    if (key !== null) {
      const e = rec.exprMembers ? rec.exprMembers[key] : undefined;
      if (e) return e;
      const v = rec.members ? rec.members[key] : undefined;
      return typeof v === 'string' ? { kind: 'string', value: v } : null;
    }
    if (rec.expr) return rec.expr;
    return typeof rec.value === 'string' ? { kind: 'string', value: rec.value } : null;
  }
  const init = key === null ? (f.bindings.get(name)?.init ?? null) : null;
  if (!init || init.shape !== 'member' || !init.callee) return null;
  const m = { kind: 'member', root: init.callee.root, path: init.callee.path };
  return envNameOf(m) !== null ? m : null;
}

/**
 * A base URL written as a NAME (`baseURL: API_BASE`, `baseURL: config.base_url`)
 * followed to what it holds, in this file or through an import.
 *
 * @param {{files:Map, resolver:object}} deps
 * @returns {(file:string, summary:object) => ({summary:object, assumed:boolean}|null)}
 */
export function makeBaseReader({ files, resolver }) {
  return (file, summary) => {
    if (!summary || (summary.kind !== 'ident' && summary.kind !== 'member')) return null;
    if (summary.kind === 'member' && (envNameOf(summary) !== null || (summary.path ?? []).length !== 1)) return null;
    const name = summary.kind === 'ident' ? summary.name : summary.root;
    const r = resolver.resolveLocal(file, name, 0);
    if (!r || r.external || r.namespace || !r.file) return null;
    const got = declaredValueOf(files, r.file, r.name, summary.kind === 'ident' ? null : summary.path[0]);
    return got === null ? null : { summary: got, assumed: r.assumed === true };
  };
}
