# TypeScript lane (NestJS, Prisma, TypeORM) setup

**English** | [한국어](../ko/setup/ts-lane.md)

The TypeScript lane reads a **NestJS backend**: the routes its controllers
serve, the calls between its methods, and every **Prisma** or **TypeORM** call
as a SQL statement against the tables and columns `schema.prisma` or the
TypeORM entities declare. It is the same round trip the Java lane gives a
Spring application (`endpoint → handler → service → statement → table →
column`), so a frontend call the web lane reads meets a Nest route exactly as
it meets a Spring one.

What it does not know, it does not state as known. A route whose address the
source holds in a variable is not made; a route whose address holds only if an
exclude this lane cannot read does not name it is made and graded HEURISTIC; a
Prisma or TypeORM argument this lane cannot read is named on the statement.
Every such gap is said: as a diagnostic on the run, or on the edge's evidence.

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
lane **without** the backend's files: they are this lane's. The lane reads the
application's root, and the files its imports reach elsewhere in the analyzed
root (see "Shared libraries", below).

The lane line says what came of it:

```
TypeScript lane: 310 file(s), 118 route(s) from 34 registered controller(s), 1368 call(s) linked, 1001 into packages, 1777 on a receiver not typed here; Prisma: 149 statement(s) from 149 client call(s)
```

The line says more when the run found more: how many files were read outside
the application because its imports reached them, how many linked calls went
into those files, and how many went through a type classes of the project
extend or implement (with how many the modules' bindings settled, and how many
are graded HEURISTIC). A TypeORM application adds its statements, entities and
naming strategy after the Prisma part. When `schema.prisma` was read, a second
`TypeScript lane: schema.prisma:` line says what it declared: its tables and
columns, or the SQL catalog's it corroborated with the disagreements, the joins
its relations are, and how many statements follow a relation or go through a
client `$extends` made.

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

