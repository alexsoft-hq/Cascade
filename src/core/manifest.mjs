// manifest.mjs — project identity (SPEC §6.1).
//
// `manifest.json` declares who the project is: its id, the repositories that
// make it up (each pinned to a full commit), and a reference to the profile.
//
// SPEC invariants honored here:
//  - §5 multi-repo identity: each repository `path` is resolved RELATIVE TO THE
//    MANIFEST FILE'S OWN DIRECTORY. This is what lets `.cascade/manifest.json`
//    (which lives beside the manifest) point at source repos wherever they are —
//    a sibling folder, a monorepo subdir, a nested git checkout.
//  - §2.1 determinism: `manifestDigest` is computed over content that EXCLUDES
//    all paths (absolute and relative), the profileRef, and the file location,
//    so the digest is identical on any machine. Paths, profileRef and file live
//    on the returned object but never enter the digest.
//  - Commits MUST be full 40-hex SHAs — branch names and short SHAs are rejected,
//    because the whole analysis is pinned to an exact blob (§2.1, §5.1).

import { sha256 } from './canonical.mjs';
import path from 'node:path';
import fs from 'node:fs';

export const MANIFEST_SCHEMA = 'cascade:manifest:1';

// A project id / repo key names directories and graph ids; keep it filesystem-
// and id-safe. Same shape as the storage-model project id (SPEC §5).
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// Accepted repo kinds (SPEC §6.1). Additive: extend here, never silently accept.
// `unknown` is the honest answer for a repository whose stack discovery could
// not name (SPEC §7.3: nothing is silently ignored) — it is listed, not dropped.
export const REPO_KINDS = Object.freeze(['backend-java', 'frontend-web', 'shared-web', 'backend-kotlin', 'unknown']);

/**
 * Read, parse, validate and normalize a `manifest.json`.
 * @param {string} manifestFilePath  absolute or cwd-relative path to manifest.json
 * @returns {{schema:string, project:string, repositories:{key:string,path:string,commit:string,kind:string,absPath:string}[], profileRef:string, manifestDigest:string, file:string}}
 */
export function loadManifest(manifestFilePath) {
  if (typeof manifestFilePath !== 'string' || manifestFilePath.length === 0) {
    throw new ManifestError('manifestFilePath must be a non-empty string');
  }
  let raw;
  try {
    raw = fs.readFileSync(manifestFilePath, 'utf8');
  } catch (e) {
    throw new ManifestError(`cannot read manifest at ${manifestFilePath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new ManifestError(`manifest at ${manifestFilePath} is not valid JSON: ${e.message}`);
  }
  const normalized = validateManifest(obj, manifestFilePath);
  return { ...normalized, file: manifestFilePath };
}

/**
 * Validate an already-parsed manifest object and return a normalized form. Pure:
 * no filesystem I/O (path.resolve/dirname are pure), so it is unit-testable
 * without touching disk. `loadManifest` uses this and then attaches `file`.
 *
 * @param {unknown} obj  the parsed manifest
 * @param {string} manifestFilePath  used ONLY to resolve each repo path relative
 *   to the manifest's own directory (§5) — never enters the digest (§2.1)
 * @returns {{schema:string, project:string, repositories:{key:string,path:string,commit:string,kind:string,absPath:string}[], profileRef:string, manifestDigest:string}}
 */
export function validateManifest(obj, manifestFilePath) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ManifestError('manifest must be a JSON object');
  }
  if (obj.schema !== MANIFEST_SCHEMA) {
    throw new ManifestError(`manifest.schema must be ${JSON.stringify(MANIFEST_SCHEMA)}, got ${JSON.stringify(obj.schema)}`);
  }
  if (typeof obj.project !== 'string' || !NAME_RE.test(obj.project)) {
    throw new ManifestError(`manifest.project must be a non-empty string matching ${NAME_RE}, got ${JSON.stringify(obj.project)}`);
  }
  if (!Array.isArray(obj.repositories) || obj.repositories.length === 0) {
    throw new ManifestError('manifest.repositories must be a non-empty array');
  }
  if (typeof obj.profile !== 'string' || obj.profile.length === 0) {
    throw new ManifestError(`manifest.profile must be a non-empty string (the profile reference), got ${JSON.stringify(obj.profile)}`);
  }

  const baseDir = path.dirname(manifestFilePath);
  const seenKeys = new Set();
  const repositories = obj.repositories.map((repo, i) => {
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
      throw new ManifestError(`manifest.repositories[${i}] must be an object`);
    }
    if (typeof repo.key !== 'string' || repo.key.length === 0) {
      throw new ManifestError(`manifest.repositories[${i}].key must be a non-empty string`);
    }
    if (seenKeys.has(repo.key)) {
      throw new ManifestError(`manifest.repositories: duplicate key ${JSON.stringify(repo.key)} (keys must be unique)`);
    }
    seenKeys.add(repo.key);
    if (typeof repo.path !== 'string' || repo.path.length === 0) {
      throw new ManifestError(`manifest.repositories[${i}] (${repo.key}).path must be a non-empty string`);
    }
    if (typeof repo.commit !== 'string' || !FULL_SHA_RE.test(repo.commit)) {
      throw new ManifestError(
        `manifest.repositories[${i}] (${repo.key}).commit must be a full 40-hex commit SHA (branch names and short SHAs are rejected), got ${JSON.stringify(repo.commit)}`,
      );
    }
    if (!REPO_KINDS.includes(repo.kind)) {
      throw new ManifestError(
        `manifest.repositories[${i}] (${repo.key}).kind must be one of ${REPO_KINDS.join('|')}, got ${JSON.stringify(repo.kind)}`,
      );
    }
    return {
      key: repo.key,
      path: repo.path,
      commit: repo.commit,
      kind: repo.kind,
      // §5: relative to the MANIFEST'S directory, not cwd.
      absPath: path.resolve(baseDir, repo.path),
    };
  });

  // §2.1: digest over content only — no paths (absolute or relative), no
  // profileRef, no file location — so it is machine-independent.
  const manifestDigest = sha256({
    schema: obj.schema,
    project: obj.project,
    repositories: repositories.map((r) => ({ key: r.key, commit: r.commit, kind: r.kind })),
  });

  return {
    schema: obj.schema,
    project: obj.project,
    repositories,
    profileRef: obj.profile,
    manifestDigest,
  };
}

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}
