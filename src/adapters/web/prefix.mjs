// prefix.mjs — what a frontend's URL is missing, and how we know.
//
// WHAT THIS MODULE OWNS. A frontend writes `client.get('/things/list')` and the
// server serves `/api/things/list`. The difference is the PREFIX, and there are
// four ways to know it, in this order:
//   declared     the profile's `gatewayRoutes` says which front-end prefix maps
//                onto which back-end one, and which service answers it
//   derived      the base URL is in the source (a literal, an env value, an
//                env value's default, every branch of a conditional, an
//                absolute address) and a dev-server proxy rule explains what of
//                it reaches the server. What each of those holds per build is
//                base_url.mjs's answer; a value that rests on a default literal
//                or on a host that is not this machine is still derived, and
//                carries that `guess`, which grades its edges HEURISTIC
//   auto         nothing states it, so every candidate is matched against the
//                routes this pack serves and the one that hits most wins. A
//                guess, and every edge through it is HEURISTIC
//   none         no candidate matched anything, so the URL is used as written
// Plus the fifth, which needs no candidate at all: a SERVER-RENDERED page writes
// its paths from the application root, so its prefix is the empty string.
//
// It also owns the package table those rules read from — which directory each
// file belongs to, and what that package's `.env` files, proxy rules, path
// aliases and build dependencies say.
//
// WHAT IT MUST NEVER KNOW ABOUT: the fact stream's calls, the screens, the
// graph. It is handed the routes this pack serves as two plain collections and
// a match function, because the `auto` rule has to SCORE candidates against
// them, and it looks at nothing else.

import { gatewayRouteOf } from '../../core/profile.mjs';
import {
  cmp, configDirOf, normalizePosix, normalizeTail, normalizeUrl,
} from './shared.mjs';
import { sortKey } from './symbols.mjs';
import {
  awayOf, buildModesOf, guessOf, readBase, readsOf, unsetModesOf,
} from './base_url.mjs';

// Where it has always been exported from, so every importer still finds it.
export { normalizeTail };

/** The mode whose value wins when two .env files disagree and nothing else decides. */
const PREFERRED_MODE = 'development';

/** What each prefix decision rested on, in one sentence. */
export const WEB_PREFIX_BASIS = Object.freeze({
  declared: 'the profile declares gatewayRoutes, and this front-end prefix maps onto that back-end prefix by declaration',
  derived: 'the base URL was read from the client\'s own configuration (an env value, a literal, an absolute address) and the dev-server proxy rule that explains it was applied',
  auto: 'nothing in the source states the prefix, so every candidate was matched against the routes this pack serves and the one with the most exact hits was chosen. That is a guess, and every edge through it is HEURISTIC',
  none: 'no candidate prefix matched any route this pack serves, so the URL is used as written',
  'context-path': 'the call is written in a server-rendered page, whose paths start at the application root. `${request.contextPath}`, `@{/…}` and `<c:url>` all name that root, and it is not part of any route this pack serves, so the prefix is empty',
});

/**
 * The prefix a SERVER-RENDERED PAGE's calls carry: none (RM48).
 *
 * A page writes its paths from the application root — `@{/owners}`,
 * `${request.contextPath}/cart/update` — and the context path is where the
 * deployment is mounted, not part of any route the pack serves. So the prefix
 * is the empty string, and no candidate had to be scored to find that out.
 */
export const TEMPLATE_PREFIX = Object.freeze({ value: '', from: 'context-path', front: '', candidates: [] });

/**
 * An absolute address read down to its PATH, or a relative value left alone.
 * The host rides along when there was one, because the caller has to know
 * whether a proxy rule still applies. The base URL reader now works on
 * base_url.mjs's outcomes; this stays for what reads one address alone.
 */
export function absoluteSplit(raw) {
  const m = /^(https?:)?\/\/([^/]+)(\/.*)?$/.exec(String(raw ?? ''));
  if (m) {
    const v = normalizeTail(m[3] ?? '');
    return { state: 'known', value: v, values: [v], absolute: true, ambiguous: false, host: m[2] };
  }
  const v = normalizeTail(String(raw ?? ''));
  return { state: 'known', value: v, values: [v], absolute: false, ambiguous: false };
}

