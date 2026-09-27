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
one whole, and `cascade rules test` runs every example ([cli.md](cli.md#cascade-rules)).

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

A kind whose examples are source code runs them through the real worker: the
`java.type-role` examples are Java, parsed by the same Java worker an analysis
uses, so they need a JDK. Without one they are reported as not run, and
`cascade rules test` exits 2 rather than 0: an example nobody ran is not one
that holds.
