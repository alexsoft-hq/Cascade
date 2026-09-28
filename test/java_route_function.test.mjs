// java_route_function.test.mjs — Spring's functional endpoints, from the worker's
// record to the routes the Java bridge places (RM67).
//
// A route declared with calls (`route().GET("/owners/{id}", handler::show)`) has
// no annotation to read. The worker records the body of a method declared to
// return a RouterFunction as a tree (javafacts/17); the `java.route-function`
// rules read it with the words the spring-functional pack gives; the bridge
// places what they read with the endpoint id every lane uses. What is pinned
// here, beside what each step reads:
//
//   * a route's HANDLES is EXACT only where the source names the class and the
//     method; a field's or a parameter's declared type is a candidate set, and
//     an interface's is every implementor;
//   * a route whose prefix is composed by code elsewhere is placed only where an
//     OpenAPI document declares the operation it names, with its verb, at a path
//     that ends with its own, and then at SOUND_SET; otherwise it is counted and
//     not placed;
//   * a handler that is a lambda doing more than calling one method, or a path
//     in a variable, is said and never guessed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane, LANE_BRIDGES } from '../src/cli/lanes_run.mjs';
import { Graph } from '../src/core/graph.mjs';
import { assembleGraph } from '../src/core/assemble.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { splitJavaFactsByFile, assembleJavaFacts } from '../src/core/facts_store.mjs';
import { buildRegistry, builtinRegistry, RuleError } from '../src/core/rules/registry.mjs';
import { javaRouteFunction, vocabularyOf, WORKER_ROUTE_TYPES } from '../src/core/rules/kinds/java_route_function.mjs';
import { overlayGraph } from '../src/core/overlay.mjs';
import { openApiDocumentsOf } from '../src/cli/overlay_provider.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

const SOURCES = {
  'OwnerRoutes.java': `package com.example;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;
import org.springframework.context.annotation.Bean;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;

public class OwnerRoutes {
    private final PetHandler pets;
    private String base = "/dynamic";

    OwnerRoutes(PetHandler pets) { this.pets = pets; }

    @Bean
    RouterFunction<ServerResponse> ownerRoutes(OwnerHandler handler) {
        return route()
            .GET("/owners/{id}", handler::show)
            .GET("/owners", this::list, ops -> ops.operationId("listOwners"))
            .POST("/owners", request -> { log(); return handler.create(request); })
            .GET(base, this::list)
            .GET("/pets", pets::all)
            .build();
    }

    public Object notRoutes() {
        return route().GET("/never", this::list).build();
    }

    Mono<ServerResponse> list(ServerRequest r) { return null; }
    void log() { }
}
`,
  'OwnerHandler.java': `package com.example;
public class OwnerHandler {
    public Object show(Object r) { return null; }
    public Object create(Object r) { return null; }
}
`,
  'PetHandler.java': `package com.example;
public interface PetHandler { Object all(Object r); }
`,
  'DogHandler.java': `package com.example;
public class DogHandler implements PetHandler { public Object all(Object r) { return null; } }
`,
  'CatHandler.java': `package com.example;
public class CatHandler implements PetHandler { public Object all(Object r) { return null; } }
`,
  'PostEndpoint.java': `package com.example;
import org.springdoc.webflux.core.fn.SpringdocRouteBuilder;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

public class PostEndpoint {
    public RouterFunction<ServerResponse> endpoint() {
        return SpringdocRouteBuilder.route()
            .GET("posts", this::listPost, b -> b.operationId("ListPosts"))
            .GET("posts/{name}", this::getPost, b -> b.operationId("GetPost"))
            .DELETE("posts/{name}", this::deletePost, b -> b.operationId("DeletePost"))
            .build();
    }
    Object listPost(Object r) { return null; }
    Object getPost(Object r) { return null; }
    Object deletePost(Object r) { return null; }
}
`,
};

