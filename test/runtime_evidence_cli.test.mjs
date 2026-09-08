import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { otelMethodsInclude } from '../src/adapters/runtime_bridge.mjs';
import { petclinicGraph, petclinicPack } from './helpers/petclinic_graph.mjs';

// The runtime evidence lane through the REAL CLI.
//
// The unit tests beside this one check the reader and the bridge on a graph
// somebody handed them. What they cannot check is the thing I-9 is about:
// whether the SAME trace, read by two separate runs of the binary, produces the
// same pack, and whether the bytes it was read from are recorded where every
// other input to a pack is recorded. Evidence that is not content-addressed is
// evidence a pack cannot be held to.

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const JAVA_FIXTURE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'java-smoke', 'com', 'example');
const TRACE_FIXTURE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'otel', 'orders-trace.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repo holding the tiny java fixture plus the trace beside it. */
function project(t) {
  const base = tmpDir(t, 'cascade-otel-');
  const dir = path.join(base, 'app');
  const src = path.join(dir, 'src', 'main', 'java', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  fs.cpSync(JAVA_FIXTURE, src, { recursive: true });
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  const trace = path.join(dir, 'evidence', 'orders.json');
  fs.copyFileSync(TRACE_FIXTURE, trace);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  return { base, dir, trace };
}

/** Analyze, capturing stderr even on success (execFileSync only returns it on a throw). */
function analyze(args, cwd, t, env) {
  const log = path.join(tmpDir(t, 'cascade-otel-log-'), 'stderr.txt');
  const fd = fs.openSync(log, 'w');
  let code = 0;
  try {
    execFileSync(process.execPath, [CLI, 'analyze', ...args], {
      env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'ignore', fd], maxBuffer: 1 << 28,
    });
  } catch (e) {
    code = e.status ?? 1;
  } finally {
    fs.closeSync(fd);
  }
  return { code, stderr: fs.readFileSync(log, 'utf8') };
}

function skipWithoutJdk(t) {
  if (findJdk()) return false;
  t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH. This test analyzes java sources, so the code lane has to run '
    + '(see docs/setup/java-lane.md); CI runs it on temurin 21');
  return true;
}

