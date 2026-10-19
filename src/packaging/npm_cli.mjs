import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Run this JS entry with process.execPath; no shell or Windows .cmd quoting.
export function npmCli(env = process.env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const dir of (env[pathKey] ?? '').split(path.delimiter)) {
    for (const name of ['npm', 'npm.cmd']) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const real = fs.realpathSync(file);
      candidates.push(real, path.join(path.dirname(real), 'node_modules/npm/bin/npm-cli.js'));
    }
  }
  const found = candidates.find((file) => file && /npm-cli\.js$/.test(file) && fs.existsSync(file));
  assert.ok(found, 'Cannot locate npm-cli.js; install npm with Node');
  return found;
}
