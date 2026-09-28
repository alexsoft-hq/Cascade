// package_pattern.mjs — a Java package matched against an Ant pattern written with '.' separators, the way Spring's AntPathMatcher(".") reads one.
//
// `**.controller.admin.**` is how a Spring project says "every package with
// `controller.admin` in it". ruoyi-vue-pro hands exactly that pattern to
// `new AntPathMatcher(".")` when it decides which controllers are served under
// /admin-api, and the profile's `pathPrefixes` entries write packages the same
// way, so a project copies its own pattern across unchanged.
//
// `*` matches within one segment, `?` one character of it, and `**` any number
// of whole segments, none included: `a.**` matches `a` itself, as it does in
// Spring. Nothing else is a wildcard. A `{name}` capture, which AntPathMatcher
// also reads, is refused: a package has nothing to capture.

/** One segment: `**`, or identifier characters with `*` and `?` among them. */
const SEGMENT = /^(\*\*|[A-Za-z0-9_$*?]+)$/;

/**
 * What is wrong with a package pattern, as a sentence, or null when nothing is.
 * @param {*} pattern
 * @returns {string|null}
 */
export function packagePatternError(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return 'must be a non-empty Ant pattern over a package name, with "." between segments';
  const bad = pattern.split('.').find((s) => !SEGMENT.test(s));
  if (bad === undefined) return null;
  return bad === ''
    ? 'has an empty segment: a pattern neither starts nor ends with ".", and has no ".." in it'
    : `has the segment "${bad}", and a segment is "**" or letters, digits, "_" and "$" with "*" and "?" as wildcards`;
}

/** One segment as a regular expression, or null for `**`. */
function segmentRe(segment) {
  if (segment === '**') return null;
  const body = segment.replace(/\$/g, '\\$').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/**
 * The pattern, ready to test packages: `(pkg) => boolean`. A class in the
 * default package has the empty package, which only `**` matches.
 * @param {string} pattern  a pattern `packagePatternError` accepts
 * @returns {(pkg:string|null) => boolean}
 */
export function packagePatternMatcher(pattern) {
  const res = pattern.split('.').map(segmentRe);
  return (pkg) => {
    const parts = typeof pkg === 'string' && pkg !== '' ? pkg.split('.') : [];
    // reach[j]: the pattern read so far can end having consumed j segments.
    let reach = parts.map(() => false).concat(false);
    reach[0] = true;
    for (const re of res) {
      const next = reach.map(() => false);
      for (let j = 0; j < reach.length; j += 1) {
        if (!reach[j]) continue;
        if (re === null) {
          for (let k = j; k < reach.length; k += 1) next[k] = true;
        } else if (j < parts.length && re.test(parts[j])) next[j + 1] = true;
      }
      reach = next;
    }
    return reach[parts.length];
  };
}
