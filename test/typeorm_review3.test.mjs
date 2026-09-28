// typeorm_review3.test.mjs — the TypeORM defects a third review reproduced, each pinned by the test the review named.
//
// Every fixture is written out here, in the shape the review's repro scripts
// ran it: what is under test is the conclusion the lane draws, and each test
// fails on the lane as the review found it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';

const SETUP = `import {Entity,Column,PrimaryColumn,ManyToOne,Repository,DataSource} from 'typeorm';
const ds = new DataSource({type:'postgres'});
@Entity('roles') export class Role { @PrimaryColumn() id:number; @Column() title:string; }
@Entity('users') export class User { @PrimaryColumn() id:number; @Column() email:string; @Column() bio:string; @ManyToOne(()=>Role,{eager:true}) role:Role; }
export class S { constructor(private ds:DataSource, private users:Repository<User>, private roles:Repository<Role>) {}
`;

function method(body, extra = '') {
  const g = new Graph();
  const stats = addTsFacts(g, factsOfFile('repro.ts', `${SETUP}async m(flag:boolean) {${body}} ${extra}}`));
  return { g, stats };
}
const sid = (i = 0) => `statement:typeorm:repro.ts#S.m/${i}`;
const edges = (g, i = 0) => g.edges.filter((e) => e.from === sid(i));
const grade = (g, to, i = 0, type = 'READS') => edges(g, i).find((e) => e.to === to && e.type === type)?.grade ?? null;

// ---------------------------------------------------------------------------
// E1: a builder whose local escapes
// ---------------------------------------------------------------------------

test('typeorm_builder_escaping_local_is_not_whole_row_exact', () => {
  const helper = method("const qb=this.users.createQueryBuilder('u'); this.narrow(qb); return qb.getMany();", "narrow(q:any){ q.select('u.id'); }");
  const alias = method("const qb=this.users.createQueryBuilder('u'); const q2=qb; q2.select('u.id'); return qb.getMany();");
  for (const [name, r] of [['helper', helper], ['alias', alias]]) {
    assert.notEqual(grade(r.g, 'column:users.bio'), 'EXACT', `${name}: a step outside may narrow the rows`);
    const node = r.g.nodes.get(sid());
    assert.ok(node.unresolved?.some((u) => u.reason === 'builder-escapes'), `${name}: said, ${JSON.stringify(node.unresolved)}`);
    assert.equal(node.columnsRuntimeOnly, true, name);
  }
  const clone = method("const qb=this.users.createQueryBuilder('u'); const q2=qb.clone().select('u.id'); await q2.getMany(); return qb.getMany();");
  assert.equal(grade(clone.g, 'column:users.bio'), 'EXACT', 'a select on a clone does not narrow the builder it copies');
  assert.ok(clone.g.nodes.get(sid()).unresolved?.some((u) => /clone/.test(u.detail)), 'the copy is not read, and is said');
});

// ---------------------------------------------------------------------------
// E2: a repository a local receives after its declaration, or through a condition
// ---------------------------------------------------------------------------

