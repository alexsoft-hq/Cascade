// nest_app.mjs — what a NestJS bootstrap says about every route's address: which application is served, its global prefix and what that excludes, and its versioning.
//
// The application is the one the bootstrap creates and then `listen`s on
// (ghostfolio makes a first one only to read its configuration and closes it).
// Its settings are calls on it (`app.setGlobalPrefix('api')`), read in the
// bootstrap and in every function of the project it is handed to
// (`configure(app)`), under the name that function's parameter gives it.
//
// A SETTING IS KNOWN ONLY WHEN IT IS SURE. One call that may not run (under a
// condition, in a callback), two that disagree, a call of that name on
// something that is not the application, or the application handed to code
// this engine does not read: each leaves the setting unknown, with the reason,
// and no route's address is made of an unknown. The names these calls go by
// are the rule's (src/core/rules/packs/nestjs.json).

import { versionsOf } from '../../core/rules/kinds/ts_route_decorator.mjs';
import { patternRegex } from './route_pattern.mjs';
import { constantEvaluator } from './static_constants.mjs';

const MAX_SITES = 64;

/** Calls of one member. */
export function callsIn(project, file, where) {
  return project.calls.filter((c) => c.file === file && c.in === where);
}

/**
 * The application the bootstrap serves: the `create` call whose holder then
 * calls `listen`. With one `create` and no `listen` seen, that one.
 */
function servedApp(project, app, diagnostics) {
  const creates = project.calls.filter((c) => c.callee === app.create);
  const served = creates.filter((c) => c.holder && callsIn(project, c.file, c.in).some((x) => x.callee === `${c.holder}.${app.listen}`));
  const pick = served.length === 1 ? served[0] : creates.length === 1 ? creates[0] : null;
  if (!pick) diagnostics.push({ kind: 'TS_APP_NOT_FOUND', reason: creates.length === 0 ? `no call of ${app.create} was found, so no controller is known to be served` : `${creates.length} calls of ${app.create} and ${served.length} of them listen: which application serves is not decided, so no route is made` });
  return pick;
}

/** The function of the project a call hands the application to, with the name it takes there; 'package' for a package's; null when not known. */
function handedTo(project, file, call, at) {
  const head = call.callee.split('.')[0];
  const m = project.meaning(file, head);
  if (m?.external) return 'package';
  if (!m || call.callee.includes('.')) return null;
  const holder = project.files.get(m.file)?.functions.get(m.name)?.params?.[at];
  return holder ? { file: m.file, in: m.name, holder } : null;
}

/**
 * Where the application is configured: the bootstrap member, and each function
 * of the project it is handed to. `unread` says where it was handed to code
 * whose settings are not known.
 */
function configSites(project, boot) {
  if (!boot.holder) return { sites: [], unread: `${boot.file}:${boot.line}: the application is not held in a name, so the calls made on it are not known` };
  const sites = [{ file: boot.file, in: boot.in, holder: boot.holder }];
  const seen = new Set([`${boot.file}#${boot.in}#${boot.holder}`]);
  for (let i = 0; i < sites.length && sites.length <= MAX_SITES; i += 1) {
    const site = sites[i];
    for (const call of callsIn(project, site.file, site.in)) {
      const at = call.args.findIndex((a) => a.k === 'id' && a.v === site.holder);
      if (at < 0 || call.callee.startsWith(`${site.holder}.`)) continue;
      const next = handedTo(project, site.file, call, at);
      if (next === 'package') continue;
      if (!next) return { sites, unread: `${site.file}:${call.line}: the application is handed to ${call.callee}, which this engine does not read` };
      const key = `${next.file}#${next.in}#${next.holder}`;
      if (!seen.has(key)) { seen.add(key); sites.push(next); }
    }
  }
  return { sites, unread: null };
}

/** One setting (`setGlobalPrefix`): `{absent}`, `{args, call}` when it is sure, `{unread}` with the reason when not. */
function settingOf(project, found, name) {
  if (found.unread) return { unread: found.unread };
  const calls = [];
  for (const s of found.sites) {
    for (const c of callsIn(project, s.file, s.in)) {
      if (c.callee === `${s.holder}.${name}`) calls.push(c);
      else if (c.callee.endsWith(`.${name}`)) return { unread: `${c.file}:${c.line}: ${c.callee} is called on something that is not the served application` };
    }
  }
  if (calls.length === 0) return { absent: true };
  const maybe = calls.find((c) => c.cond);
  if (maybe) return { unread: `${maybe.file}:${maybe.line}: ${maybe.callee} may not run (it is under a condition, in a loop or in a callback)` };
  if (new Set(calls.map((c) => JSON.stringify(c.args))).size > 1) return { unread: `${name} is called ${calls.length} times with different arguments` };
  return { args: calls[0].args, call: calls[0] };
}

/** One `exclude` entry as a matcher: a path pattern, with the request method it names; null when not read. */
function excludeEntry(entry, app) {
  if (entry.k === 'str') {
    const test = patternRegex(entry.v);
    return test ? { test, verb: 'ANY' } : null;
  }
  if (entry.k !== 'obj' || entry.spread || entry.computed || entry.v.path?.k !== 'str') return null;
  const method = entry.v.method;
  const verb = method && method.k === 'member' ? app.requestMethods[method.v] : undefined;
  const test = patternRegex(entry.v.path.v);
  return test && verb ? { test, verb } : null;
}

/**
 * What a global prefix's `exclude` option names, as matchers, and how many of
 * its entries this engine cannot read: a route one of them names would be
 * served without the prefix, and which routes that is, is not known.
 */
