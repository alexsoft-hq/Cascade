// snapshot_export.mjs — the one place a snapshot file is written from, for the page and the shell.
//
// `cascade view` answers the Export button at POST /api/export, and `cascade
// export` writes the same file from the command line. Both come here: the
// project is resolved by the same host, the tools are asked through the same
// dispatcher, and src/viewer/snapshot.mjs turns the answers into the file. What
// this module adds is only what that pure module must not know: where the
// viewer's files are on disk, which version of the engine is running, and what
// time it is.

import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot, snapshotFilename, snapshotHtml, snapshotQueryFromArgs } from '../viewer/snapshot.mjs';
import { ENGINE_ROOT } from './env.mjs';

/** The engine's own name and version, as a snapshot records who wrote it. */
export function engineIdentity(root = ENGINE_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { name: pkg.name, version: pkg.version };
}

/**
 * What `/api/meta` answers for one served project, so the page reads the same
 * masthead in the file as on the screen.
 */
export function projectMeta(host, project) {
  const { projectId } = host.resolveProjectArg(project ? { project } : {});
  const ctx = host.ctxFor(projectId);
  const pack = ctx.packJson;
  const repoRoot = pack.meta?.base?.repoPath ?? null;
  return {
    project: ctx.basis.project, projectId, digest: pack.digest, lanes: pack.meta?.lanes ?? null,
    builtAt: ctx.basis.builtAt, freshness: ctx.basis.freshness, base: pack.meta?.base ?? null,
    canSource: !!repoRoot, projects: host.list().map((p) => p.id),
  };
}

/** The viewer's files, read from this engine's own tree. */
function viewerAssets(root) {
  return {
    html: fs.readFileSync(path.join(root, 'viewer', 'index.html'), 'utf8'),
    readScript: (name) => fs.readFileSync(path.join(root, 'viewer', 'js', path.basename(name)), 'utf8'),
    readLib: (name) => fs.readFileSync(path.join(root, 'src', 'viewer', `${path.basename(name)}.mjs`), 'utf8'),
    readFont: (name) => fs.readFileSync(path.join(root, 'viewer', 'vendor', 'fonts', path.basename(name))),
    catalogs: Object.fromEntries(fs.readdirSync(path.join(root, 'viewer', 'i18n'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f.slice(0, -'.json'.length), JSON.parse(fs.readFileSync(path.join(root, 'viewer', 'i18n', f), 'utf8'))])),
  };
}

/**
 * One snapshot file for one question about one served project.
 *
 * @param {object} host  the project host `cascade view` and `cascade export` both build
 * @param {{project?:string, tab:string, args:object, lang?:string, generatedAt?:string, root?:string}} request
 * @returns {{html:string, filename:string, bytes:number, snapshot:object}}
 */
export function exportSnapshot(host, { project, tab, args, lang = 'en', generatedAt = new Date().toISOString(), root = ENGINE_ROOT }) {
  const query = snapshotQueryFromArgs(tab, args);
  const meta = projectMeta(host, project);
  const projectId = meta.projectId;
  const listed = host.callTool('projects', {}).answer.projects.find((p) => p.id === projectId) ?? { id: projectId };
  const assets = viewerAssets(root);
  const snapshot = buildSnapshot({
    query, project: listed, meta, lang, catalogs: assets.catalogs, generatedAt, engine: engineIdentity(root),
    callTool: (name, a) => host.callTool(name, { ...a, project: projectId }),
  });
  const title = `Cascade snapshot: ${projectId}, ${query.tab} from ${query.entry.value}`;
  const html = snapshotHtml({ html: assets.html, snapshot, title, readScript: assets.readScript, readLib: assets.readLib, readFont: assets.readFont });
  return { html, filename: snapshotFilename(projectId, query), bytes: Buffer.byteLength(html, 'utf8'), snapshot };
}