test('a trace annotates the pack, joins the facts index, and two runs of it agree byte for byte', (t) => {
  if (skipWithoutJdk(t)) return;
  const { base, dir, trace } = project(t);
  const out = path.join(base, 'pack');
  const env = { CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const flags = [
    '--root', dir, '--java-src', path.join(dir, 'src', 'main', 'java'),
    '--no-ddl', '--no-mappers', '--no-web', '--no-openapi',
    '--otel', trace, '--out', out,
  ];

  // ---- run 1: cold ------------------------------------------------------
  const first = analyze(flags, base, t, env);
  assert.equal(first.code, 0, first.stderr);
  // The lane line names the trace and where it came from.
  assert.match(first.stderr, /otel evidence\/orders\.json \(flag\)/);
  // The census, in the words the run prints.
  assert.match(first.stderr, /^Runtime evidence: 1 trace\(s\), 4 span\(s\) \(0 carried nothing this lane reads\), 3 observation\(s\): 2 dispatch, 0 statement and 1 route observation\(s\) matched this pack, 0 matched none$/m);
  assert.match(first.stderr, /^Runtime evidence: 2 static edge\(s\) marked observed \(2 a call the source states, 0 a candidate set the trace narrowed\), 0 RUNTIME_ONLY edge\(s\) added/m);
  assert.match(first.stderr, /^Runtime evidence: a grade was neither raised nor lowered by any of this\./m);
  const pack1 = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));

  // ---- I-9, half one: the trace's bytes are in the facts index ----------
  const index = JSON.parse(fs.readFileSync(path.join(out, 'facts-index.json'), 'utf8'));
  assert.deepEqual(index.runtimeEvidence, {
    otel: [{ path: 'evidence/orders.json', sha256: sha256(fs.readFileSync(trace)) }],
  });

  // ---- I-9, half two: the same trace, a second run, the same pack -------
  // The second run is INCREMENTAL (the first left shards behind), which is the
  // comparison that matters: a cold pack and an incremental one built from the
  // same inputs have to be identical.
  const second = analyze(flags, base, t, env);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /^incremental: /m, `the second run was not incremental:\n${second.stderr}`);
  const pack2 = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  assert.equal(pack2.digest, pack1.digest, 'the same trace produced two different packs');
  assert.deepEqual(pack2.edges, pack1.edges);
  assert.deepEqual(pack2.nodes, pack1.nodes);

  // ---- what the trace actually did to the graph -------------------------
  const edge = (from, to) => pack1.edges.find((e) => e.from === from && e.to === to);
  const controllerToService = edge('symbol:com.example.OrderController#find', 'symbol:com.example.OrderService#find');
  assert.ok(controllerToService, 'the static call is missing, so this test proves nothing');
  assert.equal(controllerToService.grade, 'SOUND_SET', 'a confirmed call keeps the grade the source earned it');
  assert.equal(controllerToService.evidence.observed, true);
  assert.equal(controllerToService.evidence.observedCount, 1);
  assert.deepEqual(controllerToService.evidence.observedBy, ['evidence/orders.json']);
  const serviceToMapper = edge('symbol:com.example.OrderService#find', 'symbol:com.example.OrderMapper#selectById');
  assert.equal(serviceToMapper.grade, 'SOUND_SET');
  assert.equal(serviceToMapper.evidence.observed, true);
  // Nothing was added: every hop the trace saw, the source already stated.
  assert.equal(pack1.edges.some((e) => e.grade === 'RUNTIME_ONLY'), false);
  // The route the request entered by.
  assert.equal(pack1.nodes.find((n) => n.id === 'endpoint:GET /orders/{id}').observed, true);

  // ---- the census the pack carries --------------------------------------
  const stats = pack1.meta.laneStats.otel;
  assert.deepEqual({
    files: stats.files, spans: stats.spans, observations: stats.observations,
    matched: stats.matched, unmatched: stats.unmatched,
    edgesObserved: stats.edgesObserved, edgesAdded: stats.edgesAdded,
    endpointsObserved: stats.endpointsObserved,
  }, {
    files: 1, spans: 4, observations: 3,
    matched: { dispatch: 2, statement: 0, endpoint: 1 },
    unmatched: { dispatch: 0, statement: 0, endpoint: 0 },
    edgesObserved: 2, edgesAdded: 0, endpointsObserved: 1,
  });
  assert.deepEqual(stats.sources, ['evidence/orders.json']);
  assert.deepEqual(stats.services, ['orders-api']);

  // ---- every answer says how much was observed --------------------------
  const rpc = spawnSync(process.execPath, [CLI, 'mcp', '--pack', out], {
    input: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'flow', arguments: { endpoint: 'GET /orders/{id}' } },
    }) + '\n',
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 1 << 26,
  });
  assert.equal(rpc.status, 0, rpc.stderr);
  const answered = JSON.parse(JSON.parse(rpc.stdout.split('\n').filter(Boolean)[0]).result.content[0].text);
  const re = answered.basis.runtimeEvidence;
  assert.ok(re, `basis carries no runtimeEvidence block: ${JSON.stringify(answered.basis)}`);
  assert.equal(re.source, 'otel');
  assert.deepEqual(re.files, ['evidence/orders.json']);
  assert.equal(re.spans, 4);
  assert.equal(re.observedEdges, 2);
  assert.equal(re.observedEndpoints, 1);
  assert.deepEqual(re.window, { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.006Z' });
  assert.match(re.note, /coverage is only what was exercised/);
  // ...and the chain says which hop was seen, without changing what it claims.
  const row = answered.answer.services.find((s) => s.id === 'com.example.OrderService#find');
  assert.equal(row.observed, true);
  assert.equal(row.grade, 'SOUND_SET');
  assert.equal(row.link.observed, true);
});

