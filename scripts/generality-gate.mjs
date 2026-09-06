#!/usr/bin/env node
// generality-gate.mjs — run the engine, UNCHANGED and with no per-project
// configuration, over a pinned corpus of real repositories it was not written
// against, and print what it reached.
//
// WHY THIS IS IN THE REPOSITORY. The engine's own tests prove that each rule
// does what it says on a fixture chosen to exercise it. They cannot tell you
// whether the SET of rules adds up to something that works on a repository
// nobody here has read. That question has one honest answer — run it and count —
// and the answer is only worth anything if it is REPEATABLE: the same commits,
// the same flags, the same numbers, so a change that quietly loses a DAO layer
// shows up as a smaller number rather than as nothing at all.
//
// So the corpus is PINNED to a sha, the run takes no per-project flags beyond
// what the table below records, and `test/generality_gate.test.mjs` compares the
// result against `test/fixtures/generality-gate.baseline.json` and fails when a
// repository reaches LESS than it did. A rise changes nothing until somebody
// runs `--accept`, which rewrites the baseline and prints the diff: a number
// that improves silently is a number nobody checked.
//
// WHAT IT IS NOT. It is not a benchmark and it is not a claim of correctness.
// "123 of 147 endpoints reach a statement" says the engine connected 123 chains;
// whether the 24 it did not have SQL behind them at all is a question only
// reading them answers, and the round that adds a repository to this table is
// the round that reads them.
//
// USAGE
//   node scripts/generality-gate.mjs --fetch          clone/checkout every pin, then run
//   node scripts/generality-gate.mjs --fetch --no-run clone only
//   node scripts/generality-gate.mjs                  run over whatever is cloned
//   node scripts/generality-gate.mjs --only ruoyi-vue,litemall
//   node scripts/generality-gate.mjs --json out.json  also write the raw JSON
//   node scripts/generality-gate.mjs --accept         rewrite the pinned baseline
//
// The clones live in `$XDG_CACHE_HOME/cascade/gate/<id>` (about 1 GB in all),
// a frontend that has a repository of its own in `<id>-front` beside it —
// never inside this repository — and `CASCADE_GATE_DIR` points somewhere else.
// Each run gets its own `CASCADE_HOME` under that directory, so the gate never
// writes to the registry the user's own projects are in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { TRUST_LEVELS } from '../src/core/trust.mjs';

export const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

/** Where the baseline the regression test reads lives. */
export const BASELINE_FILE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'generality-gate.baseline.json');

/** The baseline file's schema id, so a shape change cannot be read as a drop. */
export const GATE_SCHEMA = 'cascade:generality-gate:1';

/**
 * THE CORPUS, PINNED.
 *
 * `ddl` records the ONLY per-project input the gate is allowed to give: the DDL
 * files, when the engine's own classification would pick the wrong set. `null`
 * means the run passes no lane flag at all, which is the point — every entry
 * that stays null is a repository the engine read with nothing configured.
 *
 * `front` names a FRONTEND THAT LIVES IN ITS OWN REPOSITORY, pinned the same
 * way: the product is the two halves together, and measuring the backend alone
 * says nothing about whether a screen reaches a column. It is a second clone
 * and one flag (`--web-src`), not a configuration: an entry whose frontend sits
 * inside the backend repository needs neither, and its `note` says so.
 *
 * Nothing else may be added here. A rule that needs a project named in this
 * table is a rule that does not generalise, and belongs in the engine as a
 * framework or language rule or not at all.
 */
