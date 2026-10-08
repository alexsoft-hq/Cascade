import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsOfFile, VERSION } from '../adapters/ts/tsfacts.mjs';
import { TS_WORKER_VERSION } from '../src/core/worker_versions.mjs';
import { readProject } from '../src/adapters/ts/project.mjs';
import { nestRoutes } from '../src/adapters/ts/nest_routes.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';
const rule = builtinRegistry().ofKind('ts.route-decorator')[0].compiled;
const filesOf = (opts = {}) => {
 const expression = opts.expression ?? "[`${QUEUE.substring(1)}{/*wildcard}`, 'sitemap.xml', ...LANGS.map((lang) => { return `/${lang}{/*wildcard}`; })]";
 return [
 ['config.ts', opts.config ?? "export const QUEUE = '/admin/queues'; export const LANGS = ['en', 'ko'] as const;"],
 ['main.ts', `${opts.imports ?? "import { QUEUE, LANGS } from './config';"}
 import { NestFactory } from '@nestjs/core'; import { AppModule } from './app.module';
 ${opts.before ?? ''}
 async function bootstrap(${opts.params ?? ''}) { const app = await NestFactory.create(AppModule);
 ${opts.inside ?? ''} app.setGlobalPrefix('api', { exclude: ${expression} }); await app.listen(3000); } bootstrap();`],
 ['app.module.ts', `import { Module, Controller, Get } from '@nestjs/common';
 @Controller('en') class Language { @Get() list(){} }
 @Controller('account') class Account { @Get() list(){} }
 @Module({ controllers:[Language, Account] }) export class AppModule {}`],
 ...(opts.extra ?? [])];
};
const run = (opts = {}) => nestRoutes(readProject(filesOf(opts).flatMap(([f,s]) => factsOfFile(f,s))),rule);
const unknown = (opts) => {const r=run(opts); assert.ok(r.diagnostics.some(d=>d.kind==='TS_PREFIX_EXCLUDE_UNREAD'));assert.ok(r.routes.every(route=>route.grade==='HEURISTIC'));};

test('imported immutable constants, template substring, ordered spread and pure block map settle exclusions',()=>{
 const r=run();assert.deepEqual(r.routes.map(route=>route.path).sort(),['/api/account','/en']);assert.ok(r.routes.every(route=>route.grade===undefined));assert.ok(!r.diagnostics.some(d=>d.kind==='TS_PREFIX_EXCLUDE_UNREAD'));
});
test('renamed reexports and pure expression map are source-backed',()=>{
 const r=run({imports:"import { QUEUE, LANGUAGES as LANGS } from './barrel';",extra:[['barrel.ts',"export { QUEUE, LANGS as LANGUAGES } from './config';"]]});assert.ok(r.routes.every(route=>route.grade===undefined));
});
for(const mutation of ["LANGS.push('de');","LANGS[0]='de';","LANGS.length=0;","namespace Mutator { LANGS.length=0; }","enum Mutator { N = LANGS.splice(0).length }","({n:LANGS.length}={n:0});","for (LANGS.length of [0]) {}","delete LANGS.length;","delete LANGS[0];","const alias=LANGS; alias.splice(0);","mutate(LANGS);","LANGS.map = custom;","LANGS[Symbol.iterator] = custom;"]) test(`array mutation or escape stays unread: ${mutation}`,()=>unknown({before:mutation}));
test('mutation through another imported alias stays unread',()=>unknown({extra:[['mutator.ts',"import {LANGS as L} from './config'; L.pop();"]]}));
test('namespace and computed access stays unread',()=>unknown({extra:[['mutator.ts',"import * as cfg from './config'; cfg['LANGS'].pop();"]]}));
test('local shadow does not resolve as module import',()=>unknown({params:'LANGS'}));
test('let binding is not a constant',()=>unknown({config:"export const QUEUE='/admin/queues'; export let LANGS=['en'];"}));
test('reassigned const is not interpreted',()=>unknown({config:"export const QUEUE='/admin/queues'; export const LANGS=['en']; LANGS=['ko'];"}));
for(const callback of ['async lang => `/${lang}`','lang => { sideEffect(); return `/${lang}`; }','(lang, i, arr) => { arr.pop(); return `/${lang}`; }','lang => `/${runtime()}`','({lang}) => `/${lang}`','lang => `/${lang = runtime()}`']) test(`unsupported callback stays unread: ${callback}`,()=>unknown({expression:`[...LANGS.map(${callback})]`}));
test('callback mutating source via closure stays unread',()=>unknown({expression:"[...LANGS.map(lang => { LANGS.pop(); return `/${lang}`; })]"}));
test('conditional spread is not an unconditional union',()=>unknown({expression:"[...(process.env.ON ? ['en'] : ['ko'])]"}));
test('array holes are not silently discarded',()=>unknown({expression:"[...['en',, 'ko'].map(lang => `/${lang}`)]"}));
test('nonexported and type-only imports cannot prove a value',()=>{
 unknown({config:"const QUEUE='/admin/queues'; const LANGS=['en'];"});
 unknown({imports:"import type { QUEUE, LANGS } from './config';"});
});
test('missing reference census does not prove an exported array immutable',()=>{
 const records=filesOf().flatMap(([f,s])=>factsOfFile(f,s));records.find(r=>r.kind==='static-context'&&r.file==='config.ts').staticFacts=undefined;
 const r=nestRoutes(readProject(records),rule);assert.ok(r.diagnostics.some(d=>d.kind==='TS_PREFIX_EXCLUDE_UNREAD'));
});
test('fact version invalidates stale shards and preserves new structure',()=>{
 assert.equal(VERSION,'tsfacts/10');assert.equal(TS_WORKER_VERSION,VERSION);
 const calls=factsOfFile('x.ts',"app.setGlobalPrefix('api',{exclude:[...A.map(x=>{return `/${x}`;})]})");
 assert.equal(calls.find(r=>r.kind==='call').staticArgs[1].props.exclude.items[0].k,'spread');
});

