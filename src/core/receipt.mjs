// receipt.mjs — the deployment receipt and its verifier (SPEC §14.4).
//
// A certified run leaves a receipt: the digest of every file it produced, the
// fingerprint of the engine that produced them, the gate verdict, and an expiry.
// `cascade verify` then recomputes all of it from the bytes on disk.
//
// The receipt exists because of one specific fraud: editing a red result green.
// So the verifier is built to be un-fooled by editing ONE thing:
//
//   - edit `pack.json`        -> its sha256 no longer matches the receipt
//   - edit `gate-state.json`  -> its sha256 no longer matches the receipt
//   - edit the RECEIPT itself, to say GREEN -> the receipt's own claim no longer
//     matches the verdict inside the gate-state file it hashes (the cross-check
//     §14.4 asks for by name)
//   - swap in a different engine -> the recomputed engine print differs
//   - let it go stale          -> `expiresAt` is in the past and it is refused
//
// And the rule that makes the rest worth anything: it is NEVER "verified" on
// partial evidence. A file the receipt names and the disk does not have is a
// disagreement, not a skipped check.
//
// Pure: digests and the clock arrive as inputs; `bin/cascade.mjs` reads files.

export const RECEIPT_SCHEMA = 'cascade:receipt:1';

/** Days a receipt is good for when the profile does not say (SPEC §14.4). */
export const DEFAULT_TTL_DAYS = 30;

/** The files a receipt covers, as paths relative to `.cascade/`. */
export const RECEIPT_FILES = Object.freeze(['pack/pack.json', 'pack/facts-index.json', 'calibration/gate-state.json']);

/**
 * How long a receipt from this project stays good. The profile key is
 * `calibration.receiptTtlDays`; absent or unusable, it is DEFAULT_TTL_DAYS.
 * @param {Object} profile  a normalized profile
 * @returns {number} whole days
 */
export function receiptTtlDaysOf(profile) {
  const v = profile && profile.calibration ? profile.calibration.receiptTtlDays : undefined;
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_TTL_DAYS;
}

/**
 * Build a receipt for a run that finished non-RED.
 *
 * @param {{builtAt:string, ttlDays?:number, enginePrint:string,
 *          files:{name:string, sha256:(string|null)}[],
 *          pack:{digest:string, project:(string|null)},
 *          gate:{mode:string, verdict:string, evaluatedAt?:(string|null)}}} input
 * @returns {Object}
 */
