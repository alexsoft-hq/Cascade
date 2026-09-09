#!/usr/bin/env node
// cli-snapshot.mjs — record everything the CLI PRINTS, so a round that moves the
// CLI can prove it changed nothing a reader sees.
//
// WHY, BESIDE `answers-snapshot.mjs`. That recorder asks the MCP server
// questions and compares the answers; it never sees a line of the CLI. But the
// CLI is a product surface of its own: the lane census, the gate line, the
// diagnostics, the exit codes, the sentence a wrong flag gets. A round that
// takes `bin/cascade.mjs` apart can leave every tool answer untouched and still
// break the thing a person actually reads. So this runs a FIXED LIST of
// invocations, records stdout, stderr and the exit code of each, and diffs two
// recordings byte for byte.
//
// WHAT IT RUNS. The three little projects `scripts/golden-trees.mjs` builds — the
// same trees the answer goldens are recorded on — each one taken through the
// whole life of a project: `init`, `estimate`, `analyze` cold, `analyze`
// incremental, `verify`, `golden`, `otel-methods`, `catalog discover`, `agent`
// without `--write`, `impact` (with and without a file), and one `mcp` session
// (initialize plus one `tools/call`). Once, outside any tree: the bare command,
// `cascade --help`, `cascade help`, `doctor`, and `<command> --help` for every
// command in the dispatch table.
//
// WHAT IS MASKED, and nothing else. A mask is a place a real change can hide,
// so only what measures THIS MACHINE AND THIS MOMENT is replaced:
//   a path      the temp base, the tool home, the cache root, the engine
//               checkout and the system temp directory, longest first
//   a moment    an ISO 8601 timestamp
//   a commit    a 40-hex git object name (`git init` produces a new one per run)
//   a duration  `… 12 ms`, and the whole `timings ms:` line
//   a size      `… 1234 byte(s)`
// A pack DIGEST is not masked and must not be: it is content-addressed, so a
// digest that moves is a finding.
//
// SAFETY. Every invocation runs with CASCADE_HOME and XDG_CACHE_HOME pointed at
// this recording's own scratch directory, so nothing here can read or write the
// user's real registry or fact cache. `view` is only ever run with `--help`, in
// a directory with no pack and against an empty registry, where it refuses
// before it opens a socket: this recorder never binds a port.
//
// USAGE
//   node scripts/cli-snapshot.mjs --out <dir>
//   node scripts/cli-snapshot.mjs --diff <before> <after>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { diffDirs } from './answers-snapshot.mjs';
import { ENGINE_ROOT, TREES, commit } from './golden-trees.mjs';

const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

/** The commands the dispatch table answers to, in the order the usage lists them. */
export const COMMANDS = Object.freeze([
  'setup', 'doctor', 'init', 'agent', 'analyze', 'otel-methods', 'estimate',
  'verify', 'golden', 'catalog', 'pack', 'mcp', 'impact', 'view',
]);

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const SHA1 = /\b[0-9a-f]{40}\b/g;

/**
 * Replace every path, moment, commit, duration and size with a fixed marker.
 * `roots` are absolute directories, replaced longest first so that a root
 * INSIDE another root does not leave half of the longer one behind.
 */
export function maskText(text, roots) {
  let out = String(text ?? '');
  for (const [abs, mark] of [...roots].sort((a, b) => b[0].length - a[0].length)) {
    if (abs) out = out.split(abs).join(mark);
  }
  return out
    .replace(SHA1, '<commit>')
    .replace(ISO, '<time>')
    .replace(/^timings ms:.*$/gm, 'timings ms: <masked>')
    .replace(/(\d+) ms\b/g, '<ms> ms')
    .replace(/\b(\d+) byte\(s\)/g, '<n> byte(s)');
}

/**
 * The masking marks for one recording, as `[literal, marker]` pairs applied
 * longest first.
 *
 * A COMMIT IS MASKED BY ITS OWN VALUE, not by its shape. `git init` in a temp
 * directory produces a different sha on every run, and the CLI prints it at
 * three lengths — 40 in a receipt, 12 in the overlay's sentence, 8 after an `@`
 * in the repository line. A rule that masked "twelve hex characters" would also
 * mask a pack digest, which is the one number in this recording that MUST move
 * when the engine's output moves. So the recorder is told the sha it just made
 * and blanks exactly that.
 */
function marksFor(base, commitSha = null) {
  const marks = [
    [base, '<base>'],
    [ENGINE_ROOT.replace(/\/$/, ''), '<engine>'],
    [fs.realpathSync(os.tmpdir()), '<tmp>'],
    [os.homedir(), '<home>'],
  ];
  if (commitSha) {
    marks.push([commitSha, '<commit>'], [commitSha.slice(0, 12), '<commit12>'], [commitSha.slice(0, 8), '<commit8>']);
  }
  return marks;
}

