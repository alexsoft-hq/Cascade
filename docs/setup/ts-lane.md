# TypeScript lane (NestJS + Prisma) setup

**English** | [한국어](../ko/setup/ts-lane.md)

The TypeScript lane reads a **NestJS backend**: the routes its controllers
serve, the calls between its methods, and every **Prisma** call as a SQL
statement against the tables and columns `schema.prisma` declares. It is the
same round trip the Java lane gives a Spring application
(`endpoint → handler → service → statement → table → column`), so a frontend
call the web lane reads meets a Nest route exactly as it meets a Spring one.

What it does not know, it does not state as known. A route whose address the
source holds in a variable is not made; a route whose address holds only if an
exclude this lane cannot read does not name it is made and graded HEURISTIC; a
Prisma argument this lane cannot read is named on the statement. Every such gap
is a diagnostic that says why.

## What it needs

**Node, and nothing else.** The lane parses with the parser the web lane
vendors (`adapters/web/vendor/babel-parser.cjs`), so there is no TypeScript
compiler, no `npm install` and no build. It reads source; it never runs it.

## Running it

```
cascade init --root .        # finds the NestJS application and writes it to the profile
cascade analyze --root .     # reads it with no flag
```

`cascade init` finds an application by its bootstrap: a `.ts` file under a
package that depends on `@nestjs/core` and calls `NestFactory.create` (test
directories are left out). The directory of that file goes to
`profile.tsBackend.app`, with `nestjs` in `frameworkPacks`. When it finds two,
it writes none and names both: a pack reads **one application**, because an
endpoint is keyed by its verb and path alone and two applications' routes would
fold into one. Analyze each as its own project.

`--ts-src <dir>` names the application for one run instead, and `--no-ts`
switches the lane off. A frontend root that holds the backend too (an Nx
workspace like ghostfolio, with one `package.json` for both) is read by the web
lane **without** the backend's files: they are this lane's.

The lane line says what came of it:

```
TypeScript lane: 310 file(s), 118 route(s) from 34 registered controller(s), 1368 call(s) linked, 1001 into packages, 1777 on a receiver not typed here; Prisma: 149 statement(s) from 149 client call(s)
```

## Routes

A controller class is not a route by existing. It serves only when a module the
application loads lists it: from the module the bootstrap hands
`NestFactory.create`, through each module's `imports` (a module class,
`X.forRoot(...)`, `forwardRef(() => X)`). A controller no module registers is
listed on `meta.laneStats.ts.unregisteredControllers` and serves nothing.

A class is read the way Nest reads it. A decorator counts by the name its
package gives it: `import { Controller as Ctl } from '@nestjs/common'` is
`Controller`, and so is `common.Controller` through `import * as common`; a
decorator of the project's own named `Controller` is not Nest's. A controller
serves the route methods it inherits from classes of the project as well as its
own, as Nest's scan of the prototype chain does, and each such route is handled
by the method that declares it.

The application is the one the bootstrap then `listen`s on (an application made
only to read configuration and closed again is not it). Its settings are the
calls made on it, in the bootstrap and in every function of the project it is
handed to (`configure(app)` is read under the name its parameter gives the
application). Its address rules are applied the way Nest applies them:

| source | route |
|---|---|
| `app.setGlobalPrefix('api')` | `/api/...` before every route |
| `exclude: ['health']` in its options | `/health` served without the prefix |
| `exclude: [{ path: 'health', method: RequestMethod.GET }]` | only `GET /health` served without it |
| `exclude: ['docs{/*rest}', 'users/:id']` | matched as Nest 11 matches them: `:name` one segment, `*name` the rest, `{...}` optional, no case |
| `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })` | `/api/v1/...` |
| `@Controller({ path: 'users', version: ['1', '2'] })` | one route under each version |
| `@Version('2')` on a method | that route under v2, whatever the controller says |
| `@Version(VERSION_NEUTRAL)` | no version segment |
| `RouterModule.register([{ path: 'admin', module: AdminModule }])` | `/admin` before the routes of the controllers AdminModule declares |
| `@Get(':id')` | `{id}`, as every other lane writes a path variable |

