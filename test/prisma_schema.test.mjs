// prisma_schema.test.mjs — the tables and columns a schema.prisma declares, read from its text alone.
//
// src/adapters/ts/prisma_schema.mjs reads schema.prisma as text, line by line,
// with no Prisma tooling involved. These tests build one small schema (a User
// model with every kind of field the reader distinguishes, plus its related
// models) and check what readPrismaSchema makes of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPrismaSchema, modelOfDelegate } from '../src/adapters/ts/prisma_schema.mjs';

const SCHEMA = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

// a comment before the model, and a lone comment line, must not confuse the reader
model User {
  id        Int      @id @map("user_id") /// a doc comment after the field
  email     String   @unique
  tags      String[]
  bio       String?
  role      Role     @map("role_id")
  posts     Post[]
  profile   Profile? @relation(fields: [profileId], references: [id])
  profileId Int?
  @@map("users")
}

model Post {
  id    Int    @id
  title String
}

model Profile {
  id Int @id
}

enum Role {
  ADMIN
  USER
}
`;

test('readPrismaSchema reads the provider from the datasource block', () => {
  assert.equal(readPrismaSchema(SCHEMA).provider, 'postgresql');
});

test('a scalar field carries its type, and a list ([]) or optional (?) marker as flags', () => {
  const user = readPrismaSchema(SCHEMA).models.get('User');
  const field = (name) => user.fields.find((f) => f.name === name);
  assert.deepEqual([field('email').type, field('email').list, field('email').optional], ['String', false, false]);
  assert.deepEqual([field('tags').type, field('tags').list, field('tags').optional], ['String', true, false]);
  assert.deepEqual([field('bio').type, field('bio').list, field('bio').optional], ['String', false, true]);
});

test('@id marks a field, @map gives its column name, and a field with no @map uses its own name as the column', () => {
  const user = readPrismaSchema(SCHEMA).models.get('User');
  const id = user.fields.find((f) => f.name === 'id');
  assert.equal(id.id, true);
  assert.equal(id.column, 'user_id', '@map("user_id") names the column');
  const email = user.fields.find((f) => f.name === 'email');
  assert.equal(email.id, false);
  assert.equal(email.column, 'email', 'no @map, so the field\'s own name is the column');
});

test('@@map gives the model\'s table name, and a model with none uses its own name', () => {
  const { models } = readPrismaSchema(SCHEMA);
  assert.equal(models.get('User').table, 'users');
  assert.equal(models.get('Post').table, 'Post', 'Post declares no @@map');
});

test('a field typed with another model, or carrying @relation, is a relation and has no column of its own; relationFields lists what @relation names', () => {
  const user = readPrismaSchema(SCHEMA).models.get('User');
  const posts = user.fields.find((f) => f.name === 'posts');
  assert.equal(posts.relation, true, 'posts is typed Post, another model');
  assert.equal(posts.column, null);
  assert.deepEqual(posts.relationFields, [], 'no @relation(fields: ...) is written on this side');
  const profile = user.fields.find((f) => f.name === 'profile');
  assert.equal(profile.relation, true);
  assert.equal(profile.column, null);
  assert.deepEqual(profile.relationFields, ['profileId'], '@relation(fields: [profileId], ...) names the column that holds it');
  const profileId = user.fields.find((f) => f.name === 'profileId');
  assert.equal(profileId.relation, false, 'profileId itself is a plain Int column, not the relation');
  assert.equal(profileId.column, 'profileId');
});

test('a field typed with an enum is a column like any scalar, not a relation', () => {
  const role = readPrismaSchema(SCHEMA).models.get('User').fields.find((f) => f.name === 'role');
  assert.equal(role.relation, false);
  assert.equal(role.column, 'role_id');
});

test('comments (// and ///) and other blocks (enum) do not disturb reading the model that follows them', () => {
  const { models } = readPrismaSchema(SCHEMA);
  assert.equal(models.has('Role'), false, 'an enum is not a model');
  assert.ok(models.has('User'), 'the leading comment before "model User {" did not swallow the block');
  const id = models.get('User').fields.find((f) => f.name === 'id');
  assert.equal(id.column, 'user_id', 'the ///-doc comment after the field did not corrupt its @map reading');
});

test('modelOfDelegate maps a lowerCamel client delegate to its model, and gives null for one that does not exist', () => {
  const { models } = readPrismaSchema(SCHEMA);
  assert.equal(modelOfDelegate(models, 'user').name, 'User');
  assert.equal(modelOfDelegate(models, 'profile').name, 'Profile');
  assert.equal(modelOfDelegate(models, 'noSuchDelegate'), null);
  assert.equal(modelOfDelegate(models, ''), null);
  assert.equal(modelOfDelegate(models, null), null);
});

// ---------------------------------------------------------------------------
// compounds and @@schema
// ---------------------------------------------------------------------------

const COMPOUND_SCHEMA = `
model Account {
  id        Int    @id @default(autoincrement())
  a         Int
  b         Int
  c         Int
  @@unique([a, b], name: "id_email")
  @@index([c])
}

