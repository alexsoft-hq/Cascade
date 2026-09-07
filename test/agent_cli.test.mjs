import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `cascade agent` through the REAL CLI, in the style of analyze_root.test.mjs.
//
// The thing that goes wrong here is never one function: it is the config a
// client actually starts. A unit test of the merge would pass while the command
// wrote a relative path, or the wrong project id, or a second copy of the rules
// block under the first one. So every test below runs the binary, in a
// temporary project registered by the real `cascade init`, and then reads the
// bytes it left on disk.
//
// CASCADE_HOME points at a temporary directory in every run. A test that wrote
// into somebody's ~/.cascade would be a defect in the test.

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A registered project: a git repo with one DDL file in it (enough for `init`
 * to discover a lane and pin a commit), plus its own registry.
 *
 * No `analyze` is run and no pack exists: this command reads the registry, and
 * a reader wiring their agent up before the first analysis is a normal thing to
 * do.
 */
function fixture(t) {
  const base = tmpDir(t, 'cascade-agent-');
  const root = path.join(base, 'shop');
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'schema.sql'),
    'CREATE TABLE `order_item` (`id` bigint NOT NULL, `price` decimal(10,2));\n', 'utf8');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');

  const home = path.join(base, 'home');
  const env = { CASCADE_HOME: home };
  const init = spawnSync(process.execPath, [CLI, 'init', '--root', root, '--project', 'shop'], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  assert.equal(init.status, 0, `cascade init failed:\n${init.stderr}`);
  return { base, root, home, env, projectId: 'shop' };
}

