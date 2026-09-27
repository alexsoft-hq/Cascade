// tsfacts.test.mjs — the TypeScript worker: what one file's records say, read from that file's own text alone.
//
// adapters/ts/tsfacts.mjs is a per-file worker: it never looks at another file,
// so every test here hands factsOfFile a small source string and checks the
// records it gives back. sourceFiles is the one part that touches the
// filesystem (which files a run would even read), so those tests use a real
// temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { factsOfFile, valueOfSource, sourceFiles } from '../adapters/ts/tsfacts.mjs';

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

test('a named import, an aliased named import, a default import and a namespace import each give their own shape of import record', () => {
  const src = `
    import Foo, { A, B as C } from './mod1';
    import * as NS from './mod2';
  `;
  const [mod1, mod2] = factsOfFile('src/z.ts', src).filter((r) => r.kind === 'import');
  assert.equal(mod1.source, './mod1');
  assert.equal(mod1.default, 'Foo');
  assert.deepEqual(mod1.names, [{ imported: 'A', local: 'A' }, { imported: 'B', local: 'C' }]);
  assert.equal(mod1.typeOnly, false);
  assert.equal(mod2.namespace, 'NS');
  assert.deepEqual(mod2.names, []);
});

test('an "import type" import is marked typeOnly, unlike an ordinary import', () => {
  const src = `import type { T } from './mod3';`;
  const rec = factsOfFile('src/t.ts', src).find((r) => r.kind === 'import');
  assert.equal(rec.typeOnly, true);
  assert.deepEqual(rec.names, [{ imported: 'T', local: 'T' }]);
});

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

test('a re-export with a source and an export-all each give their own export record, and an exported class is a class record with exported true', () => {
  const src = `
    export { X } from './mod4';
    export * from './mod5';
    export class Y {}
  `;
  const records = factsOfFile('src/e.ts', src);
  const reExport = records.find((r) => r.kind === 'export' && r.source === './mod4');
  assert.deepEqual(reExport, { kind: 'export', file: 'src/e.ts', name: 'X', local: 'X', source: './mod4', line: reExport.line });
  const all = records.find((r) => r.kind === 'export' && r.all === true);
  assert.deepEqual(all, { kind: 'export', file: 'src/e.ts', all: true, source: './mod5', line: all.line });
  const cls = records.find((r) => r.kind === 'class');
  assert.equal(cls.name, 'Y');
  assert.equal(cls.exported, true);
});

test('re-exporting a name declared locally in the same file, with no module source, gives an export record with no source', () => {
  const src = `
    class X {}
    export { X };
  `;
  const rec = factsOfFile('src/local.ts', src).find((r) => r.kind === 'export');
  assert.deepEqual(rec, { kind: 'export', file: 'src/local.ts', name: 'X', local: 'X', line: rec.line });
  assert.equal('source' in rec, false, 'a local re-export names no module');
});

// ---------------------------------------------------------------------------
// class
// ---------------------------------------------------------------------------

test('a class record carries its name, exported flag, decorators with their call arguments as value summaries, and its extends/implements names', () => {
  const src = `
    @Controller('users')
    export class UsersController extends Base implements IFoo, IBar {
    }
  `;
  const cls = factsOfFile('src/users.controller.ts', src).find((r) => r.kind === 'class');
  assert.equal(cls.name, 'UsersController');
  assert.equal(cls.exported, true);
  assert.deepEqual(cls.decorators, [{ name: 'Controller', args: [{ k: 'str', v: 'users' }] }]);
  assert.equal(cls.extends, 'Base');
  assert.deepEqual(cls.implements, ['IFoo', 'IBar']);
  assert.equal(typeof cls.line, 'number');
  assert.equal(typeof cls.endLine, 'number');
  assert.ok(cls.endLine >= cls.line, 'endLine closes what line opens');
});

// ---------------------------------------------------------------------------
// ctorParam, property, method
// ---------------------------------------------------------------------------

