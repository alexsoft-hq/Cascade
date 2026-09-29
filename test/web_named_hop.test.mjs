import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { addWebFacts, webEndpointId } from '../src/adapters/web_bridge.mjs';
import { buildRegistry, builtinRegistry, RuleError } from '../src/core/rules/registry.mjs';
import { namedHopsOf } from '../src/core/rules/kinds/web_wrapper_hop.mjs';

// A framework's own wrapper step, settled by a rule pack rather than by its
// code (RM67, V5). vue-vben-admin's client class copies the request into a
// local its hooks assign again, so the lane's default-deny reading rightly
// leaves that step unsettled; the framework's source says what it does to each
// key, and `web.wrapper-hop` (src/core/rules/packs/vben-admin.json) says it as
// data. The fixture (test/fixtures/web-named-hop) is a frontend in that shape
// under other names: a rule names the step by the class's shape, never by the
// class's or the project's name, and a step no rule names stays unsettled.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-named-hop');
const STEP = 'src/utils/http/axios/Axios.ts#ApiClient.request';
const RULE = 'vben-admin.request';

function factsOf(dir) {
  return execFileSync(process.execPath, [WORKER, '--root', dir, path.join(dir, 'src')], { maxBuffer: 1 << 26 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const ROUTES = [['GET', '/sys/user/list'], ['POST', '/sys/user/add'], ['PUT', '/sys/user/edit'], ['DELETE', '/sys/user/delete'], ['POST', '/sys/common/upload']];
function run(opts = {}, facts = factsOf(FIXTURE)) {
  const g = new Graph();
  for (const [m, p] of ROUTES) {
    const id = webEndpointId(m, p);
    g.addNode({ id, path: p, httpMethod: m, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  const stats = addWebFacts(g, facts, opts);
  return { g, stats };
}
const edgeOf = (g, fn) => {
  const es = g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from.endsWith(`#${fn}`));
  assert.equal(es.length, 1, `${fn}: ${JSON.stringify(es.map((e) => [e.to, e.grade]))}`);
  return es[0];
};

test('a step a rule names is settled as the rule says: the URL and the verb arrive, and the edge names the rule', () => {
  const { g } = run();
  const e = edgeOf(g, 'list');
  assert.equal(e.to, webEndpointId('GET', '/sys/user/list'));
  assert.equal(e.evidence.sink.unsettled, undefined, JSON.stringify(e.evidence.sink.unsettled));
  assert.deepEqual(e.evidence.sink.hop, { rule: RULE, step: STEP });
  assert.deepEqual(e.evidence.method, { value: 'GET', from: 'wrapper-verb' });
  // The DELETE verb arrives too, beside options that name no key of the prefix.
  const d = edgeOf(g, 'remove');
  assert.equal(d.to, webEndpointId('DELETE', '/sys/user/delete'));
  assert.equal(d.evidence.sink.unsettled, undefined, JSON.stringify(d.evidence.sink.unsettled));
  assert.deepEqual(d.evidence.method, { value: 'DELETE', from: 'wrapper-verb' });
  // `params` written as an object is never text, so nothing is appended.
  assert.equal(edgeOf(g, 'edit').evidence.sink.unsettled, undefined);
});

test('the prefix the step puts before the URL comes from request options this lane does not read: a guess until declared', () => {
  const { g, stats } = run();
  const e = edgeOf(g, 'list');
  assert.equal(e.evidence.prefix.from, 'auto');
  assert.deepEqual(e.evidence.prefix.hop, { rule: RULE, by: ['apiUrl', 'urlPrefix', 'joinPrefix'] });
  assert.equal(e.grade, 'HEURISTIC');
  // The census says which prefix that was and why it is not the client's own.
  const inst = stats.prefix[''].instances.find((i) => i.hop);
  assert.ok(inst, JSON.stringify(stats.prefix));
  assert.deepEqual([inst.from, inst.hop.rule, inst.hop.of], ['auto', RULE, 'src/utils/http/axios/Axios.ts#ApiClient.axiosInstance']);
  // It is not one more client instance: the client is the one the class holds.
  assert.equal(stats.instances, 2);
  // Declared, the prefix is the project's word, and the settled calls are SOUND_SET.
  const { g: d } = run({ gatewayRoutes: { '*': '' } });
  assert.equal(edgeOf(d, 'list').grade, 'SOUND_SET');
  assert.equal(edgeOf(d, 'list').evidence.prefix.from, 'declared');
  assert.equal(edgeOf(d, 'remove').grade, 'SOUND_SET');
});

test('what the step does to a call it cannot see through is not settled: text params, and options that may set the prefix', () => {
  const { g } = run({ gatewayRoutes: { '*': '' } });
  const add = edgeOf(g, 'add');
  assert.equal(add.grade, 'HEURISTIC');
  assert.deepEqual(['hop', 'why', 'key', 'from'].map((k) => add.evidence.sink.unsettled?.[k]), [STEP, 'hop-append', 'url', 'params']);
  assert.equal(typeof add.evidence.sink.unsettled.reason, 'string');
  const away = edgeOf(g, 'elsewhere');
  assert.deepEqual(['why', 'key', 'option'].map((k) => away.evidence.sink.unsettled?.[k]), ['hop-option', 'url', 'apiUrl']);
  assert.equal(away.grade, 'HEURISTIC');
  const unread = edgeOf(g, 'withOptions');
  assert.deepEqual(['why', 'key', 'option'].map((k) => unread.evidence.sink.unsettled?.[k]), ['hop-option', 'url', null]);
});

test('a step no rule names stays unsettled: another method of the class, and a class of another shape', () => {
  const { g } = run({ gatewayRoutes: { '*': '' } });
  const up = edgeOf(g, 'upload');
  assert.deepEqual([up.evidence.sink.unsettled?.why, up.evidence.sink.unsettled?.key], ['written', 'baseURL']);
  assert.equal(up.evidence.sink.hop, undefined);
  const plain = edgeOf(g, 'plainList');
  assert.deepEqual([plain.evidence.sink.unsettled?.why, plain.evidence.sink.unsettled?.name], ['reassigned', 'conf']);
  assert.equal(plain.evidence.sink.hop, undefined);
  assert.equal(plain.grade, 'HEURISTIC');
});

test('a named step whose client call is not the shape the rule relies on is read as its code reads', () => {
  // The rule reads the local the client call hands on as the request copied and
  // passed through the hooks. A call that hands on something else (a name bound
  // to nothing here, `this`) is not that, and the rule says nothing about it.
  const facts = factsOf(FIXTURE).map((r) => (r.kind === 'call' && r.enclosing === 'ApiClient.request' && r.reads?.open?.why === 'reassigned'
    ? { ...r, reads: { ...r.reads, open: { why: 'unbound', name: r.reads.open.name } } } : r));
  const { g } = run({ gatewayRoutes: { '*': '' } }, facts);
  const e = edgeOf(g, 'list');
  assert.deepEqual([e.evidence.sink.unsettled?.why, e.evidence.sink.hop, e.grade], ['unbound', undefined, 'HEURISTIC']);
});

test('without the rule the same step is what it was: unsettled, through a variable assigned again', () => {
  const { g, stats } = run({ hopRules: [], gatewayRoutes: { '*': '' } });
  for (const fn of ['list', 'remove', 'edit']) {
    const e = edgeOf(g, fn);
    assert.deepEqual([e.evidence.sink.unsettled?.why, e.evidence.sink.unsettled?.hop, e.grade], ['reassigned', STEP, 'HEURISTIC'], fn);
    assert.equal(e.evidence.sink.hop, undefined);
  }
  assert.ok(Object.values(stats.prefix).every((p) => p.instances.every((i) => !i.hop)));
});

test('the rule names a step by the class\'s shape, never by a name', () => {
  const facts = factsOf(FIXTURE);
  const rules = builtinRegistry().ofKind('web.wrapper-hop');
  assert.deepEqual([...namedHopsOf(facts, rules).keys()], [STEP]);
  // The same class under the framework's own name is the same step.
  const renamed = facts.map((r) => JSON.parse(JSON.stringify(r).replaceAll('ApiClient', 'VAxios')));
  assert.deepEqual([...namedHopsOf(renamed, rules).keys()], ['src/utils/http/axios/Axios.ts#VAxios.request']);
  // One method short of the shape is not the framework's class.
  const short = facts.map((r) => (r.kind === 'class' && r.name === 'ApiClient' ? { ...r, methods: r.methods.filter((m) => m !== 'supportFormData') } : r));
  assert.deepEqual([...namedHopsOf(short, rules).keys()], []);
  // A client field built by another library's factory is not this framework's.
  const other = facts.map((r) => (r.kind === 'assign' && r.class === 'ApiClient' && r.field === 'axiosInstance'
    ? { ...r, init: { ...r.init, binding: { ...r.init.binding, source: 'ky' } } } : r));
  assert.deepEqual([...namedHopsOf(other, rules).keys()], []);
});

test('two rules that name one step are a conflict, not a choice by load order', () => {
  const pack = JSON.parse(JSON.stringify(builtinRegistry().rules.get(RULE).rule));
  const twin = { ...pack, id: 'twin.request', params: { ...pack.params, keys: { ...pack.params.keys, method: [{ does: 'set' }] } } };
  const reg = buildRegistry([
    { where: 'a.json', pack: { pack: 'vben-admin', version: 1, description: 'a', rules: [pack] } },
    { where: 'b.json', pack: { pack: 'twin', version: 1, description: 'b', rules: [twin] } },
  ]);
  assert.throws(() => namedHopsOf(factsOf(FIXTURE), reg.ofKind('web.wrapper-hop')), /twin\.request.*vben-admin\.request|vben-admin\.request.*twin\.request/);
});

test('a rule of this kind is refused when it says what the engine cannot read', () => {
  const base = builtinRegistry().rules.get(RULE).rule;
  const refused = (params) => {
    try {
      buildRegistry([{ where: 'x.json', pack: { pack: 'vben-admin', version: 1, description: 'x', rules: [{ ...base, params }] } }]);
    } catch (e) { if (e instanceof RuleError) return e.problems.join('\n'); throw e; }
    return '';
  };
  assert.match(refused({ ...base.params, extra: 1 }), /unknown key "extra"/);
  assert.match(refused({ ...base.params, keys: { ...base.params.keys, url: [{ does: 'rewrite' }] } }), /does must be one of/);
  assert.match(refused({ ...base.params, keys: { method: [{ does: 'keep' }] } }), /keys\.url/);
  assert.match(refused({ ...base.params, framework: { name: 'x' } }), /framework\.declares/);
  assert.match(refused({ ...base.params, keys: { ...base.params.keys, method: [{ does: 'prefix', by: ['x'] }] } }), /method/);
});

test('the worker says which keys an object argument writes, and when params is written as an object', () => {
  const facts = factsOf(FIXTURE);
  const call = (fn) => facts.find((r) => r.kind === 'call' && r.enclosing === fn && r.file === 'src/api/user.ts');
  // What an options object names is what the step's rule reads it by.
  assert.deepEqual(call('remove').args[1], { kind: 'object', keys: {}, names: ['joinParamsToUrl'] });
  assert.deepEqual(call('elsewhere').args[1].names, ['apiUrl']);
  // An object or an array is never text; anything else may be.
  assert.equal(call('edit').args[0].keys.params, 'object');
  assert.equal(call('add').args[0].keys.params, 'present');
  assert.deepEqual(call('list').args[0].names, ['url']);
});
