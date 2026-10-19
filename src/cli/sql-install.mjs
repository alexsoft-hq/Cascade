// Filesystem/process edges shared by SQL setup and prerequisite collection.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sqlglotPin } from '../core/sql_requirements.mjs';

export function requiredSqlglot(root) {
  return sqlglotPin(fs.readFileSync(path.join(root, 'adapters/sql/requirements.txt'), 'utf8'));
}

export function probeSqlglot(python) {
  try {
    const version = execFileSync(python, ['-c', 'import sqlglot; print(sqlglot.__version__)'], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    }).toString('utf8').trim();
    return { ok: true, version };
  } catch (e) {
    const error = String(e.stderr || e.message).trim().split('\n').filter(Boolean).pop();
    return { ok: false, error };
  }
}

/** Build at the final path: venv script entrypoints embed that absolute path.
 * Only the old environment moves, and rollback returns it to its original path.
 */
export function replaceManagedVenv(target, build) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backupRoot = fs.mkdtempSync(path.join(path.dirname(target), '.cascade-venv-backup-'));
  const backup = path.join(backupRoot, 'venv');
  let moved = false;
  let complete = false;
  try {
    if (fs.existsSync(target)) { fs.renameSync(target, backup); moved = true; }
    try { build(); }
    catch (error) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        if (moved) fs.renameSync(backup, target);
      } catch (restoreError) {
        throw new Error(`${error.message}; rollback failed: ${restoreError.message}. `
          + (moved ? `Previous environment preserved at ${backup}` : `Remove the partial environment at ${target} before retrying`), { cause: restoreError });
      }
      throw error;
    }
    complete = true;
  } finally {
    // Never delete a backup that could not be restored.
    if (!fs.existsSync(backup) || complete) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  }
}
