#!/usr/bin/env node
// make-synthetic-project.mjs — a real on-disk Java + MyBatis + DDL project of a
// requested SIZE, so the engine's behaviour can be measured at the scale of the
// system it is meant for rather than at the scale of the example we happen to
// have checked out.
//
// mall is 239 endpoints and 76 tables. The question this script exists to
// answer is the one a reader of the performance table actually has: does any of
// this still hold at 400 tables and 3 800 endpoints? Nothing here is a mock —
// it writes Java the parser really parses, mapper XML the extractor really
// flattens, and DDL the catalog lane really reads, then `cascade analyze` runs
// over it exactly as it runs over a checkout.
//
// WHAT IT WRITES (default profile: 400 tables, 3 800 endpoints, ~6 000 java files)
//
//   <out>/document/sql/schema.sql          N tables, 15..40 columns each
//   <out>/src/main/java/com/synth/app/
//       mapper/<T>Mapper.java              one mapper interface per table
//       model/<T>.java                     its row type
//       model/generated/<T>Example.java    GENERATED-looking bulk (see below)
//       service/<S>Service.java            interface
//       service/impl/<S>ServiceImpl.java   implementation, @Transactional
//       controller/<G><n>Controller.java   the HTTP surface
//   <out>/src/main/resources/com/synth/app/mapper/<T>Mapper.xml
//   <out>/.cascade/{profile.json,manifest.json}
//
// THE FOUR THINGS THAT MAKE IT A TEST AND NOT A TOY
//
//  1. Chains of real depth. A controller reaches its mapper through 1, 2 or 3
//     service hops (4, 6 or 8 graph edges), so a depth cap really bites on part
//     of the corpus and the cut census has something to count.
//  2. Statements with the shapes that break naive extraction: a shared
//     <sql> fragment pulled in with <include>, multi-table joins, and a stated
//     share carrying a `${}` substitution (which the engine must flag rather
//     than pretend to have parsed).
//  3. Generated-looking bulk. A share of the tables get an `<T>Example` class
//     under a `generated` path segment, carrying BOTH a
//     `@javax.annotation.Generated` annotation and a "// This file was
//     generated" banner, whose many `andXEqualTo` methods call one another and
//     `addCriterion` and are reached by nothing. That is mall's 8 453-symbol
//     problem, reproduced deliberately so a classification rule can be measured
//     against evidence the worker really has.
//  4. Seeded. The same --seed produces byte-identical output, so a measurement
//     can be repeated and a regression can be bisected.
//
// USAGE
//   node scripts/make-synthetic-project.mjs --out "$TMPDIR/synth" [--force]
//   node scripts/make-synthetic-project.mjs --out DIR --tables 100 --endpoints 900 \
//        --groups 20 --java-files 1500 --seed 7
//
// then, from the engine root:
//   node bin/cascade.mjs analyze --root DIR --cold
//
// It writes ONLY under --out and reads nothing but its own arguments.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const num = (name, dflt) => {
  const v = Number(opt(name, String(dflt)));
  if (!Number.isFinite(v)) die(`--${name} must be a number`);
  return v;
};

function die(msg) { process.stderr.write(`${msg}\n`); process.exit(2); }

const outDir = opt('out', null);
if (!outDir) die('--out <dir> is required (write it under $TMPDIR — this is a generated tree, not a fixture)');
const OUT = path.resolve(outDir);

const CFG = {
  tables: Math.max(1, Math.floor(num('tables', 400))),
  endpoints: Math.max(1, Math.floor(num('endpoints', 3800))),
  groups: Math.max(1, Math.floor(num('groups', 40))),
  javaFiles: Math.max(1, Math.floor(num('java-files', 6000))),
  // Share of tables that also get a generated-looking Example class.
  generatedShare: clamp01(num('generated-share', 0.55)),
  // Share of STATEMENTS that carry a `${}` substitution (mall's real rate: 43.7%).
  substShare: clamp01(num('subst-share', 0.40)),
  // Methods per generated Example class (mall's average is ~111).
  generatedMethods: Math.max(2, Math.floor(num('generated-methods', 110))),
  seed: Math.floor(num('seed', 1)),
  pkg: opt('package', 'com.synth.app'),
};

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

