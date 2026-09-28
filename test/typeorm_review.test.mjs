// typeorm_review.test.mjs — the TypeORM defects a second review reproduced, each pinned by the test the review named.
//
// Every fixture is written out here (the review's repro scripts, kept in the
// shape they were run in): what is under test is the conclusion the lane draws,
// and each test fails on the lane as the review found it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';

// ---------------------------------------------------------------------------
// calls: one method of one class, over two entities
// ---------------------------------------------------------------------------

const SETUP = `import {Entity,Column,PrimaryColumn,ManyToOne,Repository,DataSource} from 'typeorm';
const ds = new DataSource({type:'postgres'});
@Entity('roles') export class Role { @PrimaryColumn() id:number; @Column() title:string; }
@Entity('users') export class User { @PrimaryColumn() id:number; @Column() email:string; @Column() bio:string; @ManyToOne(()=>Role,{eager:true}) role:Role; }
export class S { constructor(private ds:DataSource, private users:Repository<User>, private roles:Repository<Role>) {}
`;

function method(body) {
  const g = new Graph();
  const stats = addTsFacts(g, factsOfFile('repro.ts', `${SETUP}async m(flag:boolean) {${body}}}`));
  return { g, stats };
}
const edges = (g, i = 0) => g.edges.filter((e) => e.from === `statement:typeorm:repro.ts#S.m/${i}`);

test('typeorm_receiver_uses_lexical_declaration', () => {
  const { g } = method('const r=this.ds.getRepository(User); {const r=this.ds.getRepository(Role); await r.find();} return r.find();');
  assert.equal(edges(g, 0).some((e) => e.type === 'EXECUTES' && e.to === 'table:users'), false, 'the inner r is the Role repository');
  assert.ok(edges(g, 0).some((e) => e.type === 'EXECUTES' && e.to === 'table:roles'));
  assert.ok(edges(g, 1).some((e) => e.type === 'EXECUTES' && e.to === 'table:users'), 'the outer r is still the User repository');
});

