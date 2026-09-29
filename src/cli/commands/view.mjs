// view.mjs — `cascade view`: the web viewer, over the SAME tool catalog and the
// SAME project host as `mcp`.
//
// No reimplemented queries and no second idea of which projects exist. The page
// itself shows ONE project: it passes `?project=<id>` through to the API, and
// without it a multi-project server answers `ambiguous` rather than picking one.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { toolList } from '../../mcp/catalog.mjs';
import { builtinRegistry } from '../../core/rules/registry.mjs';
import { rulesCatalog } from '../../core/rules/catalog.mjs';
import { exampleVerdicts } from '../rule_examples.mjs';
import { serveHttp } from '../../mcp/http.mjs';
import { readSourceFor, sourceRootsOf } from '../../viewer/source.mjs';
import { exportSnapshot, projectMeta } from '../snapshot_export.mjs';
import { ENGINE_ROOT } from '../env.mjs';

// `cli` rather than `ctx`, because the tool context below is called `ctx` too
// and they are different things: this one is the command line, that one is a
// loaded project.
export function run(cli) {
  const { opt } = cli;
  const host = cli.servedHost('view');
  const served = host.list();
  const html = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8');
  // The mark, read once and answered by name at /cascade-mark.svg (and its
  // dark-ground variant at /cascade-mark-dark.svg). The page inlines the light
  // geometry, so these routes exist for everything OUTSIDE the page that wants
  // the file itself.
  const mark = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'cascade-mark.svg'), 'utf8');
  const markDark = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'cascade-mark-dark.svg'), 'utf8');
  const port = Number(opt('port', '4319'));
  serveHttp({ http, port, deps: viewerDeps(host), html, mark, markDark }).then(({ port: p }) => {
    process.stderr.write(`cascade viewer at http://127.0.0.1:${p}/  serving ${served.length} project(s) [${served.map((x) => x.id).join(', ')}], `
      + `budget ${(host.budgetBytes / (1024 * 1024)).toFixed(0)} MB of pack JSON\n`);
    if (served.length > 1) {
      process.stderr.write(`the page shows ONE project: open http://127.0.0.1:${p}/?project=${served[0].id} (or another id above). `
        + 'Without it the API answers `ambiguous`\n');
    }
  });
}

/**
 * Whether each rule's examples hold, run once per server through the same
 * workers `cascade rules test` uses: the packs are part of the engine, so the
 * answer cannot change while this process runs.
 */
function examplesOnce() {
  let examples = null;
  return () => { examples ??= exampleVerdicts(builtinRegistry()); return examples; };
}

/**
 * What the server is allowed to answer with: the tool catalog, the one project
 * host, and the four directories it may read a file out of. Nothing else on
 * disk is reachable through any route.
 */
function viewerDeps(host) {
  const contextOf = (project) => {
    const { projectId } = host.resolveProjectArg(project ? { project } : {});
    return { projectId, ctx: host.ctxFor(projectId) };
  };
  return {
    toolList,
    callTool: (name, args) => host.callTool(name, args),
    meta: (project) => projectMeta(host, project),
    // The rule packs, where each left its mark here, and whether their examples hold.
    rules: (project) => rulesCatalog(builtinRegistry(), contextOf(project).ctx.graph),
    ruleExamples: examplesOnce(),
    // The Export button: one answer, written as a file that opens anywhere.
    exportSnapshot: (request) => exportSnapshot(host, request),
    // The two vendored MIT browser bundles the Graph tab's map renderers load
    // (viewer/vendor — see NOTICE). Served from THIS directory only; nothing
    // else on disk is reachable through /vendor.
    vendorDir: path.join(ENGINE_ROOT, 'viewer', 'vendor'),
    // The page's own scripts. They are classic scripts sharing one global scope,
    // loaded in the numbered order their names give them; splitting them out of
    // the HTML is what lets a stack trace name a file and a linter read them.
    viewerJsDir: path.join(ENGINE_ROOT, 'viewer', 'js'),
    // ...and the two modules the page shares with the engine, served from the
    // engine's own source minus its `export ` keywords. One file, not a copy.
    viewerLibDir: path.join(ENGINE_ROOT, 'src', 'viewer'),
    // The translation catalogues (SPEC §17.11). English is compiled into the
    // page; every other language is a JSON file fetched on demand from here,
    // which is why no non-English text lives in the page or in src/.
    i18nDir: path.join(ENGINE_ROOT, 'viewer', 'i18n'),
    // Live source preview, read from the working tree on demand (real-time).
    source: (nodeId, project, opts) => sourcePreview(contextOf(project), nodeId, opts),
  };
}

/**
 * One node's source, read from the working tree the pack was built from. A pack
 * that records no repository path has no preview to give, and says so as a
 * structured 404 rather than a blank panel.
 */
function sourcePreview({ projectId, ctx }, nodeId, opts) {
  const repoRoot = ctx.packJson.meta?.base?.repoPath ?? null;
  if (!repoRoot) {
    const e = new Error(`source preview not available for ${projectId} (its pack records no repository path)`);
    e.code = 'unknown-key';
    throw e;
  }
  return readSourceFor(ctx.graph, repoRoot, nodeId, diskSourceIo(ctx.packJson.meta, opts));
}

/**
 * What the source pane reads a pack's files with: the disk, and only under the
 * roots the pack records as analyzed (the project root, and a frontend passed
 * with --web-src beside it among them), with every link followed before a file
 * is opened.
 */
export function diskSourceIo(meta, opts) {
  return {
    readFile: (f) => fs.readFileSync(f, 'utf8'),
    realPath: (f) => fs.realpathSync.native(f),
    roots: sourceRootsOf(meta),
    ddlPath: meta?.ddl,
    whole: !!(opts && opts.whole),
  };
}
