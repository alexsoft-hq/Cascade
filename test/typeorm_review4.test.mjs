// typeorm_review4.test.mjs — review 4 of the TypeORM reading: what a builder or an operation cannot see is said, never read as EXACT.
//
// The reviewer's failing tests (.oss-work/rm67/review4-repro/r4-f2), pointed at
// this tree, and the rules behind them: a builder is read as not escaping only
// where every use of its local is one this engine recognizes (design 1); a
// column TypeORM reads or writes of its own accord is drawn when the source
// says it happens, a candidate when it may, and nothing when the source says it
// does not (0.3.28 UpdateQueryBuilder.js:395, QueryBuilder.js:544-556).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { column_impact } from '../src/mcp/tools.mjs';

const SETUP = `import {Entity,Column,PrimaryColumn,ManyToOne,ManyToMany,JoinTable,Repository,DataSource,CreateDateColumn,UpdateDateColumn,VersionColumn,DeleteDateColumn} from 'typeorm';
const ds = new DataSource({type:'postgres'});
@Entity('roles') export class Role { @PrimaryColumn() id:number; @Column() title:string; }
@Entity('users') export class User { @PrimaryColumn() id:number; @Column() email:string; @Column() bio:string; @ManyToOne(()=>Role,{eager:true}) role:Role; }
@Entity('docs') export class Doc { @PrimaryColumn() id:number; @Column() title:string; @UpdateDateColumn() updatedAt:Date; @VersionColumn() version:number; @DeleteDateColumn() deletedAt:Date; }
@Entity('tags') export class Tag { @PrimaryColumn() id:number; @Column() label:string; }
@Entity('notes') export class Note { @PrimaryColumn() id:number; @ManyToMany(()=>Tag,{eager:true}) @JoinTable() tags:Tag[]; }
export class S { constructor(private ds:DataSource, private users:Repository<User>, private roles:Repository<Role>, private docs:Repository<Doc>, private notes:Repository<Note>) {}
`;
function method(body, extra = '') {
  const g = new Graph();
  const stats = addTsFacts(g, factsOfFile('repro.ts', `${SETUP}async m(flag:boolean) {${body}} ${extra}}`));
  return { g, stats };
}
const sid = 'statement:typeorm:repro.ts#S.m/0';
const grade = (g, to, type = 'READS') => g.edges.find((e) => e.from === sid && e.to === to && e.type === type)?.grade ?? null;
const said = (g) => (g.nodes.get(sid)?.unresolved ?? []).some((u) => u.reason === 'builder-escapes') || g.nodes.get(sid)?.columnsRuntimeOnly === true;

test('typeorm_builder_escape_through_new_object_array_or_chain_alias_is_said', () => {
  const narrow = "narrow(q:any){ q?.select?.('u.id'); q?.qb?.select('u.id'); }";
  for (const [name, body] of [
    ['chain alias', "const qb=this.users.createQueryBuilder('u'); const q2 = qb.where('u.id > 0'); q2.select('u.id'); return qb.getMany();"],
    ['new', "const qb=this.users.createQueryBuilder('u'); const p:any = new Pager(qb); p.narrow(); return qb.getMany();"],
    ['object holder', "const qb=this.users.createQueryBuilder('u'); const h={qb}; h.qb.select('u.id'); return qb.getMany();"],
    ['array holder', "const qb=this.users.createQueryBuilder('u'); const xs=[qb]; xs[0].select('u.id'); return qb.getMany();"],
    ['conditional arg', "const qb=this.users.createQueryBuilder('u'); this.narrow(flag ? qb : null); return qb.getMany();"],
    ['spread arg', "const qb=this.users.createQueryBuilder('u'); this.narrow(...[qb]); return qb.getMany();"],
    ['logical arg', "const qb=this.users.createQueryBuilder('u'); this.narrow(flag && qb); return qb.getMany();"],
    ['assigned to a member', "const qb=this.users.createQueryBuilder('u'); (this as any).q = qb; this.narrow(null); return qb.getMany();"],
    ['closure', "const qb=this.users.createQueryBuilder('u'); const f = () => qb.select('u.id'); f(); return qb.getMany();"],
  ]) {
    const { g } = method(body, narrow);
    assert.notEqual(grade(g, 'column:users.bio'), 'EXACT', `${name}: a step outside may narrow the row`);
    assert.ok(said(g), `${name}: the escape is said`);
  }
});

