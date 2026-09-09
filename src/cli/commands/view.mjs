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
import { serveHttp } from '../../mcp/http.mjs';
import { readSourceFor } from '../../viewer/source.mjs';
import { ENGINE_ROOT } from '../env.mjs';

// `cli` rather than `ctx`, because the tool context below is called `ctx` too
// and they are different things: this one is the command line, that one is a
// loaded project.
export function run(cli) {
  const { opt } = cli;
  const host = cli.servedHost('view');
  const served = host.list();
  const contextOf = (project) => {
    const { projectId } = host.resolveProjectArg(project ? { project } : {});
    return { projectId, ctx: host.ctxFor(projectId) };
  };
  const html = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8');
  // The mark, read once and answered by name at /cascade-mark.svg (and its
  // dark-ground variant at /cascade-mark-dark.svg). The page inlines the light
  // geometry, so these routes exist for everything OUTSIDE the page that wants
  // the file itself.
  const mark = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'cascade-mark.svg'), 'utf8');
  const markDark = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'cascade-mark-dark.svg'), 'utf8');
  const deps = {
    toolList,
    callTool: (name, args) => host.callTool(name, args),
    meta: (project) => {
      const { projectId, ctx } = contextOf(project);
      const pack = ctx.packJson;
      const repoRoot = pack.meta?.base?.repoPath ?? null;
      return {
        project: ctx.basis.project, projectId, digest: pack.digest, lanes: pack.meta?.lanes ?? null,
        builtAt: ctx.basis.builtAt, freshness: ctx.basis.freshness, base: pack.meta?.base ?? null,
        canSource: !!repoRoot, projects: served.map((p) => p.id),
      };
    },
    // The two vendored MIT browser bundles the Graph tab's map renderers load
    // (viewer/vendor — see NOTICE). Served from THIS directory only; nothing
    // else on disk is reachable through /vendor.
    vendorDir: path.join(ENGINE_ROOT, 'viewer', 'vendor'),
    // The translation catalogues (SPEC §17.11). English is compiled into the
    // page; every other language is a JSON file fetched on demand from here,
    // which is why no non-English text lives in the page or in src/.
    i18nDir: path.join(ENGINE_ROOT, 'viewer', 'i18n'),
    // Live source preview, read from the working tree on demand (real-time).
    // A pack that records no repository path has no preview to give, and says
    // so as a structured 404 rather than a blank panel.
    source: (nodeId, project, opts) => {
      const { projectId, ctx } = contextOf(project);
      const repoRoot = ctx.packJson.meta?.base?.repoPath ?? null;
      if (!repoRoot) {
        const e = new Error(`source preview not available for ${projectId} (its pack records no repository path)`);
        e.code = 'unknown-key';
        throw e;
      }
      return readSourceFor(ctx.graph, repoRoot, nodeId, {
        readFile: (f) => fs.readFileSync(f, 'utf8'),
        ddlPath: ctx.packJson.meta?.ddl,
        whole: !!(opts && opts.whole),
      });
    },
  };
  const port = Number(opt('port', '4319'));
  serveHttp({ http, port, deps, html, mark, markDark }).then(({ port: p }) => {
    process.stderr.write(`cascade viewer at http://127.0.0.1:${p}/  serving ${served.length} project(s) [${served.map((x) => x.id).join(', ')}], `
      + `budget ${(host.budgetBytes / (1024 * 1024)).toFixed(0)} MB of pack JSON\n`);
    if (served.length > 1) {
      process.stderr.write(`the page shows ONE project: open http://127.0.0.1:${p}/?project=${served[0].id} (or another id above). `
        + 'Without it the API answers `ambiguous`\n');
    }
  });
}
