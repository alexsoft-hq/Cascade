// prisma_follow.test.mjs — a Prisma call's relations followed into the tables they reach, and a client `$extends` makes, through the TypeScript bridge.
//
// In the style of test/ts_bridge.test.mjs: each fixture is a small NestJS
// service written out here and read by the real TypeScript worker, so what is
// under test is what addTsFacts draws for one call: which tables it EXECUTES,
// which columns it READS and WRITES, how sure each edge is, and which relation
// gave it (`evidence.relation`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { readPrismaSchema } from '../src/adapters/ts/prisma_schema.mjs';

const SCHEMA = readPrismaSchema([
  'model User {',
  '  id     Int     @id',
  '  email  String',
  '  posts  Post[]',
  '  tags   Tag[]',
  '  profile Profile?',
  '  ghost   Profile[] @relation("ghost")',
  '}',
  'model Post {',
  '  id        Int     @id',
  '  title     String',
  '  published Boolean',
  '  authorId  Int',
  '  author    User    @relation(fields: [authorId], references: [id])',
  '}',
  'model Tag {',
  '  id    Int    @id',
  '  name  String',
  '  users User[]',
  '}',
  'model Profile {',
  '  id     Int  @id',
  '  userId Int  @unique',
  '  user   User @relation(fields: [userId], references: [id])',
  '  owner  User @relation("orphan", fields: [userId], references: [id])',
  '}',
  // Optional relations, for the null checks and the writes a literal leaves idle:
  // Member holds a one-to-many link to Team, Badge a one-to-one link to Team.
  'model Team {',
  '  id      Int      @id',
  '  name    String',
  '  members Member[]',
  '  badge   Badge?',
  '}',
  'model Member {',
  '  id     Int   @id',
  '  teamId Int?',
  '  team   Team? @relation(fields: [teamId], references: [id])',
  '}',
  'model Badge {',
  '  id     Int   @id',
  '  teamId Int?  @unique',
  '  team   Team? @relation(fields: [teamId], references: [id])',
  '}',
].join('\n'));

const PRISMA_SERVICE = ['prisma.service.ts', [
  "import { PrismaClient, Prisma } from '@prisma/client';",
  'export class PrismaService extends PrismaClient {}',
].join('\n')];