export const CORPUS = Object.freeze([
  {
    id: 'ruoyi-vue', url: 'https://github.com/yangzongzhuan/RuoYi-Vue', sha: '13db1fcef36bee9ce45d2d636a1d4e8f5ed5bbc3', ddl: null,
    front: { url: 'https://github.com/yangzongzhuan/RuoYi-Vue3', sha: '838965c5a18d2c61b73ec30c6e288057aaa08b63', dir: 'src' },
    note: 'Spring MVC + MyBatis XML, with its Vue 3 frontend in a repository of its own',
  },
  { id: 'litemall', url: 'https://github.com/linlinjava/litemall', sha: 'a1ef964a718b7277925b19ea26afe78ea3a1d325', ddl: null, note: 'Spring MVC + MyBatis Generator; the frontend is inside this repository, so an unconfigured init declares the web pack and the run reads it with no flag' },
  { id: 'xxl-job', url: 'https://github.com/xuxueli/xxl-job', sha: 'e74c784f68f81fa89cb350913ef15794865d7b12', ddl: null, note: 'Spring MVC + MyBatis XML' },
  { id: 'jeepay', url: 'https://github.com/jeequan/jeepay', sha: 'ba37111934c9c04183cc6cbdbdafc7f38941fa4b', ddl: null, note: 'Spring MVC + MyBatis-Plus' },
  { id: 'petclinic-ms', url: 'https://github.com/spring-petclinic/spring-petclinic-microservices', sha: '3858f9c630cf989bb6809a86edf47c2be78dc9f1', ddl: null, note: 'Spring MVC + JPA, three schema.sql (one per service)' },
  { id: 'dolphinscheduler', url: 'https://github.com/apache/dolphinscheduler', sha: '499fd068640519aa88289401ad4edd1ae15930ac', ddl: null, note: 'Spring MVC + MyBatis-Plus + XML + @Select, 118 source roots, 19 DDL files' },
  {
    id: 'mall', url: 'https://github.com/macrozheng/mall', sha: '0504e86b1f1b6f1b8aa6a734d37a90fb67346be7', ddl: null,
    front: { url: 'https://github.com/macrozheng/mall-admin-web', sha: '81fc17e5a19f452bd854b106a9d59fa1ed5c7eac', dir: 'src' },
    note: 'Spring MVC + MyBatis Generator, the engine\'s oldest fixture, with its admin frontend in a repository of its own',
  },
  { id: 'jeecg-boot', url: 'https://github.com/jeecgboot/JeecgBoot', sha: '74364054449efd5852e46d0c10325a1d38c1006a', ddl: null, note: 'Spring MVC + MyBatis-Plus, multi-module, duplicated FQNs; the frontend is inside this repository, so an unconfigured init declares the web pack and the run reads it with no flag' },
  { id: 'jsh-erp', url: 'https://github.com/jishenghua/JSH_ERP', sha: 'ad6cf886dd4e0676723060a25d361c703dc56bc0', ddl: null, note: 'Spring MVC + MyBatis XML' },
  { id: 'spring-petclinic', url: 'https://github.com/spring-projects/spring-petclinic', sha: '818c4136ea971c21674525f9053de0d9c7ad8cfe', ddl: null, note: 'Spring MVC + JPA, single module' },
  { id: 'jpetstore-6', url: 'https://github.com/mybatis/jpetstore-6', sha: 'ebb36b392f0c0fdec10e2e7b364b03b88c08c184', ddl: null, note: 'Spring MVC + MyBatis XML, HSQLDB schema' },
]);

/**
 * The numbers the regression test guards. A drop in any is a failure.
 *
 * The last two are the screen end (RM32): how many of the frontend's own call
 * sites reached a route this pack serves, and how many screens reach a table
 * through them. They are guarded for the same reason as the three above — a
 * change that quietly stops following a frontend call would otherwise cost a
 * third of the round trip and show up as nothing at all.
 */
export const GUARDED = Object.freeze([
  'endpointsReachingAStatement', 'tablesReached', 'columnsReached',
  'webCallsResolved', 'screensReachingATable',
]);

/**
 * Where the clones live. NEVER inside this repository: a gigabyte of other
 * people's source has no business in a git working tree, and a stray `git add`
 * would commit it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function gateDir(env = process.env) {
  if (env.CASCADE_GATE_DIR) return path.resolve(env.CASCADE_GATE_DIR);
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'cascade', 'gate');
}

/** The checkout directory for one corpus entry. */
export function repoDir(entry, env = process.env) {
  return path.join(gateDir(env), entry.id);
}

