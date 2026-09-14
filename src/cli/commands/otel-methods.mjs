// otel-methods.mjs — `cascade otel-methods`: the one line the OpenTelemetry
// Java agent needs before the dispatch join can see anything.
//
// The agent instruments HTTP, Spring Data and JDBC on its own, so a first run
// observes routes and statements and reports dispatch 0: no controller and no
// service method has a span, so no method span ever nests inside another. The
// fix is `-Dotel.instrumentation.methods.include=`, and the agent takes EXPLICIT
// method names there. `pkg.Class[*]` matches nothing.
//
// Writing that list by hand means reading the project. The pack has already read
// it, so this prints it: the value on stdout and nothing else, so it can be
// pasted or piped, with the count on stderr where it does not get in the way.

import fs from 'node:fs';
import path from 'node:path';
import { otelMethodsInclude } from '../../adapters/runtime_bridge.mjs';
import { loadPack } from '../../core/pack.mjs';

export function run(ctx) {
  const { flag, die, resolveOrDie } = ctx;
  const resolved = resolveOrDie();
  const file = path.join(resolved.packDir, 'pack.json');
  if (!fs.existsSync(file)) die(`no pack at ${file}. Run cascade analyze first`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = loadPack(pack, { verifyDigest: true });
  const inc = otelMethodsInclude(g);
  if (flag('json')) {
    process.stdout.write(JSON.stringify(inc.classes, null, 2) + '\n');
  } else if (inc.value !== '') {
    process.stdout.write(inc.value + '\n');
  }
  if (inc.methodCount === 0) {
    process.stderr.write(`${resolved.projectId ?? resolved.packDir}: nothing to instrument. This pack holds no route handler `
      + 'and no method that reaches a statement, so there is no caller for a trace to see\n');
    process.exit(0);
  }
  sayWhatToPass(inc);
  process.exit(0);
}

/** What the line holds, and how to hand it to the agent. */
function sayWhatToPass(inc) {
  process.stderr.write(`${inc.methodCount} method(s) in ${inc.classCount} class(es): `
    + `${inc.handlers} route handler(s) and ${inc.statementReachers} method(s) that reach a statement. `
    + 'Pass it to the agent as -Dotel.instrumentation.methods.include=<this line>, quoted, and run once with traffic. '
    + 'See docs/setup/runtime-evidence.md\n');
  sayMapperMethods(inc.mapperMethods);
}

/**
 * THE SWITCH A MyBatis PROJECT ALSO NEEDS (RM62). Measured on the eGovFrame web
 * sample: with the method list alone, all six statements came back attached to
 * the service method above them and none to a statement of the pack.
 */
function sayMapperMethods(count) {
  if (!(count > 0)) return;
  process.stderr.write(`${count} of them are MyBatis mapper methods. A mapper is an interface answered by a proxy built at run time, `
    + 'so naming its methods gives no span: also pass -Dotel.instrumentation.mybatis.enabled=true, which is off by default, '
    + 'or every statement of this pack comes back matched to the service above it and to no statement\n');
}
