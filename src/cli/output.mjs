// output.mjs — the conventions the CLI writes stderr by.
//
// EVERY CENSUS LINE IN THIS TOOL IS A PROMISE: a default that is never printed
// is indistinguishable from a hidden filter, so a run says what it read, what it
// left out, and why. That makes the lane census long, and long output has its
// own failure mode — thirteen lines saying the same thing is a wall a reader
// skips rather than a finding.
//
// So the writers live here, together, and they decide NOTHING. Each one takes
// numbers somebody else computed and turns them into the sentence a reader
// acts on; none of them reads a file, resolves a project or chooses a lane.

/**
 * A list said in one line: the first five, then how many more.
 *
 * A run over a tree with a directory of vendored plugin scripts has thirteen
 * web roots, and thirteen lines saying the same thing is a wall a reader skips
 * rather than a finding. The count is always exact; only the names are cut.
 *
 * @param {string[]} items
 * @returns {string}
 */
export function listOfFive(items) {
  const all = [...items];
  return all.length <= 5 ? all.join(', ') : `${all.slice(0, 5).join(', ')}, and ${all.length - 5} more`;
}