/** One service whose method `run` holds `body`, read with the schema above; the statements of `run`, in order. */
function run(body, extraMembers = []) {
  const svc = ['svc.ts', [
    "import { Prisma } from '@prisma/client';",
    "import { PrismaService } from './prisma.service';",
    'export class Svc {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '  async run(id, t, flag, ext) {',
    ...body,
    '  }',
    ...extraMembers,
    '}',
  ].join('\n')];
  const g = new Graph();
  const stats = addTsFacts(g, [PRISMA_SERVICE, svc].flatMap(([f, s]) => factsOfFile(f, s)), { prisma: { schema: SCHEMA } });
  const edgesOf = (sid) => g.edges.filter((e) => e.from === sid).map((e) => `${e.type} ${e.grade} ${e.to.replace(/^(table|column):/, '')}${e.evidence?.access ? ` [${e.evidence.access}]` : ''}${e.evidence?.relation ? ` via ${e.evidence.relation}` : ''}`).sort();
  return { g, stats, sid: (n = 0) => `statement:prisma:svc.ts#Svc.run/${n}`, edgesOf };
}

test('include: true reads the related table whole, and the columns its join matches on, on both sides, each edge naming the relation', () => {
  const { edgesOf, sid, g } = run(['    return this.prisma.user.findUnique({ where: { id }, include: { posts: true } });']);
  assert.deepEqual(edgesOf(sid()).filter((e) => e.includes('Post')), [
    'EXECUTES EXACT Post [read] via User.posts',
    'READS EXACT Post.authorId via User.posts',
    'READS EXACT Post.id via User.posts',
    'READS EXACT Post.published via User.posts',
    'READS EXACT Post.title via User.posts',
  ]);
  assert.ok(edgesOf(sid()).includes('READS EXACT User.id'), 'the join reads User.id too, which the where already names');
  assert.equal(g.nodes.get(sid()).unresolved, undefined, 'nothing was left unfollowed');
});

test('a relation in a select is a find of its own: only what its select and where name, and the join', () => {
  const { edgesOf, sid } = run(['    return this.prisma.user.findMany({ select: { email: true, posts: { where: { published: true }, select: { title: true } } } });']);
  assert.deepEqual(edgesOf(sid()), [
    'EXECUTES EXACT Post [read] via User.posts',
    'EXECUTES EXACT User [read]',
    'READS EXACT Post.authorId via User.posts',
    'READS EXACT Post.published via User.posts',
    'READS EXACT Post.title via User.posts',
    'READS EXACT User.email',
    'READS EXACT User.id via User.posts',
  ]);
});

test('_count reads the rows it counts through the join, and its own where; a relation filter reads what it filters on', () => {
  const { edgesOf, sid } = run(['    return this.prisma.user.findMany({ where: { posts: { some: { title: t } } }, select: { _count: { select: { tags: true } } } });']);
  assert.deepEqual(edgesOf(sid()), [
    'EXECUTES EXACT Post [read] via User.posts',
    'EXECUTES EXACT Tag [read] via User.tags',
    'EXECUTES EXACT User [read]',
    'EXECUTES EXACT _TagToUser [read] via User.tags',
    'READS EXACT Post.authorId via User.posts',
    'READS EXACT Post.title via User.posts',
    'READS EXACT Tag.id via User.tags',
    'READS EXACT User.id via User.posts',
    'READS EXACT _TagToUser.A via User.tags',
    'READS EXACT _TagToUser.B via User.tags',
  ]);
});

test('a nested create writes the related table and the column that holds the link on its side; a connect on the other side writes the link where it sits and only reads the row it finds', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.user.update({ where: { id }, data: { posts: { create: [{ title: t, published: false }] } } });',
    '    await this.prisma.post.create({ data: { title: t, published: true, author: { connect: { id } } } });',
  ]);
  const create = edgesOf(sid(0));
  assert.ok(create.includes('EXECUTES EXACT Post [write] via User.posts'));
  assert.ok(create.includes('WRITES EXACT Post.authorId via User.posts'), 'Prisma sets the link on the row it inserts');
  assert.ok(create.includes('WRITES EXACT Post.title via User.posts'));
  const connect = edgesOf(sid(1));
  assert.ok(connect.includes('EXECUTES EXACT User [read] via Post.author'), 'the connected row is found, not written');
  assert.ok(connect.includes('WRITES EXACT Post.authorId via Post.author'), 'the link is in Post, the row this call inserts');
  assert.ok(connect.includes('READS EXACT User.id via Post.author'));
  assert.ok(!connect.some((e) => e.startsWith('WRITES') && e.includes(' User.')));
});

test('an implicit many-to-many connect inserts rows of its table (A and B written); a disconnect deletes them and writes no column', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.user.update({ where: { id }, data: { tags: { connect: [{ id: 1 }] } } });',
    '    await this.prisma.user.update({ where: { id }, data: { tags: { disconnect: { id: 2 } } } });',
  ]);
  const connect = edgesOf(sid(0));
  assert.ok(connect.includes('EXECUTES EXACT _TagToUser [write] via User.tags'));
  assert.ok(connect.includes('WRITES EXACT _TagToUser.A via User.tags') && connect.includes('WRITES EXACT _TagToUser.B via User.tags'));
  assert.ok(connect.includes('EXECUTES EXACT Tag [read] via User.tags'));
  const disconnect = edgesOf(sid(1));
  assert.ok(disconnect.includes('EXECUTES EXACT _TagToUser [delete] via User.tags'));
  assert.ok(!disconnect.some((e) => e.startsWith('WRITES') && e.includes('_TagToUser')), 'a delete writes no column');
});

