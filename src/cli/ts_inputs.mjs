// ts_inputs.mjs — what the TypeScript backend bridge reads besides the source: the module paths a tsconfig maps, and the schema.prisma.
//
// Neither is cached with the source's facts. Every file's imports mean what the
// tsconfig says, and every Prisma call means what the schema says, so both are
// read again on every run and handed to the bridge whole
// (src/adapters/ts_bridge.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { readPrismaSchema } from '../adapters/ts/prisma_schema.mjs';

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

/**
 * The `baseUrl` and `paths` a tsconfig means, following its `extends` chain:
 * the nearest file's own value wins, a `paths` target is relative to the
 * `baseUrl` of the file that sets it, or to that file when it sets none.
 * Root-relative, posix.
 */
export function readTsconfigPaths(rootAbs, appRootAbs) {
  const first = tsconfigFileOf(rootAbs, appRootAbs);
  const out = { file: first ? toPosix(path.relative(rootAbs, first)) : null, baseUrl: null, paths: {} };
  const seen = new Set();
  for (let file = first; file && !seen.has(file) && seen.size < MAX_EXTENDS;) {
    seen.add(file);
    let cfg;
    try { cfg = readLenientJson(fs.readFileSync(file, 'utf8')); } catch { break; }
    const dir = path.dirname(file);
    const co = cfg.compilerOptions ?? {};
    const base = typeof co.baseUrl === 'string' ? path.resolve(dir, co.baseUrl) : null;
    if (out.baseUrl === null && base) out.baseUrl = toPosix(path.relative(rootAbs, base)) || '.';
    for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
      if (Object.hasOwn(out.paths, pattern) || !Array.isArray(targets)) continue;
      out.paths[pattern] = targets.map((t) => toPosix(path.relative(rootAbs, path.resolve(base ?? dir, t))));
    }
    file = typeof cfg.extends === 'string' && cfg.extends.startsWith('.') ? path.resolve(dir, cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`) : null;
  }
  return out;
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
  };
}