Prefix exclusions also read bounded expressions built from local or imported
literal constants: templates, string `substring` with literal integer arguments,
ordered array spreads, and a one-parameter pure `map` over primitive values.
The engine reads syntax without executing the application. An array needs a
complete reference census in the loaded project; mutations, unsafe escapes,
ambiguous imports and unsupported callbacks keep the exclusion unread. Dynamic
code such as `eval` or `Function` also prevents a complete census. When this
boundary applies, a verified list can be declared as
`tsBackend.globalPrefixExclude`. Runtime configuration still needs the deployed
value declared in the profile.

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
| `TS_CONTROLLER_UNREAD` | a module's `controllers` names a class this engine does not read (a package's, or one in a file the run left out), or holds something that is not a class name | that controller's routes are not served here |
| `TS_ROUTES_WITHOUT_CONTROLLER` | a class whose methods declare routes and that no Nest controller decorator marks (a decorator of the project's own that wraps `Controller`) | its routes are not served here |
| `TS_PREFIX_EXCLUDE_UNREAD` | an exclude entry this engine cannot settle: a runtime value, an unsafe array use, an unsupported expression or pattern | every route under the prefix is made at the prefixed address and graded HEURISTIC, since the entry may name it; `tsBackend.globalPrefixExclude` declares the list and makes them EXACT |
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
| `ts-this-dispatch` | `this.m()` where classes of the project extend this one: the nearest declaration of `m` for this class and for each of them |
| `ts-field-dispatch` | `this.svc.m()` where the field's type is an abstract class, an interface, or a class the project extends: the nearest declaration of `m` for each class the field may hold |
| `ts-function` | `f()`: a function the file declares or imports by name |
| `ts-static-method` | `Cls.m()`: a static method of a class the file names |

SOUND_SET because a subclass may override the method, and the provider bound to
a field's type may be another class. Where classes of the project do extend or
implement the type, the call is linked to each of them (below). A call into a
package is counted apart
from one on a receiver this lane does not type (a local variable, a parameter, a
chain through a field): the first is no gap in the project's links, the second
is. A decorator is not a call its method makes; it runs once, when the class is
defined.

Two more calls are guesses. A function whose name the file writes again
(`let f = ...; f = other`) may be another function when the call runs: the edge
is HEURISTIC and `evidence.incomplete` says so. And in a package that may be
published, even a `this.m()` with one target is `ts-this-dispatch`, HEURISTIC,
because a class outside the tree may extend it.

### A call through an abstract class or an interface

`this.users.findById(id)` on a field typed with an abstract class runs the
`findById` of whatever object Nest injected, never the abstract declaration,
which has no body. Through an interface there is no body at all. And `this.m()`
in a base class runs a subclass's override whenever `this` is one. So a call
through a type that classes of the project extend or implement reaches, for the
type and for each such class (directly or through another class or interface),
the nearest declaration of the method. An abstract method is never a target.
`evidence.dispatch` names the type and how many methods the set holds
(`candidates`). A type no class of the project extends or implements is linked
as before only when nothing this engine could not read may add a member to its
set (below).

Three more things decide what `this.m()` runs:

- A property that holds a function (`handle = () => {...}`) is set on the
  object when it is made, so it runs over any method of that name in the chain.
  It is a symbol of its own (`property: true`), and the nearest such property
  wins over every method.
- A member written where the method would be leaves no link to the method: a
  property whose value is not a function, `this.m = ...` anywhere in the class,
  `X.prototype.m = ...`, `Object.assign(this, ...)`, a computed member. The set
  is HEURISTIC and says which write. Where no other class of the set runs the
  method, the call has no edge at all, and is counted with the calls on a
  receiver not typed here; no diagnostic names it. `this.m.bind(this)` of itself
  changes nothing.
- A mixin is followed. `class Loud extends Shout(Base)`, where the project's
  `function Shout(B)` returns a class that extends `B`, has that class and then
  `Base` in its chain, so a method the mixin's class declares overrides `Base`'s.
  A class whose `extends` this engine cannot take for a class is an open end: a
  call it cannot follow, an expression (`extends (on ? A : B)`), a value the
  file makes (`const B = makeBase()`), or a name from a file the run did not
  read. If it, or a class below it, declares the method, it may be one more
  member of a set for that method, whichever type the set is for (the match is
  by method name), so the set is HEURISTIC and names the class; a class of the
  set that inherits the method from an open end makes the set short too.
  `extends ns.Base` through `import * as ns`, a class a module `const` holds,
  and a class declared inside a function (recorded as `<Name>$<line>`) are
  classes. A package's class, or a global such as `Error`, is not an open end.

The set rests on the project's own `extends` and `implements` clauses.
TypeScript also accepts an object of the right shape that names neither, so the
set is complete only when something settles it:

- For a field, what the NestJS modules bind to its type (rule
  `nestjs.providers`, kind `ts.provider-binding`). A class listed in
  `providers` binds itself, and `{ provide: T, useClass: C }` binds `T` to `C`.
  The modules read first are the ones the application loads, from its root
  module through each one's imports: a module class, `forwardRef(() => X)`, a
  constant of the file that holds one module or another
  (`const Db = flag ? A : B`), `X.forRoot()`, read from the object the static
  method returns, the `module:` class of a dynamic module, and a list spread
  under a condition and written out (`...(on ? [A] : [])`), read as what it
  holds; a spread of a name is still a gap. When that walk is read whole and
  Nest makes the class that holds the field (a provider or a registered
  controller), those modules settle it, and a gap elsewhere in the tree does
  not open the set. Otherwise every module of the tree is read, every static
  method's module included, and its bindings settle the set only when the whole
  tree is read too. When the bindings settle it, the edges go to the bound classes
  only, and `evidence.dispatch` says which modules bound it (`bound`), which
  reading settled it (`boundBy`), and how many candidates it narrowed from
  (`narrowedFrom`). A set they do not settle keeps every class they were read
  to bind, beside the hierarchy.
- A field typed with a class no class extends is settled the same way. Bound to
  itself, or bound by no module, it is linked as before, unless a providers or
  imports list of the modules that settle it is not read whole: another class
  may then be bound in its place, and the edge is HEURISTIC with that gap as the
  reason. Bound to another class
  (`{ provide: UsersService, useClass: CachedUsersService }`), the call reaches
  that class, SOUND_SET. Bound by `useFactory`, `useValue` or `useExisting`, it
  is HEURISTIC, with the reason.
- For `this.m()`, `this` is always an instance of a class of the tree, unless
  the type's package may be published.

The edge is SOUND_SET when the set is complete. When it may be short, the edge
is HEURISTIC, with the reason in `evidence.dispatch.incomplete`:

- a binding made by `useFactory`, `useValue` or `useExisting`, which is not
  read;
- a provider, a providers list or a module this engine cannot read, in the
  modules the application loads (anywhere in the tree when Nest does not make
  the holder from them): an import it cannot name (a module an ordinary
  function builds), a class loaded as a module that carries a decorator this
  engine does not read (a project's own wrapper of `@Module`), static methods or
  not, or that carries none and whose static methods return no module, a
  dynamic module whose `module:` class this engine cannot name, a static method
  whose return is not read, or a root module the bootstrap does not name;
- a package's module handed the type anywhere in the tree, which may bind it.
  What a package module's async options only read (`imports`, `inject`,
  `useClass`, `useExisting`, `useFactory`) is not handed to it;
- no module binds the type;
- a constructor parameter decorated `@Inject(token)` with a token other than
  its type, which the token fills, or with a decorator the `nestjs` pack does
  not name (a project's own that wraps `@Inject`), which may. `@Optional`,
  `@Self`, `@SkipSelf` and `@Host` change nothing, and neither does
  `@Inject(T)` naming the type itself;
- a field that is not a parameter of the class's own constructor, which Nest
  does not fill;
- a class the code makes with `new`, handing it whatever it likes;
- a type declared in a package that may be published: one that is not the
  application's own package and is not marked `"private": true`, so a class
  outside this tree may extend it;
- an open end: a class whose `extends` this engine cannot take for a class,
  that declares the method (see the mixins above);
- a member written over the method (see above).

`TS_DISPATCH_INCOMPLETE` counts the HEURISTIC calls and names the commonest
reasons. `TS_BINDING_NOT_READ` names each type bound in a way this engine does
not read.

## Shared libraries

An application in a monorepo imports code outside its own root: a shared
library, reached through a tsconfig `paths` alias, its `baseUrl`, or a relative
path. The lane reads the application's files and then, round by round, every
file their imports and re-exports reach inside the analyzed root, until none is
new. An import is resolved exactly as the bridge resolves it, so the file read
for an import is the file the bridge takes it to mean. It never reads
`node_modules`, a file outside the analyzed root, or a file whose bytes are
outside it: a link (`libs/shared -> ../../elsewhere`) that leads out of the
root is not read, whatever its path says, and is said (`TS_FILES_LEFT_OUT`). A
name imported from a library the run reads is linked like the application's
own, not counted as a package's; one imported from a file the run left out is
not a package's either: it means nothing here.

Test support is left out unless a file the run reads imports it, in the
application's own root and in a shared library alike: a spec, a mock, a stub, a
story, and every file under a directory such as `__mocks__`, `testing` or
`e2e`. The application runs what it imports, so a `testing` feature module the
app module imports is read, and its controller served. A barrel's
`export * from './x.mock'` alone does not make a mock the application's. Which
names mark a file as test support is the `typescript.test-support` rule
(`src/core/rules/packs/typescript.json`, kind `ts.test-support`); the worker
keeps no list of its own. A mock read as the application's is one more class a
call through an abstract type may reach, and a library's barrel may re-export
its mocks. What the run leaves out is said: `TS_FILES_LEFT_OUT` counts the test
support no read file imports and the files whose bytes are outside the root,
and names the read files that import or re-export one of them. On ghostfolio
492 files are read, and 58 test support files are left out and said.

The files read outside the application are listed on
`meta.laneStats.ts.reached`, and the lane line counts them. They are analysis
inputs like any other: one that differs from HEAD makes the pack dirty.

A file the web lane reads too (a frontend and a backend sharing a library)
keeps one shard per lane, so neither lane re-reads it for the other. A function
both lanes make is one node, since it is one piece of code, and its `lanes`
names both. `TS_SYMBOL_SHARED_WITH_WEB` says which: the web lane addresses the
requests such a function sends by the frontend's rules, so a walk from a
backend route that passes through it takes those requests at the address the
frontend would use.

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
on `_` to guess them. A relation the call names is followed into the model it
reaches (see "Relations", below). What the rule cannot follow travels on the
statement:

- `relation-not-followed`: a relation the schema does not let this lane place,
  with why.
- `argument-not-read`: a key the rule does not know, with the path it was found
  under.
- `columnsRuntimeOnly`: an argument held in a variable, spread, or written with
  a computed key, so which columns it touches is only known when it runs. The
  statement names the key.
- A `select` value that is neither `true` nor `false` (`email: showEmail`) MAY
  read its column: that READS edge is graded SOUND_SET, and the statement names
  the key that made it uncertain.

With no `select`, and an argument read whole, a read reads every scalar column
of the model.

A call that names a model and an operation of the schema on a receiver this
lane does not know to be a client (a client handed to a function as a
parameter, a local assigned again) makes no statement, and is said:
`TS_PRISMA_CALL_UNREAD` counts them and names a few, with why when the lane
knows it.

`schema.prisma` is found at `prisma/schema.prisma` at or above the application
root, where Prisma looks first; a package's own `"prisma": { "schema": ... }`
or the profile's `tsBackend.prismaSchema` names another. It is read again on
every run, and its path, sha256 and provider are on `meta.laneStats.ts`.

### schema.prisma is the catalog

Every model of `schema.prisma` is a table and every scalar field a column,
whether a call names it or not; a `view` block is read the same way. The nodes
have the shape the SQL lane gives a DDL's: a column carries its type as the
schema writes it (`String`, `String[]`, an enum's name, and `nativeType` for a
`@db.X` attribute), `nullable` from `?`, and `pk` from `@id` or `@@id`, and
every node says `declaredBy: "prisma"`. A relation is a `JOINS` edge between
the two tables, on the columns its `fields` and `references` name, graded EXACT
because the schema states it. An implicit many-to-many (two lists, no `fields`
on either side) is the table Prisma makes for it: `_` and the relation's name,
or with none the two model names in alphabetical order joined by `To`
(`_OrderToTag`). Its columns `A` and `B` point at the ids of the first and the
second model, and it is joined to both. Whether `(A, B)` is a primary key or a
unique index depends on the Prisma version, so neither column says it is in a
key. Whether a list column allows NULL is not in the schema, so a list's
`nullable` is null. With no DDL, the pack's `meta.catalog` is
`{source: "prisma", path, sha256}`, and the catalog axis ships with
`schema.prisma` in `axes.catalog.sources`. Where the names came from is not a
limit on an answer, so it is not a note.

When the run also reads a SQL catalog (migrations named as the DDL, or a
snapshot), a table that catalog declares is not declared twice. Its nodes stay
the SQL lane's, and the schema corroborates them (`prismaModel`,
`prismaField`). What the two state differently is a disagreement: a table or a
column only one of them declares (`table-not-in-catalog`,
`column-not-in-catalog`, `table-not-in-schema`, `column-not-in-schema`), a
primary key (`pk-differs`), or a nullability (`nullable-differs`). Neither is
taken to be the newer, since a migration may lag the schema, or the schema the
database. So a column whose key or nullability the two state differently keeps
both on its node, each under its source:
`declarationsDiffer: { pk: { catalog, prisma }, nullable: { catalog, prisma } }`.
The node's own `pk` is the SQL catalog's, as the node is. Every disagreement is
counted on `meta.laneStats.ts.prisma.catalog`, said in one
`PRISMA_CATALOG_DISAGREES` diagnostic, and noted on the catalog axis. A column
only the schema declares is added as the schema's, since the client sends it;
one only the SQL catalog declares is only said, since no Prisma call can name
it. Types are not compared: Prisma's `String` and the database's `TEXT` are two
vocabularies, not a disagreement.

### Relations

A relation a call names is followed into the model it reaches: in `include` or
`select` (`true` is its whole row, an object is a find of its own there), in a
filter (`some`, `every`, `none`, `is`, `isNot`, or a to-one filter written
straight), in an `orderBy`, as a `_count`, and as a nested write (`create`,
`createMany`, `connect`, `connectOrCreate`, `set`, `disconnect`, `update`,
`updateMany`, `upsert`, `delete`, `deleteMany`). The statement then reads,
writes or deletes the related table and its columns, and reads the columns the
join matches on, on both sides. A write that sets or clears the link writes the
columns that hold it, on whichever side they sit, or inserts or deletes rows of
the implicit table. Every such edge names the relation in `evidence.relation`.
The names are pack data (`prisma.json`: `relationFilters`,
`relationNullFilters`, `relationCount`, `nestedWrites`).

An update whose `data` sets no field of its own model, only relation writes,
reads its row and writes none of it, as Prisma 6.19 sends it: its own table's
`EXECUTES` is a read. Data not written out (a variable) may set a field, so the
write is SOUND_SET.

A relation is part of the call's own statement, not a statement of its own.
Which SQL Prisma sends for it depends on things the call site does not settle:
one query with a join under `relationLoadStrategy: "join"`, one more query per
relation level under `"query"` (the default without the relationJoins preview
feature), several statements in one transaction for a nested write. What all of
those share is the call site, and the call site is what a method implements.

One call keeps one `EXECUTES` edge per table and access (read, write, delete),
as the SQL lane does, so a call that reads a table and writes it is found by
both questions. Each takes the strongest grade any path gave that access. A
column keeps one edge per type, at the strongest grade.

A relation value only the running program knows (`include: { posts: flag }`,
`data: { account }`) is followed as one that MAY happen: its edges are
SOUND_SET, and the statement names the key in `columnsRuntimeOnly`. A relation
the schema does not let this lane place stays `relation-not-followed`, with
why: its other side is missing or not the only candidate, its `fields` and
`references` do not match, or it is an implicit many-to-many the schema does
not place: of a model with itself (which side is `A` the schema does not say),
between models without a one-field id, or across two `@@schema` blocks.

**What Prisma finds first.** Before a nested write changes related rows it
has to find, Prisma selects them, and that read is drawn too. A write finds
the rows its value names (`named`: a connect's `SELECT Tag.id ... WHERE Tag.id
= ?`), or the rows linked to the row it hangs from (`linked`: a delete's
`SELECT Post.id, Post.authorId ... WHERE Post.authorId IN (?)`). Such a lookup
reads the related table, its key and the columns the join matches on, and, when
it finds the linked rows of a many-to-many, the implicit table
(`_TagToUser`). Which write looks up which rows depends on the kind of relation
(the list side or the to-one side of a one-to-many, a one-to-one with the key
on either side, a many-to-many), and the pack says it per nested write
(`prisma.json`: `lookup`), as measured on Prisma 6.19.0 over SQLite. A row the
call is creating has nothing linked yet, so no linked lookup is drawn under a
create: the call's own, an upsert's `create`, or a nested `create` (the pack's
`argumentRows` and `nests`). On ghostfolio this adds two reads of an implicit
table: `_OrderToTag` under `tags: { set }` and `_UserWatchlist` under
`watchlist: { disconnect }`.

**What a literal changes.** A relation filtered on null (`author: null`,
`{ is: null }`, `{ isNot: null }`; the pack names the keys in
`relationNullFilters`) only checks the link. When the foreign key is in the
filtered model's own table, the statement reads that key column and nothing of
the other table, as Prisma's engine tests it. When the key is in the other
table, that table is followed as any filter is.

A nested write handed a literal that makes Prisma change nothing draws what
Prisma still sends, and no more. Each nested write lists those literals in the
pack's `idle` entries: the value (`[]` or `false`, of the whole value or of
one argument), the relations it applies on, and what it drops, every edge or
only the writes. The first entry that applies to the relation wins:

- `[]` for `create`, `connect`, `connectOrCreate`, `update`, `updateMany`,
  `upsert` and `deleteMany`, and `createMany: { data: [] }`: no edge, since
  Prisma sends nothing for them.
- `delete: false`, and `disconnect: false` on a one-to-one relation: no edge.
  On the to-one side of a one-to-many, Prisma disconnects whatever the boolean,
  so that write stays.
- `disconnect: []` on a many-to-many: no edge, since no query is built.
- `delete: []`, and `disconnect: []` on a one-to-many: no write, but Prisma
  still selects the related rows before it finds nothing to change. So the
  statement keeps the related table read, the join, the implicit table on a
  many-to-many, and the related rows' key.

`set` replaces the link: it clears it, then sets it, so `set: []` still
clears.

### A client `$extends` makes

A local that holds what `$extends` made of a client field,
`const x = this.prisma.$extends({...})`, is a client for the calls made through
it from that line on. So is a local that holds what a method of the class
returns (`const x = this.client()`), when every `return` of that method is such
a call or the client field itself. An extension this lane reads whole, written
there or made by `Prisma.defineExtension` in a local of the same method, with no
`query` component, leaves those calls as sure as the client. One it cannot
read, or one with a `query` component (which intercepts an operation and may
change what it sends), makes them HEURISTIC. The statement says which in
`prismaEvidence.extension` (the method, whether it was read, its components),
and `prismaEvidence.returnedBy` names the method a client came from. The names
are pack data (`prisma.json`: `extensions`).

A field an extension's `result` component computes is not a column. Selecting
it reads the fields its `needs` sets to true, through the computed fields it
needs in turn, whether it is declared for one model or for `$allModels`. One
with no `needs` reads nothing more. One whose `needs` this lane cannot read is
named in `columnsRuntimeOnly`. A set of computed fields is open where a spread
or a computed key may add a field to it or replace one written there, in the
model's object or in the `result` component itself. Selecting a field of an
open set claims none of its `needs`: the statement says they are known only at
run time, and a real field of that name is still read.

### Which local is a client

A local holds a client as the declaration it is, not by its name. The worker
scopes each file the way the language does (`adapters/ts/tsscope.mjs`) and says
which declaration a call's receiver is. The same name declared again in an
inner block, or an inner function's parameter that shadows a transaction's
client, is another local, and a call on it is not a client call. A local
assigned again anywhere in its scope (`x = other`, `x++`, a `for...of` target)
may hold anything by the time of a call, so it holds a client nowhere: its
calls are not read, and `TS_PRISMA_CALL_UNREAD` lists them with that reason.

## TypeORM

A NestJS application on TypeORM is read the way one on Prisma is: its entities
are the catalog, and each call that sends SQL is a statement. What the lane
knows about TypeORM is the `typeorm` rule pack
(`src/core/rules/packs/typeorm.json`), read through four kinds
(`typeorm.entity`, `typeorm.receiver`, `typeorm.operation`,
`typeorm.query-builder`), with examples `cascade rules test` runs.

### Entities are a catalog

A class decorated `@Entity` is a table, and each property a column decorator
marks (`@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`,
`@ObjectIdColumn`, `@CreateDateColumn`, `@UpdateDateColumn`, `@VersionColumn`,
`@DeleteDateColumn`) is a column. Columns a class inherits from a class of the
project it extends are its own, as TypeORM reads the whole prototype chain. A
`@ManyToOne`, or a `@OneToOne` with `@JoinColumn`, adds the join column that
holds it; a `@ManyToMany` with `@JoinTable` adds the join table and its two
columns. Each relation that owns its join column, and each join table, is a
`JOINS` edge. Every column is in the pack, whether a call reads it or not. A
property a subclass only declares again with no TypeORM decorator
(`declare email: string`) hides none of the columns the class it extends maps.

A table only the entities declare is a stub node with `declaredBy: "typeorm"`:
the entities are what the application declares, not what the database has. A
table a DDL declared is that same node, marked `typeormCatalogMatch`. When the
run read a DDL and a table only the entities declare meets none of its tables,
`TS_TYPEORM_TABLE_MISSES_DDL` says so, with the DDL's tables of the same name
under another schema or none. A DDL usually writes a table with no schema, and
TypeORM puts the DataSource's schema before it (`public.users` against
`users`): declaring that schema as the profile's `schema.default` makes the
DDL's unqualified table and TypeORM's the same table.

A project whose entities all use table inheritance (`@TableInheritance`,
`@ChildEntity`), which this lane does not read, still gets a lane line and a
`TS_TYPEORM_MAPPING_UNREAD` that names them, rather than nothing.

### Names follow TypeORM's naming strategy, prefix and schema

A name the decorator does not write is derived the way TypeORM's metadata
builders derive it, under the naming strategy the DataSource options name in
`namingStrategy`. The options also carry an `entityPrefix`, put before every
table name, and a `schema`, given to every entity that names none. All three
are read the same way, fact by fact:

- The options are read where an application writes them:
  `TypeOrmModule.forRoot({...})`, what a `forRootAsync` `useFactory` returns,
  `createTypeOrmOptions()` of its `useClass` or `useExisting`,
  `createConnection({...})`, and `new DataSource({...})`. A
  `new DataSource(options)` inside a `dataSourceFactory` is the same options,
  not another place. A value given through a `const` of the same file is read
  as the literal it holds (`const PREFIX = 'app_'`,
  `const naming = new SnakeNamingStrategy()`); one written again is not, and
  neither is a module-level name written again anywhere in the file. A value
  imported from another file is not followed, and the reading says so.
- Options that name no strategy mean `DefaultNamingStrategy`.
  `new SnakeNamingStrategy()` from typeorm-naming-strategies is the other
  strategy the pack knows.
- When every place is read and all agree, the fact is known.
- When a place is not written out (`forRoot()` with no argument reads ormconfig
  or the environment; options in a variable, spread, or built by code this
  engine does not read; a strategy class the pack does not name), when two
  places disagree, or when no place is found, the fact is not known. The reason
  is on `meta.laneStats.ts.typeorm.naming`, and `TS_TYPEORM_NAMING_ASSUMED` says
  which names it leaves HEURISTIC.
- A derived name is EXACT only when the strategy is known. A table name, one the
  decorator writes included, is EXACT only when the prefix is known and, for an
  entity that names no schema, the schema is.
- What goes before a table name is the driver's, the options' `type`, as each
  TypeORM driver builds a table path (`tablePath` in the pack): the schema on
  PostgreSQL, CockroachDB, Oracle and SAP, the entity's own database on MySQL,
  MariaDB and Spanner, both on SQL Server. On `sqlite`, `better-sqlite3` and
  `react-native` it is a handle the driver makes for a database file an entity
  names (`attached` in the pack); this lane does not make that handle, so such a
  table is keyed by its bare name and graded HEURISTIC, with the reason on its
  edges only. `sqljs`, `capacitor`, `cordova`, `nativescript` and `expo` put
  nothing before a table name. So on MySQL
  the options' `schema: 'billing'` puts nothing before `users`, and
  `@Entity('orders', { database: 'shop' })` is `shop.orders`. The table is keyed
  that way, as the SQL lane keys one. A driver the pack does not name leaves
  the table name HEURISTIC. So does a `type` the options do not write out, for
  a table that a schema or a database could qualify, unless the profile
  declares it (`tsBackend.typeorm.type`). Where the driver leaves a name in
  doubt, the lane line says `type not known` and `TS_TYPEORM_NAMING_ASSUMED`
  gives the driver as the reason. A schema the profile
  declares goes before the name of an entity that names neither a schema nor a
  database, whatever the driver.
- TypeORM's `snakeCase` changed at 0.2.35 and again at 0.2.38. A derived name
  those versions spell differently is HEURISTIC even under a known strategy,
  since the installed version decides it. So is a derived join table name
  longer than 29 characters, which a 0.3 driver may shorten (Oracle's alias
  limit).
- A `@JoinColumn` or `@JoinTable` name held in a value rather than written as a
  literal leaves the default name HEURISTIC.

`tsBackend.typeorm` in the profile declares what the options leave to run time:
`namingStrategy` (by the name the pack gives it, `default` or `snake`),
`entityPrefix`, `schema`, and `type`, the driver by TypeORM's own name for it.
`null` is not declared, and `""` is declared none for the first three. The
values of `type` that settle a table path are the driver names the pack's
`tablePath` knows (`postgres`, `mysql`, `mssql`, `sqlite` and the rest); a
`type` the pack does not name does not stop the analysis, and the names it would
qualify stay HEURISTIC.
A declared fact is used instead of what the options say, and a declaration that
differs from what the options write is said in `TS_TYPEORM_NAMING_DECLARED`.
Every table name waits for the prefix, so an application whose options are not
in the source reaches no table in the default `conservative` mode until it
declares the block. A
strategy name the pack does not know stops the analysis with a profile error
that lists the ones it does.

### Each call site is a statement

A TypeORM call that sends SQL is a statement of its own:
`statement:typeorm:<file>#<Class.method>/<n>`, the n-th TypeORM call of that
method, numbered as Prisma calls are. A call that sends nothing (`create`,
`merge`) takes no number. The calls are the ones made on a receiver the
`typeorm.receivers` rule knows:

- a repository: a field `@InjectRepository(E)` injects, a field typed
  `Repository<E>` or `TreeRepository<E>`, a project class that extends
  `Repository<E>` or that `@EntityRepository(E)` marks, and `getRepository(E)`
  on a data source, on an entity manager, or as TypeORM 0.2's own function;
- an entity manager: a field typed `EntityManager` or injected by
  `@InjectEntityManager()`, the `manager` of a data source or a repository,
  TypeORM 0.2's `getManager()`, and the manager a `transaction` callback is
  handed. Its operations name the entity in their first argument;
- a data source: a field typed `DataSource` or `Connection`.

A local that holds a repository or a manager
(`const repo = this.ds.getRepository(User)`) is bound where it is declared, as
a Prisma client local is: the same name declared in an inner block is another
local, and a local assigned again may hold anything at the call, so its calls
are not read and `TS_TYPEORM_RECEIVER_UNREAD` says so. Two forms are read all
the same: a local declared with no value and given one once
(`let r; r = this.ds.getRepository(User)`), and a local given a field or
another local that holds one (`const r = this.users`). A local a condition
fills (`flag ? getRepository(Tag) : getRepository(Label)`) holds one of them
only the running program picks, so its calls are said, not read. A local taken
from the object by destructuring (`const { users } = this`) holds what that
field holds; one given by `||`, `??` or `&&` may hold either value, so its
calls are said too.

An operation is read by the part each argument plays (`typeorm.operations`):

- Find options by role: `where` filters (an array of wheres is an OR),
  `select` returns what it names, `order` reads, `relations` loads the
  relations it names. TypeORM 0.2's `findOne(conditions)` and `findOne(id)` are
  told apart by TypeORM's own test, and an object whose keys are all find
  options and none a property is options, so TypeORM 0.3's
  `{ select: { email: true } }` is not read as a condition.
- A find with no `select` returns every column of the entity. A find loads its
  eager relations, and theirs, as TypeORM joins them (at most eight deep, never
  twice into one entity), and the relations its options name, each whole,
  whatever its `select` names, as TypeORM's SelectQueryBuilder joins them. A
  relation the options name brings its target's eager relations too: one level
  down EXACT, past it SOUND_SET. `loadEagerRelations: false` stops the eager
  ones.
- An update or an insert writes the properties its values name. `save`, or an
  insert, of a value not written out MAY write any column: those WRITES are
  SOUND_SET, and the statement says `columnsRuntimeOnly`.
- `softDelete`, `restore`, `softRemove` and `recover` write the entity's
  `@DeleteDateColumn`.
- A select (a find, `count`, `exists`, an aggregate) on an entity with a
  `@DeleteDateColumn` reads that column, because TypeORM filters out the rows
  it marks, unless the options ask for them (`withDeleted`, role
  `with-deleted`). A `withDeleted` that is not a literal, or options not written
  out, make the read SOUND_SET. A relation or an eager join reads the target's
  delete date the same way (`typeorm-soft-delete`).
- `count`, `exists` and the aggregates (`sum`, `average`, `minimum`,
  `maximum`) join the eager relations in TypeORM 0.3 without selecting them, so
  their tables and the columns the joins match on are SOUND_SET (for a
  many-to-many, the join table's columns and the keys they reference on both
  sides), with no other column of the relation's row. 0.2 does not join them,
  and this lane does not read which version is installed, so the join is a
  candidate, not a fact.
- A write also sets the columns TypeORM sets on its own, as its query builders
  do from 0.2.24 to 0.3.28, though the call names none of them. An update
  (`update`, `increment`, `decrement`, the update `save` makes) sets the
  `@UpdateDateColumn` and adds one to the `@VersionColumn`, which reads it.
  Values that name one of these columns write it themselves: from 0.2.34
  TypeORM then adds nothing, and before 0.2.34 it still added one, so the read
  of the old version is SOUND_SET; values not written out may name it, so the
  read is SOUND_SET there too. A
  soft delete or a restore sets both beside the delete date. An insert
  (`insert`, `upsert`, the insert `save` makes) lists the create date, the
  update date and the version, unless the column's `insert` option is false.
  Which statement sets which column is pack data (`autoColumns` and
  `insertKey` on the entities rule, `sends` on each operation). A column every
  statement the call may send sets is written; one only some set is SOUND_SET,
  as `save`'s create date is, since `save` inserts only a row it does not
  find. Each such edge names `typeorm-auto-column` and why.

A `createQueryBuilder` chain is read at the call that makes it, with every step
written on it and the calls made later in the same method on the local that
holds it, found by where that local is declared. Aliases are read first, since
TypeORM builds the SQL when the query runs. Each run of the query returns what
is selected at that point, so two runs with two selections keep both. `alias.property` in a condition's text names a column of the
entity that alias stands for. A join adds its table, and a `...AndSelect` join
returns that table's row. `select` narrows what is returned; `update`,
`delete` and `insert` make it that statement; `set` and `values` write what
they name. `update`, `insert`, `softDelete` and `restore` set the date and
version columns as the operations above do; an insert whose `into` lists its
columns inserts those alone. A select or a join of an entity with a delete date
column reads it, unless `withDeleted` came before. A step written under a condition, in a loop or in
a callback MAY run, so what it reads is SOUND_SET, and a `select` there keeps
the selection it may leave in place as candidates. A step this rule cannot
place (a condition built with `Brackets`, a method the pack does not name) is
`builder-step-not-read` on the statement. A builder with no step that runs the
query where it is made says `builder-not-run-here`, and its edges are
SOUND_SET.

A builder is read whole only where every use of its local is a step whose
value is thrown away, or a chain that ends in a step that runs the query or
makes another builder. Any other use may give it steps this reading does not
see (a `select` that narrows its rows, a `where` that replaces its filter):
handed to a call or a `new`, put in an object or a list, a branch of a
condition or of `&&` or `||`, captured in a function, held in a second name by
a step that returns the builder (`const q2 = qb.where(...)`), returned. The
worker records every such use of the local. What the builder reads is then
SOUND_SET, and the statement says where it went (`builder-escapes`) and that
its columns are known only at run time; `column_impact` gives such a column's
list as a lower bound, in the statement's own words. A `let` given a step on
itself (`q = q.andWhere(...)`) stays one builder; given anything else, the
builder escapes. `clone()` and `subQuery()` make another builder: the one it
copies keeps what it reads, and the copy's steps are not read, which the
statement says (`builder-step-not-read`).

What is not read is said:

| diagnostic | what the source did |
|---|---|
| `TS_TYPEORM_CALL_UNREAD` | raw SQL (`query()`), an operation the pack does not name, or a call on no entity this engine read |
| `TS_TYPEORM_RECEIVER_UNREAD` | an operation that names an entity, on a receiver not known to be a repository or an entity manager, or on a local that holds one but may hold another value at the call: one assigned again, or one a condition fills |
| `TS_TYPEORM_MAPPING_UNREAD` | mapping this engine does not read: an embedded entity (`@Column(() => Address)`), a class `@ChildEntity`, `@ViewEntity`, `@TableInheritance` or `@Tree` marks, join options not written out, a relation whose target is not an entity this engine read |
| `TS_TYPEORM_NAMING_ASSUMED` | options this engine could not read, so the naming strategy, the prefix or the schema is not known, or the driver leaves a table name in doubt (not written out, or not one the pack names), and the names that depend on it are HEURISTIC. It says that declaring `tsBackend.typeorm` (`namingStrategy`, `entityPrefix`, `schema`, `type`) settles it |
| `TS_TYPEORM_NAMING_DECLARED` | the profile's `tsBackend.typeorm` declares a fact other than the one the options write; the profile's is used |
| `TS_TYPEORM_TABLE_MISSES_DDL` | a DDL was read, and a table only the entities declare meets none of its tables; the DDL's tables of that name under another schema are named, with `schema.default` as the way to join them |

A relation in a `where` stays `relation-not-followed` on the statement, and a
key the entity does not have is `argument-not-read`.

The catalog axis ships when every table and column name is written in the
decorators or follows a strategy the run knows, with
`TypeORM entities (N table(s), M column(s))` in `axes.catalog.sources`. When a
name had to be derived by a rule the run could not confirm (an unknown strategy,
prefix or schema, a spelling the TypeORM versions disagree on), the catalog and
column axes are
degraded, with the reason, and a DDL beside the entities does not lift that.

## The profile

```json
"frameworkPacks": ["nestjs"],
"tsBackend": { "app": "../apps/api/src", "prismaSchema": null, "globalPrefix": null, "globalPrefixExclude": null,
               "typeorm": { "namingStrategy": null, "entityPrefix": null, "schema": null, "type": null } }
```

Every key a profile can hold, with an example of each, is listed in
[concepts.md](../concepts.md#9-the-profile-key-by-key).

- `tsBackend.app`: the application root, manifest-relative. Read when
  `frameworkPacks` declares `nestjs`.
- `tsBackend.prismaSchema`: the schema, when it is not where Prisma looks first.
- `tsBackend.globalPrefix`: the prefix the application is deployed under, for a
  bootstrap that reads it from configuration. `""` is a real answer: no prefix.
- `tsBackend.globalPrefixExclude`: the route patterns that prefix excludes, in
  Nest's own syntax (`["health", "docs{/*rest}"]`), for a bootstrap that builds
  the list at run time. Declared, it replaces the bootstrap's list.
- `tsBackend.typeorm`: the TypeORM `namingStrategy`, `entityPrefix`, `schema`
  and driver `type` the DataSource runs with, for options the source does not
  write out (see *Names follow TypeORM's naming strategy, prefix and schema*).

A project that sets none of these keeps the profile digest it had before they
existed, so upgrading does not look to the calibration gate like a change of
target. The `typeorm` block came after the others, so it is left out of the
digest on its own while all four are `null`: a project that set `tsBackend`
before the block existed keeps its digest too. `type` came later still, and is
left out on its own while it is `null`, so a block set before it existed keeps
its digest as well. Reading another application does
move it:
the root read is part of the pin.

`cascade init` also writes the datasource `provider` of `schema.prisma` to
`sqlDialects.main` when it is a dialect a profile may name (`postgresql`,
`mysql`): a project on Prisma says which database it runs on, and its migrations
are written in that database's SQL.

## What is cached, and what is not

Each file's facts are cached like the web lane's, by the bytes of the file: a
second run re-reads only what changed. Which files are read is decided again on
every run: the application's, and those its imports reach elsewhere in the
analyzed root. A shard still holds one file's records, and the facts index
records the files read in its own `tsFiles` map, apart from the web lane's.
What crosses files (which file an import names, which class a field is typed
with, which controllers are registered, which classes a module binds to a type)
is decided again on every run, over the whole application, together with the
tsconfig `paths`, `schema.prisma` and the `package.json` files that say whether
a type's package may be published, so a cached file never holds a conclusion
about another.

## Uncommitted edits (the working-tree overlay)

`cascade impact` on uncommitted changes, and the MCP `changed_impact` tool, lay
the working-tree overlay over a pack with this lane as they do over a Java one.
The overlay walks the lane the way `analyze` does, over the fact cache, and
writes nothing to it:

- A file whose bytes still key its shard is read from the shard. An edited file
  is read again by the worker (`parsedTsFiles`).
- Which files are read is decided again: the files under the application's
  root, and every file their imports reach now, with test support left out as
  `analyze` leaves it out. A file an edit starts to import, test support
  included, is read for the first time; one no import reaches any more is left
  out (`droppedTsFiles`), as the next `analyze` would leave it out.
- The tsconfig chain, `schema.prisma` and the `package.json` files are read
  again whole, as every run reads them. The ones that changed are listed in
  `tsConfigFiles`.
- The bridge runs over the whole stream with the options `analyze` builds
  (`src/cli/ts_inputs.mjs`), so what crosses files is decided again: which class
  a module binds to an abstract type, which field is a Prisma client, which
  repository a TypeORM call goes through, and the naming strategy, prefix and
  schema the DataSource options set.
- A statement, table or column no certified run has seen is `provisional`, and
  so is every edge that touches one: a Prisma call added to a method, a column
  an entity renames, a field `schema.prisma` adds.

Over no edit the overlay builds the analyzed graph, digest for digest, and over
an edit it builds the graph `analyze` builds from the edited tree
(`test/overlay_equivalence.test.mjs`, `test/overlay_ts.test.mjs`). A function
both this lane and the web lane read stays one node whose `lanes` names both.

What it declines, and what it says:

- A shard that no longer applies to a file git calls unchanged declines the
  overlay with `overlay-stale`: the TypeScript worker changed since the pack was
  built, the shard is gone from the cache, or the file changed where git does
  not look. Run `cascade analyze`.
- The overlay builds from the inputs the pack was built from. The profile's
  digest is compared with the one the pack records, and a profile that changed
  since declines the overlay, on a clean tree too: another `tsBackend.app`,
  prefix, exclude list or `tsBackend.typeorm` value would read as your edit.
  Run `cascade analyze`. `tsBackend.app` and `tsBackend.prismaSchema` resolve
  against the directory the run recorded (the project's `.cascade`), not the
  pack's. The overlay reads the application the pack read, as its fact index
  records it: when the run read another one than the profile names
  (`--ts-src`), `limits` says so.
- A Prisma or TypeORM statement is numbered by its place among its method's
  calls, so a call added before others renumbers them. Only an id the pack never
  had is `provisional`; the edges of a renumbered statement carry the overlay's
  session id, like every edge out of an edited file.
- A fact index an older engine wrote, with the TypeScript shards among the other
  lanes', declines with `ts-not-overlaid`. Run `cascade analyze` once to write
  it again.

## Not in this version

- Guards, interceptors and pipes as edges.
- Raw SQL: Prisma's `$queryRaw` and `$executeRaw`, TypeORM's `query()`.
- Prisma's fluent relation API (`findUnique(...).posts()`), a client held in a
  class field that `$extends` made, and an implicit many-to-many of a model with
  itself.
- TypeORM embedded entities, table inheritance (`@ChildEntity`,
  `@TableInheritance`), view and tree entities, Active Record calls
  (`User.find()` on a `BaseEntity`), custom repositories made with
  `Repository.extend({...})`, and what `save` or `remove` cascades to related
  entities.
- Mongoose, Next.js route handlers, Express without Nest.
