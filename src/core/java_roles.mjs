// java_roles.mjs — the Java records the rules give: roles read from the supertypes the worker recorded.
//
// The Java worker records what each file says; it no longer decides which types
// are MyBatis-Plus mappers and services. The `java.type-role` rules of the
// engine's packs do, from the worker's `type` records, and this is where their
// records join the worker's: after the shards are assembled and before anything
// reads them (which lanes to run, the bridges). `cascade analyze` and the
// working-tree overlay both come through here, so the two cannot disagree.
//
// The rules run on every assembly and nothing they give is cached: the cache
// holds what the worker read, and a changed rule applies to it at once.

import { assembleJavaFacts } from './facts_store.mjs';
import { builtinRegistry } from './rules/registry.mjs';
import { deriveTypeRoles } from './rules/kinds/java_type_role.mjs';

/**
 * The worker's records with the role records the rules give them, each in the
 * place the worker's own record of that kind used to sit.
 *
 * @param {object[]} javaFacts  assembled worker records
 * @param {{id:string, compiled:Function}[]} [rules]  the `java.type-role` rules; the engine's own by default
 * @returns {object[]}
 */
export function withTypeRoles(javaFacts, rules = builtinRegistry().ofKind('java.type-role')) {
  const derived = deriveTypeRoles(javaFacts, rules);
  return derived.length === 0 ? javaFacts : assembleJavaFacts([javaFacts, derived]);
}
