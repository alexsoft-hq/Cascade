// ts_trees.mjs — the NestJS trees the working-tree overlay is held to, written out here so a test names what it builds.
//
//   prismaTree    the ts-nest fixture: a workspace shaped like ghostfolio, one
//                 package.json for an Angular frontend and a NestJS API, the API
//                 under apps/api/src, prisma/schema.prisma at the top, and a
//                 shared lib reached through a tsconfig path
//   typeormTree   a NestJS application on TypeORM: two entities, a repository
//                 read with a select, written with an insert and walked with a
//                 query builder, under options that name every fact
//   dispatchTree  the ts-nest workspace, and a service that calls through an
//                 abstract class the module binds to one of two subclasses, and
//                 a lib function that sends a request, which the web lane reads
//                 as the frontend's and the TypeScript lane as the API's

import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../../scripts/golden-trees.mjs';

export function write(repo, rel, body) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body, 'utf8');
}

export const PRISMA_SERVICE = 'apps/api/src/users/users.service.ts';

export function prismaTree(repo) {
  fs.cpSync(path.join(FIXTURES, 'ts-nest'), repo, { recursive: true });
}

export const TYPEORM_FILES = Object.freeze({
  'package.json': '{\n  "name": "shop-api",\n  "private": true,\n  "dependencies": { "@nestjs/common": "^10.0.0", "@nestjs/core": "^10.0.0", "@nestjs/typeorm": "^10.0.0", "typeorm": "^0.3.20" }\n}\n',
  'tsconfig.json': '{ "compilerOptions": { "baseUrl": "./" } }\n',
  'src/main.ts': `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(3000);
}

void bootstrap();
`,
  'src/app.module.ts': `import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArticleModule } from './article/article.module';

@Module({ imports: [TypeOrmModule.forRoot({ type: 'postgres' }), ArticleModule] })
export class AppModule {}
`,
  'src/article/article.module.ts': `import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArticleController } from './article.controller';
import { ArticleEntity } from './article.entity';
import { ArticleService } from './article.service';

@Module({ imports: [TypeOrmModule.forFeature([ArticleEntity])], controllers: [ArticleController], providers: [ArticleService] })
export class ArticleModule {}
`,
  'src/article/article.entity.ts': `import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AuthorEntity } from './author.entity';

@Entity('article')
export class ArticleEntity {
  @PrimaryGeneratedColumn() id: number;
  @Column() title: string;
  @Column() body: string;
  @ManyToOne(() => AuthorEntity) author: AuthorEntity;
}
`,
  'src/article/author.entity.ts': `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('author')
export class AuthorEntity {
  @PrimaryGeneratedColumn() id: number;
  @Column() name: string;
}
`,
  'src/article/article.service.ts': `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArticleEntity } from './article.entity';

@Injectable()
export class ArticleService {
  public constructor(@InjectRepository(ArticleEntity) private readonly articles: Repository<ArticleEntity>) {}

  public list() {
    return this.articles.find({ select: { id: true, title: true } });
  }

  public byTitle(title: string) {
    return this.articles.createQueryBuilder('a').where('a.title = :title', { title }).getMany();
  }

  public create(title: string, body: string) {
    return this.articles.insert({ title, body });
  }
}
`,
  'src/article/article.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ArticleService } from './article.service';

@Controller('articles')
export class ArticleController {
  public constructor(private readonly service: ArticleService) {}

  @Get()
  public list() {
    return this.service.list();
  }

  @Get('search')
  public search(@Query('title') title: string) {
    return this.service.byTitle(title);
  }

  @Post()
  public create(@Body() body: { title: string; body: string }) {
    return this.service.create(body.title, body.body);
  }
}
`,
});

export const TYPEORM_ENTITY = 'src/article/article.entity.ts';
export const TYPEORM_SERVICE = 'src/article/article.service.ts';

export function typeormTree(repo) {
  for (const [rel, body] of Object.entries(TYPEORM_FILES)) write(repo, rel, body);
}

export const SHARED_API = 'libs/common/src/ping.ts';

export const DISPATCH_FILES = Object.freeze({
  'apps/api/src/notify/notifier.ts': `export abstract class Notifier {
  public abstract send(to: string): Promise<void>;
}
`,
  'apps/api/src/notify/email.notifier.ts': `import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Notifier } from './notifier';

@Injectable()
export class EmailNotifier extends Notifier {
  public constructor(private readonly prisma: PrismaService) {
    super();
  }

  public async send(to: string) {
    await this.prisma.post.create({ data: { title: to, authorId: to } });
  }
}
`,
  'apps/api/src/notify/sms.notifier.ts': `import { Injectable } from '@nestjs/common';
import { Notifier } from './notifier';

@Injectable()
export class SmsNotifier extends Notifier {
  public async send(to: string) {
    void to;
  }
}
`,
  'apps/api/src/users/users.module.ts': `import { Module } from '@nestjs/common';
import { EmailNotifier } from '../notify/email.notifier';
import { Notifier } from '../notify/notifier';
import { PrismaService } from '../prisma/prisma.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [PrismaService, UsersService, { provide: Notifier, useClass: EmailNotifier }]
})
export class UsersModule {}
`,
  'apps/api/src/users/users.service.ts': `import { Injectable } from '@nestjs/common';
import { normalizeEmail } from '@fixture/common/email';
import { pingHealth } from '@fixture/common/ping';
import { Notifier } from '../notify/notifier';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  public constructor(private readonly prisma: PrismaService, private readonly notifier: Notifier) {}

  public list() {
    return this.prisma.user.findMany({ select: { id: true, email: true } });
  }

  public async one(id: string) {
    await pingHealth();
    return this.prisma.user.findUnique({ where: { id }, select: { name: true } });
  }

  public async create(email: string, name: string) {
    const user = await this.prisma.user.create({ data: { email: normalizeEmail(email), name } });
    await this.notifier.send(email);
    return user;
  }
}
`,
  // A function of the shared lib that sends a request: the web lane makes it a
  // node as the frontend's, the TypeScript lane as one the API imports.
  [SHARED_API]: `export async function pingHealth() {
  const res = await fetch('/health');
  return res.ok;
}
`,
});

export function dispatchTree(repo) {
  prismaTree(repo);
  for (const [rel, body] of Object.entries(DISPATCH_FILES)) write(repo, rel, body);
}