test('a constructor parameter property gives its field name and type, and a class property with a type reference gives its type name', () => {
  const src = `
    class UsersService {
      constructor(private readonly repo: UsersRepository) {}
      name: string;
      repo: UsersRepository;
    }
  `;
  const records = factsOfFile('src/users.service.ts', src);
  const ctor = records.find((r) => r.kind === 'ctorParam');
  assert.equal(ctor.class, 'UsersService');
  assert.equal(ctor.name, 'repo');
  assert.equal(ctor.type, 'UsersRepository');
  assert.equal(ctor.index, 0);
  const props = records.filter((r) => r.kind === 'property');
  assert.equal(props.find((p) => p.name === 'name').type, null, 'a primitive type keyword is not a type reference, so typeNameOf gives null');
  assert.equal(props.find((p) => p.name === 'repo').type, 'UsersRepository');
});

test('a static method carries its decorators, each with its call arguments as value summaries', () => {
  const src = `
    class UsersController {
      @Get(':id')
      static find() {}
    }
  `;
  const method = factsOfFile('src/users.controller2.ts', src).find((r) => r.kind === 'method');
  assert.equal(method.name, 'find');
  assert.equal(method.static, true);
  assert.deepEqual(method.decorators, [{ name: 'Get', args: [{ k: 'str', v: ':id' }] }]);
});

// ---------------------------------------------------------------------------
// module-level function
// ---------------------------------------------------------------------------

test('a function declaration and a const arrow function are both function records, and each keeps its own exported flag', () => {
  const src = `
    export function bar() {}
    const f = () => {};
    export const g = () => {};
  `;
  const records = factsOfFile('src/fns.ts', src).filter((r) => r.kind === 'function');
  assert.deepEqual(records.map((r) => [r.name, r.exported]), [['bar', true], ['f', false], ['g', true]]);
});

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

test('a call\'s "in" names the method or the module function it is written in, and is null for a call at module level', () => {
  const src = `
    function top() { a(); }
    class C { method() { b(); } }
    c();
  `;
  const calls = factsOfFile('src/calls.ts', src).filter((r) => r.kind === 'call');
  assert.deepEqual(calls.map((r) => [r.in, r.callee]), [['top', 'a'], ['C.method', 'b'], [null, 'c']]);
});

test('the "n" ordinal counts a member\'s own calls in source order, and each member is counted on its own', () => {
  const src = `
    function top() { a(); b(); }
    class C { method() { x(); y(); z(); } }
  `;
  const calls = factsOfFile('src/n.ts', src).filter((r) => r.kind === 'call');
  assert.deepEqual(calls.map((r) => [r.in, r.callee, r.n]), [
    ['top', 'a', 0], ['top', 'b', 1],
    ['C.method', 'x', 0], ['C.method', 'y', 1], ['C.method', 'z', 2],
  ]);
});

test('an awaited call held in a const gives that name as the call\'s holder', () => {
  const src = `
    async function bootstrap() {
      const app = await NestFactory.create(AppModule);
    }
  `;
  const call = factsOfFile('src/main.ts', src).find((r) => r.kind === 'call');
  assert.equal(call.callee, 'NestFactory.create');
  assert.equal(call.holder, 'app');
  assert.deepEqual(call.args, [{ k: 'id', v: 'AppModule' }]);
});

test('a call written inside a decorator produces no call record: the decorator runs once when the class is defined, not when a member runs', () => {
  const src = `
    class UsersController {
      @Get(buildPath())
      @UseGuards(AuthGuard('jwt'))
      list() {}
    }
  `;
  const records = factsOfFile('src/deco.ts', src);
  assert.deepEqual(records.filter((r) => r.kind === 'call'), [], 'buildPath() and AuthGuard(\'jwt\') are written only inside decorators');
  const method = records.find((r) => r.kind === 'method');
  assert.deepEqual(method.decorators.map((d) => d.name), ['Get', 'UseGuards']);
  assert.deepEqual(method.decorators[0].args, [{ k: 'call', callee: 'buildPath', args: [] }]);
  assert.deepEqual(method.decorators[1].args, [{ k: 'call', callee: 'AuthGuard', args: [{ k: 'str', v: 'jwt' }] }]);
});

// ---------------------------------------------------------------------------
// valueOfSource
// ---------------------------------------------------------------------------

test('valueOfSource reads a string, a number, a boolean, null, an identifier and a member chain', () => {
  assert.deepEqual(valueOfSource(`'hi'`), { k: 'str', v: 'hi' });
  assert.deepEqual(valueOfSource('42'), { k: 'num', v: 42 });
  assert.deepEqual(valueOfSource('true'), { k: 'bool', v: true });
  assert.deepEqual(valueOfSource('null'), { k: 'null' });
  assert.deepEqual(valueOfSource('foo'), { k: 'id', v: 'foo' });
  assert.deepEqual(valueOfSource('a.b.c'), { k: 'member', v: 'a.b.c' });
  assert.deepEqual(valueOfSource('this.x.y'), { k: 'member', v: 'this.x.y' });
});

