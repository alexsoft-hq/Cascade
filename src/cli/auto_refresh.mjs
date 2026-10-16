// Request barriers and background refresh share one serialized analysis per project.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { runningEnginePrint } from './state.mjs';
import { CLI_PATH } from './env.mjs';
import { sourceFiles as tsSourceFiles } from '../../adapters/ts/tsfacts.mjs';
import { isWebPackageConfigFile } from '../core/invalidate.mjs';
import { validateStructure } from '../core/structure.mjs';
import { validateIndex, javaShardKey } from '../core/facts_store.mjs';
import { externalSourcesOf, contentDigestOf, createFileHashCache, springConfigFilesBeside } from './external_sources.mjs';
import { tsSupplementaryFiles, tsCandidateFiles } from './ts_inputs.mjs';

let engineFingerprint;
const currentEngine = () => (engineFingerprint ??= runningEnginePrint());
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep);
export class RefreshError extends Error {
  constructor(message) { super(message); this.code = 'refresh-failed'; }
}
export const buildIdentity = (pack) => hash([pack.digest, pack.meta?.builtAt, pack.meta?.structure?.digest ?? null]);

/** Replay flags are paths relative to the original analyzed root, never the server cwd. */
export function refreshArgv(entry, pack) {
  const root = pack.meta?.base?.repoPath;
  const invocation = pack.meta?.analysis?.invocation;
  if (!root || !invocation) throw new RefreshError('this pack lacks a reproducible analysis invocation; run cascade analyze once');
  const args = [CLI_PATH, 'analyze', javaNeedsCold(entry, pack) ? '--cold' : '--incremental', '--root', root, '--out', inputPath(entry.packDir)];
  for (const [key, flag] of [['ddl', 'ddl'], ['mappers', 'mappers'], ['javaSrc', 'java-src'], ['webSrc', 'web-src'], ['tsSrc', 'ts-src'], ['openapi', 'openapi'], ['har', 'har'], ['otel', 'otel']]) {
    for (const file of invocation[key] ?? []) args.push(`--${flag}`, path.resolve(root, file));
  }
  for (const [key, flag] of [['noDdl', 'no-ddl'], ['noMappers', 'no-mappers'], ['noJava', 'no-java'], ['noWeb', 'no-web'], ['noTs', 'no-ts'], ['noOpenapi', 'no-openapi']]) {
    if (invocation[key]) args.push(`--${flag}`);
  }
  const profile = invocation.profile ? path.resolve(root, invocation.profile) : entry.dotCascadePath ? path.join(entry.dotCascadePath, 'profile.json') : null;
  if (profile && (invocation.profile || fs.existsSync(profile))) args.push('--profile', profile);
  return args;
}

/** Java's incremental planner follows Git changes. Ignored/external Java can
 * change without a Git changeset, so only that unexplained drift needs a cold
 * run. The web and TS lanes already compare source-dependent shard keys. */
function javaNeedsCold(entry, pack) {
  const analysis = pack.meta.analysis ?? {}, root = pack.meta.base.repoPath;
  const roots = activeRoots(analysis, 'javaRoots', 'javaSrc', 'noJava');
  if (!roots.length) return false;
  try {
    const index = validateIndex(readJson(path.join(entry.packDir, 'facts-index.json')));
    if (index.packDigest !== pack.digest) return true;
    const old = new Map(Object.entries(index.files).filter(([, e]) => (e.lane ?? 'java') === 'java'));
    const current = new Map();
    for (const selected of roots) for (const file of javaSourceFiles(path.resolve(root, selected), [])) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const contentSha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      current.set(rel, javaShardKey({ path: rel, contentSha256, workerVersion: index.workers.java }));
    }
    const drift = [...new Set([...old.keys(), ...current.keys()])].filter((file) => old.get(file)?.shardKey !== current.get(file));
    if (!drift.length) return false;
    const reparsed = javaChangesetFiles(root, index);
    return drift.some((file) => !reparsed.has(file));
  } catch { return true; }
}

