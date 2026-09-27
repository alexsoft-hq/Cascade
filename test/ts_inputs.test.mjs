// ts_inputs.test.mjs — what the TypeScript bridge reads besides the source: tsconfig paths and the schema.prisma location.
//
// Both readTsconfigPaths and prismaSchemaFileOf walk a real directory tree
// (an extends chain, a nearer file winning over one further up), so these
// tests build real temp directories with fs.mkdtempSync rather than faking
// the filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLenientJson, readTsconfigPaths, prismaSchemaFileOf, tsBridgeOptions } from '../src/cli/ts_inputs.mjs';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); };

// ---------------------------------------------------------------------------
// readLenientJson
// ---------------------------------------------------------------------------

test('readLenientJson accepts // and /* */ comments and a trailing comma, and keeps a "//" written inside a string', () => {
  const text = `{
  // a leading comment
  "a": 1, /* a block
  comment */
  "b": "http://example.com", // a trailing comment
  "c": 2,
}`;
  assert.deepEqual(readLenientJson(text), { a: 1, b: 'http://example.com', c: 2 });
});

// ---------------------------------------------------------------------------
// readTsconfigPaths
// ---------------------------------------------------------------------------

test('readTsconfigPaths prefers tsconfig.app.json over tsconfig.build.json over tsconfig.json in the same directory', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-priority-');
  const appRoot = path.join(root, 'apps', 'api');
  writeJson(path.join(appRoot, 'tsconfig.json'), { compilerOptions: { baseUrl: '.', paths: { '@json/*': ['json/*'] } } });
  writeJson(path.join(appRoot, 'tsconfig.build.json'), { compilerOptions: { baseUrl: '.', paths: { '@build/*': ['build/*'] } } });
  writeJson(path.join(appRoot, 'tsconfig.app.json'), { compilerOptions: { baseUrl: '.', paths: { '@app/*': ['app/*'] } } });
  const result = readTsconfigPaths(root, appRoot);
  assert.equal(result.file, 'apps/api/tsconfig.app.json');
  assert.deepEqual(result.paths, { '@app/*': ['apps/api/app/*'] }, 'only the chosen file\'s own paths are read, not the other two configs in the same directory');
});

test('readTsconfigPaths walks up from the app root to the analyzed root when the app root itself has no tsconfig', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-walkup-');
  writeJson(path.join(root, 'tsconfig.json'), { compilerOptions: { baseUrl: '.', paths: { '@up/*': ['up/*'] } } });
  const appRoot = path.join(root, 'apps', 'foo');
  fs.mkdirSync(appRoot, { recursive: true });
  const result = readTsconfigPaths(root, appRoot);
  assert.equal(result.file, 'tsconfig.json');
  assert.deepEqual(result.paths, { '@up/*': ['up/*'] });
});

test('readTsconfigPaths follows "extends" (a relative specifier with no .json suffix), and the nearer file\'s own paths win over the base while a pattern only the base sets still merges in', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-extends-');
  writeJson(path.join(root, 'tsconfig.base.json'), {
    compilerOptions: { baseUrl: 'basebase', paths: { '@x/*': ['base/x/*'], '@y/*': ['base/y/*'] } },
  });
  writeJson(path.join(root, 'tsconfig.json'), {
    extends: './tsconfig.base',
    compilerOptions: { baseUrl: 'nearbase', paths: { '@x/*': ['near/x/*'] } },
  });
  const result = readTsconfigPaths(root, root);
  assert.equal(result.baseUrl, 'nearbase', 'the nearest file\'s own baseUrl wins');
  assert.deepEqual(result.paths, {
    '@x/*': ['nearbase/near/x/*'], // the nearer file's own target, relative to its own baseUrl
    '@y/*': ['basebase/base/y/*'], // only the base sets this one, so it still comes through, relative to the base's own baseUrl
  });
});

test('readTsconfigPaths follows "extends" written with an explicit .json suffix', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-extends-json-');
  writeJson(path.join(root, 'tsconfig.base.json'), { compilerOptions: { baseUrl: 'basebase' } });
  writeJson(path.join(root, 'tsconfig.json'), { extends: './tsconfig.base.json', compilerOptions: { paths: { '@z/*': ['z/*'] } } });
  const result = readTsconfigPaths(root, root);
  assert.equal(result.baseUrl, 'basebase', 'the nearer file sets no baseUrl of its own, so the base\'s baseUrl is used');
  assert.deepEqual(result.paths, { '@z/*': ['z/*'] }, 'the nearer file\'s own paths target is relative to its OWN directory, since that file sets no baseUrl of its own');
});

