// mcp.mjs — `cascade mcp`: the MCP server over stdio (SPEC §13).
//
// It serves ONE OR MANY projects: `--pack`/`--root` pick a single pack,
// `--project a --project b` picks registry entries, and with no flag at all
// every registered project is served. Packs are LAZY — nothing is parsed until a
// tool asks a project a question — and the loaded ones live in an LRU under
// `--memory-budget` MB (§17.6). The host itself is built in `src/cli/serve.mjs`,
// which `view` calls too.

import { toolList } from '../../mcp/catalog.mjs';
import { serve } from '../../mcp/stdio.mjs';

export function run(ctx) {
  const host = ctx.servedHost('mcp');
  const served = host.list();
  process.stderr.write(`cascade mcp: serving ${served.length} project(s) [${served.map((p) => p.id).join(', ')}]: `
    + `packs load on first use, budget ${(host.budgetBytes / (1024 * 1024)).toFixed(0)} MB of pack JSON\n`);
  if (served.length > 1) process.stderr.write('more than one project: every tool call must name one (`project`), or it is answered with `ambiguous`. Call `projects` to list them\n');
  serve({ deps: { toolList, callTool: (name, args) => host.callTool(name, args) } })
    .then(() => process.exit(0));
}
