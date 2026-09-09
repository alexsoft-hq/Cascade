import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The web lane's worker, driven the way the CLI drives it (RM26).
//
// It is SPAWNED, like test/java_smoke.test.mjs spawns the Java one, because the
// thing under test is a program with a JSONL contract, not a function: the
// header, the record order, the bytes being the same twice, and a file the
// parser could not read still leaving the other files alone.
//
// Every expectation about a LINE NUMBER is computed from the fixture text. A
// hard-coded 24 would go quietly wrong the day somebody adds a line to the
// template, which is exactly the bug the line-offset code exists to prevent.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-smoke');
const SRC = path.join(FIXTURE, 'src');

/** Run the worker over the fixture and return the raw stdout. */
function runRaw() {
  return execFileSync(process.execPath, [WORKER, '--root', FIXTURE, SRC], { maxBuffer: 1 << 28 }).toString('utf8');
}

const RAW = runRaw();
const RECORDS = RAW.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const HEADER = RECORDS[0];
const SUMMARY = RECORDS[RECORDS.length - 1];
const BODY = RECORDS.slice(1, -1);

const of = (file) => BODY.filter((r) => r.file === file);
const kind = (file, k) => of(file).filter((r) => r.kind === k);
const one = (file, k, where) => {
  const hits = kind(file, k).filter(where ?? (() => true));
  assert.equal(hits.length, 1, `expected exactly one ${k} in ${file}, got ${hits.length}: ${JSON.stringify(hits)}`);
  return hits[0];
};

/** The 1-based line a fixture file's first line matching `re` sits on. */
function lineOf(relFile, re) {
  const lines = fs.readFileSync(path.join(FIXTURE, relFile), 'utf8').split('\n');
  const i = lines.findIndex((l) => re.test(l));
  assert.ok(i >= 0, `${relFile} has no line matching ${re}; the fixture and this test have drifted apart`);
  return i + 1;
}

// ---------------------------------------------------------------------------
// The stream itself
// ---------------------------------------------------------------------------

test('the header names the schema, the version, the roots and what it read', () => {
  assert.equal(HEADER.kind, 'header');
  assert.equal(HEADER.schema, 'cascade:webfacts:1');
  assert.equal(HEADER.version, 'webfacts/4');
  assert.equal(HEADER.root, FIXTURE);
  assert.deepEqual(HEADER.roots, ['src']);
  // `files` is the number of files that were read WITH THE PARSER. Every one of
  // them produced exactly one `file` record, so the two must agree or one of
  // the counts is a guess.
  const fileRecords = BODY.filter((r) => r.kind === 'file');
  assert.equal(HEADER.files, fileRecords.length, JSON.stringify(fileRecords.map((r) => r.file)));
  assert.equal(HEADER.parseErrors, BODY.filter((r) => r.kind === 'parse_error').length);
});

test('two runs over the same tree print identical bytes', () => {
  assert.equal(runRaw(), RAW);
});

test('files come out in sorted path order, and a file record comes before its own records', () => {
  const files = [...new Set(BODY.map((r) => r.file))];
  assert.deepEqual(files, [...files].sort(), 'files must be in sorted root-relative path order');
  // Within one file: never decreasing by line, and the `file` record first.
  for (const f of files) {
    const rows = of(f);
    const lines = rows.map((r) => r.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b), `${f}: records are not in line order`);
    if (rows.some((r) => r.kind === 'file')) {
      assert.equal(rows[0].kind, 'file', `${f}: the file record must come first`);
    }
  }
});

test('the skipped files are absent: a .d.ts and a test file are not sources this lane reads', () => {
  const files = new Set(BODY.map((r) => r.file));
  assert.equal(files.has('src/types/thing.d.ts'), false);
  assert.equal(files.has('src/__tests__/things.test.js'), false);
  // ...and the fixture really does contain them, so the assertion above is not
  // passing because the files are missing.
  assert.ok(fs.existsSync(path.join(SRC, 'types', 'thing.d.ts')));
  assert.ok(fs.existsSync(path.join(SRC, '__tests__', 'things.test.js')));
});

