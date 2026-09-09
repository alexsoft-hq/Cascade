// args.mjs — reading the command line, and nothing else.
//
// Four readers and one exit, over an ARRAY. Nothing here touches
// `process.argv`, the filesystem or a project, so a test can hand it a line and
// read what a command would have seen — which is what makes the `--help` rule
// below checkable without starting a process at all.
//
// The readers are deliberately naive: `--name value`, repeated as often as you
// like, and a bare `--name` for a switch. There is no combined `-abc`, no
// `--name=value` and no argument order to remember, because every command in
// this tool takes a handful of long flags and a reader who has to think about
// the parser is a reader who has stopped thinking about their project.

/** The two spellings of "explain this instead of doing it". */
export const HELP_FLAGS = Object.freeze(['--help', '-h']);

/** True when the line asks for help, wherever on it the flag sits. */
export function wantsHelp(argv) {
  return argv.some((a) => HELP_FLAGS.includes(a));
}

/**
 * The option readers for one command line.
 *
 * `io` is the process edge, injectable so a test can watch `die` without being
 * killed by it: `write` takes a whole line, `exit` takes a code and must not
 * return.
 *
 * @param {string[]} argv  the arguments after the program name
 * @param {{write?:(s:string)=>void, exit?:(code:number)=>void}} [io]
 */
export function makeArgs(argv, io = {}) {
  const write = io.write ?? ((s) => process.stderr.write(s));
  const exit = io.exit ?? ((code) => process.exit(code));

  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
  };
  const optAll = (name) => argv.reduce((acc, a, i) => (a === `--${name}` && i + 1 < argv.length ? [...acc, argv[i + 1]] : acc), []);
  const flag = (name) => argv.includes(`--${name}`);
  // Every refusal in this tool goes through here, so every refusal is a
  // sentence on stderr and exit 2 — never a stack trace, and never exit 1,
  // which `doctor` owns.
  const die = (m) => { write(m + '\n'); exit(2); };

  return { argv, cmd: argv[0], opt, optAll, flag, die };
}
