#!/usr/bin/env node
// answers-snapshot.mjs — record every answer this engine gives, so a refactoring
// round can prove it changed nothing a user can see.
//
// WHY THIS EXISTS. A refactoring round moves code. The only honest way to say
// "nothing changed" is to ask the server the same questions before and after and
// compare the answers byte for byte. The pack digest already guards what the
// ANALYZER produces; this guards what the SERVER says about it — the tool
// answers, which are where a caller actually lives.
//
// WHAT IT RECORDS, per served project:
//   overview / map / erd / coupling   one answer each, default arguments
//   flow                              down from every endpoint and every screen,
//                                     sorted by key, the first 200 of each
//   endpoint_impact / screen_impact   for every column, sorted, the first 200
//   projects                          once for the whole server, recorded last
//                                     so `loaded` reflects a fixed call order
//
// Each answer lands at `<out>/<project>/<tool>/<key>.json` as pretty JSON with
// the tool name and the arguments beside it, so a diff line names the question
// as well as the answer. `_server/projects/projects.json` holds the one
// server-level answer.
//
// WHAT IS MASKED, and why only this. A mask is a place a real change can hide,
// so exactly two kinds of value are replaced with a fixed marker, and both are
// facts about the MACHINE rather than about the answer:
//   a moment      a pack's `builtAt` rides in every `basis`. It is the build's
//                 time, not the answer's content, and left alone it would make
//                 every file differ after any rebuild.
//   a size        `bytes`, `budgetBytes`, `unpackedSize` and the whole `cache`
//                 block of the `projects` answer. These are the memory proxy a
//                 server keeps for a loaded pack: `bytes` is the size of
//                 pack.json plus facts-index.json, and facts-index carries
//                 ABSOLUTE paths, so the number moves with the length of the
//                 directory the project happens to sit in. It made the goldens
//                 red on a CI runner, whose checkout path is a hundred
//                 characters longer than a laptop's temp directory, and green on
//                 the laptop — for a difference that is not an answer. `loaded`
//                 and `evictions` follow that number against the budget, so the
//                 cache block goes with it.
// `digest` is NOT masked, and must not be: it is content-addressed, so a digest
// that moves between two machines is a finding, not noise.
//
// USAGE
//   node scripts/answers-snapshot.mjs --out <dir> --project mall --project petclinic
//   node scripts/answers-snapshot.mjs --out <dir> --pack <packDir> [--pack <packDir>]
//   node scripts/answers-snapshot.mjs --diff <before> <after>
//
// `--diff` prints every file that is missing on one side or differs byte for
// byte, and exits 1 if there is one. CASCADE_HOME is passed through untouched:
// the recorder only ever READS a registry.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

/** How many walk starts (endpoints, screens) and how many columns one project records. */
export const DEFAULT_CAP = 200;

/**
 * Keys whose VALUE is a moment in time. Masked everywhere they appear, at any
 * depth. `lastCertifiedAt`, `builtAt` and friends all end in "At"; the rest are
 * spelled out so that adding one is a deliberate act.
 */
const TIME_KEYS = new Set(['builtAt', 'lastCertifiedAt', 'certifiedAt', 'generatedAt', 'recordedAt', 'observedAt', 'at', 'timestamp', 'time']);

/**
 * Keys whose VALUE is a size in bytes, and `cache`, the server's whole account
 * of what it is holding. Masked everywhere they appear, at any depth.
 *
 * A SIZE HERE IS A MEASUREMENT OF THIS MACHINE, NOT OF THE ANSWER. The one that
 * moved was `projects[].bytes`, the pack's memory proxy: pack.json plus
 * facts-index.json, and facts-index holds the ABSOLUTE path of the repository it
 * was built from, so the same pack under a checkout path a hundred characters
 * longer measures a hundred bytes larger. Measured, not assumed.
 *
 * `map.bytes` — the size of the map answer itself — goes with it, and gives up
 * almost nothing: it is computed FROM the answer, and the answer is compared
 * byte for byte either way, so a map that really changed still shows it in every
 * node and edge. One key name, one rule, is worth more here than a rule that
 * knows which tool it is reading.
 */
const SIZE_KEYS = new Set(['bytes', 'budgetBytes', 'unpackedSize', 'cache']);
const MASK = '<masked>';

/** True for a key we mask by name: a moment, or any `…At`. */
function isTimeKey(key) {
  return TIME_KEYS.has(key) || (/At$/.test(key) && key.length > 2);
}

/** True for a key whose value measures this machine rather than this answer. */
function isSizeKey(key) {
  return SIZE_KEYS.has(key);
}

/**
 * Replace every moment and every size with a fixed marker, keeping the shape.
 * Null stays null: "this pack has no build time" is a fact, not a moment, and a
 * mask that hid the difference between null and a date would hide a real
 * regression. The same goes for a size that is absent rather than zero.
 */
