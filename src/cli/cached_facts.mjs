// cached_facts.mjs — the Java worker's records a pack was built from, read back out of the fact cache.
//
// `cascade rules explain` reasons over the whole project's types without
// parsing it again: every Java shard the pack's fact index names, assembled in
// the worker's own order. A cache from another worker generation, or one that
// is gone, is refused with the cure rather than read as if it were current.

import fs from 'node:fs';
import path from 'node:path';
import { assembleJavaFacts, createFactsStore, laneOfEntry, nodeFactsIo } from '../core/facts_store.mjs';
import { readIndex } from './overlay_provider.mjs';

export class CachedFactsError extends Error {}

/** @returns {object[]} the Java records of the pack in `packDir` */
export function cachedJavaFacts(packDir) {
  const refuse = (msg) => { throw new CachedFactsError(`${msg}. Run \`cascade analyze\` to rebuild the pack and its fact cache`); };
  const idx = readIndex(path.join(packDir, 'facts-index.json'), refuse);
  const store = createFactsStore({ io: nodeFactsIo(fs), projectId: idx.project, env: process.env });
  const shards = Object.values(idx.files ?? {})
    .filter((entry) => laneOfEntry(entry) === 'java')
    .map((entry) => store.read('javafacts', entry.shardKey, entry).records);
  return assembleJavaFacts(shards);
}