if (fs.existsSync(OUT)) {
  if (!flag('force')) die(`${OUT} already exists — pass --force to overwrite it`);
  fs.rmSync(OUT, { recursive: true, force: true });
}

// ---- seeded PRNG (mulberry32) ---------------------------------------------
// Small, fast, and — the only property that matters here — reproducible from a
// number, so the whole tree is a pure function of --seed and the sizes.
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(CFG.seed);
const rint = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pickOne = (arr) => arr[Math.floor(rng() * arr.length)];

// ---- vocabulary ------------------------------------------------------------
// Deliberately domain-flavoured: names that read like a real back office, so a
// human looking at the generated pack can tell one table from another.
const DOMAINS = ['order', 'product', 'member', 'stock', 'payment', 'coupon', 'shipping', 'ticket',
  'invoice', 'contract', 'branch', 'account', 'ledger', 'audit', 'notice', 'policy',
  'claim', 'batch', 'route', 'vendor'];
const NOUNS = ['item', 'header', 'detail', 'log', 'history', 'rule', 'code', 'group', 'link',
  'state', 'plan', 'quota', 'limit', 'fee', 'tax', 'note', 'file', 'tag', 'level', 'stage'];
const COLNAMES = ['name', 'title', 'code', 'status', 'amount', 'qty', 'price', 'rate', 'memo',
  'kind', 'level', 'sort_no', 'ref_no', 'owner_id', 'parent_id', 'start_at', 'end_at',
  'flag_a', 'flag_b', 'total', 'balance', 'discount', 'tax_amount', 'unit', 'src_id',
  'dst_id', 'phase', 'grade', 'score', 'weight', 'height', 'depth_cm', 'volume', 'color',
  'reason', 'detail_txt', 'ext_key', 'ext_val'];
const COLTYPES = ['bigint(20)', 'int(11)', 'varchar(64)', 'varchar(255)', 'decimal(10,2)',
  'datetime', 'tinyint(1)', 'text'];

// ---- 1. the schema ---------------------------------------------------------
const tables = [];
const usedTableNames = new Set();
for (let i = 0; i < CFG.tables; i += 1) {
  let name;
  let guard = 0;
  do {
    name = `${pickOne(DOMAINS)}_${pickOne(NOUNS)}${guard || rng() < 0.4 ? `_${i}` : ''}`;
    guard += 1;
  } while (usedTableNames.has(name) && guard < 5);
  if (usedTableNames.has(name)) name = `${name}_${i}`;
  usedTableNames.add(name);

  const nCols = rint(15, 40);
  const cols = [{ name: 'id', type: 'bigint(20)', comment: 'primary key', pk: true }];
  const taken = new Set(['id']);
  while (cols.length < nCols) {
    let c = pickOne(COLNAMES);
    if (taken.has(c)) c = `${c}_${cols.length}`;
    taken.add(c);
    cols.push({ name: c, type: pickOne(COLTYPES), comment: `${c} of ${name}`, pk: false });
  }
  tables.push({ name, cols, javaName: pascal(name) });
}

// A join graph: every table after the first joins one earlier table, so the
// schema is connected (an ERD of 400 unrelated tables would measure nothing).
for (let i = 1; i < tables.length; i += 1) {
  const other = tables[rint(0, i - 1)];
  tables[i].joinsTo = other.name;
  // the joining column really exists on both sides
  if (!tables[i].cols.some((c) => c.name === 'owner_id')) {
    tables[i].cols.push({ name: 'owner_id', type: 'bigint(20)', comment: `fk to ${other.name}`, pk: false });
  }
}

// ---- 2. how many of each java file ----------------------------------------
const endpointsPerController = 10;
const controllers = Math.max(1, Math.ceil(CFG.endpoints / endpointsPerController));
const generatedTables = Math.round(CFG.tables * CFG.generatedShare);
// mapper interfaces + models + generated examples + controllers, then services
// (2 files each) fill the rest of the requested file budget.
const fixedFiles = CFG.tables * 2 + generatedTables + controllers;
const services = Math.max(controllers, Math.floor((CFG.javaFiles - fixedFiles) / 2));
const javaFileTotal = fixedFiles + services * 2;

