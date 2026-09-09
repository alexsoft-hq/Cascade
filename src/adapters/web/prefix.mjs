// prefix.mjs — what a frontend's URL is missing, and how we know.
//
// WHAT THIS MODULE OWNS. A frontend writes `client.get('/things/list')` and the
// server serves `/api/things/list`. The difference is the PREFIX, and there are
// four ways to know it, in this order:
//   declared     the profile's `gatewayRoutes` says which front-end prefix maps
//                onto which back-end one, and which service answers it
//   derived      the base URL is in the source (a literal, an env value, an
//                absolute address) and a dev-server proxy rule explains what of
//                it reaches the server
//   auto         nothing states it, so every candidate is matched against the
//                routes this pack serves and the one that hits most wins. A
//                guess, and every edge through it is HEURISTIC
//   none         no candidate matched anything, so the URL is used as written
// Plus the fifth, which needs no candidate at all: a SERVER-RENDERED page writes
// its paths from the application root, so its prefix is the empty string.
//
// It also owns the package table those rules read from — which directory each
// file belongs to, and what that package's `.env` files, proxy rules and path
// aliases say.
//
// WHAT IT MUST NEVER KNOW ABOUT: the fact stream's calls, the screens, the
// graph. It is handed the routes this pack serves as two plain collections and
// a match function, because the `auto` rule has to SCORE candidates against
// them, and it looks at nothing else.

import { gatewayRouteOf } from '../../core/profile.mjs';
import { cmp, configDirOf, normalizePosix, normalizeUrl } from './shared.mjs';
import { sortKey } from './symbols.mjs';

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

