// Source-backed values for Nest bootstrap exclusions. No project code is run.
// An array binding needs a complete reference census for the loaded project.
const MAX_DEPTH = 16, MAX_ITEMS = 256, MAX_STEPS = 4096, MAX_TEXT = 8192;
const UNKNOWN = Symbol('unknown');
const keyOf = (file, r) => `${file}#${r.at ?? ''}#${r.name}`;
const refKey = (r) => `${r.at ?? ''}#${r.name}`;

function resolveBinding(project, file, ref, seen = new Set()) {
  if (!ref || seen.size > MAX_DEPTH) return null;
  const key = keyOf(file, ref), f = project.files.get(file);
  if (seen.has(key) || !f?.staticFacts?.complete) return null;
  const next = new Set([...seen, key]);
  const local = f.staticFacts.constants.find((c) => c.name === ref.name && c.at === ref.at);
  if (local) return { file, record: local, key: keyOf(file, local) };
  if (ref.at) return null;
  const imports = f.staticFacts.imports.filter((i) => i.name === ref.name && i.imported !== '*');
  if (imports.length !== 1) return null;
  const imp = imports[0], target = project.resolveModule(file, imp.source);
  return target ? exportedBinding(project, target, imp.imported, next) : null;
}

function exportedBinding(project, file, name, seen) {
  const token = `export:${file}:${name}`, f = project.files.get(file);
  if (seen.has(token) || seen.size > MAX_DEPTH || !f?.staticFacts?.complete) return null;
  const next = new Set([...seen, token]), matches = [];
  for (const e of f.staticFacts.exports) {
    if (!e.all && e.name !== name) continue;
    const target = e.source && project.resolveModule(file, e.source);
    const hit = e.source ? target && exportedBinding(project, target, e.all ? name : e.local ?? name, next)
      : resolveBinding(project, file, { name: e.local ?? name }, next);
    if (e.all && !hit) return null;
    if (hit) matches.push(hit);
  }
  return matches.length === 1 ? matches[0] : null;
}

function reexports(project, file, target, seen = new Set()) {
  if (file === target) return true;
  if (seen.has(file) || seen.size > MAX_DEPTH) return false;
  const next = new Set([...seen, file]);
  return (project.files.get(file)?.staticFacts?.exports ?? []).some((e) => e.source && reexports(project, project.resolveModule(file, e.source), target, next));
}

function exportedNames(project, file, binding, seen = new Set()) {
  if (seen.has(file) || seen.size > MAX_DEPTH) return null;
  const facts = project.files.get(file)?.staticFacts;
  if (!facts?.complete) return null;
  const names = [];
  for (const e of facts.exports) {
    if (e.all) {
      const other = exportedNames(project, project.resolveModule(file, e.source), binding, new Set([...seen, file]));
      if (!other) return null;
      names.push(...other);
    } else if (exportedBinding(project, file, e.name, new Set())?.key === binding.key) names.push(e.name);
    if (names.length > MAX_ITEMS) return null;
  }
  return names;
}

function namespaceEscape(project, file, facts, binding) {
  for (const imp of facts.imports.filter((i) => i.imported === '*')) {
    const target = project.resolveModule(file, imp.source);
    if (!target || !reexports(project, target, binding.file)) continue;
    const names = exportedNames(project, target, binding);
    const builtinsSafe = !facts.imports.some((i) => i.name === 'Object')
      && [...project.files.values()].every((f) => f.staticFacts?.complete && f.staticFacts.builtinHazards.length === 0);
    for (const use of facts.uses.filter((u) => !u.at && u.name === imp.name)) {
      if (!builtinsSafe || !names?.length || typeof use.keyPrefix !== 'string' || names.some((n) => n.startsWith(use.keyPrefix))) return true;
    }
  }
  return false;
}

function safeArray(project, binding) {
  let uses = 0;
  for (const [file, f] of project.files) {
    const facts = f.staticFacts;
    if (!facts?.complete || (uses += facts.uses.length) > 100000 || namespaceEscape(project, file, facts, binding)) return false;
    if (facts.opaqueModules.some((spec) => spec === '*' || reexports(project, project.resolveModule(file, spec), binding.file))) return false;
    for (const use of facts.uses) if (!use.safe && resolveBinding(project, file, use)?.key === binding.key) return false;
  }
  return true;
}

