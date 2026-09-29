// ts_inputs.mjs — what the TypeScript backend bridge reads besides the source: the module paths a tsconfig maps, and the schema.prisma.
//
// Neither is cached with the source's facts. Every file's imports mean what the
// tsconfig says, and every Prisma call means what the schema says, so both are
// read again on every run and handed to the bridge whole
// (src/adapters/ts_bridge.mjs). The same module paths tell the run which files
// outside the application its imports reach (`tsReachResolver`).
//
// `cascade analyze` and the working-tree overlay both take the lane's runners
// and the bridge's options from here (`tsLaneRunners`, `tsLaneOptions`), so an
// overlay reads the same files, follows the same imports and hands the bridge
// the same options as the run that built its base pack.

import fs from 'node:fs';
import path from 'node:path';
import { isReadablePath } from '../../adapters/ts/tsfacts.mjs';
import { readPrismaSchema } from '../adapters/ts/prisma_schema.mjs';
import { makeModuleResolver } from '../adapters/ts/project.mjs';
import { ProfileError } from '../core/profile.mjs';
import { builtinRegistry } from '../core/rules/registry.mjs';
import { runTsLane } from './lanes_run.mjs';

const toPosix = (p) => p.split(path.sep).join('/');
const TSCONFIG_NAMES = Object.freeze(['tsconfig.app.json', 'tsconfig.build.json', 'tsconfig.json']);
const MAX_EXTENDS = 16;

/**
 * JSON as a tsconfig writes it: comments and trailing commas allowed. Strings
 * are walked past whole, so a `//` inside a path is not taken for a comment.
 */
export function readLenientJson(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      if (!m) break;
      out += m[0];
      i += m[0].length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The nearest tsconfig at or above the app root, up to the analyzed root. */
function tsconfigFileOf(rootAbs, appRootAbs) {
  for (let dir = appRootAbs; dir.startsWith(rootAbs); dir = path.dirname(dir)) {
    for (const name of TSCONFIG_NAMES) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) return f;
    }
    if (dir === rootAbs) break;
  }
  return null;
}

