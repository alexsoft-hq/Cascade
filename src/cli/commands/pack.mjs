// pack.mjs — `cascade pack`: build a pack from SQL-lane output alone.
//
// The low-level entry: a catalog JSONL and a lineage JSONL in, a pack out. It
// is what `analyze` does at the end of a run, with none of the run — useful
// when the two files were produced somewhere else, and the only way to build a
// pack without a project.

import fs from 'node:fs';
import path from 'node:path';
import { buildGraphFromSql } from '../../adapters/sql_bridge.mjs';
import { projectPack } from '../../core/pack.mjs';
import { resolveProject } from '../../core/resolve.mjs';
import { jsonl, manifestAt, projectIdFrom } from '../env.mjs';

export function run(ctx) {
  const { opt, die } = ctx;
  const catalog = opt('catalog'); const lineage = opt('lineage'); const out = opt('out', '.cascade/pack');
  if (!catalog || !lineage) die('usage: cascade pack --catalog <f> --lineage <f> --out <dir> [--project NAME]');
  const g = buildGraphFromSql(jsonl(catalog), jsonl(lineage));
  // The same identity rule `analyze` uses (SPEC §5.1). A pack built next to a
  // project's `.cascade/` belongs to that project whether or not --project was
  // typed; with no manifest to read, the flag is all there is, and with neither
  // the pack says it does not know rather than calling itself "project".
  const packResolved = resolveProject({ cwd: process.cwd(), env: process.env });
  const packProject = projectIdFrom(packResolved.projectId, manifestAt(packResolved.dotCascade)?.project, opt('project'));
  const pack = projectPack(g, { project: packProject, builtAt: new Date().toISOString() });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'pack.json');
  fs.writeFileSync(file, JSON.stringify(pack));
  process.stderr.write(`wrote ${file}: ${pack.counts.nodes} nodes, ${pack.counts.edges} edges, digest ${pack.digest}\n`);
  process.exit(0);
}