test('valueOfSource collapses a template literal with no interpolation to a plain string, and leaves one with a hole as just "tpl"', () => {
  assert.deepEqual(valueOfSource('`abc`'), { k: 'str', v: 'abc' });
  assert.deepEqual(valueOfSource('`a${b}c`'), { k: 'tpl' });
});

test('valueOfSource marks an array\'s spread and an object\'s spread and computed key, without guessing what they add', () => {
  assert.deepEqual(valueOfSource('[1, ...x]'), { k: 'arr', v: [{ k: 'num', v: 1 }], spread: true });
  assert.deepEqual(valueOfSource('({a: 1, ...x, [y]: 2})'), { k: 'obj', v: { a: { k: 'num', v: 1 } }, spread: true, computed: true });
});

test('valueOfSource reads a call by its callee and arguments, and an arrow function by what it returns when its body is an expression', () => {
  assert.deepEqual(valueOfSource('foo(1, "a")'), { k: 'call', callee: 'foo', args: [{ k: 'num', v: 1 }, { k: 'str', v: 'a' }] });
  assert.deepEqual(valueOfSource('() => 5'), { k: 'fn', returns: { k: 'num', v: 5 } });
  assert.deepEqual(valueOfSource('() => { return 5; }'), { k: 'fn' }, 'a block body is not read for what it returns');
});

// ---------------------------------------------------------------------------
// parse errors
// ---------------------------------------------------------------------------

test('a file that does not parse at all gives a parse_error record instead of throwing', () => {
  const records = factsOfFile('src/bad.ts', 'const x = "abc');
  assert.deepEqual(records.map((r) => r.kind), ['parse_error']);
  assert.match(records[0].message, /Unterminated string/);
});

test('a file that mostly parses gives its records plus a recovered parse_error for the part that did not', () => {
  // A stray `return` left at module level: the class before it is real code and
  // is still read, while the mistake after it is reported, not silently dropped.
  const records = factsOfFile('src/bad2.ts', 'class Foo {}\nreturn 5;');
  assert.ok(records.some((r) => r.kind === 'class' && r.name === 'Foo'), 'the part that parsed is still read');
  const err = records.find((r) => r.kind === 'parse_error');
  assert.ok(err, 'the stray return is reported');
  assert.equal(err.recovered, true);
});

// ---------------------------------------------------------------------------
// sourceFiles
// ---------------------------------------------------------------------------

test('sourceFiles skips node_modules, dist, build, coverage, .git, .nx, .angular and tmp, test directories and dot-directories, and skips .spec/.test/.e2e-spec and .d.ts files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-tsfacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, content = 'export const x = 1;') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('a.ts');
  write('sub/keep.ts');
  write('node_modules/skip.ts');
  write('dist/skip.ts');
  write('build/skip.ts');
  write('coverage/skip.ts');
  write('.git/skip.ts');
  write('.nx/skip.ts');
  write('.angular/skip.ts');
  write('tmp/skip.ts');
  write('.hidden/skip.ts');
  write('test/skip.ts');
  write('tests/skip.ts');
  write('__tests__/skip.ts');
  write('e2e/skip.ts');
  write('b.spec.ts');
  write('c.test.ts');
  write('d.e2e-spec.ts');
  write('e.d.ts');
  const files = sourceFiles([root]).map((f) => path.relative(root, f).split(path.sep).join('/'));
  assert.deepEqual(files, ['a.ts', 'sub/keep.ts']);
});

test('sourceFiles skips a directory it cannot read, instead of throwing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-tsfacts-unreadable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const x = 1;');
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'hidden.ts'), 'export const y = 1;');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) { t.skip('running as root: permission bits do not restrict access'); return; }
  fs.chmodSync(locked, 0o000);
  try {
    assert.doesNotThrow(() => sourceFiles([root]));
    const files = sourceFiles([root]).map((f) => path.relative(root, f).split(path.sep).join('/'));
    assert.deepEqual(files, ['a.ts'], 'the unreadable directory contributed nothing, and nothing else broke');
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});