/** Match the planner's diff, untracked inputs, and previous dirty-file replay.
 * Merely being tracked is insufficient (assume-unchanged can hide a real edit). */
function javaChangesetFiles(root, index) {
  if (!index.base?.commit) return new Set();
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  return new Set([...git(['diff', '--name-only', '-z', '--relative', '--no-renames', index.base.commit, '--']),
    ...git(['ls-files', '-z', '--others', '--exclude-standard']), ...(index.base.dirtyFiles ?? [])]);
}

/** Content, including untracked files and resolved symlinks; generated state is excluded. */
export function sourceFingerprint(entry, pack) {
  return hash({ engine: currentEngine(), ...sourceInputs(entry, pack) });
}

/** Calibration identifies saved inputs, independently of worker output and engine identity. */
export function sourceContentFingerprint(entry, pack) {
  return hash(sourceInputs(entry, pack, { recorded: false, allowUnversioned: true }));
}

/** Canonicalize even not-yet-created output/config paths through their existing ancestor. */
function inputPath(file) {
  if (!file) return null;
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(absolute) === absolute) throw error;
    return path.join(inputPath(path.dirname(absolute)), path.basename(absolute));
  }
}

function sourceInputs(entry, pack, { recorded = true, allowUnversioned = false } = {}) {
  entry = { ...entry, packDir: inputPath(entry.packDir), dotCascadePath: inputPath(entry.dotCascadePath) };
  const root = inputPath(pack.meta.base.repoPath);
  const excluded = [path.resolve(entry.packDir), path.resolve(`${entry.packDir}-rejected`), ...(entry.dotCascadePath ? [path.resolve(entry.dotCascadePath)] : [])];
  const lines = [], fileHash = createFileHashCache();
  const options = { exclude: (file) => excluded.some((dir) => inside(inputPath(file), dir)), canonicalize: inputPath };
  const digestOf = (file) => contentDigestOf(file, fileHash, options);
  let head, files;
  try {
    const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    head = git(['rev-parse', 'HEAD']).trim();
    try { head += ':' + git(['symbolic-ref', '--quiet', 'HEAD']).trim(); } catch { head += ':detached'; }
    files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  } catch {
    if (!allowUnversioned) throw new RefreshError('cannot establish source HEAD and file inventory');
    head = null; files = unversionedFiles(root, excluded);
  }
  for (const rel of [...new Set(files)].sort()) {
    const file = path.resolve(root, rel);
    if (excluded.some((dir) => inside(file, dir)) || rel.split(/[\\/]/).includes('.cascade')) continue;
    try {
      const stat = fs.lstatSync(file);
      // Do not recursively follow an arbitrary repository symlink into unrelated data.
      lines.push([rel, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fileHash(file) : 'non-file']);
    } catch (error) { if (error.code === 'ENOENT') lines.push([rel, 'missing']); else throw error; }
  }
  const analysis = pack.meta.analysis ?? {};
  const external = externalSourcesOf(analysis.invocation, analysis.selection, fileHash, options);
  // Explicitly selected roots can contain ignored inputs; hash those too.
  const selected = ['javaRoots', 'webRoots', 'mapperDirs', 'tsRoots', 'ddls'].flatMap((key) => analysis.selection?.[key] ?? []);
  selected.push(...(analysis.selection?.templateRoots ?? []).map((item) => item.root), ...['javaSrc', 'webSrc', 'tsSrc', 'mappers', 'ddl', 'openapi'].flatMap((key) => analysis.invocation?.[key] ?? []));
  for (const file of new Set(selected.map((selectedPath) => inputPath(path.resolve(root, selectedPath))))) {
    const absolute = path.resolve(root, file);
    if (!excluded.some((dir) => inside(absolute, dir))) external[absolute] = absolute === root ? selectedRootDigest(root, excluded, analysis, digestOf) : digestOf(absolute);
  }
  Object.assign(external, webPackageDigests(root, analysis, digestOf));
  Object.assign(external, supplementaryDigests(entry, pack, root, analysis, excluded, digestOf, recorded));
  const profile = analysis.invocation?.profile;
  const extras = [...(analysis.declaredInputs ?? []).map((file) => path.resolve(root, file)), profile ? path.resolve(root, profile) : null,
    ...(entry.dotCascadePath ? ['profile.json', 'manifest.json', 'catalog', 'golden'].map((name) => path.join(entry.dotCascadePath, name)) : [])].filter(Boolean);
  for (const file of extras) external[inputPath(file)] = contentDigestOf(file, fileHash);
  for (const file of Object.keys(external).filter((item) => path.isAbsolute(item) && !inside(item, root) && !item.includes('#'))) {
    try {
      const directory = fs.statSync(file).isDirectory() ? file : path.dirname(file);
      external[`${file}#HEAD`] = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    } catch { /* not every external input belongs to a repository */ }
  }
  if (Object.values(external).includes('unreadable')) throw new RefreshError('an analysis input is unreadable');
  return { head, lines, external, invocation: analysis.invocation };
}

