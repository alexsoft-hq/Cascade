// webfacts_modules.test.mjs — the web WORKER's modules, each imported on its own.
//
// WHY THIS FILE EXISTS BESIDE test/webfacts.test.mjs. That file SPAWNS the
// worker and reads its JSONL, which is the right test of a program with a
// stream contract. What it cannot do is reach one rule: a `calleeOf` that got a
// member chain wrong and a `summarizeArg` that got a template wrong both come
// out as one missing call record. RM49 split the worker's body into
// `adapters/web/lib/`; this file holds each module to the paragraph it opens
// with.
//
// The worker itself runs `main` on import, so it can never be imported from a
// test. These modules can, and that is half the point of the split.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  calleeOf, eachChild, isFunctionNode, isNode, keyName, patternNames, propOf, Scope,
  summarizeArg, toPosix,
} from '../adapters/web/lib/ast.mjs';
import {
  customElementTags, neutralizeScript, resolveIncludeName, soleElementTag,
  templateForms, templateIncludes, templateLinks, templateScriptBlocks, templateUrlOf,
  thymeleafFragmentTemplate,
} from '../adapters/web/lib/templates.mjs';
import { emptyCounts, orderRecords, tally } from '../adapters/web/lib/emit.mjs';
import { anyPackSeesARoute, packSeesARoute } from '../adapters/web/lib/routers.mjs';
import { bindingOf, isRequireCall } from '../adapters/web/lib/imports.mjs';
import { looksLikeUrlSummary, VERBS } from '../adapters/web/lib/calls.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const babel = require('../adapters/web/vendor/babel-parser.cjs');

/** One expression, parsed with the same options the worker parses a file with. */
function expr(code) {
  const ast = babel.parse(`const __x = ${code};`, {
    sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'decorators-legacy'],
  });
  return ast.program.body[0].declarations[0].init;
}

// ---------------------------------------------------------------------------
// ast.mjs — how the worker reads a syntax tree
// ---------------------------------------------------------------------------

test('ast: a callee is its root, the chain after it, and the last name', () => {
  assert.deepEqual(calleeOf(expr('a.b.c')), { root: 'a', path: ['b', 'c'], shape: 'member', name: 'c' });
  assert.deepEqual(calleeOf(expr('a')), { root: 'a', path: [], shape: 'ident', name: 'a' });
  assert.deepEqual(calleeOf(expr('this.inner')), { root: 'this', path: ['inner'], shape: 'member', name: 'inner' });
  // `import.meta.env.X` is spelled with the root `import.meta`, because that IS
  // the identifier as far as anything reading this stream is concerned.
  assert.equal(calleeOf(expr('import.meta.env.MODE')).root, 'import.meta');
  // A computed member nobody can name is a hole, not a guess.
  assert.deepEqual(calleeOf(expr('a[k].b')).path, ['*', 'b']);
  // A callee written on the RESULT of a call has no root name at all.
  assert.equal(calleeOf(expr('make().get')), null);
});

test('ast: an argument summary is lossy on purpose, and a hole is written as one', () => {
  assert.deepEqual(summarizeArg(expr("'/things/list'")), { kind: 'string', value: '/things/list' });
  const t = summarizeArg(expr('`/things/${id}`'));
  assert.equal(t.kind, 'template');
  assert.equal(t.template, '/things/{*}');
  assert.equal(t.dynamicParts, 1);
  // `'/user/' + id` and `` `/user/${id}` `` are the same route with the same hole.
  const plus = summarizeArg(expr("'/user/' + id"));
  assert.equal(plus.template, '/user/{*}');
  const ternary = summarizeArg(expr("a ? '/x' : '/y'"));
  assert.equal(ternary.kind, 'ternary');
  assert.deepEqual(ternary.candidates.map((c) => c.value), ['/x', '/y']);
  assert.equal(summarizeArg(expr('someCall()')).kind, 'other');
});

test('ast: the URL a template is built ON is named, because only the bridge can say what it holds', () => {
  const t = summarizeArg(expr('base_url + "/jobinfo/pageList"'));
  assert.equal(t.kind, 'template');
  assert.equal(t.base, 'base_url');
});

test('ast: an object argument is summarised by the keys a call is described by', () => {
  const o = summarizeArg(expr("{ url: '/x', method: 'post', body: whatever }"));
  assert.equal(o.kind, 'object');
  assert.deepEqual(o.keys.url, { kind: 'string', value: '/x' });
  assert.deepEqual(o.keys.method, { kind: 'string', value: 'post' });
  assert.equal(Object.prototype.hasOwnProperty.call(o.keys, 'body'), false, 'body is not one of the keys a call is read by');
});