/** A base URL or a proxy context with one leading slash and no trailing one. */
export function normalizeTail(v) {
  let s = String(v ?? '').trim();
  if (s === '' || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * An absolute address read down to its PATH, or a relative value left alone.
 * The host rides along when there was one, because the caller has to know
 * whether a proxy rule still applies.
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
  const packageDirs = new Set();
  for (const p of opts.packages ?? []) {
    // discovery names the package.json, and the package is the directory it sits in.
    if (p && typeof p.path === 'string') packageDirs.add(configDirOf(normalizePosix(p.path)));
  }
  for (const c of configs) packageDirs.add(configDirOf(c.file));
  if (packageDirs.size === 0) packageDirs.add('');
  const sortedPackages = [...packageDirs].sort((a, b) => b.length - a.length || cmp(a, b));
  const packageOf = (file) => {
    for (const d of sortedPackages) {
      if (d === '' || file === d || file.startsWith(`${d}/`)) return d;
    }
    return '';
  };
  const pkgConfig = new Map();
  const configFor = (dir) => {
    let c = pkgConfig.get(dir);
    if (!c) { c = { env: new Map(), proxies: [], aliases: [], axiosBaseUrl: null }; pkgConfig.set(dir, c); }
    return c;
  };
  for (const d of packageDirs) configFor(d);
  for (const c of configs.slice().sort((a, b) => cmp(sortKey(a), sortKey(b)))) {
    const dir = configDirOf(c.file);
    const cfg = configFor(packageDirs.has(dir) ? dir : packageOf(c.file));
    if (c.what === 'env') {
      if (!cfg.env.has(c.name)) cfg.env.set(c.name, []);
      cfg.env.get(c.name).push({ value: c.value, mode: c.mode ?? null, file: c.file });
    } else if (c.what === 'proxy') cfg.proxies.push(c);
    else if (c.what === 'alias') cfg.aliases.push(c);
    else if (c.what === 'axios-defaults' && c.key === 'baseURL') cfg.axiosBaseUrl = c.value ?? null;
  }
  for (const cfg of pkgConfig.values()) {
    // The longest context first: `/api/v2` must win over `/api`.
    cfg.proxies.sort((a, b) => b.context.length - a.context.length || cmp(a.context, b.context));
    cfg.aliases.sort((a, b) => b.from.length - a.from.length || cmp(a.from, b.from));
  }
  return { packageDirs, packageOf, configFor };
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
 * ONE env name read across every mode the project declares.
 *
 * The modes DISAGREE more often than not. Two shapes, both measured on the
 * frontends this round was built against:
 *
 *   - `/dev-api`, `/prod-api` and `/stage-api` for the same variable: three
 *     real prefixes, and exactly one of them has a dev-proxy rule explaining
 *     it. That one is the one this analysis can follow to a route, so it wins.
 *   - a relative path for development and two absolute addresses for the two
 *     deployments, all three ending in the SAME path. Compared as strings
 *     those disagree; compared as PATHS they are one value, which is what
 *     they are. So the comparison is on paths.
 *
 * Only when neither settles it is the answer ambiguous, and the auto step
 * takes over.
 */
function envValue(ctx, pkg, name) {
  const cfg = ctx.configFor(pkg);
  const rows = cfg.env.get(name) ?? [];
  if (rows.length === 0) return { value: null, values: [], ambiguous: false };
  const values = [...new Set(rows.map((r) => absoluteSplit(r.value).value))].sort();
  if (values.length === 1) return { value: values[0], values, ambiguous: false };
  const explained = values.filter((v) => v !== '' && cfg.proxies.some((p) => v === p.context || v.startsWith(p.context)));
  if (explained.length === 1) return { value: explained[0], values, ambiguous: false };
  const byMode = (m) => rows.find((r) => r.mode === m);
  const chosen = byMode(PREFERRED_MODE)
    ?? rows.slice().sort((a, b) => cmp(a.mode ?? '', b.mode ?? '') || cmp(a.file, b.file))[0];
  return { value: absoluteSplit(chosen.value).value, values, ambiguous: true };
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
 *   known    the value was read (a literal, an env value, an absolute address).
 *   unknown  a base URL IS declared and this lane could not read it: an env
 *            name with no .env record, a template with a hole in it, an
 *            expression. THAT is what the auto step exists for.
 */
function baseUrlValue(ctx, summary, pkg) {
  if (!summary) return { state: 'absent', value: '', values: [''], absolute: false, ambiguous: false };
  if (summary.kind === 'string') return absoluteSplit(summary.value);
  if (summary.kind === 'template' && (summary.dynamicParts ?? 0) === 0) return absoluteSplit(summary.template);
  if (summary.kind === 'member' && Array.isArray(summary.path) && summary.path.length >= 2
    && summary.path[0] === 'env' && (summary.root === 'process' || summary.root === 'import.meta')) {
    const e = envValue(ctx, pkg, summary.path[1]);
    if (e.value === null) return { state: 'unknown', value: '', values: [''], absolute: false, ambiguous: false };
    // `absolute` is false here even when the env value was an absolute
    // address: `envValue` already reduced every value to its PATH, so what
    // comes back is a path and the proxy rules apply to it like any other.
    return {
      state: 'known', value: e.value, values: e.values, absolute: false, ambiguous: e.ambiguous,
    };
  }
  return { state: 'unknown', value: '', values: [''], absolute: false, ambiguous: false };
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
  if (base.absolute) return { value: base.value, from: 'derived', candidates: [] };
  const p = throughProxy(ctx, base.value, pkg);
  return p.ok ? { value: p.value, from: 'derived', candidates: [] } : null;
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
    const summary = inst.baseURL ?? ctx.configFor(pkg).axiosBaseUrl ?? null;
    const base = baseUrlValue(ctx, summary, pkg);
    const out = declaredPrefix(ctx, base)
      ?? derivedPrefix(ctx, base, pkg)
      ?? autoPrefix(ctx, base, pkg, instanceId);
    // WHAT THE BROWSER SENDS, kept beside what the server answers. `value` is
    // the prefix that reaches the SERVER; `front` is the one on the address bar,
    // which is what a HAR recording holds (src/adapters/har_bridge.mjs). They
    // are the same string only when no dev-server proxy rewrote anything.
    out.front = base.state === 'known' ? base.value : '';
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
      candidates: p.from === 'auto' ? p.candidates : [],
    });
  }
}
