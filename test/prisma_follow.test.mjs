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

test('a local that holds a client in one place and something else in another is not read: its calls stay unread and are counted', () => {
  const { stats } = run([
    '    let x = this.prisma.$extends({});',
    '    if (flag) { const x = make(); x.user.findMany(); }',
    '    return x.user.findMany();',
  ]);
  assert.equal(stats.prisma.statements, 0);
  assert.equal(stats.prisma.unreadClientCalls, 2);
});
