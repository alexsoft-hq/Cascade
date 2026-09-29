// web_examples.mjs — the web worker and the web lane, as a `web.wrapper-hop` rule's examples run through them.
//
// A web rule's example is a small frontend: its source files, the routes a
// backend would serve, and what the calls in it send. The files go through the
// real worker (adapters/web/webfacts.mjs, spawned on a scratch tree that is
// removed after), and the facts through the real bridge with the rule under
// test alone, so an example holds only where an analysis would say the same.
// Node is all either needs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Graph } from '../core/graph.mjs';
import { addWebFacts, webEndpointId } from '../adapters/web_bridge.mjs';
import { runWebLane } from './lanes_run.mjs';

/** The web worker's records for these example files, read from a scratch tree. */
export function webFactsForExamples(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-web-examples-'));
  try {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.name), f.text);
    }
    return runWebLane(dir, [dir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The CALLS_HTTP edges the web lane draws from those records onto the routes
 * written as "VERB /path", with only the rules handed in naming a step.
 */
export function webCallsForExamples(records, routes, hopRules) {
  const g = new Graph();
  for (const r of routes) {
    const [method, p] = r.split(' ');
    const id = webEndpointId(method, p);
    g.addNode({ id, path: p, httpMethod: method, handler: 'example.Handler#handle' });
    g.addEdge({ from: id, to: 'symbol:example.Handler#handle', type: 'HANDLES', grade: 'EXACT' });
  }
  addWebFacts(g, records, { hopRules });
  return g.edges.filter((e) => e.type === 'CALLS_HTTP');
}
