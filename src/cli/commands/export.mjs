// export.mjs — `cascade export`: one Flow or Impact answer, written as one HTML file.
//
// The file is the viewer's own page with the answer inside, so it opens in any
// browser with no Cascade and no network, and it draws the grades, the limits
// and the truncation notes the live page draws (src/viewer/snapshot.mjs). The
// viewer's Export button writes the same file for the same question.

import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_TABS } from '../../viewer/snapshot.mjs';
import { exportSnapshot } from '../snapshot_export.mjs';

/** The entry flags a tab accepts, in the order the tab's own entry box reads them. */
const ENTRY_FLAGS = Object.freeze(['endpoint', 'screen', 'symbol', 'table', 'column', 'statement']);

/** The question, read off the command line: exactly one entry for the tab. */
function questionOf({ opt, die }) {
  const tab = opt('tab', 'flow');
  const def = SNAPSHOT_TABS[tab];
  if (!def) die(`--tab must be ${Object.keys(SNAPSHOT_TABS).join(' or ')}, got ${JSON.stringify(tab)}`);
  const given = ENTRY_FLAGS.filter((k) => opt(k) !== undefined);
  if (given.length !== 1) {
    die(`name exactly one place the ${tab} picture starts from: ${def.kinds.map((k) => `--${k}`).join(', ')}`
      + (given.length > 1 ? ` (got ${given.map((k) => `--${k}`).join(' and ')})` : ''));
  }
  const kind = given[0];
  if (!def.kinds.includes(kind)) die(`the ${tab} tab does not start from --${kind}: use ${def.kinds.map((k) => `--${k}`).join(', ')}`);
  const args = { [kind]: opt(kind), mode: opt('mode'), depth: opt('depth'), limit: opt('limit') };
  if (def.direction === 'up') args.direction = 'up';
  return { tab, args };
}

export function run(cli) {
  const { opt, die } = cli;
  const { tab, args } = questionOf(cli);
  const lang = opt('lang', 'en');
  const format = opt('format', 'html');
  const host = cli.servedHost('export');
  let out;
  try {
    out = exportSnapshot(host, { project: opt('project'), tab, args, lang, format });
  } catch (e) {
    die(`${e.code ? `${e.code}: ` : ''}${e.message}`);
  }
  const file = path.resolve(opt('out', out.filename));
  fs.writeFileSync(file, out.format === 'svg' ? out.svg : out.html, 'utf8');
  printSummary(file, out);
}

/** What was written, and what the answer inside it is worth. */
function printSummary(file, out) {
  const flow = out.snapshot.calls.find((c) => c.name === 'flow').answer;
  const limits = Array.isArray(flow.limits) ? flow.limits.length : 0;
  const cut = flow.truncated && Array.isArray(flow.truncated.fields) ? flow.truncated.fields.filter((f) => f.shown < f.total).length : 0;
  process.stdout.write(`wrote ${file} (${out.bytes} bytes): ${out.snapshot.tab} from ${out.snapshot.entry.kind} ${out.snapshot.entry.value}, `
    + `mode ${out.snapshot.args.mode}, depth ${out.snapshot.args.depth}, limit ${out.snapshot.args.limit}\n`);
  process.stdout.write(`trust ${flow.trust?.trustLevel ?? 'unknown'}, ${limits} limit(s), ${cut} cut list(s). The file carries all of them, `
    + (out.format === 'svg' ? 'and is one picture a document can hold\n' : 'and opens in a browser with no server\n'));
}
