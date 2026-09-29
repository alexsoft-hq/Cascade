// overlay_inputs.test.mjs — the overlay builds from the base pack's inputs, and says so when one of them moved.
//
// ONE RULE (review 3, design 7). The working-tree overlay lays the edited files
// over the inputs the base pack was built from: the profile it read, the
// catalog files it read, the frontend repository at the commit it read, the
// ports its applications listened on. An input that changed since, without
// being one of the edited files the overlay re-reads, is not quietly read
// again: the overlay declines (the profile, the catalog), is discarded as
// behind (a frontend repository that moved on), or says what it did not read
// again (a Java edit that loads configuration or sets a port). The session id
// holds those inputs, so a long-running server does not answer from an overlay
// built over the old ones.
//
// Each case below is the reviewer's reproduction, run by the real CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { packMeta } from '../src/cli/serve.mjs';
import { overlaySession } from '../src/core/overlay_session.mjs';
import { projectPack } from '../src/core/pack.mjs';
import { backend, FIXTURES, ENGINE_ROOT } from '../scripts/golden-trees.mjs';
import { sqlLaneVenv } from './helpers/lane_prereqs.mjs';
import {
  analyzedProject, assertSameGraph, commitAll, git, layOver, preflight, providerOf, write,
} from './helpers/overlay_trees.mjs';

const SERVICE = 'src/main/java/com/example/service/ThingService.java';
const appendComment = (repo, rel) => fs.appendFileSync(path.join(repo, rel), '// an unrelated comment\n');

// ---------------------------------------------------------------------------
// the catalog: a DDL outside the analyzed root, a re-fetched snapshot (N4)
// ---------------------------------------------------------------------------

test('overlay_declines_when_ddl_outside_root_changed: a schema outside the root that changed since the pack declines, edited file or not', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'ddl-outside', {
    build: (base, repo) => {
      backend(repo);
      fs.renameSync(path.join(repo, 'db'), path.join(base, 'db'));
      commitAll(repo);
    },
    flags: (base) => ['--no-mappers', '--ddl', path.join(base, 'db', 'schema.sql')],
  });
  const schema = path.join(p.base, 'db', 'schema.sql');
  fs.writeFileSync(schema, fs.readFileSync(schema, 'utf8').replace('`name` varchar(64)', '`email` varchar(64), `secret` varchar(64)'));
  appendComment(p.repo, SERVICE);
  const { state } = layOver(p, [{ path: SERVICE, status: 'M' }]);
  assert.equal(state.applied, false, 'no overlay over a catalog the pack did not read');
  assert.equal(state.state, 'declined');
  assert.match(state.reason, /\.\.\/db\/schema\.sql/);
  assert.match(state.reason, /changed since this pack was built/);
  // Through the provider, with the Java edit undone: still not "clean".
  fs.writeFileSync(path.join(p.repo, SERVICE), git(p.repo, 'show', `HEAD:${SERVICE}`));
  const noEdit = providerOf(p).call();
  assert.equal(noEdit.state, 'declined', 'a tree whose outside schema moved is not the certified base');
  assert.match(noEdit.limits[0].reason, /\.\.\/db\/schema\.sql/);
});

test('a pinned catalog snapshot fetched again since the pack declines the overlay, and a memo over the old one is not reused', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const { python } = sqlLaneVenv();
  const p = analyzedProject(t, 'snapshot', {
    build: (base, repo) => { backend(repo); commitAll(repo); },
    flags: () => ['--no-mappers'],
    afterInit: (repo) => {
      const records = execFileSync(python, [path.join(ENGINE_ROOT, 'adapters', 'sql', 'catalog_ddl.py'), '--identifier-case', 'fold-lower', path.join(repo, 'db', 'schema.sql')]);
      write(repo, '.cascade/catalog/columns.jsonl', records.toString('utf8'));
      const file = path.join(repo, '.cascade', 'profile.json');
      const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
      profile.catalog = { ...(profile.catalog ?? {}), source: 'jdbc' };
      fs.writeFileSync(file, JSON.stringify(profile, null, 2));
    },
  });
  appendComment(p.repo, SERVICE);
  const provider = providerOf(p);
  assert.equal(provider.call().applied, true, 'the overlay lays over the snapshot the pack read');
  const snap = path.join(p.repo, '.cascade', 'catalog', 'columns.jsonl');
  fs.writeFileSync(snap, fs.readFileSync(snap, 'utf8').split('\n').filter((l) => !(l.includes('"thing"') && l.includes('"name"'))).join('\n'));
  const after = provider.call();
  assert.equal(after.applied, false, 'the same provider does not answer from the overlay it built over the old snapshot');
  assert.match(after.reason, /catalog snapshot .*changed since this pack was built/);
});

