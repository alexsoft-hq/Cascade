// openapi_declared.test.mjs — a person says what the source cannot: this OpenAPI document and this code are in step (RM67-O5).
//
// Two readings put a handler under a route through an OpenAPI document, and
// both are HEURISTIC because nothing in the tree says the document is current:
//
//   * a Spring functional route mounted by code elsewhere is placed where a
//     document declares the operation id it names (halo, springdoc writes the
//     document from the running code);
//   * a controller implementing an interface a generator writes from the
//     document is paired with it by the generator's naming (spring-petclinic-rest,
//     openapi-generator writes the interfaces from the document).
//
// The profile now says it, one way for each direction:
//   openapi.generatedFromCode  documents a build writes from this code as it is now
//   openapi.generatesCode      documents this code's interfaces are generated from
// With the key, the link is graded as the rest of its evidence allows and its
// evidence names the declaration; without it, nothing changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { loadPack } from '../src/core/pack.mjs';
import { assembleGraph } from '../src/core/assemble.mjs';
import { assembleJavaFacts } from '../src/core/facts_store.mjs';
import { overlayGraph } from '../src/core/overlay.mjs';
import { openapiDeclarationsOf } from '../src/core/lanes.mjs';
import {
  KEYS_DIGESTED_WHEN_SET, PROFILE_KEY_CONSUMERS, digestedProfile, normalizeProfile, validateProfile,
} from '../src/core/profile.mjs';
import { profileDigestOf } from '../src/core/calibration.mjs';
import { DIAGNOSTIC_REMEDIES, REMEDY_EXAMPLES, diagnosticRemedy, gapRemedy, routeRemedy } from '../src/core/remedies.mjs';
import { readOpenApiDocument, addOpenApiRoutes, withDeclarations } from '../src/adapters/openapi_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane, LANE_BRIDGES } from '../src/cli/lanes_run.mjs';
import { openApiDocumentsOf } from '../src/cli/overlay_provider.mjs';
import { readOpenApiDocs } from '../src/cli/commands/analyze/lanes.mjs';
import { documentGuessNotes } from '../src/cli/commands/analyze/census.mjs';
import { overview } from '../src/mcp/tools.mjs';
import { sqlLaneVenv } from './helpers/lane_prereqs.mjs';

const CLI = fileURLToPath(new URL('../bin/cascade.mjs', import.meta.url));
const FROM_CODE = 'openapi.generatedFromCode';
const GENERATES = 'openapi.generatesCode';

// ---------------------------------------------------------------------------
// the profile keys
// ---------------------------------------------------------------------------

test('openapi.generatedFromCode and openapi.generatesCode: lists of documents, empty by default, refused when they are not paths or name one document both ways', () => {
  const p = normalizeProfile({});
  assert.deepEqual([p.openapi.generatedFromCode, p.openapi.generatesCode], [[], []]);
  const ok = normalizeProfile({ openapi: { documents: ['../api.json'], generatedFromCode: ['../api.json'], generatesCode: ['../src/main/resources/openapi.yml'] } });
  assert.doesNotThrow(() => validateProfile(ok));
  for (const [bad, why] of [
    [{ openapi: { generatedFromCode: '../api.json' } }, /profile\.openapi\.generatedFromCode must be an array of non-empty paths/],
    [{ openapi: { generatesCode: [''] } }, /profile\.openapi\.generatesCode must be an array of non-empty paths/],
    [{ openapi: { generatesCode: [3] } }, /profile\.openapi\.generatesCode must be an array of non-empty paths/],
    [{ openapi: { generatedFromCode: ['../a.yml'], generatesCode: ['../a.yml'] } }, /"\.\.\/a\.yml" is in both openapi\.generatedFromCode and openapi\.generatesCode/],
    // Two spellings of the one path, compared the way lanes.mjs resolves them (RM67-F5): a
    // leading "./", and ".." folded back on itself, used to pass because only an exact
    // string match was refused, and the document then counted as only one of the two.
    [{ openapi: { generatedFromCode: ['./a.json'], generatesCode: ['a.json'] } }, /"\.\/a\.json" \(openapi\.generatedFromCode\) and "a\.json" \(openapi\.generatesCode\) name the same document/],
    [{ openapi: { generatedFromCode: ['a.json'], generatesCode: ['docs/../a.json'] } }, /"a\.json" \(openapi\.generatedFromCode\) and "docs\/\.\.\/a\.json" \(openapi\.generatesCode\) name the same document/],
  ]) {
    assert.throws(() => validateProfile(normalizeProfile(bad)), (e) => e.name === 'ProfileError' && why.test(e.message), JSON.stringify(bad));
  }
  // Two different documents that merely sit near each other are not refused.
  assert.doesNotThrow(() => validateProfile(normalizeProfile(
    { openapi: { generatedFromCode: ['docs/../a.json'], generatesCode: ['./docs/a.json'] } },
  )));
});

