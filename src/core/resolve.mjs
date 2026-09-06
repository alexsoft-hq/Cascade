// resolve.mjs — "which project am I talking about?" (SPEC §15 M1).
//
// Every command that reads a pack must answer this the same way, or the CLI, the
// MCP server and the viewer end up describing different projects from the same
// flags. One resolver, one priority order:
//
//   1. --pack <dir>      an explicit pack directory wins over everything
//   2. --project <id>    looked up in ~/.cascade/registry.json (§5)
//   3. --root <dir>      that directory's `.cascade/`
//   4. cwd               the current directory's `.cascade/`
//
// Removing ROOT-relative path joining in favour of this resolver is the point of
// M1: nothing downstream is allowed to guess an output location from cwd.
//
// Pure: the registry read arrives injected (`readRegistry`), so the priority
// order and the error texts are unit-testable without a home directory.

import path from 'node:path';
import { registryPath } from './paths.mjs';
import { readRegistry as readRegistryFs, findProject, projectIds } from './registry.mjs';

/**
 * Resolve the project a command should act on.
 *
 * @param {{
 *   pack?:string, project?:string, root?:string,
 *   cwd?:string, env?:NodeJS.ProcessEnv,
 *   readRegistry?: (file:string) => {projects:Object[]}
 * }} opts
 * @returns {{packDir:string, dotCascade:(string|null), source:('pack-flag'|'registry'|'root'|'cwd'), projectId:(string|null)}}
 */
export function resolveProject(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const readRegistry = opts.readRegistry ?? readRegistryFs;

  if (isGiven(opts.pack)) {
    // An explicit pack directory: the caller has said exactly what to read, so
    // no `.cascade/` is implied and nothing is registered off the back of it.
    return { packDir: path.resolve(cwd, opts.pack), dotCascade: null, source: 'pack-flag', projectId: null };
  }

  if (isGiven(opts.project)) {
    const file = registryPath(env);
    const reg = readRegistry(file);
    const entry = findProject(reg, opts.project);
    if (!entry) {
      const ids = projectIds(reg);
      throw new ResolveError(
        ids.length === 0
          ? `unknown project ${JSON.stringify(opts.project)}: the registry at ${file} is empty. Run \`cascade init\` in the project root first (it registers the project), or pass --pack <dir>`
          : `unknown project ${JSON.stringify(opts.project)}: registered ids are ${ids.join(', ')} (registry ${file})`,
      );
    }
    const dot = path.resolve(entry.dotCascadePath);
    return { packDir: path.join(dot, 'pack'), dotCascade: dot, source: 'registry', projectId: entry.id };
  }

  if (isGiven(opts.root)) {
    const dot = path.resolve(cwd, opts.root, '.cascade');
    return { packDir: path.join(dot, 'pack'), dotCascade: dot, source: 'root', projectId: null };
  }

  const dot = path.resolve(cwd, '.cascade');
  return { packDir: path.join(dot, 'pack'), dotCascade: dot, source: 'cwd', projectId: null };
}

/**
 * Whether an analyze run that wrote its pack into `outDir` belongs to a project
 * that may be registered — i.e. the output landed inside the resolved
 * `.cascade/`. A bare `--out /somewhere/else` is a one-off build and registers
 * nothing, so the registry never points at a directory that is not project state.
 *
 * @param {{dotCascade:(string|null), projectId:(string|null)}} resolved
 * @param {string} outDir
 * @param {string} [cwd]
 * @returns {{dotCascade:string, projectId:(string|null)}|null}
 */
export function registrationTarget(resolved, outDir, cwd = process.cwd()) {
  if (!resolved || typeof resolved.dotCascade !== 'string' || resolved.dotCascade.length === 0) return null;
  if (typeof outDir !== 'string' || outDir.length === 0) return null;
  const dot = path.resolve(resolved.dotCascade);
  const out = path.resolve(cwd, outDir);
  if (out !== dot && !out.startsWith(dot + path.sep)) return null;
  return { dotCascade: dot, projectId: resolved.projectId ?? null };
}

function isGiven(v) {
  return typeof v === 'string' && v.length > 0;
}

export class ResolveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResolveError';
  }
}
