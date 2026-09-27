// prisma_catalog.test.mjs — schema.prisma as a catalog: tables, columns, keys and joins, alone and read against a SQL catalog.
//
// src/adapters/ts/prisma_catalog.mjs puts every model of a schema.prisma in the
// graph as a table, in the shape the SQL lane gives a DDL's, and reads it
// against the SQL catalog when the run read one too. These tests build small
// schemas and, for the second half, a DDL catalog through the SQL bridge
// itself, so the nodes schema.prisma meets are the ones a real run has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { readPrismaSchema } from '../src/adapters/ts/prisma_schema.mjs';
import { addPrismaCatalog } from '../src/adapters/ts/prisma_catalog.mjs';
import { relationsOf } from '../src/adapters/ts/prisma_relations.mjs';

const SCHEMA = [
  'model User {',
  '  id        Int      @id',
  '  email     String   @unique',
  '  nickname  String?  @map("nick_name") @db.VarChar(40)',
  '  scopes    String[]',
  '  posts     Post[]',
  '  referrer  User?    @relation("refs", fields: [referrerId], references: [id])',
  '  referred  User[]   @relation("refs")',
  '  referrerId Int?',
  '  tags      Tag[]',
  '}',
  '',
  'model Post {',
  '  id       Int    @id',
  '  title    String',
  '  authorId Int',
  '  author   User   @relation(fields: [authorId], references: [id])',
  '  @@map("posts")',
  '}',
  '',
  'model Tag {',
  '  id    Int    @id',
  '  users User[]',
  '}',
  '',
  'model Membership {',
  '  userId Int',
  '  teamId Int',
  '  @@id([userId, teamId])',
  '}',
].join('\n');

const schemaOf = (text = SCHEMA) => readPrismaSchema(text);
const joinsOf = (g) => g.edges.filter((e) => e.type === 'JOINS').map((e) => ({ from: e.from, to: e.to, ...e.evidence }));

test('every model is a table and every scalar field a column, with its type, nullability and primary key, declared by schema.prisma', () => {
  const g = new Graph();
  const { stats } = addPrismaCatalog(g, schemaOf());
  const table = g.nodes.get('table:User');
  assert.deepEqual({ ...table }, { id: 'table:User', kind: 'table', comment: null, declaredBy: 'prisma', prismaModel: 'User' });
  assert.ok(g.nodes.has('table:Membership'), 'a model no call names is a table all the same');
  const nick = g.nodes.get('column:User.nick_name');
  assert.deepEqual([nick.name, nick.type, nick.nativeType, nick.nullable, nick.pk, nick.prismaField], ['nick_name', 'String', 'VarChar(40)', true, false, 'nickname']);
  assert.deepEqual([g.nodes.get('column:User.id').pk, g.nodes.get('column:User.id').nullable], [true, false]);
  assert.equal(g.nodes.get('column:User.scopes').type, 'String[]');
  assert.equal(g.nodes.get('column:User.scopes').nullable, null, 'whether a list column allows NULL is not in the schema');
  assert.deepEqual([g.nodes.get('column:Membership.userId').pk, g.nodes.get('column:Membership.teamId').pk], [true, true], '@@id puts both fields in the key');
  assert.ok(!g.nodes.has('column:User.posts'), 'a relation field is not a column');
  const declares = g.edges.filter((e) => e.type === 'DECLARES' && e.from === 'table:posts').map((e) => e.to).sort();
  assert.deepEqual(declares, ['column:posts.authorId', 'column:posts.id', 'column:posts.title']);
  assert.equal(stats.source, 'schema');
});

test('a relation is a JOINS edge on the columns its fields and references name, one per pair of tables, and a relation of a model with itself is none', () => {
  const g = new Graph();
  addPrismaCatalog(g, schemaOf());
  const joins = joinsOf(g);
  const toPosts = joins.find((j) => j.to === 'table:posts' || j.from === 'table:posts');
  assert.deepEqual(toPosts, { from: 'table:User', to: 'table:posts', via: 'prisma-relation', columns: ['id=authorId'], relations: ['Post.author'] });
  assert.equal(g.edges.find((e) => e.type === 'JOINS' && e.to === 'table:posts').grade, 'EXACT');
  assert.ok(!joins.some((j) => j.from === j.to), 'User.referrer joins User to itself, which is not an ERD relationship');
});

