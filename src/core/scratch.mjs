// scratch.mjs — scratch directories that are removed even when the process
// exits from inside the work.
//
// The defect this exists for, seen in the field: `cascade analyze` created a
// `.analyze-XXXX` directory, wrapped the run in try/finally to remove it, and
// then called `process.exit(3)` INSIDE the try when the calibration gate went
// red. `process.exit` does not run `finally`, so every rejected run left a
// directory behind — two dozen had piled up in the repository root before
// anyone noticed. A cleanup that only covers the happy path is not a cleanup.
//
// So the removal is registered ONCE on process exit (which `process.exit` does
// run), and the caller may still remove a directory eagerly on the normal path.
// Pure: `mkdtemp`, `rm` and `onExit` are injected, so the whole lifecycle —
// including "the exit handler removes what is still outstanding" — is testable
// without a filesystem or a real exit.

/**
 * @param {{mkdtemp:(prefix:string)=>string, rm:(dir:string)=>void,
 *          onExit:(handler:()=>void)=>void, warn?:(line:string)=>void}} io
 * @returns {{create:(prefix:string)=>string, remove:(dir:string)=>void, pending:()=>string[]}}
 */
export function makeScratch(io) {
  if (!io || typeof io.mkdtemp !== 'function' || typeof io.rm !== 'function' || typeof io.onExit !== 'function') {
    throw new TypeError('makeScratch needs {mkdtemp, rm, onExit}');
  }
  const outstanding = new Set();
  let armed = false;

  const sweep = () => {
    for (const dir of [...outstanding]) {
      outstanding.delete(dir);
      // An exit handler must not throw: a failed removal is reported and the
      // rest are still swept, so one locked directory cannot keep the others.
      try { io.rm(dir); } catch (e) { if (io.warn) io.warn(`could not remove the scratch directory ${dir}: ${(e && e.message) || e}`); }
    }
  };

  return {
    /** Make a scratch directory and put it under the exit handler's care. */
    create(prefix) {
      if (!armed) { io.onExit(sweep); armed = true; }
      const dir = io.mkdtemp(prefix);
      outstanding.add(dir);
      return dir;
    },
    /** Remove one now (the normal path); the exit handler then has nothing to do. */
    remove(dir) {
      outstanding.delete(dir);
      io.rm(dir);
    },
    /** The directories the exit handler would still remove. */
    pending() { return [...outstanding]; },
  };
}
