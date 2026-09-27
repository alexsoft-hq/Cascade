// route_pattern.mjs — a NestJS route pattern as the framework's own matcher reads it, for the paths a global prefix excludes.
//
// Nest 11 matches an `exclude` entry against a route's path pattern
// (`/users/:id`) with path-to-regexp 8: `:name` is one path segment, `*name`
// is the rest of the path, `{...}` is optional, `\` escapes the next
// character, and the match ignores case and a trailing slash. A pattern that
// uses anything else (the `(.*)` groups of the matcher Nest 10 used, a `?`, a
// `+`) is not read here: which routes it names is not known, and the caller
// says so rather than guessing.

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const RESERVED = '()[]?+!';
const escape = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The regular expression a pattern means, or null when it uses syntax this engine does not read. */
export function patternRegex(pattern) {
  if (typeof pattern !== 'string') return null;
  const p = pattern.startsWith('/') ? pattern : `/${pattern}`;
  let src = '';
  let depth = 0;
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '\\') {
      if (i + 1 >= p.length) return null;
      i += 1;
      src += escape(p[i]);
    } else if (c === '{') {
      src += '(?:';
      depth += 1;
    } else if (c === '}') {
      if (depth === 0) return null;
      src += ')?';
      depth -= 1;
    } else if (c === ':' || c === '*') {
      const m = NAME.exec(p.slice(i + 1));
      if (!m) return null;
      src += c === ':' ? '[^/]+' : '.+';
      i += m[0].length;
    } else if (RESERVED.includes(c)) {
      return null;
    } else src += escape(c);
  }
  return depth === 0 ? new RegExp(`^${src}/?$`, 'i') : null;
}

/** A route path as this engine writes one (`/users/{id}`) in the form Nest matches exclusions against (`/users/:id`). */
export const nestPathOf = (path) => path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