// Counters the report prints — filled in by the writers below.
let statementCount = 0;
let substCount = 0;
let joinCount = 0;
let includeCount = 0;
// service index -> how many service hops sit between the controller and the mapper
const depthOf = [];

// ---- 3. write --------------------------------------------------------------
const JAVA_ROOT = path.join(OUT, 'src', 'main', 'java', ...CFG.pkg.split('.'));
const RES_ROOT = path.join(OUT, 'src', 'main', 'resources', ...CFG.pkg.split('.'), 'mapper');
mkdirs([
  path.join(OUT, 'document', 'sql'),
  path.join(JAVA_ROOT, 'mapper'), path.join(JAVA_ROOT, 'model'), path.join(JAVA_ROOT, 'model', 'generated'),
  path.join(JAVA_ROOT, 'service'), path.join(JAVA_ROOT, 'service', 'impl'), path.join(JAVA_ROOT, 'controller'),
  RES_ROOT, path.join(OUT, '.cascade'),
]);

writeDdl();
writeModels();
writeMappers();
const serviceDefs = writeServices();
const endpointCount = writeControllers(serviceDefs);
// git first (so the manifest can name a real commit), then .cascade — which is
// generated state and deliberately NOT in that commit.
write(path.join(OUT, '.gitignore'), '.cascade/\n');
const headCommit = flag('git') ? initGit() : null;
writeCascadeDir();

process.stdout.write([
  `synthetic project written to ${OUT}`,
  `  seed             ${CFG.seed}`,
  `  tables           ${tables.length} (15..40 columns; ${tables.reduce((n, t) => n + t.cols.length, 0)} columns total)`,
  `  mapper xml       ${tables.length} files, ${statementCount} statements `
    + `(${substCount} with a \${} substitution = ${(substCount / statementCount * 100).toFixed(1)}%, `
    + `${joinCount} with a join, ${includeCount} using an <include> fragment)`,
  `  java files       ${javaFileTotal}`,
  `    mappers        ${tables.length}`,
  `    models         ${tables.length}`,
  `    generated      ${generatedTables} Example classes x ${CFG.generatedMethods} methods `
    + `= ${generatedTables * CFG.generatedMethods} generated methods`,
  `    services       ${services} interfaces + ${services} impls`,
  `    controllers    ${controllers}`,
  `  endpoints        ${endpointCount} across ${CFG.groups} API groups`,
  `  git              ${headCommit ? `${headCommit} (one commit; manifest stamped)` : 'not a repository — pass --git to measure the overlay / incremental paths'}`,
  `  call depth       ${depthHistogram()}`,
  '',
  'next:',
  `  node bin/cascade.mjs analyze --root ${OUT} --cold`,
].join('\n') + '\n');

// ---------------------------------------------------------------------------

function mkdirs(dirs) { for (const d of dirs) fs.mkdirSync(d, { recursive: true }); }

function writeDdl() {
  const parts = ['-- synthetic schema, generated by scripts/make-synthetic-project.mjs',
    `-- seed ${CFG.seed}, ${tables.length} tables`, ''];
  for (const t of tables) {
    parts.push(`DROP TABLE IF EXISTS \`${t.name}\`;`);
    parts.push(`CREATE TABLE \`${t.name}\` (`);
    const lines = t.cols.map((c) => `  \`${c.name}\` ${c.type}${c.pk ? ' NOT NULL AUTO_INCREMENT' : ' DEFAULT NULL'} COMMENT '${c.comment}'`);
    lines.push('  PRIMARY KEY (`id`)');
    parts.push(lines.join(',\n'));
    parts.push(`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='${t.name} of the synthetic corpus';`);
    parts.push('');
  }
  fs.writeFileSync(path.join(OUT, 'document', 'sql', 'schema.sql'), parts.join('\n'));
}