/** Non-Git analyze targets still have content identity; never walk generated state. */
function unversionedFiles(root, excluded) {
  const files = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (excluded.some((out) => inside(file, out)) || ['.git', 'node_modules', '.cascade'].includes(item.name)) continue;
      if (item.isDirectory()) walk(file);
      else files.push(path.relative(root, file));
    }
  };
  walk(root); return files;
}

const activeRoots = (analysis, selection, invocation, disabled) => analysis.invocation?.[disabled] ? []
  : [...new Set([...(analysis.selection?.[selection] ?? []), ...(analysis.invocation?.[invocation] ?? [])])];

/** The validated published inventory also contains imports reached outside the
 * app root. A stale/missing inventory cannot certify current: structureMatches
 * requires the exact pack generation before the coordinator reuses its receipt. */
function recordedSources(entry, pack) {
  try { return validateStructure(readJson(path.join(entry.packDir, 'structure.json')), { pack }).files; }
  catch { /* old packs can still name their facts, but must rebuild structure */ }
  try {
    const index = validateIndex(readJson(path.join(entry.packDir, 'facts-index.json')));
    if (index.packDigest !== pack.digest) return [];
    return [...Object.entries(index.files).map(([file, e]) => ({ path: file, lanes: [e.lane ?? 'java'] })),
      ...Object.keys(index.tsFiles ?? {}).map((file) => ({ path: file, lanes: ['ts'] }))];
  } catch { return []; }
}

/** Inputs beside source roots must be watched even when Git ignores them.
 * Read inventory through the analyzer's own helpers, not a second config parser. */
function supplementaryDigests(entry, pack, root, analysis, excluded, digestOf, includeRecorded) {
  const files = new Set();
  const javaRoots = activeRoots(analysis, 'javaRoots', 'javaSrc', 'noJava');
  for (const selected of javaRoots) for (const file of springConfigFilesBeside(path.resolve(root, selected))) files.add(file);
  for (const selected of javaRoots) for (const file of javaSourceFiles(path.resolve(root, selected), excluded)) files.add(file);
  const tsRoots = activeRoots(analysis, 'tsRoots', 'tsSrc', 'noTs');
  if (tsRoots.length > 0) for (const file of tsCandidateFiles(root)) if (!excluded.some((dir) => inside(file, dir))) files.add(file);
  const disabled = { java: 'noJava', ts: 'noTs', web: 'noWeb' };
  const recorded = (includeRecorded ? recordedSources(entry, pack) : []).filter((f) => f.lanes.some((lane) => !analysis.invocation?.[disabled[lane]]));
  for (const f of recorded) files.add(path.resolve(root, f.path));
  const tsFiles = includeRecorded ? recorded.filter((f) => f.lanes.includes('ts')).map((f) => path.resolve(root, f.path)) : tsRoots.length ? tsCandidateFiles(root) : [];
  const schemaPath = includeRecorded ? pack.meta?.laneStats?.ts?.prismaSchema?.path : null;
  const schema = schemaPath ? path.resolve(root, schemaPath) : null;
  for (const selected of tsRoots) {
    for (const file of tsSupplementaryFiles(root, path.resolve(root, selected), schema, tsFiles)) files.add(file);
  }
  return Object.fromEntries([...files].sort().map((file) => [file, digestOf(file)]));
}