/** The checkout directory for an entry's own frontend repository, when it has one. */
export function frontRepoDir(entry, env = process.env) {
  return entry.front ? path.join(gateDir(env), `${entry.id}-front`) : null;
}

/** Whether one directory is a clone sitting at exactly `sha`. */
function checkoutAt(dir, sha) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { present: false, head: null, why: `no clone at ${dir}` };
  let head = null;
  try {
    head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return { present: false, head: null, why: `${dir} has no readable HEAD: ${e.message.split('\n')[0]}` };
  }
  if (head !== sha) {
    return { present: false, head, why: `${dir} is at ${head.slice(0, 12)}, the corpus pins ${sha.slice(0, 12)}` };
  }
  return { present: true, head, why: null };
}

/**
 * Whether a corpus entry is cloned AT ITS PIN. A clone of some other commit is
 * NOT usable: the numbers below are a property of a commit, and comparing them
 * across two would be comparing two different programs.
 *
 * An entry with its own frontend repository needs BOTH halves at their pins. A
 * run with the backend and no frontend is not a smaller version of the same
 * measurement, it is a different one: every screen count would be zero, and a
 * baseline written from it would be a floor nobody could ever fail.
 *
 * @param {object} entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{present:boolean, why:(string|null), dir:string, head:(string|null),
 *            frontDir:(string|null), frontHead:(string|null)}}
 */
export function checkoutStatus(entry, env = process.env) {
  const dir = repoDir(entry, env);
  const frontDir = frontRepoDir(entry, env);
  const back = checkoutAt(dir, entry.sha);
  if (!back.present) return { present: false, dir, head: back.head, frontDir, frontHead: null, why: back.why };
  if (!frontDir) return { present: true, dir, head: back.head, frontDir: null, frontHead: null, why: null };
  const front = checkoutAt(frontDir, entry.front.sha);
  if (!front.present) {
    return { present: false, dir, head: back.head, frontDir, frontHead: front.head, why: `the frontend: ${front.why}` };
  }
  return { present: true, dir, head: back.head, frontDir, frontHead: front.head, why: null };
}

/** Clone (or move) one directory to one commit. Shallow: one commit, no history. */
function fetchInto(dir, url, sha) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (!fs.existsSync(path.join(dir, '.git'))) git(['init', '-q']);
  try { git(['remote', 'add', 'origin', url]); } catch { git(['remote', 'set-url', 'origin', url]); }
  git(['fetch', '-q', '--depth', '1', 'origin', sha]);
  git(['checkout', '-q', '-f', sha]);
  git(['clean', '-qfdx', '-e', '.cascade']);
}

/** Clone (or move) one corpus entry, and its own frontend when it has one, to their pins. */
export function fetchOne(entry, env = process.env, log = () => {}) {
  log(`  fetching ${entry.id} @ ${entry.sha.slice(0, 12)}…`);
  fetchInto(repoDir(entry, env), entry.url, entry.sha);
  if (!entry.front) return;
  log(`  fetching ${entry.id}'s frontend @ ${entry.front.sha.slice(0, 12)}…`);
  fetchInto(frontRepoDir(entry, env), entry.front.url, entry.front.sha);
}

/**
 * Run the engine over one checkout and measure what it reached.
 *
 * `init` writes the project's own profile from what discovery measured, and
 * `analyze` takes NO lane flag beyond the corpus's `ddl` entry. That is the
 * whole discipline of this script: whatever the engine cannot work out for
 * itself is a number this table will show as missing.
 *
 * @param {object} entry
 * @param {{env?:NodeJS.ProcessEnv, log?:(s:string)=>void}} [opts]
 * @returns {object} the per-repo measurement
 */