function writeModels() {
  for (let i = 0; i < tables.length; i += 1) {
    const t = tables[i];
    const fields = t.cols.map((c) => `    private ${javaTypeOf(c.type)} ${camel(c.name)};`).join('\n');
    const accessors = t.cols.map((c) => {
      const jt = javaTypeOf(c.type);
      const n = pascal(c.name);
      return `    public ${jt} get${n}() { return this.${camel(c.name)}; }\n`
        + `    public void set${n}(${jt} v) { this.${camel(c.name)} = v; }`;
    }).join('\n');
    write(path.join(JAVA_ROOT, 'model', `${t.javaName}.java`),
      `package ${CFG.pkg}.model;\n\n`
      + `/** Row type for ${t.name}. */\npublic class ${t.javaName} {\n${fields}\n\n${accessors}\n}\n`);

    if (i < generatedTables) writeGeneratedExample(t);
  }
}

/**
 * The generated bulk. Three independent pieces of evidence that this file was
 * machine-written, because a classifier must be measurable against each of
 * them separately: the `@javax.annotation.Generated` annotation, the banner
 * comment, and the `model/generated/` path segment. Its methods call each other
 * and `addCriterion`, and nothing outside the class calls any of them.
 */
function writeGeneratedExample(t) {
  const body = [];
  body.push('    protected List<Criterion> criteria = new ArrayList<Criterion>();');
  body.push('');
  body.push('    protected void addCriterion(String condition) {');
  body.push('        if (condition == null) { throw new RuntimeException("Value for condition cannot be null"); }');
  body.push('        criteria.add(new Criterion(condition));');
  body.push('    }');
  body.push('');
  const cols = t.cols;
  for (let i = 0; i < CFG.generatedMethods; i += 1) {
    const c = cols[i % cols.length];
    const n = pascal(c.name);
    const suffix = ['EqualTo', 'NotEqualTo', 'GreaterThan', 'LessThan', 'IsNull', 'IsNotNull'][i % 6];
    body.push(`    public GeneratedCriteria and${n}${suffix}${i}(Object value) {`);
    body.push(`        addCriterion("${c.name} ${suffix.startsWith('Is') ? 'is null' : '='}", value);`);
    // half of them also call a sibling: a generated call graph, not a flat list
    if (i > 0 && i % 2 === 0) body.push(`        and${pascal(cols[(i - 1) % cols.length].name)}${['EqualTo', 'NotEqualTo', 'GreaterThan', 'LessThan', 'IsNull', 'IsNotNull'][(i - 1) % 6]}${i - 1}(value);`);
    body.push('        return this;');
    body.push('    }');
  }
  write(path.join(JAVA_ROOT, 'model', 'generated', `${t.javaName}Example.java`),
    '// This file was generated by the synthetic corpus generator.\n'
    + '// Do not edit — every method here is machine-written.\n'
    + `package ${CFG.pkg}.model.generated;\n\n`
    + 'import java.util.ArrayList;\nimport java.util.List;\n\n'
    + '@javax.annotation.Generated("synthetic-mbg")\n'
    + `public class ${t.javaName}Example {\n`
    + `    public static class Criterion { public Criterion(String c) { } }\n`
    + `    public static class GeneratedCriteria {\n${body.join('\n')}\n    }\n}\n`);
}