/** Run `cascade agent …` and hand back everything it said. */
function agent(fx, args, cwd = fx.root) {
  const r = spawnSync(process.execPath, [CLI, 'agent', ...args], {
    env: { ...process.env, ...fx.env }, cwd, encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The `--- <path> ---` sections of a dry run, keyed by the path in the header. */
function sections(stdout) {
  const marks = [...stdout.matchAll(/^--- (.+) ---$/gm)];
  const out = new Map();
  marks.forEach((m, i) => {
    const start = m.index + m[0].length + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : stdout.length;
    out.set(m[1], stdout.slice(start, end));
  });
  return out;
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('a dry run prints both files, with the absolute command a client will start and the registered project id', (t) => {
  const fx = fixture(t);
  const r = agent(fx, []);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}:\n${r.stderr}`);

  const files = sections(r.stdout);
  assert.deepEqual([...files.keys()], ['.mcp.json', 'CLAUDE.md'],
    `the default client writes exactly these two files, got ${[...files.keys()].join(', ')}`);

  const cfg = JSON.parse(files.get('.mcp.json'));
  const server = cfg.mcpServers.cascade;
  assert.equal(server.command, process.execPath, 'the command is the running node, by absolute path');
  assert.equal(path.isAbsolute(server.args[0]), true, `the first argument must be absolute: ${server.args[0]}`);
  assert.match(server.args[0], /bin[/\\]cascade\.mjs$/);
  assert.equal(fs.existsSync(server.args[0]), true, `${server.args[0]} does not exist`);
  assert.deepEqual(server.args.slice(1), ['mcp', '--project', fx.projectId]);

  const block = files.get('CLAUDE.md');
  assert.match(block, /^<!-- cascade:begin -->$/m);
  assert.match(block, /^<!-- cascade:end -->$/m);
  assert.ok(block.includes(`(project \`${fx.projectId}\`)`), 'the block names the registered project');
  assert.ok(block.includes('`changed_impact`'), 'the block tells the agent how to ask');

  // A dry run writes nothing.
  assert.equal(fs.existsSync(path.join(fx.root, '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(fx.root, 'CLAUDE.md')), false);
});

test('--write creates both files, and a second --write is byte-identical and says unchanged', (t) => {
  const fx = fixture(t);
  const first = agent(fx, ['--write']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^created \.mcp\.json$/m);
  assert.match(first.stdout, /^created CLAUDE\.md$/m);

  const mcp1 = read(fx.root, '.mcp.json');
  const md1 = read(fx.root, 'CLAUDE.md');

  const second = agent(fx, ['--write']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /^unchanged \.mcp\.json$/m);
  assert.match(second.stdout, /^unchanged CLAUDE\.md$/m);
  assert.equal(read(fx.root, '.mcp.json'), mcp1, '.mcp.json changed on the second run');
  assert.equal(read(fx.root, 'CLAUDE.md'), md1, 'CLAUDE.md changed on the second run');

  // The line the reader needs and nothing on the page says: Claude Code holds a
  // project server at "Pending approval" until it is approved once.
  assert.match(first.stdout, /claude mcp get cascade/);
});

test('an older block inside a CLAUDE.md is replaced in place, and the text around it survives', (t) => {
  const fx = fixture(t);
  const before = '# shop\n\nRun the tests with `npm test`.\n';
  const after = '\n## House style\n\nTwo spaces, no tabs.\n';
  fs.writeFileSync(path.join(fx.root, 'CLAUDE.md'),
    `${before}\n<!-- cascade:begin -->\n## Cascade\n\nan older, shorter rule\n<!-- cascade:end -->\n${after}`, 'utf8');

  const r = agent(fx, ['--write']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^updated CLAUDE\.md$/m);

  const text = read(fx.root, 'CLAUDE.md');
  assert.ok(text.startsWith(before), 'the text above the block was rewritten');
  assert.ok(text.endsWith(after), 'the text below the block was rewritten');
  assert.equal(text.match(/<!-- cascade:begin -->/g).length, 1, 'the block must appear exactly once');
  assert.equal(text.match(/<!-- cascade:end -->/g).length, 1, 'the block must appear exactly once');
  assert.ok(text.includes('`changed_impact`'), 'the block carries the new text');
  assert.equal(text.includes('an older, shorter rule'), false, 'the old block text is gone');

  // ...and doing it again changes nothing at all.
  const again = agent(fx, ['--write']);
  assert.match(again.stdout, /^unchanged CLAUDE\.md$/m);
  assert.equal(read(fx.root, 'CLAUDE.md'), text);
});

test('another server in .mcp.json is kept, and a .mcp.json that is not JSON is refused untouched', (t) => {
  const fx = fixture(t);
  const mine = { mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] } }, otherKey: 42 };
  fs.writeFileSync(path.join(fx.root, '.mcp.json'), `${JSON.stringify(mine, null, 2)}\n`, 'utf8');

  const r = agent(fx, ['--write']);
  assert.equal(r.code, 0, r.stderr);
  const cfg = JSON.parse(read(fx.root, '.mcp.json'));
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['cascade', 'filesystem']);
  assert.deepEqual(cfg.mcpServers.filesystem, mine.mcpServers.filesystem, 'the other server was changed');
  assert.equal(cfg.otherKey, 42, 'a key that is not ours was dropped');

  // A file that does not parse is somebody's configuration this command could
  // not read. It is named, and it is left exactly as it was.
  const broken = '{ "mcpServers": { "filesystem": }\n';
  fs.writeFileSync(path.join(fx.root, '.mcp.json'), broken, 'utf8');
  const refused = agent(fx, ['--write']);
  assert.equal(refused.code, 2, `expected exit 2, got ${refused.code}`);
  assert.ok(refused.stderr.includes(path.join(fx.root, '.mcp.json')), `the message must name the file:\n${refused.stderr}`);
  assert.equal(read(fx.root, '.mcp.json'), broken, 'the unreadable file was rewritten');
});

test('--client cursor writes the Cursor config and an always-applied rule file', (t) => {
  const fx = fixture(t);
  const r = agent(fx, ['--client', 'cursor', '--write']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^created \.cursor\/mcp\.json$/m);
  assert.match(r.stdout, /^created \.cursor\/rules\/cascade\.mdc$/m);

  const cfg = JSON.parse(read(fx.root, '.cursor', 'mcp.json'));
  assert.equal(cfg.mcpServers.cascade.command, process.execPath);
  assert.deepEqual(cfg.mcpServers.cascade.args.slice(1), ['mcp', '--project', fx.projectId]);

  const mdc = read(fx.root, '.cursor', 'rules', 'cascade.mdc');
  assert.match(mdc, /^alwaysApply: true$/m);
  assert.match(mdc, /^description: Ask the Cascade impact graph before changing data-facing code$/m);
  assert.ok(mdc.includes('`changed_impact`'), 'the rule file carries the same body');
  assert.equal(mdc.includes('<!-- cascade:begin -->'), false, 'the whole file is ours, so it carries no markers');

  assert.equal(fs.existsSync(path.join(fx.root, '.mcp.json')), false, 'cursor does not write the Claude Code config');
});

test('--client codex writes AGENTS.md and prints the TOML block for the config it does not write', (t) => {
  const fx = fixture(t);
  const r = agent(fx, ['--client', 'codex', '--write']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^created AGENTS\.md$/m);

  const text = read(fx.root, 'AGENTS.md');
  assert.match(text, /^<!-- cascade:begin -->$/m);
  assert.ok(text.includes('`changed_impact`'));

  assert.match(r.stdout, /^\[mcp_servers\.cascade\]$/m, 'the TOML block is printed');
  assert.match(r.stdout, /^command = ".*"$/m);
  assert.match(r.stdout, /^args = \[".*bin\/cascade\.mjs", "mcp", "--project", "shop"\]$/m);
  assert.match(r.stdout, /config\.toml/, 'it says where the block goes');
  assert.equal(fs.existsSync(path.join(fx.root, 'config.toml')), false, 'nothing is written for Codex');
});

test('a root with no registered project exits 2 and names the command that registers one', (t) => {
  const fx = fixture(t);
  const stranger = path.join(fx.base, 'not-a-project');
  fs.mkdirSync(stranger, { recursive: true });

  const r = agent(fx, ['--root', stranger], fx.base);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /cascade init/, 'the message must name `cascade init`');
  assert.match(r.stderr, /cascade analyze/);
  assert.equal(fs.existsSync(path.join(stranger, '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(stranger, 'CLAUDE.md')), false);
});