test('typeorm_receiver_invalidates_reassigned_local', () => {
  const { g, stats } = method('let r=this.ds.getRepository(User); r=this.ds.getRepository(Role); return r.find();');
  assert.equal(edges(g).some((e) => e.to === 'table:users' && e.grade === 'EXACT'), false, JSON.stringify(edges(g)));
  assert.ok(stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_RECEIVER_UNREAD' && /assigned again/.test(d.reason)), 'what was not read is said');
});

test('typeorm_builder_preserves_each_execution_projection', () => {
  const { g } = method("const qb=this.users.createQueryBuilder('u').select('u.id'); await qb.getRawMany(); qb.select('u.email'); return qb.getRawMany();");
  assert.ok(edges(g).some((e) => e.to === 'column:users.id' && e.type === 'READS'), JSON.stringify(edges(g)));
  assert.ok(edges(g).some((e) => e.to === 'column:users.email' && e.type === 'READS'));
});

test('typeorm_conditional_select_keeps_candidate_columns', () => {
  const { g } = method("const qb=this.users.createQueryBuilder('u'); if(flag) qb.select('u.id'); return qb.getRawMany();");
  const email = edges(g).find((e) => e.to === 'column:users.email' && e.type === 'READS');
  assert.ok(email, JSON.stringify(edges(g)));
  assert.equal(email.grade, 'SOUND_SET', 'read only when the branch does not run: a candidate');
});

test('typeorm_partial_select_keeps_eager_relations', () => {
  const { g } = method('return this.users.find({where:{},select:{email:true}});');
  assert.ok(edges(g).some((e) => e.to === 'table:roles'), JSON.stringify(edges(g)));
  assert.ok(edges(g).some((e) => e.to === 'column:roles.title'), 'the eager relation is selected whole');
});

test('typeorm_partial_select_keeps_explicit_relation_columns', () => {
  const { g } = method("return this.users.find({where:{},select:{id:true},relations:['role'],loadEagerRelations:false});");
  assert.ok(edges(g).some((e) => e.to === 'column:roles.title'), JSON.stringify(edges(g)));
});

test('typeorm_modern_select_object_does_not_read_unselected_column', () => {
  const { g, stats } = method('return this.users.find({select:{email:true}});');
  assert.equal(edges(g).some((e) => e.to === 'column:users.bio' && e.grade === 'EXACT'), false, JSON.stringify(edges(g)));
  assert.ok(edges(g).some((e) => e.to === 'column:users.email' && e.grade === 'EXACT'));
  assert.equal(g.nodes.get('statement:typeorm:repro.ts#S.m/0').unresolved, undefined, 'nothing about it was not read');
  void stats;
});

/** The corpus checkout, found by walking up from this file (CASCADE_TS_CORPUS names another), or null. */
function corpusRepo(name) {
  if (process.env.CASCADE_TS_CORPUS) return path.join(process.env.CASCADE_TS_CORPUS, name);
  for (let dir = path.dirname(new URL(import.meta.url).pathname); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const hit = path.join(dir, '.oss-work', 'ts-corpus', name);
    if (fs.existsSync(hit)) return hit;
  }
  return null;
}

// nestjs-realworld-example-app at c1c2cc4, the lines this rests on: article.service.ts:181 and the three entities.
const REALWORLD = [
  ['src/user/user.entity.ts', `import {Entity, PrimaryGeneratedColumn, Column, OneToMany} from 'typeorm';
import { ArticleEntity } from '../article/article.entity';
@Entity('user')
export class UserEntity {
  @PrimaryGeneratedColumn() id: number;
  @Column() username: string;
  @OneToMany(type => ArticleEntity, article => article.author) articles: ArticleEntity[];
}`],
  ['src/article/article.entity.ts', `import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { UserEntity } from '../user/user.entity';
import { Comment } from './comment.entity';
@Entity('article')
export class ArticleEntity {
  @PrimaryGeneratedColumn() id: number;
  @Column() slug: string;
  @ManyToOne(type => UserEntity, user => user.articles) author: UserEntity;
  @OneToMany(type => Comment, comment => comment.article, {eager: true}) @JoinColumn() comments: Comment[];
}`],
  ['src/article/comment.entity.ts', `import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { ArticleEntity } from './article.entity';
@Entity()
export class Comment {
  @PrimaryGeneratedColumn() id: number;
  @Column() body: string;
  @ManyToOne(type => ArticleEntity, article => article.comments) article: ArticleEntity;
}`],
  ['src/article/article.service.ts', `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArticleEntity } from './article.entity';
import { UserEntity } from '../user/user.entity';
@Injectable()
export class ArticleService {
  constructor(@InjectRepository(ArticleEntity) private readonly articleRepository: Repository<ArticleEntity>,
    @InjectRepository(UserEntity) private readonly userRepository: Repository<UserEntity>) {}
  async create(userId: number, article: ArticleEntity) {
    const newArticle = await this.articleRepository.save(article);
    const author = await this.userRepository.findOne({ where: { id: userId }, relations: ['articles'] });
    return newArticle;
  }
}`],
];

/** The EXECUTES edges of realworld's ArticleService.create/1, `findOne({ where: { id }, relations: ['articles'] })`. */
function createFindOne(records) {
  const g = new Graph();
  addTsFacts(g, records, { typeorm: { namingStrategy: 'default', entityPrefix: '', schema: '' } });
  return g.edges.filter((e) => e.from === 'statement:typeorm:src/article/article.service.ts#ArticleService.create/1' && e.type === 'EXECUTES');
}

test('typeorm_explicit_relation_follows_target_eager_in_realworld', (t) => {
  // relations: ['articles'] loads Article, and TypeORM joins Article's eager comments with it.
  const inline = createFindOne(REALWORLD.flatMap(([f, text]) => factsOfFile(f, text)));
  assert.ok(inline.some((e) => e.to === 'table:comment' && e.grade === 'EXACT'), JSON.stringify(inline));
  const root = corpusRepo('nestjs-realworld-example-app');
  if (!root || !fs.existsSync(root)) { t.skip('the realworld checkout is not on this machine: the inline copy of its files was read'); return; }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name))
    : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [path.join(d, e.name)] : []));
  const real = createFindOne(walk(`${root}/src`).flatMap((f) => factsOfFile(path.relative(root, f), fs.readFileSync(f, 'utf8'))));
  assert.ok(real.some((e) => e.to === 'table:comment'), JSON.stringify(real));
});