const enumeration = (predicate = "([key]) => { return key.startsWith('PROPERTY_'); }") => `import * as config from './config';
const values = Object.entries(config).filter(${predicate}).map(([,value])=>value);`;
test('namespace enumeration whose literal key filter excludes the array does not escape it',()=>{
 const r=run({extra:[['reader.ts',enumeration()]]});assert.ok(r.routes.every(route=>route.grade===undefined));
});
for (const predicate of ["([key])=>key.startsWith('LANG')", "([key])=>key.startsWith(runtime())", "([key,value])=>{mutate(value);return key.startsWith('PROPERTY_');}", "([key])=>{sideEffect();return key.startsWith('PROPERTY_');}", "([key])=>!key.startsWith('LANG')"]) test(`namespace enumeration remains unsafe with ${predicate}`,()=>unknown({extra:[['reader.ts',enumeration(predicate)]]}));
test('namespace filter rejects shadowed Object',()=>unknown({extra:[['reader.ts',"const Object=custom;"+enumeration()]]}));
test('namespace filter rejects imported Object',()=>unknown({extra:[['reader.ts',"import Object from 'custom';"+enumeration()]]}));
for(const mutation of ["String.prototype.startsWith=custom;","Object.entries=custom;","const S=String; mutate(S);","Object.defineProperty(String.prototype,'startsWith',{value:custom});"]) test(`namespace filter rejects modified builtins: ${mutation}`,()=>unknown({extra:[['reader.ts',enumeration()],['patch.ts',mutation]]}));
test('namespace key-filter proof follows an exported alias that could retain the array',()=>unknown({extra:[['barrel.ts',"export { LANGS as PROPERTY_LANGS } from './config';"],['reader.ts',enumeration().replace("'./config'","'./barrel'")]]}));
for(const mutation of ['Array.prototype.map=custom;', 'Array.prototype[Symbol.iterator]=custom;', 'String.prototype.substring=custom;', 'const C=Array; mutate(C);', "globalThis['Array'].prototype.map=custom;"]) test(`visible intrinsic modification prevents evaluation: ${mutation}`,()=>unknown({extra:[['patch.ts',mutation]]}));
for(const mutation of ["[].constructor.prototype.map=()=>[];", "[].__proto__.map=()=>[];", "Object.getPrototypeOf([]).map=()=>[];", "const other=[]; other.__proto__.map=()=>[];"]) test(`literal or visible prototype escape prevents intrinsic evaluation: ${mutation}`,()=>unknown({before:mutation}));
for(const dynamic of ["eval('LANGS.length=0');", "new Function('LANGS.length=0');", "(0,eval)('LANGS.length=0');"]) test(`dynamic code disables source-only constant proof: ${dynamic}`,()=>unknown({before:dynamic}));
