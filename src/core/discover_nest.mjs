// discover_nest.mjs — the NestJS application a tree holds, for `cascade init` to write as tsBackend.app.
//
// A package that depends on @nestjs/core holds a Nest application where one of
// its TypeScript files calls the bootstrap the nestjs rule pack names
// (`NestFactory.create`, src/core/rules/packs/nestjs.json). That file's
// directory is the application's root: the TypeScript lane reads it, and the
// tsconfig and schema.prisma are looked for from there upward.
//
// The walk only NOTES the files (discover.mjs never reads a file for its
// content while walking); which of them bootstraps an application is read after
// it, and only under a package that depends on @nestjs/core. A schema.prisma is
// noted the same way, for the database its datasource names.

import path from 'node:path';
import { builtinRegistry } from './rules/registry.mjs';

const NEST_CORE = '@nestjs/core';
const TEST_DIR = /(^|\/)(test|tests|e2e|__tests__)(\/|$)/;
const MAX_READS = 20000;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bootstrap call as the nestjs rule names it, written with or without type arguments. */
function bootstrapPattern() {
  const create = builtinRegistry().ofKind('ts.route-decorator')[0]?.compiled.app?.create;
  if (!create) return null;
  return new RegExp(`\\b${create.split('.').map(escapeRegExp).join('\\s*\\.\\s*')}\\s*[<(]`);
}

/**
 * A `.ts` source or a schema.prisma the walk passes: noted for the reading
 * after it. Never finishes a file's classification.
 */
export function noteTypeScriptBackendFile(d, f) {
  const { name, absFile, rel } = f;
  if (name === 'schema.prisma') d.prismaSchemas.push(rel(absFile));
  if (!name.endsWith('.ts') || name.endsWith('.d.ts') || /\.(spec|test)\.ts$/.test(name)) return false;
  const r = rel(absFile);
  if (!TEST_DIR.test(r)) d.tsFiles.push(r);
  return false;
}

/**
 * The database each schema.prisma's datasource names (`provider = "postgresql"`),
 * sorted by path. The bridge reads the whole schema (src/adapters/ts/prisma_schema.mjs);
 * `cascade init` needs only this one word, to write the SQL dialect.
 */
export function prismaProvidersOf(d) {
  return [...d.prismaSchemas].sort().map((file) => {
    const text = d.read(path.join(d.root, file));
    const block = text === null ? null : /datasource\s+\w+\s*\{([^}]*)\}/.exec(text);
    const provider = block ? /provider\s*=\s*"([^"]+)"/.exec(block[1]) : null;
    return { path: file, provider: provider ? provider[1] : null };
  });
}

/**
 * A package.json that depends on @nestjs/core, with the schema.prisma its own
 * `prisma.schema` names (Prisma's documented place for a schema that is not at
 * `prisma/schema.prisma`), root-relative.
 */
export function noteNestPackage(d, { relFile, deps, pkg }) {
  if (!Object.hasOwn(deps, NEST_CORE)) return;
  const dir = path.posix.dirname(relFile);
  const schema = typeof pkg?.prisma?.schema === 'string' && pkg.prisma.schema !== '' ? path.posix.normalize(path.posix.join(dir, pkg.prisma.schema)) : null;
  d.nestPackages.push({ path: relFile, dir, prismaSchema: schema });
}

const under = (file, dir) => dir === '.' || file.startsWith(`${dir}/`);

/**
 * Every Nest application the tree holds: the directory of each file under a
 * @nestjs/core package that calls the bootstrap, with that file and the
 * package's declared schema. Sorted by root.
 *
 * @param {{nestPackages:object[], tsFiles:string[], read:Function, root:string, diagnostics:object[]}} d
 * @returns {{root:string, bootstrap:string, package:string, prismaSchema:(string|null)}[]}
 */
export function nestAppsOf(d) {
  const pattern = d.nestPackages.length > 0 ? bootstrapPattern() : null;
  if (!pattern) return [];
  const candidates = d.tsFiles.filter((f) => d.nestPackages.some((p) => under(f, p.dir))).sort();
  if (candidates.length > MAX_READS) {
    d.diagnostics.push({ kind: 'DISCOVERY_CAPPED', severity: 'warn', path: '.', reason: `${candidates.length} TypeScript files sit under a @nestjs/core package and only the first ${MAX_READS} were read for the bootstrap; name the application with --ts-src` });
  }
  const apps = new Map();
  for (const file of candidates.slice(0, MAX_READS)) {
    const text = d.read(path.join(d.root, file));
    if (text === null || !pattern.test(text)) continue;
    const root = path.posix.dirname(file);
    if (apps.has(root)) continue;
    // The nearest package: a workspace's own package.json over the monorepo's.
    const pkg = d.nestPackages.filter((p) => under(file, p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
    apps.set(root, { root, bootstrap: file, package: pkg.path, prismaSchema: pkg.prismaSchema });
  }
  return [...apps.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}
