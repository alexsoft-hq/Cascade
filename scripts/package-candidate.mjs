// Build once; platform jobs consume the immutable uploaded bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageIdentity } from '../src/packaging/release_checks.mjs';
import { npmCli } from '../src/packaging/npm_cli.mjs';

export function packCandidate(root, out) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const identity = packageIdentity(read('package.json'), read('package-lock.json'));
  fs.mkdirSync(out, { recursive: true });
  const [packed] = JSON.parse(execFileSync(process.execPath,
    [npmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', out],
    { cwd: root, encoding: 'utf8', timeout: 120_000 }));
  if (packed.name !== identity.name || packed.version !== identity.version) throw new Error('Tarball metadata differs from package/lock');
  const tarball = path.join(out, 'candidate.tgz');
  fs.renameSync(path.join(out, packed.filename), tarball);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const manifest = { ...identity, sha256, integrity: packed.integrity, files: packed.files };
  fs.writeFileSync(path.join(out, 'candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...identity, tarball, sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node scripts/package-candidate.mjs --out DIRECTORY');
    const result = packCandidate(fileURLToPath(new URL('../', import.meta.url)), path.resolve(args[1]));
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