test('two lists with no fields are an implicit many-to-many: the table Prisma makes, _AToB with A and B, joined to both', () => {
  const g = new Graph();
  const { stats, relation } = addPrismaCatalog(g, schemaOf());
  const jt = g.nodes.get('table:_TagToUser');
  assert.equal(jt.prismaBlock, 'implicit');
  assert.deepEqual(['A', 'B'].map((c) => g.nodes.get(`column:_TagToUser.${c}`).type), ['Int', 'Int']);
  assert.deepEqual(['A', 'B'].map((c) => g.nodes.get(`column:_TagToUser.${c}`).pk), [null, null], 'a primary key or a unique index, by Prisma version: not said');
  const joins = joinsOf(g).filter((j) => j.from === 'table:_TagToUser' || j.to === 'table:_TagToUser');
  assert.deepEqual(joins.map((j) => `${j.from} ${j.to} ${j.columns}`).sort(), ['table:Tag table:_TagToUser id=A', 'table:User table:_TagToUser id=B']);
  assert.equal(stats.implicitTables, 1);
  const r = relation({ name: 'User' }, 'tags');
  assert.equal(r.joinTable, 'table:_TagToUser');
  assert.deepEqual(r.link.columns, ['column:_TagToUser.A', 'column:_TagToUser.B']);
  assert.deepEqual(r.joinReads, ['column:User.id', 'column:Tag.id', 'column:_TagToUser.A', 'column:_TagToUser.B']);
});

test('the side that holds a relation, and the side that does not, both know which columns join and which hold the link', () => {
  const g = new Graph();
  const { relation } = addPrismaCatalog(g, schemaOf());
  const held = relation({ name: 'Post' }, 'author');
  assert.deepEqual([held.targetTable, held.joinReads, held.link], ['table:User', ['column:posts.authorId', 'column:User.id'], { table: 'table:posts', columns: ['column:posts.authorId'] }]);
  const other = relation({ name: 'User' }, 'posts');
  assert.deepEqual([other.targetTable, other.joinReads, other.link], ['table:posts', ['column:User.id', 'column:posts.authorId'], { table: 'table:posts', columns: ['column:posts.authorId'] }]);
  const named = relation({ name: 'User' }, 'referred');
  assert.deepEqual(named.link, { table: 'table:User', columns: ['column:User.referrerId'] }, 'the relation name finds the side that holds it');
});

test('a relation this reading cannot place is said, with the reason: no other side, two candidates, or a model with itself in a many-to-many', () => {
  const rels = relationsOf(schemaOf([
    'model A { id Int @id\n  bs B[] }',
    'model B { id Int @id\n  aId Int\n  a1 A @relation(fields: [aId], references: [id])\n  a2 A @relation(fields: [aId], references: [id]) }',
    'model C { id Int @id\n  friends C[] @relation("f")\n  friendOf C[] @relation("f") }',
    'model D { id Int @id\n  e E? }',
    'model E { id Int @id }',
  ].join('\n').replace(/ \}/g, '\n}').replace(/\{ /g, '{\n  ')).models);
  assert.match(rels.get('A.bs').why, /2 fields of B could be the other side/);
  assert.match(rels.get('C.friends').why, /a many-to-many of a model with itself/);
  assert.match(rels.get('D.e').why, /names no field of E that is the other side/);
  assert.equal(rels.get('B.a1').kind, 'fk', 'the side that holds it is read from its own fields');
});

// ---------------------------------------------------------------------------
// with a SQL catalog
// ---------------------------------------------------------------------------

