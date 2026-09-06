import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { loadPack } from '../src/core/pack.mjs';
import {
  endpoint_impact, flow, search, neighborhood, overview, screen_impact, browse,
} from '../src/mcp/tools.mjs';

// The web lane through the REAL CLI (RM26, RM28), in the style of analyze_root.test.mjs.
//
// The unit tests above this one check the worker, the bridge and the pure lane
// selection. What they cannot check is the thing that actually goes wrong:
// whether a run whose ONLY lane is `web` is a legal run at all. There is no
// backend in it, so not one frontend call can reach a route this pack serves,
// and the pack has to come out the other end SAYING SO rather than looking like
// a failed analysis.

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const FIXTURE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'web-smoke');
const OPENAPI_FIXTURE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'openapi');

function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repo holding a copy of the web fixture, so the run has a commit to pin. */
function frontendRepo(t) {
  const base = tmpDir(t, 'cascade-weblane-');
  const dir = path.join(base, 'front');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  return { base, dir };
}

/** Analyze, capturing stderr even on success (execFileSync only returns it on a throw). */
function analyze(args, cwd, t, env = {}) {
  const log = path.join(tmpDir(t, 'cascade-weblane-log-'), 'stderr.txt');
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

test('a run whose only lane is web exits 0, and every call it found is an outbound target', (t) => {
  const { base, dir } = frontendRepo(t);
  const out = path.join(base, 'pack');
  const res = analyze(
    ['--root', dir, '--web-src', path.join(dir, 'src'), '--no-ddl', '--no-mappers', '--no-java', '--out', out],
    base, t, { CASCADE_HOME: path.join(base, 'home') },
  );
  assert.equal(res.code, 0, res.stderr);

  // The worker's line, with every count the pack will carry.
  const lane = res.stderr.split('\n').find((l) => /^Web lane: \d+ file/.test(l));
  assert.ok(lane, `no web lane line in:\n${res.stderr}`);
  assert.match(lane, /^Web lane: 19 file\(s\) \(3 \.vue, 8 \.ts\/\.tsx, 8 \.js\/\.jsx\), 1 parse error\(s\); /);
  assert.match(lane, /13 call site\(s\) carry a URL \(7 literal, 3 template, 2 constant, 1 unresolved\)/);
  assert.match(lane, /7 route declaration\(s\), 3 alias\(es\), 2 proxy rule\(s\)/);

  // The BRIDGE's line: with no backend in this pack, nothing can match, and the
  // line says that in the same words the pack does.
  const bridge = res.stderr.split('\n').find((l) => /^Web lane: \d+ call site\(s\)/.test(l));
  assert.ok(bridge, `no web bridge line in:\n${res.stderr}`);
  assert.match(bridge, /13 call site\(s\), 0 resolved \(0 sound, 0 heuristic\)/);
  assert.match(bridge, /prefix \.: \(none\) \(derived\)/);
  assert.match(res.stderr, /2 client instance\(s\), \d+ wrapper\(s\)/);

  // The parse error is named, with its file, because a file the lane could not
  // read contributes nothing to anything below and nothing else would say so.
  assert.match(res.stderr, /\[warn\] WEB_PARSE_ERROR src\/broken\/bad\.js:/);
  // ...and so is a URL nothing here serves.
  assert.match(res.stderr, /\[warn\] WEB_NO_ROUTE GET \/things\/list \(1 call site\(s\)\)/);

  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  assert.deepEqual(pack.meta.lanes, ['web']);
  // Every node is either a frontend function or the route it names, and every
  // edge is UNRESOLVED: this pack serves nothing, so nothing was matched.
  assert.ok(pack.nodes.length > 0, 'the frontend functions and their targets are nodes');
  assert.equal(pack.nodes.every((n) => n.lane === 'web' || n.outbound === true || n.kind === 'screen'), true,
    JSON.stringify(pack.nodes.filter((n) => n.lane !== 'web' && n.outbound !== true && n.kind !== 'screen')));
  // Every CALLS_HTTP edge is UNRESOLVED (this pack serves nothing); the only
  // other edges are the frontend's own calls and the screens that render them,
  // neither of which needs a backend.
  const backendless = (e) => (e.type === 'CALLS_HTTP' && e.grade === 'UNRESOLVED') || e.type === 'CALLS' || e.type === 'RENDERS';
  assert.equal(pack.edges.every(backendless), true, JSON.stringify(pack.edges.filter((e) => !backendless(e))));
  assert.equal(pack.edges.filter((e) => e.type === 'CALLS').length, 6,
    'the views call three api functions between them (RM30) and hand three more over as values (RM32)');

  const stats = pack.meta.laneStats.web;
  assert.ok(stats.calls.withUrl > 0, JSON.stringify(stats));
  assert.equal(stats.files, 19);
  assert.equal(stats.callsWithUrl, 13);
  assert.deepEqual(stats.urlByShape, { literal: 7, template: 3, constant: 2, unresolved: 1 });
  assert.deepEqual(stats.byPack, { 'react-router': 2, 'vue-router': 5 });
  assert.deepEqual(stats.roots, ['src']);
  assert.equal(stats.envFiles, 1);
  assert.deepEqual(stats.resolved, { SOUND_SET: 0, HEURISTIC: 0 });
  assert.equal(stats.instances, 2);
  assert.equal(stats.unresolved.byReason.parameter, 1);

  assert.equal(pack.meta.axes.web.status, 'degraded');
  assert.match(pack.meta.axes.web.reason, /not one of them reached a route this pack serves/);
  // THE THIRD STATE OF THE SWITCH (RM32). This run passed no profile at all, so
  // `screenAxis.enabled` is undeclared — and the frontend package it reads
  // depends on vue-router, so the screens are built. Before RM32 the undeclared
  // key meant "off" and this run produced no screen, which was a wrong answer
  // about a frontend the run had just read end to end.
  assert.match(res.stderr, /^screen axis ON \(read-router\): screenAxis\.enabled is undeclared and a frontend package this run reads depends on vue-router$/m);
  assert.equal(pack.nodes.filter((n) => n.id.startsWith('screen:')).length, 7);
  assert.equal(pack.meta.axes.screen.status, 'degraded');
  assert.match(pack.meta.axes.screen.reason, /5 of 7 route declaration\(s\) name a component/);
  assert.deepEqual(stats.functions, { withHttp: 12, reachingHttp: 4, created: 16 });
  assert.deepEqual(stats.callsEdges, { EXACT: 3, SOUND_SET: 3, HEURISTIC: 0 });
  assert.deepEqual(stats.callsByRule, { 'same-file': 0, 'esm-import': 3, 'passed-as-value': 3 });
  assert.equal(stats.screens.declared, 7);
  assert.equal(stats.screens.screens, 7);
  assert.deepEqual(stats.screens.renders, { EXACT: 3, SOUND_SET: 0 });
});

test('screenAxis.enabled: false is still the user\'s word, and it turns the axis off', (t) => {
  // The counterpart of the test above: the same tree, the same flags, and a
  // profile that says no. What the run reads does not overrule that.
  const { base, dir } = frontendRepo(t);
  const out = path.join(base, 'pack');
  const profile = path.join(base, 'off.json');
  fs.writeFileSync(profile, JSON.stringify({ screenAxis: { enabled: false } }), 'utf8');
  const res = analyze(
    ['--root', dir, '--web-src', path.join(dir, 'src'), '--no-ddl', '--no-mappers', '--no-java',
      '--profile', profile, '--out', out],
    base, t, { CASCADE_HOME: path.join(base, 'home') },
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /^screen axis OFF \(profile\): the profile sets screenAxis\.enabled to false$/m);
  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  assert.equal(pack.nodes.some((n) => n.id.startsWith('screen:')), false);
  assert.equal(pack.meta.axes.screen.status, 'not-shipped');
  assert.match(pack.meta.axes.screen.reason, /7 route declaration\(s\)/);
  assert.match(pack.meta.axes.screen.reason, /the profile sets screenAxis\.enabled to false/);
  assert.equal(pack.meta.laneStats.web.screens.screens, 0);
});

test('--no-web and --web-src contradict each other, and the message says which pair', (t) => {
  const { base, dir } = frontendRepo(t);
  const res = analyze(['--root', dir, '--no-web', '--web-src', path.join(dir, 'src')], base, t,
    { CASCADE_HOME: path.join(base, 'home') });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--no-web and --web-src contradict each other/);
});

