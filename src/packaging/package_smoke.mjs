// Validate the artifact's bytes, rather than the checkout's publish allowlist.
import { gunzipSync } from 'node:zlib';

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json', 'bin/cascade.mjs', 'src/cli/env.mjs', 'src/core/paths.mjs',
  'src/mcp/stdio.mjs', 'src/mcp/catalog.mjs', 'src/mcp/protocol_versions.mjs',
  'adapters/java/JavaFacts.java', 'adapters/sql/requirements.txt',
  'adapters/sql/catalog_ddl.py', 'adapters/sql/mybatis_extract.py', 'adapters/sql/lineage.py',
  'adapters/ts/tsfacts.mjs', 'adapters/web/webfacts.mjs',
  'adapters/web/vendor/babel-parser.cjs', 'adapters/web/vendor/LICENSE-babel-parser.txt',
  'viewer/index.html', 'viewer/js/00_state.js', 'viewer/vendor/force-graph.min.js',
  'viewer/vendor/3d-force-graph.min.js', 'viewer/vendor/LICENSE-force-graph.txt',
  'viewer/vendor/LICENSE-3d-force-graph.txt', 'viewer/vendor/fonts/OFL-IBM-Plex.txt',
  'viewer/vendor/fonts/IBM-Plex-Sans-latin.woff2', 'LICENSE', 'NOTICE',
]);

export function validatePackageFiles(files, pkg, expectedVersion = pkg.version) {
  const names = new Set(files);
  for (const name of names) {
    if (/^[a-z]:/i.test(name) || name.startsWith('/') || name.includes('\\') || name.split('/').some((p) => p === '..' || p === '.')) throw new Error(`Unsafe package path: ${name}`);
    if (/(^|\/)(?:\.git|\.github|\.cascade|\.codex|\.claude|\.oss-work|\.cascade-venv-backup-[^/]+|\.idea|\.vscode|\.venv|venv|node_modules|__pycache__|\.java-build|\.DS_Store)(\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:tgz|pyc|class|log|pem|key|p12|pfx)$|(?:^|\/)(?:registry|localsettings|\.mcp|credentials|service-account)\.json$/i.test(name)) throw new Error(`Private or generated package path: ${name}`);
    if (/(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc)$|(^|\/)(?:credentials|secrets?)(?:\.(?:json|ya?ml|ini|txt))?$/i.test(name)) throw new Error(`Private package path: ${name}`);
  }
  for (const required of REQUIRED_PACKAGE_FILES) if (!names.has(required)) throw new Error(`Missing required package asset: ${required}`);
  if (pkg.name !== '@alexsoft-hq/cascade') throw new Error(`Unexpected package name: ${pkg.name}`);
  if (pkg.version !== expectedVersion) throw new Error(`Package version mismatch: expected ${expectedVersion}, got ${pkg.version}`);
  if (pkg.bin?.cascade !== 'bin/cascade.mjs') throw new Error('Missing cascade executable mapping');
  if (Object.keys(pkg.dependencies ?? {}).length) throw new Error('Runtime npm dependencies are forbidden');
  return { name: pkg.name, version: pkg.version, files: names.size };
}

// npm writes POSIX tar headers (including PAX long names). Reading them here
// avoids a dependency on a tar executable or platform-specific tar switches.
export function readPackageTarball(compressed) {
  const tar = gunzipSync(compressed);
  const files = new Map();
  let pax = {}, longName = null;
  const str = (buf) => buf.toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(str(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid tar entry size');
    const content = tar.subarray(offset + 512, offset + 512 + size);
    const type = String.fromCharCode(header[156]);
    const prefix = str(header.subarray(345, 500));
    const name = longName ?? pax.path ?? `${prefix ? prefix + '/' : ''}${str(header.subarray(0, 100))}`;
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      pax = {};
      for (let at = 0; at < content.length;) {
        const space = content.indexOf(32, at), len = Number(content.subarray(at, space).toString());
        if (space < 0 || !Number.isInteger(len) || len <= 0 || at + len > content.length) throw new Error('Invalid PAX header');
        const record = content.subarray(space + 1, at + len - 1).toString();
        const equal = record.indexOf('=');
        pax[record.slice(0, equal)] = record.slice(equal + 1);
        at += len;
      }
      continue;
    }
    if (type === 'L') { longName = str(content); continue; }
    pax = {}; longName = null;
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') throw new Error(`Unsupported tar entry type ${type}: ${name}`);
    if (!name.startsWith('package/')) throw new Error(`Unexpected tar root: ${name}`);
    const relative = name.slice(8);
    if (files.has(relative)) throw new Error(`Duplicate tar entry: ${relative}`);
    files.set(relative, content);
  }
  if (!files.has('package.json')) throw new Error('Missing package.json in tarball');
  return { files, pkg: JSON.parse(files.get('package.json').toString('utf8')) };
}