test('a relation value only the running program knows MAY be followed: its edges are SOUND_SET, and the key is named', () => {
  const { edgesOf, sid, g } = run(['    return this.prisma.post.create({ data: { title: t, published: true, author: flag }, include: { author: flag } });']);
  const edges = edgesOf(sid());
  assert.ok(edges.includes('EXECUTES SOUND_SET User [write] via Post.author'), 'a nested write held in a variable may write the related table');
  assert.ok(edges.includes('WRITES SOUND_SET Post.authorId via Post.author'));
  assert.ok(edges.includes('READS SOUND_SET User.email via Post.author'), 'an include held in a variable may read its whole row');
  assert.ok(!edges.some((e) => e.includes('EXACT') && e.includes('via Post.author')), 'nothing the variable decides is EXACT');
  assert.match(g.nodes.get(sid()).columnsRuntimeOnlyReason, /data\.author/);
  assert.match(g.nodes.get(sid()).columnsRuntimeOnlyReason, /include\.author/);
});

test('a relation schema.prisma does not let this engine place stays said on the statement, with why', () => {
  const { g, sid } = run(['    return this.prisma.user.findMany({ include: { ghost: true } });']);
  const node = g.nodes.get(sid());
  assert.equal(node.hasUnresolved, true);
  assert.match(node.unresolved[0].detail, /^User\.ghost reaches another table this statement does not name: schema\.prisma names no field of Profile that is the other side of it$/);
  assert.equal(node.unresolved[0].reason, 'relation-not-followed');
});

// ---------------------------------------------------------------------------
// $extends
// ---------------------------------------------------------------------------