/** The document a springdoc build of this project would write, give or take one drift on purpose. */
const DOCUMENTS = [{
  path: 'api-docs/console.json', version: '3.0.1', basePath: '', unreadable: [],
  paths: [
    { method: 'GET', path: '/apis/console/v1/posts', operationId: 'ListPosts', summary: null },
    { method: 'GET', path: '/apis/console/v1/posts/{name}', operationId: 'GetPost', summary: null },
    // the code deletes at .../posts/{name}; the document says elsewhere
    { method: 'DELETE', path: '/apis/console/v1/other/{name}', operationId: 'DeletePost', summary: null },
    // the code names this route listOwners
    { method: 'GET', path: '/owners', operationId: 'ownersList', summary: null },
  ],
}];

const cached = new Map();
/** The worker's records for a set of sources, read once; null without a JDK. */
function facts(sources = SOURCES) {
  if (cached.has(sources)) return cached.get(sources);
  const jdk = findJdk();
  if (!jdk) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-routefn-'));
  const src = path.join(dir, 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(sources)) fs.writeFileSync(path.join(src, name), body);
  try { cached.set(sources, runJavaLane(jdk, dir, [dir], { quiet: true })); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return cached.get(sources);
}

function needFacts(t, sources = SOURCES) {
  const f = facts(sources);
  if (!f) t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md');
  return f;
}

const handlesOf = (g, ep) => g.edges.filter((e) => e.type === 'HANDLES' && e.from === ep);
const lineOfText = (file, text) => SOURCES[file].split('\n').findIndex((l) => l.includes(text)) + 1;

test('javafacts/17: a method declared to return a RouterFunction is recorded as a tree, each call on the line its name is on', (t) => {
  const f = needFacts(t);
  if (!f) return;
  const recs = f.filter((r) => r.kind === 'routeFunction');
  assert.deepEqual(recs.map((r) => `${r.owner}#${r.method}`).sort(), ['com.example.OwnerRoutes#ownerRoutes', 'com.example.PostEndpoint#endpoint'],
    'notRoutes() calls the same builder and returns Object, so it is not recorded');
  const owner = recs.find((r) => r.method === 'ownerRoutes');
  assert.equal(owner.returnType, 'RouterFunction');
  assert.equal(owner.returnWrapper, null);
  assert.deepEqual(owner.annotations, ['Bean']);
  assert.deepEqual(owner.params, [{ name: 'handler', type: 'OwnerHandler' }]);
  assert.equal(owner.cut, false);
  // The chain starts on the `return route()` line; each verb is written on its own.
  const calls = [];
  const walk = (n) => { if (n && n.k === 'call') { calls.push(n); walk(n.r); } };
  walk(owner.body.find((s) => s.s === 'return').e);
  const getOwner = calls.find((c) => c.n === 'GET' && c.a[0].v === '/owners/{id}');
  assert.equal(getOwner.l, lineOfText('OwnerRoutes.java', '.GET("/owners/{id}"'));
  assert.deepEqual(getOwner.a[1], { k: 'ref', r: { k: 'id', v: 'handler' }, n: 'show' });
});

test('javafacts/17: a routeFunction record is sharded and reassembled in the order the worker wrote it', (t) => {
  const f = needFacts(t);
  if (!f) return;
  const records = f.filter((r) => r.kind !== 'header');
  const { byFile } = splitJavaFactsByFile(records);
  const back = assembleJavaFacts([...byFile.values()].reverse());
  assert.equal(back.map((r) => JSON.stringify(r)).join('\n'), records.map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(back.filter((r) => r.kind === 'routeFunction').length, 2);
});

test('the kind reads only the return types the worker records, and the two lists are one', () => {
  const src = fs.readFileSync(path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java'), 'utf8');
  const m = src.match(/ROUTE_FUNCTION_TYPES\s*=\s*new[^;]*asList\(([^)]*)\)/);
  assert.ok(m, 'JavaFacts.java declares ROUTE_FUNCTION_TYPES');
  assert.deepEqual([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort(), [...WORKER_ROUTE_TYPES].sort());
  const rule = structuredClone(builtinRegistry().rules.get('spring-functional.router-functions').rule);
  rule.params.returnTypes = ['Mono'];
  assert.throws(() => buildRegistry([{ where: 'p.json', pack: { pack: 'spring-functional', version: 1, description: 'x', rules: [rule] } }]),
    (e) => e instanceof RuleError && e.problems.some((p) => /Mono, which the Java worker does not record/.test(p)));
});

test('a route-function rule refuses a call that does nothing it knows, and a role it does not read', () => {
  const errors = javaRouteFunction.validateParams({
    returnTypes: ['RouterFunction'], mountAnnotations: ['Bean'], operationId: ['operationId'], methods: {},
    calls: [{ names: ['GET'], does: 'serve', forms: ['path handler'] }, { names: ['nest'], does: 'nest', forms: ['prefix routes'] }],
    predicates: [],
  });
  assert.ok(errors.some((e) => /calls\[0\]\.does must be one of/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /calls\[1\]\.forms has "prefix routes"/.test(e)), errors.join('\n'));
});

test('two rules that read one call two ways stop the run, whatever order they load in', () => {
  const rule = (id, verb) => javaRouteFunction.compile({
    id, params: { returnTypes: ['RouterFunction'], mountAnnotations: ['Bean'], calls: [{ names: ['GET'], does: 'route', verb, forms: ['path handler'] }], predicates: [] },
  });
  assert.throws(() => vocabularyOf([rule('a.one', 'GET'), rule('b.two', 'POST')]), /a\.one and b\.two read GET two ways/);
  assert.doesNotThrow(() => vocabularyOf([rule('a.one', 'GET'), rule('b.two', 'GET')]));
});

test('a bean\'s routes: EXACT where the source names the class and the method, a candidate set through a declared type', (t) => {
  const f = needFacts(t);
  if (!f) return;
  const g = new Graph();
  const stats = addJavaFacts(g, f, {});
  const show = handlesOf(g, 'endpoint:GET /owners/{id}');
  assert.deepEqual(show.map((e) => [e.to, e.grade]), [['symbol:com.example.OwnerHandler#show', 'SOUND_SET']]);
  assert.equal(show[0].evidence.rule, 'spring-functional.router-functions');
  assert.equal(show[0].evidence.mount, 'bean');
  assert.equal(show[0].evidence.handlerVia, 'param');
  assert.deepEqual(show[0].evidence.declaredAt, { file: 'com/example/OwnerRoutes.java', line: lineOfText('OwnerRoutes.java', '.GET("/owners/{id}"') });
  const list = handlesOf(g, 'endpoint:GET /owners');
  assert.deepEqual(list.map((e) => [e.to, e.grade]), [['symbol:com.example.OwnerRoutes#list', 'EXACT']]);
  assert.equal(g.nodes.get('endpoint:GET /owners').operationId, 'listOwners');
  assert.equal(g.nodes.get('symbol:com.example.OwnerRoutes#list').line, lineOfText('OwnerRoutes.java', 'Mono<ServerResponse> list('));
  // An interface's method runs in whichever implementor the field holds: every one of them, at SOUND_SET.
  const pets = handlesOf(g, 'endpoint:GET /pets');
  assert.deepEqual(pets.map((e) => [e.to, e.grade]).sort(), [['symbol:com.example.CatHandler#all', 'SOUND_SET'], ['symbol:com.example.DogHandler#all', 'SOUND_SET']]);
  assert.equal(pets[0].evidence.candidates, 2);
  assert.equal(stats.functionalRoutes.handles.EXACT, 1);
  assert.equal(stats.functionalRoutes.handles.SOUND_SET, 3);
});

test('what is not read is said: a lambda doing more than one call keeps its route and names no handler, a path in a field is no route', (t) => {
  const f = needFacts(t);
  if (!f) return;
  const g = new Graph();
  const stats = addJavaFacts(g, f, {}).functionalRoutes;
  const post = g.nodes.get('endpoint:POST /owners');
  assert.equal(post.handlerUnread, true);
  assert.deepEqual(handlesOf(g, 'endpoint:POST /owners'), []);
  assert.equal(stats.servedWithoutHandler, 1);
  assert.equal(stats.pathUnread, 1);
  assert.ok(![...g.nodes.keys()].some((id) => id.includes('/dynamic') || id.includes('/never')));
  const codes = stats.samples.map((s) => s.code);
  assert.ok(codes.includes('handler-not-one-call') && codes.includes('path-not-literal'), codes.join(', '));
});

test('a route mounted by code elsewhere is placed only where a document declares its operation, with its verb, at a path ending in its own', (t) => {
  const f = needFacts(t);
  if (!f) return;
  const without = new Graph();
  const alone = addJavaFacts(without, f, {}).functionalRoutes;
  assert.ok(![...without.nodes.keys()].some((id) => id.includes('posts')), 'no document, so no prefix, so no route');
  assert.equal(alone.unmounted, 3);
  assert.ok(alone.samples.some((s) => s.code === 'operation-id-not-declared'));

  const g = new Graph();
  const stats = addJavaFacts(g, f, { openapiDocuments: DOCUMENTS }).functionalRoutes;
  const list = handlesOf(g, 'endpoint:GET /apis/console/v1/posts');
  assert.deepEqual(list.map((e) => [e.to, e.grade]), [['symbol:com.example.PostEndpoint#listPost', 'HEURISTIC']],
    'this::listPost names the method outright, and the mount is a document\'s operation id matched by convention: HEURISTIC');
  assert.equal(list[0].evidence.mount, 'operation-id');
  assert.equal(list[0].evidence.document, 'api-docs/console.json');
  assert.equal(list[0].evidence.relativePath, '/posts');
  assert.equal(handlesOf(g, 'endpoint:GET /apis/console/v1/posts/{name}').length, 1);
  assert.ok(![...g.nodes.keys()].some((id) => id.startsWith('endpoint:DELETE')), 'the document puts DeletePost at another path: not placed');
  assert.equal(stats.mountedByOperationId, 2);
  assert.equal(stats.unmounted, 1);
  // Both drifts are said: the one route not placed, and the bean route whose operation id the document gives another name.
  assert.equal(stats.operationIdDisagreements, 2);
  assert.deepEqual(stats.disagreements.map((d) => d.endpoint).sort(), ['DELETE /posts/{name}', 'GET /owners']);
});

/** Two classes that name one operation: springdoc keeps one name and renames the other in the document. */
const TWICE = {
  'ConsoleComments.java': `package com.example;
public class ConsoleComments {
    public RouterFunction<ServerResponse> endpoint() {
        return SpringdocRouteBuilder.route().POST("comments", this::create, b -> b.operationId("CreateComment")).build();
    }
    Object create(Object r) { return null; }
}
`,
  'PublicComments.java': `package com.example;
public class PublicComments {
    public RouterFunction<ServerResponse> endpoint() {
        return SpringdocRouteBuilder.route().POST("comments", this::create, b -> b.operationId("CreateComment")).build();
    }
    Object create(Object r) { return null; }
}
`,
};

test('two routes of the code that name one operation are placed by neither: which document entry is which is not known', (t) => {
  const f = needFacts(t, TWICE);
  if (!f) return;
  const g = new Graph();
  const stats = addJavaFacts(g, f, { openapiDocuments: [{ path: 'doc.json', paths: [
    { method: 'POST', path: '/apis/console/v1/comments', operationId: 'CreateComment' },
    { method: 'POST', path: '/apis/public/v1/comments', operationId: 'CreateComment_1' },
  ] }] }).functionalRoutes;
  assert.equal(stats.mountedByOperationId, 0);
  assert.equal(stats.notRead['operation-id-not-unique'], 2);
  assert.ok(![...g.nodes.keys()].some((id) => id.startsWith('endpoint:')));
});

test('through the assembler, a route placed by its operation id is one the document then finds served, not a second node', (t) => {
  const f = needFacts(t);
  if (!f) return;
  const { graph, openapiStats, javaStats } = assembleGraph({
    bridges: LANE_BRIDGES, javaFacts: f, openapiDocuments: DOCUMENTS, java: {}, openapi: {},
  });
  assert.equal(javaStats.functionalRoutes.mountedByOperationId, 2);
  assert.equal(openapiStats.matchedServed, 3, 'the two posts routes and GET /owners');
  const posts = graph.nodes.get('endpoint:GET /apis/console/v1/posts');
  assert.deepEqual(posts.declaredBy, ['api-docs/console.json']);
  assert.equal(posts.operationId, 'ListPosts');
  assert.equal(graph.nodes.get('endpoint:GET /owners').operationId, 'listOwners', 'the code\'s name stays; the drift is in the lane stats');
  // Without the OpenAPI lane the Java lane is handed no document.
  const off = assembleGraph({ bridges: LANE_BRIDGES, javaFacts: f, openapiDocuments: DOCUMENTS, java: {}, openapi: null });
  assert.equal(off.javaStats.functionalRoutes.mountedByOperationId, 0);
});

test('a tree with no route-building method is untouched: no route, no node, and the census says nothing was there', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.example.A', typeKind: 'class', package: 'com.example', annotations: ['RestController'], implements: [], extends: null, declaredMethods: ['a/0'], file: 'A.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/a', handler: 'com.example.A#a', handlerType: 'com.example.A', line: 3, file: 'A.java' },
  ], {}).functionalRoutes;
  assert.equal(stats.functions, 0);
  assert.deepEqual([...g.nodes.keys()].filter((id) => id.startsWith('endpoint:')), ['endpoint:GET /a']);
  assert.equal(g.nodes.get('endpoint:GET /a').operationId, undefined);
});

