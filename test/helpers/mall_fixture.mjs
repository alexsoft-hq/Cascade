// mall_fixture.mjs — ONE guard in front of every mall-pinned test.
//
// Five test files pin numbers to one built pack of macrozheng/mall. The guard
// they each carried was copied four times and had drifted in its wording, which
// is the shape a fixture rule always rots into: four almost-identical blocks,
// one of which will eventually check something slightly different from the
// others and nobody will notice.
//
// THE RULE, once:
//   - no pack on this machine   -> skip, naming the path and how to build one
//   - a pack at a DIFFERENT digest -> skip, naming both digests and the rebuild
//     command. A pack built by another engine generation is not a failure OF
//     THIS ENGINE; it is a fixture that moved, and a number nobody can
//     interpret is worse than an honest skip.
//   - the pinned digest -> run, and the numbers must hold.
//
// CI is where the skip is forbidden: the `fixtures` job builds the pack and
// fails if any of these tests skips (SPEC §16.3 — a permanent self-omission on
// a fresh clone is a defect, not a pass).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../../src/core/pack.mjs';

/**
 * The pack digest these tests are pinned to. Re-pin it here — in ONE place —
 * when the mall pack is deliberately rebuilt, and re-derive every number that
 * depends on it in the same change.
 *
 * RM14 moved it from 9e1874dd5f6c: the Java worker now records `this.m()` and
 * `super.m()` calls, which it used to drop. Exactly ONE mall number moved with
 * it — MAY_CALL/SOUND_SET, 10126 -> 10127 — and it was re-derived FROM THE
 * SOURCE, not from the engine: mall's whole tree (`src/main`, excluding tests)
 * contains one `this.<method>(...)` call,
 *   mall-security/.../DynamicSecurityMetadataSource.java:44 `this.loadDataSource()`,
 * whose enclosing type the lane parses, so it resolves to one new MAY_CALL; and
 * two `super.<method>(...)` calls, both in mall-mbg/.../CommentGenerator.java,
 * whose superclass (MyBatis Generator's DefaultCommentGenerator) is outside the
 * pack, so both are counted UNRESOLVED under `super-enclosing` and add no edge.
 * 1 edge added, 0 removed: 19268 -> 19269, node count unchanged at 12674.
 */
export const MALL_DIGEST = '99141d55e969';

/**
 * The upstream commit the pinned pack was built from. `pack.meta.base.commit`
 * must equal this, so a pack that happens to collide on a digest prefix still
 * cannot pass for the fixture.
 */
export const MALL_COMMIT = '0504e86b1f1b6f1b8aa6a734d37a90fb67346be7';

/** The sibling checkout by default; CASCADE_MALL_PACK points elsewhere (CI, another clone). */
export const MALL_PACK_PATH = process.env.CASCADE_MALL_PACK
  || fileURLToPath(new URL('../../../target-examples/mall/.cascade/pack/pack.json', import.meta.url));

/** The mall checkout itself (needed only by the tests that RUN `analyze`). */
export const MALL_REPO = process.env.CASCADE_MALL_REPO
  || fileURLToPath(new URL('../../../target-examples/mall/', import.meta.url));

const REBUILD = 'node bin/cascade.mjs init --root ../target-examples/mall --project mall'
  + ' && node bin/cascade.mjs analyze --root ../target-examples/mall';

let cached;

/**
 * Read the fixture once per process and decide.
 * @returns {{ok:boolean, why:(string|null), pack:(object|null), path:string}}
 */
export function mallFixture() {
  if (cached) return cached;
  const path = MALL_PACK_PATH;
  if (!fs.existsSync(path)) {
    cached = {
      ok: false,
      pack: null,
      path,
      why: `no mall pack at ${path} — clone macrozheng/mall at ${MALL_COMMIT} and build it (${REBUILD}), `
        + 'or set CASCADE_MALL_PACK=<path to pack.json>',
    };
    return cached;
  }
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    cached = { ok: false, pack: null, path, why: `mall pack at ${path} is unreadable: ${e.message}` };
    return cached;
  }
  if (pack.digest !== MALL_DIGEST) {
    cached = {
      ok: false,
      pack,
      path,
      why: `mall pack at ${path} has digest ${pack.digest}; these numbers are pinned to ${MALL_DIGEST} — rebuild it (${REBUILD})`,
    };
    return cached;
  }
  const commit = pack.meta?.base?.commit;
  if (commit && commit !== MALL_COMMIT) {
    cached = {
      ok: false,
      pack,
      path,
      why: `mall pack at ${path} was built from commit ${commit}; these numbers are pinned to ${MALL_COMMIT}`,
    };
    return cached;
  }
  cached = { ok: true, pack, path, why: null };
  return cached;
}

/**
 * The `skip` value node:test wants: `false` to run, the REASON to skip.
 * @returns {false|string}
 */
export function skipUnlessMall() {
  const f = mallFixture();
  return f.ok ? false : f.why;
}

/** A fresh Graph over the pinned pack. Throws if the fixture is not usable. */
export function mallGraph() {
  const f = mallFixture();
  if (!f.ok) throw new Error(f.why);
  return loadPack(f.pack);
}

/** The pinned pack object itself. Throws if the fixture is not usable. */
export function mallPack() {
  const f = mallFixture();
  if (!f.ok) throw new Error(f.why);
  return f.pack;
}

/**
 * The other half of the fixture: the CHECKOUT, for the one test that runs
 * `analyze` itself rather than reading a pack somebody else built. It needs the
 * commit to be present in the clone, not merely checked out — the test clones
 * and checks it out on its own.
 * @param {(args:string[])=>string} gitOut  run `git` and return stdout (throws on failure)
 * @returns {string|null}  null when it can be used, otherwise the reason it cannot
 */
export function mallRepoWhyNot(gitOut) {
  if (!fs.existsSync(MALL_REPO)) {
    return `no mall checkout at ${MALL_REPO} — clone macrozheng/mall there, or set CASCADE_MALL_REPO`;
  }
  try {
    const type = gitOut(['-C', MALL_REPO, 'cat-file', '-t', MALL_COMMIT]).trim();
    if (type !== 'commit') return `${MALL_REPO} has no commit ${MALL_COMMIT} (git says "${type}")`;
  } catch (e) {
    return `${MALL_REPO} does not contain the pinned commit ${MALL_COMMIT}: ${e.message.split('\n')[0]}`
      + ' — a --depth 1 clone of another commit cannot be used; fetch it with `git fetch origin ' + MALL_COMMIT + '`';
  }
  return null;
}
