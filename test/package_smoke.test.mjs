import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_PACKAGE_FILES, validatePackageFiles, readPackageTarball } from '../src/packaging/package_smoke.mjs';

const pkg = { name: '@alexsoft-hq/cascade', version: '1.2.3', bin: { cascade: 'bin/cascade.mjs' } };
test('package validation accepts the required artifact assets', () => {
  assert.equal(validatePackageFiles(REQUIRED_PACKAGE_FILES, pkg, '1.2.3').version, '1.2.3');
});
test('missing runtime assets fail package validation', () => {
  assert.throws(() => validatePackageFiles(REQUIRED_PACKAGE_FILES.filter((f) => f !== 'adapters/web/vendor/babel-parser.cjs'), pkg), /Missing required package asset: adapters\/web\/vendor\/babel-parser.cjs/);
});
test('a mismatched release version fails package validation', () => {
  assert.throws(() => validatePackageFiles(REQUIRED_PACKAGE_FILES, pkg, '9.9.9'), /version mismatch/);
});
test('private, generated and traversal paths fail package validation', () => {
  for (const name of ['.cascade/pack.json', 'src/.venv/bin/python', 'adapters/java/JavaFacts.class', '.env.local', 'old.tgz', '../secret', 'C:/local/secret', '.oss-work/build.txt', '.claude/settings.json', '.cascade-venv-backup-old/bin/python', 'keys/server.pem', 'id_ed25519', '.npmrc', 'credentials.json']) {
    assert.throws(() => validatePackageFiles([...REQUIRED_PACKAGE_FILES, name], pkg), /package path/);
  }
});
test('invalid tarballs fail before installation', () => {
  assert.throws(() => readPackageTarball(Buffer.from('invalid')));
});