test('ast: a key is read as written, and a computed one is not read at all', () => {
  const obj = expr("{ a: 1, 'b': 2, 3: 4, [x]: 5 }");
  assert.deepEqual(obj.properties.map((p) => keyName(p)), ['a', 'b', '3', null]);
  assert.equal(propOf(obj, 'b').value, 2);
  assert.equal(propOf(obj, 'nope'), null);
  assert.equal(propOf(expr('[1]'), 'a'), null, 'an array has no properties to read');
});

test('ast: a scope finds the nearest declaration, and a module scope says it is one', () => {
  const mod = new Scope(null, true);
  mod.declare('a', null);
  const inner = new Scope(mod, false);
  inner.declare('b', null);
  assert.equal(inner.find('b'), inner);
  assert.equal(inner.find('a'), mod);
  assert.equal(inner.find('a').isModule, true);
  assert.equal(inner.find('c'), null);
});

test('ast: every name a destructuring pattern introduces is found', () => {
  const pat = babel.parse('const { a, b: { c }, ...rest } = x;', { sourceType: 'module' })
    .program.body[0].declarations[0].id;
  assert.deepEqual(patternNames(pat).sort(), ['a', 'c', 'rest']);
});

test('ast: the small predicates say what they are for', () => {
  assert.equal(isNode({ type: 'Identifier' }), true);
  assert.equal(isNode({}), false);
  assert.equal(isNode(null), false);
  assert.equal(isFunctionNode(expr('() => 1')), true);
  assert.equal(isFunctionNode(expr('1')), false);
  assert.equal(toPosix(['a', 'b'].join(path.sep)), 'a/b');
  const seen = [];
  eachChild(expr('a.b'), (child) => seen.push(child.type));
  assert.ok(seen.includes('Identifier'));
});

// ---------------------------------------------------------------------------
// templates.mjs — a server-rendered page, read as text
// ---------------------------------------------------------------------------

test('templates: a hyphenated tag is a component the page mounts, once each, in source order', () => {
  assert.deepEqual(customElementTags('<owner-list></owner-list><pet-card/><owner-list/>'), ['owner-list', 'pet-card']);
  assert.deepEqual(customElementTags('<div><span></span></div>'), []);
});

test('templates: a template that IS one element names it, hyphen or not', () => {
  assert.equal(soleElementTag('<visits></visits>'), 'visits');
  assert.equal(soleElementTag('<owner-list/>'), 'owner-list');
  assert.equal(soleElementTag(' <div class="x"></div> '), 'div');
  assert.equal(soleElementTag('<a></a><b></b>'), null, 'markup around it names no single component');
});

test('templates: a directive is neutralised into a placeholder, and the LINES survive', () => {
  const src = 'var a = 1;\nvar b = "${request.contextPath}";\nvar c = "${other}";\n';
  const out = neutralizeScript(src, 'thymeleaf');
  assert.equal(out.split('\n').length, src.split('\n').length, 'a call record points at a line of the TEMPLATE');
  assert.match(out, /__cascade_ctx__/, 'the app root keeps a marker of its own');
  assert.match(out, /__cascade_expr__/, 'and every other expression is a hole a parser accepts');
});

test('templates: a form is a call site of the page itself, and its method is read from the tag', () => {
  const forms = templateForms('<form action="/cart/update" method="post"></form>\n<form action="/search"></form>');
  assert.equal(forms.length, 2);
  assert.equal(forms[0].url, '/cart/update');
  assert.equal(forms[0].method, 'POST');
  assert.equal(forms[1].method, 'GET', 'a form with no method is a GET, which is the HTML default');
});

test('templates: a link is a GET, and a static asset is not a route', () => {
  const links = templateLinks('<a href="/owners/1">o</a><a href="/css/app.css">c</a><a href="#x">n</a>');
  assert.deepEqual(links.map((l) => l.url), ['/owners/1']);
});