test('a builder whose local is only chained, stepped and run stays EXACT', () => {
  const { g } = method("const qb=this.users.createQueryBuilder('u'); qb.where('u.id > 0'); if (flag) qb.andWhere('u.email = :e'); return qb.getMany();");
  assert.equal(grade(g, 'column:users.bio'), 'EXACT');
  assert.ok(!said(g));
});

test('typeorm_subquery_steps_are_not_the_outer_builders', () => {
  const { g } = method("const qb=this.users.createQueryBuilder('u'); const sub=qb.subQuery().select('u.id').from(User,'u').getQuery(); qb.where('u.id IN ' + sub); return qb.getMany();");
  assert.ok(grade(g, 'column:users.email'), 'the outer builder still returns the whole row (subQuery makes another builder)');
});

test('typeorm_builder_reassigned_local_is_a_lower_bound_in_column_impact', () => {
  const { g } = method("let q = this.users.createQueryBuilder('u'); if (flag) q = q.andWhere('u.email = :e', {e:1}); return q.getMany();");
  const ctx = { graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' } };
  const r = column_impact(g, { column: 'users.email', mode: 'read' }, ctx);
  const listed = (r.answer.statements?.items ?? r.answer.statements ?? []).length > 0;
  const limit = (r.limits ?? []).find((l) => /runtime-only-columns/.test(l.scope));
  assert.ok(listed || limit, 'the statement reads users.email when it runs: listed or a lower-bound limit');
  if (limit) assert.doesNotMatch(limit.reason ?? limit.text ?? JSON.stringify(limit), /MyBatis-Plus/, 'a TypeORM statement is not blamed on MyBatis-Plus');
});

// The reviewer asked for no read at all where the values name the version: that is 0.3.28's answer
// (UpdateQueryBuilder.js:395), and every version since 0.2.34. Before 0.2.34 the update added one
// whatever the values said (the typeorm pack's why), and the engine does not read which version is
// installed, so the read is a candidate there: never EXACT, never absent.
test('typeorm_update_naming_the_version_does_not_read_it', () => {
  const given = method("return this.docs.update(1, {title:'x', version: 5});");
  assert.equal(grade(given.g, 'column:docs.version'), 'SOUND_SET', 'since 0.2.34 no read; before, a read: a candidate, not EXACT');
  assert.equal(grade(given.g, 'column:docs.version', 'WRITES'), 'EXACT', 'the values write it');
  const unknown = method("const v:any = {title:'x'}; return this.docs.update(1, v);");
  assert.notEqual(grade(unknown.g, 'column:docs.version'), 'EXACT', 'values not written out may name the version');
  const qb = method("return this.docs.createQueryBuilder().update(Doc).set({version: 3}).where('id = 1').execute();");
  assert.equal(grade(qb.g, 'column:docs.version'), 'SOUND_SET', 'a builder\'s set that names the version: the same candidate');
  const plain = method("return this.docs.update(1, {title:'x'});");
  assert.equal(grade(plain.g, 'column:docs.version'), 'EXACT', 'values that do not name it add one to it in every version: read, and written');
});

test('typeorm_select_on_soft_deletable_entity_reads_delete_date', () => {
  const c = method("return this.docs.count({where:{title:'x'}});");
  assert.ok(grade(c.g, 'column:docs.deletedAt'), 'QueryBuilder.createWhereExpression adds deletedAt IS NULL to a select without withDeleted');
  const q = method("return this.docs.createQueryBuilder('d').select('d.id').getMany();");
  assert.ok(grade(q.g, 'column:docs.deletedAt'));
  const w = method("return this.docs.createQueryBuilder('d').select('d.id').withDeleted().getMany();");
  assert.equal(grade(w.g, 'column:docs.deletedAt'), null, 'withDeleted leaves the filter out');
  const f = method("return this.docs.find({ withDeleted: true, select: { id: true } });");
  assert.equal(grade(f.g, 'column:docs.deletedAt'), null, 'the find option withDeleted leaves it out too');
  const none = method("return this.users.count({where:{email:'x'}});");
  assert.equal(grade(none.g, 'column:users.deletedAt'), null, 'an entity with no delete date column has no filter');
});

test('typeorm_receiver_from_destructure_or_logical_is_said', () => {
  for (const body of ['const { users } = this; return users.find();', 'const r = (flag && this.users) || this.roles; return r.find();', 'const r = (this as any).maybe ?? this.roles; return r.find();']) {
    const { g, stats } = method(body);
    const made = g.nodes.has(sid);
    assert.ok(made || stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_RECEIVER_UNREAD'), `${body}: a statement or a diagnostic`);
  }
});

test('a count joins an eager many-to-many without its rows, and still reads the key it joins on', () => {
  const { g } = method("return this.notes.count();");
  assert.ok(grade(g, 'column:tags.id'), 'the join matches on the target key');
  assert.equal(grade(g, 'column:tags.label'), null, 'and selects nothing of it');
});

const IMPORTS = "import { Entity, Column, PrimaryColumn, DataSource, DefaultNamingStrategy } from 'typeorm';\nimport { SnakeNamingStrategy } from 'typeorm-naming-strategies';\n";
function names(src, opts = {}) { const g = new Graph(); const stats = addTsFacts(g, factsOfFile('fixture.ts', IMPORTS + src), opts); return { g, stats }; }

test('typeorm_module_let_strategy_written_again_is_not_read', () => {
  const { g } = names("let naming: any = new SnakeNamingStrategy(); naming = undefined; new DataSource({type:'postgres', namingStrategy: naming}); @Entity('users') export class User { @PrimaryColumn() id:number; @Column() createdAt: Date; }");
  const e = g.edges.find((x) => x.type === 'DECLARES' && x.to === 'column:users.created_at');
  assert.notEqual(e?.grade, 'EXACT', 'naming is undefined when the DataSource is made: DefaultNamingStrategy, createdAt');
  const kept = names("let naming: any = new SnakeNamingStrategy(); new DataSource({type:'postgres', namingStrategy: naming}); @Entity('users') export class User { @PrimaryColumn() id:number; @Column() createdAt: Date; }");
  assert.equal(kept.g.edges.find((x) => x.type === 'DECLARES' && x.to === 'column:users.created_at')?.grade, 'EXACT', 'a module let never written again holds what it was given');
});

test('typeorm_unknown_driver_type_is_said', () => {
  for (const ds of ["{type: process.env.T as any, schema:'s'}", "{type:'mongodb'}"]) {
    const { g, stats } = names(`new DataSource(${ds}); @Entity('users') export class User { @PrimaryColumn() id:number; }`);
    const heuristic = [...g.nodes.values()].some((n) => n.kind === 'table' && n.typeormNameGrade === 'HEURISTIC');
    assert.ok(heuristic, 'precondition');
    assert.ok(stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_NAMING_ASSUMED' && /type|driver/.test(d.reason)), `${ds}: the HEURISTIC names are said with the driver as the reason`);
    const decl = g.edges.find((x) => x.type === 'DECLARES');
    assert.ok(!(decl.grade === 'HEURISTIC' && /which the options name/.test(decl.evidence.why ?? '')), 'a HEURISTIC edge does not give an EXACT reason');
  }
});

test('a driver the profile declares settles the table names the source leaves to the environment', () => {
  const { g, stats } = names("new DataSource({type: process.env.T as any, schema:'s'}); @Entity('users') export class User { @PrimaryColumn() id:number; }", { typeorm: { type: 'postgres' } });
  assert.equal(g.nodes.get('table:s.users')?.typeormNameGrade ?? [...g.nodes.values()].find((n) => n.kind === 'table')?.typeormNameGrade, 'EXACT');
  assert.ok(!stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_NAMING_ASSUMED'));
});

test('typeorm_sqlite_entity_database_is_not_bare_exact', () => {
  const { g } = names("new DataSource({type:'sqlite', database:'main.db'}); @Entity('users',{database:'other.db'}) export class User { @PrimaryColumn() id:number; }");
  assert.notEqual(g.nodes.get('table:users')?.typeormNameGrade, 'EXACT', 'SqliteDriver.buildTableName puts an attach handle before a table of another database file');
});

test('an option held in a const another file declares says so, not that it is no literal', () => {
  const g = new Graph();
  const stats = addTsFacts(g, [
    ...factsOfFile('config.ts', "export const PREFIX = 'app_';"),
    ...factsOfFile('fixture.ts', `${IMPORTS}import { PREFIX } from './config';\nnew DataSource({type:'postgres', entityPrefix: PREFIX}); @Entity('users') export class User { @PrimaryColumn() id:number; }`),
  ]);
  const said = stats.diagnostics.find((d) => d.kind === 'TS_TYPEORM_NAMING_ASSUMED');
  assert.ok(said);
  assert.doesNotMatch(said.reason, /is not a literal/);
  assert.match(said.reason, /another file/);
});