function excludesOf(opts, app, resolved) {
  if (resolved?.known && Array.isArray(resolved.value)) {
    const read = resolved.value.map((v) => typeof v === 'string' ? excludeEntry({ k: 'str', v }, app) : null);
    return { matchers: read.filter(Boolean), unread: read.filter((m) => !m).length };
  }
  if (!opts) return { matchers: [], unread: 0 };
  // Options in a variable, or spread, may hold an exclude list of their own.
  const hidden = opts.k !== 'obj' || opts.spread || opts.computed ? 1 : 0;
  const list = opts.k === 'obj' ? opts.v.exclude : undefined;
  if (list === undefined) return { matchers: [], unread: hidden };
  if (list.k !== 'arr') return { matchers: [], unread: 1 };
  const read = list.v.map((e) => excludeEntry(e, app));
  return { matchers: read.filter(Boolean), unread: read.filter((m) => !m).length + (list.spread ? 1 : 0) + hidden };
}

/** The profile's `tsBackend.globalPrefixExclude`: path patterns, any method, all of them read or none. */
function declaredExcludes(patterns, notes) {
  const matchers = patterns.map((p) => ({ test: patternRegex(p), verb: 'ANY', pattern: p }));
  for (const m of matchers.filter((x) => !x.test)) notes.push({ kind: 'TS_PREFIX_EXCLUDE_UNREAD', reason: `the profile's tsBackend.globalPrefixExclude entry "${m.pattern}" uses route pattern syntax this engine does not read` });
  return { matchers: matchers.filter((m) => m.test), unread: matchers.filter((m) => !m.test).length };
}

/**
 * The global prefix and what it excludes. The profile's `tsBackend.globalPrefix`
 * and `globalPrefixExclude`, when it declares them, stand for the deployed values
 * the source only names; otherwise the bootstrap's literal, `''` when it sets
 * none. `{unread}` when the prefix is not known.
 */
function prefixOf(project, found, app, declared, notes) {
  const cfg = settingOf(project, found, app.globalPrefix);
  const [p, opts] = cfg.args ?? [];
  const written = cfg.absent ? '' : p && p.k === 'str' ? p.v : null;
  const prefix = declared.globalPrefix ?? written;
  if (prefix === null) return { unread: cfg.unread ?? 'the global prefix is not written as a literal' };
  if (declared.globalPrefix != null && written !== null && written !== declared.globalPrefix) {
    notes.push({ kind: 'TS_PREFIX_DECLARED', reason: `the profile's tsBackend.globalPrefix "${declared.globalPrefix}" is used, and the bootstrap sets "${written}"` });
  }
  const excludes = declared.globalPrefixExclude ? declaredExcludes(declared.globalPrefixExclude, notes)
    : cfg.unread ? { matchers: [], unread: 1 } : excludesOf(opts, app, constantExcludes(project, cfg.call));
  if (excludes.unread > 0 && prefix !== '') {
    notes.push({ kind: 'TS_PREFIX_EXCLUDE_UNREAD', reason: `the global prefix "${prefix}" excludes ${excludes.unread} route pattern(s) this engine cannot read; a route one of them names is served without the prefix, so every route under it is shown with the prefix and graded HEURISTIC. Declare the list as tsBackend.globalPrefixExclude in the profile to read it` });
  }
  return { prefix, matchers: excludes.matchers, unreadExcludes: excludes.unread };
}


function constantExcludes(project, call) {
  const opts = call?.staticArgs?.[1];
  return opts?.k === 'object' && opts.props.exclude
    ? constantEvaluator(project)(opts.props.exclude, call.file) : null;
}

/** URI versioning: `{uri:false}` when there is none, `{uri, prefix, defaultVersion}` when it is literal, `{unread}` when not. */
function versioningOf(project, found, app) {
  const cfg = settingOf(project, found, app.versioning);
  if (cfg.unread) return { unread: cfg.unread };
  if (cfg.absent) return { uri: false };
  const opts = cfg.args[0];
  const unread = { unread: 'the versioning options are not written as literals' };
  if (!opts || opts.k !== 'obj' || opts.spread || opts.computed) return unread;
  const type = opts.v.type;
  if (!type || type.k !== 'member') return unread;
  if (type.v !== app.uriType) return { uri: false };
  const defaultVersion = versionsOf(opts.v.defaultVersion, app.neutral);
  if (defaultVersion?.unread) return unread;
  const prefix = opts.v.prefix === undefined ? app.uriPrefix : opts.v.prefix.k === 'str' ? opts.v.prefix.v : null;
  return prefix === null ? unread : { uri: true, prefix, defaultVersion };
}

/**
 * THE SERVED APPLICATION: the `create` call that makes it, its global prefix
 * and versioning. `prefix` or `versioning` is `{unread}` when not known, and
 * every reason is in `diagnostics`.
 *
 * @param {{globalPrefix?:(string|null), globalPrefixExclude?:(string[]|null)}} declared  what the profile says the source cannot
 */
export function readApplication(project, app, declared, diagnostics) {
  const boot = servedApp(project, app, diagnostics);
  if (!boot) return null;
  const found = configSites(project, boot);
  const prefix = prefixOf(project, found, app, declared, diagnostics);
  const versioning = versioningOf(project, found, app);
  if (prefix.unread) diagnostics.push({ kind: 'TS_PREFIX_UNREAD', reason: `${prefix.unread}, so no route's address is known. Declare the deployed prefix as tsBackend.globalPrefix in the profile` });
  if (versioning.unread) diagnostics.push({ kind: 'TS_VERSIONING_UNREAD', reason: `${versioning.unread}, so no route's address is known` });
  return { boot, prefix, versioning };
}
