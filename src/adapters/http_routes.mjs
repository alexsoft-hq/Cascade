// http_routes.mjs — how this engine spells a URL path, and how it decides that
// a call and a route are the same route.
//
// WHY IT IS ITS OWN MODULE. Two lanes ask the same question from opposite sides
// of the wire. The web lane reads `client.get('/things/' + id)` in a browser and
// asks which route answers it; the Java lane reads
// `restTemplate.getForObject(url, …)` in one service and asks which route of
// another service answers it. The HAR bridge asks it of a recorded request, the
// runtime bridge of a trace span, and the federation index of a call that leaves
// its own pack. That is one question, and while the rule lived inside the web
// lane the Java bridge had to import the WEB BRIDGE to reach it — a lane
// depending on a lane for a rule that belongs to neither.
//
// WHAT THIS MODULE OWNS:
//   normalizeUrlPath  the ONE spelling of a path. Two spellings of one path are
//                     two nodes, so every lane keys through this.
//   routeMatches      whether a route template and a call template can be the
//                     same route. Both sides carry holes and they are not the
//                     same kind of hole.
//   gatewayRouteOf    what one entry of the profile's `gatewayRoutes` table
//                     means, re-exported from where the profile is read.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, a fact stream, a lane's statistics,
// or which lane is asking. It is strings in and a verdict out.

/**
 * `gatewayRoutes` is a PROFILE field, so its reader stays where the profile is
 * read: `src/core/` may not import an adapter, and an adapter deciding what a
 * profile entry means would be the second opinion about it. It is re-exported
 * here so a lane needs one import for the whole route vocabulary (I-5: one
 * entry, one meaning).
 */
export { gatewayRouteOf } from '../core/profile.mjs';

/** Every regex metacharacter escaped, so a path segment can be matched literally. */
export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** A URL path with one leading slash, no doubled slashes and no trailing slash. */
export function normalizeUrlPath(u) {
  let s = String(u ?? '');
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Whether one ROUTE path template matches one CALL path template.
 *
 * Both sides have holes and they are not the same kind of hole. A route's
 * `{id}`, `{key:.+}` and `*` each stand for ONE segment and `**` for the rest;
 * a call's `{*}` is whatever the code interpolated, which is one whole segment
 * when the segment is nothing but the hole, and part of a segment otherwise
 * (`/thing-{*}.json`). So the comparison is segment by segment, and a hole on
 * either side is satisfied by anything the other side can be.
 *
 * @param {string} routePath  as the pack records it
 * @param {string} callPath   as the web lane resolved it
 * @returns {boolean}
 */
export function routeMatches(routePath, callPath) {
  const r = normalizeUrlPath(routePath).split('/');
  const c = normalizeUrlPath(callPath).split('/');
  let i = 0;
  for (; i < r.length; i += 1) {
    const rs = r[i];
    if (rs === '**') return true; // the rest, however many segments it is
    if (i >= c.length) return false;
    const cs = c[i];
    const routeHole = (rs.startsWith('{') && rs.endsWith('}')) || rs === '*';
    if (routeHole) continue; // one segment, whatever it is
    if (rs === cs) continue;
    if (!cs.includes('{*}')) return false;
    // The call segment carries a hole: it matches this literal route segment
    // when its fixed parts line up around it.
    const re = new RegExp(`^${cs.split('{*}').map(escapeRe).join(cs === '{*}' ? '[^/]+' : '[^/]*')}$`);
    if (!re.test(rs)) return false;
  }
  return i === r.length && c.length === r.length;
}