function writeMappers() {
  for (const t of tables) {
    const ns = `${CFG.pkg}.mapper.${t.javaName}Mapper`;
    const cols = t.cols.map((c) => c.name);
    const writable = t.cols.filter((c) => !c.pk).slice(0, 8);
    // Each statement is built with a `${}` SLOT it may or may not use, so the
    // substitution share is a share of STATEMENTS (mall's real rate is 43.7%),
    // not of files. `subst` is decided per statement, from the seeded stream.
    const subst = () => rng() < CFG.substShare;
    const body = [];
    // A shared fragment every select pulls in — the shape that makes an
    // extractor resolve <include> instead of reading raw text.
    body.push(`    <sql id="Base_Column_List">\n        ${cols.join(', ')}\n    </sql>`);

    const add = (xml, opts) => {
      body.push(xml);
      statementCount += 1;
      if (opts.subst) substCount += 1;
      if (opts.join) joinCount += 1;
      if (opts.include) includeCount += 1;
    };

    let sub = subst();
    add(`    <select id="selectByPrimaryKey" resultType="map">\n`
      + `        SELECT <include refid="Base_Column_List"/>\n        FROM ${t.name}\n`
      + `        WHERE id = #{id}${sub ? '\n        AND ${extraWhere}' : ''}\n    </select>`,
    { subst: sub, include: true });

    if (t.joinsTo) {
      sub = subst();
      add(`    <select id="selectWithOwner" resultType="map">\n`
        + `        SELECT a.id, a.name, b.id AS ownerId\n`
        + `        FROM ${t.name} a\n        LEFT JOIN ${t.joinsTo} b ON a.owner_id = b.id\n`
        + `        WHERE a.status = #{status}${sub ? '\n        AND ${ownerFilter}' : ''}\n    </select>`,
      { subst: sub, join: true });
    }

    sub = subst();
    add(`    <select id="selectPage" resultType="map">\n`
      + `        SELECT <include refid="Base_Column_List"/>\n        FROM ${t.name}\n`
      + '        WHERE status = #{status}\n'
      + `        ORDER BY ${sub ? '${orderBy}' : 'id DESC'}\n    </select>`,
    { subst: sub, include: true });

    add(`    <insert id="insertSelective" parameterType="${CFG.pkg}.model.${t.javaName}">\n`
      + `        INSERT INTO ${t.name} (${writable.map((c) => c.name).join(', ')})\n`
      + `        VALUES (${writable.map((c) => `#{${camel(c.name)}}`).join(', ')})\n    </insert>`, {});

    sub = subst();
    add(`    <update id="updateByPrimaryKeySelective" parameterType="${CFG.pkg}.model.${t.javaName}">\n`
      + `        UPDATE ${t.name}\n        SET ${writable.map((c) => `${c.name} = #{${camel(c.name)}}`).join(', ')}\n`
      + `        WHERE id = #{id}${sub ? '\n        AND ${tenantScope}' : ''}\n    </update>`,
    { subst: sub });

    sub = subst();
    add(`    <delete id="deleteByPrimaryKey">\n        DELETE FROM ${t.name} `
      + `WHERE id = #{id}${sub ? ' AND ${tenantScope}' : ''}\n    </delete>`, { subst: sub });

    write(path.join(RES_ROOT, `${t.javaName}Mapper.xml`),
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n'
      + `<mapper namespace="${ns}">\n${body.join('\n')}\n</mapper>\n`);

    // The interface whose method names the statement ids bind to. Every id above
    // must appear here or the binding is "a statement with no mapper method".
    const methods = ['selectByPrimaryKey', ...(t.joinsTo ? ['selectWithOwner'] : []), 'selectPage',
      'insertSelective', 'updateByPrimaryKeySelective', 'deleteByPrimaryKey'];
    write(path.join(JAVA_ROOT, 'mapper', `${t.javaName}Mapper.java`),
      `package ${CFG.pkg}.mapper;\n\nimport ${CFG.pkg}.model.${t.javaName};\nimport java.util.List;\n\n`
      + `public interface ${t.javaName}Mapper {\n`
      + methods.map((m) => `    ${m.startsWith('select') ? `List<${t.javaName}>` : 'int'} ${m}(Object param);`).join('\n')
      + '\n}\n');
  }
}

/**
 * The service layer. Service i calls, in order of preference:
 *   - a deeper service (making a 2- or 3-hop chain), or
 *   - one or two mappers directly.
 * Each impl is @Transactional, so the transactions view has something to say.
 */
function writeServices() {
  const defs = [];
  for (let i = 0; i < services; i += 1) {
    // 55% one hop, 30% two, 15% three — so a depth-6 walk covers most of the
    // corpus and a depth cap really bites on the rest.
    const r = rng();
    const hops = r < 0.55 ? 1 : r < 0.85 ? 2 : 3;
    depthOf.push(hops);
    defs.push({ i, hops, name: `Svc${i}`, iface: `Svc${i}Service`, impl: `Svc${i}ServiceImpl` });
  }
  for (const d of defs) {
    // the tail of the chain: which services this one delegates to
    const delegates = [];
    for (let k = 1; k < d.hops; k += 1) {
      const j = (d.i + k * 7 + 1) % services;
      if (j !== d.i) delegates.push(defs[j]);
    }
    const mappers = [tables[(d.i * 3) % tables.length], tables[(d.i * 5 + 1) % tables.length]];
    const imports = [
      `import ${CFG.pkg}.mapper.${mappers[0].javaName}Mapper;`,
      `import ${CFG.pkg}.mapper.${mappers[1].javaName}Mapper;`,
      ...delegates.map((x) => `import ${CFG.pkg}.service.${x.iface};`),
    ];
    const fields = [
      `    @Autowired\n    private ${mappers[0].javaName}Mapper mapperA;`,
      `    @Autowired\n    private ${mappers[1].javaName}Mapper mapperB;`,
      ...delegates.map((x, k) => `    @Autowired\n    private ${x.iface} next${k};`),
    ];
    const readBody = delegates.length
      ? delegates.map((x, k) => `        next${k}.read(id);`).join('\n') + '\n        return mapperA.selectByPrimaryKey(id);'
      : '        return mapperA.selectByPrimaryKey(id);';
    const writeBody = delegates.length
      ? delegates.map((x, k) => `        next${k}.write(id);`).join('\n') + '\n        return mapperB.updateByPrimaryKeySelective(id);'
      : '        mapperA.insertSelective(id);\n        return mapperB.updateByPrimaryKeySelective(id);';

    write(path.join(JAVA_ROOT, 'service', `${d.iface}.java`),
      `package ${CFG.pkg}.service;\n\nimport java.util.List;\n\n`
      + `public interface ${d.iface} {\n    List<Object> read(Object id);\n    int write(Object id);\n    List<Object> page(Object id);\n}\n`);

    write(path.join(JAVA_ROOT, 'service', 'impl', `${d.impl}.java`),
      `package ${CFG.pkg}.service.impl;\n\n`
      + `${imports.join('\n')}\nimport ${CFG.pkg}.service.${d.iface};\n`
      + 'import org.springframework.beans.factory.annotation.Autowired;\n'
      + 'import org.springframework.stereotype.Service;\n'
      + 'import org.springframework.transaction.annotation.Transactional;\n'
      + 'import java.util.List;\n\n'
      + `@Service\npublic class ${d.impl} implements ${d.iface} {\n`
      + `${fields.join('\n')}\n\n`
      + `    @Override\n    public List<Object> read(Object id) {\n${readBody}\n    }\n\n`
      + `    @Override\n    @Transactional\n    public int write(Object id) {\n${writeBody}\n    }\n\n`
      + '    @Override\n    public List<Object> page(Object id) {\n        return mapperB.selectPage(id);\n    }\n}\n');
  }
  return defs;
}

function depthHistogram() {
  const h = { 1: 0, 2: 0, 3: 0 };
  for (const d of depthOf) h[d] += 1;
  return `${h[1]} services 1 hop from a mapper, ${h[2]} two hops, ${h[3]} three hops `
    + '(4 / 6 / 8 graph edges from the handler down to a statement)';
}

/**
 * The HTTP surface: `controllers` classes spread over `groups` API groups, each
 * with `endpointsPerController` routes, until `endpoints` are written. Every
 * route is a real Spring mapping annotation on a method that really calls a
 * service field, so the endpoint→statement chain the engine walks exists.
 */
function writeControllers(serviceDefs) {
  const verbs = ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping'];
  let written = 0;
  for (let c = 0; c < controllers && written < CFG.endpoints; c += 1) {
    const group = `grp${c % CFG.groups}`;
    const cls = `${pascal(group)}Ctl${c}Controller`;
    const svc = serviceDefs[c % serviceDefs.length];
    const methods = [];
    for (let m = 0; m < endpointsPerController && written < CFG.endpoints; m += 1) {
      const verb = verbs[(c + m) % verbs.length];
      const call = m % 3 === 0 ? 'write' : m % 3 === 1 ? 'read' : 'page';
      methods.push(
        `    @${verb}("/op${m}/{id}")\n`
        + `    @ResponseBody\n`
        + `    public Object op${m}(@PathVariable Long id) {\n`
        + `        return svc.${call}(id);\n    }\n`);
      written += 1;
    }
    write(path.join(JAVA_ROOT, 'controller', `${cls}.java`),
      `package ${CFG.pkg}.controller;\n\n`
      + `import ${CFG.pkg}.service.${svc.iface};\n`
      + 'import org.springframework.beans.factory.annotation.Autowired;\n'
      + 'import org.springframework.stereotype.Controller;\n'
      + 'import org.springframework.web.bind.annotation.*;\n\n'
      + `@Controller\n@RequestMapping("/${group}/c${c}")\npublic class ${cls} {\n`
      + `    @Autowired\n    private ${svc.iface} svc;\n\n`
      + `${methods.join('\n')}}\n`);
  }
  return written;
}

/**
 * `--git`: make the tree a real repository with one commit, and stamp that
 * commit into the manifest. The working-tree overlay and the incremental path
 * both diff against a base COMMIT, so without this the tree can only be
 * cold-analyzed and two of the SPEC §2.3 gates cannot be measured at all.
 * Committer identity is set on the repo itself, so it never depends on (or
 * touches) the machine's global git config.
 */
function initGit() {
  const git = (...args) => execFileSync('git', args, { cwd: OUT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'user.name', 'synthetic corpus');
  git('add', '-A');
  git('commit', '-q', '-m', `synthetic corpus, seed ${CFG.seed}`);
  return git('rev-parse', 'HEAD');
}

function writeCascadeDir() {
  write(path.join(OUT, '.cascade', 'profile.json'), `${JSON.stringify({
    build: { tool: 'maven', javaRelease: null, profiles: [] },
    packagePrefixes: [CFG.pkg],
    schema: { default: null, propertyNames: [], rewriteLayer: null },
    sqlDialects: { main: 'mysql' },
    gatewayRoutes: {},
    screenAxis: { enabled: false, codeRegex: null, pathRule: null, nameSource: 'none' },
    moduleAttribution: { packageDepth: null, codeLength: null },
    frameworkPacks: ['spring-mvc', 'mybatis-xml'],
    // The generated-source declaration this corpus exists to exercise. BOTH
    // rules are declared because the generated classes here carry both marks;
    // the lane's stats then say which one actually fired. A real project often
    // has only one (mall's MyBatis-generator output carries NEITHER an
    // annotation nor a banner, so only a path can name it).
    generatedSources: {
      annotations: ['Generated'],
      pathGlobs: [`src/main/java/${CFG.pkg.split('.').join('/')}/model/generated/**`],
    },
    modelPacks: [],
    catalog: { source: 'file', connectionFrom: '../document/sql/schema.sql' },
    calibration: { firstRun: 'bootstrap' },
  }, null, 2)}\n`);
  // The manifest needs the repo's real HEAD (a full 40-hex SHA or nothing —
  // the registry rejects anything else), so the repository is created FIRST and
  // its commit written here.
  write(path.join(OUT, '.cascade', 'manifest.json'), `${JSON.stringify({
    schema: 'cascade:manifest:1',
    project: 'synthetic',
    repositories: [{ key: 'synthetic', path: '..', commit: headCommit, kind: 'backend-java' }],
    profile: './profile.json',
  }, null, 2)}\n`);
  write(path.join(OUT, 'README.md'),
    '# synthetic corpus\n\nGenerated by `scripts/make-synthetic-project.mjs`'
    + ` with seed ${CFG.seed}: ${tables.length} tables, ${CFG.endpoints} endpoints.\n`
    + 'Nothing here is hand-written; regenerate it rather than editing it.\n');
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function pascal(s) { return String(s).split(/[^a-zA-Z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(''); }
function camel(s) { const p = pascal(s); return p[0].toLowerCase() + p.slice(1); }
function javaTypeOf(sqlType) {
  if (sqlType.startsWith('bigint')) return 'Long';
  if (sqlType.startsWith('int') || sqlType.startsWith('tinyint')) return 'Integer';
  if (sqlType.startsWith('decimal')) return 'java.math.BigDecimal';
  if (sqlType.startsWith('datetime')) return 'java.util.Date';
  return 'String';
}
