// index.mjs — the rule kinds this engine has: HOW a rule is read, where rule packs only say WHAT.
//
// A kind is code, reviewed like code. Adding one is a decision (a new way of
// reading a project); adding a rule of an existing kind is data. When a
// framework's variation does not fit any kind here, the answer is a new kind
// with its own tests, never an expression written inside a rule.
//
// Every kind answers the same things: its `name`, the `stage` of an analysis it
// runs in, the strongest grade it may give (`gradeCap`, null for a
// classification that draws no edge), `validateParams`, `validateExample`,
// `compile`, and either `runExample` (one example at a time) or `runExamples`
// (all of them together, for examples that go through a worker once).

import { javaTypeRole } from './java_type_role.mjs';
import { sqlDialectPath } from './sql_dialect_path.mjs';

export const KINDS = Object.freeze({
  [javaTypeRole.name]: javaTypeRole,
  [sqlDialectPath.name]: sqlDialectPath,
});