export function buildReceipt(input) {
  const { builtAt, enginePrint, files, pack, gate } = input;
  if (typeof builtAt !== 'string' || builtAt.length === 0) throw new ReceiptError('buildReceipt requires builtAt');
  if (typeof enginePrint !== 'string' || enginePrint.length === 0) throw new ReceiptError('buildReceipt requires the engine print');
  if (!Array.isArray(files)) throw new ReceiptError('buildReceipt requires the file digests');
  if (!gate || typeof gate.verdict !== 'string') throw new ReceiptError('buildReceipt requires the gate verdict');
  if (gate.verdict === 'RED') throw new ReceiptError('a RED run does not get a receipt. The pack it produced was rejected');
  const ttlDays = Number.isFinite(input.ttlDays) && input.ttlDays > 0 ? input.ttlDays : DEFAULT_TTL_DAYS;
  const built = Date.parse(builtAt);
  if (!Number.isFinite(built)) throw new ReceiptError(`builtAt ${JSON.stringify(builtAt)} is not a timestamp`);
  return {
    schema: RECEIPT_SCHEMA,
    builtAt,
    expiresAt: new Date(built + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
    ttlDays,
    enginePrint,
    pack: { digest: pack?.digest ?? null, project: pack?.project ?? null },
    gate: { mode: gate.mode ?? null, verdict: gate.verdict, evaluatedAt: gate.evaluatedAt ?? null },
    files: files
      .map((f) => ({ name: f.name, sha256: f.sha256 ?? null }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/**
 * Recompute and compare. Returns a structured verdict; the caller turns a
 * non-ok result into exit code 4 (SPEC §17.4 — structured, not prose).
 *
 * @param {{receipt:Object,
 *          actual:{files:Object, enginePrint:string, gateState:(Object|null),
 *                  packContentDigest?:(string|null), now:string}}} input
 * @returns {{ok:boolean, checked:number, disagreements:Object[], expiresAt:(string|null)}}
 */
export function verifyReceipt(input) {
  const receipt = input && input.receipt;
  const actual = (input && input.actual) || {};
  const bad = [];
  const add = (check, expected, found, reason) => bad.push({ check, expected, found, reason });

  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, checked: 0, expiresAt: null, disagreements: [{ check: 'receipt', expected: RECEIPT_SCHEMA, found: null, reason: 'there is no receipt to verify. The last run either failed the gate or predates the calibration layer. Run `cascade analyze`' }] };
  }
  if (receipt.schema !== RECEIPT_SCHEMA) {
    add('schema', RECEIPT_SCHEMA, receipt.schema ?? null, 'unknown receipt schema. This engine refuses to read it rather than guess what it meant');
    return { ok: false, checked: 1, expiresAt: receipt.expiresAt ?? null, disagreements: bad };
  }

  let checked = 0;

  // 1. every file the receipt names, recomputed from the bytes on disk
  const seen = new Set();
  for (const f of receipt.files ?? []) {
    checked += 1;
    seen.add(f.name);
    const found = actual.files ? actual.files[f.name] : undefined;
    if (found === undefined) {
      add(`file:${f.name}`, f.sha256, null, `the receipt covers ${f.name} but there is no such file to hash. This is never "verified" on partial evidence`);
    } else if (found !== f.sha256) {
      add(`file:${f.name}`, f.sha256, found, `${f.name} has changed since the receipt was written`);
    }
  }
  for (const name of Object.keys(actual.files ?? {})) {
    if (RECEIPT_FILES.includes(name) && !seen.has(name) && actual.files[name] !== null) {
      checked += 1;
      add(`file:${name}`, null, actual.files[name], `${name} exists but the receipt does not cover it, so the receipt describes a different run`);
    }
  }

  // 2. the pack's own content digest, recomputed from its nodes and edges
  if (actual.packContentDigest !== undefined && receipt.pack && receipt.pack.digest != null) {
    checked += 1;
    if (actual.packContentDigest !== receipt.pack.digest) {
      add('pack-content-digest', receipt.pack.digest, actual.packContentDigest,
        'the pack\'s content digest recomputed from its own nodes and edges does not match the one the receipt recorded');
    }
  }

  // 3. the engine that is RUNNING versus the engine that signed
  checked += 1;
  if (typeof actual.enginePrint !== 'string' || actual.enginePrint.length === 0) {
    add('engine-print', receipt.enginePrint, null, 'the running engine could not be fingerprinted, so the receipt cannot be attributed to it');
  } else if (actual.enginePrint !== receipt.enginePrint) {
    add('engine-print', receipt.enginePrint, actual.enginePrint,
      'this receipt was written by a different build of the engine. Re-run `cascade analyze` with the engine you are actually running');
  }

  // 4. the cross-check §14.4 asks for by name: the receipt's own claim against
  //    the gate state it hashed. Editing the receipt alone cannot survive this.
  checked += 1;
  const stateVerdict = actual.gateState && typeof actual.gateState === 'object' ? actual.gateState.verdict ?? null : null;
  if (stateVerdict == null) {
    add('gate-verdict', receipt.gate?.verdict ?? null, null,
      'the receipt claims a gate verdict but there is no gate state on disk to corroborate it');
  } else {
    if (stateVerdict !== receipt.gate?.verdict) {
      add('gate-verdict', receipt.gate?.verdict ?? null, stateVerdict,
        'the receipt and the gate state disagree about the verdict. Either a later run replaced the gate state without earning a receipt, or the receipt itself was edited. The two are cross-checked because editing one file is the cheap fraud');
    }
    if (stateVerdict === 'RED') {
      add('gate-red', 'GREEN|BOOTSTRAP', 'RED',
        'the gate state on disk records a RED run. Whatever the receipt says, this project has an uncertified analysis as its most recent result');
    }
  }

  // 5. expiry — fail closed, not "probably still fine"
  checked += 1;
  const now = Date.parse(actual.now ?? '');
  const expires = Date.parse(receipt.expiresAt ?? '');
  if (!Number.isFinite(expires)) {
    add('expiry', receipt.expiresAt ?? null, null, 'the receipt carries no usable expiry');
  } else if (Number.isFinite(now) && now > expires) {
    add('expiry', receipt.expiresAt, actual.now, `the receipt expired at ${receipt.expiresAt} and it is now ${actual.now}. Re-run \`cascade analyze\` rather than trusting a stale certification`);
  }

  return { ok: bad.length === 0, checked, expiresAt: receipt.expiresAt ?? null, disagreements: bad };
}

export class ReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReceiptError';
  }
}
