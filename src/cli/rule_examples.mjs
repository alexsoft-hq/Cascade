// rule_examples.mjs — the workers a rule's examples run through, and the per-example answer the viewer shows.
//
// `cascade rules test` and the viewer's Rules tab run the SAME examples the
// same way, so a rule the CLI says holds is the one the page marks as holding.
// A Java example is source code, parsed by the real Java worker, so it needs a
// JDK; a TypeScript one is read by the TypeScript worker in process, and a web
// one by the web worker and the web lane, which need nothing beyond Node.
// Without a JDK the Java examples are NOT RUN and say so: an example nobody ran
// is not one that holds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testRules } from '../core/rules/examples.mjs';
import { findJdk } from './env.mjs';
import { runJavaLane } from './lanes_run.mjs';
import { factsOfFile, valueOfSource } from '../../adapters/ts/tsfacts.mjs';
import { readOpenApiDocument } from '../adapters/openapi_bridge.mjs';
import { webCallsForExamples, webFactsForExamples } from './web_examples.mjs';

/** Each example source written under `dir` at its own relative name. */
function writeSources(dir, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.name), f.text);
  }
}

/**
 * The Java worker, run over example sources written to a scratch tree that is
 * removed after; null when there is no JDK, so the examples are reported not run.
 */
function javaWorkerForExamples() {
  const jdk = findJdk();
  if (!jdk) return null;
  return (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-rule-examples-'));
    try {
      writeSources(dir, files);
      return runJavaLane(jdk, dir, [dir], { quiet: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * The readers that run in process: a TypeScript example needs nothing but the
 * engine, and neither does an OpenAPI document.
 */
const IN_PROCESS_READERS = Object.freeze({
  tsFacts: factsOfFile, tsValue: valueOfSource, openApiDocument: readOpenApiDocument,
  webFacts: webFactsForExamples, webCalls: webCallsForExamples,
});

/** Everything a rule's examples may need to run, on this machine. */
export function ruleExampleEnv() {
  const javaFacts = javaWorkerForExamples();
  return { ...IN_PROCESS_READERS, ...(javaFacts ? { javaFacts } : {}) };
}

/**
 * Every rule's examples, run, with a verdict per example: `held[i]` is whether
 * the i-th example of the rule's pack entry holds, and null for every one of
 * them when none could be run (`notRun` says why).
 *
 * @param {object} registry
 * @returns {{rules:{id:string, total:number, held:(boolean[]|null), notRun:(string|null)}[]}}
 */
export function exampleVerdicts(registry) {
  const results = testRules(registry, { env: ruleExampleEnv() });
  return {
    rules: results.map((r) => {
      const examples = registry.rules.get(r.id).rule.examples;
      const failed = new Set(r.failures.map((f) => JSON.stringify(f.example)));
      return {
        id: r.id, total: r.total, notRun: r.notRun,
        held: r.notRun ? null : examples.map((ex) => !failed.has(JSON.stringify(ex))),
      };
    }),
  };
}
