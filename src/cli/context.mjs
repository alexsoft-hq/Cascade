// context.mjs — the one object a command is handed.
//
// A command needs two things it cannot compute for itself: the command line,
// and the handful of answers that come from reading it — which project this run
// is about, which profile it reads by, which projects a server serves, how much
// memory that server may hold. Every one of those is `argv` plus a rule, so
// they are bound here, once, and a command body reads `opt('root')` or
// `resolveOrDie()` without ever being handed the array.
//
// That is the whole of it. Everything else a command needs it imports itself,
// which is what keeps this object from becoming the place where the CLI's state
// quietly accumulates.

import { makeArgs } from './args.mjs';
import { resolveOrDie } from './env.mjs';
import { memoryBudgetBytes, readProfile, servedEntries, servedHost } from './serve.mjs';

/**
 * @param {string[]} argv  the arguments after the program name
 * @param {{write?:(s:string)=>void, exit?:(code:number)=>void}} [io]
 */
export function makeContext(argv, io = {}) {
  const args = makeArgs(argv, io);
  return Object.freeze({
    ...args,
    resolveOrDie: (opts) => resolveOrDie(args, opts),
    readProfile: (dotCascade) => readProfile(args, dotCascade),
    servedEntries: (cmdName) => servedEntries(args, cmdName),
    servedHost: (cmdName) => servedHost(args, cmdName),
    memoryBudgetBytes: () => memoryBudgetBytes(args),
  });
}
