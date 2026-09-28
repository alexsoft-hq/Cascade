# Rule packs

**English** | [한국어](ko/rules.md)

Cascade's knowledge of frameworks is moving out of its code and into rule
packs: JSON files a person can read, that say what the engine concludes and
why, with the examples that hold each rule. The code keeps a small set of rule
**kinds**, each of which knows how one kind of question is read; the packs say
what the answers are. A framework variation that fits an existing kind is a new
rule entry, never a new branch in the engine; one that fits no kind is a new
kind, reviewed and tested as code.

`cascade rules list` names every pack and rule, `cascade rules show <id>` prints
one whole, `cascade rules test` runs every example, and `cascade rules explain
<type>` says why a Java type of the project has a role or has none
([cli.md](cli.md#cascade-rules)). The MCP tool `rules` answers from a pack:
every pack and rule with what each gave in that project (links by type and
grade, nodes by kind), or one rule whole with the links and nodes it gave
([mcp.md](mcp.md#rules)). It does not run the examples; that needs the
workers, so it stays `cascade rules test`'s job.
The viewer's **Rules** tab (`cascade view`) shows the same packs, read-only:
each rule's description, why it is there, its params and examples, and how many
links of the project's pack it gave. A link a rule gave names that rule in its
evidence (`evidence.rule`, with a sentence in `evidence.basis`), so a walked
path in Flow or Impact says which rule made that step.

## Where they are

The packs the engine carries are in `src/core/rules/packs/`. They are part of the
engine: the print the calibration gate compares covers them, so changing one is
judged as an engine change, like changing code.

| pack | what it holds | kinds |
|---|---|---|
| `sql-dialects` | which database a DDL or mapper file is written for, from a word in its path | `sql.dialect-path` |
| `mybatis-plus` | which types are MyBatis-Plus mappers and services | `java.type-role` |
| `mybatis-plus-join` | mybatis-plus-join's `MPJBaseMapper`, which a jar declares as a `BaseMapper` | `java.type-role` |
| `spring-mvc` | the calls that set a path prefix in Spring configuration code, and the profile key that declares it instead | `java.code-setting` |
| `spring-functional` | the calls a method that returns a `RouterFunction` builds its routes with | `java.route-function` |
| `openapi-generator` | how openapi-generator names the interfaces it writes, so a controller that implements one handles the document's routes | `java.contract-link` |
| `nestjs` | the NestJS decorators and bootstrap calls that make routes, and what a module's `providers` bind | `ts.route-decorator`, `ts.provider-binding` |
| `prisma` | the Prisma client types, and what each client call reads and writes | `ts.type-role`, `prisma.operation` |
| `typeorm` | TypeORM entities and naming strategies, the objects a call is made on, each repository operation and each query builder | `typeorm.entity`, `typeorm.receiver`, `typeorm.operation`, `typeorm.query-builder` |

## The format

```json
{
  "pack": "sql-dialects",
  "version": 1,
  "description": "Which database a DDL file or a mapper file is written for, read from a word in its path.",
  "rules": [
    {
      "id": "sql-dialects.path-names",
      "kind": "sql.dialect-path",
      "description": "What the rule means, in sentences.",
      "why": "Why it is there: the repository or the failure that asked for it.",
      "params": { "dialects": [ { "dialect": "mysql", "names": ["mysql"] } ] },
      "examples": [
        { "path": "db/mysql/schema.sql", "expect": "mysql" },
        { "path": "sql/mysqldump/schema.sql", "expect": null, "why": "one longer word" }
      ]
    }
  ]
}
```

- `id` is the pack's name, a dot, and a name. It is what a conclusion names as
  its source, so it does not change.
- `kind` is one of the kinds below; `params` is that kind's own shape.
- `grade`, where a kind draws edges, is the strongest grade the rule may give,
  never more than the kind allows. Where a kind only classifies, a grade is
  refused.
- `examples` are required. An example that expects nothing (`null`) is as
  important as one that expects something: it is the case the rule must not
  catch.

The shape is closed. A key the engine does not know is refused, not ignored,
and a pack with any problem is refused with every problem named by file and
rule. Two rules that give one input two different answers are a conflict and
stop the run: which one wins is never decided by the order the packs load in.

## The kinds

| kind | runs | reads | concludes | strongest grade |
|---|---|---|---|---|
| `java.type-role` | after the Java worker's records are assembled, before the lanes are chosen | the supertypes a type's own extends and implements clauses name, and their type arguments | which role a type plays (a MyBatis-Plus mapper or service) and which of its type arguments is the entity or the mapper. Only the roots of a chain are matched: a type that reaches one through a type of the project's own is found by the bridge that reads the role | EXACT |
| `java.code-setting` | in `analyze`, over the Java worker's records, once the lanes have run | the calls each Java file makes, each with its receiver as the file declares it (the Java worker's `invocations` record), and what the file imports | which call makes, in configuration code, a setting the profile declares instead (`params.setting`). It is said as `SETTING_IN_CODE` while the profile key is empty | none: it draws no edge |
| `java.route-function` | in the Java lane's bridge, beside the mapping annotations | the body of a method declared to return a `RouterFunction` (or a `Supplier` of one), as a tree of the calls it is written with (the worker's `routeFunction` record) | which call starts a builder, adds a route (its verb, path, predicate, handler and springdoc operation id), puts routes under a path, joins another router function's routes, or leaves them as they are; and whether the method is registered by an annotation (`@Bean`) or mounted by code elsewhere. Which Java method a handler names, and where a route mounted elsewhere is served, are the bridge's questions | EXACT |
| `java.contract-link` | in the OpenAPI bridge, once the documents' routes are on the graph | a class's own annotations and implements clause, what its file's imports make of each name, the methods it declares, and each OpenAPI document's operations (method, path, the path as written, operationId, tags), document by document | which method handles which declared route when the class implements an interface a code generator writes from the document at build time, which the source tree does not hold. Each link is a HANDLES edge | HEURISTIC |
| `sql.dialect-path` | while discovering the tree | a file's path | which database a DDL or mapper file is for, from a whole word of its path. The first entry of a rule whose word is in the path wins, so a rule lists first the entry it prefers | none: it only classifies |
| `ts.route-decorator` | in the TypeScript lane's bridge | a class's decorators and its methods' decorators, as the TypeScript worker recorded them | which class is a controller and which method a route, with its path and versions; which class is a module, with the modules it imports and the controllers it lists; and the names the bootstrap calls (`NestFactory.create`, `setGlobalPrefix`, `enableVersioning`, `RouterModule.register`). Whether a controller is served is the bridge's question, read from the module graph | EXACT |
| `ts.provider-binding` | in the TypeScript lane's bridge | a module's `providers` list, in its `@Module` options or in the object a static method of the module returns (`X.forRoot()`) | which class a module binds to a type (a class listed alone binds itself; `{ provide: T, useClass: C }` binds T to C), which binding it does not read (`useFactory`, `useValue`, `useExisting`), and which entry it cannot read at all (a spread, a computed key). Which modules count, and what that does to a call, is the bridge's question | none: it draws no edge |
| `ts.type-role` | in the TypeScript lane's bridge | the package and the exported name a type is imported from | which role a type plays (a Prisma client). A project class that extends it plays it too | EXACT |
| `prisma.operation` | in the TypeScript lane's bridge | a Prisma call's operation and its argument, key by key | the statement it sends (select, insert, update, upsert, delete), the fields it reads and writes, and whether it returns the whole row. A relation the call names is followed into the model it reaches: in `include` or `select`, in a relation filter, as a `_count`, and as a nested write. A relation filtered on null only checks the link, and a nested write handed a literal that changes nothing draws only what Prisma still sends (the pack's `idle` entries). `extensions` names the call that makes a client of a client (`$extends`) and the part of an extension that may change what a call sends. What it cannot follow it says: a relation into a model it was not handed, a key it does not know, an argument held in a variable | EXACT |
| `typeorm.entity` | in the TypeScript lane's bridge | the classes TypeORM's decorators mark, the columns and relations their properties declare, the classes they extend, and the DataSource options wherever the application writes them | which classes are entities, and the tables, columns and join tables they map, each named as the naming strategy, table prefix and schema in the options name it. A name a strategy derives is EXACT only when the strategy is known and every TypeORM version spells it the same; a table name, a written one included, only when the prefix is known and, for an entity that names no schema, the schema is; else HEURISTIC with why | none: it draws no edge, and its names carry their own grade |
| `typeorm.receiver` | in the TypeScript lane's bridge | the fields of a class, their types and injection decorators, the functions and members a call chain goes through, and a transaction callback's parameter | which object a TypeORM call is made on (a repository of an entity, an entity manager, a data source) and which entity it names | none: it only classifies |
| `typeorm.operation` | in the TypeScript lane's bridge | a repository or entity manager operation's name and its arguments, part by part | the statement it sends, the columns it filters by, returns, orders by and writes, whether it returns the whole row with the relations marked eager, and what an argument not written out leaves to the running program | EXACT |
| `typeorm.query-builder` | in the TypeScript lane's bridge | a `createQueryBuilder` chain and the later calls on the name that holds it, step by step, with a condition's text | the aliases the query names, the columns `alias.property` names in a condition, the tables a join adds, what `select` narrows, and whether it is a select, an update, a delete or an insert. A step written under a condition MAY run, so what it reads is SOUND_SET | EXACT |

### Supertypes written in full

A `java.type-role` rule may write a supertype by its full name, and the
MyBatis-Plus pack does: `com.baomidou.mybatisplus.core.mapper.BaseMapper`. Such
a supertype is read as the rule's type unless the file means another type by
that simple name: an import of another `BaseMapper` (tk.mybatis has one, and so
do projects that write their own), or a type of that name the project declares
in the file's package or in a package the file imports whole. A name written
fully qualified in the source leaves nothing to read, and is read as the rule's
type. A supertype written by its simple name alone is read by that name.

### A role a library declares

Some libraries put their own base type between a project and the framework's.
mybatis-plus-join declares `MPJBaseMapper<T>` as a `BaseMapper<T>`, and a
project whose mappers extend `MPJBaseMapper` never writes `BaseMapper`. The
project's source cannot show that relation, because it is in a jar. A
`java.type-role` rule for such a type names it in `params.library`:

```json
"grade": "SOUND_SET",
"params": {
  "role": "mybatis-plus-mapper", "supertypes": ["MPJBaseMapper"], "entityArg": 0,
  "library": {
    "type": "com.github.yulichang.base.MPJBaseMapper",
    "declares": "public interface MPJBaseMapper<T> extends BaseMapper<T>, JoinMapper<T>",
    "source": "mybatis-plus-join-core, com/github/yulichang/base/MPJBaseMapper.java"
  }
}
```

- `type`, `declares` and `source` are all required: which type, what the rule
  relies on it being, and where anyone can check that.
- Such a rule is graded below EXACT, and only such a rule may be. Every link a
  role from it gives (the method to its generic statement, the statement to its
  table and columns) is capped at that grade, and the statement's evidence names
  the rule and the library type.
- A supertype is read as the library's type only when its file means that
  type, read the way javac reads a name: an import of that one name decides,
  else a type of the file's own package, else a package imported whole. A type
  of the same name from elsewhere is not it.
- When a rule for the framework's own type and a library rule both give a type
  the same answer, the type has one role, as sure as the surer rule.

### A setting made in code

Some of what decides where a route is served is set by configuration code, not
declared. Spring puts a path prefix before the controllers a predicate picks:
`RequestMappingHandlerMapping.setPathPrefixes(...)`, or
`PathMatchConfigurer.addPathPrefix(prefix, predicate)` in a `WebMvcConfigurer`
or a `WebFluxConfigurer`. The predicate is a lambda and the prefix is usually a
property. This engine reads neither (a prefix written as a constant is readable
in principle, and is not read either), so the profile has a key for it,
`pathPrefixes` ([the Java lane setup page](setup/java-lane.md#a-prefix-set-in-configuration-code-pathprefixes)).
A `java.code-setting` rule is how the engine notices that a project needs that
key:

```json
"params": {
  "setting": "pathPrefixes",
  "effect": "the controllers it picks are served under a path prefix, and every route of theirs is recorded here without it",
  "calls": [
    { "on": "PathMatchConfigurer", "method": "addPathPrefix",
      "types": ["org.springframework.web.servlet.config.annotation.PathMatchConfigurer",
                "org.springframework.web.reactive.config.PathMatchConfigurer"] }
  ]
}
```

- `setting` is a key of the profile. `effect` says, in a clause, what the call
  sets and what that leaves out of the pack.
- `types` writes in full every type that declares the method, so the rule
  names the method it means by its declaring type, not by its name alone.
- The Java worker records each call's receiver as the file declares it: a
  local, a parameter, a field, `new X()`, a cast, or `this`. A call is the
  setting when that type is one `types` lists, written in full or by a name the
  file can name, or a class whose `extends` or `implements` names one. A call
  whose receiver's type the file does not state, in a file that imports such a
  type, is only a lower note (severity `info`), since nothing proves it. A call
  on a receiver declared as another type is some other method, and is not said.
- When the Java facts show such a call and the profile key is still empty,
  `cascade analyze` warns `SETTING_IN_CODE` with the file, the line and the key
  to fill in. A declared key is the project's word, and nothing is said.
- It draws no edge and grades nothing, so a rule of this kind has no grade.

### Routes built with calls

Spring's functional endpoints declare routes with calls, not annotations:

```java
@Bean RouterFunction<ServerResponse> routes(OwnerHandler handler) {
  return route().nest(path("/owners"), b -> b.GET("/{id}", handler::show)).build();
}
```

The Java worker records the body of every method declared to return a
`RouterFunction` (or a `Supplier` of one) as a tree of the calls it is written
with, and decides nothing. A `java.route-function` rule is the vocabulary that
tree is read with. Each entry of `calls` names methods, the class a static call
is made `on`, what the call does, and the argument roles of each form it takes
(`"path predicate handler"`, `"predicate routes"`, and so on). The
`spring-functional` pack reads Spring's own builders on WebFlux and WebMvc, and
springdoc's `SpringdocRouteBuilder`:

| `does` | calls in `spring-functional` | what it does to the routes |
|---|---|---|
| `start` | `RouterFunctions.route()`, `SpringdocRouteBuilder.route()` | starts a builder |
| `route` | `GET`, `POST` and the other verbs on a builder; `route(predicate, handler)`, `andRoute` | adds a route, with the path, predicate, handler and springdoc operation consumer its form has |
| `nest` | `nest`, `andNest`, the builder's `path(...)` | puts the routes inside under that path, given as a router function, a `Supplier` of one, or a consumer of a fresh builder |
| `combine` | `and`, `andOther`, `add` | joins another router function's routes |
| `build` | `build` | the router function the builder holds at that point |
| `keep` | `filter`, `before`, `after`, `onError`, `withAttribute`, `withAttributes` | leaves them as they are |
| `resources` | `resources` | serves static files: counted, and no route |

`predicates` does the same for `RequestPredicates`: `GET("/x")` and the other
verbs, `path("/x")` and `method(HttpMethod.GET)` name a path or a verb, joined
with `and`; `accept`, `contentType` and the like narrow a route and name no
path. `mountAnnotations` (`Bean`) names the annotation that makes Spring
register a method's routes, and `operationId` the call in springdoc's operation
consumer that names the operation.

Where a route is served is the Java bridge's question:

- A `@Bean` method's routes are served at the paths their calls compose. A
  route-building method of the same class that one calls with no argument is
  read there, under the caller's prefix. Any other one is mounted by code
  elsewhere, and its paths are relative to a prefix its file does not state.
- Such a route is placed only where an OpenAPI document declares the operation
  id it names, with its verb, at a path that ends with its own. Its HANDLES
  edge is then HEURISTIC: no mount the source states puts it there, only a
  document that may be stale. Two routes of the code that name one operation,
  or an operation id the documents declare on two routes, are placed by
  neither. The operation id is the one the builder was given last; a last one
  that is not a literal leaves it unknown.
- Every route gets the endpoint id every lane uses, so a route a document
  declares is the same node, corroborated rather than duplicated.
- For a route whose `@Bean` states where it is served, HANDLES is EXACT where
  the source names the class and the method and nothing in the tree overrides
  it (`this::list`, or `OwnerHandler::list` of a type the tree declares with
  that method). Through a declared type (a field, a parameter, a local, or
  `this` with an override below it) it is SOUND_SET, and the set is every
  method an object of that type may run: the type's own or inherited one and
  every override below it in the tree. A lambda that calls one method names
  that method.
- A builder is one object whatever names hold it, so a route added through a
  second name is the builder's, and `build()` is what the builder holds at that
  point. A local assigned again (a path, a prefix, a builder) is read at the
  value it holds where it is used; where the reader cannot follow the
  assignment (a branch, `+=`, an assignment inside an expression), the local is
  not read from there on.
- A handler this lane cannot name (a lambda that does more than call one
  method, a handler held in a variable) leaves the route as an endpoint node
  with `handlerUnread: true` and no HANDLES edge.
- What is not read is counted in `laneStats.functionalRoutes` and the first
  few are printed as `JAVA_ROUTE_NOT_READ`: a path in a variable, a predicate or
  a call the pack does not name, a helper handed arguments. An operation id the
  documents give to another route is counted in `operationIdDisagreements` and
  printed as `OPERATION_ID_DISAGREES`.

A builder a project or a library adds is a pack entry, not a code change. Two
rules that read one call two ways stop the run.

### A contract only the build writes

A contract-first project keeps its API in an OpenAPI document, and the build
runs a code generator over it. openapi-generator writes one interface per group
of operations (`OwnersApi`), one method per operation named by its operationId,
each carrying the mapping annotation, and the project's controllers implement
those interfaces. The interfaces are not in the source tree, so the Java lane
sees controllers with no mapping, and the document's routes have nothing under
them.

A `java.contract-link` rule pairs the two by the generator's naming:

- `serverClass.annotations` (`RestController`, `Controller`): only a class that
  carries one of them itself is a handler. A client of the API that implements
  the same interface serves nothing. A controller that gets its annotation from
  a superclass or a meta-annotation is not linked either: a missing link, never
  a guessed one.
- `interfaceName`: the suffix (`Api`) and where the generator takes a group's
  name from (`tag`, each of the operation's tags, and `path`, the first segment
  of its path as the document writes it), spelled with the generator's own
  sanitizing and camel-casing.
- `generator`: which generator, what the rule relies on it doing, and where
  that is written (`name`, `declares`, `source`). All three are required.

A concrete class that carries such an annotation, whose own implements clause
names an interface the project does not declare, with the suffix and the name
the generator gives an operation's group, handles that operation's route with
the method named by its operationId. The link is a HANDLES edge graded
HEURISTIC, the kind's cap: neither the interface nor any generator
configuration is read, so all that joins the two is a naming convention. Its
evidence names the rule, the operationId, the documents and the interface.

What is not linked is said when it is a near miss (`CONTRACT_NOT_LINKED`): an
operationId the interface's name fits on two different routes (two documents
with different base paths), and a method named like an operationId whose
operation would be generated into another interface. Two documents that put the
operationId on the same route are one link that names both. An interface the
project declares is the Java lane's to read, and an operationId the generator
rewrites into another method name (a hyphen, a Java keyword) is not matched.
A route the code already maps to the same method gets no second edge; it is
counted as `alreadyHandled`, not as a link.

`analyze` prints how many routes the rules gave a handler, and
`laneStats.openapi.contractLinks` lists them with the methods not linked. The
overview names them in its `contract-links` gap. The drift census still counts
these routes as declared and not served, because no mapping in the source
serves them.

A walk treats a route's link to its handler as a link. The whole-pack views
start only from a handler the mode admits and grade what they reach no higher
than that link, and `flow` does the same. So these routes reach their SQL at
`mode=heuristic` and not at the default `conservative`, where the walk stops at
the route and says why.

### The TypeScript backend's kinds

The NestJS, Prisma and TypeORM packs (`nestjs.json`, `prisma.json`,
`typeorm.json`) hold what the TypeScript lane knows about those frameworks: the
decorator names, the bootstrap calls, the client types, and the role of each key
a Prisma call takes (`where` filters, `select` projects, `data` writes, `include`
reaches relations). A decorator a project renames, or an operation a newer
Prisma adds, is an edit of a pack, with an example that holds it. The
`prisma.nestjs-prisma-service` rule is a library's type like the one above: it names the
declaration it relies on and where to check it, and its links are graded
SOUND_SET.

- `prisma.operations` also names how a relation is followed: the relation
  filters (`some`, `every`, `none`, `is`, `isNot`), the ones that given `null`
  only check the link (`relationNullFilters`), what `_count` reads, what each
  nested write does to the related rows and to the link, and the literal values
  that make a nested write change nothing (`idle`: each entry names the value,
  the relations it applies on, and whether it drops every edge or only the
  writes, since `delete: []` still looks the related rows up). `extensions` names `$extends`, the component that may rewrite what a
  call sends (`query`), `Prisma.defineExtension`, and where a `result` component
  says which fields a computed field needs.
- `nestjs.providers` (kind `ts.provider-binding`) reads what a module binds to a
  type: a class listed alone binds itself, `{ provide: T, useClass: C }` binds T
  to C, and a binding by `useFactory`, `useValue` or `useExisting` is named and
  not read. A constructor parameter marked `@Inject(token)` is filled by the
  token, not its type. The lane uses these bindings to settle which classes a
  call through an abstract class or an interface can reach.
- The `typeorm` pack has one rule per kind. `typeorm.entities` names the entity,
  column and relation decorators, the decorators it does not read
  (`@ChildEntity`, `@ViewEntity`, `@TableInheritance`, `@Tree`), where an
  application writes its DataSource options (`TypeOrmModule.forRoot` and
  `forRootAsync`, `createConnection`, `new DataSource`), and the naming
  strategies it knows, `default` (TypeORM's `DefaultNamingStrategy`) and `snake`
  (`SnakeNamingStrategy` of typeorm-naming-strategies), each as the transform it
  applies to a table, a column, a join column, a join table and its columns.
  A project that declares `tsBackend.typeorm.namingStrategy` names one of
  these.
  `typeorm.receivers` names the types, injection decorators, functions and
  members that give a repository, an entity manager or a data source.
  `typeorm.operations` names every operation, the statement it sends and the
  part each argument plays, and TypeORM 0.2's test that tells a find's options
  from its conditions. `typeorm.query-builder` names the part each builder
  method plays, and the words of a condition that are SQL's and not a column.

See [the TypeScript lane setup page](setup/ts-lane.md).

A kind whose examples are source code runs them through the real worker. The
Java kinds' examples (`java.type-role`, `java.code-setting`,
`java.route-function`, `java.contract-link`) are Java, parsed by the same Java
worker an analysis uses, so they need a JDK; a `java.contract-link` example
also carries its OpenAPI documents, which the engine's own OpenAPI reader reads
in process. The TypeScript kinds' examples are read by the TypeScript worker in
process, so they need nothing beyond Node. Without a JDK the Java examples are
reported as not run, and `cascade rules test` exits 2 rather than 0: an example
nobody ran is not one that holds.
