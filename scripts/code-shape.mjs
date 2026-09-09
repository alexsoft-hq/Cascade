#!/usr/bin/env node
// code-shape.mjs — measure how long and how branchy every function in this
// engine is, and hold the numbers down.
//
// WHY THIS IS NOT A LINT RULE. `max-lines-per-function` takes ONE number for a
// whole repository. Set it above the worst function and it means nothing; set it
// where it should be and every commit is red until somebody switches it off. So
// this is a RATCHET instead, the same shape as the generality gate and the other
// way up: the baseline records what each file's worst function is TODAY, the
// test fails when a file gets worse, and `--accept` may only write a number
// DOWN. A file cannot get longer by accident, and improving one is the only
// thing that changes the baseline.
//
// Two rules, because a ratchet on the maximum alone has an obvious hole: split a
// 1 700-line function into a 1 600-line one plus a fresh 100-line one, and the
// maximum falls while the code is no better. So a function whose NAME the
// baseline does not already carry for that file is judged against absolute
// limits — 80 lines and 30 branches — and the file's own maximum only protects
// the functions that were already there.
//
// WHAT IS MEASURED, per function:
//   lines     end line - start line + 1, the whole span including any function
//             nested inside it. A callback inside a 200-line function is part of
//             what a reader has to hold in their head.
//   branches  if / for / while / do / switch case / ternary / && / || / ?? /
//             catch, counted over the same span. Length is how much there is;
//             branches are how many ways it can go, and the second is what makes
//             a function hard to change.
//
// USAGE
//   node scripts/code-shape.mjs                 print the table, worst first
//   node scripts/code-shape.mjs --json out.json also write the raw measurement
//   node scripts/code-shape.mjs --accept        re-seal the baseline, downward only
//   node scripts/code-shape.mjs --file <path>   the functions of ONE file, in order
//
// The parser is the VENDORED babel parser the web lane already uses, so this
// script needs no npm install either.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const babel = require('../adapters/web/vendor/babel-parser.cjs');

export const SHAPE_SCHEMA = 'cascade:code-shape:1';
export const BASELINE_FILE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'code-shape.baseline.json');

/** What a function the baseline does not name may be, at most. */
export const NEW_FUNCTION_LINES = 80;
export const NEW_FUNCTION_BRANCHES = 30;

/**
 * The source this ratchet holds. `bin/` and `src/` are the engine; `adapters/web`
 * is the worker beside them, with the modules its body was split into; `viewer/js`
 * is the page's own code, which used to be one inline script in the HTML where no
 * tool could read it. The VENDORED parser and the vendored map renderers are
 * excluded because they are not ours (the walk skips any directory named
 * `vendor`). Tests are not here: a test file is read once, in one direction, and
 * length is not what makes one hard.
 */
export const SCOPE = Object.freeze([
  { dir: 'bin', recurse: true },
  { dir: 'src', recurse: true },
  { dir: 'adapters/web', recurse: true },
  { dir: 'viewer/js', recurse: true },
]);

const BRANCH_TYPES = new Set([
  'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'ConditionalExpression',
  'LogicalExpression', 'CatchClause',
]);

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);

const SKIP_KEYS = new Set(['loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'errors', 'comments', 'tokens']);
const isNode = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string';

function eachChild(node, fn) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) if (isNode(item)) fn(item);
    } else if (isNode(v)) fn(v);
  }
}

/** Every `.mjs` / `.js` file in scope, as repo-relative posix paths, sorted. */
export function filesInScope(root = ENGINE_ROOT) {
  const out = [];
  const walk = (abs, rel, recurse) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // The vendored parser is upstream's code, verbatim. It is not ours to shape.
        if (recurse && entry.name !== 'vendor' && entry.name !== 'node_modules') walk(childAbs, childRel, recurse);
      } else if (/\.(mjs|js)$/.test(entry.name)) {
        out.push(childRel);
      }
    }
  };
  for (const s of SCOPE) {
    const abs = path.join(root, s.dir);
    if (fs.existsSync(abs)) walk(abs, s.dir, s.recurse);
  }
  return out.sort();
}

/**
 * The name a function is known by, or null when it has none of its own. A
 * declaration and a method have one; an arrow takes the name of the binding it
 * is assigned to, which is how a reader refers to it anyway (`const cut = (xs)
 * => …` is "cut").
 */