test('at their default the profile digest is what it was before the keys existed, and each is a consumed key', () => {
  for (const key of [FROM_CODE, GENERATES]) {
    assert.ok(KEYS_DIGESTED_WHEN_SET.includes(key), key);
    assert.equal(PROFILE_KEY_CONSUMERS[key].status, 'consumed');
  }
  assert.deepEqual(digestedProfile(normalizeProfile({})).openapi, { documents: [] }, 'the openapi block as it was digested before');
  const docs = normalizeProfile({ openapi: { documents: ['../api.yml'] } });
  assert.deepEqual(digestedProfile(docs).openapi, { documents: ['../api.yml'] });
  const declared = normalizeProfile({ openapi: { documents: ['../api.yml'], generatesCode: ['../api.yml'] } });
  assert.deepEqual(digestedProfile(declared).openapi, { documents: ['../api.yml'], generatesCode: ['../api.yml'] });
  assert.notEqual(profileDigestOf(declared), profileDigestOf(docs), 'a declaration is a change of the profile the gate pins');
});

test('a declaration names a document by its path from the manifest, as openapi.documents does, and is matched by its path from the root', () => {
  const root = '/r/app';
  const got = openapiDeclarationsOf(normalizeProfile({ openapi: { generatedFromCode: ['../api-docs/a.json'], generatesCode: ['../src/main/resources/openapi.yml'] } }), { root, manifestDir: '/r/app/.cascade' });
  assert.deepEqual([...got], [['api-docs/a.json', FROM_CODE], ['src/main/resources/openapi.yml', GENERATES]]);
  assert.deepEqual([...openapiDeclarationsOf(normalizeProfile({}), { root, manifestDir: '/r/app/.cascade' })], []);
  const docs = [{ path: 'api-docs/a.json', paths: [] }, { path: 'api-docs/b.json', paths: [] }];
  const stamped = withDeclarations(docs, got);
  assert.deepEqual(stamped.map((d) => d.declaration ?? null), [FROM_CODE, null]);
  assert.equal(docs[0].declaration, undefined, 'the documents read are not changed in place');
});

// ---------------------------------------------------------------------------
// a contract link on a document declared to generate this code
// ---------------------------------------------------------------------------

const type = (fqn, over = {}) => ({
  kind: 'type', fqn, package: fqn.slice(0, fqn.lastIndexOf('.')), typeKind: 'class', abstract: false,
  implements: [], implementsArgs: [], extends: null, extendsArgs: [], typeParams: [], declaredMethods: [],
  file: `src/main/java/${fqn.replace(/\./g, '/')}.java`, ...over,
});
const imported = (owner, fqn) => ({ kind: 'import', owner, simple: fqn.slice(fqn.lastIndexOf('.') + 1), fqn, file: `src/main/java/${owner.replace(/\./g, '/')}.java` });
const controller = (fqn, iface, methods) => [
  imported(fqn, `p.api.${iface}`),
  type(fqn, { annotations: ['RestController'], implements: [iface], implementsArgs: [[]], declaredMethods: methods.map((m) => `${m}/1`) }),
];

/**
 * spring-petclinic-rest's shape, with one pairing the naming cannot settle: `countOwners`
 * is tagged pets and lives under /owners, so OwnersApi holds it only when the build
 * names interfaces by path, while other operations name OwnersApi by their tag.
 */
const PETCLINIC = 'openapi: 3.0.1\nservers:\n  - url: /petclinic/api\npaths:\n'
  + '  /owners:\n    get:\n      tags: [owners]\n      operationId: listOwners\n'
  + '  /owners/count:\n    get:\n      tags: [pets]\n      operationId: countOwners\n'
  + '  /v2/owners:\n    get:\n      tags: [owner-v2]\n      operationId: listOwnersPage\n';