/**
 * The packages this run read, and what each one declares.
 *
 * A package is a directory with a package.json, or — where there is none — the
 * directory a config record sits in. Every `.env` value, dev-proxy rule and path
 * alias is filed under one, because two frontends in one repository have two
 * different answers to every question above and mixing them is how a call gets
 * the other one's prefix.
 *
 * @returns {{packageDirs:Set<string>, packageOf:Function, configFor:Function}}
 */
export function readPackages({ opts, configs }) {
  const packageDirs = packageDirsOf(opts, configs);
  const sortedPackages = [...packageDirs].sort((a, b) => b.length - a.length || cmp(a, b));
  const packageOf = (file) => {
    for (const d of sortedPackages) {
      if (d === '' || file === d || file.startsWith(`${d}/`)) return d;
    }
    return '';
  };
  const pkgConfig = new Map();
  const configFor = (dir) => {
    if (!pkgConfig.has(dir)) {
      pkgConfig.set(dir, {
        env: new Map(), proxies: [], aliases: [], scopedAliases: [], axiosBaseUrl: null, dependencies: null,
      });
    }
    return pkgConfig.get(dir);
  };
  for (const d of packageDirs) configFor(d);
  for (const c of configs.slice().sort((a, b) => cmp(sortKey(a), sortKey(b)))) {
    const dir = configDirOf(c.file);
    if (c.what === 'package' && !packageDirs.has(dir)) continue;
    fileConfigRecord(configFor(packageDirs.has(dir) ? dir : packageOf(c.file)), c);
  }
  for (const cfg of pkgConfig.values()) {
    // The longest context first: `/api/v2` must win over `/api`.
    cfg.proxies.sort((a, b) => b.context.length - a.context.length || cmp(a.context, b.context));
    cfg.aliases.sort((a, b) => b.from.length - a.from.length || cmp(a.from, b.from));
    cfg.scopedAliases.sort((a, b) => cmp(a.scope, b.scope) || b.from.length - a.from.length || cmp(a.from, b.from));
  }
  return { packageDirs, packageOf, configFor };
}

/** The package directories: the ones discovery names, and the ones a config record sits in. */
function packageDirsOf(opts, configs) {
  const packageDirs = new Set();
  for (const p of opts.packages ?? []) {
    // discovery names the package.json, and the package is the directory it sits in.
    if (p && typeof p.path === 'string') packageDirs.add(configDirOf(normalizePosix(p.path)));
  }
  // A SCOPED alias record (RM67) comes from a directory INSIDE a package, and
  // that directory is not a package: it names no dependencies and holds no
  // .env, so it must not become one. A package.json's own record names no
  // package the others did not either: it only says what one of them builds
  // with.
  for (const c of configs) {
    if (typeof c.scope !== 'string' && c.what !== 'package') packageDirs.add(configDirOf(c.file));
  }
  if (packageDirs.size === 0) packageDirs.add('');
  return packageDirs;
}

/** One config record filed under what it declares. */
function fileConfigRecord(cfg, c) {
  if (c.what === 'env') {
    if (!cfg.env.has(c.name)) cfg.env.set(c.name, []);
    cfg.env.get(c.name).push({ value: c.value, mode: c.mode ?? null, file: c.file });
  } else if (c.what === 'proxy') cfg.proxies.push(c);
  else if (c.what === 'alias') (typeof c.scope === 'string' ? cfg.scopedAliases : cfg.aliases).push(c);
  else if (c.what === 'axios-defaults' && c.key === 'baseURL') cfg.axiosBaseUrl = c.value ?? null;
  else if (c.what === 'package') cfg.dependencies = Array.isArray(c.dependencies) ? c.dependencies : [];
}

/**
 * B5: the prefix per client instance.
 *
 * The four rules below are written apart, each answering "can I decide it this
 * way?" with a prefix object or null, and `prefixOf` asks them in order and
 * memoises the answer. They take one CONTEXT between them: the instances, the
 * package configuration, the declared gateway table, and — for the auto rule —
 * the routes this pack serves plus the URLs each instance actually sends.
 *
 * @typedef {{instanceOf:Map, configFor:Function, gatewayRoutes:object, gatewayKeys:string[],
 *            callsPerInstance:Map, exactPaths:Set<string>, templatePaths:string[],
 *            routeMatches:Function}} PrefixCtx
 */

