// rules_catalog.test.mjs — the rule packs as the viewer's Rules tab reads them: each rule whole, and where it left its mark in a pack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinRegistry } from '../src/core/rules/registry.mjs';
import { rulesCatalog } from '../src/core/rules/catalog.mjs';
import { handleApi } from '../src/mcp/http.mjs';

const GRAPH = {
  edges: [
    { type: 'IMPLEMENTS_STMT', evidence: { rule: 'mybatis-plus.mapper' } },
    { type: 'IMPLEMENTS_STMT', evidence: { rule: 'mybatis-plus.mapper' } },
    { type: 'IMPLEMENTS_STMT', evidence: { rule: 'mybatis-plus-join.mapper', library: ['com.github.yulichang.base.MPJBaseMapper'] } },
    { type: 'CALLS', evidence: { rule: 'template-own' } },
    null,
  ],
};

const ruleOf = (catalog, id) => catalog.packs.flatMap((p) => p.rules).find((r) => r.id === id);

test('every pack and rule the engine carries, each rule whole, the same the CLI shows', () => {
  const registry = builtinRegistry();
  const catalog = rulesCatalog(registry);
  assert.deepEqual(catalog.packs.map((p) => p.name), registry.packs.map((p) => p.name));
  for (const [id, entry] of registry.rules) {
    const r = ruleOf(catalog, id);
    assert.deepEqual({ description: r.description, params: r.params, examples: r.examples }, {
      description: entry.rule.description, params: entry.rule.params, examples: entry.rule.examples,
    }, id);
  }
  assert.deepEqual(catalog.kinds.map((k) => k.name).sort(), ['java.code-setting', 'java.contract-link', 'java.route-function', 'java.type-role', 'prisma.operation', 'sql.dialect-path', 'ts.route-decorator', 'ts.type-role']);
  assert.equal(ruleOf(catalog, 'mybatis-plus-join.mapper').grade, 'SOUND_SET');
  assert.equal(ruleOf(catalog, 'mybatis-plus.mapper').grade, null, 'no grade written means the kind\'s own');
});

test('where a rule left its mark: the edges of a pack that name it, and null for a kind that draws none', () => {
  const catalog = rulesCatalog(builtinRegistry(), GRAPH);
  assert.equal(ruleOf(catalog, 'mybatis-plus.mapper').appliedHere, 2);
  assert.equal(ruleOf(catalog, 'mybatis-plus-join.mapper').appliedHere, 1);
  assert.equal(ruleOf(catalog, 'mybatis-plus.service-impl').appliedHere, 0, 'a rule that could draw edges and drew none here');
  assert.equal(ruleOf(catalog, 'sql-dialects.path-names').appliedHere, null, 'a classification draws no edge, so there is nothing to count');
  assert.equal(ruleOf(rulesCatalog(builtinRegistry()), 'mybatis-plus.mapper').appliedHere, null, 'no pack, no count');
});

test('GET /api/rules answers the catalog for the project asked about, and nothing else does', () => {
  const asked = [];
  const deps = { rules: (project) => { asked.push(project); return rulesCatalog(builtinRegistry(), GRAPH); } };
  const ok = handleApi('GET', '/api/rules', null, deps, new URLSearchParams('project=shop'));
  assert.equal(ok.status, 200);
  assert.deepEqual(asked, ['shop']);
  assert.equal(ruleOf(ok.json, 'mybatis-plus.mapper').appliedHere, 2);
  assert.equal(handleApi('POST', '/api/rules', {}, deps, null).status, 405);
  assert.equal(handleApi('GET', '/api/rules', null, {}, null).status, 404, 'a server with no catalog says so');
});