// ---------------------------------------------------------------------------
// the ports: a Java edit that loads configuration (N5)
// ---------------------------------------------------------------------------

test('overlay_java_edit_adding_property_source_says_ports_not_reread', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'propsource', {
    build: (base, repo) => {
      backend(repo);
      write(repo, 'src/main/resources/application.yml', 'server:\n  port: 8081\n');
      fs.cpSync(path.join(FIXTURES, 'web-smoke'), path.join(repo, 'front'), { recursive: true });
      commitAll(repo);
    },
    flags: (base, repo) => ['--web-src', path.join(repo, 'front', 'src'), '--no-mappers'],
  });
  const file = path.join(p.repo, SERVICE);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('@Service', '@PropertySource("classpath:extra.properties")\n@Service'));
  const { state } = layOver(p, [{ path: SERVICE, status: 'M' }]);
  assert.equal(state.applied, true);
  const said = state.limits.find((l) => l.reason.includes(SERVICE));
  assert.ok(said, `a limit names the edit: ${JSON.stringify(state.limits)}`);
  assert.match(said.reason, /by the ports the base pack read \(port 8081\) and does not read them again/);
  // A comment that only mentions it is not configuration, and says nothing.
  fs.writeFileSync(file, git(p.repo, 'show', `HEAD:${SERVICE}`).replace('@Service', '// @PropertySource("classpath:extra.properties")\n@Service'));
  assert.deepEqual(layOver(p, [{ path: SERVICE, status: 'M' }]).state.limits, []);
});

test('overlay_property_source_file_edit_says_ports_not_reread: a file a @PropertySource loads that now sets the port is said', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'ps-file', {
    build: (base, repo) => {
      backend(repo);
      write(repo, 'src/main/resources/application.yml', 'server:\n  port: 8081\n');
      write(repo, 'src/main/resources/extra.properties', 'app.greeting=hello\n');
      const service = path.join(repo, SERVICE);
      fs.writeFileSync(service, fs.readFileSync(service, 'utf8').replace('@Service', '@PropertySource("classpath:extra.properties")\n@Service'));
      fs.cpSync(path.join(FIXTURES, 'web-smoke'), path.join(repo, 'front'), { recursive: true });
      commitAll(repo);
    },
    flags: (base, repo) => ['--web-src', path.join(repo, 'front', 'src'), '--no-mappers'],
  });
  const extra = 'src/main/resources/extra.properties';
  fs.appendFileSync(path.join(p.repo, extra), 'server.port=9090\n');
  const { state } = layOver(p, [{ path: extra, status: 'M' }]);
  assert.equal(state.applied, true, state.reason);
  const said = state.limits.find((l) => l.reason.includes(extra));
  assert.ok(said, `a limit names the file: ${JSON.stringify(state.limits)}`);
  assert.match(said.reason, /does not read them again/);
  // A file that says nothing of the port says nothing here either.
  fs.writeFileSync(path.join(p.repo, extra), 'app.greeting=bonjour\n');
  assert.deepEqual(layOver(p, [{ path: extra, status: 'M' }]).state.limits, []);
});

// ---------------------------------------------------------------------------
// R12: the mapper alternatives, a frontend repository, the profile
// ---------------------------------------------------------------------------