/** Write one recorded invocation. `slug` orders and names the file. */
function write(outDir, section, n, slug, body, roots) {
  const dir = path.join(outDir, section);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(n).padStart(2, '0')}-${slug.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
  const masked = JSON.parse(maskText(JSON.stringify(body), roots));
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(masked, null, 2)}\n`, 'utf8');
}

/** One CLI invocation, recorded. Never inherits a terminal, so nothing prompts. */
function run(argv, { cwd, env }) {
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd, env, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    argv, exit: r.status, signal: r.signal ?? null,
    stdout: r.stdout ?? '', stderr: r.stderr ?? '',
  };
}

/** The commit `git init` + `git commit` just produced in `repo`. */
function headOf(repo) {
  return spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null;
}

/** A scratch home + cache for one shell, so nothing reaches the real registry. */
function scratchEnv(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return { ...process.env, CASCADE_HOME: dir, XDG_CACHE_HOME: path.join(dir, 'cache') };
}

// ---------------------------------------------------------------------------
// the fixed list
// ---------------------------------------------------------------------------

/**
 * Everything that does not need a project: the bare command, both spellings of
 * the whole usage text, `doctor`, and `<command> --help` for every command.
 *
 * EACH `--help` GETS ITS OWN EMPTY DIRECTORY AND ITS OWN HOME. Before the help
 * rule existed, `cascade analyze --help` analyzed the current directory and
 * `cascade init --help` registered it; recording that honestly means letting it
 * happen somewhere it cannot matter, and never twice in the same place.
 */
function recordGeneral(outDir, base) {
  const roots = marksFor(base);
  const dir = path.join(base, 'general');
  const env = scratchEnv(path.join(dir, 'home'));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  let n = 0;
  for (const argv of [[], ['--help'], ['-h'], ['help'], ['doctor'], ['doctor', '--json']]) {
    write(outDir, 'general', n += 1, argv.join('_') || 'bare', run(argv, { cwd, env }), roots);
  }
  for (const cmd of COMMANDS) {
    for (const flag of ['--help', '-h']) {
      const box = path.join(base, 'help', `${cmd}${flag === '-h' ? '-h' : ''}`);
      fs.mkdirSync(path.join(box, 'cwd'), { recursive: true });
      const one = { cwd: path.join(box, 'cwd'), env: scratchEnv(path.join(box, 'home')) };
      write(outDir, 'help', n += 1, `${cmd}${flag}`, run([cmd, flag], one), roots);
    }
  }
}

/** The `mcp` session: initialize, one `tools/call`, recorded as the raw replies. */
async function recordMcp(outDir, section, n, args, { cwd, env }, roots, project) {
  const child = spawn(process.execPath, [CLI, 'mcp', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = [];
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const done = new Promise((resolve) => {
    child.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) replies.push(JSON.parse(line));
        if (replies.length === 2) resolve();
      }
    });
    child.on('exit', resolve);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'overview', arguments: { project } } })}\n`);
  await done;
  child.stdin.end();
  child.kill('SIGTERM');
  write(outDir, section, n, 'mcp-session', { argv: ['mcp', ...args], replies, stderr }, roots);
}

/**
 * One tree, taken through the whole life of a project. `analyze` runs twice: the
 * first is cold because there is no fact index yet, the second is incremental
 * because there is one and nothing moved.
 */
async function recordTree(outDir, base, tree) {
  const home = path.join(base, tree.name, 'home');
  const repo = path.join(base, tree.name, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  tree.build(repo, base);
  commit(repo);
  const env = scratchEnv(home);
  const cwd = repo;
  const roots = marksFor(base, headOf(repo));
  const flags = tree.flags(repo);
  const id = tree.name;
  const list = [
    ['estimate', '--root', repo],
    ['init', '--root', repo, '--project', id],
    ['estimate', '--project', id],
    ['analyze', '--root', repo, ...flags],
    ['analyze', '--root', repo, ...flags],
    ['verify', '--project', id],
    ['otel-methods', '--project', id],
    ['golden'],
    ['golden', 'propose', '--project', id],
    ['catalog', 'discover', '--root', repo],
    ['agent', '--project', id],
    ['pack'],
    ['impact', '--project', id],
    ['impact', '--project', id, '--file', 'src/main/java/com/example/domain/Thing.java'],
  ];
  let n = 0;
  for (const argv of list) {
    const slug = argv.filter((a) => !a.startsWith('/')).join('_') || 'bare';
    write(outDir, tree.name, n += 1, slug, run(argv, { cwd, env }), roots);
  }
  await recordMcp(outDir, tree.name, n + 1, ['--project', id], { cwd, env }, roots, id);
}

/** Record the whole list into `outDir`. Returns how many files it wrote. */
export async function record(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-cli-snap-')));
  try {
    recordGeneral(outDir, base);
    for (const tree of TREES) await recordTree(outDir, base, tree);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  return walk(outDir).length;
}

/** Every recorded file under `dir`, as directory-relative posix paths, sorted. */
export function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, child));
    else out.push(child);
  }
  return out.sort();
}

async function main(argv) {
  const log = (m) => process.stderr.write(`${m}\n`);
  const at = argv.indexOf('--diff');
  if (at >= 0) {
    const [a, b] = [argv[at + 1], argv[at + 2]];
    if (!a || !b) { log('usage: cli-snapshot.mjs --diff <before> <after>'); return 2; }
    const d = diffDirs(a, b);
    for (const f of d.onlyInA) process.stdout.write(`only in ${a}: ${f}\n`);
    for (const f of d.onlyInB) process.stdout.write(`only in ${b}: ${f}\n`);
    for (const f of d.differ) process.stdout.write(`differs: ${f}\n`);
    process.stdout.write(`${d.same} identical, ${d.differ.length} differ, ${d.onlyInA.length} only in ${a}, ${d.onlyInB.length} only in ${b}\n`);
    return d.onlyInA.length + d.onlyInB.length + d.differ.length > 0 ? 1 : 0;
  }
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : null;
  if (!out) { log('usage: cli-snapshot.mjs --out <dir> | --diff <before> <after>'); return 2; }
  const started = Date.now();
  const files = await record(path.resolve(out));
  log(`recorded ${files} invocation(s) into ${path.resolve(out)} in ${Math.round((Date.now() - started) / 1000)}s`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