test('--web-src pointing nowhere fails with the path the user typed, not "0 files"', (t) => {
  const { base, dir } = frontendRepo(t);
  const res = analyze(['--root', dir, '--web-src', path.join(dir, 'nope'), '--no-ddl', '--no-mappers', '--no-java'],
    base, t, { CASCADE_HOME: path.join(base, 'home') });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--web-src .*nope does not exist/);
});

test('after `cascade init` the profile declares the web pack and an unflagged run reads the frontend', (t) => {
  const { base, dir } = frontendRepo(t);
  const home = path.join(base, 'home');
  execFileSync(process.execPath, [CLI, 'init', '--root', dir, '--project', 'front'], {
    env: { ...process.env, CASCADE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const profile = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8'));
  // One `router` per PACKAGE, and this fixture's package declares both, so the
  // first match wins. It changes nothing about what is read: the worker loads
  // every pack in adapters/web/packs whichever ones the profile happens to
  // name, and the react routes below prove it.
  assert.deepEqual(profile.frameworkPacks, ['web', 'vue-router']);
  // A router pack IS the screen axis switch, and `init` turns it on.
  assert.equal(profile.screenAxis.enabled, true);

  // No lane flag at all: the profile and discovery decide, and the frontend is
  // read because the pack says to read it.
  const res = analyze(['--root', dir], base, t, { CASCADE_HOME: home });
  assert.equal(res.code, 0, res.stderr);
  const laneLine = res.stderr.split('\n').find((l) => l.startsWith('lanes ['));
  assert.match(laneLine, /^lanes \[web\]/);
  assert.match(laneLine, /web src \(discovery\)/);

  const pack = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.deepEqual(pack.meta.lanes, ['web']);
  assert.equal(pack.meta.axes.web.status, 'degraded');
  assert.deepEqual(pack.meta.laneStats.web.byPack, { 'react-router': 2, 'vue-router': 5 });

  // ...and with the axis on, the routes really are screens. Five of the seven
  // components are files this fixture does not ship, so the axis is DEGRADED
  // and says exactly that rather than looking healthy.
  const screens = pack.nodes.filter((n) => n.id.startsWith('screen:'));
  assert.deepEqual(screens.map((n) => n.path).sort(),
    ['/', '/catalog', '/catalog/index', '/login', '/r', '/r/child', '/things/list']);
  const rows = screens.find((n) => n.path === '/things/list');
  assert.equal(rows.name, 'ThingList');
  assert.equal(rows.component, 'src/views/things/list.vue');
  assert.equal(rows.group, 'things');
  assert.equal(rows.source, 'router');
  assert.deepEqual(rows.declaredAt, [{ file: 'src/router/index.js', line: 15 }]);
  assert.equal(pack.edges.filter((e) => e.type === 'RENDERS').length, 3);
  assert.equal(pack.meta.axes.screen.status, 'degraded');
  assert.match(pack.meta.axes.screen.reason, /5 of 7 route declaration\(s\) name a component/);
  assert.equal(pack.meta.laneStats.web.screens.componentUnresolved, 5);
});

test('a second run over an unchanged frontend still succeeds, and the pack still declares the axis', (t) => {
  // The web lane is NOT sharded this round, so the second run re-reads every
  // file. What must not happen is the run reusing a pack built from a different
  // lane selection: `webRoots` is part of the selection for exactly that reason.
  const { base, dir } = frontendRepo(t);
  const home = path.join(base, 'home');
  execFileSync(process.execPath, [CLI, 'init', '--root', dir, '--project', 'front'], {
    env: { ...process.env, CASCADE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const first = analyze(['--root', dir], base, t, { CASCADE_HOME: home });
  assert.equal(first.code, 0, first.stderr);
  const second = analyze(['--root', dir], base, t, { CASCADE_HOME: home });
  assert.equal(second.code, 0, second.stderr);

  const pack = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack.meta.axes.web.status, 'degraded');
  assert.equal(pack.meta.laneStats.web.files, 19);

  // Turning the lane OFF is a different selection, so the run that follows is
  // cold and says which sentence made it cold.
  const off = analyze(['--root', dir, '--no-web'], base, t, { CASCADE_HOME: home });
  assert.notEqual(off.code, 0, 'with the web lane off this project has no lane left at all');
  assert.match(off.stderr, /nothing to analyze/);
  assert.match(off.stderr, /web source roots: src/, 'the die must name the roots discovery found');
});

test('cascade estimate prints the web axis and the frontend file counts', (t) => {
  const { base, dir } = frontendRepo(t);
  const home = path.join(base, 'home');
  execFileSync(process.execPath, [CLI, 'init', '--root', dir, '--project', 'front'], {
    env: { ...process.env, CASCADE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = execFileSync(process.execPath, [CLI, 'estimate', '--root', dir], {
    env: { ...process.env, CASCADE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8');
  assert.match(out, /^ {2}web {9}degraded {5}\d+ frontend source file\(s\)/m);
  assert.match(out, /web files: \d+ frontend source file\(s\) \(3 \.vue\) in 1 source root\(s\), from 1 frontend package\(s\)/);
});

// ---------------------------------------------------------------------------
// The declaration layer, end to end (RM29)
// ---------------------------------------------------------------------------
//
// The case the OpenAPI lane exists for: a frontend, a document, and NO backend
// this engine can read. Without the document not one of those calls has anything
// to land on; with it, they land on the routes the project itself declared.

test('a frontend plus an OpenAPI document and no java lane: the calls reach the declared routes', (t) => {
  const { base, dir } = frontendRepo(t);
  // The document and a schema live beside the frontend, in the same repo.
  fs.cpSync(path.join(OPENAPI_FIXTURE, 'web-routes.yaml'), path.join(dir, 'api.yaml'));
  fs.writeFileSync(path.join(dir, 'schema.sql'), 'CREATE TABLE `thing` (\n  `id` bigint NOT NULL,\n  `name` varchar(64) DEFAULT NULL COMMENT \'thing name\'\n) ENGINE=InnoDB;\n', 'utf8');
  const out = path.join(base, 'pack');
  const res = analyze([
    '--root', dir, '--web-src', path.join(dir, 'src'), '--openapi', path.join(dir, 'api.yaml'),
    '--ddl', path.join(dir, 'schema.sql'), '--no-mappers', '--no-java', '--out', out,
  ], base, t, { CASCADE_HOME: path.join(base, 'home') });
  assert.equal(res.code, 0, res.stderr);

  assert.match(res.stderr, /^OpenAPI lane: api\.yaml \(openapi 3\): 12 route\(s\) declared$/m);
  assert.match(res.stderr, /^OpenAPI lane: 12 declared route\(s\) over 1 document\(s\): 0 also served by this code, 12 declared and not served, 0 served and not declared$/m);

  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  assert.deepEqual(pack.meta.lanes, ['sql', 'openapi', 'web'],
    'the document is a lane of its own, and it is listed before the web lane that needs it');

  // The frontend's calls are SOUND_SET edges onto routes NOTHING here serves.
  const graph = loadPack(pack, { verifyDigest: true });
  const sound = graph.edges.filter((e) => e.type === 'CALLS_HTTP' && e.grade === 'SOUND_SET');
  assert.ok(sound.length >= 8, `only ${sound.length} sound frontend call(s) reached a declared route`);
  const target = graph.nodes.get(sound[0].to);
  assert.equal(target.declared, true, 'the route the call landed on came from the document');
  assert.equal(target.source, 'openapi');
  assert.deepEqual(target.declaredBy, ['api.yaml']);
  assert.equal(graph.edges.some((e) => e.to === sound[0].to && e.type === 'HANDLES'), false,
    'a declaration says a route exists and says nothing about what runs below it');

  // ...and the pack says exactly how far that gets a reader.
  assert.equal(pack.meta.axes.code.status, 'degraded');
  assert.match(pack.meta.axes.code.reason, /endpoints come from an OpenAPI document, not from source/);
  assert.match(pack.meta.axes.code.reason, /a frontend call reaches an endpoint and stops there/);

  const stats = pack.meta.laneStats.openapi;
  assert.equal(stats.paths, 12);
  assert.equal(stats.matchedServed, 0);
  assert.equal(stats.onlyInDocument, 12);
  assert.equal(stats.onlyInCode, 0);
  assert.deepEqual(stats.documents.map((d) => d.path), ['api.yaml']);

  const ctx = {
    graph,
    basis: { project: 'front', buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED' },
    limits: [], pack: { ...pack.meta, digest: pack.digest },
  };
  // A column question has no answer here, and the answer SAYS not-shipped rather
  // than "none": nothing below a declared route is walked, so an empty list is
  // not a finding.
  const impact = endpoint_impact(graph, { column: 'thing.name', mode: 'heuristic' }, ctx);
  assert.deepEqual(impact.answer.endpoints, []);
  assert.equal(impact.answer.empty.endpoints, 'not-shipped');

  // The overview carries the census and the drift gap, in the RM23 voice.
  const ov = overview(graph, {}, ctx);
  assert.equal(ov.answer.openapi.paths, 12);
  assert.equal(ov.answer.openapi.onlyInDocument, 12);
  assert.deepEqual(ov.answer.openapi.documents.map((d) => [d.path, d.version]), [['api.yaml', '3']]);
  const drift = ov.answer.gaps.find((g) => g.kind === 'openapi-drift');
  assert.ok(drift, `no openapi-drift gap: ${ov.answer.gaps.map((g) => g.kind).join(', ')}`);
  assert.match(drift.note, /declared and not served here/);
  assert.match(drift.note, /reports both and judges neither/);
});

test('`cascade init` records the document, and an unflagged run reads it', (t) => {
  const { base, dir } = frontendRepo(t);
  fs.cpSync(path.join(OPENAPI_FIXTURE, 'web-routes.yaml'), path.join(dir, 'api.yaml'));
  const home = path.join(base, 'home');
  execFileSync(process.execPath, [CLI, 'init', '--root', dir, '--project', 'front-doc'], {
    env: { ...process.env, CASCADE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const profile = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8'));
  assert.deepEqual(profile.openapi.documents, ['../api.yaml'], 'manifest-relative, as every profile path is');

  const res = analyze(['--root', dir], base, t, { CASCADE_HOME: home });
  assert.equal(res.code, 0, res.stderr);
  const laneLine = res.stderr.split('\n').find((l) => l.startsWith('lanes ['));
  assert.match(laneLine, /^lanes \[openapi,web\]/);
  assert.match(laneLine, /openapi api\.yaml \(profile\)/);

  const pack = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack.meta.laneStats.openapi.paths, 12);
});

test('a document this reader refuses names the construct, and contributes no route', (t) => {
  const { base, dir } = frontendRepo(t);
  fs.cpSync(path.join(OPENAPI_FIXTURE, 'anchors.yaml'), path.join(dir, 'api.yaml'));
  const out = path.join(base, 'pack');
  const res = analyze([
    '--root', dir, '--web-src', path.join(dir, 'src'), '--openapi', path.join(dir, 'api.yaml'),
    '--no-ddl', '--no-mappers', '--no-java', '--out', out,
  ], base, t, { CASCADE_HOME: path.join(base, 'home') });
  assert.equal(res.code, 0, 'an unreadable document is a finding, not a failed run');
  assert.match(res.stderr, /\[warn\] OPENAPI_UNREADABLE api\.yaml:5: an anchor/);
  assert.match(res.stderr, /UNREADABLE_INPUT openapi\.documents/);

  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  assert.equal(pack.meta.laneStats.openapi.paths, 0);
  assert.deepEqual(pack.meta.laneStats.openapi.drift.onlyInCode, []);
  assert.equal(pack.nodes.some((n) => n.declared === true), false);
});

test('--no-openapi and --openapi contradict each other, and a missing document is named', (t) => {
  const { base, dir } = frontendRepo(t);
  const clash = analyze(['--root', dir, '--no-openapi', '--openapi', path.join(dir, 'api.yaml')], base, t,
    { CASCADE_HOME: path.join(base, 'home') });
  assert.notEqual(clash.code, 0);
  assert.match(clash.stderr, /--no-openapi and --openapi contradict each other/);

  const missing = analyze(['--root', dir, '--web-src', path.join(dir, 'src'), '--openapi', path.join(dir, 'nope.yaml'),
    '--no-ddl', '--no-mappers', '--no-java'], base, t, { CASCADE_HOME: path.join(base, 'home') });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /--openapi .*nope\.yaml does not exist/);
});

// ---------------------------------------------------------------------------
// The round trip, end to end (RM28)
// ---------------------------------------------------------------------------
//
// The two fixtures analyzed together: the frontend calls `/orders/` + id, the
// backend serves `GET /orders/{id}`, and a column the handler's chain reads is
// three hops below it. This is the one test that shows the whole shape the
// round exists for, through the real CLI and the real tools.

test('a frontend call reaches the endpoint the backend serves, and a column-impact answer says so', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return;
  }
  const base = tmpDir(t, 'cascade-web-e2e-');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.cpSync(path.join(ENGINE_ROOT, 'test', 'fixtures', 'java-smoke'), path.join(repo, 'java'), { recursive: true });
  fs.cpSync(FIXTURE, path.join(repo, 'front'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');

  const out = path.join(base, 'pack');
  const res = analyze([
    '--root', repo, '--java-src', path.join(repo, 'java'), '--web-src', path.join(repo, 'front', 'src'),
    '--no-ddl', '--no-mappers', '--out', out,
  ], base, t, { CASCADE_HOME: path.join(base, 'home') });
  assert.equal(res.code, 0, res.stderr);

  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });

  // ONE resolved edge, from the frontend function to the route the backend serves.
  const resolved = graph.edges.filter((e) => e.type === 'CALLS_HTTP' && e.grade !== 'UNRESOLVED');
  assert.equal(resolved.length, 1, JSON.stringify(resolved.map((e) => `${e.from} -> ${e.to}`)));
  const [edge] = resolved;
  assert.equal(edge.from, 'symbol:front/src/api/orders.js#getOrder');
  assert.equal(edge.to, 'endpoint:GET /orders/{id}');
  assert.equal(edge.grade, 'SOUND_SET');
  assert.equal(edge.evidence.match, 'template');
  assert.equal(edge.evidence.sink.kind, 'wrapper', 'the fixture calls through a class wrapper');
  assert.equal(edge.evidence.sink.module, 'axios');

  // Nothing about this frontend had to be guessed, so the axis is shipped.
  assert.equal(pack.meta.axes.web.status, 'shipped', pack.meta.axes.web.reason);
  assert.equal(pack.meta.axes.web.reason, null);

  // ...and the answer a reader actually asks for: change this column, and the
  // route that is affected says how many frontend functions call it.
  const ctx = {
    graph,
    basis: { project: 'front', buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED' },
    limits: [],
  };
  const impact = endpoint_impact(graph, { column: 'orders.status', mode: 'heuristic' }, ctx);
  assert.deepEqual(impact.answer.endpoints.map((e) => ({ id: e.id, frontendCalls: e.frontendCalls })),
    [{ id: 'GET /orders/{id}', frontendCalls: 1 }]);

  // The same number on the Flow view's endpoint row, walking up from the column.
  const up = flow(graph, {
    direction: 'up', column: 'orders.status', mode: 'heuristic', depth: 8,
  }, ctx);
  assert.deepEqual(up.answer.endpoints.map((e) => ({ id: e.id, frontendCalls: e.frontendCalls })),
    [{ id: 'GET /orders/{id}', frontendCalls: 1 }]);

  // And a reader can find the frontend function by its file or its name.
  const found = search(graph, { query: 'getOrder' }, ctx);
  assert.deepEqual(found.answer.webSymbols, [
    { symbol: 'front/src/api/orders.js#getOrder', file: 'front/src/api/orders.js', line: 3 },
  ]);
  // ...and see it hanging off the route in the graph view.
  const around = neighborhood(graph, { endpoint: 'GET /orders/{id}', direction: 'up', hops: 1 }, ctx);
  assert.deepEqual(around.answer.nodes.filter((n) => n.lane === 'web').map((n) => n.id),
    ['symbol:front/src/api/orders.js#getOrder']);
});

// ---------------------------------------------------------------------------
// The WHOLE round trip, screen to column and back (RM30)
// ---------------------------------------------------------------------------
//
// SPEC §1.1 in one test, through the real CLI and the real tools: the router
// declares a screen, the screen's component calls an api function, the api
// function calls a route this backend serves, and the route's chain ends at a
// column. Then the same journey backwards, and a recording on top of it.

test('a screen reaches the column, the column names the screen, and a recording marks the pair observed', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return;
  }
  const base = tmpDir(t, 'cascade-screen-e2e-');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.cpSync(path.join(ENGINE_ROOT, 'test', 'fixtures', 'java-smoke'), path.join(repo, 'java'), { recursive: true });
  fs.cpSync(FIXTURE, path.join(repo, 'front'), { recursive: true });
  fs.cpSync(path.join(ENGINE_ROOT, 'test', 'fixtures', 'har', 'session.har'), path.join(repo, 'session.har'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');

  // `cascade init` is what turns the screen axis on, because this project
  // declares a router pack.
  const home = path.join(base, 'home');
  execFileSync(process.execPath, [CLI, 'init', '--root', repo, '--project', 'trip'], {
    env: { ...process.env, CASCADE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const profile = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'profile.json'), 'utf8'));
  assert.equal(profile.screenAxis.enabled, true, '`cascade init` sets the gate when a router pack is declared');

  const out = path.join(base, 'pack');
  const res = analyze([
    '--root', repo, '--java-src', path.join(repo, 'java'), '--web-src', path.join(repo, 'front', 'src'),
    '--har', path.join(repo, 'session.har'), '--no-ddl', '--no-mappers', '--out', out,
  ], base, t, { CASCADE_HOME: home });
  assert.equal(res.code, 0, res.stderr);

  // The lane list gains `har`, and the lane line says what it read.
  assert.match(res.stderr, /^lanes \[java,web,har\]/m);
  assert.match(res.stderr, /^Web lane: 7 screen\(s\) from 7 route declaration\(s\), 2 with a component \(5 unresolved\), 3 exact and 0 candidate RENDERS edge\(s\)/m);
  assert.match(res.stderr, /^HAR lane: 1 recording\(s\), 8 request\(s\): 3 matched a route this pack serves, 3 matched none, 2 static asset\(s\); 2 screen-to-route pair\(s\) observed/m);

  const pack = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  const ctx = {
    graph,
    basis: { project: 'trip', buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED' },
    limits: [], pack: { ...pack.meta, digest: pack.digest },
  };

  // DOWN: from the screen the router declares, all the way to the table.
  const down = flow(graph, { screen: '/things/list', mode: 'heuristic' }, ctx);
  assert.equal(down.answer.entry.kind, 'screen');
  assert.equal(down.answer.entry.component, 'front/src/views/things/list.vue');
  assert.deepEqual(down.answer.webFunctions.map((r) => r.id), [
    'front/src/views/things/list.vue#getList',
    'front/src/views/things/list.vue#openOrder',
    'front/src/api/orders.js#getOrder',
    'front/src/api/things.js#listThings',
  ]);
  assert.deepEqual(down.answer.endpoints.map((r) => r.id), ['GET /orders/{id}']);
  assert.deepEqual(down.answer.tables.map((r) => r.table), ['orders']);
  assert.equal(down.answer.endpoints[0].observed, true, 'the recording saw this route being called');

  // UP: the same journey backwards, from the column.
  const impact = screen_impact(graph, { column: 'orders.status', mode: 'heuristic' }, ctx);
  assert.deepEqual(impact.answer.screens.map((s) => [s.screen, s.endpoints, s.observed]), [
    ['/things/list', ['GET /orders/{id}'], true],
  ]);

  // ...and the endpoint answer names the screens on the other side of the route.
  const eps = endpoint_impact(graph, { column: 'orders.status', mode: 'heuristic' }, ctx);
  assert.deepEqual(eps.answer.endpoints.map((e) => [e.id, e.screens]), [
    ['GET /orders/{id}', { count: 1, sample: ['/things/list'] }],
  ]);

  // The recording's own edge is in the pack, RUNTIME_ONLY, with its evidence.
  const har = graph.edges.filter((e) => e.grade === 'RUNTIME_ONLY');
  assert.deepEqual(har.map((e) => `${e.from} -> ${e.to}`).sort(), [
    'screen:/nowhere/at/all -> endpoint:GET /orders/{id}',
    'screen:/things/list -> endpoint:GET /orders/{id}',
  ]);
  assert.equal(har[0].evidence.rule, 'har');
  assert.equal(pack.meta.laneStats.har.pairs, 2);
  assert.equal(pack.meta.laneStats.har.pagesWithoutScreen, 1);

  // A page the router never declared is a screen of its own, and it says so.
  const strays = browse(graph, { kind: 'screen', query: 'nowhere' }, ctx).answer.items;
  assert.deepEqual(strays.map((r) => [r.screen, r.source, r.component, r.observed]), [
    ['/nowhere/at/all', 'har', null, true],
  ]);
});