const MAPPER_XML = (col) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.UserMapper">
  <select id="selectById" resultType="string">SELECT ${col} FROM t_user WHERE id = #{id}</select>
</mapper>
`;

/** One MyBatis mapper shipped twice, for MySQL and for Oracle: `init` records the Oracle copy as an alternative. */
function vendorMapperTree(base, repo) {
  const J = 'src/main/java/com/example/';
  write(repo, 'pom.xml', '<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>y</artifactId><version>1</version></project>\n');
  write(repo, `${J}UserController.java`, 'package com.example;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping("/users")\npublic class UserController {\n  private final UserService service;\n  public UserController(UserService service) { this.service = service; }\n  @GetMapping("/{id}")\n  public String find(@PathVariable String id) { return service.find(id); }\n}\n');
  write(repo, `${J}UserService.java`, 'package com.example;\nimport org.springframework.stereotype.Service;\n@Service\npublic class UserService {\n  private final UserMapper mapper;\n  public UserService(UserMapper mapper) { this.mapper = mapper; }\n  public String find(String id) { return mapper.selectById(id); }\n}\n');
  write(repo, `${J}UserMapper.java`, 'package com.example;\nimport org.apache.ibatis.annotations.Mapper;\n@Mapper\npublic interface UserMapper { String selectById(String id); }\n');
  write(repo, 'src/main/resources/mapper/UserMapper_mysql.xml', MAPPER_XML('name'));
  write(repo, 'src/main/resources/mapper/UserMapper_oracle.xml', MAPPER_XML('nick'));
  write(repo, 'src/main/resources/application.properties', 'spring.datasource.url=jdbc:mysql://localhost:3306/app\n');
  write(repo, 'db/schema.sql', 'CREATE TABLE t_user (id varchar(32) NOT NULL, name varchar(64), nick varchar(64), PRIMARY KEY (id));\n');
  commitAll(repo);
}

test('overlay_over_no_edit_skips_mapper_alternatives_like_analyze: the alternatives resolve against .cascade, as analyze reads them', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'mapper-alt', { build: vendorMapperTree });
  const profile = JSON.parse(fs.readFileSync(path.join(p.repo, '.cascade', 'profile.json'), 'utf8'));
  assert.deepEqual(Object.keys(profile.mappers?.alternatives ?? {}), ['oracle'], 'init recorded the Oracle copy as an alternative');
  const r = layOver(p);
  assert.ok(r.pack.edges.some((e) => e.type === 'READS' && e.to === 'column:t_user.name'), 'the run read the MySQL copy');
  assert.ok(!r.pack.edges.some((e) => e.type === 'READS' && e.to === 'column:t_user.nick'), 'and left the Oracle copy out');
  assertSameGraph(r);
});

test('overlay_frontend_repo_commit_after_pack_is_stale: a frontend repository that moved on since the pack discards the overlay, and the memo with it', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'front-commit', {
    build: (base, repo) => {
      backend(repo);
      commitAll(repo);
      fs.cpSync(path.join(FIXTURES, 'web-smoke'), path.join(base, 'front'), { recursive: true });
      commitAll(path.join(base, 'front'));
    },
    flags: (base) => ['--web-src', path.join(base, 'front', 'src'), '--no-mappers'],
  });
  appendComment(p.repo, 'src/main/java/com/example/web/ThingController.java');
  const provider = providerOf(p);
  assert.equal(provider.call().applied, true, 'with the frontend where the pack read it, the overlay lays');
  const front = path.join(p.base, 'front');
  const orders = path.join(front, 'src', 'api', 'orders.js');
  fs.writeFileSync(orders, fs.readFileSync(orders, 'utf8').replace("'/orders/' + id", "'/things/' + id"));
  git(front, 'commit', '-qam', 'the frontend moves on');
  const after = provider.call();
  assert.equal(after.applied, false);
  assert.equal(after.state, 'stale-commit', 'a moved frontend is the same verdict as a moved backend: behind');
  assert.match(after.reason, /the frontend repository at \.\.\/front/);
});

/** A frontend in a repository of its own beside the analyzed root, with orders.js edited and not committed. */
function dirtyOutsideFront(base, repo) {
  backend(repo);
  commitAll(repo);
  const front = path.join(base, 'front');
  fs.cpSync(path.join(FIXTURES, 'web-smoke'), front, { recursive: true });
  commitAll(front);
  const orders = path.join(front, 'src', 'api', 'orders.js');
  fs.writeFileSync(orders, fs.readFileSync(orders, 'utf8').replace("'/orders/' + id", "'/things/' + id"));
}

const ORDERS = '../front/src/api/orders.js';
const callsFromOrders = (edges) => edges.filter((e) => e.type === 'CALLS_HTTP' && e.from.includes('orders.js')).map((e) => e.to);

test('outside_frontend_dirty_at_analyze_is_recorded_and_its_revert_is_seen: the edit the pack read is its base, and undoing it is an edit', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'front-dirty', {
    build: dirtyOutsideFront,
    flags: (base) => ['--web-src', path.join(base, 'front', 'src'), '--no-mappers'],
  });
  const pack = JSON.parse(fs.readFileSync(path.join(p.packDir, 'pack.json'), 'utf8'));
  // Recorded: the pack read a working tree, not a commit, and says which file.
  assert.equal(pack.meta.base.dirty, true, 'a pack that read an uncommitted frontend edit is provisional');
  assert.deepEqual(pack.meta.base.dirtyFiles, [ORDERS]);
  assert.ok(callsFromOrders(pack.edges).some((to) => to.includes('/things/')), `the pack read the edit: ${callsFromOrders(pack.edges)}`);
  const baseline = JSON.parse(fs.readFileSync(path.join(p.repo, '.cascade', 'calibration', 'baseline.json'), 'utf8'));
  assert.equal(baseline.pin.dirty, true, 'the pin says the tree was dirty');
  // The edit undone: not "clean". The file the pack read dirty is read again, as a backend file is.
  git(path.join(p.base, 'front'), 'checkout', '--', '.');
  const s = providerOf(p).call();
  assert.notEqual(s.state, 'clean', 'the working tree no longer holds what the pack read');
  assert.equal(s.applied, true, s.reason);
  assert.ok(s.dirtyFiles.includes(ORDERS), `the reverted file is re-read: ${s.dirtyFiles}`);
  const laid = callsFromOrders(projectPack(s.graph, {}).edges);
  assert.ok(laid.includes('endpoint:GET /orders/{id}') && !laid.some((to) => to.includes('/things/')), `the answer is the reverted call: ${laid}`);
  // An incremental analyze reads the file again, and a cold one of the reverted tree is another target
  // for the gate, not the same one measured twice.
  for (const mode of ['--incremental', '--cold']) {
    p.run(['analyze', '--root', p.repo, '--project', 'ovl-front-dirty', mode, '--web-src', path.join(p.base, 'front', 'src'), '--no-mappers']);
    const after = JSON.parse(fs.readFileSync(path.join(p.packDir, 'pack.json'), 'utf8'));
    assert.equal(after.meta.base.dirty, false, mode);
    assert.ok(!callsFromOrders(after.edges).some((to) => to.includes('/things/')), `${mode}: the reverted call is gone`);
  }
});

test('overlay_frontend_repo_nested_in_root_is_behind_or_said: a frontend repository inside the analyzed root is read as one of its own', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'front-nested', {
    build: (base, repo) => {
      backend(repo);
      write(repo, '.gitignore', 'front/\n');
      commitAll(repo);
      fs.cpSync(path.join(FIXTURES, 'web-smoke'), path.join(repo, 'front'), { recursive: true });
      commitAll(path.join(repo, 'front'));
    },
    flags: (base, repo) => ['--web-src', path.join(repo, 'front', 'src'), '--no-mappers'],
  });
  const front = path.join(p.repo, 'front');
  const orders = path.join(front, 'src', 'api', 'orders.js');
  fs.writeFileSync(orders, fs.readFileSync(orders, 'utf8').replace("'/orders/' + id", "'/things/' + id"));
  // An edit there, not committed: seen, as an edit in a frontend beside the root is.
  const edited = providerOf(p).call();
  assert.equal(edited.applied, true, edited.reason);
  assert.ok(edited.dirtyFiles.includes('front/src/api/orders.js'), `the nested edit is read: ${edited.dirtyFiles}`);
  // Committed there: the frontend moved on, and the overlay is behind, as for a moved backend.
  git(front, 'commit', '-qam', 'the nested frontend moves on');
  const moved = providerOf(p).call();
  assert.equal(moved.applied, false);
  assert.equal(moved.state, 'stale-commit', moved.reason);
  assert.match(moved.reason, /the frontend repository at front\/src/);
});

test('cli_impact_over_declined_overlay_says_the_decline: the command line says why the overlay was not laid, not that nothing changed', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'cli-declined', { build: (base, repo) => { backend(repo); commitAll(repo); }, flags: () => ['--no-mappers'] });
  const file = path.join(p.repo, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  profile.pathPrefixes = [{ prefix: '/api', packages: 'com.example.**', annotation: 'RestController' }];
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  let said = '';
  try { p.run(['impact', '--root', p.repo]); } catch (e) { said = e.message; }
  assert.match(said, /declined/, said.slice(-600));
  assert.match(said, /is not the one this pack was built with/);
  assert.doesNotMatch(said, /no changed files/);
});

test('cli_impact_names_route_the_edit_removed: a route the edit took away is printed, as the tool answer carries it', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'cli-removed', { build: (base, repo) => { backend(repo); commitAll(repo); }, flags: () => ['--no-mappers'] });
  const file = path.join(p.repo, 'src/main/java/com/example/web/OrderController.java');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('@GetMapping("/{id}")', '@GetMapping("/one/{id}")'));
  const out = p.run(['impact', '--root', p.repo]);
  assert.match(out, /routes the edit removed \(1\):\n {2}endpoint:GET \/orders\/\{id\}/, out);
});

test('frontend_repo_commit_repins_instead_of_rejecting: a frontend repository at another commit is another target for the gate', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'front-repin', {
    build: (base, repo) => {
      backend(repo);
      commitAll(repo);
      fs.cpSync(path.join(FIXTURES, 'web-smoke'), path.join(base, 'front'), { recursive: true });
      commitAll(path.join(base, 'front'));
    },
    flags: (base) => ['--web-src', path.join(base, 'front', 'src'), '--no-mappers'],
  });
  const front = path.join(p.base, 'front');
  const orders = path.join(front, 'src', 'api', 'orders.js');
  fs.writeFileSync(orders, fs.readFileSync(orders, 'utf8').replace("'/orders/' + id", "'/things/' + id"));
  git(front, 'commit', '-qam', 'the frontend moves on');
  // Refused before: same backend commit, same pin, different measurements, read as nondeterminism.
  p.run(['analyze', '--root', p.repo, '--project', 'ovl-front-repin', '--web-src', path.join(front, 'src'), '--no-mappers']);
  const gate = JSON.parse(fs.readFileSync(path.join(p.repo, '.cascade', 'calibration', 'gate-state.json'), 'utf8'));
  assert.notEqual(gate.mode, 'NO_CHANGE', 'a frontend at another commit is another pin');
  assert.notEqual(gate.verdict, 'RED', JSON.stringify(gate.findings ?? []).slice(0, 400));
});

test('overlay_profile_changed_since_pack_is_declined_or_limited: a profile edited since the pack declines, with an edit and without one', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'profile-drift', { build: (base, repo) => { backend(repo); commitAll(repo); }, flags: () => ['--no-mappers'] });
  const file = path.join(p.repo, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  profile.pathPrefixes = [{ prefix: '/api', packages: 'com.example.**', annotation: 'RestController' }];
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  const clean = providerOf(p).call();
  assert.equal(clean.state, 'declined', 'a clean tree over a changed profile is not the certified base either');
  assert.match(clean.reason, /the profile .*profile\.json.* is not the one this pack was built with/);
  appendComment(p.repo, SERVICE);
  const edited = layOver(p, [{ path: SERVICE, status: 'M' }]).state;
  assert.equal(edited.applied, false, 'no endpoint moves to /api because of an unrelated edit');
  assert.match(edited.reason, /is not the one this pack was built with/);
});

// ---------------------------------------------------------------------------
// R12: an OpenAPI-only edit reports the route it moved
// ---------------------------------------------------------------------------

const ITEM_CONTROLLER = `package com.example.web;