const petclinicFacts = () => [
  ...controller('p.web.OwnerController', 'OwnersApi', ['listOwners', 'countOwners']),
  ...controller('p.web.OwnerPageController', 'OwnerV2Api', ['listOwnersPage']),
];
const SPEC = 'src/main/resources/openapi.yml';
const spec = (declared) => {
  const d = readOpenApiDocument(PETCLINIC, { path: SPEC });
  return declared ? withDeclarations([d], new Map([[SPEC, GENERATES]])) : [d];
};
const handles = (g) => Object.fromEntries(g.edges.filter((e) => e.type === 'HANDLES').map((e) => [e.to.slice('symbol:'.length), e]));

test('without the declaration a contract link is what it was: HEURISTIC, on the evidence it had, and the census counts it as resting on no declaration', () => {
  const g = new Graph();
  const stats = addOpenApiRoutes(g, spec(false), { java: {}, javaFacts: petclinicFacts() }).contractLinks;
  const got = handles(g);
  assert.deepEqual(Object.values(got).map((e) => e.grade), ['HEURISTIC', 'HEURISTIC', 'HEURISTIC']);
  assert.deepEqual(Object.keys(got['p.web.OwnerController#listOwners'].evidence).sort(), ['basis', 'documents', 'generator', 'interface', 'match', 'operationId', 'rule']);
  assert.equal(stats.undeclared, 3);
  assert.equal('declared' in stats, false);
});