export function maskVolatile(value) {
  if (Array.isArray(value)) return value.map(maskVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const mask = (isTimeKey(k) || isSizeKey(k)) && v !== null && v !== undefined;
      out[k] = mask ? MASK : maskVolatile(v);
    }
    return out;
  }
  return value;
}

/**
 * A file name for an answer key. Router paths, "GET /owners/{id}" and
 * "schema.table.column" all contain characters a file name cannot hold, so the
 * readable part is sanitised and a short hash of the ORIGINAL key is appended:
 * two different keys can flatten to the same readable part, and then only the
 * hash keeps them apart.
 */
export function keyToFile(key) {
  const readable = key.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'key';
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${readable}.${hash}.json`;
}

/** A line-delimited JSON-RPC client over a spawned `cascade mcp`. */
class McpClient {
  constructor(args, env) {
    this.child = spawn(process.execPath, [CLI, 'mcp', ...args], {
      cwd: ENGINE_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
    this.exited = null;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.on('exit', (code) => {
      this.exited = code;
      for (const [, { reject }] of this.pending) {
        reject(new Error(`cascade mcp exited with ${code}: ${this.stderr.trim()}`));
      }
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`rpc error ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    }
  }

  rpc(method, params) {
    if (this.exited !== null) return Promise.reject(new Error(`cascade mcp already exited with ${this.exited}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** One tool call, parsed. A tool that fails comes back as `{ error: <text> }`, recorded as such. */
  async call(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) return { error: text };
    try { return JSON.parse(text); } catch { return { error: `unparsable answer: ${text.slice(0, 400)}` }; }
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      if (this.exited !== null) return resolve();
      this.child.on('exit', resolve);
      setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 5000).unref?.();
    });
  }
}

/**
 * Write one answer file. Returns its path.
 *
 * `scrub` is the caller's own normaliser, applied AFTER the mask above. The
 * corpus needs none: those projects live at fixed paths and were built from
 * fixed commits. A golden built in a temp directory needs one, because the
 * directory and the commit it was `git init`-ed at are different on every run
 * and are not what the golden is about.
 */
function writeAnswer(outDir, dirName, tool, key, tool_args, answer, scrub = (x) => x) {
  const dir = path.join(outDir, dirName, tool);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, keyToFile(key));
  const body = { tool, key, args: scrub(maskVolatile(tool_args)), answer: scrub(maskVolatile(answer)) };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/** Every page of a listing tool, concatenated in the order the server gave them. */
async function listAll(client, tool, args, pick, pageSize = 500) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await client.call(tool, { ...args, limit: pageSize, offset });
    const rows = pick(res);
    if (!rows || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    if (out.length > 20000) break; // a listing this long is a bug, not a corpus
  }
  return out;
}

/**
 * The keys one project is asked about: endpoints and screens to walk down from,
 * and columns to ask both impact tools about. Sorted, then cut to `cap`, so the
 * SAME questions are asked before and after even if the listing order shifted.
 */
async function questionsFor(client, project, cap) {
  const endpoints = await listAll(client, 'flow', { project, kind: 'endpoint' }, (r) => r?.answer?.entries?.map((e) => e.id));
  const screens = await listAll(client, 'flow', { project, kind: 'screen' }, (r) => r?.answer?.entries?.map((e) => e.id ?? e.screen ?? e.path));
  const columns = await listAll(client, 'browse', { project, kind: 'column' }, (r) => r?.answer?.items?.map((c) => c.column));
  const cut = (xs) => [...new Set(xs.filter((x) => typeof x === 'string'))].sort().slice(0, cap);
  return { endpoints: cut(endpoints), screens: cut(screens), columns: cut(columns) };
}

/**
 * Record every answer for one project into `outDir`. Returns how many files it
 * wrote. `dirName` is the directory the answers land in; it defaults to the
 * project id and differs only when the caller wants a stable name for a pack
 * whose own id is not one.
 */
export async function recordProject(client, project, outDir, {
  cap = DEFAULT_CAP, log = () => {}, scrub = (x) => x, dirName = project,
} = {}) {
  let files = 0;
  const put = (tool, key, args, answer) => {
    writeAnswer(outDir, dirName, tool, key, args, answer, scrub);
    files++;
  };
  for (const tool of ['overview', 'map', 'erd', 'coupling']) {
    put(tool, 'default', { project }, await client.call(tool, { project }));
  }
  const q = await questionsFor(client, project, cap);
  log(`  ${dirName}: ${q.endpoints.length} endpoint(s), ${q.screens.length} screen(s), ${q.columns.length} column(s)`);
  for (const endpoint of q.endpoints) {
    const args = { project, endpoint, direction: 'down' };
    put('flow', `endpoint ${endpoint}`, args, await client.call('flow', args));
  }
  for (const screen of q.screens) {
    const args = { project, screen, direction: 'down' };
    put('flow', `screen ${screen}`, args, await client.call('flow', args));
  }
  for (const column of q.columns) {
    for (const tool of ['endpoint_impact', 'screen_impact']) {
      const args = { project, column };
      put(tool, column, args, await client.call(tool, args));
    }
  }
  return files;
}

const INIT_PARAMS = { protocolVersion: '2024-11-05', clientInfo: { name: 'answers-snapshot', version: '1' } };

/**
 * Start ONE server over all the named projects (so federation is exercised the
 * way a user's server exercises it) and record every project's answers.
 *
 * A `--pack` dir is its OWN one-project server: `cascade mcp --pack` serves one
 * pack by design, so several packs mean several servers. A pack entry is either
 * a directory or `{dir, name}`, where `name` is the directory the answers land
 * in — a golden needs a name it chose, not the id a temp build happened to get.
 *
 * @param {{out:string, projects?:string[], packs?:(string|{dir:string,name?:string})[],
 *          cap?:number, log?:Function, scrub?:Function}} cfg
 */
export async function snapshot({ out, projects = [], packs = [], cap = DEFAULT_CAP, log = () => {}, scrub = (x) => x }) {
  fs.mkdirSync(out, { recursive: true });
  let files = 0;
  if (projects.length) {
    const client = new McpClient(projects.flatMap((id) => ['--project', id]));
    try {
      await client.rpc('initialize', INIT_PARAMS);
      for (const id of projects) files += await recordProject(client, id, out, { cap, log, scrub });
      writeAnswer(out, '_server', 'projects', 'projects', {}, await client.call('projects', {}), scrub);
      files++;
    } finally { await client.close(); }
  }
  for (const entry of packs) {
    const dir = typeof entry === 'string' ? entry : entry.dir;
    const client = new McpClient(['--pack', dir]);
    try {
      await client.rpc('initialize', INIT_PARAMS);
      const first = await client.call('overview', {});
      const id = first?.basis?.project ?? path.basename(dir);
      const dirName = (typeof entry === 'string' ? null : entry.name) ?? id;
      files += await recordProject(client, id, out, { cap, log, scrub, dirName });
      writeAnswer(out, dirName, 'projects', 'projects', {}, await client.call('projects', {}), scrub);
      files++;
    } finally { await client.close(); }
  }
  return files;
}

/** Every file under `dir`, as paths relative to it, sorted. */
export function walkFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out.sort();
}

/**
 * Compare two snapshot directories byte for byte.
 * @returns {{onlyInA:string[], onlyInB:string[], differ:string[], same:number}}
 */
export function diffDirs(a, b) {
  const inA = new Set(walkFiles(a));
  const inB = new Set(walkFiles(b));
  const onlyInA = [...inA].filter((f) => !inB.has(f)).sort();
  const onlyInB = [...inB].filter((f) => !inA.has(f)).sort();
  const differ = [];
  let same = 0;
  for (const f of [...inA].filter((x) => inB.has(x)).sort()) {
    const ba = fs.readFileSync(path.join(a, f));
    const bb = fs.readFileSync(path.join(b, f));
    if (ba.equals(bb)) same++; else differ.push(f);
  }
  return { onlyInA, onlyInB, differ, same };
}

function optAll(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}`) out.push(argv[++i]);
  return out;
}
function opt(argv, name) {
  const all = optAll(argv, name);
  return all.length ? all[all.length - 1] : null;
}

async function main(argv) {
  const log = (m) => process.stderr.write(`${m}\n`);
  const diffAt = argv.indexOf('--diff');
  if (diffAt >= 0) {
    const [a, b] = [argv[diffAt + 1], argv[diffAt + 2]];
    if (!a || !b) { log('usage: answers-snapshot.mjs --diff <before> <after>'); return 2; }
    const d = diffDirs(a, b);
    for (const f of d.onlyInA) process.stdout.write(`only in ${a}: ${f}\n`);
    for (const f of d.onlyInB) process.stdout.write(`only in ${b}: ${f}\n`);
    for (const f of d.differ) process.stdout.write(`differs: ${f}\n`);
    const bad = d.onlyInA.length + d.onlyInB.length + d.differ.length;
    process.stdout.write(`${d.same} identical, ${d.differ.length} differ, ${d.onlyInA.length} only in ${a}, ${d.onlyInB.length} only in ${b}\n`);
    return bad > 0 ? 1 : 0;
  }
  const out = opt(argv, 'out');
  if (!out) { log('usage: answers-snapshot.mjs --out <dir> [--project <id>]... [--pack <dir>]...'); return 2; }
  const cap = Number(opt(argv, 'cap') ?? DEFAULT_CAP);
  const started = Date.now();
  const files = await snapshot({
    out,
    projects: optAll(argv, 'project'),
    packs: optAll(argv, 'pack'),
    cap,
    log,
  });
  log(`${files} answer file(s) under ${out} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
