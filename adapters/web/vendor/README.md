# adapters/web/vendor — the JavaScript/TypeScript parser the web lane reads with

`adapters/web/webfacts.mjs` parses `.js`, `.ts`, `.jsx`, `.tsx` and the script
blocks of `.vue` files. It does that with **`@babel/parser`**, vendored here.

It is **vendored on purpose**, for two reasons that both matter:

1. **There is no `npm install` step and no network at analysis time.** The
   engine declares zero npm dependencies (`package.json` has no `dependencies`
   key, and `test/gates.test.mjs` holds it to that), and SPEC §2.3 allows the
   extraction path zero network calls. A parser fetched at run time would break
   both.
2. **A parser that moved under the engine would change what every fact means.**
   Every fact shard folds its worker's version into its key (SPEC §17.7), and
   the worker's version is a constant in the worker file. If the parser could
   drift independently, two shards with the same key could have been produced by
   two different parsers. Pinning the bytes is what makes the version honest.

| file | package | version | size | sha256 | upstream tarball | path inside it |
|---|---|---|---|---|---|---|
| `babel-parser.cjs` | `@babel/parser` | 7.29.8 | 513,214 bytes | `6969920ae0610df927b6b3e675d1309372c268e36d391652af8e3e0183cbe8f8` | `https://registry.npmjs.org/@babel/parser/-/parser-7.29.8.tgz` | `package/lib/index.js` |
| `LICENSE-babel-parser.txt` | `@babel/parser` | 7.29.8 | 1,086 bytes | — | the same tarball | `package/LICENSE` |

MIT, `Copyright (C) 2012-2014 by various contributors`. The repository `NOTICE`
credits it.

## Why `.cjs` and not `.js`

`package.json` at the top of this repository says `"type": "module"`, so a file
named `.js` anywhere under it is read as an ES module. The vendored bundle is
CommonJS (it ends in `exports.parse = parse`), so under that name it would fail
to load with `exports is not defined`. Renaming it to `.cjs` is the **only**
change made to the file: the bytes are otherwise identical to the tarball's, and
the sha256 in the table above is the sha256 of `package/lib/index.js` as
published. The worker loads it with
`createRequire(import.meta.url)('./vendor/babel-parser.cjs')`.

## Why 7.x and not 8.x

`@babel/parser` 8.0.4 declares `engines.node` as `^22.18.0 || >=24.11.0`. This
engine promises `>=20` (`package.json`), and a lane that quietly needs a newer
Node than the engine does is a lane that fails on somebody's machine with a
syntax error instead of a message. 7.29.8 is the current 7.x, supports the same
TypeScript and JSX syntax the corpus uses, and runs on Node 6 and up.

The bundle has **no `require(` call in it at all** (`grep -c "require("` over
`package/lib/index.js` returns 0), so nothing is missing by not vendoring
`@babel/types`. Its own `package.json` says as much, in as many words:
`"# dependencies": "This package doesn't actually have runtime dependencies.
@babel/types is only needed for type definitions."`

## Excluded from the repository's own sweeps

`babel-parser.cjs` is third-party text governed by `NOTICE`, not by this
project's style rules. It is excluded from the **NUL-byte sweep**, the **em-dash
and middle-dot sweep** and the **English-only sweep**, for the same reason the
viewer's bundles are: those bytes are not ours to rewrite, and a minified bundle
may legitimately contain anything a minifier emitted.

The exclusion is not a special case anybody has to remember. `test/gates.test.mjs`
skips every directory named `vendor` (`SKIP_DIRS`), so this directory is already
outside every gate that walks the tree, and `test/i18n_voice.test.mjs` walks
`adapters/web/*.mjs` without descending into it.

What is NOT excluded is the bytes themselves: `test/gates.test.mjs` recomputes
the sha256 of `babel-parser.cjs` and requires it to equal the one on the
`babel-parser.cjs` row of the table above. A parser edited in place fails the
build.

## Updating

1. `npm pack @babel/parser@<version>` (or fetch the tarball URL above) and untar
   it.
2. Copy `package/lib/index.js` to `babel-parser.cjs` and `package/LICENSE` to
   `LICENSE-babel-parser.txt`. Copy, do not rebuild and do not reformat.
3. Check the new bundle still has no `require(` call, and that its
   `engines.node` still admits Node 20.
4. Update the version, the size and **the sha256** in the table above, and the
   version in the repository `NOTICE`.
5. Bump `VERSION` in `adapters/web/webfacts.mjs` and the mirror in
   `src/core/worker_versions.mjs`. A different parser is a different generation
   of facts, and every cached shard from the old one must be invalidated.
6. Re-run `npm test`. `test/gates.test.mjs` checks the hash and the NOTICE
   entry; `test/webfacts.test.mjs` runs the worker over the fixture.
