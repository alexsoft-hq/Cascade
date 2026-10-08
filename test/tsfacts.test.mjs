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

test('a method says what each of its own returns hands back; a return in a nested function is not its own, and a body that may end without one says so', () => {
  const src = `
    class S {
      client() { const e = 1; return this.prisma.$extends(e); }
      maybe(c) { if (c) { return this.prisma; } }
      nested() { return [1].map((x) => { return x; }); }
      none() { this.x(); }
      thrown(c) { if (c) return name; throw new Error(); }
    }
  `;
  const byName = new Map(factsOfFile('src/s.ts', src).filter((r) => r.kind === 'method').map((r) => [r.name, r.returns]));
  assert.deepEqual(byName.get('client'), [{ k: 'call', callee: 'this.prisma.$extends', line: 3 }]);
  assert.deepEqual(byName.get('maybe'), [{ k: 'member', v: 'this.prisma' }, { k: 'none' }], 'the body may end without returning');
  assert.deepEqual(byName.get('nested'), [{ k: 'expr' }], 'the arrow\'s return is its own, not the method\'s');
  assert.equal(byName.get('none'), undefined, 'a method that returns nothing carries no returns');
  assert.deepEqual(byName.get('thrown'), [{ k: 'id', v: 'name' }], 'a body that ends by throwing does not end without a return');
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

test('a call says where the file declares the local its receiver starts at, and the local it is held in; a name declared again in a block is another local', () => {
  const lines = [
    'export class C {',
    '  m(p) {',
    '    const x = make();',
    '    {',
    '      const x = { a: 1 };',
    '      x.a.run();',
    '    }',
    '    x.b.run(x, p);',
    '    let y = make();',
    '    y = other();',
    '    y.c.run();',
    '    list.map((p) => p.d.run());',
    '    glob.e.run();',
    '  }',
    '}',
  ];
  const at = (line, text, skip = 0) => `${line}:${lines[line - 1].indexOf(text) + skip}`;
  const calls = factsOfFile('src/b.ts', lines.join('\n')).filter((r) => r.kind === 'call');
  const on = (line, callee) => calls.find((c) => c.line === line && c.callee === callee);
  assert.equal(on(3, 'make').holderAt, at(3, 'x'));
  assert.equal(on(6, 'x.a.run').rootAt, at(5, 'x'), 'the inner x, not the outer one');
  assert.equal(on(8, 'x.b.run').rootAt, at(3, 'x'));
  assert.deepEqual(on(8, 'x.b.run').args, [{ k: 'id', v: 'x', at: at(3, 'x') }, { k: 'id', v: 'p', at: at(2, 'p') }], 'an argument that names a local says which');
  assert.deepEqual([on(9, 'make').holderAt, on(9, 'make').holderReassigned], [at(9, 'y'), true], 'y is written again on line 10');
  assert.deepEqual([on(11, 'y.c.run').rootAt, on(11, 'y.c.run').rootReassigned], [at(9, 'y'), true]);
  assert.deepEqual(on(12, 'list.map').args[0].paramsAt, [at(12, '(p)', 1)]);
  assert.equal(on(12, 'p.d.run').rootAt, at(12, '(p)', 1), 'the arrow\'s own p, not the method\'s');
  assert.equal(on(12, 'list.map').rootAt, undefined, 'a name this file does not declare has no place');
  assert.equal(on(13, 'glob.e.run').rootAt, undefined);
});

test('what counts as writing a local again: an assignment, a destructuring assignment, ++, a for-of target and a second var', () => {
  const src = [
    'function f() {',
    '  let a = make(); a += 1;',
    '  let b = make(); [b] = [2];',
    '  let c = make(); c++;',
    '  let d = make(); for (d of []) {}',
    '  var e = make(); var e = 2;',
    '  const g = make(); g.h = 1;',
    '}',
  ].join('\n');
  const held = Object.fromEntries(factsOfFile('src/w.ts', src).filter((r) => r.kind === 'call' && r.holder).map((c) => [c.holder, c.holderReassigned === true]));
  assert.deepEqual(held, { a: true, b: true, c: true, d: true, e: true, g: false }, 'writing a member of g is not writing g');
});

test('a name declared at module level or imported has no place in a call record: only a local does', () => {
  const src = "import { db } from './db';\nconst top = make();\nexport function f() { db.user.run(); top.x.run(); }\n";
  const calls = factsOfFile('src/m.ts', src).filter((r) => r.kind === 'call');
  assert.equal(calls.find((c) => c.callee === 'make').holderAt, undefined);
  assert.deepEqual(calls.filter((c) => c.callee !== 'make').map((c) => c.rootAt), [undefined, undefined]);
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
  // What a spread puts in the list is kept as it is written (`spreads`): a name, which no reader can list.
  assert.deepEqual(valueOfSource('[1, ...x]'), { k: 'arr', v: [{ k: 'num', v: 1 }], spread: true, spreads: [{ k: 'id', v: 'x' }] });
  // A list written out, or one of two a condition picks, is each kept whole.
  assert.deepEqual(valueOfSource('[...(on ? [A] : [])]'), { k: 'arr', v: [], spread: true, spreads: [{ k: 'arr', v: [{ k: 'id', v: 'A' }] }, { k: 'arr', v: [] }] });
  assert.deepEqual(valueOfSource('({a: 1, ...x, [y]: 2})'), { k: 'obj', v: { a: { k: 'num', v: 1 } }, spread: true, computed: true });
});

test('valueOfSource reads a call by its callee and arguments, and an arrow function by what it returns when its body is an expression', () => {
  assert.deepEqual(valueOfSource('foo(1, "a")'), { k: 'call', callee: 'foo', args: [{ k: 'num', v: 1 }, { k: 'str', v: 'a' }] });
  assert.deepEqual(valueOfSource('() => 5'), { k: 'fn', params: [], line: 1, endLine: 1, returns: { k: 'num', v: 5 } });
  assert.deepEqual(valueOfSource('() => { return 5; }'), { k: 'fn', params: [], line: 1, endLine: 1 }, 'a block body is not read for what it returns');
  // A callback's parameters are named, so a call written inside it can be read
  // against them (the client a Prisma $transaction hands its callback).
  assert.deepEqual(valueOfSource('async (tx, { a }) => {\n  await tx.user.findMany();\n}'), { k: 'fn', params: ['tx', null], line: 1, endLine: 3 });
});

test('a call that may not run when its member does is marked: a branch, a loop, a catch block, a nested callback', () => {
  const src = [
    'async function boot(app) {',
    '  app.a();',
    '  if (x) app.b(); else app.c();',
    '  x && app.d();',
    '  for (const y of ys) app.e();',
    '  try { app.f(); } catch { app.g(); }',
    '  ys.forEach(() => app.h());',
    '}',
    'export const run = () => app.i();',
  ].join('\n');
  const calls = factsOfFile('src/boot.ts', src).filter((r) => r.kind === 'call');
  const cond = Object.fromEntries(calls.map((c) => [c.callee, c.cond === true]));
  assert.deepEqual(cond, {
    'app.a': false, 'app.b': true, 'app.c': true, 'app.d': true, 'app.e': true,
    'app.f': false, 'app.g': true, 'ys.forEach': false, 'app.h': true, 'app.i': false,
  });
  const fn = factsOfFile('src/boot.ts', src).find((r) => r.kind === 'function' && r.name === 'boot');
  assert.deepEqual(fn.params, ['app'], 'a module function names its parameters, so a helper the bootstrap hands the application to can be followed');
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

test('sourceFiles skips node_modules, dist, build, coverage, .git, .nx, .angular and tmp, dot-directories and .d.ts files, and lists tests: which are a test\'s is the typescript pack\'s', (t) => {
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
  // Test files are listed like any other: the run asks ts.test-support, and says what it leaves out.
  assert.deepEqual(files, ['__tests__/skip.ts', 'a.ts', 'b.spec.ts', 'c.test.ts', 'd.e2e-spec.ts', 'e2e/skip.ts', 'sub/keep.ts', 'test/skip.ts', 'tests/skip.ts']);
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

test('every file read says so first, even one of constants alone, so the bridge never takes it for a package', () => {
  const records = factsOfFile('src/consts.ts', "export const DATE_FORMAT = 'yyyy-MM-dd';");
  assert.deepEqual(records[0], { kind: 'file', file: 'src/consts.ts' });
  assert.equal(records[1].kind, 'static-context');
  assert.equal(records[1].staticFacts.complete, true);
  assert.deepEqual(records.slice(2), [{ kind: 'const', file: 'src/consts.ts', name: 'DATE_FORMAT', value: { k: 'str', v: 'yyyy-MM-dd' }, line: 1 }], 'and the literal the const holds, which a reading of options resolves');
});

test('an interface is recorded with the interfaces it extends, and an abstract method, which has no body, is no method', () => {
  const records = factsOfFile('src/repo.ts', [
    'export interface Store extends Base, ns.Other { get(k: string): string; }',
    'interface Local {}',
    'export abstract class Repo implements Store {',
    '  abstract find(id: string): unknown;',
    '  get(k: string) { return k; }',
    '}',
  ].join('\n'));
  const itfs = records.filter((r) => r.kind === 'interface');
  assert.deepEqual(itfs.map((r) => [r.name, r.exported, r.extends]), [['Store', true, ['Base', 'ns.Other']], ['Local', false, []]]);
  assert.deepEqual(records.filter((r) => r.kind === 'method').map((r) => r.name), ['get']);
});

test('a property holding a function, the class a mixin function returns, a class extending a call, and a constant naming one value or another', () => {
  const records = factsOfFile('src/m.ts', [
    'export function Loud(B) { return class extends B { step() { return this.x(); } }; }',
    'export class Mixed extends Loud(Base) { run = () => this.step(); size = 3; }',
    'const chosen = isDocument() ? DocumentModule : RelationalModule;',
    'const made = build();',
  ].join('\n'));
  const mixin = records.find((r) => r.kind === 'class' && r.name === 'Loud()');
  assert.deepEqual([mixin.mixinOf, mixin.mixinParam, mixin.extends], ['Loud', 0, null], 'it extends what the function is handed, not a name of the file');
  assert.equal(records.find((r) => r.kind === 'method' && r.class === 'Loud()').name, 'step');
  assert.equal(records.find((r) => r.kind === 'call' && r.callee === 'this.x').in, 'Loud().step', 'a call in the mixin\'s class is its method\'s');
  const mixed = records.find((r) => r.kind === 'class' && r.name === 'Mixed');
  assert.deepEqual(mixed.extendsCall, { callee: 'Loud', args: [{ k: 'id', v: 'Base' }] });
  const props = records.filter((r) => r.kind === 'property');
  assert.deepEqual(props.map((r) => [r.name, r.fn ?? false]), [['run', true], ['size', false]]);
  const aliases = records.filter((r) => r.kind === 'alias');
  assert.deepEqual(aliases.map((r) => [r.name, r.values.map((v) => v.v)]), [['chosen', ['DocumentModule', 'RelationalModule']]], 'a call is no alias');
});