test('templates: an include is followed per engine, and resolved against the including file', () => {
  assert.deepEqual(templateIncludes('<div th:replace="fragments/layout :: main"></div>', 'thymeleaf').map((i) => i.written), ['fragments/layout']);
  assert.deepEqual(templateIncludes('<#include "common/head.ftl">', 'freemarker').map((i) => i.written), ['common/head.ftl']);
  assert.deepEqual(templateIncludes('<%@ include file="../common/Top.jsp" %>', 'jsp').map((i) => i.written), ['../common/Top.jsp']);
  assert.equal(thymeleafFragmentTemplate('fragments/layout :: main'), 'fragments/layout');
  assert.equal(resolveIncludeName('../common/Top.jsp', { fromDir: 'cart', relativeTo: 'file', suffix: '.jsp' }), 'common/Top');
  assert.equal(resolveIncludeName('fragments/layout', { fromDir: 'things', relativeTo: 'root', suffix: '.html' }), 'fragments/layout');
});

test('templates: the script blocks of a page are what the JavaScript reader gets, at their own lines', () => {
  const page = '<html>\n<body>\n<script>\nvar a = 1;\n</script>\n</body>\n</html>';
  const blocks = templateScriptBlocks(page, 'plain-html');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].code, /var a = 1;/);
  // `var a = 1;` is on line 4 of the page. The block's own text starts with the
  // newline after `<script>`, so the offset that lands it on line 4 is 2.
  const inBlock = blocks[0].code.split('\n').findIndex((l) => l.includes('var a = 1;'));
  assert.equal(blocks[0].lineOffset + inBlock + 1, 4);
});

test('templates: a page URL is read from the attribute, and an asset is not a route', () => {
  assert.equal(templateUrlOf('/owners/1'), '/owners/1');
  assert.equal(templateUrlOf('@{/owners/{id}}'), '/owners/{*}');
  assert.equal(templateUrlOf('${request.contextPath}/cart/update'), '/cart/update',
    'the app root is where the deployment is mounted, and no route this pack serves carries it');
  assert.equal(templateUrlOf('/css/app.css'), null, 'a served file is not a route');
  assert.equal(templateUrlOf('#anchor'), null);
  assert.equal(templateUrlOf('https://elsewhere.example.com/x'), null);
  assert.equal(templateUrlOf('relative/page'), null, 'a page URL is written from the application root');
});

// ---------------------------------------------------------------------------
// emit.mjs — the stream's order, and the summary that counts it
// ---------------------------------------------------------------------------

test('emit: a file record comes first, then line order, then the order the walk found things', () => {
  const recs = [
    { line: 9, order: 3, rec: { kind: 'call' } },
    { line: 1, order: 7, rec: { kind: 'import' } },
    { line: 1, order: -1, rec: { kind: 'file' } },
    { line: 9, order: 1, rec: { kind: 'call' } },
  ];
  assert.deepEqual(
    orderRecords(recs).map((r) => [r.line, r.rec.kind, r.order]),
    [[1, 'file', -1], [1, 'import', 7], [9, 'call', 1], [9, 'call', 3]],
  );
  // Sorted, not sorted in place: the caller's array is its own.
  assert.equal(recs[0].line, 9);
});

test('emit: a fresh summary carries every field, and the tally fills them from the records', () => {
  const counts = emptyCounts({ files: 2, parseErrors: 0, recoveredErrors: 0, envFiles: 1 });
  assert.equal(counts.files, 2);
  assert.equal(counts.envFiles, 1);
  assert.deepEqual(counts.urlByShape, { literal: 0, template: 0, constant: 0, unresolved: 0 });

  tally({ kind: 'import' }, counts);
  tally({ kind: 'route', pack: 'vue-router' }, counts);
  tally({
    kind: 'call',
    url: { resolved: [{ template: '/x', via: 'literal' }] },
    method: { value: 'GET', from: 'callee-name' },
  }, counts);
  assert.equal(counts.imports, 1);
  assert.equal(counts.routes, 1);
  assert.equal(counts.byPack['vue-router'], 1);
  assert.equal(counts.calls, 1);
  assert.equal(counts.callsWithUrl, 1);
  assert.equal(counts.urlByShape.literal, 1);
  assert.equal(counts.methodBySource['callee-name'], 1);
});

// ---------------------------------------------------------------------------
// routers.mjs / imports.mjs / calls.mjs — the rules with no other reach
// ---------------------------------------------------------------------------

const VUE_PACK = {
  pack: 'vue-router',
  routeObject: {
    pathKey: 'path', nameKey: 'name', componentKeys: ['component'], childrenKey: 'children',
    redirectKey: 'redirect', metaKey: 'meta', titleKey: 'title', hiddenKey: 'hidden',
  },
};