const DDL_RECORDS = [
  { kind: 'header' },
  { kind: 'table', schema: null, table: 'user', comment: null },
  { kind: 'column', schema: null, table: 'user', column: 'id', type: 'INT', nullable: false, pk: true, comment: null },
  { kind: 'column', schema: null, table: 'user', column: 'email', type: 'TEXT', nullable: true, pk: false, comment: null },
  { kind: 'column', schema: null, table: 'user', column: 'legacy', type: 'TEXT', nullable: true, pk: false, comment: null },
  { kind: 'column', schema: null, table: 'user', column: 'scopes', type: 'TEXT[]', nullable: true, pk: false, comment: null },
  { kind: 'table', schema: null, table: 'audit', comment: null },
  { kind: 'column', schema: null, table: 'audit', column: 'id', type: 'INT', nullable: false, pk: true, comment: null },
];

const MIGRATED = [
  'model User {',
  '  id     Int      @id',
  '  email  String',
  '  nick   String?',
  '  scopes String[]',
  '}',
  'model Note {',
  '  id Int @id',
  '}',
].join('\n');

test('with a SQL catalog, a table it declares is not declared twice: the schema corroborates its nodes, through the same fold the SQL lane keyed them with', () => {
  const g = buildGraphFromSql(DDL_RECORDS, [], { identifierCase: 'fold-lower' });
  const { stats } = addPrismaCatalog(g, schemaOf(MIGRATED), { identifierCase: 'fold-lower', catalogRecords: DDL_RECORDS });
  const tables = [...g.nodes.keys()].filter((id) => id.startsWith('table:')).sort();
  assert.deepEqual(tables, ['table:Note', 'table:audit', 'table:user'], 'User is the DDL\'s user, not a second table');
  const user = g.nodes.get('table:user');
  assert.equal(user.prismaModel, 'User');
  assert.equal(user.declaredBy, undefined, 'the node stays the SQL catalog\'s');
  const email = g.nodes.get('column:user.email');
  assert.deepEqual([email.type, email.prismaField, email.nullable], ['TEXT', 'email', undefined], 'the DDL\'s column keeps its own shape');
  assert.deepEqual([stats.source, stats.tablesCorroborated, stats.columnsCorroborated, stats.tables], ['schema-and-sql-catalog', 1, 3, 1]);
});

test('where the schema and the SQL catalog disagree it is said, each kind by name; a list\'s nullability is not compared', () => {
  const g = buildGraphFromSql(DDL_RECORDS, [], { identifierCase: 'fold-lower' });
  const { stats } = addPrismaCatalog(g, schemaOf(MIGRATED), { identifierCase: 'fold-lower', catalogRecords: DDL_RECORDS });
  assert.deepEqual(stats.disagreementsByKind, {
    'column-not-in-catalog': 1, 'column-not-in-schema': 1, 'nullable-differs': 1, 'table-not-in-catalog': 1, 'table-not-in-schema': 1,
  });
  const said = stats.disagreementSamples.map((d) => `${d.what} ${d.column ?? d.table}`).sort();
  assert.deepEqual(said, [
    'column-not-in-catalog user.nick', 'column-not-in-schema user.legacy', 'nullable-differs user.email', 'table-not-in-catalog Note', 'table-not-in-schema audit',
  ]);
  const nick = g.nodes.get('column:user.nick');
  assert.deepEqual([nick.declaredBy, nick.nullable], ['prisma', true], 'a column only the schema declares is added as the schema\'s, since the client sends it');
  assert.ok(g.edges.some((e) => e.type === 'DECLARES' && e.from === 'table:user' && e.to === 'column:user.nick'));
});

test('a primary key the two state differently is a disagreement too', () => {
  const g = buildGraphFromSql(DDL_RECORDS, [], { identifierCase: 'fold-lower' });
  const { stats } = addPrismaCatalog(g, schemaOf('model User {\n  id Int\n  email String? @id\n  legacy String?\n  scopes String[]\n}\nmodel Audit {\n  id Int @id\n}'), { identifierCase: 'fold-lower', catalogRecords: DDL_RECORDS });
  assert.deepEqual(stats.disagreementSamples.filter((d) => d.what === 'pk-differs').map((d) => [d.column, d.prisma, d.catalog]), [['user.id', false, true], ['user.email', true, false]]);
});