function ownNameOf(node, parent) {
  if (node.id && node.id.name) return node.id.name;
  if (parent) {
    if (parent.type === 'VariableDeclarator' && parent.id && parent.id.name) return parent.id.name;
    if ((parent.type === 'ObjectProperty' || parent.type === 'ClassProperty' || parent.type === 'PropertyDefinition')
      && parent.key && (parent.key.name || parent.key.value)) return String(parent.key.name ?? parent.key.value);
    if (parent.type === 'AssignmentExpression' && parent.left && parent.left.type === 'Identifier') return parent.left.name;
  }
  if ((node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') && node.key) {
    return String(node.key.name ?? node.key.id?.name ?? node.key.value ?? 'method');
  }
  return null;
}

/** How many ways the code under `node` can go. Counted over the whole subtree. */
function branchesUnder(node) {
  let n = 0;
  const visit = (cur) => {
    if (BRANCH_TYPES.has(cur.type)) n += 1;
    // A `switch` counts its CASES, not itself: `default` is not a branch, it is
    // what is left, and counting the switch as one would say a twelve-way
    // dispatch is as simple as an `if`.
    if (cur.type === 'SwitchCase' && cur.test) n += 1;
    eachChild(cur, visit);
  };
  eachChild(node, visit);
  return n;
}

/**
 * Every function in one source text: `{name, line, lines, branches}`, in source
 * order.
 *
 * AN ANONYMOUS FUNCTION IS NAMED BY WHERE IT LIVES, NOT BY ITS LINE. A callback
 * called `<anonymous>@261` would become a DIFFERENT function the moment somebody
 * added a comment above it, and the baseline would then see a brand new 260-line
 * function and fail for no reason at all. So it is `<owner>/1`, `<owner>/2`
 * counting within the function that holds it, which only changes when the code
 * around it does.
 */
export function functionsIn(code) {
  const ast = babel.parse(code, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    attachComment: false,
    ranges: false,
    tokens: false,
    plugins: ['jsx', 'decorators-legacy'],
  });
  const out = [];
  const anonCount = new Map();
  const visit = (node, parent, owner) => {
    let here = owner;
    if (FUNCTION_TYPES.has(node.type)) {
      let name = ownNameOf(node, parent);
      if (name === null) {
        const n = (anonCount.get(owner) ?? 0) + 1;
        anonCount.set(owner, n);
        name = `${owner}/${n}`;
      }
      here = name;
      out.push({
        name,
        line: node.loc?.start?.line ?? 0,
        lines: (node.loc?.end?.line ?? 0) - (node.loc?.start?.line ?? 0) + 1,
        branches: branchesUnder(node),
      });
    }
    eachChild(node, (child) => visit(child, node, here));
  };
  visit(ast, null, '<file>');
  out.sort((a, b) => a.line - b.line);
  return out;
}

/**
 * Measure every file in scope.
 * @returns {{files: Object<string, {maxLines:number, maxBranches:number,
 *          longest:string, branchiest:string, functions:string[]}>, all: object[]}}
 */
export function measure(root = ENGINE_ROOT) {
  const files = {};
  const all = [];
  for (const rel of filesInScope(root)) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    const fns = functionsIn(code);
    for (const f of fns) all.push({ file: rel, ...f });
    let longest = { name: null, lines: 0 };
    let branchiest = { name: null, branches: 0 };
    for (const f of fns) {
      if (f.lines > longest.lines) longest = f;
      if (f.branches > branchiest.branches) branchiest = f;
    }
    files[rel] = {
      maxLines: longest.lines,
      maxBranches: branchiest.branches,
      longest: longest.name,
      branchiest: branchiest.name,
      functions: [...new Set(fns.map((f) => f.name))].sort(),
    };
  }
  return { files, all };
}

/** The sealed baseline, or null when there is none yet. */
export function readBaseline(file = BASELINE_FILE) {
  if (!fs.existsSync(file)) return null;
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (b.schema !== SHAPE_SCHEMA) throw new Error(`${file}: unexpected schema ${b.schema}`);
  return b;
}

/**
 * Compare a measurement against a baseline. PURE — this is what the test calls.
 *
 * A file the baseline does not know is not a failure: a new module is measured
 * by the NEW-function limits, function by function, which is exactly what should
 * judge code nobody has looked at yet.
 *
 * @returns {{regressions:string[], newTooBig:string[], improvements:string[], unknownFiles:string[]}}
 */
export function compare(now, baseline) {
  const regressions = [];
  const newTooBig = [];
  const improvements = [];
  const unknownFiles = [];
  const base = baseline?.files ?? {};
  const byFile = new Map();
  for (const f of now.all) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [rel, cur] of Object.entries(now.files)) {
    const was = base[rel];
    if (!was) unknownFiles.push(rel);
    const known = new Set(was?.functions ?? []);
    if (was) {
      if (cur.maxLines > was.maxLines) {
        regressions.push(`${rel}: the longest function is ${cur.maxLines} lines (${cur.longest}), the baseline holds it at ${was.maxLines}`);
      }
      if (cur.maxBranches > was.maxBranches) {
        regressions.push(`${rel}: the branchiest function has ${cur.maxBranches} branches (${cur.branchiest}), the baseline holds it at ${was.maxBranches}`);
      }
      if (cur.maxLines < was.maxLines || cur.maxBranches < was.maxBranches) {
        improvements.push(`${rel}: ${was.maxLines}/${was.maxBranches} -> ${cur.maxLines}/${cur.maxBranches} lines/branches`);
      }
    }
    for (const f of byFile.get(rel) ?? []) {
      if (known.has(f.name)) continue;
      if (f.lines > NEW_FUNCTION_LINES) {
        newTooBig.push(`${rel}:${f.line} ${f.name} is new and ${f.lines} lines (a function this file has not carried before may be at most ${NEW_FUNCTION_LINES})`);
      }
      if (f.branches > NEW_FUNCTION_BRANCHES) {
        newTooBig.push(`${rel}:${f.line} ${f.name} is new and has ${f.branches} branches (at most ${NEW_FUNCTION_BRANCHES})`);
      }
    }
  }
  return {
    regressions: regressions.sort(),
    newTooBig: newTooBig.sort(),
    improvements: improvements.sort(),
    unknownFiles: unknownFiles.sort(),
  };
}

