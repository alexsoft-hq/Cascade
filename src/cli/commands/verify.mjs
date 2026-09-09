// verify.mjs — `cascade verify`: recompute the deployment receipt from the
// bytes on disk and refuse it on any disagreement.
//
// There is no "mostly verified". A file the receipt names and the disk cannot
// produce is a disagreement, an engine that is not the one that signed it is a
// disagreement, an expired receipt is a disagreement, and any disagreement at
// all is exit 4 with the whole report on stdout.

import fs from 'node:fs';
import path from 'node:path';
import { digest12 } from '../../core/canonical.mjs';
import { verifyReceipt, RECEIPT_FILES } from '../../core/receipt.mjs';
import { hashOrNull, readJsonOrNull, runningEnginePrint, stateDirOf } from '../state.mjs';

export function run(ctx) {
  const { flag, resolveOrDie } = ctx;
  // SPEC §14.4. Recompute every digest the receipt claims, from the bytes on
  // disk, and cross-check the receipt against the gate state it hashed. There is
  // no "mostly verified": a file the receipt names and the disk cannot produce
  // is a disagreement, and any disagreement at all is exit 4.
  const resolved = resolveOrDie();
  const stateDir = stateDirOf(resolved, resolved.packDir);
  const asJson = flag('json');
  const receiptFile = path.join(stateDir, 'receipt.json');
  let receipt = null;
  let receiptError = null;
  try { receipt = readJsonOrNull(receiptFile); }
  catch (e) { receiptError = e.message; }

  const files = {};
  const names = new Set([...RECEIPT_FILES, ...((receipt && receipt.files) || []).map((f) => f.name)]);
  for (const name of [...names].sort()) {
    const h = hashOrNull(path.resolve(stateDir, name));
    if (h !== null) files[name] = h;
  }
  let gateState;
  try { gateState = readJsonOrNull(path.join(stateDir, 'calibration', 'gate-state.json')); }
  catch (e) { gateState = { verdict: null, unreadable: e.message }; }

  let packContentDigest;
  const packFile = path.join(resolved.packDir, 'pack.json');
  if (fs.existsSync(packFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(packFile, 'utf8'));
      packContentDigest = digest12({ nodes: p.nodes, edges: p.edges });
    } catch (e) { packContentDigest = null; }
  }

  const now = new Date().toISOString();
  const result = receiptError
    ? { ok: false, checked: 1, expiresAt: null, disagreements: [{ check: 'receipt', expected: 'a readable cascade:receipt:1 document', found: receiptFile, reason: `the receipt could not be read: ${receiptError}` }] }
    : verifyReceipt({ receipt, actual: { files, enginePrint: runningEnginePrint(), gateState, packContentDigest, now } });

  const report = {
    schema: 'cascade:verify-report:1',
    verified: result.ok,
    project: resolved.projectId ?? null,
    stateDir,
    receipt: receiptFile,
    checkedAt: now,
    expiresAt: result.expiresAt,
    checks: result.checked,
    enginePrint: runningEnginePrint(),
    gate: gateState ? { mode: gateState.mode ?? null, verdict: gateState.verdict ?? null } : null,
    disagreements: result.disagreements,
  };
  if (!result.ok) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`NOT VERIFIED: ${result.disagreements.length} disagreement(s): ${result.disagreements.map((d) => d.check).join(', ')}\n`);
    process.exit(4);
  }
  if (asJson) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write(`verified ${stateDir}: ${result.checked} check(s) agreed: pack, fact index and gate state match the receipt, `
      + `the running engine is the one that signed it, and it is valid until ${result.expiresAt}\n`);
    process.stdout.write(`gate ${report.gate?.mode ?? 'unknown'} -> ${report.gate?.verdict ?? 'unknown'}\n`);
  }
  process.exit(0);
}