**What is not known makes no route.** A setting is known only when it is sure:
one call that may not run (under a condition, in a loop, in a callback), two
that set different values, a call of that name on something that is not the
application, or the application handed to code this engine does not read, all
leave it unknown. Each of these is a diagnostic on the run:

| diagnostic | what the source did | what happens |
|---|---|---|
| `TS_APP_NOT_FOUND` | no `NestFactory.create`, or several and not one of them listening | no route |
| `TS_PREFIX_UNREAD` | a global prefix read from configuration (`configService.get('app.apiPrefix')`), set under a condition, set twice to different values, or the application handed to code not read | no route, until `tsBackend.globalPrefix` declares the deployed one |
| `TS_VERSIONING_UNREAD` | versioning options not known, for the same reasons | no route |
| `TS_ROUTER_MODULE_UNREAD` | a `RouterModule.register` argument not written as literals | no route |
| `TS_ROUTE_PATH_UNREAD`, `TS_ROUTE_VERSION_UNREAD` | one route's path or version in a variable, or in options a spread may change (`@Controller({ ...base })`) | that route is not made |
| `TS_MODULE_UNREAD` | module options not written as an object this engine can read whole (a variable, a spread that may replace a list) | nothing that module imports or registers is served here |
| `TS_MODULE_IMPORT_UNREAD` | a module list holding a variable (`isDocumentDb ? A : B`) or a spread | the modules it may hold are not walked |
| `TS_ROUTES_WITHOUT_CONTROLLER` | a class whose methods declare routes and that no Nest controller decorator marks (a decorator of the project's own that wraps `Controller`) | its routes are not served here |
| `TS_PREFIX_EXCLUDE_UNREAD` | an exclude entry this engine cannot read: a template, a spread of a list, a pattern in another syntax | every route under the prefix is made at the prefixed address and graded HEURISTIC, since the entry may name it; `tsBackend.globalPrefixExclude` declares the list and makes them EXACT |
| `TS_PREFIX_DECLARED` | the profile's `tsBackend.globalPrefix` differs from the literal the bootstrap sets | the profile's is used |

The one address that is made while something about it is unknown is the one an
unread exclude could change: the route exists, and its handler is sure, so it is
made at the address it has unless that entry names it, and the HANDLES edge is
graded HEURISTIC with the reason on its evidence. In the default `conservative`
mode a walk does not cross it; `heuristic` does.

A module imported from a package (`ConfigModule.forRoot()`, `JwtModule`) is the
package's, and is not a gap: its code is not read, and neither are the routes it
may serve.

## Calls

A `MAY_CALL` edge, graded SOUND_SET, joins a method to what it calls, when the
receiver is one this lane can type:

| rule (on `evidence.rule`) | call |
|---|---|
| `ts-this-method` | `this.m()`: a method of the same class, or of a class it extends |
| `ts-injected-field` | `this.svc.m()`: a method of the class a constructor-injected field is typed with |
| `ts-function` | `f()`: a function the file declares or imports by name |
| `ts-static-method` | `Cls.m()`: a static method of a class the file names |

SOUND_SET because a subclass may override the method, and the provider bound to
a field's type may be another class. A call into a package is counted apart
from one on a receiver this lane does not type (a local variable, a parameter, a
chain through a field): the first is no gap in the project's links, the second
is. A decorator is not a call its method makes; it runs once, when the class is
defined.

## Prisma

A field is a Prisma client when it is typed with `PrismaClient` from
`@prisma/client`, with a project class that extends it (the usual
`PrismaService`), or with the `PrismaService` of `nestjs-prisma`. The last is a
library's type, so its links are graded SOUND_SET and name the library on their
evidence, as the rule pack says (`src/core/rules/packs/prisma.json`).

**Each call site is a statement of its own**:
`statement:prisma:<file>#<Class.method>/<n>`, the n-th client call of that
method. Two calls on one model with different `select`s are two statements, so
what one reads never reaches the callers of the other. The model is the one the
delegate names (`this.prisma.userProfile` is `UserProfile`), the table its
`@@map` or its name, in the schema its `@@schema` names (multi-schema Prisma),
and each column its `@map` or its name.

An interactive transaction, `this.prisma.$transaction(async (tx) => { ... })`,
hands its callback a client: a call through `tx` inside it is read like one
through `this.prisma`, counted in the same method, and says
`transaction: "$transaction"` on its evidence. The array form,
`$transaction([this.prisma.a.update(...), ...])`, is read call by call.

What a call reads and writes comes from its argument, read by the
`prisma.operation` rule: `select`, `where`, `orderBy`, `data` and the rest each
have a role, and a filter's `AND`, `OR` and `NOT` are read into. A key naming a
compound unique or id reads the fields the schema joins under that name
(`@@unique([a, b], name: "pair")`, or `a_b` with no name); a key is never split
on `_` to guess them. What the rule cannot follow travels on the statement:

- `relation-not-followed`: an `include`, or a relation field in a `select`,
  reaches another table this statement does not name.
- `argument-not-read`: a key the rule does not know (a relation's `_count`
  inside an `include`, for one).
- `columnsRuntimeOnly`: an argument held in a variable, spread, or written with
  a computed key, so which columns it touches is only known when it runs.
- A `select` value that is neither `true` nor `false` (`email: showEmail`) MAY
  read its column: that READS edge is graded SOUND_SET, and the statement names
  the key that made it uncertain.

With no `select`, and an argument read whole, a read reads every scalar column
of the model.

A call that names a model and an operation of the schema on a receiver this
lane does not know to be a client (a client held in a local variable, one
`$extends` made) makes no statement, and is said: `TS_PRISMA_CALL_UNREAD` counts
them and names a few.

`schema.prisma` is found at `prisma/schema.prisma` at or above the application
root, where Prisma looks first; a package's own `"prisma": { "schema": ... }`
or the profile's `tsBackend.prismaSchema` names another. It is read again on
every run, and its path, sha256 and provider are on `meta.laneStats.ts`. A table
no DDL declared is added as a stub with `declaredBy: "prisma"`; a table a
migration's DDL declared is the same node.

## The profile

```json
"frameworkPacks": ["nestjs"],
"tsBackend": { "app": "../apps/api/src", "prismaSchema": null, "globalPrefix": null, "globalPrefixExclude": null }
```

- `tsBackend.app` — the application root, manifest-relative. Read when
  `frameworkPacks` declares `nestjs`.
- `tsBackend.prismaSchema` — the schema, when it is not where Prisma looks first.
- `tsBackend.globalPrefix` — the prefix the application is deployed under, for a
  bootstrap that reads it from configuration. `""` is a real answer: no prefix.
- `tsBackend.globalPrefixExclude` — the route patterns that prefix excludes, in
  Nest's own syntax (`["health", "docs{/*rest}"]`), for a bootstrap that builds
  the list at run time. Declared, it replaces the bootstrap's list.

A project that sets none of these keeps the profile digest it had before they
existed, so upgrading does not look to the calibration gate like a change of
target. Reading another application does: the root read is part of the pin.

`cascade init` also writes the datasource `provider` of `schema.prisma` to
`sqlDialects.main` when it is a dialect a profile may name (`postgresql`,
`mysql`): a project on Prisma says which database it runs on, and its migrations
are written in that database's SQL.

## What is cached, and what is not

Each file's facts are cached like the web lane's, by the bytes of the file: a
second run re-reads only what changed. What crosses files (which file an import
names, which class a field is typed with, which controllers are registered) is
decided again on every run, over the whole application, together with the
tsconfig `paths` and `schema.prisma`, so a cached file never holds a conclusion
about another.

`cascade impact` on uncommitted changes (the working-tree overlay) does not
re-read TypeScript yet: on a pack with this lane it declines with
`ts-not-overlaid`, and `--mode base-only` still answers from the pack.

## Not in this version

- Guards, interceptors and pipes as edges.
- Following a Prisma relation (`include`) into the table it reaches, a
  relation's `_count`, a client made by `$extends`, and raw SQL (`$queryRaw`).
- A call through an interface or an abstract class to the classes that
  implement it.
- TypeORM, Mongoose, Next.js route handlers, Express without Nest.
- Files outside the application root that a tsconfig path reaches (a shared
  library in a monorepo): a name imported from one is counted as a package's.