/** Package configuration is read above a frontend root even when Git ignores it. */
function webPackageDigests(root, analysis, digestOf) {
  const results = {};
  const roots = [...(analysis.selection?.webRoots ?? []), ...(analysis.invocation?.webSrc ?? [])];
  for (const selected of roots) {
    let dir = path.resolve(root, selected);
    while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    if (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.resolve(root, selected);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    results[`${dir}#package-config`] = hash(fs.readdirSync(dir).filter(isWebPackageConfigFile).sort().map((name) => [name, digestOf(path.join(dir, name))]));
  }
  return results;
}

/** A root explicitly selected as source must include ignored source files, not build products. */
function selectedRootDigest(root, excluded, analysis, digestOf) {
  const records = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      if (excluded.some((out) => inside(file, out))) continue;
      if (item.isDirectory()) {
        if (['node_modules', '.git', '.cascade', '__tests__', '__mocks__', '.oss-work', '.venv'].includes(item.name)) continue;
        if (dir === root && ['dist', 'build', 'coverage', 'public', 'target', 'out'].includes(item.name)) continue;
        walk(file);
      } else if (/\.(?:java|[cm]?jsx?|tsx?|vue|xml|xfdl|xjs|sql|json|ya?ml|properties|html?|jsp[x]?|ftlh?|vm)$/.test(item.name) || isWebPackageConfigFile(item.name)) {
        records.push([path.relative(root, file), digestOf(file)]);
      }
    }
  };
  walk(root);
  for (const file of rootLaneSources(root, analysis, excluded)) records.push([path.relative(root, file), digestOf(file)]);
  return hash(records);
}

/** Root selections use the union of lane inventories, never another lane's directory exclusions. */
export function rootLaneSources(root, analysis, excluded = []) {
  const atRoot = (keys, flag) => !analysis.invocation?.[flag] && keys.some(([container, key]) => (analysis[container]?.[key] ?? []).some((file) => path.resolve(root, file) === root));
  const files = [];
  if (atRoot([['selection', 'tsRoots'], ['invocation', 'tsSrc']], 'noTs')) files.push(...tsSourceFiles([root]));
  if (atRoot([['selection', 'javaRoots'], ['invocation', 'javaSrc']], 'noJava')) files.push(...javaSourceFiles(root, excluded));
  return [...new Set(files)].filter((file) => !excluded.some((dir) => inside(file, dir))).sort();
}

/** JavaFacts.collectJava recurses every directory, including target/public and hidden directories. */
function javaSourceFiles(root, excluded) {
  const files = [], seen = new Set();
  const walk = (file) => {
    if (excluded.some((dir) => inside(file, dir))) return;
    let stat;
    try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) {
      const real = fs.realpathSync(file);
      if (seen.has(real)) return;
      seen.add(real);
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
    } else if (stat.isFile() && file.endsWith('.java')) files.push(file);
  };
  walk(root); return files;
}

/** Separate process keeps synchronous workers off the protocol loop. */
export function runRefresh(entry, pack, { signal, timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, refreshArgv(entry, pack), {
      cwd: pack.meta.base.repoPath, env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
    });
    let stderr = '', stopped = false;
    const stop = () => {
      stopped = true;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(stop, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code) => {
      cleanup();
      if (code === 0 && !stopped) resolve();
      else reject(new RefreshError(stopped ? 'analysis cancelled or timed out' : `analysis exited ${code}: ${stderr.trim()}`));
    });
  });
}

function structureMatches(entry, pack) {
  if (!pack.meta?.structure) return false;
  try { validateStructure(readJson(path.join(entry.packDir, 'structure.json')), { pack }); return true; }
  catch { return false; }
}

