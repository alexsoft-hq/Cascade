// registry.mjs — the home registry, `~/.cascade/registry.json` (SPEC §5).
//
// The home tier knows exactly one thing: "where is what". Each entry names a
// project id and the `.cascade/` directory that holds its durable state, plus
// how the entry got there and when the project was last certified.
//
//   { "schema": "cascade:registry:1",
//     "projects": [ { "id", "dotCascadePath", "source", "stack", "lastCertifiedAt" } ] }
//
// SPEC rules honored here:
//  - §18.1: the file declares its schema; an unknown one is REFUSED, never
//    read on a guess and never silently reset (losing a user's project list to
//    a parse error would be a silent data loss).
//  - §5: one `.cascade/` directory is one project. Two different directories
//    claiming the same id is a conflict the user must resolve (or force).
//
// Pure except for two filesystem functions, kept obviously apart at the bottom:
// `readRegistry` (read) and `writeRegistryAtomic` (the ONE writer).

import fs from 'node:fs';
import path from 'node:path';

export const REGISTRY_SCHEMA = 'cascade:registry:1';

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A registry with no projects.
 * @returns {{schema:string, projects:[]}}
 */
export function emptyRegistry() {
  return { schema: REGISTRY_SCHEMA, projects: [] };
}

/**
 * Validate an already-parsed registry object and return a normalized copy
 * (entries sorted by id). Pure.
 * @param {unknown} obj
 * @param {string} [origin]  a path used only in error messages
 * @returns {{schema:string, projects:Object[]}}
 */
export function validateRegistry(obj, origin = '<memory>') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new RegistryError(`registry at ${origin} must be a JSON object`);
  }
  if (obj.schema !== REGISTRY_SCHEMA) {
    throw new RegistryError(
      `registry at ${origin} declares schema ${JSON.stringify(obj.schema)}, expected ${JSON.stringify(REGISTRY_SCHEMA)}. Refusing to read it (a newer or foreign registry is never guessed at, and never overwritten)`,
    );
  }
  if (!Array.isArray(obj.projects)) {
    throw new RegistryError(`registry at ${origin}: "projects" must be an array`);
  }
  const projects = obj.projects.map((p, i) => normalizeEntry(p, `${origin} projects[${i}]`));
  const seen = new Set();
  for (const p of projects) {
    if (seen.has(p.id)) throw new RegistryError(`registry at ${origin}: duplicate project id ${JSON.stringify(p.id)}`);
    seen.add(p.id);
  }
  return { schema: REGISTRY_SCHEMA, projects: sortById(projects) };
}

/**
 * Add or replace one project entry and return a NEW registry (the input is not
 * mutated). Entries come back sorted by id.
 *
 * Identity rules:
 *  - the same `dotCascadePath` (resolved) replaces the entry that holds it,
 *    whatever its id — one directory is one project;
 *  - a DIFFERENT directory claiming an id that is already taken is a conflict:
 *    `RegistryError` unless `force`, which then re-points the id.
 *
 * @param {{schema:string, projects:Object[]}} reg
 * @param {{id:string, dotCascadePath:string, source:string, stack?:string[], lastCertifiedAt?:(string|null)}} entry
 * @param {{force?:boolean}} [opts]
 * @returns {{schema:string, projects:Object[]}}
 */
export function upsertProject(reg, entry, opts = {}) {
  const current = validateRegistry(reg);
  const next = normalizeEntry(entry, 'upsertProject entry');
  const force = opts.force === true;

  const kept = [];
  for (const p of current.projects) {
    if (p.dotCascadePath === next.dotCascadePath) continue; // replaced below
    if (p.id === next.id) {
      if (!force) {
        throw new RegistryError(
          `ambiguous project id ${JSON.stringify(next.id)}: it is already registered at ${p.dotCascadePath}, but ${next.dotCascadePath} claims it too. Choose another id (--project <id>) or re-point the existing one with --force`,
        );
      }
      continue; // forced: the new path takes the id
    }
    kept.push(p);
  }
  kept.push(next);
  return { schema: REGISTRY_SCHEMA, projects: sortById(kept) };
}

/**
 * The entry for a project id, or null.
 * @param {{projects:Object[]}} reg
 * @param {string} id
 * @returns {Object|null}
 */
export function findProject(reg, id) {
  if (!reg || !Array.isArray(reg.projects)) return null;
  return reg.projects.find((p) => p.id === id) ?? null;
}

/**
 * All registered ids, sorted.
 * @param {{projects:Object[]}} reg
 * @returns {string[]}
 */
export function projectIds(reg) {
  if (!reg || !Array.isArray(reg.projects)) return [];
  return reg.projects.map((p) => p.id).sort();
}

function normalizeEntry(p, origin) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new RegistryError(`${origin} must be an object`);
  }
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) {
    throw new RegistryError(`${origin}.id must match ${ID_RE}, got ${JSON.stringify(p.id)}`);
  }
  if (typeof p.dotCascadePath !== 'string' || p.dotCascadePath.length === 0) {
    throw new RegistryError(`${origin}.dotCascadePath must be a non-empty string`);
  }
  if (typeof p.source !== 'string' || p.source.length === 0) {
    throw new RegistryError(`${origin}.source must be a non-empty string (e.g. "init" or "analyze")`);
  }
  const stack = p.stack ?? [];
  if (!Array.isArray(stack) || stack.some((s) => typeof s !== 'string')) {
    throw new RegistryError(`${origin}.stack must be an array of strings`);
  }
  const lastCertifiedAt = p.lastCertifiedAt ?? null;
  if (lastCertifiedAt !== null && typeof lastCertifiedAt !== 'string') {
    throw new RegistryError(`${origin}.lastCertifiedAt must be null or a string`);
  }
  return {
    id: p.id,
    dotCascadePath: path.resolve(p.dotCascadePath),
    source: p.source,
    stack: stack.slice(),
    lastCertifiedAt,
  };
}

function sortById(projects) {
  return projects.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Filesystem edge. Everything above is pure.
// ---------------------------------------------------------------------------

/**
 * Read and validate the registry file. A MISSING file is normal (nothing has
 * been registered yet) and yields an empty registry; anything else — unreadable,
 * malformed, unknown schema — throws, so a broken registry is never silently
 * replaced by an empty one.
 * @param {string} file
 * @returns {{schema:string, projects:Object[]}}
 */
export function readRegistry(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new RegistryError('readRegistry needs a file path');
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyRegistry();
    throw new RegistryError(`cannot read registry at ${file}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new RegistryError(`registry at ${file} is not valid JSON: ${e.message}. Fix or remove it by hand. It is never reset automatically`);
  }
  return validateRegistry(obj, file);
}

/**
 * FILESYSTEM-WRITING export (the only one). Write the registry atomically:
 * mkdir -p the home dir, write a sibling temp file, rename over the target — so
 * a crash mid-write can never leave a half-written registry.
 * @param {string} file
 * @param {{schema:string, projects:Object[]}} reg
 * @returns {string} the file written
 */
export function writeRegistryAtomic(file, reg) {
  const validated = validateRegistry(reg, file);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryError';
  }
}