test('a local holding what $extends made of a client is a client: its calls are statements, as sure as the client when the extension rewrites no query', () => {
  const { g, sid, stats } = run([
    '    const x = this.prisma.$extends({ result: { user: { label: { compute: () => 1 } } } });',
    '    return x.user.findMany({ select: { email: true } });',
  ]);
  assert.equal(stats.prisma.unreadClientCalls, 0);
  const impl = g.edges.find((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid());
  assert.equal(impl.grade, 'EXACT');
  assert.deepEqual(g.nodes.get(sid()).prismaEvidence.extension, { method: '$extends', read: true, components: ['result'] });
});

test('an extension with a query component, or one this engine cannot read, may change what the call sends: HEURISTIC', () => {
  const query = run([
    '    const x = this.prisma.$extends({ query: { user: { findMany: ({ args, query }) => query(args) } } });',
    '    return x.user.findMany();',
  ]);
  assert.equal(query.g.edges.find((e) => e.type === 'IMPLEMENTS_STMT').grade, 'HEURISTIC');
  assert.deepEqual(query.g.nodes.get(query.sid()).prismaEvidence.extension.rewriting, ['query']);
  const unread = run(['    const x = this.prisma.$extends(ext);', '    return x.user.findMany();']);
  assert.ok(unread.g.edges.filter((e) => e.from === unread.sid() || e.to === unread.sid()).every((e) => e.grade === 'HEURISTIC'));
});

test('a client a method of the class hands back is a client, and an extension Prisma.defineExtension makes is read where that method holds it', () => {
  const { g, sid } = run(['    const x = this.client();', '    return x.post.count({ where: { published: true } });'], [
    '  private client() {',
    '    const e = Prisma.defineExtension((c) => { return c.$extends({ result: {} }); });',
    '    return this.prisma.$extends(e);',
    '  }',
  ]);
  const node = g.nodes.get(sid());
  assert.equal(node.prismaEvidence.returnedBy, 'Svc.client');
  assert.deepEqual(node.prismaEvidence.extension, { method: '$extends', read: true, components: ['result'] });
  assert.equal(g.edges.find((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid()).grade, 'EXACT');
});

test('a name declared again in an inner block is another binding: the outer one still holds the client, the inner one does not', () => {
  const { g, sid, stats } = run([
    '    let x = this.prisma.$extends({});',
    '    if (flag) { const x = make(); x.user.findMany(); }',
    '    return x.user.findMany();',
  ]);
  assert.equal(stats.prisma.statements, 1);
  assert.equal(g.nodes.get(sid()).line, 8, 'the statement is the outer call, on the return line');
  assert.equal(stats.prisma.unreadClientCalls, 1, 'the inner call is counted as unread');
});

test('extended_client_literal_shadow_is_not_a_database_call', () => {
  const { g, sid, stats } = run([
    '    const x = this.prisma.$extends({});',
    '    {',
    '      const x = { user: { findMany() { return []; } } };',
    '      x.user.findMany();',
    '    }',
    '    return x.user.findMany({ select: { email: true } });',
  ]);
  assert.equal(stats.prisma.statements, 1, 'only the call through the client is a statement');
  assert.equal(g.nodes.get(sid()).line, 11);
  assert.equal(g.nodes.get(sid(1)), undefined);
  assert.deepEqual(stats.prisma.unreadSamples.map((s) => s.line), [9], 'the call on the object literal is said, not drawn');
});

test('extended_client_reassignment_invalidates_binding', () => {
  const before = run([
    '    let x = this.prisma.$extends({});',
    '    x = make();',
    '    return x.user.findMany();',
  ]);
  assert.equal(before.stats.prisma.statements, 0, 'a name written again may hold anything by the time of the call');
  assert.equal(before.stats.prisma.unreadClientCalls, 1);
  assert.match(before.stats.prisma.unreadSamples[0].why, /assigned again/);
  const after = run([
    '    let x = this.prisma.$extends({});',
    '    await x.user.findMany();',
    '    const reset = () => { x = make(); };',
    '    reset();',
  ]);
  assert.equal(after.stats.prisma.statements, 0, 'written anywhere the name is in scope, even after the call and in a closure');
});

test('a transaction callback parameter shadowed by an inner function\'s parameter is not the client there', () => {
  const { g, stats } = run([
    '    await this.prisma.$transaction(async (tx) => {',
    '      await tx.user.findMany({ select: { email: true } });',
    '      [1].forEach((tx) => tx.user.findMany());',
    '    });',
  ]);
  assert.equal(stats.prisma.statements, 1);
  assert.equal(g.nodes.get('statement:prisma:svc.ts#Svc.run/0').line, 7);
  assert.equal(stats.prisma.unreadClientCalls, 1);
});

test('an extension argument whose name an inner block declares again is not the defined extension: HEURISTIC', () => {
  const { g, sid } = run([
    '    const e = Prisma.defineExtension({ result: {} });',
    '    {',
    '      const e = ext;',
    '      const x = this.prisma.$extends(e);',
    '      return x.user.findMany();',
    '    }',
  ]);
  assert.equal(g.edges.find((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid()).grade, 'HEURISTIC');
  assert.equal(g.nodes.get(sid()).prismaEvidence.extension.read, false);
});

// ---------------------------------------------------------------------------
// a relation filtered on null
// ---------------------------------------------------------------------------

test('inline_relation_null_reads_only_local_foreign_key', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.member.findMany({ where: { team: null }, select: { id: true } });',
    '    await this.prisma.member.findMany({ where: { team: { is: null } }, select: { id: true } });',
    '    await this.prisma.member.findMany({ where: { team: { isNot: null } }, select: { id: true } });',
    '    await this.prisma.badge.findMany({ where: { team: null }, select: { id: true } });',
  ]);
  for (const n of [0, 1, 2]) {
    assert.deepEqual(edgesOf(sid(n)), ['EXECUTES EXACT Member [read]', 'READS EXACT Member.id', 'READS EXACT Member.teamId via Member.team'], `statement ${n}`);
  }
  assert.deepEqual(edgesOf(sid(3)), ['EXECUTES EXACT Badge [read]', 'READS EXACT Badge.id', 'READS EXACT Badge.teamId via Badge.team'], 'a one-to-one held on this side is the same');
});