test('on a document declared to generate this code, a contract link is graded as the method it names, and names the declaration', () => {
  const g = new Graph();
  const stats = addOpenApiRoutes(g, spec(true), { java: {}, javaFacts: petclinicFacts() }).contractLinks;
  const got = handles(g);
  const list = got['p.web.OwnerController#listOwners'];
  assert.equal(list.grade, 'EXACT', 'OwnersApi is the name both of the generator\'s namings give listOwners');
  assert.deepEqual(list.evidence.declared, { key: GENERATES, document: SPEC });
  assert.match(list.evidence.basis, /The profile declares that the build generates this code's interfaces from the document \(openapi\.generatesCode\)/);
  // OwnerV2Api: only a tag gives any operation that name, so a build that wrote it names interfaces by tag.
  assert.equal(got['p.web.OwnerPageController#listOwnersPage'].grade, 'EXACT');
  // countOwners is in OwnersApi only when the build names by path, and listOwners gives OwnersApi by tag too: not settled.
  const count = got['p.web.OwnerController#countOwners'];
  assert.equal(count.grade, 'HEURISTIC');
  assert.deepEqual(count.evidence.declared, { key: GENERATES, document: SPEC });
  assert.match(count.evidence.naming, /gets the name OwnersApi from its path, and other operations get it from their tag: which one the build names interfaces by is a setting of the generator this engine does not read/);
  assert.equal(stats.undeclared, 0);
  assert.deepEqual(stats.declared, {
    key: GENERATES, links: 2,
    endpoints: ['endpoint:GET /petclinic/api/owners', 'endpoint:GET /petclinic/api/v2/owners'],
    unsettled: [{ endpoint: 'endpoint:GET /petclinic/api/owners/count', handler: 'p.web.OwnerController#countOwners', interface: 'p.api.OwnersApi' }],
  });
});

test('a document declared the other way, generated FROM this code, does not settle a contract link', () => {
  const g = new Graph();
  const d = withDeclarations([readOpenApiDocument(PETCLINIC, { path: SPEC })], new Map([[SPEC, FROM_CODE]]));
  addOpenApiRoutes(g, d, { java: {}, javaFacts: petclinicFacts() });
  assert.deepEqual(Object.values(handles(g)).map((e) => [e.grade, e.evidence.declared ?? null]), [['HEURISTIC', null], ['HEURISTIC', null], ['HEURISTIC', null]]);
});

test('the working-tree overlay grades a declared contract link as analyze does', () => {
  const file = 'src/main/java/p/web/OwnerController.java';
  const baseShards = new Map([[file, petclinicFacts()]]);
  const documents = spec(true);
  const base = assembleGraph({ bridges: LANE_BRIDGES, javaFacts: assembleJavaFacts(baseShards), openapiDocuments: documents, java: {}, openapi: {} }).graph;
  const r = overlayGraph({ bridges: LANE_BRIDGES, baseShards, dirtyFiles: [], baseGraph: base, overlaySessionId: 'e'.repeat(64), openapiDocuments: documents });
  const grades = (g) => Object.entries(handles(g)).map(([k, e]) => [k, e.grade]).sort();
  assert.deepEqual(grades(r.graph), grades(base));
  assert.equal(handles(base)['p.web.OwnerController#listOwners'].grade, 'EXACT');

  // The provider stamps the documents it reads again with the profile's declarations.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-declared-docs-'));
  try {
    fs.mkdirSync(path.join(root, 'api'));
    fs.writeFileSync(path.join(root, 'api', 'spec.yml'), PETCLINIC);
    const pack = { meta: { laneStats: { openapi: { documents: [{ path: 'api/spec.yml' }] } } } };
    assert.deepEqual(openApiDocumentsOf(pack, root, new Map([['api/spec.yml', GENERATES]])).map((d) => [d.path, d.declaration]), [['api/spec.yml', GENERATES]]);
    assert.equal(openApiDocumentsOf(pack, root)[0].declaration, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// a functional route placed by a declared document's operation id
// ---------------------------------------------------------------------------

const ROUTES = {
  'PostEndpoint.java': `package com.example;
import org.springdoc.webflux.core.fn.SpringdocRouteBuilder;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

public class PostEndpoint {
    private final PostHandler handler;
    PostEndpoint(PostHandler handler) { this.handler = handler; }
    public RouterFunction<ServerResponse> endpoint() {
        return SpringdocRouteBuilder.route()
            .GET("posts", this::listPost, b -> b.operationId("ListPosts"))
            .GET("posts/{name}", handler::show, b -> b.operationId("GetPost"))
            .build();
    }
    Object listPost(Object r) { return null; }
}
`,
  'PostHandler.java': `package com.example;
public class PostHandler { public Object show(Object r) { return null; } }
`,
};

/** The document springdoc writes from this code; `declared` stamps it as the profile's openapi.generatedFromCode would. */
const consoleDocs = (declared) => {
  const d = {
    path: 'api-docs/console.json', version: '3', basePath: '', unreadable: [],
    paths: [
      { method: 'GET', path: '/apis/console/v1/posts', operationId: 'ListPosts', summary: null, tags: [] },
      { method: 'GET', path: '/apis/console/v1/posts/{name}', operationId: 'GetPost', summary: null, tags: [] },
    ],
  };
  return declared ? withDeclarations([d], new Map([[d.path, declared]])) : [d];
};

let routeFacts;
function needRouteFacts(t) {
  if (routeFacts === undefined) {
    const jdk = findJdk();
    routeFacts = null;
    if (jdk) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-declared-routes-'));
      fs.mkdirSync(path.join(dir, 'com', 'example'), { recursive: true });
      for (const [name, body] of Object.entries(ROUTES)) fs.writeFileSync(path.join(dir, 'com', 'example', name), body);
      try { routeFacts = runJavaLane(jdk, dir, [dir], { quiet: true }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
  if (!routeFacts) t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md');
  return routeFacts;
}

const routeHandles = (g, ep) => g.edges.filter((e) => e.type === 'HANDLES' && e.from === ep);

test('without the declaration a route placed by a document\'s operation id stays a guess, on the evidence it had', (t) => {
  const f = needRouteFacts(t);
  if (!f) return;
  const g = new Graph();
  const stats = addJavaFacts(g, f, { openapiDocuments: consoleDocs(null) }).functionalRoutes;
  const [list] = routeHandles(g, 'endpoint:GET /apis/console/v1/posts');
  assert.equal(list.grade, 'HEURISTIC');
  assert.equal('declared' in list.evidence, false);
  assert.match(list.evidence.basis, /the match is a convention, so the link is a guess/);
  assert.deepEqual([stats.mountedByOperationId, stats.mountedByDeclaredDocument], [2, 0]);
});

test('on a document declared generated from this code, a route placed by its operation id is graded as its handler, and names the declaration', (t) => {
  const f = needRouteFacts(t);
  if (!f) return;
  const g = new Graph();
  const stats = addJavaFacts(g, f, { openapiDocuments: consoleDocs(FROM_CODE) }).functionalRoutes;
  const [list] = routeHandles(g, 'endpoint:GET /apis/console/v1/posts');
  assert.deepEqual([list.to, list.grade], ['symbol:com.example.PostEndpoint#listPost', 'EXACT'], 'this::listPost names the method');
  assert.deepEqual(list.evidence.declared, { key: FROM_CODE, document: 'api-docs/console.json' });
  assert.equal(list.evidence.mount, 'operation-id');
  assert.match(list.evidence.basis, /the profile declares that document generated from this code as it is now \(openapi\.generatedFromCode\)/);
  const [show] = routeHandles(g, 'endpoint:GET /apis/console/v1/posts/{name}');
  assert.deepEqual([show.to, show.grade], ['symbol:com.example.PostHandler#show', 'SOUND_SET'], 'through a field\'s declared type: a candidate set');
  assert.deepEqual([stats.mountedByOperationId, stats.mountedByDeclaredDocument], [2, 2]);
  assert.deepEqual(stats.handles, { EXACT: 1, SOUND_SET: 1, HEURISTIC: 0 });
  // Declared the other way, the document says nothing about where hand-written code mounts a route.
  const other = new Graph();
  addJavaFacts(other, f, { openapiDocuments: consoleDocs(GENERATES) });
  assert.equal(routeHandles(other, 'endpoint:GET /apis/console/v1/posts')[0].grade, 'HEURISTIC');
});

// ---------------------------------------------------------------------------
// what analyze says, and the remedy the overview carries
// ---------------------------------------------------------------------------

test('analyze says which routes rest on a document nothing declares current, with the key that settles them, and a declaration that names no document read', () => {
  const guessed = documentGuessNotes(
    { functionalRoutes: { mountedByOperationId: 169, mountedByDeclaredDocument: 5 } },
    { contractLinks: { links: 36, undeclared: 36 } },
  );
  assert.deepEqual(guessed.map((d) => [d.kind, d.severity, d.key]), [
    ['ROUTE_MOUNT_FROM_DOCUMENT', 'warn', FROM_CODE], ['CONTRACT_FROM_DOCUMENT', 'warn', GENERATES],
  ]);
  assert.match(guessed[0].reason, /^164 functional route\(s\) are served where an OpenAPI document declares their operation id/);
  assert.match(guessed[1].reason, /^36 HANDLES edge\(s\) pair a route with a method by a code generator's naming/);
  assert.deepEqual(documentGuessNotes({ functionalRoutes: { mountedByOperationId: 4, mountedByDeclaredDocument: 4 } }, { contractLinks: { links: 2, undeclared: 0 } }), []);
  assert.deepEqual(documentGuessNotes({}, null), []);
  for (const d of guessed) assert.doesNotMatch(d.reason, /[—·]/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-declared-read-'));
  try {
    fs.writeFileSync(path.join(root, 'api.yml'), PETCLINIC);
    const diagnostics = [];
    const profile = normalizeProfile({ openapi: { generatesCode: ['../api.yml', '../gone.yml'] } });
    const docs = readOpenApiDocs({ die: (m) => { throw new Error(m); } },
      { openapiFiles: [path.join(root, 'api.yml')], root, diagnostics, profile, manifestDir: path.join(root, '.cascade') });
    assert.deepEqual(docs.map((d) => [d.path, d.declaration]), [['api.yml', GENERATES]]);
    assert.deepEqual(diagnostics.map((d) => [d.kind, d.key]), [['OPENAPI_DECLARATION_UNUSED', GENERATES]]);
    assert.match(diagnostics[0].reason, /"\.\.\/gone\.yml" names no OpenAPI document this run reads, so it settles nothing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the remedy names the key: for the guessed routes, for the contract-links gap, and a mode only where a declaration cannot settle them', () => {
  for (const [kind, key] of [['ROUTE_MOUNT_FROM_DOCUMENT', FROM_CODE], ['CONTRACT_FROM_DOCUMENT', GENERATES]]) {
    assert.equal(DIAGNOSTIC_REMEDIES[kind].routes, true, kind);
    assert.deepEqual(diagnosticRemedy({ kind, key }), { action: 'declare', key, example: REMEDY_EXAMPLES[key] });
    assert.deepEqual(routeRemedy({ EXACT: 12, HEURISTIC: 164 }, 'conservative', [{ kind, key }]), { action: 'declare', key, example: REMEDY_EXAMPLES[key] });
  }
  const links = (undeclared) => ({ openapi: { contractLinks: { links: 3, undeclared } } });
  assert.deepEqual(gapRemedy('contract-links', { mode: 'conservative', laneStats: links(3) }), { action: 'declare', key: GENERATES, example: REMEDY_EXAMPLES[GENERATES] });
  assert.deepEqual(gapRemedy('contract-links', { mode: 'conservative', laneStats: links(0) }), { action: 'mode', mode: 'heuristic' },
    'every guessed link already rests on a declared document: the naming is what is left, and only a wider mode walks it');
  assert.equal(gapRemedy('contract-links', { mode: 'heuristic', laneStats: links(0) }), null);
});

const walkCtx = (g, laneStats) => ({
  graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } },
  trust: { trustLevel: 'UNCERTIFIED' }, limits: [], pack: { digest: 'd', laneStats },
});

test('the overview says no guess of a link a declaration settled, and counts the ones it did not', () => {
  const g = new Graph();
  const stats = addOpenApiRoutes(g, spec(true), { java: {}, javaFacts: petclinicFacts() });
  const gap = overview(g, { mode: 'conservative' }, walkCtx(g, { openapi: stats })).answer.gaps.find((x) => x.kind === 'contract-links');
  assert.equal(gap.count, 1, 'only countOwners is still a guess');
  assert.match(gap.note, /2 more are graded as the method they name: the profile declares that the build generates this code's interfaces from the document \(openapi\.generatesCode\)/);
  assert.deepEqual(gap.remedy, { action: 'mode', mode: 'heuristic' });

  const settled = new Graph();
  const onlySettled = addOpenApiRoutes(settled, spec(true), { java: {}, javaFacts: controller('p.web.OwnerController', 'OwnersApi', ['listOwners']) });
  assert.equal(overview(settled, { mode: 'conservative' }, walkCtx(settled, { openapi: onlySettled })).answer.gaps.find((x) => x.kind === 'contract-links'), undefined,
    'a link a declaration settled is no guess to disclose');

  const plain = new Graph();
  const undeclared = addOpenApiRoutes(plain, spec(false), { java: {}, javaFacts: petclinicFacts() });
  const guessed = overview(plain, { mode: 'conservative' }, walkCtx(plain, { openapi: undeclared })).answer.gaps.find((x) => x.kind === 'contract-links');
  assert.equal(guessed.count, 3);
  assert.deepEqual(guessed.remedy, { action: 'declare', key: GENERATES, example: REMEDY_EXAMPLES[GENERATES] });
});

// ---------------------------------------------------------------------------
// the whole run
// ---------------------------------------------------------------------------

test('cascade analyze: the declaration in the profile settles a contract-first controller, and without it the overview names the key', { timeout: 600000 }, (t) => {
  if (!findJdk()) { t.skip('no JDK found: see docs/setup/java-lane.md'); return; }
  if (!fs.existsSync(sqlLaneVenv().python)) { t.skip('no venv python: the SQL lane cannot run (see docs/setup/sql-lane.md)'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-declared-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const src = path.join(repo, 'src', 'main', 'java', 'p');
  const res = path.join(repo, 'src', 'main', 'resources');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'openapi.yml'), 'openapi: 3.0.1\npaths:\n  /owners:\n    get:\n      tags: [owners]\n      operationId: listOwners\n');
  fs.writeFileSync(path.join(src, 'OwnerController.java'), 'package p;\nimport p.api.OwnersApi;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController\npublic class OwnerController implements OwnersApi {\n  public Object listOwners(String lastName) { return null; }\n}\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', '-A');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'fixture');
  const env = { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') };
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  assert.equal(cli(['init', '--root', repo, '--project', 'declared']).status, 0);
  const profileFile = path.join(repo, '.cascade', 'profile.json');
  const packOf = () => JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const answer = (pack) => {
    const graph = loadPack(pack, { verifyDigest: true });
    return overview(graph, { mode: 'conservative' }, { ...walkCtx(graph, pack.meta.laneStats), pack: { ...pack.meta, digest: pack.digest } }).answer;
  };
  const edge = (pack) => pack.edges.find((e) => e.type === 'HANDLES' && e.to === 'symbol:p.OwnerController#listOwners');

  const before = cli(['analyze', '--root', repo, '--project', 'declared']);
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stderr, /CONTRACT_FROM_DOCUMENT openapi\.generatesCode: 1 HANDLES edge\(s\)/);
  const guessed = packOf();
  assert.equal(edge(guessed).grade, 'HEURISTIC');
  assert.deepEqual(answer(guessed).routeRemedy, { action: 'declare', key: GENERATES, example: REMEDY_EXAMPLES[GENERATES] });

  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  profile.openapi = { ...profile.openapi, generatesCode: ['../src/main/resources/openapi.yml'] };
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2));
  const after = cli(['analyze', '--root', repo, '--project', 'declared']);
  assert.equal(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stderr, /CONTRACT_FROM_DOCUMENT|OPENAPI_DECLARATION_UNUSED/);
  const declared = packOf();
  assert.equal(edge(declared).grade, 'EXACT');
  assert.deepEqual(edge(declared).evidence.declared, { key: GENERATES, document: 'src/main/resources/openapi.yml' });
  assert.equal(answer(declared).routeRemedy, null, 'no route is a guess any more');
});