/**
 * WHICH PATH a base URL is, when its builds read more than one.
 *
 * The builds DISAGREE more often than not. Two shapes, both measured on the
 * frontends this was built against:
 *
 *   - `/dev-api`, `/prod-api` and `/stage-api` for the same variable: three
 *     real prefixes, and exactly one of them has a dev-proxy rule explaining
 *     it. That one is the one this analysis can follow to a route, so it wins.
 *   - a relative path for development and two absolute addresses for the two
 *     deployments, all three ending in the SAME path. Compared as strings
 *     those disagree; compared as PATHS they are one value, which is what
 *     they are. So `paths` is already a list of paths.
 *
 * Only when neither settles it is the answer ambiguous, and the auto step
 * takes over. A conditional (`a ? b : c`) is settled the same way: its
 * branches are more builds of one base URL.
 */
function settlePaths(ctx, pkg, paths, outcomes) {
  if (paths.length === 1) return { value: paths[0], ambiguous: false };
  const cfg = ctx.configFor(pkg);
  const explained = paths.filter((v) => v !== '' && cfg.proxies.some((p) => v === p.context || v.startsWith(p.context)));
  if (explained.length === 1) return { value: explained[0], ambiguous: false };
  const chosen = outcomes.find((o) => o.mode === PREFERRED_MODE)
    ?? outcomes.slice().sort((a, b) => cmp(a.mode ?? '', b.mode ?? '') || cmp(a.file ?? '', b.file ?? ''))[0];
  return { value: chosen.path, ambiguous: true };
}

/**
 * A base-URL summary read down to a string, in THREE states that must not be
 * confused with each other:
 *
 *   absent   the client declares no base URL and the package declares no
 *            axios default. That is not an unknown: a client with no base URL
 *            sends the path as written, which is a prefix of ''. Calling it a
 *            guess would grade every `fetch('/health')` in the corpus
 *            HEURISTIC for a fact the library documents.
 *   known    the value was read (a literal, an env value, an absolute address,
 *            an env value's default, every branch of a conditional).
 *   unknown  a base URL IS declared and this lane could not read all of it: an
 *            env name no .env file this build reads sets, a template with a
 *            hole in it, an expression, a conditional with one such branch.
 *            THAT is what the auto step exists for, and whatever WAS read is
 *            among its candidates.
 *
 * What the value rests on rides along as `guess` (base_url.mjs), and for a
 * default or a conditional the reads themselves (`reads`), so the edge says
 * which build gave which value.
 */
function baseUrlValue(ctx, summary, pkg, assumed = false) {
  const read = readBase(ctx.configFor(pkg), summary);
  if (read.state === 'absent') return { state: 'absent', value: '', values: [''], absolute: false, ambiguous: false };
  const paths = [...new Set(read.outcomes.map((o) => o.path))].sort();
  const reads = read.detailed ? { reads: readsOf(read.outcomes) } : {};
  if (read.state === 'unknown') {
    return {
      state: 'unknown', value: '', values: paths.length > 0 ? paths : [''], absolute: false, ambiguous: false, ...reads,
    };
  }
  const { value, ambiguous } = settlePaths(ctx, pkg, paths, read.outcomes);
  const mine = read.outcomes.filter((o) => o.path === value);
  // Every build on this machine but on a port this pack does not listen on is
  // ANOTHER service's base URL: its calls leave the pack, with both ports said.
  const away = awayOf(mine, ctx.ports);
  // Read through an alias this engine assumed, the value is only as good as
  // that guess, whatever it holds.
  const guess = away ? null : (guessOf(mine) ?? (assumed ? 'assumed-alias' : null));
  // ABSOLUTE only when every build that gives this path spells a host: a dev
  // proxy never sees an absolute address, and one relative build still goes
  // through it.
  // The builds the chosen value holds in, when not every one (review 2, item 4).
  const modes = buildModesOf(ctx.configFor(pkg), mine);
  // The builds that set it nowhere send no base URL at all (review 3, R4).
  const unset = unsetModesOf(ctx.configFor(pkg), read.outcomes);
  return {
    state: 'known', value, values: paths, ambiguous, absolute: mine.every((o) => o.host !== null),
    ...(guess ? { guess } : {}), ...(away ? { away } : {}), ...(modes ? { modes } : {}), ...reads,
    ...(unset.length > 0 ? { unset: { value: '', modes: unset } } : {}),
  };
}