test('a relation filtered on null whose key sits on the other side reads the other table, which Prisma joins or subselects', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.team.findMany({ where: { badge: null }, select: { id: true } });',
    '    await this.prisma.team.findMany({ where: { badge: { isNot: null } }, select: { id: true } });',
  ]);
  for (const n of [0, 1]) {
    assert.deepEqual(edgesOf(sid(n)), [
      'EXECUTES EXACT Badge [read] via Team.badge', 'EXECUTES EXACT Team [read]', 'READS EXACT Badge.teamId via Team.badge', 'READS EXACT Team.id',
    ], `statement ${n}`);
  }
});

test('a null check beside a filter on the related row still follows the relation for the filter', () => {
  const { edgesOf, sid } = run(['    return this.prisma.member.findMany({ where: { team: { isNot: null, is: { name: t } } }, select: { id: true } });']);
  const edges = edgesOf(sid());
  assert.ok(edges.includes('EXECUTES EXACT Team [read] via Member.team'));
  assert.ok(edges.includes('READS EXACT Team.name via Member.team'));
});

// ---------------------------------------------------------------------------
// a nested write a literal leaves idle
// ---------------------------------------------------------------------------

test('nested_disconnect_false_emits_no_relation_edges', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.badge.update({ where: { id }, data: { team: { disconnect: false } }, select: { id: true } });',
    '    await this.prisma.member.update({ where: { id }, data: { team: { disconnect: false } }, select: { id: true } });',
  ]);
  assert.deepEqual(edgesOf(sid(0)), ['EXECUTES EXACT Badge [write]', 'READS EXACT Badge.id'], 'on a one-to-one, Prisma returns before building any query');
  assert.ok(edgesOf(sid(1)).includes('WRITES EXACT Member.teamId via Member.team'), 'on the to-one side of a one-to-many, Prisma\'s engine disconnects whatever the boolean says');
});

test('nested_create_empty_emits_no_relation_writes', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.user.update({ where: { id }, data: { email: t, posts: { create: [] } }, select: { id: true } });',
    '    await this.prisma.user.update({ where: { id }, data: { email: t, posts: { connect: [], deleteMany: [] }, tags: { disconnect: [] } }, select: { id: true } });',
    '    await this.prisma.team.update({ where: { id }, data: { badge: { delete: false } }, select: { id: true } });',
  ]);
  assert.deepEqual(edgesOf(sid(0)), ['EXECUTES EXACT User [write]', 'READS EXACT User.id', 'WRITES EXACT User.email']);
  assert.deepEqual(edgesOf(sid(1)), ['EXECUTES EXACT User [write]', 'READS EXACT User.id', 'WRITES EXACT User.email'], 'a many-to-many disconnect of nothing returns before any query');
  assert.deepEqual(edgesOf(sid(2)), ['EXECUTES EXACT Team [write]', 'READS EXACT Team.id']);
});

// Measured on Prisma 6.19.0 over SQLite (.oss-work/rm67/y2/runtime-result.jsonl):
// `posts: { delete: [] }` and `posts: { disconnect: [] }` on a one-to-many send
// `SELECT Post.id, Post.authorId FROM Post WHERE (1=0 AND Post.authorId IN (?))`
// and nothing else on Post; `deleteMany: []`, `create: []` and
// `createMany: { data: [] }` send nothing on Post.
test('nested_empty_delete_and_one_to_many_disconnect_preserve_child_reads', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.user.update({ where: { id }, data: { posts: { delete: [] } }, select: { id: true } });',
    '    await this.prisma.team.update({ where: { id }, data: { members: { disconnect: [] } }, select: { id: true } });',
  ]);
  assert.deepEqual(edgesOf(sid(0)), [
    'EXECUTES EXACT Post [read] via User.posts', 'EXECUTES EXACT User [write]',
    'READS EXACT Post.authorId via User.posts', 'READS EXACT Post.id via User.posts', 'READS EXACT User.id',
  ], 'the children are still looked up, and nothing of Post is written or deleted');
  assert.deepEqual(edgesOf(sid(1)), [
    'EXECUTES EXACT Member [read] via Team.members', 'EXECUTES EXACT Team [write]',
    'READS EXACT Member.id via Team.members', 'READS EXACT Member.teamId via Team.members', 'READS EXACT Team.id',
  ]);
});