test('the working-tree overlay places a route by its operation id as analyze does, from the documents the pack read', (t) => {
  const f = needFacts(t);
  if (!f) return;
  const { byFile } = splitJavaFactsByFile(f.filter((r) => r.kind !== 'header'));
  const base = assembleGraph({ bridges: LANE_BRIDGES, javaFacts: f, openapiDocuments: DOCUMENTS, java: {}, openapi: {} }).graph;
  const over = (openapiDocuments) => overlayGraph({
    bridges: LANE_BRIDGES, baseShards: byFile, baseGraph: base, overlaySessionId: 'ov-test', dirtyFiles: [], openapiDocuments,
  });
  const withDocs = over(DOCUMENTS);
  assert.equal(withDocs.javaStats.functionalRoutes.mountedByOperationId, 2);
  assert.deepEqual(handlesOf(withDocs.graph, 'endpoint:GET /apis/console/v1/posts').map((e) => e.to), ['symbol:com.example.PostEndpoint#listPost']);
  assert.equal(over(null).javaStats.functionalRoutes.mountedByOperationId, 0, 'without them the route has no prefix, and is not placed');

  // The provider reads the documents the pack names, from the tree as it is now; one gone is not read.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-routefn-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'api.json'), JSON.stringify({ openapi: '3.0.1', paths: { '/x/posts': { get: { operationId: 'ListPosts' } } } }));
  const pack = { meta: { laneStats: { openapi: { documents: [{ path: 'docs/api.json' }, { path: 'docs/gone.json' }] } } } };
  const docs = openApiDocumentsOf(pack, root);
  assert.deepEqual(docs.map((d) => [d.path, d.paths.map((p) => `${p.method} ${p.path} ${p.operationId}`)]), [['docs/api.json', ['GET /x/posts ListPosts']]]);
  assert.deepEqual(openApiDocumentsOf({ meta: {} }, root), []);
});