export function runOne(entry, opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const dir = repoDir(entry, env);
  const home = path.join(gateDir(env), '.home');
  const cache = path.join(gateDir(env), '.cache');
  fs.mkdirSync(home, { recursive: true });
  const childEnv = { ...env, CASCADE_HOME: home, XDG_CACHE_HOME: cache };
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, env: childEnv });

  // A previous run's state must not decide this one: the profile `init` writes
  // is part of what is being measured.
  fs.rmSync(path.join(dir, '.cascade'), { recursive: true, force: true });
  const project = `gate-${entry.id}`;
  const init = cli(['init', '--root', dir, '--project', project]);
  if (init.status !== 0) return { id: entry.id, sha: entry.sha, ok: false, error: `init failed: ${lastLines(init.stderr)}` };

  const ddlFlags = (entry.ddl ?? []).flatMap((f) => ['--ddl', path.join(dir, f)]);
  // The one flag a frontend in its own repository needs. It is not a
  // configuration: it says WHERE the other half of the product is checked out,
  // which no discovery over the backend's tree could ever work out.
  const webFlags = entry.front ? ['--web-src', path.join(frontRepoDir(entry, env), entry.front.dir)] : [];
  const t0 = Date.now();
  const run = cli(['analyze', '--root', dir, '--project', project, ...ddlFlags, ...webFlags]);
  const wallMs = Date.now() - t0;
  const packFile = path.join(dir, '.cascade', 'pack', 'pack.json');
  if (!fs.existsSync(packFile)) {
    return { id: entry.id, sha: entry.sha, ok: false, error: `analyze wrote no pack (status ${run.status}): ${lastLines(run.stderr)}` };
  }

  const packJson = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  const graph = loadPack(packJson, { verifyDigest: true });
  const ctx = {
    graph,
    basis: { project: entry.id, buildDigest: packJson.digest, builtAt: null, freshness: { verdict: 'unknown' } },
    // The lowest level the enum has: this reads a pack off disk, it certifies
    // nothing, and the name is taken from the module that owns it (§14.3).
    trust: { trustLevel: TRUST_LEVELS[0] },
    limits: [],
    pack: {
      project: entry.id, digest: packJson.digest, lanes: packJson.meta.lanes,
      axes: packJson.meta.axes, identifierCase: packJson.meta.identifierCase,
      laneStats: packJson.meta.laneStats,
    },
  };
  const o = callTool('overview', {}, ctx).answer;
  const r = o.reach;
  // The screen end. A backend-only entry has no `web` lane stats and no screens
  // block at all, and both read as zero here rather than as absent: a floor of
  // zero is exactly right for a measurement nothing was there to make.
  const web = packJson.meta.laneStats?.web ?? null;
  const screens = o.screens ?? null;
  const webCalls = web ? (web.calls?.withUrl ?? 0) : 0;
  const webCallsResolved = web ? ((web.resolved?.SOUND_SET ?? 0) + (web.resolved?.HEURISTIC ?? 0)) : 0;
  log(`  ${entry.id}: ${r.endpoints - r.endpointsWithoutStatement}/${r.endpoints} endpoints -> SQL, `
    + `${r.tablesReached}/${r.tables} tables, ${r.columnsReached}/${r.columns} columns, `
    + `${webCallsResolved}/${webCalls} web calls -> route, `
    + `${screens ? screens.reachingATable : 0}/${screens ? screens.screens : 0} screens -> table, `
    + `${Math.round(wallMs / 1000)}s`);
  return {
    id: entry.id,
    sha: entry.sha,
    frontSha: entry.front ? entry.front.sha : null,
    ok: true,
    endpoints: r.endpoints,
    endpointsReachingAStatement: r.endpoints - r.endpointsWithoutStatement,
    statements: r.statements,
    statementsReached: r.statementsReached,
    tables: r.tables,
    tablesReached: r.tablesReached,
    columns: r.columns,
    columnsReached: r.columnsReached,
    webCalls,
    webCallsResolved,
    screens: screens ? screens.screens : 0,
    screensReachingATable: screens ? screens.reachingATable : 0,
    axes: Object.fromEntries(Object.entries(packJson.meta.axes ?? {}).map(([k, v]) => [k, v.status])),
    nodes: packJson.counts.nodes,
    edges: packJson.counts.edges,
    // Wall time is REPORTED and never guarded: it is a property of the machine
    // that ran it, and a baseline over it would fail on a slow laptop.
    wallMs,
  };
}