test('an empty delete on a many-to-many still looks the rows up through the implicit table, and deletes nothing', () => {
  // Measured (.oss-work/rm67/y2/measured-y2.jsonl): SELECT _TagToUser.B, _TagToUser.A ...; SELECT Tag.id ... WHERE (1=0 AND ...).
  const { edgesOf, sid } = run(['    await this.prisma.user.update({ where: { id }, data: { tags: { delete: [] } }, select: { id: true } });']);
  assert.deepEqual(edgesOf(sid(0)), [
    'EXECUTES EXACT Tag [read] via User.tags', 'EXECUTES EXACT User [write]', 'EXECUTES EXACT _TagToUser [read] via User.tags',
    'READS EXACT Tag.id via User.tags', 'READS EXACT User.id', 'READS EXACT _TagToUser.A via User.tags', 'READS EXACT _TagToUser.B via User.tags',
  ]);
});

test('nested_createMany_empty_data_emits_no_post_write_existing_defect', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.user.update({ where: { id }, data: { posts: { createMany: { data: [] } } }, select: { id: true } });',
    '    await this.prisma.user.update({ where: { id }, data: { posts: { createMany: { data: [], skipDuplicates: true } } }, select: { id: true } });',
    '    await this.prisma.user.update({ where: { id }, data: { posts: { createMany: { data: rows } } }, select: { id: true } });',
  ]);
  assert.deepEqual(edgesOf(sid(0)), ['EXECUTES EXACT User [write]', 'READS EXACT User.id']);
  assert.deepEqual(edgesOf(sid(1)), ['EXECUTES EXACT User [write]', 'READS EXACT User.id']);
  assert.ok(edgesOf(sid(2)).includes('EXECUTES EXACT Post [write] via User.posts'), 'data held in a variable may hold rows');
});

test('set: [] clears the relation, which is a write; a set that lists rows clears and then sets', () => {
  const { edgesOf, sid } = run([
    '    await this.prisma.user.update({ where: { id }, data: { tags: { set: [] } }, select: { id: true } });',
    '    await this.prisma.team.update({ where: { id }, data: { members: { set: [] } }, select: { id: true } });',
    '    await this.prisma.user.update({ where: { id }, data: { tags: { set: [{ id: 1 }] } }, select: { id: true } });',
  ]);
  const clearM2m = edgesOf(sid(0));
  assert.ok(clearM2m.includes('EXECUTES EXACT _TagToUser [delete] via User.tags'));
  assert.ok(!clearM2m.some((e) => e.startsWith('WRITES') && e.includes('_TagToUser')), 'rows are deleted, no column written');
  assert.ok(!clearM2m.includes('EXECUTES EXACT _TagToUser [write] via User.tags'));
  const clearFk = edgesOf(sid(1));
  assert.ok(clearFk.includes('WRITES EXACT Member.teamId via Team.members'), 'the link is set to NULL on the rows that held it');
  const replace = edgesOf(sid(2));
  assert.ok(replace.includes('EXECUTES EXACT _TagToUser [delete] via User.tags') && replace.includes('EXECUTES EXACT _TagToUser [write] via User.tags'));
  assert.ok(replace.includes('WRITES EXACT _TagToUser.A via User.tags'));
});

// ---------------------------------------------------------------------------
// one table read and written by one call
// ---------------------------------------------------------------------------

test('one call that reads a table and writes it keeps both, each at its own grade', () => {
  const { edgesOf, sid } = run(['    return this.prisma.user.update({ where: { id }, data: { posts: flag }, include: { posts: true } });']);
  const edges = edgesOf(sid());
  assert.ok(edges.includes('EXECUTES EXACT Post [read] via User.posts'), 'include reads Post for certain');
  assert.ok(edges.includes('EXECUTES SOUND_SET Post [write] via User.posts'), 'the nested write held in a variable may write it: who writes Post must still find this call');
});

