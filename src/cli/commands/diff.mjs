// diff.mjs — `cascade diff`: what changed between two packs of one project.
//
// The comparison is src/core/pack_diff.mjs; this is the shell around it. Two
// packs on disk in, the difference out, conditions first: a list of removed
// tables means nothing until the reader knows the catalog was read both times.

import fs from 'node:fs';
import path from 'node:path';
import { diffPacks } from '../../core/pack_diff.mjs';

/** A pack from a pack directory, a `.cascade/` directory or a pack.json path. */
function readPackAt(arg, { die }) {
  const abs = path.resolve(arg);
  const candidates = [abs, path.join(abs, 'pack.json'), path.join(abs, 'pack', 'pack.json'), path.join(abs, '.cascade', 'pack', 'pack.json')];
  const file = candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) die(`no pack at ${abs}: give a pack.json, the directory holding it, or a .cascade directory`);
  try { return { file, pack: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return die(`cannot read ${file}: ${e.message}`); }
}

const sign = (n, s) => (n > 0 ? `${s}${n}` : null);
const short = (d) => (d ? String(d).slice(0, 12) : '?');

/** The two identity lines and the conditions, before any count. */
function printHeader(out, d) {
  const side = (label, s) => `${label}  ${short(s.digest)}  ${s.project ?? '?'}  commit ${s.commit ? s.commit.slice(0, 10) : '?'}${s.dirty ? ' (dirty)' : ''}  built ${s.builtAt ?? '?'}\n`;
  out.write(side('base', d.base) + side('head', d.head));
  if (d.samePack) out.write('the two packs have the same digest: nothing in the graph changed\n');
  const c = d.conditions;
  out.write(`conditions: ${c.verdict === 'same' ? 'the same (lanes, identity rule, axes, workers, profile, engine, flags, roots)' : c.verdict}\n`);
  for (const x of c.differences) out.write(`  ${x.what}: ${x.base} -> ${x.head}\n`);
  for (const u of c.unknown) out.write(`  not recorded: ${u}\n`);
  if (c.verdict !== 'same') out.write('  so a difference below may come from the analysis rather than the code\n');
}

/** The counts, then the lists, each cut list named with its total. */
function printBody(out, d) {
  const byKind = Object.entries(d.nodes.byKind).map(([k, v]) => `${k} ${[sign(v.added, '+'), sign(v.removed, '-')].filter(Boolean).join('/')}`);
  out.write(`nodes: +${d.nodes.added} -${d.nodes.removed}${byKind.length ? `  (${byKind.join(', ')})` : ''}\n`);
  const byType = Object.entries(d.edges.byType).map(([k, v]) => `${k} ${[sign(v.added, '+'), sign(v.removed, '-'), sign(v.regraded, '~')].filter(Boolean).join('/')}`);
  out.write(`edges: +${d.edges.added} -${d.edges.removed} regraded ${d.edges.regraded}${byType.length ? `  (${byType.join(', ')})` : ''}\n`);
  out.write(`endpoints above the change: ${d.endpointsTouched.total}\n`);
  for (const id of d.endpointsTouched.ids) out.write(`  ${id.slice('endpoint:'.length)}\n`);
  out.write(`screens above the change: ${d.screensTouched.total}\n`);
  for (const id of d.screensTouched.ids) out.write(`  ${id.slice('screen:'.length)}\n`);
  const section = (title, rows) => { if (rows.length) out.write(`${title}\n${rows.map((r) => `  ${r}\n`).join('')}`); };
  section('added nodes', d.nodes.addedIds);
  section('removed nodes', d.nodes.removedIds.map((r) => (r.axisChanged ? `${r.id}  (the ${r.axisChanged} axis changed between the packs)` : r.id)));
  const edge = (e) => `${e.from} -> ${e.to}  ${e.type}${e.rule ? ` [${e.rule}]` : ''}`;
  section('added edges', d.edges.addedList.map((e) => `${edge(e)}  ${e.grade}`));
  section('removed edges', d.edges.removedList.map((e) => `${edge(e)}  ${e.grade}`));
  section('regraded edges', d.edges.regradedList.map((e) => `${edge(e)}  ${e.base} -> ${e.head}`));
  const cutLists = d.truncated.fields.filter((f) => f.nextOffset !== null);
  if (cutLists.length) out.write(`cut: ${cutLists.map((f) => `${f.field} ${f.shown} of ${f.total}`).join(', ')} (raise --limit, or --json)\n`);
}

export function run(cli) {
  const { opt, flag, die, resolveOrDie } = cli;
  const baseArg = opt('base');
  if (!baseArg) die('name the pack to compare against: --base <pack dir | pack.json | .cascade dir>');
  const base = readPackAt(baseArg, cli);
  const head = opt('head') ? readPackAt(opt('head'), cli) : readPackAt(resolveOrDie().packDir, cli);
  const rawLimit = opt('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) die(`--limit must be a positive whole number, got ${JSON.stringify(rawLimit)}`);
  const d = diffPacks(base.pack, head.pack, { limit });
  if (flag('json')) { process.stdout.write(`${JSON.stringify(d, null, 2)}\n`); return; }
  printHeader(process.stdout, d);
  printBody(process.stdout, d);
}
