// mybatis_annotation.mjs — MyBatis statements written as an ANNOTATION on a
// mapper method (`@Select`, `@Insert`, `@Update`, `@Delete`) rather than in a
// mapper XML file (RM20 §4).
//
// WHY THIS IS NOT ITS OWN SQL PATH. The two spellings are the same feature:
//
//     @Select("select * from t_user where id = #{id}")   User selectById(int id);
//     <select id="selectById">select * from t_user where id = #{id}</select>
//
// and the annotation form accepts the SAME dynamic tags, wrapped in `<script>`:
// `<if>`, `<foreach>`, `<where>`, `<trim>`, `<choose>`. Re-implementing that
// flattening here would be a second reading of MyBatis's dynamic SQL, which
// would drift from the first. So this module writes each mapper's annotation
// statements out as a SYNTHETIC MAPPER XML and lets `adapters/sql/mybatis_extract.py`
// read it — one flattener, one set of tag rules, one place where a `<foreach>`
// becomes a bind list.
//
// The synthetic file is a translation, not a claim: it exists only inside the
// run's scratch directory, and the statement records that come back are
// re-stamped with the JAVA file and the annotation's own line, so nothing in the
// pack ever points at a file the repository does not contain.
//
// The engine decides nothing about the SQL here. What table `select * from t` is
// about is `lineage.py`'s reading, exactly as for a mapper XML statement.

/** The XML element name for each verb the worker recorded. */
const ELEMENT_OF = Object.freeze({
  select: 'select', insert: 'insert', update: 'update', delete: 'delete',
});

/** `<script>…</script>` around the whole body: MyBatis's own escape hatch. */
const SCRIPT_RE = /^\s*<script\s*>([\s\S]*)<\/script\s*>\s*$/i;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** XML text escaping for a statement body that is NOT markup. */
function escapeXmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A mapper FQN as a file name that cannot collide or escape a directory. */
export function annotationMapperFileName(mapperFqn) {
  return `${String(mapperFqn).replace(/[^A-Za-z0-9_.$-]/g, '_')}.xml`;
}

/**
 * Group the worker's `mapperAnnotationSql` records into one synthetic mapper XML
 * per mapper interface.
 *
 * `xmlStatementKeys` is the set of `namespace.id` keys the REAL mapper XML
 * already declares. MyBatis forbids a method having both an annotation and an
 * XML statement — it throws at startup — so a method that has both is a defect
 * in the analyzed project, not an engine choice. The XML wins (that is the
 * statement a reader will find, and the one MyBatis reports the clash for) and
 * the collision is returned as a diagnostic rather than resolved silently.
 *
 * @param {object[]} javaFacts  the cascade:javafacts:1 stream
 * @param {Iterable<string>} [xmlStatementKeys]  "namespace.id" of every XML statement
 * @returns {{files:{mapperFqn:string, fileName:string, xml:string,
 *                   statements:{method:string, verb:string, javaFile:(string|null), line:(number|null)}[]}[],
 *            statements:number, scripts:number, overriddenByXml:string[],
 *            diagnostics:{kind:string, severity:string, key:string, reason:string}[]}}
 */
export function annotationMapperXml(javaFacts, xmlStatementKeys = []) {
  const taken = new Set(xmlStatementKeys);
  const byMapper = new Map(); // mapperFqn -> [record]
  const overriddenByXml = [];
  const diagnostics = [];
  let scripts = 0;

  for (const r of javaFacts ?? []) {
    if (!r || r.kind !== 'mapperAnnotationSql') continue;
    if (!r.ownerFqn || !r.method || typeof r.text !== 'string') continue;
    const key = `${r.ownerFqn}.${r.method}`;
    if (taken.has(key)) {
      overriddenByXml.push(key);
      continue;
    }
    let list = byMapper.get(r.ownerFqn);
    if (!list) { list = []; byMapper.set(r.ownerFqn, list); }
    list.push(r);
  }
  if (overriddenByXml.length > 0) {
    overriddenByXml.sort(cmp);
    diagnostics.push({
      kind: 'MAPPER_STATEMENT_DECLARED_TWICE', severity: 'warn', key: 'frameworkPacks',
      reason: `${overriddenByXml.length} mapper method(s) carry BOTH a statement annotation and a mapper XML statement `
        + `(${overriddenByXml.slice(0, 5).join(', ')}${overriddenByXml.length > 5 ? ', …' : ''}). `
        + 'MyBatis rejects that at startup, so one of the two is dead code in the analyzed project; '
        + 'this pack keeps the XML statement and ignores the annotation.',
    });
  }

  const files = [];
  let statements = 0;
  for (const mapperFqn of [...byMapper.keys()].sort(cmp)) {
    // ONE method can carry only one statement annotation; two would be the same
    // clash again, so the records are deduplicated by method with the first
    // (alphabetically lowest verb) winning — deterministic, and reported.
    const seen = new Set();
    const recs = byMapper.get(mapperFqn)
      .slice()
      .sort((a, b) => cmp(a.method, b.method) || cmp(a.verb, b.verb))
      .filter((r) => {
        if (seen.has(r.method)) {
          diagnostics.push({
            kind: 'MAPPER_STATEMENT_DECLARED_TWICE', severity: 'warn', key: 'frameworkPacks',
            reason: `${mapperFqn}#${r.method} carries more than one MyBatis statement annotation; the first by verb was kept and @${r.verb} ignored`,
          });
          return false;
        }
        seen.add(r.method);
        return true;
      });

    const body = [];
    const stmtMeta = [];
    for (const r of recs) {
      const element = ELEMENT_OF[r.verb];
      if (!element) continue;
      const m = SCRIPT_RE.exec(r.text);
      // A `<script>` body IS markup — the dynamic tags are the point of it — so
      // it goes in verbatim. Anything else is text, and `where id > #{id}` must
      // not turn into a tag.
      const inner = m ? m[1] : escapeXmlText(r.text);
      if (m) scripts += 1;
      body.push(`  <${element} id="${r.method}">${inner}</${element}>`);
      stmtMeta.push({ method: r.method, verb: r.verb, javaFile: r.file ?? null, line: r.line ?? null });
      statements += 1;
    }
    if (body.length === 0) continue;
    files.push({
      mapperFqn,
      fileName: annotationMapperFileName(mapperFqn),
      xml: `<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="${mapperFqn}">\n${body.join('\n')}\n</mapper>\n`,
      statements: stmtMeta,
    });
  }

  return { files, statements, scripts, overriddenByXml, diagnostics };
}

/**
 * Re-stamp extracted statement records so they point at the JAVA source.
 *
 * `mybatis_extract.py` reports the file it read, which for these statements is a
 * synthetic file in the run's scratch directory — a path that will not exist a
 * second later and that no reader could open. The annotation's real home is the
 * mapper interface, at the line the annotation is on, and that is what the pack
 * must carry.
 *
 * @param {object[]} records  statement records from mybatis_extract.py
 * @param {ReturnType<typeof annotationMapperXml>['files']} files
 * @returns {object[]}
 */
export function restampToJavaSource(records, files) {
  const meta = new Map(); // "namespace.id" -> {javaFile, line}
  for (const f of files) {
    for (const s of f.statements) meta.set(`${f.mapperFqn}.${s.method}`, s);
  }
  return (records ?? [])
    .filter((r) => r && r.kind === 'statement')
    .map((r) => {
      const m = meta.get(`${r.namespace}.${r.id}`);
      return m ? { ...r, file: m.javaFile, line: m.line } : r;
    });
}