/** Each tsconfig of the `extends` chain from `first`, nearest first, with the directory it sits in. */
function tsconfigChain(first) {
  const chain = [];
  const seen = new Set();
  for (let file = first; file && !seen.has(file) && seen.size < MAX_EXTENDS;) {
    seen.add(file);
    const dir = path.dirname(file);
    let cfg;
    // A file that is not there or does not parse sets nothing, and is still one the lane looked at.
    try { cfg = readLenientJson(fs.readFileSync(file, 'utf8')); } catch { chain.push({ file, dir, co: {} }); break; }
    chain.push({ file, dir, co: cfg.compilerOptions ?? {} });
    file = typeof cfg.extends === 'string' && cfg.extends.startsWith('.') ? path.resolve(dir, cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`) : null;
  }
  return chain;
}

/**
 * The `baseUrl` and `paths` a tsconfig means, as the compiler reads its
 * `extends` chain: each option is the nearest file's that sets it, whole (a
 * child's `paths` replaces its parent's, it is not merged into it), and a
 * `paths` target is relative to that `baseUrl`, wherever in the chain it was
 * set, or, with none, to the file that sets `paths`. Root-relative, posix.
 */
export function readTsconfigPaths(rootAbs, appRootAbs) {
  const first = tsconfigFileOf(rootAbs, appRootAbs);
  const chain = tsconfigChain(first);
  const withBase = chain.find((c) => typeof c.co.baseUrl === 'string');
  const base = withBase ? path.resolve(withBase.dir, withBase.co.baseUrl) : null;
  const withPaths = chain.find((c) => c.co.paths && typeof c.co.paths === 'object');
  const paths = {};
  for (const [pattern, targets] of Object.entries(withPaths?.co.paths ?? {})) {
    if (Array.isArray(targets)) paths[pattern] = targets.map((t) => toPosix(path.relative(rootAbs, path.resolve(base ?? withPaths.dir, t))));
  }
  return { file: first ? toPosix(path.relative(rootAbs, first)) : null, baseUrl: base ? toPosix(path.relative(rootAbs, base)) || '.' : null, paths };
}

/** The schema.prisma that belongs to the app: the profile's, else `prisma/schema.prisma` at or above the app root. */
export function prismaSchemaFileOf(rootAbs, appRootAbs, declared) {
  if (declared) return fs.existsSync(declared) ? declared : null;
  for (let dir = appRootAbs; dir.startsWith(rootAbs); dir = path.dirname(dir)) {
    const f = path.join(dir, 'prisma', 'schema.prisma');
    if (fs.existsSync(f)) return f;
    if (dir === rootAbs) break;
  }
  return null;
}

/**
 * The TypeScript bridge's options for one app: its module paths, and its
 * Prisma schema when it has one.
 */
export function tsBridgeOptions({ rootAbs, appRootAbs, declaredSchema = null, sqlArgs }) {
  const tsconfig = readTsconfigPaths(rootAbs, appRootAbs);
  const schemaFile = prismaSchemaFileOf(rootAbs, appRootAbs, declaredSchema);
  return {
    tsconfig: { baseUrl: tsconfig.baseUrl, paths: tsconfig.paths },
    tsconfigFile: tsconfig.file,
    prisma: schemaFile ? { schema: readPrismaSchema(fs.readFileSync(schemaFile, 'utf8')) } : null,
    prismaSchemaFile: schemaFile ? toPosix(path.relative(rootAbs, schemaFile)) : null,
    schemaName: sqlArgs.defaultSchema ?? null,
    identifierCase: sqlArgs.identifierCase,
    publishedOf: packagePublishing(rootAbs, appRootAbs),
  };
}

/** The nearest package.json at or above `dirAbs`, up to the analyzed root, or null. */
function packageFileOf(rootAbs, dirAbs) {
  for (let dir = dirAbs; dir.startsWith(rootAbs); dir = path.dirname(dir)) {
    const f = path.join(dir, 'package.json');
    if (fs.existsSync(f)) return f;
    if (dir === rootAbs) break;
  }
  return null;
}

/**
 * Whether code outside this tree may extend or implement a type a file
 * declares: `(file) => reason`, null when it may not. A type of the package
 * that holds the application, or of a package.json marked `"private": true`,
 * is used by nothing but this tree; any other package may be published, and a
 * class of whoever installs it is then one this engine never reads. Read on
 * every run, like the tsconfig; a file with no package.json above it in the
 * analyzed root is in no package to publish.
 */
export function packagePublishing(rootAbs, appRootAbs) {
  const appPackage = packageFileOf(rootAbs, appRootAbs);
  const memo = new Map();
  const verdictOf = (file) => {
    if (!file || file === appPackage) return null;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return `${toPosix(path.relative(rootAbs, file))} cannot be read, so whether its package is published is not known`; }
    return pkg && pkg.private === true ? null
      : `the package of ${toPosix(path.relative(rootAbs, file))}${pkg?.name ? ` (${pkg.name})` : ''} is not the application's and is not marked private, so it may be published and a class outside this tree may extend or implement the type`;
  };
  return (rel) => {
    const file = packageFileOf(rootAbs, path.dirname(path.join(rootAbs, rel)));
    if (!memo.has(file)) memo.set(file, verdictOf(file));
    return memo.get(file);
  };
}

/**
 * Whether a root-relative path is a file whose bytes are inside the analyzed
 * root: a link that leads out of it (`libs/linked -> ../../elsewhere`) is not,
 * whatever its path says.
 */
function fileInsideRoot(rootAbs) {
  let realRoot;
  try { realRoot = fs.realpathSync(rootAbs); } catch { realRoot = rootAbs; }
  return (rel) => {
    try {
      const real = fs.realpathSync(path.join(rootAbs, rel));
      return (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) && fs.statSync(real).isFile();
    } catch { return false; }
  };
}

/** Which root-relative files are test support, as the typescript rule pack says (typescript.test-support). */
function testSupport() {
  const rules = builtinRegistry().ofKind('ts.test-support');
  return (rel) => rules.some((r) => r.compiled.isTestSupport(rel));
}

/** Why a file the run found is not read: test support the application does not import, or bytes outside the analyzed root. */
const LEFT_OUT = Object.freeze({ test: 'test-support', outside: 'outside-root' });

/**
 * Where an import of the application leads while the run decides which files
 * to read: the bridge's own resolution (src/adapters/ts/project.mjs) over the
 * same tsconfig, so the file read for an import is the file the bridge takes it
 * to mean. Under the application's root a file is one the worker listed; outside
 * it, a source file whose bytes are inside the analyzed root and that a walk
 * would read (never node_modules, or a path or a link that leaves the root).
 *
 * Test support (the typescript pack's ts.test-support) is read when a file the
 * run reads IMPORTS it: the application runs what it imports, whatever the
 * directory is called (a `testing` feature). A re-export alone (a barrel's
 * `export * from './x.mock'`) does not make it the application's. A file the
 * resolution would have named and that is not read goes into `leftOut` with
 * why, so the bridge says it and does not take it for a package.
 *
 * @param {{rootAbs:string, appRootAbs:string, listed:string[], leftOut?:Map<string,string>}} a  `listed` root-relative
 * @returns {(fromFile:string, spec:string, kind?:string) => (string|null)} the root-relative file, or null for a package;
 *          `kind` is the record the specifier is written in, 'import' or 'export'
 */
export function tsReachResolver({ rootAbs, appRootAbs, listed, leftOut = new Map() }) {
  const tsconfig = readTsconfigPaths(rootAbs, appRootAbs);
  const paths = { baseUrl: tsconfig.baseUrl, paths: tsconfig.paths };
  const known = new Set(listed);
  const inside = fileInsideRoot(rootAbs);
  const readable = readableOutside(rootAbs, appRootAbs, inside);
  const forImport = makeModuleResolver((f) => known.has(f) || readable(f, false) || readable(f, true), paths);
  const forExport = makeModuleResolver((f) => known.has(f) || readable(f, false), paths);
  const there = makeModuleResolver((f) => isReadablePath(f) && fileThere(rootAbs, f), paths);
  return (fromFile, spec, kind = 'import') => {
    const hit = (kind === 'export' ? forExport : forImport)(fromFile, spec);
    const missed = hit ? null : there(fromFile, spec);
    if (missed && !known.has(missed)) leftOut.set(missed, inside(missed) ? LEFT_OUT.test : LEFT_OUT.outside);
    return hit;
  };
}

/**
 * Whether a file not listed may be read: `(file, test)`, a source file whose
 * bytes are inside the root that is test support (`test`), or that is not and
 * lies outside the application's root (a shared library's).
 */
function readableOutside(rootAbs, appRootAbs, inside) {
  const app = toPosix(path.relative(rootAbs, appRootAbs));
  const inApp = (f) => app === '' || f === app || f.startsWith(`${app}/`);
  const isTest = testSupport();
  return (f, test) => isReadablePath(f) && inside(f) && (test ? isTest(f) : !isTest(f) && !inApp(f));
}

/** Whether a root-relative path is a file, through any link. */
function fileThere(rootAbs, rel) {
  try { return fs.statSync(path.join(rootAbs, rel)).isFile(); } catch { return false; }
}

/**
 * THE TYPESCRIPT LANE'S WORKER INVOCATIONS, for `cascade analyze` and the
 * working-tree overlay alike (src/core/incremental.mjs runTsLaneWithShards is
 * handed them): the files a run over the application's root reads (none that
 * is test support or whose bytes are outside the root, unless the application
 * imports it: see tsReachResolver), the resolution its imports are followed
 * by, and those files read. `tsLeftOut()` names each file found and not listed,
 * with why, so the run says it rather than dropping it. `onRead` sees each
 * batch before the worker is handed it.
 *
 * @param {string} rootAbs  the analyzed root
 * @param {(string|null)} appRootAbs  the application's root, null with none
 * @param {{onRead?:(targets:string[])=>void}} [opts]
 */
export function tsLaneRunners(rootAbs, appRootAbs, { onRead = () => {} } = {}) {
  // The application's own files are read under the same two rules as a shared library's.
  const [inside, isTest] = [fileInsideRoot(rootAbs), testSupport()];
  const leftOut = new Map();
  const listable = (f) => {
    const why = !inside(f) ? LEFT_OUT.outside : isTest(f) ? LEFT_OUT.test : null;
    if (why) leftOut.set(f, why);
    return !why;
  };
  return {
    tsList: (roots) => runTsLane(rootAbs, roots, { list: true }).filter((r) => r.kind === 'sourceFile' && listable(r.file)).map((r) => r.file),
    tsResolver: (listed) => (appRootAbs ? tsReachResolver({ rootAbs, appRootAbs, listed, leftOut }) : null),
    tsLeftOut: () => [...leftOut].map(([file, why]) => ({ file, why })).sort((a, b) => (a.file < b.file ? -1 : 1)),
    ts: (targets) => {
      onRead(targets);
      return runTsLane(rootAbs, targets);
    },
  };
}

/**
 * What the profile's `tsBackend.typeorm` block declares, its naming strategy
 * checked against the strategies the typeorm rule pack names ("" is none
 * named, which the pack's default is). Null when it declares nothing.
 */
export function typeormDeclared(block) {
  if (!block || Object.values(block).every((v) => v == null)) return null;
  const name = block.namingStrategy ?? null;
  const known = builtinRegistry().ofKind('typeorm.entity').flatMap((e) => e.rule.params.strategies.map((s) => s.name));
  if (name !== null && name !== '' && !known.includes(name)) {
    throw new ProfileError(`profile.tsBackend.typeorm.namingStrategy must be null, "" or one of ${known.join(', ')} (the strategies the typeorm rule pack names), got ${JSON.stringify(name)}`);
  }
  return { namingStrategy: name, entityPrefix: block.entityPrefix ?? null, schema: block.schema ?? null, type: block.type ?? null };
}

/**
 * THE TYPESCRIPT BRIDGE'S OPTIONS, for `cascade analyze` and the working-tree
 * overlay alike, as javaLaneOptions and webLaneOptions are for theirs
 * (src/core/assemble.mjs): two callers that each wrote this list would drift
 * apart. It holds the application's tsconfig module paths and schema.prisma,
 * read from disk now; the global prefix and the TypeORM facts the profile
 * declares when the source only names them; and the SQL catalog the run read,
 * for schema.prisma to be read against. Null with no application.
 *
 * @param {{rootAbs:string, appRootAbs:(string|null), profile:(object|null), profileDir?:(string|null),
 *          sqlArgs:object, catalogRecords?:object[]}} a
 *        `profileDir` is the directory `tsBackend.prismaSchema` is relative to
 *        (the profile's own); the analyzed root when there is none
 * @param {object[]} [diagnostics]  where a declared schema that is not there is said
 */
export function tsLaneOptions({ rootAbs, appRootAbs, profile, profileDir = null, sqlArgs, catalogRecords = [] }, diagnostics = []) {
  if (!appRootAbs) return null;
  const ts = profile?.tsBackend ?? {};
  const declaredSchema = ts.prismaSchema ? path.resolve(profileDir ?? rootAbs, ts.prismaSchema) : null;
  const opts = tsBridgeOptions({ rootAbs, appRootAbs, declaredSchema, sqlArgs });
  if (declaredSchema && !opts.prisma) {
    diagnostics.push({ kind: 'MISSING_INPUT', severity: 'warn', key: 'tsBackend.prismaSchema', reason: `tsBackend.prismaSchema names ${ts.prismaSchema}, which is not there, so no Prisma call is read` });
  }
  return {
    ...opts, globalPrefix: ts.globalPrefix ?? null, globalPrefixExclude: ts.globalPrefixExclude ?? null,
    // The application's root, so its own files are told from those its imports reached elsewhere.
    typeorm: typeormDeclared(ts.typeorm), appRoot: toPosix(path.relative(rootAbs, appRootAbs)), catalogRecords,
  };
}

/**
 * THE FILES EVERY TYPESCRIPT FILE'S MEANING RESTS ON, root-relative: each
 * tsconfig of the chain the lane reads for the application, each name that
 * would take the nearest one's place, and the schema.prisma it read or would
 * find. None of them is cached: a run reads them again, and so does the
 * working-tree overlay, which says which of them it found changed.
 *
 * @param {string} rootAbs
 * @param {string} appRootAbs
 * @param {(string|null)} prismaSchemaFile  root-relative, the one the options read
 */
export function tsLaneInputFiles(rootAbs, appRootAbs, prismaSchemaFile) {
  const out = new Set(tsconfigChain(tsconfigFileOf(rootAbs, appRootAbs)).map((c) => toPosix(path.relative(rootAbs, c.file))));
  for (let dir = appRootAbs; dir.startsWith(rootAbs); dir = path.dirname(dir)) {
    for (const name of [...TSCONFIG_NAMES, path.join('prisma', 'schema.prisma')]) out.add(toPosix(path.relative(rootAbs, path.join(dir, name))));
    if (dir === rootAbs) break;
  }
  if (prismaSchemaFile) out.add(prismaSchemaFile);
  return [...out].sort();
}