test('typeorm_receiver_assigned_after_declaration_is_said', () => {
  const later = method('let r; r=this.ds.getRepository(User); return r.find();');
  assert.ok(edges(later.g).some((e) => e.type === 'EXECUTES' && e.to === 'table:users'), 'one assignment settles what the local holds');
  const member = method('const r = this.users; return r.find();');
  assert.ok(edges(member.g).some((e) => e.type === 'EXECUTES' && e.to === 'table:users'), 'a local holding a field holds the field\'s repository');
  const ternary = method('const r = flag ? this.ds.getRepository(User) : this.ds.getRepository(Role); return r.find();');
  assert.equal(ternary.g.nodes.has(sid()), false, 'which repository it holds is the condition\'s to decide');
  assert.ok(ternary.stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_RECEIVER_UNREAD' && /one of the values a condition/.test(d.reason)), JSON.stringify(ternary.stats.diagnostics));
});

// ---------------------------------------------------------------------------
// E3: count and exists join the eager relations in TypeORM 0.3
// ---------------------------------------------------------------------------

test('typeorm_count_joins_eager_relations_in_0_3', () => {
  const { g } = method("return this.users.count({where:{email:'x'}});");
  assert.equal(grade(g, 'table:roles', 0, 'EXECUTES'), 'SOUND_SET', '0.3 LEFT JOINs the eager role; 0.2 does not');
  assert.equal(grade(g, 'column:users.roleId'), 'SOUND_SET');
  assert.equal(grade(g, 'column:roles.title'), null, 'a count selects no row of the relation');
  const off = method("return this.users.count({where:{email:'x'}, loadEagerRelations:false});");
  assert.equal(grade(off.g, 'table:roles', 0, 'EXECUTES'), null);
});

// ---------------------------------------------------------------------------
// E4, N6, N8, design 4 and 5: names
// ---------------------------------------------------------------------------

const IMPORTS = "import { Entity, Column, PrimaryColumn, DataSource, TableInheritance, ChildEntity } from 'typeorm';\nimport { SnakeNamingStrategy } from 'typeorm-naming-strategies';\n";
function names(source, options = {}, g = new Graph()) {
  const stats = addTsFacts(g, factsOfFile('fixture.ts', IMPORTS + source), options);
  return { graph: g, stats };
}
const tableGrade = (r, id) => r.graph.nodes.get(`table:${id}`)?.typeormNameGrade ?? null;

test('typeorm_inheritance_only_entities_are_said', () => {
  const r = names("new DataSource({type:'postgres'}); @Entity('content') @TableInheritance({column:{type:'varchar',name:'type'}}) export class Content { @PrimaryColumn() id:number; @Column() title:string; } @ChildEntity() export class Photo extends Content { @Column() size:number; }");
  assert.ok(r.stats.typeorm, 'the lane says what it read, even when it could read no entity');
  const said = r.stats.diagnostics.find((d) => d.kind === 'TS_TYPEORM_MAPPING_UNREAD');
  assert.match(said?.reason ?? '', /Content.*TableInheritance/);
  assert.match(said.reason, /Photo.*ChildEntity/);
});

test('typeorm_mysql_datasource_schema_does_not_qualify_table', () => {
  const mysql = names("new DataSource({type:'mysql',schema:'billing'}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(mysql, 'users'), 'EXACT', 'MysqlDriver.buildTableName puts the database, not the schema, before a table');
  assert.equal(mysql.graph.nodes.has('table:billing.users'), false);
  const db = names("new DataSource({type:'mysql',database:'app'}); @Entity('users',{database:'other'}) export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(db, 'other.users'), 'EXACT', 'an entity\'s own database qualifies it on MySQL');
  const sqlite = names("new DataSource({type:'sqlite',database:'x.db',schema:'billing'}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(sqlite, 'users'), 'EXACT', 'SQLite puts nothing before a table');
  const pg = names("new DataSource({type:'postgres',schema:'billing'}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(pg, 'billing.users'), 'EXACT');
  const unknown = names("import { dbType } from './env'; new DataSource({type:dbType,schema:'billing'}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(unknown, 'billing.users'), 'HEURISTIC', 'the driver decides whether the schema qualifies the table, and it is not known');
});

test('typeorm_schema_stub_beside_unqualified_ddl_is_said', () => {
  const cat = [{ kind: 'table', schema: null, table: 'users', comment: null }, { kind: 'column', schema: null, table: 'users', column: 'id', type: 'INT', pk: true, comment: null }];
  const g = buildGraphFromSql(cat, []);
  const r = names("new DataSource({type:'postgres', schema:'public'}); @Entity('users') export class User { @PrimaryColumn() id:number; }", { catalogRecords: cat, identifierCase: 'fold-lower' }, g);
  assert.ok(g.nodes.has('table:public.users'), 'the name is TypeORM\'s: public.users');
  const said = r.stats.diagnostics.find((d) => d.kind === 'TS_TYPEORM_TABLE_MISSES_DDL');
  assert.match(said?.reason ?? '', /public\.users.*users/, JSON.stringify(r.stats.diagnostics));
  assert.match(said.reason, /schema\.default/);
  // Declared as the default schema, public is where the DDL's unqualified users is: one table.
  const g2 = buildGraphFromSql(cat, []);
  const met = names("new DataSource({type:'postgres', schema:'public'}); @Entity('users') export class User { @PrimaryColumn() id:number; }", { catalogRecords: cat, identifierCase: 'fold-lower', schemaName: 'public' }, g2);
  assert.equal(g2.nodes.has('table:public.users'), false);
  assert.equal(g2.nodes.get('table:users').typeormCatalogMatch, true);
  assert.equal(met.stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_TABLE_MISSES_DDL'), false);
});

test('typeorm_const_literal_options_are_read', () => {
  const prefix = names("const prefix = 'tenant_'; new DataSource({type:'postgres', entityPrefix: prefix}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(prefix, 'tenant_users'), 'EXACT', 'a const literal in the same file is the value it holds');
  const schema = names("const SCHEMA = 'billing'; new DataSource({type:'postgres', schema: SCHEMA}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(schema, 'billing.users'), 'EXACT');
  const strategy = names("const naming = new SnakeNamingStrategy(); new DataSource({type:'postgres', namingStrategy: naming}); @Entity() export class UserProfile { @PrimaryColumn() id:number; @Column() createdAt:Date; }");
  assert.ok(strategy.graph.nodes.has('column:user_profile.created_at'));
  assert.equal(tableGrade(strategy, 'user_profile'), 'EXACT');
  const loose = names("let prefix = 'tenant_'; prefix = 'x_'; new DataSource({type:'postgres', entityPrefix: prefix}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(loose, 'users'), 'HEURISTIC', 'a value written again is not the literal it started as');
});
