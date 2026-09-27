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