test('a DIFFERENT trace is a different pack, and no trace at all leaves the basis silent', (t) => {
  if (skipWithoutJdk(t)) return;
  const { base, dir, trace } = project(t);
  const env = { CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const lanes = [
    '--root', dir, '--java-src', path.join(dir, 'src', 'main', 'java'),
    '--no-ddl', '--no-mappers', '--no-web', '--no-openapi',
  ];

  const bare = path.join(base, 'bare');
  assert.equal(analyze([...lanes, '--out', bare], base, t, env).code, 0);
  const bareePack = JSON.parse(fs.readFileSync(path.join(bare, 'pack.json'), 'utf8'));
  assert.equal(bareePack.meta.laneStats?.otel, undefined, 'a run with no trace must claim no observation');
  assert.equal(JSON.parse(fs.readFileSync(path.join(bare, 'facts-index.json'), 'utf8')).runtimeEvidence, undefined);

  const withTrace = path.join(base, 'traced');
  assert.equal(analyze([...lanes, '--otel', trace, '--out', withTrace], base, t, env).code, 0);
  const tracedPack = JSON.parse(fs.readFileSync(path.join(withTrace, 'pack.json'), 'utf8'));
  // Evidence rides in the digest like every other fact, so the two differ.
  assert.notEqual(tracedPack.digest, bareePack.digest);
  assert.equal(tracedPack.nodes.length, bareePack.nodes.length, 'a trace that matched everything must add no node');
  assert.equal(tracedPack.edges.length, bareePack.edges.length, 'a trace that matched everything must add no edge');

  // A trace that saw ONE fewer request is a different capture and a different pack.
  const half = JSON.parse(fs.readFileSync(trace, 'utf8'));
  half.resourceSpans[0].scopeSpans[0].spans.pop();
  const halfFile = path.join(dir, 'evidence', 'half.json');
  fs.writeFileSync(halfFile, JSON.stringify(half));
  const halfOut = path.join(base, 'half');
  assert.equal(analyze([...lanes, '--otel', halfFile, '--out', halfOut], base, t, env).code, 0);
  const halfPack = JSON.parse(fs.readFileSync(path.join(halfOut, 'pack.json'), 'utf8'));
  assert.notEqual(halfPack.digest, tracedPack.digest);
  assert.equal(halfPack.meta.laneStats.otel.edgesObserved, 1);
});

test('the SAME spans in the agent\'s LOG form make the same pack, and the run says how it read them', (t) => {
  if (skipWithoutJdk(t)) return;
  const { base, dir, trace } = project(t);
  const env = { CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const lanes = ['--root', dir, '--java-src', path.join(dir, 'src', 'main', 'java'),
    '--no-ddl', '--no-mappers', '--no-web', '--no-openapi'];

  // The same document, written the way the Java agent's `logging-otlp` exporter
  // writes it: one ResourceSpans per line, behind the logger's own prefix, in
  // the middle of the application's log.
  const doc = JSON.parse(fs.readFileSync(trace, 'utf8'));
  const prefix = '[otel.javaagent 2026-01-01 00:00:00:000 +0000] [BatchSpanProcessor_WorkerThread-1] INFO '
    + 'io.opentelemetry.exporter.logging.otlp.OtlpJsonLoggingSpanExporter - ';
  const log = path.join(dir, 'evidence', 'app.log');
  fs.writeFileSync(log, [
    'Starting OrdersApplication using Java 21',
    ...doc.resourceSpans.map((rs) => prefix + JSON.stringify(rs)),
    'Commencing graceful shutdown',
    '',
  ].join('\n'));

  const asDoc = path.join(base, 'from-document');
  const asLog = path.join(base, 'from-log');
  const a = analyze([...lanes, '--otel', trace, '--out', asDoc], base, t, env);
  assert.equal(a.code, 0, a.stderr);
  const b = analyze([...lanes, '--otel', log, '--out', asLog], base, t, env);
  assert.equal(b.code, 0, b.stderr);

  // The run says which form it read and what it could not use, so a reader who
  // pointed at the wrong log sees a count instead of a silent pass.
  assert.equal(/was read as an agent log/.test(a.stderr), false, 'a document must not be reported as a log');
  assert.match(b.stderr, /^Runtime evidence: evidence\/app\.log was read as an agent log, one export per line: 4 span\(s\) in it, 2 line\(s\) carried none$/m);

  // Same spans in, same answer out: the two packs differ only in the file name
  // the evidence was read from.
  const packOf = (d) => JSON.parse(fs.readFileSync(path.join(d, 'pack.json'), 'utf8'));
  const [pd, pl] = [packOf(asDoc), packOf(asLog)];
  assert.equal(pl.meta.laneStats.otel.observations, pd.meta.laneStats.otel.observations);
  assert.equal(pl.meta.laneStats.otel.edgesObserved, pd.meta.laneStats.otel.edgesObserved);
  assert.deepEqual(pl.meta.laneStats.otel.sources, ['evidence/app.log']);
  const strip = (p) => JSON.stringify(p.edges).split('evidence/app.log').join('evidence/orders.json');
  assert.equal(strip(pl), strip(pd), 'the same spans read two ways must annotate the graph identically');
});

test('an unreadable trace is a named warning, not a dead run', (t) => {
  if (skipWithoutJdk(t)) return;
  const { base, dir } = project(t);
  const env = { CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const bad = path.join(dir, 'evidence', 'not-a-trace.json');
  fs.writeFileSync(bad, '{"traces": []}');
  const out = path.join(base, 'pack');
  const r = analyze([
    '--root', dir, '--java-src', path.join(dir, 'src', 'main', 'java'),
    '--no-ddl', '--no-mappers', '--no-web', '--no-openapi', '--otel', bad, '--out', out,
  ], base, t, env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\[warn] OTEL_UNREADABLE evidence\/not-a-trace\.json: no resourceSpans array/);
  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  assert.equal(pack.meta.laneStats.otel.observations, 0);
  assert.equal(pack.edges.some((e) => e.grade === 'RUNTIME_ONLY'), false);
});

test('--otel names a file that is not there, and the run says so instead of analyzing half of it', (t) => {
  const { base, dir } = project(t);
  const env = { CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const r = analyze([
    '--root', dir, '--java-src', path.join(dir, 'src', 'main', 'java'),
    '--no-ddl', '--no-mappers', '--no-web', '--no-openapi',
    '--otel', path.join(dir, 'evidence', 'absent.json'), '--out', path.join(base, 'pack'),
  ], base, t, env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--otel .*absent\.json does not exist/);
});

// ---------------------------------------------------------------------------
// `cascade otel-methods` — the line the agent has to be handed
// ---------------------------------------------------------------------------
//
// No JDK and no analysis here: the command reads a PACK, so the test writes
// one. The graph it writes is the spring-petclinic shape (test/helpers/
// petclinic_graph.mjs), which is also what the runtime bridge's unit tests join
// the real capture against, so both halves of this round are held to the same
// project.

/** Run the binary and return {code, stdout, stderr}. */
function run(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A pack directory holding the petclinic-shaped pack, and a home to go with it. */
function packDir(t) {
  const base = tmpDir(t, 'cascade-otel-methods-');
  const dir = path.join(base, 'pack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(petclinicPack(), null, 2));
  return { base, dir, env: { CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') } };
}

test('otel-methods prints the agent value on stdout, and nothing else on it', (t) => {
  const { dir, env } = packDir(t);
  const r = run(['otel-methods', '--pack', dir], env);
  assert.equal(r.code, 0, r.stderr);

  const value = r.stdout.trimEnd();
  assert.equal(r.stdout.split('\n').filter((l) => l !== '').length, 1, 'stdout must be the value and nothing else, so it can be pasted or piped');
  assert.equal(value, otelMethodsInclude(petclinicGraph()).value);
  assert.match(value, /org\.springframework\.samples\.petclinic\.owner\.OwnerController\[[^\]]*showOwner[^\]]*\]/);
  assert.equal(value.includes(';'), true, 'the classes are joined for the agent');
  assert.equal(value.includes('[*]'), false, 'the agent gets explicit names, never a wildcard');

  // The count and the instruction go where they cannot get into a pipe.
  assert.match(r.stderr, /32 method\(s\) in 10 class\(es\): 17 route handler\(s\)/);
  assert.match(r.stderr, /-Dotel\.instrumentation\.methods\.include=/);

  // Twice is the same, byte for byte.
  assert.equal(run(['otel-methods', '--pack', dir], env).stdout, r.stdout);
});

test('otel-methods --json prints the same list as {class: [methods]}', (t) => {
  const { dir, env } = packDir(t);
  const r = run(['otel-methods', '--pack', dir, '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc, otelMethodsInclude(petclinicGraph()).classes);
  assert.ok(doc['org.springframework.samples.petclinic.owner.OwnerController'].includes('showOwner'));
  // The two halves say the same thing.
  const value = run(['otel-methods', '--pack', dir], env).stdout.trimEnd();
  assert.equal(Object.entries(doc).map(([c, m]) => `${c}[${m.join(',')}]`).join(';'), value);
});

test('otel-methods with no pack says which file it wanted', (t) => {
  const base = tmpDir(t, 'cascade-otel-methods-empty-');
  const r = run(['otel-methods', '--pack', path.join(base, 'nothing')], {
    CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache'),
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no pack at .*pack\.json\. Run cascade analyze first/);
});