test('routers: an object is a route only when it carries a path AND something a route has', () => {
  assert.equal(packSeesARoute(VUE_PACK, expr("{ path: '/a', component: X }")), true);
  assert.equal(packSeesARoute(VUE_PACK, expr("{ path: '/a', children: [] }")), true);
  assert.equal(packSeesARoute(VUE_PACK, expr("{ path: '/a', redirect: '/b' }")), true);
  // A path on its own is a string in an object, not a route declaration.
  assert.equal(packSeesARoute(VUE_PACK, expr("{ path: '/a' }")), false);
  assert.equal(packSeesARoute(VUE_PACK, expr("{ component: X }")), false);
  assert.equal(packSeesARoute({ pack: 'x', routeObject: {} }, expr("{ path: '/a', component: X }")), false);
  assert.equal(anyPackSeesARoute([VUE_PACK], expr("{ path: '/a', component: X }")), true);
  assert.equal(anyPackSeesARoute([VUE_PACK], expr("'/a'")), false);
  assert.equal(anyPackSeesARoute([VUE_PACK], null), false);
});

test('imports: a bare `require` is an import, and a shadowed one is a call like any other', () => {
  const scope = new Scope(null, true);
  const env = { scope };
  assert.equal(isRequireCall(null, expr("require('x')"), env), true);
  assert.equal(isRequireCall(null, expr("require(name)"), env), false, 'only a literal names a module');
  assert.equal(isRequireCall(null, expr("other('x')"), env), false);
  const shadowed = new Scope(null, true);
  shadowed.declare('require', null);
  assert.equal(isRequireCall(null, expr("require('x')"), { scope: shadowed }), false,
    'a file that declares its own `require` is not doing CommonJS');
});

test('imports: what a root identifier IS — an import, a local, a `this`, or nobody\'s', () => {
  const ctx = {
    top: {
      imports: new Map([['client', { source: '@/utils/http', imported: 'default' }]]),
      constants: new Map(),
      bindings: new Map([['local', {}]]),
      functions: new Map(),
    },
  };
  const mod = new Scope(null, true);
  assert.deepEqual(bindingOf(ctx, 'client', mod, null), { kind: 'import', source: '@/utils/http', imported: 'default' });
  assert.deepEqual(bindingOf(ctx, 'local', mod, null), { kind: 'local', name: 'local' });
  assert.deepEqual(bindingOf(ctx, 'window', mod, null), { kind: 'global', name: 'window' });
  assert.deepEqual(bindingOf(ctx, 'this', mod, { name: 'Api' }), { kind: 'this', class: 'Api' });
  assert.deepEqual(bindingOf(ctx, 'this', mod, null), { kind: 'global', name: 'this' });
  // A parameter of the enclosing function is not this file's to follow.
  const inner = new Scope(mod, false);
  inner.declare('client', null);
  assert.equal(bindingOf(ctx, 'client', inner, null), null);
});

test('calls: a bare `/` is the separator, not a URL', () => {
  assert.equal(looksLikeUrlSummary({ kind: 'string', value: '/things' }), true);
  assert.equal(looksLikeUrlSummary({ kind: 'string', value: '/' }), false);
  assert.equal(looksLikeUrlSummary({ kind: 'string', value: 'size' }), false);
  assert.equal(looksLikeUrlSummary({ kind: 'template', template: '//host/x' }), true);
  assert.equal(looksLikeUrlSummary({ kind: 'other' }), false);
  assert.deepEqual([...VERBS].sort(), ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
});

// ---------------------------------------------------------------------------
// the layering the worker was split under
// ---------------------------------------------------------------------------

test('nothing in adapters/web/lib/ reaches into src/', () => {
  const dir = path.join(ROOT, 'adapters', 'web', 'lib');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(files.length >= 5, `expected the worker's modules, found ${files.length}`);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      assert.equal(/(^|\/)src\//.test(spec), false, `${f} imports ${spec}: the worker is a separate process and shares no engine code`);
      assert.equal(spec.includes('webfacts.mjs'), false, `${f} imports the entry file it is part of`);
    }
  }
});

test('every worker module says what it owns and what it must never know about', () => {
  const dir = path.join(ROOT, 'adapters', 'web', 'lib');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, 40).join('\n');
    assert.match(head, /WHAT THIS MODULE OWNS/, `${f} opens without saying what it owns`);
    assert.match(head, /WHAT IT MUST NEVER KNOW ABOUT|imports nothing/, `${f} does not say what it must not reach`);
  }
});