/** The proxy rule that explains a relative base URL, and what it leaves. */
function throughProxy(ctx, value, pkg) {
  if (value === '') return { value: '', ok: true };
  const cfg = ctx.configFor(pkg);
  const rule = cfg.proxies.find((p) => value === p.context || value.startsWith(p.context));
  if (!rule) return { ok: false, reason: 'no-proxy-rule' };
  if (rule.rewrite === 'opaque') return { ok: false, reason: 'opaque-rewrite' };
  if (!Array.isArray(rule.rewrite) || rule.rewrite.length === 0) return { value, ok: true, rule: rule.context };
  let out = value;
  for (const r of rule.rewrite) {
    try { out = out.replace(new RegExp(r.from), r.to ?? ''); } catch { return { ok: false, reason: 'opaque-rewrite' }; }
  }
  return { value: normalizeTail(out), ok: true, rule: rule.context };
}

/**
 * 1. DECLARED. The profile said what the front-end prefix maps onto, so no rule
 * has to work it out. I-5: gatewayRoutes reaches exactly two readers, this one
 * and src/adapters/java_bridge.mjs, which applies the same rewrite to an
 * imperative Java HTTP call. Both read a value through the one reader in
 * src/core/profile.mjs, so a route's `service` means the same thing on both
 * sides of the wire.
 */
function declaredPrefix(ctx, base) {
  const star = Object.prototype.hasOwnProperty.call(ctx.gatewayRoutes, '*')
    ? gatewayRouteOf(ctx.gatewayRoutes['*']) : null;
  if (star !== null) return { value: normalizeTail(star.to), from: 'declared', service: star.service, candidates: [] };
  if (base.state !== 'known' || base.value === '') return null;
  const hit = ctx.gatewayKeys.find((k) => base.value === k || base.value.startsWith(k));
  if (hit === undefined) return null;
  const route = gatewayRouteOf(ctx.gatewayRoutes[hit]);
  return {
    value: normalizeTail(`${route.to}${base.value.slice(hit.length)}`),
    from: 'declared', service: route.service, candidates: [],
  };
}

/**
 * 2. DERIVED. Either there is nothing to apply (no base URL: the path as
 * written IS the path), or the base URL is in the source and a proxy rule
 * explains what of it reaches the server.
 */
function derivedPrefix(ctx, base, pkg) {
  if (base.state === 'absent') return { value: '', from: 'derived', candidates: [] };
  if (base.state !== 'known' || base.ambiguous) return null;
  // A value that rests on a default or on a deployment's host is still READ
  // from the source, so it is derived; the guess it rests on goes with it.
  const guess = {
    ...(base.guess ? { guess: base.guess } : base.away ? { away: base.away } : {}),
    ...(base.modes ? { modes: base.modes } : {}), ...(base.unset ? { unset: base.unset } : {}),
  };
  if (base.absolute) return { value: base.value, from: 'derived', candidates: [], ...guess };
  const p = throughProxy(ctx, base.value, pkg);
  return p.ok ? { value: p.value, from: 'derived', candidates: [], ...guess } : null;
}

/**
 * 3. AUTO. Nothing states it, so every candidate is matched against the routes
 * this pack serves and the one that hits most wins. A guess, said so.
 */
function autoPrefix(ctx, base, pkg, instanceId) {
  const cands = new Set(['']);
  for (const v of base.values ?? []) {
    cands.add(normalizeTail(v));
    const p = throughProxy(ctx, normalizeTail(v), pkg);
    if (p.ok) cands.add(p.value);
  }
  const urls = ctx.callsPerInstance.get(instanceId) ?? [];
  const scored = [...cands].sort().map((value) => {
    let exact = 0;
    let template = 0;
    for (const u of urls) {
      const full = normalizeUrl(`${value}${u}`);
      if (ctx.exactPaths.has(full)) exact += 1;
      else if (ctx.templatePaths.some((r) => ctx.routeMatches(r, full))) template += 1;
    }
    return { value, exact, template };
  });
  scored.sort((a, b) => b.exact - a.exact || b.template - a.template || b.value.length - a.value.length || cmp(a.value, b.value));
  const winner = scored[0] ?? { value: '', exact: 0, template: 0 };
  return winner.exact + winner.template > 0
    ? { value: winner.value, from: 'auto', candidates: scored }
    : { value: '', from: 'none', candidates: scored };
}

