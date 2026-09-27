// ts_project.test.mjs — the TypeScript project over several files: module resolution, re-exports, lineage.
//
// src/adapters/ts/project.mjs decides everything that crosses a file, over the
// whole project's records. Every test here builds those records with the real
// worker (factsOfFile) over small in-memory sources, using root-relative posix
// file names ('src/a.ts') the way the bridge names them, then asks readProject
// the same three questions the bridge asks: what a name means, what class it
// is, and what it extends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { readProject, methodOf, fieldOf } from '../src/adapters/ts/project.mjs';

/** The records of several small files, in file order, as the bridge would hand them to readProject. */
function recordsOf(filesMap) {
  const out = [];
  for (const [file, code] of Object.entries(filesMap)) out.push(...factsOfFile(file, code));
  return out;
}

// ---------------------------------------------------------------------------
// module resolution
// ---------------------------------------------------------------------------

test('a relative import resolves to the file with ".ts" appended and to "/index.ts", and a ".js" suffix in the specifier still resolves to the .ts file', () => {
  const project = readProject(recordsOf({
    'src/a.ts': `
      import { B } from './b';
      import { C } from './sub';
      import { D } from './d.js';
    `,
    'src/b.ts': `export class B {}`,
    'src/sub/index.ts': `export class C {}`,
    'src/d.ts': `export class D {}`,
  }), {});
  assert.deepEqual(project.meaning('src/a.ts', 'B'), { file: 'src/b.ts', name: 'B' });
  assert.deepEqual(project.meaning('src/a.ts', 'C'), { file: 'src/sub/index.ts', name: 'C' });
  assert.deepEqual(project.meaning('src/a.ts', 'D'), { file: 'src/d.ts', name: 'D' }, 'a .js specifier means the .ts file that TypeScript itself would resolve it to');
});

test('a tsconfig "paths" star pattern and an exact pattern both resolve, and "baseUrl" resolves what neither names', () => {
  const tsconfig = { baseUrl: 'lib', paths: { '@app/*': ['src/app/*'], '@exact': ['src/exact-target'] } };
  const project = readProject(recordsOf({
    'src/a.ts': `
      import { X } from '@app/foo';
      import { Y } from '@exact';
      import { Z } from 'baseonly';
    `,
    'src/app/foo.ts': `export class X {}`,
    'src/exact-target.ts': `export class Y {}`,
    'lib/baseonly.ts': `export class Z {}`,
  }), tsconfig);
  assert.deepEqual(project.meaning('src/a.ts', 'X'), { file: 'src/app/foo.ts', name: 'X' });
  assert.deepEqual(project.meaning('src/a.ts', 'Y'), { file: 'src/exact-target.ts', name: 'Y' });
  assert.deepEqual(project.meaning('src/a.ts', 'Z'), { file: 'lib/baseonly.ts', name: 'Z' });
});

test('a specifier neither a relative path, "paths" nor "baseUrl" finds in the project is external', () => {
  const project = readProject(recordsOf({ 'src/a.ts': `import { Thing } from 'left-pad';` }), {});
  assert.deepEqual(project.meaning('src/a.ts', 'Thing'), { external: 'left-pad', name: 'Thing' });
});

// ---------------------------------------------------------------------------
// re-exports
// ---------------------------------------------------------------------------

test('an "export * from" chain reaches through every hop to the file that declares the name', () => {
  const project = readProject(recordsOf({
    'src/a.ts': `export * from './b';`,
    'src/b.ts': `export * from './c';`,
    'src/c.ts': `export class Foo {}`,
    'src/main.ts': `import { Foo } from './a';`,
  }), {});
  assert.deepEqual(project.meaning('src/main.ts', 'Foo'), { file: 'src/c.ts', name: 'Foo' });
});

test('a named export renamed with "as" is followed under its new name', () => {
  const project = readProject(recordsOf({
    'src/a.ts': `
      class X {}
      export { X as Y };
    `,
    'src/main.ts': `import { Y } from './a';`,
  }), {});
  assert.deepEqual(project.meaning('src/main.ts', 'Y'), { file: 'src/a.ts', name: 'X' }, 'the alias resolves to the local declaration it renames');
});

test('a name re-exported from a package, not from a project file, is external', () => {
  const project = readProject(recordsOf({
    'src/a.ts': `export { Thing } from 'external-lib';`,
    'src/main.ts': `import { Thing } from './a';`,
  }), {});
  assert.deepEqual(project.meaning('src/main.ts', 'Thing'), { external: 'external-lib', name: 'Thing' });
});

// ---------------------------------------------------------------------------
// meaning, classOf
// ---------------------------------------------------------------------------

test('meaning of a local class or function is the file and name it is declared with, and classOf is null for an external name', () => {
  const project = readProject(recordsOf({
    'src/a.ts': `export class Foo {}\nexport function bar() {}`,
    'src/main.ts': `
      import { Foo } from './a';
      import { bar } from './a';
      import { NotAClass } from 'left-pad';
    `,
  }), {});
  assert.deepEqual(project.meaning('src/main.ts', 'Foo'), { file: 'src/a.ts', name: 'Foo' });
  assert.deepEqual(project.meaning('src/main.ts', 'bar'), { file: 'src/a.ts', name: 'bar' });
  const cls = project.classOf('src/main.ts', 'Foo');
  assert.equal(cls.name, 'Foo');
  assert.equal(cls.key, 'src/a.ts#Foo');
  assert.equal(project.classOf('src/main.ts', 'NotAClass'), null, 'an external name is never guessed into a project class');
});

// ---------------------------------------------------------------------------
// lineage
// ---------------------------------------------------------------------------

test('lineage follows "extends" across files, nearest first, and a cycle stops it instead of looping forever', () => {
  const straight = readProject(recordsOf({
    'src/base.ts': `export class Base {}`,
    'src/mid.ts': `import { Base } from './base'; export class Mid extends Base {}`,
    'src/top.ts': `import { Mid } from './mid'; export class Top extends Mid {}`,
  }), {});
  const top = straight.classOf('src/top.ts', 'Top');
  assert.deepEqual(straight.lineage(top).map((c) => c.name), ['Top', 'Mid', 'Base']);

  // Two classes that each extend the other: a real project would never
  // compile this, but the lookup itself must terminate rather than recurse forever.
  const cyclic = readProject(recordsOf({
    'src/x.ts': `import { Y } from './y'; export class X extends Y {}`,
    'src/y.ts': `import { X } from './x'; export class Y extends X {}`,
  }), {});
  const x = cyclic.classOf('src/y.ts', 'X');
  assert.deepEqual(cyclic.lineage(x).map((c) => c.name), ['X', 'Y'], 'the cycle is entered once and then stopped, not repeated');
});

// ---------------------------------------------------------------------------
// methodOf, fieldOf
// ---------------------------------------------------------------------------

test('methodOf and fieldOf find a member declared on a superclass, in another file, and return the class that declares it', () => {
  const project = readProject(recordsOf({
    'src/base.ts': `export class Base { foo() {} svc: Service; }`,
    'src/mid.ts': `import { Base } from './base'; export class Mid extends Base {}`,
  }), {});
  const mid = project.files.get('src/mid.ts').classes.get('Mid');
  const method = methodOf(project, mid, 'foo');
  assert.equal(method.cls.name, 'Base');
  assert.equal(method.cls.file, 'src/base.ts');
  assert.equal(method.method.name, 'foo');
  const field = fieldOf(project, mid, 'svc');
  assert.equal(field.cls.name, 'Base');
  assert.equal(field.field.name, 'svc');
  assert.equal(methodOf(project, mid, 'noSuchMethod'), null);
});