// ---------------------------------------------------------------------------
// result extensions
// ---------------------------------------------------------------------------

test('result_extension_select_reads_needs', () => {
  const { edgesOf, sid, g } = run([
    '    const x = this.prisma.$extends({ result: { user: { label: { needs: { email: true, id: false }, compute(u) { return u.email; } } } } });',
    '    await x.user.findMany({ select: { label: true } });',
    '    await x.post.findMany({ select: { title: true, author: { select: { label: true } } } });',
  ]);
  assert.deepEqual(edgesOf(sid(0)), ['EXECUTES EXACT User [read]', 'READS EXACT User.email'], 'a computed field reads what it needs, and is no column of its own');
  assert.equal(g.nodes.get(sid(0)).unresolved, undefined);
  assert.ok(!g.nodes.has('column:User.label'));
  assert.ok(edgesOf(sid(1)).includes('READS EXACT User.email via Post.author'), 'a relation\'s select computes it too');
});

test('a computed field that needs another computed field reads what that one needs; needs the source does not spell out are said', () => {
  const { edgesOf, sid, g } = run([
    '    const x = this.prisma.$extends({ result: { $allModels: { tag: { needs: { id: true }, compute: () => 1 } }, user: { label: { needs: { email: true }, compute: () => 1 }, badge: { needs: { label: true }, compute: () => 1 }, loose: { needs: ext, compute: () => 1 } } } });',
    '    await x.user.findMany({ select: { badge: true, tag: true } });',
    '    await x.user.findMany({ select: { loose: true } });',
  ]);
  assert.deepEqual(edgesOf(sid(0)), ['EXECUTES EXACT User [read]', 'READS EXACT User.email', 'READS EXACT User.id']);
  assert.match(g.nodes.get(sid(1)).columnsRuntimeOnlyReason, /select\.loose/);
});

test('result_extension_nested_spread_cannot_claim_overridden_needs_exact', () => {
  const { edgesOf, sid, g } = run([
    '    const x = this.prisma.$extends({ result: { user: { label: { needs: { email: true }, compute(u) { return u.email; } }, ...ext } } });',
    '    await x.user.findMany({ select: { label: true } });',
  ]);
  assert.ok(!edgesOf(sid(0)).includes('READS EXACT User.email'), 'the spread may replace label with one that needs only id (measured: Prisma then selects User.id alone)');
  assert.match(g.nodes.get(sid(0)).columnsRuntimeOnlyReason, /select\.label/);
});

test('a field a spread in the result component may compute, a real one included, is said: what it needs is not known', () => {
  const { edgesOf, sid, g } = run([
    '    const x = this.prisma.$extends({ result: { ...base, user: { label: { needs: { email: true }, compute: () => 1 } } } });',
    '    await x.user.findMany({ select: { label: true } });',
    '    const y = this.prisma.$extends({ result: { user: { ...ext } } });',
    '    await y.user.findMany({ select: { id: true } });',
  ]);
  assert.ok(!edgesOf(sid(0)).includes('READS EXACT User.email'), 'a spread beside the model key may replace it');
  assert.match(g.nodes.get(sid(0)).columnsRuntimeOnlyReason, /select\.label/);
  assert.ok(edgesOf(sid(1)).includes('READS EXACT User.id'), 'a real field is selected all the same');
  assert.match(g.nodes.get(sid(1)).columnsRuntimeOnlyReason, /select\.id/, 'the spread may compute id from other fields, which Prisma then selects too');
});

test('a computed field named like a real one reads the real one and what it needs, as Prisma selects both', () => {
  const { edgesOf, sid } = run([
    '    const x = this.prisma.$extends({ result: { user: { id: { needs: { email: true }, compute: (u) => u.email.length } } } });',
    '    await x.user.findMany({ select: { id: true } });',
  ]);
  assert.deepEqual(edgesOf(sid(0)), ['EXECUTES EXACT User [read]', 'READS EXACT User.email', 'READS EXACT User.id'], 'measured: SELECT User.id, User.email');
});