/**
 * The prefix machinery for one run.
 *
 * `callsPerInstance` is filled by the call pass BEFORE the first prefix is
 * asked for, because the `auto` rule scores candidates against the URLs one
 * instance actually sends. That is the whole reason the call pass runs twice:
 * once to classify and collect, once to grade.
 *
 * @param {{instanceOf:Map, configFor:Function, gatewayRoutes:object,
 *          callsPerInstance:Map, exactPaths:Set<string>, templatePaths:string[],
 *          routeMatches:Function}} deps
 * @returns {{prefixOf:Function, gatewayKeys:string[]}}
 */
export function makePrefixes(deps) {
  // Longest key first, so `/api/customer` wins over `/api` on a call that
  // starts with both, and by name after that, so two runs choose the same one.
  const gatewayKeys = Object.keys(deps.gatewayRoutes)
    .filter((k) => k !== '*')
    .sort((a, b) => b.length - a.length || cmp(a, b));
  const ctx = { ...deps, gatewayKeys };
  const prefixCache = new Map();

  const prefixOf = (instanceId) => {
    if (prefixCache.has(instanceId)) return prefixCache.get(instanceId);
    const inst = ctx.instanceOf.get(instanceId) ?? { id: instanceId, module: null, baseURL: null, package: '' };
    const pkg = inst.package ?? '';
    const written = inst.baseURL ?? ctx.configFor(pkg).axiosBaseUrl ?? null;
    // A base URL written as a NAME is read where the name is declared
    // (base_url.mjs makeBaseReader); the client's own file is the one before
    // the `#` of its id.
    const named = inst.baseURL && ctx.readBaseName
      ? ctx.readBaseName(inst.id.slice(0, inst.id.lastIndexOf('#')), inst.baseURL) : null;
    const base = baseUrlValue(ctx, named ? named.summary : written, pkg, named ? named.assumed : false);
    const out = declaredPrefix(ctx, base)
      ?? derivedPrefix(ctx, base, pkg)
      ?? autoPrefix(ctx, base, pkg, instanceId);
    // WHAT THE BROWSER SENDS, kept beside what the server answers. `value` is
    // the prefix that reaches the SERVER; `front` is the one on the address bar,
    // which is what a HAR recording holds (src/adapters/har_bridge.mjs). They
    // are the same string only when no dev-server proxy rewrote anything.
    out.front = base.state === 'known' ? base.value : '';
    // WHICH BUILD GAVE WHICH VALUE, for a base URL with a default or a
    // condition in it: the edge has to say whether the literal was used.
    if (base.reads) out.reads = base.reads;
    prefixCache.set(instanceId, out);
    return out;
  };

  return { prefixOf, gatewayKeys };
}

/**
 * The prefix census, per package: what every instance ended up with and how it
 * got there. This is what a reader checks a wrong prefix against, so the
 * candidates an `auto` decision weighed are kept beside the winner.
 */
export function prefixCensus({ instanceOf, prefixOf, stats }) {
  for (const inst of [...instanceOf.values()].sort((a, b) => cmp(a.id, b.id))) {
    const p = prefixOf(inst.id);
    const pkg = inst.package ?? '';
    if (!stats.prefix[pkg]) stats.prefix[pkg] = { instances: [] };
    stats.prefix[pkg].instances.push({
      id: inst.id, value: p.value, from: p.from, front: p.front ?? '',
      // Only when a declared route named one: an instance whose prefix nobody
      // declared has no service to name, and an always-present null would read
      // as "we looked and found nothing".
      ...(p.service ? { service: p.service } : {}),
      // Only when the value rests on one (base_url.mjs WEB_BASE_GUESS).
      ...(p.guess ? { guess: p.guess } : {}),
      candidates: p.from === 'auto' ? p.candidates : [],
    });
  }
}
