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
| `sql.dialect-path` | while discovering the tree | a file's path | which database a DDL or mapper file is for, from a whole word of its path. The first entry of a rule whose word is in the path wins, so a rule lists first the entry it prefers |
