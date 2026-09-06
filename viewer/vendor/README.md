# viewer/vendor — the browser bundles and web fonts the viewer loads

The viewer is a single self-contained HTML file plus the files below. They
are **vendored on purpose**: the page is served from a local `cascade view`
process with no network, and pulling a renderer or a typeface off a CDN at read
time would make the picture depend on somebody else's uptime and on what that
CDN decides to ship today. They are served by the `/vendor/<name>` route in
`src/mcp/http.mjs`, out of this directory only.

Both are MIT, by Vasco Asturiano. The licence texts sit next to them, and the
repository `NOTICE` lists all three components (the third is `three`, which is
bundled *inside* the 3D build — see below).

| file | package | version | size | upstream |
|---|---|---|---|---|
| `force-graph.min.js` | [`force-graph`](https://github.com/vasturiano/force-graph) | 1.51.4 | 173 KB | `https://registry.npmjs.org/force-graph/-/force-graph-1.51.4.tgz` → `package/dist/force-graph.min.js` |
| `3d-force-graph.min.js` | [`3d-force-graph`](https://github.com/vasturiano/3d-force-graph) | 1.80.0 | 1,283 KB | `https://registry.npmjs.org/3d-force-graph/-/3d-force-graph-1.80.0.tgz` → `package/dist/3d-force-graph.min.js` |
| `LICENSE-force-graph.txt` | — | — | 1 KB | `package/LICENSE` of the same tarball (MIT, © 2018 Vasco Asturiano) |
| `LICENSE-3d-force-graph.txt` | — | — | 1 KB | `package/LICENSE` of the same tarball (MIT, © 2017 Vasco Asturiano) |

Both files are the packages' own UMD `dist` builds, copied byte for byte — not
rebuilt, not minified again, not patched. Each defines one global:
`ForceGraph` (2D, canvas) and `ForceGraph3D` (3D, WebGL).

**`three` is bundled inside `3d-force-graph.min.js`** — revision **r183**
(`THREE.REVISION === "183"` in that file) — together with the rest of its
dependency tree (`three-forcegraph`, `three-render-objects`, `kapsule`,
`accessor-fn`). There is therefore **no separate `three.min.js` here**, and the
page must not load one: the bundle prefers `window.THREE` if it finds it, so a
second copy would be a second WebGL renderer's worth of classes fighting the
first. `force-graph.min.js` likewise carries its own `d3-*`, `bezier-js`,
`@tweenjs/tween.js`, `canvas-color-tracker` and `lodash-es` pieces.

## fonts/ — IBM Plex, Latin subsets (OFL-1.1)

The page's type: **IBM Plex Sans** for prose and chrome, **IBM Plex Mono** for
identifiers, SQL and every number in a table. Latin subsets only — Korean falls
back to the system face (`"Apple SD Gothic Neo"`, `"Malgun Gothic"`,
`"Noto Sans KR"`), which is why no CJK cut is vendored here.

| file | family | weights | size |
|---|---|---|---|
| `fonts/IBM-Plex-Sans-latin.woff2` | IBM Plex Sans | **400–600, variable** | 39 KB |
| `fonts/IBM-Plex-Mono-400-latin.woff2` | IBM Plex Mono | 400 | 10 KB |
| `fonts/IBM-Plex-Mono-500-latin.woff2` | IBM Plex Mono | 500 | 10 KB |
| `fonts/OFL-IBM-Plex.txt` | — | — | 4 KB |

The Sans file really is a **variable font** — its table directory carries
`fvar`, `gvar`, `avar`, `HVAR`, `MVAR` and `STAT` — so the page declares it in
ONE `@font-face` with `font-weight: 400 600` and the browser interpolates the
weight axis. The two Mono files are static cuts and get one `@font-face` each.
Every face is `font-display: swap`: the page is readable in the fallback face
before the download lands, and no text is ever invisible.

`/vendor` serves `.woff2` as `font/woff2` with a **one-year immutable** cache,
where the two bundles get a day: a font file never changes under its own name
(the name carries the family, the weight and the subset), while a bundle can be
replaced in place by an update.

Upstream: <https://github.com/IBM/plex>. The three `.woff2` files are Google
Fonts' own Latin subsets of IBM Plex, copied byte for byte and not re-subset
here; `OFL-IBM-Plex.txt` is the SIL Open Font License 1.1 they ship under.

## Updating

1. `npm pack <package>@<version>` (or fetch the tarball URL above) and untar it.
2. Copy `package/dist/*.min.js` and `package/LICENSE` in, under the names above.
3. Update the versions, sizes, and the bundled `three` revision in this table,
   and the version numbers in the repository `NOTICE`.
4. Re-run `npm test` — `test/http.test.mjs` serves these files through the real
   `/vendor` route and would notice them going missing.

These two `.min.js` files are third-party text and are **excluded from the
repository's NUL-byte sweep**: they may legitimately contain any byte a
minifier emitted, and they are not ours to rewrite.