/**
 * Seal the baseline, DOWNWARD ONLY. A number that rose is refused with the
 * reason; the ratchet is worth nothing if `--accept` can undo it.
 * @returns {{written:boolean, refused:string[], lowered:string[], added:string[]}}
 */
export function seal(now, baseline, file = BASELINE_FILE) {
  const base = baseline?.files ?? {};
  const refused = [];
  const lowered = [];
  const added = [];
  const next = {};
  for (const [rel, cur] of Object.entries(now.files)) {
    const was = base[rel];
    if (!was) { next[rel] = cur; added.push(rel); continue; }
    if (cur.maxLines > was.maxLines || cur.maxBranches > was.maxBranches) {
      refused.push(`${rel}: ${was.maxLines}/${was.maxBranches} -> ${cur.maxLines}/${cur.maxBranches} lines/branches is a RISE. `
        + '--accept only writes a number down; make the file smaller, or change the baseline by hand and say why in the commit');
      next[rel] = was;
      continue;
    }
    if (cur.maxLines < was.maxLines || cur.maxBranches < was.maxBranches) {
      lowered.push(`${rel}: ${was.maxLines}/${was.maxBranches} -> ${cur.maxLines}/${cur.maxBranches}`);
    }
    next[rel] = cur;
  }
  if (refused.length > 0) return { written: false, refused, lowered, added };
  const out = { schema: SHAPE_SCHEMA, files: {} };
  for (const rel of Object.keys(next).sort()) out.files[rel] = next[rel];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`, 'utf8');
  return { written: true, refused, lowered, added };
}

function table(now, limit) {
  const rows = [...now.all].sort((a, b) => b.lines - a.lines).slice(0, limit);
  const w = Math.max(...rows.map((r) => `${r.file}:${r.line}`.length), 4);
  const lines = [`${'where'.padEnd(w)}  lines  branches  function`];
  for (const r of rows) {
    lines.push(`${`${r.file}:${r.line}`.padEnd(w)}  ${String(r.lines).padStart(5)}  ${String(r.branches).padStart(8)}  ${r.name}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const log = (m) => process.stderr.write(`${m}\n`);
  const has = (f) => argv.includes(`--${f}`);
  const opt = (f) => {
    const i = argv.indexOf(`--${f}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  const one = opt('file');
  if (one) {
    const code = fs.readFileSync(path.resolve(one), 'utf8');
    for (const f of functionsIn(code)) {
      process.stdout.write(`${String(f.line).padStart(5)}  ${String(f.lines).padStart(5)} lines  ${String(f.branches).padStart(4)} branches  ${f.name}\n`);
    }
    return 0;
  }

  const now = measure();
  const baseline = readBaseline();
  const jsonOut = opt('json');
  if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(now.files, null, 1)}\n`, 'utf8');

  const over80 = now.all.filter((f) => f.lines > 80).length;
  const over200 = now.all.filter((f) => f.lines > 200).length;
  process.stdout.write(`${now.all.length} function(s) in ${Object.keys(now.files).length} file(s): ${over80} over 80 lines, ${over200} over 200\n`);
  process.stdout.write(`${table(now, Number(opt('top') ?? 15))}\n`);

  if (has('accept')) {
    const res = seal(now, baseline);
    for (const r of res.refused) log(`REFUSED ${r}`);
    for (const l of res.lowered) log(`lowered ${l}`);
    for (const a of res.added) log(`added   ${a}`);
    if (!res.written) return 1;
    log(`baseline written: ${BASELINE_FILE}`);
    return 0;
  }

  if (!baseline) {
    log(`no baseline at ${BASELINE_FILE}. Seal one with \`node scripts/code-shape.mjs --accept\``);
    return 1;
  }
  const cmp = compare(now, baseline);
  for (const r of cmp.regressions) log(`WORSE ${r}`);
  for (const r of cmp.newTooBig) log(`TOO BIG ${r}`);
  for (const i of cmp.improvements) log(`better ${i}`);
  return cmp.regressions.length + cmp.newTooBig.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