function referenceValue(ctx, value, file, env, depth, active) {
  if (env.has(refKey(value))) return env.get(refKey(value));
  const hit = resolveBinding(ctx.project, file, value);
  if (!hit || hit.record.reassigned || active.has(hit.key)) return UNKNOWN;
  const out = evaluate(ctx, hit.record.value, hit.file, new Map(), depth + 1, new Set([...active, hit.key]));
  return Array.isArray(out) && !safeArray(ctx.project, hit) ? UNKNOWN : out;
}

function intrinsicSafe(project, name) {
  return [...project.files.values()].every((f) => f.staticFacts?.complete && !f.staticFacts.builtinHazards.includes(name));
}

function templateValue(value, run) {
  if (value.parts.some((p) => typeof p !== 'string')) return UNKNOWN;
  const args = value.values.map((v) => run(v));
  if (args.some((v) => !['string', 'number', 'boolean'].includes(typeof v))) return UNKNOWN;
  const text = value.parts.map((p, i) => p + (i < args.length ? String(args[i]) : '')).join('');
  return text.length <= MAX_TEXT ? text : UNKNOWN;
}

function arrayValue(value, run, project) {
  if (value.items.some((item) => item.k === 'spread') && !intrinsicSafe(project, 'Array')) return UNKNOWN;
  const out = [];
  for (const item of value.items) {
    const v = run(item.k === 'spread' ? item.value : item);
    if (v === UNKNOWN || (item.k === 'spread' && !Array.isArray(v))) return UNKNOWN;
    if (item.k === 'spread') out.push(...v); else out.push(v);
    if (out.length > MAX_ITEMS) return UNKNOWN;
  }
  return out;
}

function objectValue(value, run) {
  const out = Object.create(null);
  for (const [name, v] of Object.entries(value.props)) { out[name] = run(v); if (out[name] === UNKNOWN) return UNKNOWN; }
  return out;
}

function callValue(value, run, env, project) {
  const receiver = run(value.object);
  if (typeof receiver === 'string' && value.method === 'substring' && value.args.length >= 1 && value.args.length <= 2) {
    if (!intrinsicSafe(project, 'String')) return UNKNOWN;
    const args = value.args.map((v) => v.k === 'literal' && Number.isInteger(v.v) ? v.v : UNKNOWN);
    return args.includes(UNKNOWN) ? UNKNOWN : receiver.substring(...args);
  }
  const fn = value.args[0];
  if (!intrinsicSafe(project, 'Array') || !Array.isArray(receiver) || value.method !== 'map' || value.args.length !== 1 || fn?.k !== 'arrow' || fn.params.length !== 1) return UNKNOWN;
  if (receiver.some((x) => !['string', 'number', 'boolean'].includes(typeof x))) return UNKNOWN;
  const out = receiver.map((v) => { const scope = new Map(env); scope.set(refKey(fn.params[0]), v); return run(fn.body, scope); });
  return out.includes(UNKNOWN) ? UNKNOWN : out;
}

function evaluate(ctx, value, file, env, depth, active) {
  if (!value || ++ctx.steps > MAX_STEPS || depth > MAX_DEPTH) return UNKNOWN;
  const run = (v, nextEnv = env) => evaluate(ctx, v, file, nextEnv, depth + 1, active);
  switch (value.k) {
    case 'literal': return typeof value.v === 'string' && value.v.length > MAX_TEXT ? UNKNOWN : value.v;
    case 'ref': return referenceValue(ctx, value, file, env, depth, active);
    case 'template': return templateValue(value, run);
    case 'array': return arrayValue(value, run, ctx.project);
    case 'object': return objectValue(value, run);
    case 'call': return callValue(value, run, env, ctx.project);
    default: return UNKNOWN;
  }
}

export function constantEvaluator(project) {
  return (value, file) => {
    const out = evaluate({ project, steps: 0 }, value, file, new Map(), 0, new Set());
    return out === UNKNOWN ? { known: false } : { known: true, value: out };
  };
}