model Widget {
  x Int
  y Int
  @@id([x, y])
}

model Order {
  region String
  code   String
  ref    String
  @@unique(fields: [region, code], name: "region_code_key", map: "orders_region_code_udx")
}

model Tenanted {
  id Int @id
  @@schema("tenant_a")
}
`;

test('@@unique([a, b], name: "id_email") gives the model a compound: the client key "id_email" means fields a and b', () => {
  const account = readPrismaSchema(COMPOUND_SCHEMA).models.get('Account');
  assert.deepEqual(account.compounds, { id_email: ['a', 'b'] });
});

test('@@id([x, y]) with no name gives the default client key, the field names joined with _', () => {
  const widget = readPrismaSchema(COMPOUND_SCHEMA).models.get('Widget');
  assert.deepEqual(widget.compounds, { x_y: ['x', 'y'] });
});

test('@@unique(fields: [...], name: "x", map: "db_name") is read the same way; map is the database constraint name and never changes the client key', () => {
  const order = readPrismaSchema(COMPOUND_SCHEMA).models.get('Order');
  assert.deepEqual(order.compounds, { region_code_key: ['region', 'code'] });
});

test('@@index([...]) names no compound: it is not a unique or id key the client can filter by as one', () => {
  const account = readPrismaSchema(COMPOUND_SCHEMA).models.get('Account');
  assert.deepEqual(Object.keys(account.compounds), ['id_email'], '@@index gave no second compound entry');
});

test('a model with no compound attribute has an empty compounds object, not undefined', () => {
  const post = readPrismaSchema(SCHEMA).models.get('Post');
  assert.deepEqual(post.compounds, {});
});

test('a relation carries its name, its fields and its references, written in any order; the other side carries only its name', () => {
  const { models } = readPrismaSchema([
    'model Access {',
    '  id      String @id',
    '  userId  String',
    '  user    User   @relation("give", fields: [userId], onDelete: Cascade, references: [id])',
    '  other   User   @relation(references: [id], fields: [userId], name: "take")',
    '}',
    'model User {',
    '  id    String   @id',
    '  gives Access[] @relation("give")',
    '  plain Access[]',
    '}',
  ].join('\n'));
  const field = (m, f) => models.get(m).fields.find((x) => x.name === f);
  assert.deepEqual([field('Access', 'user').relationName, field('Access', 'user').relationFields, field('Access', 'user').references], ['give', ['userId'], ['id']]);
  assert.deepEqual([field('Access', 'other').relationName, field('Access', 'other').relationFields, field('Access', 'other').references], ['take', ['userId'], ['id']]);
  assert.deepEqual([field('User', 'gives').relationName, field('User', 'gives').relationFields], ['give', []]);
  assert.equal(field('User', 'plain').relationName, null);
});

test('the primary key is the @id field, or the fields @@id joins; a @db. attribute gives the native type, and Unsupported keeps its database type', () => {
  const { models } = readPrismaSchema([
    'model A {',
    '  id   Int    @id @default(autoincrement())',
    '  name String @db.VarChar(255)',
    '  geo  Unsupported("circle")?',
    '}',
    'model B {',
    '  x Int',
    '  y Int',
    '  @@id([x, y])',
    '}',
    'model C {',
    '  k String @unique',
    '}',
  ].join('\n'));
  assert.deepEqual(models.get('A').primaryKey, ['id']);
  assert.deepEqual(models.get('B').primaryKey, ['x', 'y']);
  assert.deepEqual(models.get('C').primaryKey, [], 'a unique key is not the primary key');
  const name = models.get('A').fields.find((f) => f.name === 'name');
  assert.equal(name.nativeType, 'VarChar(255)');
  const geo = models.get('A').fields.find((f) => f.name === 'geo');
  assert.deepEqual([geo.type, geo.optional, geo.column], ['Unsupported("circle")', true, 'geo']);
});

test('@@schema("x") gives the model its schema; a model with none has schema null', () => {
  const tenanted = readPrismaSchema(COMPOUND_SCHEMA).models.get('Tenanted');
  assert.equal(tenanted.schema, 'tenant_a');
  const account = readPrismaSchema(COMPOUND_SCHEMA).models.get('Account');
  assert.equal(account.schema, null);
});