function lastLines(s, n = 6) {
  return String(s ?? '').trim().split('\n').slice(-n).join(' | ');
}

/** The table the report prints, from the measurements. */
export function renderTable(results) {
  const head = ['repo', 'endpoints -> SQL', 'tables', 'columns', 'web calls -> route', 'screens -> table', 'degraded axes', 'wall'];
  const rows = results.map((m) => (m.ok
    ? [
      m.id,
      `${m.endpointsReachingAStatement} / ${m.endpoints}${m.endpoints > 0 ? ` (${Math.round((m.endpointsReachingAStatement / m.endpoints) * 100)}%)` : ''}`,
      `${m.tablesReached} / ${m.tables}`,
      `${m.columnsReached} / ${m.columns}`,
      `${m.webCallsResolved ?? 0} / ${m.webCalls ?? 0}`,
      `${m.screensReachingATable ?? 0} / ${m.screens ?? 0}`,
      Object.entries(m.axes).filter(([, v]) => v !== 'shipped').map(([k, v]) => `${k}=${v}`).join(' ') || 'all shipped',
      `${Math.max(1, Math.round(m.wallMs / 1000))} s`,
    ]
    : [m.id, 'FAILED', '', '', '', '', m.error ?? '', '']));
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  return [line(head), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.map(line)].join('\n');
}

/** Read the pinned baseline, or null when there is none yet. */
export function readBaseline(file = BASELINE_FILE) {
  if (!fs.existsSync(file)) return null;
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (b.schema !== GATE_SCHEMA) throw new Error(`${file} has schema ${JSON.stringify(b.schema)}, expected ${GATE_SCHEMA}`);
  return b;
}

/**
 * Compare measurements against a baseline. Pure.
 *
 * A number that ROSE is not a failure and does not update anything: the baseline
 * moves only when somebody runs `--accept`, so an improvement is a decision
 * rather than a side effect. A number that FELL is a regression, named with both
 * values.
 *
 * @param {object[]} results
 * @param {object|null} baseline
 * @returns {{regressions:string[], improvements:string[], unknown:string[]}}
 */
export function compareToBaseline(results, baseline) {
  const regressions = [];
  const improvements = [];
  const unknown = [];
  const repos = baseline?.repos ?? {};
  for (const m of results) {
    if (!m.ok) { regressions.push(`${m.id}: the run FAILED — ${m.error}`); continue; }
    const b = repos[m.id];
    if (!b) { unknown.push(`${m.id}: not in the baseline — run --accept to record it`); continue; }
    if (b.sha && b.sha !== m.sha) {
      unknown.push(`${m.id}: the baseline was taken at ${String(b.sha).slice(0, 12)} and this run is at ${m.sha.slice(0, 12)} — not comparable`);
      continue;
    }
    if (b.frontSha && b.frontSha !== m.frontSha) {
      unknown.push(`${m.id}: the baseline's frontend was at ${String(b.frontSha).slice(0, 12)} and this run's is at ${String(m.frontSha ?? 'none').slice(0, 12)} — not comparable`);
      continue;
    }
    for (const k of GUARDED) {
      const was = b[k];
      const now = m[k];
      if (!Number.isInteger(was)) { unknown.push(`${m.id}.${k}: no baseline value`); continue; }
      if (now < was) regressions.push(`${m.id}.${k}: ${was} -> ${now}`);
      else if (now > was) improvements.push(`${m.id}.${k}: ${was} -> ${now}`);
    }
  }
  return { regressions, improvements, unknown };
}

