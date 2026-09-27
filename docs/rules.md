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
([cli.md](cli.md#cascade-rules)).
The viewer's **Rules** tab (`cascade view`) shows the same packs, read-only:
each rule's description, why it is there, its params and examples, and how many
links of the project's pack it gave. A link a rule gave names that rule in its
evidence (`evidence.rule`, with a sentence in `evidence.basis`), so a walked
path in Flow or Impact says which rule made that step.

## Where they are

The packs the engine carries are in `src/core/rules/packs/`. They are part of the
engine: the print the calibration gate compares covers them, so changing one is
judged as an engine change, like changing code.

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

| kind | runs | reads | concludes |
|---|---|---|---|
| `java.type-role` | after the Java worker's records are assembled, before the lanes are chosen | the supertypes a type's own extends and implements clauses name, and their type arguments | which role a type plays (a MyBatis-Plus mapper or service) and which of its type arguments is the entity or the mapper. Only the roots of a chain are matched: a type that reaches one through a type of the project's own is found by the bridge that reads the role |
| `sql.dialect-path` | while discovering the tree | a file's path | which database a DDL or mapper file is for, from a whole word of its path. The first entry of a rule whose word is in the path wins, so a rule lists first the entry it prefers |
| `ts.route-decorator` | in the TypeScript lane's bridge | a class's decorators and its methods' decorators, as the TypeScript worker recorded them | which class is a controller and which method a route, with its path and versions; which class is a module, with the modules it imports and the controllers it lists; and the names the bootstrap calls (`NestFactory.create`, `setGlobalPrefix`, `enableVersioning`, `RouterModule.register`). Whether a controller is served is the bridge's question, read from the module graph |
| `ts.type-role` | in the TypeScript lane's bridge | the package and the exported name a type is imported from | which role a type plays (a Prisma client). A project class that extends it plays it too |
| `prisma.operation` | in the TypeScript lane's bridge | a Prisma call's operation and its argument, key by key | the statement it sends (select, insert, update, upsert, delete), the fields it reads and writes, whether it returns the whole row, and what it cannot follow: a relation, a key it does not know, an argument held in a variable |

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

### The TypeScript backend's kinds

The NestJS and Prisma packs (`nestjs.json`, `prisma.json`) hold what the
TypeScript lane knows about those frameworks: the decorator names, the bootstrap
calls, the client types, and the role of each key a Prisma call takes (`where`
filters, `select` projects, `data` writes, `include` reaches relations). A
decorator a project renames, or an operation a newer Prisma adds, is an edit of
a pack, with an example that holds it. The `nestjs-prisma` rule is a library's
type like the one above: it names the declaration it relies on and where to
check it, and its links are graded SOUND_SET. See
[the TypeScript lane setup page](setup/ts-lane.md).

A kind whose examples are source code runs them through the real worker: the
`java.type-role` examples are Java, parsed by the same Java worker an analysis
uses, so they need a JDK. The TypeScript kinds' examples are read by the
TypeScript worker in process, so they need nothing beyond Node. Without one they are reported as not run, and
`cascade rules test` exits 2 rather than 0: an example nobody ran is not one
that holds.