/** Retry only a verified source race; preserve ordinary build failures for this input. */
async function runAttempt({ run, entry, pack, signal, fingerprint, digest, state, failureKey }) {
  try { await run(entry, pack, { signal }); return true; }
  catch (error) {
    if (!signal.aborted && error.message.includes('SOURCE_INPUTS_CHANGED') && fingerprint(entry, pack) !== digest) return false;
    state.failure = { key: failureKey, message: error.message }; throw error;
  }
}

export function createAutoRefresh({ entries, enabled = true, fingerprint = sourceFingerprint, run = runRefresh, validStructure = structureMatches, intervalMs = 30000, now = () => new Date().toISOString() }) {
  const states = new Map(entries.map((entry) => [entry.id, { entry, pending: null, verdict: 'unknown', reason: enabled ? 'not checked' : 'automatic refresh disabled (--no-watch)', success: null, failure: null }]));
  const abort = new AbortController();
  let closed = false;
  const status = (id) => {
    const state = states.get(id);
    return state ? { verdict: state.verdict, reason: state.reason, inputDigest: state.inputDigest ?? null, checkedAt: state.checkedAt ?? null, refreshedAt: state.refreshedAt ?? null, refreshing: !!state.pending, automatic: enabled } : { verdict: 'unknown', reason: 'project not served' };
  };
  async function refresh(state) {
    if (!enabled) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (closed) throw new RefreshError('refresh coordinator closed');
      const { entry } = state;
      const pack = readJson(path.join(entry.packDir, 'pack.json'));
      if (!pack.meta?.base?.repoPath || !fs.existsSync(pack.meta.base.repoPath)) {
        Object.assign(state, { verdict: 'unknown', reason: 'snapshot: local sources are unavailable' }); return;
      }
      const identity = buildIdentity(pack), digest = fingerprint(entry, pack);
      state.inputDigest = digest; state.checkedAt = now();
      const receiptFile = path.join(entry.packDir, 'refresh-state.json');
      if (!state.success) { try { state.success = readJson(receiptFile); } catch { /* first refresh */ } }
      if (state.success?.build === identity && state.success?.inputDigest === digest && validStructure(entry, pack)) {
        Object.assign(state, { verdict: 'current', reason: undefined }); return;
      }
      const failureKey = `${identity}:${digest}`;
      if (state.failure?.key === failureKey) throw new RefreshError(state.failure.message);
      Object.assign(state, { verdict: 'behind', reason: 'source changes require analysis' });
      if (!await runAttempt({ run, entry, pack, signal: abort.signal, fingerprint, digest, state, failureKey })) continue;
      if (closed) throw new RefreshError('refresh coordinator closed');
      const updated = readJson(path.join(entry.packDir, 'pack.json'));
      if (!validStructure(entry, updated)) throw new RefreshError('analysis did not publish a valid structure sidecar');
      const after = fingerprint(entry, updated);
      if (digest !== after) continue;
      const receipt = { schema: 'cascade:refresh:1', build: buildIdentity(updated), inputDigest: after };
      const temp = `${receiptFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(receipt)); fs.renameSync(temp, receiptFile);
      Object.assign(state, { success: receipt, failure: null, verdict: 'current', reason: undefined, refreshedAt: now() }); return;
    }
    throw new RefreshError('sources kept changing during analysis; retry after saving finishes');
  }
  const ensureOne = (id) => {
    const state = states.get(id);
    if (!state) return Promise.reject(new RefreshError(`unknown project ${id}`));
    if (!state.pending) state.pending = refresh(state).catch((error) => {
      Object.assign(state, { verdict: 'behind', reason: error.message });
      throw error instanceof RefreshError ? error : new RefreshError(error.message);
    }).finally(() => { state.pending = null; });
    return state.pending;
  };
  const ensureFresh = async (ids = [...states.keys()]) => { for (const id of ids) await ensureOne(id); };
  const timer = enabled && intervalMs > 0 ? setInterval(() => { if (!closed) for (const id of states.keys()) void ensureOne(id).catch(() => {}); }, intervalMs) : null;
  timer?.unref();
  return { ensureFresh, status, close: () => { closed = true; clearInterval(timer); abort.abort(); } };
}