import com.example.api.ItemApi;
import com.example.domain.Thing;
import com.example.service.ThingService;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ItemController implements ItemApi {
  private final ThingService service;

  public ItemController(ThingService service) {
    this.service = service;
  }

  @Override
  public Thing getItem(Long id) {
    return service.byId(id);
  }
}
`;

test('overlay_openapi_edit_reports_moved_route: the edited document is matched, the route it moved to is touched and the one it left is said', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const p = analyzedProject(t, 'openapi-edit', {
    build: (base, repo) => {
      backend(repo, { extraJava: { 'web/ItemController.java': ITEM_CONTROLLER } });
      fs.mkdirSync(path.join(repo, 'api'), { recursive: true });
      fs.cpSync(path.join(FIXTURES, 'openapi', 'shop.yaml'), path.join(repo, 'api', 'shop.yaml'));
      commitAll(repo);
    },
    flags: (base, repo) => ['--no-mappers', '--openapi', path.join(repo, 'api', 'shop.yaml')],
  });
  const doc = 'api/shop.yaml';
  fs.writeFileSync(path.join(p.repo, doc), fs.readFileSync(path.join(p.repo, doc), 'utf8').replace('  /item/get:', '  /item/fetch:'));
  const r = layOver(p, [{ path: doc, status: 'M' }]);
  assert.equal(r.state.applied, true);
  const ctx = {
    graph: r.baseGraph, overlay: () => r.state, limits: [], pack: packMeta(r.pack),
    basis: { project: 'openapi-edit', buildDigest: r.pack.digest, builtAt: null, freshness: { verdict: 'unknown' } },
    trust: computeTrust({ packDigest: r.pack.digest }),
  };
  const resp = callTool('changed_impact', { files: [doc] }, ctx);
  const a = resp.answer;
  assert.deepEqual(a.files.matched, [doc], 'the document is matched, not "impact unknown"');
  assert.ok(a.touched.endpoints.includes('GET /api/item/fetch'), `the route it moved to is touched: ${JSON.stringify(a.touched.endpoints)}`);
  assert.ok(a.upstreamEndpoints.some((e) => e.id === 'GET /api/item/fetch' && e.provisional === true), 'and new: only the overlay has it');
  assert.deepEqual(a.overlay.removedIds.endpoints, ['endpoint:GET /api/item/get'], 'and the route it left is said, as the provisional ones are');
});

// ---------------------------------------------------------------------------
// the session id
// ---------------------------------------------------------------------------

test('the overlay session id holds the base inputs: the same dirty bytes over another input are another session', () => {
  const at = { baseDigest: 'd'.repeat(12), baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), dirtyFiles: [{ path: 'x.java', sha256: 'f'.repeat(64) }] };
  const plain = overlaySession(at).overlaySessionId;
  assert.equal(overlaySession({ ...at, inputs: null }).overlaySessionId, plain, 'no inputs is the id it always was');
  const one = overlaySession({ ...at, inputs: { profile: 'p1', catalog: 'c1' } }).overlaySessionId;
  assert.notEqual(one, plain);
  assert.notEqual(overlaySession({ ...at, inputs: { profile: 'p2', catalog: 'c1' } }).overlaySessionId, one);
  assert.equal(overlaySession({ ...at, inputs: { catalog: 'c1', profile: 'p1' } }).overlaySessionId, one, 'in any key order');
});