test('readTsconfigPaths gives file null and no paths when nothing is found up to the analyzed root', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-none-');
  const appRoot = path.join(root, 'apps', 'x');
  fs.mkdirSync(appRoot, { recursive: true });
  assert.deepEqual(readTsconfigPaths(root, appRoot), { file: null, baseUrl: null, paths: {} });
});

// ---------------------------------------------------------------------------
// prismaSchemaFileOf
// ---------------------------------------------------------------------------

test('prismaSchemaFileOf finds prisma/schema.prisma at the app root or above it, but never above the analyzed root', (t) => {
  const outer = tmpDir(t, 'cascade-ts-inputs-prisma-outer-');
  fs.mkdirSync(path.join(outer, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(outer, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }');
  const appRoot = path.join(outer, 'apps', 'api');
  fs.mkdirSync(appRoot, { recursive: true });
  assert.equal(prismaSchemaFileOf(outer, appRoot, null), path.join(outer, 'prisma', 'schema.prisma'), 'the schema above the app root, at the analyzed root, is found by walking up');

  // Placing the same file one level ABOVE the analyzed root must not be found:
  // the analyzed root is where the walk-up stops.
  const analyzedRoot = path.join(outer, 'innerroot');
  const innerApp = path.join(analyzedRoot, 'apps', 'api');
  fs.mkdirSync(innerApp, { recursive: true });
  assert.equal(prismaSchemaFileOf(analyzedRoot, innerApp, null), null, 'a schema.prisma outside the analyzed root is not this app\'s schema');
});

test('a declared schema path wins when it exists, and a declared path that does not exist gives null without falling back to the default lookup', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-prisma-declared-');
  fs.mkdirSync(path.join(root, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }');
  const appRoot = path.join(root, 'apps', 'api');
  fs.mkdirSync(appRoot, { recursive: true });
  const declared = path.join(root, 'apps', 'declared.prisma');
  fs.writeFileSync(declared, 'datasource db { provider = "mysql" }');
  assert.equal(prismaSchemaFileOf(root, appRoot, declared), declared, 'the declared path is used even though the default prisma/schema.prisma also exists');
  const missing = path.join(root, 'apps', 'does-not-exist.prisma');
  assert.equal(prismaSchemaFileOf(root, appRoot, missing), null, 'a declared path that does not exist gives null, not the default schema');
});

// ---------------------------------------------------------------------------
// tsBridgeOptions
// ---------------------------------------------------------------------------

test('tsBridgeOptions returns the tsconfig paths, the Prisma schema and its file, and the schema name and identifier case from sqlArgs', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-bridge-');
  writeJson(path.join(root, 'tsconfig.json'), { compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } });
  fs.mkdirSync(path.join(root, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), [
    'datasource db {',
    '  provider = "postgresql"',
    '}',
    'model User {',
    '  id Int @id',
    '}',
  ].join('\n'));
  const opts = tsBridgeOptions({
    rootAbs: root, appRootAbs: root, declaredSchema: null,
    sqlArgs: { defaultSchema: 'public', identifierCase: 'fold-lower' },
  });
  assert.deepEqual(opts.tsconfig, { baseUrl: '.', paths: { '@app/*': ['src/*'] } });
  assert.equal(opts.tsconfigFile, 'tsconfig.json');
  assert.equal(opts.prisma.schema.provider, 'postgresql');
  assert.ok(opts.prisma.schema.models.has('User'), 'the schema\'s models are read whole, not just its provider');
  assert.equal(opts.prismaSchemaFile, 'prisma/schema.prisma');
  assert.equal(opts.schemaName, 'public');
  assert.equal(opts.identifierCase, 'fold-lower');
});

test('tsBridgeOptions gives prisma null when the app has no schema.prisma anywhere up to the analyzed root', (t) => {
  const root = tmpDir(t, 'cascade-ts-inputs-bridge-noprisma-');
  const appRoot = path.join(root, 'apps', 'api');
  fs.mkdirSync(appRoot, { recursive: true });
  const opts = tsBridgeOptions({ rootAbs: root, appRootAbs: appRoot, declaredSchema: null, sqlArgs: {} });
  assert.equal(opts.prisma, null);
  assert.equal(opts.prismaSchemaFile, null);
  assert.equal(opts.schemaName, null, 'sqlArgs.defaultSchema was not given');
});
