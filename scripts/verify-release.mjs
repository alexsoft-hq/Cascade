// Verification only: never creates a tag, changes versions, or publishes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { releaseSelection } from '../src/packaging/release_checks.mjs';
import { npmCli } from '../src/packaging/npm_cli.mjs';
import { packCandidate } from './package-candidate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-release-'));

function smoke(tarball, version) {
  execFileSync(process.execPath, [path.join(root, 'scripts/package-smoke.mjs'),
    '--tarball', tarball, '--expected-version', version], { stdio: 'inherit', timeout: 600_000 });
}

function verifyTag(selection) {
  const source = path.join(scratch, 'tag-source');
  fs.mkdirSync(source);
  const archive = path.join(scratch, 'source.tar');
  // Resolve ONLY a local tag, never an arbitrary revision expression or branch.
  const sha = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${selection.tag}^{commit}`],
    { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['archive', '--format=tar', '-o', archive, sha], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', source]);
  const candidate = packCandidate(source, path.join(scratch, 'tag-package'));
  if (candidate.version !== selection.version) throw new Error('Selected tag version differs from package/lock');
  console.log(JSON.stringify({ tag: selection.tag, commit: sha, version: candidate.version }));
  smoke(candidate.tarball, selection.version);
}

function verifyNpm(selection) {
  const registry = 'https://registry.npmjs.org';
  const spec = `@alexsoft-hq/cascade@${selection.npmVersion}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  Object.assign(env, {
    npm_config_cache: path.join(scratch, 'npm-cache'),
    npm_config_userconfig: path.join(scratch, 'npmrc'),
    npm_config_globalconfig: path.join(scratch, 'global-npmrc'),
  });
  fs.writeFileSync(env.npm_config_userconfig, '');
  fs.writeFileSync(env.npm_config_globalconfig, '');
  const [packed] = JSON.parse(execFileSync(process.execPath,
    [npmCli(), 'pack', spec, '--json', '--ignore-scripts', '--registry', registry,
      `--@alexsoft-hq:registry=${registry}`, '--pack-destination', scratch],
    { cwd: scratch, env, encoding: 'utf8', timeout: 120_000 }));
  if (packed.name !== '@alexsoft-hq/cascade' || packed.version !== selection.version) {
    throw new Error('Public npm metadata differs from the selected version');
  }
  console.log(JSON.stringify({ npm: spec, integrity: packed.integrity, registry }));
  smoke(path.join(scratch, packed.filename), selection.version);
}

try {
  const { values } = parseArgs({ options: {
    tag: { type: 'string' }, 'npm-version': { type: 'string' },
    tarball: { type: 'string' }, 'expected-version': { type: 'string' },
  } });
  const selection = releaseSelection({ tag: values.tag, npmVersion: values['npm-version'],
    tarball: values.tarball, expectedVersion: values['expected-version'] });
  if (selection.tarball) smoke(path.resolve(selection.tarball), selection.version);
  if (selection.tag) verifyTag(selection);
  if (selection.npmVersion) verifyNpm(selection);
  console.log(`Release verification passed for ${selection.version}; nothing was published.`);
} catch (error) {
  console.error(`Release verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