/** The baseline document for a set of measurements. */
export function baselineFrom(results) {
  const repos = {};
  for (const m of results.filter((x) => x.ok).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    repos[m.id] = {
      sha: m.sha,
      ...(m.frontSha ? { frontSha: m.frontSha } : {}),
      endpoints: m.endpoints,
      endpointsReachingAStatement: m.endpointsReachingAStatement,
      statements: m.statements,
      statementsReached: m.statementsReached,
      tables: m.tables,
      tablesReached: m.tablesReached,
      columns: m.columns,
      columnsReached: m.columnsReached,
      webCalls: m.webCalls,
      webCallsResolved: m.webCallsResolved,
      screens: m.screens,
      screensReachingATable: m.screensReachingATable,
      axes: m.axes,
    };
  }
  return { schema: GATE_SCHEMA, repos };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const has = (f) => argv.includes(f);
  const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const only = valueOf('--only');
  const wanted = only ? new Set(only.split(',').map((s) => s.trim())) : null;
  const corpus = CORPUS.filter((e) => !wanted || wanted.has(e.id));
  const log = (s) => process.stderr.write(`${s}\n`);

  log(`gate directory: ${gateDir()}`);
  if (has('--fetch')) {
    for (const e of corpus) {
      const st = checkoutStatus(e);
      if (st.present) { log(`  ${e.id}: already at ${e.sha.slice(0, 12)}`); continue; }
      try { fetchOne(e, process.env, log); } catch (err) { log(`  ${e.id}: FETCH FAILED — ${err.message.split('\n')[0]}`); }
    }
    // `--fetch --no-run` is the CI shape: clone in one step so the failure to
    // clone is a step of its own, then let the regression test do the running.
    if (has('--no-run')) return 0;
  }

  const runnable = [];
  for (const e of corpus) {
    const st = checkoutStatus(e);
    if (st.present) runnable.push(e);
    else log(`  skipping ${e.id}: ${st.why} (run with --fetch)`);
  }
  if (runnable.length === 0) {
    log('nothing to run: no corpus repository is cloned at its pin. `node scripts/generality-gate.mjs --fetch` clones them (~1 GB).');
    return 2;
  }

  const results = runnable.map((e) => runOne(e, { log }));
  process.stdout.write(`${renderTable(results)}\n`);

  const jsonFile = valueOf('--json');
  const doc = { schema: GATE_SCHEMA, repos: Object.fromEntries(results.map((m) => [m.id, m])) };
  if (jsonFile) {
    fs.writeFileSync(jsonFile, `${JSON.stringify(doc, null, 1)}\n`, 'utf8');
    log(`wrote ${jsonFile}`);
  }

  const baseline = readBaseline();
  const cmp = compareToBaseline(results, baseline);
  for (const u of cmp.unknown) log(`  [unknown]     ${u}`);
  for (const i of cmp.improvements) log(`  [improved]    ${i}`);
  for (const r of cmp.regressions) log(`  [REGRESSION]  ${r}`);

  if (has('--accept')) {
    // The DIFF is printed before the write, always: accepting a baseline without
    // seeing what moved is how a regression becomes the new normal.
    const next = baselineFrom(results);
    if (baseline) {
      for (const id of Object.keys(next.repos).sort()) {
        const was = baseline.repos?.[id];
        for (const k of GUARDED) {
          const a = was?.[k];
          const b = next.repos[id][k];
          if (a !== b) log(`  [accept] ${id}.${k}: ${a ?? '(new)'} -> ${b}`);
        }
      }
    }
    // Only the repos this run measured are rewritten; a corpus entry that was
    // not cloned keeps the baseline it had, rather than being deleted by a
    // partial run.
    const merged = { schema: GATE_SCHEMA, repos: { ...(baseline?.repos ?? {}), ...next.repos } };
    merged.repos = Object.fromEntries(Object.keys(merged.repos).sort().map((k) => [k, merged.repos[k]]));
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(merged, null, 1)}\n`, 'utf8');
    log(`baseline rewritten: ${BASELINE_FILE}`);
    return 0;
  }

  return cmp.regressions.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
