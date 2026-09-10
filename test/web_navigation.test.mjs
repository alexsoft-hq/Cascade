import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A SCREEN CHANGE IS NOT A REQUEST (RM59), read by the worker that is spawned.
//
// The rule under test is one sentence: a call on a sink the navigation pack
// names changes which screen the browser shows, so it is recorded as a
// navigation and never as an HTTP call. The fixture is one file per router,
// plus one file of things that look like navigations and are not.
//
// What the BRIDGE does with a navigation — whether the path it names is a
// screen this project declares — is in web_bridge.test.mjs, because that needs
// the whole tree and this worker has one file.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-navigation');

const RAW = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, path.join(FIXTURE, 'src')], { maxBuffer: 1 << 28 }).toString('utf8');
const RECORDS = RAW.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const NAVIGATIONS = RECORDS.filter((r) => r.kind === 'navigation');

/** The one navigation written on `file:line`, or a failure naming what is there. */
function navigationAt(file, line) {
  const hits = NAVIGATIONS.filter((r) => r.file === file && r.line === line);
  assert.equal(hits.length, 1, `expected one navigation at ${file}:${line}, got ${JSON.stringify(hits)}`);
  return hits[0];
}

const targetOf = (rec) => (rec.to && Array.isArray(rec.to.resolved)
  ? rec.to.resolved.map((r) => r.template) : null);

test('every navigation carries the router that owns the sink and the evidence rule', () => {
  assert.ok(NAVIGATIONS.length > 0, 'the fixture produced no navigation at all');
  for (const rec of NAVIGATIONS) {
    assert.equal(rec.rule, 'router-navigation');
    assert.ok(['next', 'vue-router', 'react-router', 'browser'].includes(rec.framework), `unknown router ${rec.framework}`);
    assert.equal(typeof rec.sink, 'string');
    assert.equal(typeof rec.enclosing, 'string');
  }
});

test('Next.js: a router a hook made, its three methods, and a link element', () => {
  const file = 'src/pages/CrateList.tsx';
  assert.deepEqual(targetOf(navigationAt(file, 10)), ['/crates/{*}']);
  assert.equal(navigationAt(file, 10).sink, 'router.push');
  assert.deepEqual(targetOf(navigationAt(file, 14)), ['/']);
  assert.equal(navigationAt(file, 14).sink, 'router.replace');
  assert.deepEqual(targetOf(navigationAt(file, 17)), ['/crates/new']);
  assert.equal(navigationAt(file, 17).sink, 'router.prefetch');
  assert.deepEqual(targetOf(navigationAt(file, 23)), ['/crates/archive']);
  assert.equal(navigationAt(file, 23).sink, '<Link href>');
});

test('a router takes the path as an object as readily as text', () => {
  // `push({pathname, query})` is the same navigation as `push(pathname)`, and
  // the query is not part of where it goes.
  assert.deepEqual(targetOf(navigationAt('src/pages/CrateList.tsx', 19)), ['/crates/new']);
});

test('Vue: `this.$router` is the framework\'s own property, in the options style', () => {
  assert.deepEqual(targetOf(navigationAt('src/views/CratePanel.vue', 9)), ['/crates/{*}']);
  assert.equal(navigationAt('src/views/CratePanel.vue', 9).sink, '$router.push');
  assert.deepEqual(targetOf(navigationAt('src/views/CratePanel.vue', 12)), ['/crates']);
});

test('a hook\'s value is a router whatever the file calls it', () => {
  // The fixture binds `useRouter()` to `nav`, so a rule that matched the NAME
  // `router` would see nothing here.
  const rec = navigationAt('src/views/crateActions.js', 7);
  assert.equal(rec.framework, 'vue-router');
  assert.equal(rec.sink, 'nav.push');
  assert.deepEqual(targetOf(rec), ['/crates/{*}']);
});

test('react-router: the navigate function itself, an import, and two elements', () => {
  const file = 'src/views/ShipmentPanel.jsx';
  assert.deepEqual(targetOf(navigationAt(file, 7)), ['/shipments/{*}']);
  assert.equal(navigationAt(file, 7).sink, 'go()');
  assert.deepEqual(targetOf(navigationAt(file, 8)), ['/shipments']);
  assert.equal(navigationAt(file, 8).sink, 'redirect()');
  assert.equal(navigationAt(file, 11).sink, '<Link to>');
  assert.equal(navigationAt(file, 12).sink, '<Navigate to>');
});

test('the browser\'s own address bar counts, set as a property or called', () => {
  const file = 'src/views/addressBar.js';
  assert.deepEqual(targetOf(navigationAt(file, 3)), ['/portal/home']);
  assert.equal(navigationAt(file, 3).sink, 'window.location.href');
  assert.equal(navigationAt(file, 7).sink, 'location.assign');
  assert.equal(navigationAt(file, 11).sink, 'window.location.replace');
});

test('a navigation is NOT an HTTP call: none of them is in the call records', () => {
  const calls = RECORDS.filter((r) => r.kind === 'call' && r.url);
  const where = calls.map((c) => `${c.file}:${c.line}`).sort();
  // The only two calls with a URL in the whole fixture are the decoys, which
  // are calls and must stay calls.
  assert.deepEqual(where, ['src/views/Decoy.jsx:8', 'src/views/Decoy.jsx:9']);
});

test('a push on something that is not a router, and a Link from a component library, are not navigations', () => {
  assert.deepEqual(NAVIGATIONS.filter((r) => r.file === 'src/views/Decoy.jsx'), []);
});

test('the summary counts the navigations, by the router each one went through', () => {
  const summary = RECORDS.find((r) => r.kind === 'summary');
  assert.equal(summary.navigations, NAVIGATIONS.length);
  assert.deepEqual(summary.navigationsByFramework, {
    next: 5, 'vue-router': 3, 'react-router': 4, browser: 3,
  });
});