// ---------------------------------------------------------------------------
// names: what the options and the decorators leave unknown
// ---------------------------------------------------------------------------

const IMPORTS = "import { Entity, Column, PrimaryColumn, ManyToOne, ManyToMany, JoinColumn, JoinTable, DataSource } from 'typeorm';";
function names(source, options = {}) {
  const graph = new Graph();
  const stats = addTsFacts(graph, factsOfFile('fixture.ts', IMPORTS + source), options);
  return { graph, stats };
}
const tableGrade = (r, id) => r.graph.nodes.get(`table:${id}`)?.typeormNameGrade;

test('typeorm unknown entityPrefix remains uncertain after declaring naming strategy', () => {
  const explicit = names("const prefix='tenant_'; new DataSource({type:'postgres',entityPrefix:prefix}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  const declared = names("const prefix='tenant_'; new DataSource({type:'postgres',entityPrefix:prefix}); @Entity() export class User { @PrimaryColumn() id:number; }", { typeorm: { namingStrategy: 'default' } });
  // TypeORM names these tenant_users and tenant_user; neither unprefixed name is known.
  assert.deepEqual([tableGrade(explicit, 'users'), tableGrade(declared, 'user')], ['HEURISTIC', 'HEURISTIC']);
  const settled = names("const prefix='tenant_'; new DataSource({type:'postgres',entityPrefix:prefix}); @Entity('users') export class User { @PrimaryColumn() id:number; }", { typeorm: { entityPrefix: 'tenant_' } });
  assert.equal(tableGrade(settled, 'tenant_users'), 'EXACT', 'a declared prefix is applied, and the name is then known');
});

test('typeorm datasource schema supplies entity schema when decorator omits it', () => {
  const r = names("new DataSource({type:'postgres',schema:'billing'}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.ok(r.graph.nodes.has('table:billing.users'), 'the DataSource schema is billing');
  const own = names("new DataSource({type:'postgres',schema:'billing'}); @Entity('users', { schema: 'audit' }) export class User { @PrimaryColumn() id:number; }");
  assert.ok(own.graph.nodes.has('table:audit.users'), 'the decorator\'s own schema wins');
  const unread = names("const s='x'; new DataSource({type:'postgres',schema:s}); @Entity('users') export class User { @PrimaryColumn() id:number; }");
  assert.equal(tableGrade(unread, 'users'), 'HEURISTIC', 'a schema held in a variable leaves the table\'s schema unknown');
});

test('typeorm undecorated subclass declaration preserves inherited column metadata', () => {
  const r = names("new DataSource({type:'postgres'}); abstract class Base { @PrimaryColumn() id:number; @Column() email:string; } @Entity('users') export class User extends Base { declare email:string; }");
  assert.ok(r.graph.nodes.has('column:users.email'), 'Base @Column email is still TypeORM metadata');
});

test('typeorm dynamic JoinColumn and JoinTable names do not become exact defaults', () => {
  const col = names("new DataSource({type:'postgres'}); const fk='parent_fk'; @Entity('parent') export class Parent { @PrimaryColumn() id:number; } @Entity('child') export class Child { @PrimaryColumn() id:number; @ManyToOne(()=>Parent) @JoinColumn({name:fk}) parent:Parent; }");
  const jt = names("new DataSource({type:'postgres'}); const jt='custom_join'; @Entity('tag') export class Tag { @PrimaryColumn() id:number; } @Entity('post') export class Post { @PrimaryColumn() id:number; @ManyToMany(()=>Tag) @JoinTable({name:jt}) tags:Tag[]; }");
  const edge = col.graph.edges.find((e) => e.type === 'DECLARES' && e.to === 'column:child.parentId');
  assert.deepEqual([edge?.grade, tableGrade(jt, 'post_tags_tag')], ['HEURISTIC', 'HEURISTIC']);
});
