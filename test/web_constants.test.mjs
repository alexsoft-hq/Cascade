import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A URL BUILT ON A NAMED CONSTANT (RM58), read by the worker that is spawned.
//
// The rule under test is one sentence: a hole in a URL template that is a name
// THIS FILE can follow to text is filled in, and everything else stays a hole
// with its kind on it. So the fixture is one file per way a name can fail —
// another module's export, an environment variable, a call, a circle — beside
// the one way it succeeds.
//
// What the BRIDGE does with an imported constant is in web_bridge.test.mjs,
// because following an import needs the other files and this worker has one.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-constants');

const RAW = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, path.join(FIXTURE, 'src')], { maxBuffer: 1 << 28 }).toString('utf8');
const RECORDS = RAW.split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** The url record of the one call written inside `enclosing`. */
function urlOf(enclosing) {
  const hits = RECORDS.filter((r) => r.kind === 'call' && r.enclosing === enclosing);
  assert.equal(hits.length, 1, `expected one call in ${enclosing}, got ${hits.length}`);
  return hits[0].url;
}

const templateOf = (enclosing) => urlOf(enclosing).resolved.map((r) => r.template);

test('a constant declared in the same file is put into the template', () => {
  const url = urlOf('getPost');
  assert.deepEqual(url.substituted, [
    { name: 'POSTS_URL', value: '/board-service/api/v1/posts', from: 'same-file' },
  ]);
  // The text as the source spells it is kept, so the substitution can be read
  // back rather than taken on trust.
  assert.equal(url.written, '{*}/{*}');
  assert.deepEqual(templateOf('getPost'), ['/board-service/api/v1/posts/{*}']);
  assert.deepEqual(url.holes, [{ kind: 'parameter', name: 'postsNo' }]);
});

test('a template whose every hole is filled has no hole left at all', () => {
  assert.deepEqual(templateOf('savePost'), ['/board-service/api/v1/posts/save']);
  assert.equal(urlOf('savePost').holes, undefined);
  assert.equal(urlOf('savePost').resolved[0].dynamicParts, 0);
});

test('a constant built out of another constant is followed to the end of the chain', () => {
  // `ROOT` -> `V1` -> `REPORTS_URL`, three declarations and one path.
  assert.deepEqual(urlOf('getReport').substituted, [
    { name: 'REPORTS_URL', value: '/report-service/api/v1/reports', from: 'same-file' },
  ]);
  assert.deepEqual(templateOf('getReport'), ['/report-service/api/v1/reports/{*}']);
});

test('a constant another module exports stays a hole, with the specifier that leads to it', () => {
  // One file cannot say what another exports. What it CAN say is where to look,
  // and that is what the record carries for the bridge to finish.
  assert.equal(urlOf('listComments').substituted, undefined);
  assert.deepEqual(urlOf('listComments').holes, [
    { kind: 'import', name: 'COMMENTS_URL', source: './urls', imported: 'COMMENTS_URL' },
    { kind: 'parameter', name: 'postsNo' },
  ]);
  // A member of an imported object, and a member of a namespace import: the
  // name is the whole path, and the specifier is the one the root came in on.
  assert.deepEqual(urlOf('listBoardComments').holes[0], {
    kind: 'import', name: 'Paths.boards', source: './urls', imported: 'Paths',
  });
  assert.deepEqual(urlOf('countComments').holes[0], {
    kind: 'import', name: 'Urls.COMMENTS_URL', source: './urls', imported: '*',
  });
});

test('a constant bound to the environment stays a hole, and says it is the environment', () => {
  // `process.env.X` is a DEPLOYMENT fact. Filling it in would state something
  // this repository does not say, so it is named and left.
  assert.deepEqual(urlOf('getExternalReport').holes, [
    { kind: 'env', name: 'EXTERNAL_URL' },
    { kind: 'parameter', name: 'id' },
  ]);
  // Written straight into the template, it is the same answer.
  assert.deepEqual(urlOf('getFromTheEnvironment').holes[0], { kind: 'env', name: 'process.env.API_ROOT' });
});

test('a hole the enclosing function was handed is a parameter, and a call is a call', () => {
  assert.deepEqual(urlOf('getReportRows').holes, [{ kind: 'call', name: 'slug' }]);
  assert.deepEqual(templateOf('getReportRows'), ['/report-service/api/v1/{*}/rows']);
  assert.deepEqual(urlOf('getPost').holes, [{ kind: 'parameter', name: 'postsNo' }]);
});

test('a `let` is not a constant, whatever it was initialized with', () => {
  // `let tenant = 'default'` and an `if` that assigns it again is real code
  // (jeecg-boot writes exactly that for a tenant id). The initializer is not
  // what the name holds, so it is left as a hole rather than stated as a path.
  assert.deepEqual(urlOf('getForTenant').holes, [{ kind: 'parameter', name: 'tenant' }]);
  assert.deepEqual(templateOf('getForTenant'), ['/report-service/api/v1/reports/of/{*}']);
});

test('two constants that name each other stop, rather than running for ever', () => {
  assert.deepEqual(urlOf('getLoopedReport').holes[0], { kind: 'unknown', name: 'LOOP_A' });
  assert.deepEqual(templateOf('getLoopedReport'), ['{*}/{*}']);
});

test('two runs over the same tree print identical bytes', () => {
  const again = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, path.join(FIXTURE, 'src')], { maxBuffer: 1 << 28 }).toString('utf8');
  assert.equal(again, RAW);
});
