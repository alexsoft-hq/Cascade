// rules_tool.test.mjs — the `rules` tool: every rule this engine runs, what each gave in the pack at hand, and the links one gave.
//
// A rule gives two kinds of thing. A rule that draws a link names itself on it
// (`evidence.rule`); a rule that decides what a NODE is names itself in that
// node's own evidence block (`prismaEvidence.rule` on a Prisma statement). The
// Rules tab used to count only the first, and said "0 links" for the rule that
// had made every statement of a NestJS project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { appliedIndex } from '../src/core/rules/applied.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';
import { callTool, DispatchError, toolList } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { handleApi } from '../src/mcp/http.mjs';
import { exampleVerdicts } from '../src/cli/rule_examples.mjs';

/** A NestJS + Prisma pack in miniature: two routes, one Prisma statement, and a MyBatis-Plus link nowhere. */
function nestPack() {
  const g = new Graph();
  const ctl = 'symbol:src/users/users.controller.ts#UsersController.list';
  const svc = 'symbol:src/users/users.service.ts#UsersService.all';
  const stmt = 'statement:prisma:src/users/users.service.ts#UsersService.all/0';
  for (const [path, grade] of [['/api/users', 'HEURISTIC'], ['/api/users/{id}', 'EXACT']]) {
    g.addNode({ id: `endpoint:GET ${path}`, path, httpMethod: 'GET', handler: ctl });
    g.addEdge({ from: `endpoint:GET ${path}`, to: ctl, type: 'HANDLES', grade, evidence: { rule: 'nestjs.routes', basis: 'a controller declares this route' } });
  }
  g.addNode({ id: ctl, file: 'src/users/users.controller.ts' });
  g.addNode({ id: svc, file: 'src/users/users.service.ts' });
  g.addEdge({ from: ctl, to: svc, type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: 'ts-injected-field' } });
  g.addNode({ id: stmt, statementType: 'select', prismaEvidence: { rule: 'prisma.operations', client: 'prisma.client', operation: 'findMany' } });
  g.addEdge({ from: svc, to: stmt, type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { rule: 'prisma.client', basis: 'this method sends findMany on User through a Prisma client' } });
  g.addEdge({ from: stmt, to: 'table:User', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  return g;
}

const basis = () => ({ project: 'shop', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const ask = (args, g = nestPack()) => callTool('rules', args, { graph: g, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' } });

test('what a rule gave: the links whose evidence names it, and the nodes an evidence block of their own marks', () => {
  const index = appliedIndex(nestPack());
  assert.equal(index.get('nestjs.routes').edges.length, 2);
  assert.equal(index.get('prisma.client').edges.length, 1);
  assert.deepEqual(index.get('prisma.operations'), { edges: [], nodes: ['statement:prisma:src/users/users.service.ts#UsersService.all/0'] });
  // `client` names the rule that knew the client; only `rule` says which rule made the node
  assert.equal(index.get('prisma.client').nodes.length, 0);
});

test('the list: every rule, what applies HERE first and biggest first, and a classification counted as nothing to count', () => {
  const r = ask({});
  assertContract(r);
  const rows = r.answer.rules;
  assert.equal(rows.length, builtinRegistry().rules.size);
  assert.deepEqual(rows.slice(0, 3).map((x) => [x.id, x.gave, x.here]), [
    ['nestjs.routes', { edges: 2, nodes: 0, byType: { HANDLES: 2 }, byGrade: { EXACT: 1, HEURISTIC: 1 }, byKind: {} }, true],
    ['prisma.client', { edges: 1, nodes: 0, byType: { IMPLEMENTS_STMT: 1 }, byGrade: { EXACT: 1 }, byKind: {} }, true],
    ['prisma.operations', { edges: 0, nodes: 1, byType: {}, byGrade: {}, byKind: { statement: 1 } }, true],
  ]);
  assert.ok(rows.slice(3).every((x) => !x.here), 'nothing that gave nothing sorts above something that did');
  const dialects = rows.find((x) => x.id === 'sql-dialects.path-names');
  assert.equal(dialects.gave, null, 'a kind that only classifies leaves nothing in a pack to count');
  assert.equal(dialects.grade, null);
  assert.equal(rows.find((x) => x.id === 'mybatis-plus-join.mapper').grade, 'SOUND_SET', 'a rule\'s own grade below its kind\'s cap');
  assert.deepEqual(r.answer.totals, { packs: builtinRegistry().packs.length, rules: rows.length, here: 3 });
  const lanes = Object.fromEntries(r.answer.kinds.map((k) => [k.name, [k.lane, k.draws]]));
  assert.deepEqual(lanes['java.type-role'], ['java', 'links']);
  assert.deepEqual(lanes['sql.dialect-path'], ['sql', 'classifies']);
  assert.deepEqual(lanes['table.join-table'], ['sql', 'classifies'], 'it reads table and column names, whichever lane declared them');
  assert.deepEqual(lanes['prisma.operation'], ['ts', 'links']);
});

test('the list narrows by what applies here, by lane, by kind and by a word, and says why an empty list is empty', () => {
  assert.deepEqual(ask({ here: true }).answer.rules.map((x) => x.id), ['nestjs.routes', 'prisma.client', 'prisma.operations']);
  assert.ok(ask({ lane: 'java' }).answer.rules.every((x) => x.lane === 'java'));
  assert.deepEqual(ask({ kind: 'prisma.operation' }).answer.rules.map((x) => x.id), ['prisma.operations']);
  assert.deepEqual(ask({ query: 'NESTJS HTTP CONTROLLERS' }).answer.rules.map((x) => x.id), [], 'a word of the pack\'s description is not the rule\'s');
  assert.deepEqual(ask({ query: '@CONTROLLER(PATH)' }).answer.rules.map((x) => x.id), ['nestjs.routes'], 'any case, and the rule\'s own description');
  const none = ask({ query: 'no rule says this' });
  assert.deepEqual(none.answer.rules, []);
  assert.equal(none.answer.empty.rules, 'not-in-this-axis');
  assert.throws(() => ask({ kind: 'java.nothing' }), (e) => e instanceof DispatchError && e.code === 'bad-input');
});

test('one rule: the rule whole, and the links it gave with both ends, their grade and their lane\'s sentence, a page at a time', () => {
  const r = ask({ rule: 'nestjs.routes', limit: 1 });
  assertContract(r);
  const a = r.answer;
  assert.equal(a.rule.id, 'nestjs.routes');
  assert.equal(a.rule.lane, 'ts');
  assert.ok(a.rule.examples.length > 0 && a.rule.params, 'the rule whole, as its pack writes it');
  assert.deepEqual(a.gave, { edges: 2, nodes: 0, byType: { HANDLES: 2 }, byGrade: { EXACT: 1, HEURISTIC: 1 }, byKind: {} });
  assert.deepEqual(a.edges, [{
    from: { id: 'endpoint:GET /api/users', kind: 'endpoint', label: 'GET /api/users' },
    to: { id: 'symbol:src/users/users.controller.ts#UsersController.list', kind: 'symbol', label: 'users.controller.ts#UsersController.list' },
    type: 'HANDLES', grade: 'HEURISTIC', basis: 'a controller declares this route',
  }]);
  const edges = r.truncated.fields.find((f) => f.field === 'edges');
  assert.deepEqual([edges.shown, edges.total, edges.nextOffset], [1, 2, 1]);
  assert.equal(r.answer.empty.nodes, 'none');
  const next = ask({ rule: 'nestjs.routes', limit: 1, offset: 1 });
  assert.equal(next.answer.edges[0].from.id, 'endpoint:GET /api/users/{id}');
});

test('one rule that makes nodes lists them; a classification says it has nothing to count; an unknown rule is unknown', () => {
  const ops = ask({ rule: 'prisma.operations' }).answer;
  assert.deepEqual(ops.nodes, [{ id: 'statement:prisma:src/users/users.service.ts#UsersService.all/0', kind: 'statement', label: 'users.service.ts#UsersService.all/0' }]);
  assert.deepEqual(ops.gave.byKind, { statement: 1 });
  const dialects = ask({ rule: 'sql-dialects.path-names' });
  assert.equal(dialects.answer.gave, null);
  assert.deepEqual(dialects.answer.empty, { edges: 'not-shipped', nodes: 'not-shipped' });
  assert.ok(dialects.limits.some((l) => l.scope === 'rules' && /draws no link/.test(l.reason)));
  assert.throws(() => ask({ rule: 'nestjs.nothing' }), (e) => e instanceof DispatchError && e.code === 'unknown-key');
});

test('a classifying rule a lane names on what it decided is counted, not called "nothing to count"', () => {
  // typeorm.receivers classifies a receiver as a repository; the TypeORM lane
  // names it on the statement link it typed (nestjs-realworld-example-app: 48).
  const g = nestPack();
  g.addEdge({ from: 'symbol:src/a.service.ts#A.load', to: 'statement:typeorm:src/a.service.ts#A.load/0', type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { rule: 'typeorm.receivers' } });
  const row = ask({}, g).answer.rules.find((x) => x.id === 'typeorm.receivers');
  assert.equal(row.here, true);
  assert.equal(row.gave.edges, 1);
  assert.equal(ask({}).answer.rules.find((x) => x.id === 'typeorm.receivers').gave, null, 'named nowhere, it has nothing to count');
});

test('the catalog publishes the tool with its arguments, and the project routing argument like every other', () => {
  const t = toolList().tools.find((x) => x.name === 'rules');
  assert.ok(t, 'rules is in tools/list');
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['here', 'kind', 'lane', 'limit', 'offset', 'project', 'query', 'rule']);
  assert.deepEqual(t.inputSchema.properties.lane.enum, ['java', 'ts', 'sql']);
});

test('GET /api/rules/examples answers whether each example holds, and a server that runs none says so', () => {
  const deps = { ruleExamples: () => ({ rules: [{ id: 'nestjs.routes', total: 2, held: [true, false], notRun: null }] }) };
  const ok = handleApi('GET', '/api/rules/examples', null, deps, null);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.rules[0].held, [true, false]);
  assert.equal(handleApi('GET', '/api/rules/examples', null, {}, null).status, 404);
  assert.equal(handleApi('POST', '/api/rules/examples', {}, deps, null).status, 405);
});

test('the example verdicts the page shows are the ones `cascade rules test` gives: one per example, in pack order', () => {
  const registry = builtinRegistry();
  const v = exampleVerdicts(registry);
  assert.equal(v.rules.length, registry.rules.size);
  for (const r of v.rules) {
    const examples = registry.rules.get(r.id).rule.examples;
    if (r.notRun) { assert.equal(r.held, null, `${r.id} was not run, so nothing is said to hold`); continue; }
    assert.equal(r.held.length, examples.length, r.id);
    assert.ok(r.held.every((x) => x === true), `${r.id}: every example the engine carries holds`);
  }
  // the TypeScript kinds need nothing but the engine, so they always run
  assert.equal(v.rules.find((r) => r.id === 'prisma.operations').notRun, null);
});