test('a file the parser cannot read is RECORDED, and the other files keep every record', () => {
  const err = one('src/broken/bad.js', 'parse_error');
  assert.ok(err.line >= 1);
  assert.equal(typeof err.message, 'string');
  assert.ok(err.message.length > 0);
  // The broken file contributes nothing else...
  assert.deepEqual(
    kind('src/broken/bad.js', 'function').length + kind('src/broken/bad.js', 'call').length, 0,
  );
  // ...and the file beside it is untouched.
  assert.ok(kind('src/api/things.js', 'call').length >= 4);
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const callAt = (file, line) => one(file, 'call', (r) => r.line === line);

test('a literal url resolves to itself, with via literal', () => {
  const c = callAt('src/api/things.js', lineOf('src/api/things.js', /url: '\/things\/list'/) - 1);
  assert.deepEqual(c.url.resolved, [{ template: '/things/list', dynamicParts: 0, via: 'literal' }]);
  assert.deepEqual(c.args[0].keys.url, { kind: 'string', value: '/things/list' });
});

test('a `+` concatenation and a template literal both become one template with one hole', () => {
  const concat = callAt('src/api/things.js', lineOf('src/api/things.js', /url: '\/things\/' \+ id/) - 1);
  assert.deepEqual(concat.url.resolved, [{ template: '/things/{*}', dynamicParts: 1, via: 'template' }]);
  const tpl = callAt('src/api/things.js', lineOf('src/api/things.js', /\/things\/\$\{id\}\/tags/) - 1);
  assert.deepEqual(tpl.url.resolved, [{ template: '/things/{*}/tags', dynamicParts: 1, via: 'template' }]);
});

test('a member of a file-local constant resolves to the member string', () => {
  const c = callAt('src/api/catalog.ts', lineOf('src/api/catalog.ts', /export const listCatalog/));
  assert.deepEqual(c.url.arg, { kind: 'member', root: 'CatalogUrls', path: ['list'] });
  assert.deepEqual(c.url.resolved, [{ template: '/catalog/list', dynamicParts: 0, via: 'local-constant' }]);
});

test('a local const initialised from a ternary yields BOTH candidates', () => {
  const c = callAt('src/api/catalog.ts', lineOf('src/api/catalog.ts', /return client\.post/));
  assert.deepEqual(c.url.arg, { kind: 'ident', name: 'url' });
  assert.deepEqual(c.url.resolved, [
    { template: '/catalog/save', dynamicParts: 0, via: 'local-variable' },
    { template: '/catalog/edit', dynamicParts: 0, via: 'local-variable' },
  ]);
});

test('a url that is a PARAMETER is unresolved, and says which kind of unresolved', () => {
  const c = callAt('src/api/catalog.ts', lineOf('src/api/catalog.ts', /fetchWhereverTheCallerSays/));
  assert.equal(c.url.resolved, null);
  assert.equal(c.url.unresolved, 'parameter');
});

test('the enum and the object constant are recorded, and a non-string member is COUNTED, not dropped', () => {
  const en = one('src/api/catalog.ts', 'constant');
  assert.equal(en.name, 'CatalogUrls');
  assert.deepEqual(en.members, { list: '/catalog/list', save: '/catalog/save', edit: '/catalog/edit' });
  assert.equal(en.omitted, 0);

  const consts = kind('src/api/bases.ts', 'constant');
  const base = consts.find((c) => c.name === 'BASE');
  assert.deepEqual({ value: base.value, exported: base.exported }, { value: '/v2', exported: true });
  const paths = consts.find((c) => c.name === 'Paths');
  assert.deepEqual(paths.members, { one: '/one' });
  assert.equal(paths.omitted, 1, 'the numeric member must be counted as omitted, not silently dropped');
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

test('the method comes from the callee name, the config object or a positional argument, and says which', () => {
  const byCallee = callAt('src/api/catalog.ts', lineOf('src/api/catalog.ts', /export const listCatalog/));
  assert.deepEqual(byCallee.method, { value: 'GET', from: 'callee-name' });

  const byConfig = callAt('src/api/things.js', lineOf('src/api/things.js', /url: '\/things\/list'/) - 1);
  assert.deepEqual(byConfig.method, { value: 'GET', from: 'config' });

  const xhr = callAt('src/legacy/xhr.js', lineOf('src/legacy/xhr.js', /x\.open\(/));
  assert.deepEqual(xhr.method, { value: 'GET', from: 'positional' });
  assert.equal(xhr.platformSink, 'xhr');
  assert.deepEqual(xhr.url.resolved, [{ template: '/legacy/ping', dynamicParts: 0, via: 'literal' }]);

  const fetchCall = callAt('src/react/App.tsx', lineOf('src/react/App.tsx', /fetch\('\/health'/));
  assert.deepEqual(fetchCall.method, { value: 'POST', from: 'positional' });
  assert.equal(fetchCall.platformSink, 'fetch');

  // A call with no method at all says null rather than guessing GET.
  const noMethod = callAt('src/api/things.js', lineOf('src/api/things.js', /url: '\/things\/save'/) - 1);
  assert.equal(noMethod.method, null);
});

// ---------------------------------------------------------------------------
// A function handed over as a VALUE (webfacts/3)
// ---------------------------------------------------------------------------
//
// `usePagedList({ api: listThings })` never calls `listThings`, so nothing that
// follows calls can see that this screen depends on it. What the worker records
// is which identifier was handed over and what this file binds it to; whether
// the receiver ever calls it is the bridge's problem, not this one's.

const BOARD = 'src/views/things/board.vue';

test('an identifier handed over as a value is recorded, by property and by argument', () => {
  const byProperty = callAt(BOARD, lineOf(BOARD, /api: listThings/));
  assert.deepEqual(byProperty.fnRefs, [{
    name: 'listThings',
    binding: { kind: 'import', source: '@/api/things', imported: 'listThings' },
    via: 'property',
    key: 'api',
  }]);

  const byArgument = callAt(BOARD, lineOf(BOARD, /usePagedList\(saveThing/));
  assert.deepEqual(byArgument.fnRefs, [{
    name: 'saveThing',
    binding: { kind: 'import', source: '@/api/things', imported: 'saveThing' },
    via: 'argument',
  }]);
});

test('a member of a namespace import keeps the root and the path it was written with', () => {
  const rec = callAt(BOARD, lineOf(BOARD, /usePagedList\(thingApi\./));
  assert.deepEqual(rec.fnRefs, [{
    name: 'thingApi',
    path: ['detailThing'],
    binding: { kind: 'import', source: '@/api/things', imported: '*' },
    via: 'argument',
  }]);
});

test('a string is not a reference, and neither is an inline arrow', () => {
  // The same object literal carries `api: listThings`, `title: 'board'` and
  // `after: (rows) => …`. Only the first is a function this file can name: a
  // string is a string, and an arrow's own body is already attributed to the
  // function that encloses it.
  const rec = callAt(BOARD, lineOf(BOARD, /api: listThings/));
  assert.equal(rec.fnRefs.length, 1, JSON.stringify(rec.fnRefs));

  // And a call that hands over nothing carries no list at all, rather than an
  // empty one on every call record a frontend has.
  const plain = one('src/views/things/list.vue', 'call', (r) => r.callee.root === 'listThings');
  assert.equal(plain.fnRefs, undefined);
});

// ---------------------------------------------------------------------------
// Enclosing function names
// ---------------------------------------------------------------------------

test('enclosing is the nearest NAMED function: a method shorthand, an arrow const, (module) and (setup)', () => {
  // A method shorthand inside `methods: { … }`, with the call sitting inside a
  // `.then` callback that gets no name of its own.
  const inMethod = one('src/views/things/list.vue', 'call', (r) => r.callee.root === 'listThings');
  assert.equal(inMethod.enclosing, 'getList');

  // An arrow assigned to an exported const.
  const inArrow = callAt('src/api/catalog.ts', lineOf('src/api/catalog.ts', /export const listCatalog/));
  assert.equal(inArrow.enclosing, 'listCatalog');

  // Top-level code in a plain module.
  const inModule = callAt('src/legacy/xhr.js', lineOf('src/legacy/xhr.js', /x\.open\(/));
  assert.equal(inModule.enclosing, '(module)');

  // Top-level code in a `<script setup>` block, including inside an
  // `onMounted(async () => …)` argument, which is not a named function.
  const setupCalls = kind('src/views/catalog/index.vue', 'call');
  const apiCall = setupCalls.find((c) => c.callee.root === 'listCatalog');
  assert.ok(apiCall, JSON.stringify(setupCalls));
  assert.equal(apiCall.enclosing, '(setup)');
});

test('a function record carries its name, span, export state, asyncness and arity', () => {
  const getList = one('src/views/things/list.vue', 'function', (r) => r.name === 'getList');
  assert.equal(getList.exported, 'default-member');
  assert.equal(getList.async, false);
  assert.equal(getList.params, 0);
  assert.ok(getList.endLine > getList.line);

  const store = one('src/api/catalog.ts', 'function', (r) => r.name === 'storeCatalog');
  assert.equal(store.exported, 'named');
  assert.equal(store.params, 2);
});

// ---------------------------------------------------------------------------
// Vue single-file components
// ---------------------------------------------------------------------------

test('every line number in a .vue file is the line in the .vue file, template included', () => {
  const rel = 'src/views/things/list.vue';
  const scriptOpen = lineOf(rel, /^<script>/);
  assert.ok(scriptOpen >= 20, `the fixture must keep the script below line 20 to make this test mean something (it opens at ${scriptOpen})`);

  const fileRec = one(rel, 'file');
  assert.equal(fileRec.lang, 'vue');
  assert.deepEqual(fileRec.blocks, [{ lang: 'js', setup: false, line: scriptOpen }]);

  // The import, the default export and the method are each on the line the
  // fixture puts them on, computed from the fixture rather than written down.
  assert.equal(one(rel, 'import', (r) => r.source === '@/api/things').line, lineOf(rel, /import \{ listThings \}/));
  assert.equal(one(rel, 'export').line, lineOf(rel, /^export default \{/));
  assert.equal(one(rel, 'function', (r) => r.name === 'getList').line, lineOf(rel, /getList\(\) \{/));
  assert.equal(one(rel, 'call', (r) => r.callee.root === 'listThings').line, lineOf(rel, /listThings\(this\.q\)/));
});

test('a `<script setup lang="ts">` block is marked as setup and parsed as TypeScript', () => {
  const rel = 'src/views/catalog/index.vue';
  const fileRec = one(rel, 'file');
  assert.deepEqual(fileRec.blocks, [{ lang: 'ts', setup: true, line: lineOf(rel, /^<script setup/) }]);
  assert.equal(fileRec.recoveredErrors, 0);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('vue-router: nested routes carry their parent, their component source, redirect, meta title and hidden', () => {
  const rel = 'src/router/index.js';
  const routes = kind(rel, 'route');
  assert.ok(routes.every((r) => r.pack === 'vue-router'), JSON.stringify(routes.map((r) => [r.path, r.pack])));
  assert.deepEqual(routes.map((r) => r.path).sort(), ['/', '/catalog', '/login', 'index', 'things/list']);

  const login = routes.find((r) => r.path === '/login');
  assert.equal(login.componentSource, '@/views/login/index.vue');
  assert.equal(login.hidden, true);
  assert.equal(login.parent, null);
  assert.equal(login.children, 0);

  const home = routes.find((r) => r.path === '/');
  assert.equal(home.redirect, '/things/list');
  assert.equal(home.componentLocal, 'Layout');
  assert.equal(home.componentSource, '@/layout/index.vue', 'an identifier bound to an import names the module it came from');
  assert.equal(home.children, 1);

  const child = routes.find((r) => r.path === 'things/list');
  assert.equal(child.parent, home.line, 'a child route points at the LINE of its parent record');
  assert.equal(child.name, 'ThingList');
  assert.equal(child.metaTitle, 'Things');
  assert.equal(child.componentSource, '@/views/things/list.vue');
});

test('react-router: a JSX <Route> tree is a route tree, with the same parent rule', () => {
  const rel = 'src/react/App.tsx';
  const routes = kind(rel, 'route');
  assert.ok(routes.every((r) => r.pack === 'react-router'), JSON.stringify(routes));
  const parent = routes.find((r) => r.path === '/r');
  const child = routes.find((r) => r.path === 'child');
  assert.equal(parent.parent, null);
  assert.equal(parent.children, 1);
  assert.equal(parent.componentSource, '@/react/ThingPanel');
  assert.equal(parent.componentLocal, 'ThingPanel');
  assert.equal(child.parent, parent.line);
  assert.equal(child.componentSource, '@/react/ChildPanel');
});

test('a route path is recorded AS WRITTEN, relative children included', () => {
  const paths = BODY.filter((r) => r.kind === 'route').map((r) => r.path);
  assert.ok(paths.includes('things/list'), 'a relative child path must not be composed here');
  assert.ok(paths.includes('child'));
});

// ---------------------------------------------------------------------------
// Project wiring
// ---------------------------------------------------------------------------

test('a dotenv file in the package directory becomes env records, comments ignored and quotes stripped', () => {
  const env = kind('.env.development', 'config');
  assert.deepEqual(env.map((r) => [r.name, r.value, r.mode]), [
    ['VUE_APP_BASE_API', '/api', 'development'],
    ['VUE_APP_TITLE', 'web smoke', 'development'],
  ]);
  assert.ok(env.every((r) => r.what === 'env'));
});

test('both config files yield their proxy rule, and the rewrite is READ, not just noted', () => {
  const vue = one('vue.config.js', 'config', (r) => r.what === 'proxy');
  assert.equal(vue.context, '/api');
  assert.equal(vue.target, 'http://localhost:8080');
  assert.deepEqual(vue.rewrite, [{ from: '^/api', to: '' }]);

  const vite = one('vite.config.ts', 'config', (r) => r.what === 'proxy');
  assert.equal(vite.context, '/dev-prefix');
  assert.equal(vite.target, 'http://localhost:8080');
  assert.equal(vite.rewrite.length, 1);
  assert.match(vite.rewrite[0].from, /dev-prefix/);
  assert.equal(vite.rewrite[0].to, '');
});

test('the alias comes from all three places a project can declare it, each attributed to its own file', () => {
  const aliases = BODY.filter((r) => r.kind === 'config' && r.what === 'alias');
  assert.deepEqual(
    aliases.map((r) => [r.file, r.from, r.to]).sort(),
    [['jsconfig.json', '@', 'src'], ['vite.config.ts', '@', 'src'], ['vue.config.js', '@', 'src']],
  );
  // Nothing is assumed here, because all three declared it.
  assert.equal(aliases.some((r) => r.assumed === true), false);
});

test('axios.create\'s baseURL rides on the binding that holds the client', () => {
  const b = one('src/utils/http.js', 'binding', (r) => r.name === 'client');
  assert.equal(b.init.shape, 'call');
  assert.deepEqual(b.init.callee, { shape: 'member', root: 'axios', path: ['create'], name: 'create' });
  assert.deepEqual(b.init.binding, { kind: 'import', source: 'axios', imported: 'default' });
  assert.deepEqual(b.init.baseURL, { kind: 'member', root: 'process', path: ['env', 'VUE_APP_BASE_API'] });
  // ...and the default export points back at it, which is the hop the bridge
  // needs to follow `import client from '@/utils/http'`.
  const def = one('src/utils/http.js', 'export', (r) => r.name === 'default');
  assert.deepEqual({ of: def.of, local: def.local }, { of: 'expression', local: 'client' });
});

test('a dynamic import() is an import record, and a call through an import binding says so', () => {
  const dyn = kind('src/router/index.js', 'import').filter((r) => r.dynamic === true);
  assert.deepEqual(dyn.map((r) => r.source).sort(),
    ['@/views/catalog/index.vue', '@/views/login/index.vue', '@/views/things/list.vue']);

  const c = one('src/views/things/list.vue', 'call', (r) => r.callee.root === 'listThings');
  assert.deepEqual(c.binding, { kind: 'import', source: '@/api/things', imported: 'listThings' });
  assert.equal(c.url, null, 'a component passing a payload is not passing a URL');
});

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

test('every count in the summary equals the records it claims to count', () => {
  assert.equal(SUMMARY.kind, 'summary');
  assert.equal(SUMMARY.version, 'webfacts/4');
  const n = (k) => BODY.filter((r) => r.kind === k).length;
  assert.equal(SUMMARY.files, n('file'));
  assert.equal(SUMMARY.parseErrors, n('parse_error'));
  assert.equal(SUMMARY.calls, n('call'));
  assert.equal(SUMMARY.routes, n('route'));
  assert.equal(SUMMARY.imports, n('import'));
  assert.equal(SUMMARY.functions, n('function'));
  assert.equal(SUMMARY.constants, n('constant'));
  assert.equal(SUMMARY.bindings, n('binding'));

  const calls = BODY.filter((r) => r.kind === 'call');
  assert.equal(SUMMARY.callsWithUrl, calls.filter((c) => c.url).length);
  const u = SUMMARY.urlByShape;
  assert.equal(u.literal + u.template + u.constant + u.unresolved, SUMMARY.callsWithUrl,
    'the four url shapes must partition the calls that carry a url');
  assert.equal(u.unresolved, calls.filter((c) => c.url && c.url.resolved === null).length);

  const cfg = BODY.filter((r) => r.kind === 'config');
  assert.equal(SUMMARY.aliases, cfg.filter((r) => r.what === 'alias').length);
  assert.equal(SUMMARY.proxies, cfg.filter((r) => r.what === 'proxy').length);
  assert.equal(SUMMARY.envRecords, cfg.filter((r) => r.what === 'env').length);

  const byPack = {};
  for (const r of BODY) if (r.kind === 'route') byPack[r.pack] = (byPack[r.pack] ?? 0) + 1;
  assert.deepEqual(SUMMARY.byPack, byPack);

  const langs = BODY.filter((r) => r.kind === 'file').map((r) => r.lang);
  assert.equal(SUMMARY.vueFiles, langs.filter((l) => l === 'vue').length);
  assert.equal(SUMMARY.tsFiles, langs.filter((l) => l === 'ts' || l === 'tsx').length);
});

// ---------------------------------------------------------------------------
// Which directories are output, and which merely share a name with one
// ---------------------------------------------------------------------------
//
// This has its own tiny tree in a temp directory rather than a sixth corner of
// `web-smoke`: the whole point is WHERE a directory sits, and that needs a
// second package root, which the shared fixture must not grow.

import os from 'node:os';

/** A throwaway package: a real `build`/`dist` at the boundaries, one deeper down. */
function skipTree(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-webskip-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, 'utf8');
  };
  write('package.json', JSON.stringify({ name: 'skip-tree', dependencies: { vue: '3.0.0' } }));
  // A FEATURE called "build": a form builder, six screens deep in a real
  // project. It is source, and the lane must read it.
  write('src/views/build/x.vue', '<template><div/></template>\n<script>\nexport default { name: "Builder" }\n</script>\n');
  // Output, at the two places output goes.
  write('build/y.js', 'export const bundled = 1\n');
  write('src/dist/z.js', 'export const emitted = 1\n');
  // A control: an ordinary source file, so a run that read nothing at all
  // cannot pass by accident.
  write('src/main.js', 'export const main = 1\n');
  return dir;
}

/** The worker's file records, as root-relative paths. */
function filesRead(root, ...roots) {
  const out = execFileSync(process.execPath, [WORKER, '--root', root, ...roots], { maxBuffer: 1 << 28 }).toString('utf8');
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'file').map((r) => r.file).sort();
}

test('a directory NAMED build deeper than the source root is source, and is read', (t) => {
  const dir = skipTree(t);
  const files = filesRead(dir, path.join(dir, 'src'));
  assert.ok(files.includes('src/views/build/x.vue'),
    `src/views/build/x.vue is a screen, not output, and must be read. Got: ${files.join(', ')}`);
  assert.ok(files.includes('src/main.js'), 'the control file must be read too');
});

test('dist/build/coverage/public are skipped at the source root and at the package root, and only there', (t) => {
  const dir = skipTree(t);

  // Source root `src`: `src/dist` is a direct child of it, so it is output.
  const fromSrc = filesRead(dir, path.join(dir, 'src'));
  assert.equal(fromSrc.includes('src/dist/z.js'), false,
    `src/dist is a direct child of the source root and is output. Got: ${fromSrc.join(', ')}`);
  assert.equal(fromSrc.includes('build/y.js'), false, 'the package root build/ is not under this source root at all');

  // Source root = the PACKAGE directory (what discovery reports for a package
  // with no `src`): now `build` is a direct child of both, and is output.
  const fromPkg = filesRead(dir, dir);
  assert.equal(fromPkg.includes('build/y.js'), false,
    `build/ is a direct child of the package directory and is output. Got: ${fromPkg.join(', ')}`);
  assert.ok(fromPkg.includes('src/views/build/x.vue'), 'the deeper build/ is still source, whichever root was given');
});

test('node_modules, .git and a test directory are skipped at ANY depth', (t) => {
  const dir = skipTree(t);
  fs.mkdirSync(path.join(dir, 'src/views/build/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/views/build/node_modules/dep.js'), 'export const dep = 1\n');
  fs.mkdirSync(path.join(dir, 'src/views/build/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/views/build/__tests__/x.js'), 'export const t = 1\n');
  const files = filesRead(dir, path.join(dir, 'src'));
  assert.equal(files.some((f) => f.includes('node_modules')), false, files.join(', '));
  assert.equal(files.some((f) => f.includes('__tests__')), false, files.join(', '));
  assert.ok(files.includes('src/views/build/x.vue'), 'and their parent is still read');
});

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

test('the fixture is synthetic: it names no project and no wrapper from the corpus', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      files.push(p);
    }
  };
  walk(FIXTURE);
  assert.ok(files.length >= 15, `expected the whole fixture, found ${files.length} file(s)`);
  // The engine must not have been written against any one project, and neither
  // must the fixture it is tested on.
  const forbidden = ['defHttp', 'litemall', 'jeecg', 'ruoyi'];
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const word of forbidden) if (text.includes(word)) hits.push(`${path.relative(ROOT, f)}: ${word}`);
  }
  assert.deepEqual(hits, [], `the fixture must invent its own names:\n${hits.join('\n')}`);
});

test('neither the worker nor a router pack names a wrapper or a project from the corpus', () => {
  const sources = [
    path.join(ROOT, 'adapters', 'web', 'webfacts.mjs'),
    ...fs.readdirSync(path.join(ROOT, 'adapters', 'web', 'packs')).map((f) => path.join(ROOT, 'adapters', 'web', 'packs', f)),
  ];
  const forbidden = ['defHttp', 'litemall', 'jeecg', 'ruoyi'];
  const hits = [];
  for (const f of sources) {
    const text = fs.readFileSync(f, 'utf8');
    for (const word of forbidden) if (text.includes(word)) hits.push(`${path.relative(ROOT, f)}: ${word}`);
  }
  assert.deepEqual(hits, [], `a rule written against one project's spelling works on one project:\n${hits.join('\n')}`);
});

// ---------------------------------------------------------------------------
// A frontend that lives BESIDE the backend
// ---------------------------------------------------------------------------
//
// Two repositories, not one, which is the common real layout: the analyzed root
// is the backend and `--web-src ../front/src` points outside it. The frontend's
// package.json, its `.env` files, its dev-proxy rules and its aliases are all
// ABOVE the root, and the walk that finds them must not stop at it — losing
// them makes every `@/…` import unresolvable and every match a guess, for a
// reason that has nothing to do with the code.

/** A backend directory with a frontend package sitting beside it. */
function besideTree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-webbeside-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), text, 'utf8');
  };
  fs.mkdirSync(path.join(base, 'backend'), { recursive: true });
  write('front/package.json', JSON.stringify({ name: 'beside-front', dependencies: { vue: '3.0.0' } }));
  write('front/.env.development', "VITE_BASE = '/dev-prefix'\n");
  write('front/vite.config.ts', [
    "import { defineConfig } from 'vite'",
    '',
    'export default defineConfig({',
    "  resolve: { alias: { '@': './src' } },",
    '  server: {',
    '    proxy: {',
    "      '/dev-prefix': {",
    "        target: 'http://localhost:8080',",
    "        rewrite: (p: string) => p.replace(/^\\/dev-prefix/, '')",
    '      }',
    '    }',
    '  }',
    '})',
    '',
  ].join('\n'));
  write('front/src/utils/http.ts', [
    "import axios from 'axios'",
    '',
    'const client = axios.create({ baseURL: import.meta.env.VITE_BASE })',
    '',
    'export default client',
    '',
  ].join('\n'));
  write('front/src/api/x.ts', [
    "import client from '@/utils/http'",
    '',
    'export function listX() {',
    "  return client.get({ url: '/x/list' })",
    '}',
    '',
  ].join('\n'));
  return base;
}

test('a frontend BESIDE the analyzed root keeps its package config, stamped with ../', (t) => {
  const base = besideTree(t);
  const out = execFileSync(process.execPath, [
    WORKER, '--root', path.join(base, 'backend'), path.join(base, 'front', 'src'),
  ], { maxBuffer: 1 << 28 }).toString('utf8');
  const records = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const body = records.slice(1, -1);

  // The source files are stamped root-relative, which above the root means `../`.
  const files = body.filter((r) => r.kind === 'file').map((r) => r.file).sort();
  assert.deepEqual(files, ['../front/src/api/x.ts', '../front/src/utils/http.ts', '../front/vite.config.ts']);
  const call = body.find((r) => r.kind === 'call' && r.file === '../front/src/api/x.ts');
  assert.ok(call, JSON.stringify(body.map((r) => [r.kind, r.file])));
  assert.deepEqual(call.url.resolved, [{ template: '/x/list', dynamicParts: 0, via: 'literal' }]);

  // ...and so is every record from the package directory ABOVE the root.
  const cfg = body.filter((r) => r.kind === 'config');
  const env = cfg.find((r) => r.what === 'env');
  assert.ok(env, JSON.stringify(cfg));
  assert.deepEqual(
    { file: env.file, name: env.name, value: env.value, mode: env.mode },
    {
      file: '../front/.env.development', name: 'VITE_BASE', value: '/dev-prefix', mode: 'development',
    },
  );
  const proxy = cfg.find((r) => r.what === 'proxy');
  assert.ok(proxy, JSON.stringify(cfg));
  assert.equal(proxy.file, '../front/vite.config.ts');
  assert.equal(proxy.context, '/dev-prefix');
  assert.equal(proxy.rewrite[0].to, '');
  const alias = cfg.find((r) => r.what === 'alias');
  assert.ok(alias, JSON.stringify(cfg));
  assert.equal(alias.file, '../front/vite.config.ts');
  assert.deepEqual({ from: alias.from, to: alias.to }, { from: '@', to: 'src' });
  // The alias was DECLARED, so nothing here is assumed.
  assert.equal(cfg.some((r) => r.what === 'alias' && r.assumed === true), false);
});

test('a source root with no package.json anywhere above it is still its own package', (t) => {
  // The unchanged half of the rule: the walk stops at the filesystem root and
  // the source root itself is the package, exactly as before.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-webnopkg-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'lone', 'src'), { recursive: true });
  fs.writeFileSync(path.join(base, 'lone', 'src', 'a.js'), "export const a = '/a'\n", 'utf8');
  const out = execFileSync(process.execPath, [
    WORKER, '--root', path.join(base, 'lone'), path.join(base, 'lone', 'src'),
  ], { maxBuffer: 1 << 28 }).toString('utf8');
  const body = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(1, -1);
  assert.deepEqual(body.filter((r) => r.kind === 'file').map((r) => r.file), ['src/a.js']);
  // No package.json above it means no `src` sibling to assume `@` for either,
  // so there is no config record at all rather than a guessed one.
  assert.deepEqual(body.filter((r) => r.kind === 'config'), []);
});
