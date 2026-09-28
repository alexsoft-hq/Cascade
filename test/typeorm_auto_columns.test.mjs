// typeorm_auto_columns.test.mjs — the columns TypeORM writes on its own: a date or a version the call does not name.
//
// TypeORM 0.2.24 to 0.3.28 (src/query-builder): UpdateQueryBuilder sets the
// @UpdateDateColumn to CURRENT_TIMESTAMP and the @VersionColumn to itself plus
// one; SoftDeleteQueryBuilder does the same beside the @DeleteDateColumn;
// InsertQueryBuilder lists every insertable column, the version as 1 and the
// dates as their DEFAULT. Every Repository and EntityManager write goes
// through one of them, save through the insert or the update as the row it
// finds decides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';

const ENTITY = `import {Entity,Column,PrimaryColumn,CreateDateColumn,UpdateDateColumn,VersionColumn,DeleteDateColumn,Repository,DataSource} from 'typeorm';
const ds = new DataSource({type:'postgres'});
@Entity('users') export class User {
  @PrimaryColumn() id:number; @Column() email:string; @Column() logins:number;
  @CreateDateColumn() createdAt:Date; @UpdateDateColumn() updatedAt:Date; @VersionColumn() version:number; @DeleteDateColumn() deletedAt:Date;
}
`;

function run(body, entity = ENTITY) {
  const g = new Graph();
  addTsFacts(g, factsOfFile('auto.ts', `${entity}export class S { constructor(private users:Repository<User>, private ds:DataSource) {}\nasync m(u:User) {${body}} }`));
  const sid = 'statement:typeorm:auto.ts#S.m/0';
  const edges = g.edges.filter((e) => e.from === sid);
  const grade = (col, type = 'WRITES') => edges.find((e) => e.type === type && e.to === `column:users.${col}`)?.grade ?? null;
  return { g, edges, grade, node: g.nodes.get(sid) };
}

test('typeorm_update_writes_update_date_and_version', () => {
  for (const body of [
    "return this.users.update({id:1},{email:'x'});",
    "return this.users.createQueryBuilder().update(User).set({email:'x'}).where('id = :id',{id:1}).execute();",
    "return this.users.increment({id:1},'logins',1);",
  ]) {
    const r = run(body);
    assert.equal(r.grade('updatedAt'), 'EXACT', `${body}: UpdateQueryBuilder sets the update date`);
    assert.equal(r.grade('version'), 'EXACT', `${body}: and the version to version + 1`);
    assert.equal(r.grade('version', 'READS'), 'EXACT', `${body}: which reads the version it adds one to`);
    assert.equal(r.grade('createdAt'), null, `${body}: an update leaves the create date`);
    assert.equal(r.grade('deletedAt'), null, body);
    const auto = r.edges.find((e) => e.type === 'WRITES' && e.to === 'column:users.updatedAt');
    assert.equal(auto.evidence?.rule, 'typeorm-auto-column', 'the edge says TypeORM wrote it, not the call');
  }
});

test('typeorm_soft_delete_writes_update_date_and_version', () => {
  for (const body of [
    'return this.users.softDelete({id:1});',
    'return this.users.restore({id:1});',
    'return this.users.softRemove(u);',
    'return this.users.recover(u);',
    "return this.users.createQueryBuilder().softDelete().where('id = :id',{id:1}).execute();",
    "return this.users.createQueryBuilder().restore().where('id = :id',{id:1}).execute();",
  ]) {
    const r = run(body);
    assert.equal(r.grade('deletedAt'), 'EXACT', body);
    assert.equal(r.grade('updatedAt'), 'EXACT', `${body}: SoftDeleteQueryBuilder sets the update date too`);
    assert.equal(r.grade('version'), 'EXACT', `${body}: and the version`);
    assert.equal(r.grade('createdAt'), null, body);
  }
});

test('typeorm_insert_writes_create_date_update_date_and_version', () => {
  for (const body of [
    "return this.users.insert({email:'x'});",
    "return this.users.upsert({id:1, email:'x'}, ['id']);",
    "return this.users.createQueryBuilder().insert().into(User).values({email:'x'}).execute();",
  ]) {
    const r = run(body);
    for (const col of ['createdAt', 'updatedAt', 'version']) assert.equal(r.grade(col), 'EXACT', `${body}: InsertQueryBuilder lists ${col}`);
    assert.equal(r.grade('version', 'READS'), null, `${body}: a new row's version is 1, not read`);
  }
  const listed = run("return this.users.createQueryBuilder().insert().into(User, ['email', 'createdAt']).values({email:'x'}).execute();");
  assert.equal(listed.grade('createdAt'), 'EXACT', 'a column the list names is inserted');
  assert.equal(listed.grade('updatedAt'), null, 'into with a list of columns inserts those alone');
  assert.equal(listed.grade('version'), null);
});

test('typeorm_save_writes_what_both_of_its_statements_write', () => {
  const r = run("return this.users.save({id:1, email:'x'});");
  assert.equal(r.grade('email'), 'EXACT', 'what the object names is written');
  assert.equal(r.grade('updatedAt'), 'EXACT', 'the insert and the update both set it');
  assert.equal(r.grade('version'), 'EXACT');
  assert.equal(r.grade('createdAt'), 'SOUND_SET', 'only an insert sets it, and which one save sends is the row it finds');
});

test('typeorm_delete_writes_no_date', () => {
  const r = run('return this.users.delete({id:1});');
  for (const col of ['createdAt', 'updatedAt', 'version', 'deletedAt']) assert.equal(r.grade(col), null, col);
});

test('typeorm_auto_column_left_out_of_insert_is_not_written', () => {
  const quiet = ENTITY.replace('@CreateDateColumn() createdAt', '@CreateDateColumn({insert:false}) createdAt');
  assert.equal(run("return this.users.insert({email:'x'});", quiet).grade('createdAt'), null, 'insert: false keeps it out of the INSERT (ColumnMetadata.isInsert)');
  const unknown = ENTITY.replace('@CreateDateColumn() createdAt', '@CreateDateColumn({insert: flag}) createdAt').replace("const ds", 'declare const flag: boolean;\nconst ds');
  assert.equal(run("return this.users.insert({email:'x'});", unknown).grade('createdAt'), 'SOUND_SET', 'an insert option not written out may keep it out');
});

test('typeorm_auto_column_is_as_sure_as_its_name', () => {
  const assumed = ENTITY.replace("const ds = new DataSource({type:'postgres'});", '');
  const r = run("return this.users.update({id:1},{email:'x'});", assumed);
  assert.equal(r.grade('updatedAt'), 'HEURISTIC', 'a name derived under a naming strategy not known is HEURISTIC, whatever wrote it');
});
