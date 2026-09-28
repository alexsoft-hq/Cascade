// ts_test_support.mjs — the `ts.test-support` rule kind: which TypeScript files are a test's, not the application's, read from their path.
//
// A spec, a mock beside the class it stands in for, a `__mocks__` or `testing`
// directory: code a test runs, which the application never does. Read as the
// application's, a mock class becomes one more class a call may reach. This
// kind knows HOW a path is matched: a directory by its whole name, a file by
// the end of its name. The rule packs say WHICH names mean test support
// (src/core/rules/packs/typescript.json), and the TypeScript lane leaves every
// file one names out, the application's own and a shared library's alike.

const DIR = /^[A-Za-z0-9_.-]+$/;
const SUFFIX = /^[A-Za-z0-9_.-]*\.ts$/;
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const listOf = (v, re) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && re.test(x));

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['dirs', 'suffixes']).map((k) => `params has an unknown key "${k}"`);
  if (!listOf(params.dirs, DIR)) errors.push('params.dirs must list directory names, each a whole name');
  if (!listOf(params.suffixes, SUFFIX)) errors.push('params.suffixes must list file name endings, each ending in .ts');
  return errors;
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['path', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.path !== 'string' || example.path === '') errors.push('an example needs a path');
  if (typeof example.expect !== 'boolean') errors.push('an example expects true (test support) or false');
  return errors;
}

/** The rule, ready to read root-relative paths: `isTestSupport(path)`. */
function compile(rule) {
  const dirs = new Set(rule.params.dirs);
  const { suffixes } = rule.params;
  const isTestSupport = (rel) => {
    const parts = String(rel ?? '').split('/');
    const name = parts[parts.length - 1];
    return parts.slice(0, -1).some((d) => dirs.has(d)) || suffixes.some((s) => name.endsWith(s));
  };
  return { isTestSupport, rule: rule.id };
}

function runExample(compiled, example) {
  const got = compiled.isTestSupport(example.path);
  return { passed: got === example.expect, got };
}

export const tsTestSupport = Object.freeze({
  name: 'ts.test-support',
  lane: 'ts',
  stage: 'discovery',
  // A classification of a file, not an edge: there is no grade to cap.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExample,
});
