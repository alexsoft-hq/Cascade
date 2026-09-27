// java_sql.mjs — the SQL a Java source carries, read the same way by `cascade analyze` and the working-tree overlay.
//
// Three kinds of statement come from somewhere other than a mapper XML: SQL
// written in a MyBatis annotation (`@Select`…), a JPA native query
// (`@Query(nativeQuery = true)`), and a MyBatis-Plus wrapper fragment (`apply`,
// `last`, `inSql`…). Each goes to the same SQL analyzer as a mapper statement,
// through the same content-addressed shards.
//
// The overlay (`cascade impact` on uncommitted edits) once read only the
// fragments. On a project whose SQL sits in annotations or native queries, an
// edit that changed nothing but a comment reached no column from the working
// tree where the pack reached them. Both callers now read all three from here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeQueryStatements } from '../adapters/jpa_bridge.mjs';
import { wrapperFragmentStatements } from '../adapters/mp_bridge.mjs';
import { annotationMapperXml, restampToJavaSource } from '../adapters/mybatis_annotation.mjs';
import { runLineageForStatements } from '../core/incremental.mjs';
import { catalogDigestOf } from '../core/facts_store.mjs';
import { workerVersions } from '../core/worker_versions.mjs';
import { parseJsonl } from './env.mjs';

/**
 * The mapper XML the MyBatis statement annotations among `javaFacts` stand for.
 * A statement a mapper XML already declares is left out: MyBatis itself refuses
 * a statement declared twice.
 *
 * @returns {{files:object[], statements:number, scripts:number, diagnostics:object[]}}
 */
export function annotationMappersOf(javaFacts, statementRecords) {
  const declared = (statementRecords ?? []).filter((r) => r && r.kind === 'statement').map((r) => `${r.namespace}.${r.id}`);
  return annotationMapperXml(javaFacts, declared);
}

/**
 * Those mappers read by the mapper flattener, which is what keeps `<script>`
 * bodies and `<foreach>` in step with a mapper XML's, and each statement stamped
 * back onto its Java file and line. The scratch files are removed after.
 */
export function flattenAnnotationMappers(files, { runpy, mybatisArgs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-annotation-mappers-'));
  try {
    for (const f of files) fs.writeFileSync(path.join(dir, f.fileName), f.xml, 'utf8');
    return restampToJavaSource(parseJsonl(runpy('mybatis_extract.py', ['--root', dir, ...mybatisArgs, dir])), files);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The lineage of `statements`. One analyzed before is read back from `store`;
 * one that is new is analyzed by `runners.lineage`. The overlay hands in a
 * store that reads the cache and writes nothing to disk, so an uncommitted edit
 * never becomes a cached fact.
 *
 * @returns {{lineageRecords:object[], statementEntries:object}}
 */
export function lineageOfStatements({ statements, store, index, catalog, sqlArgs, runners, force, diagnostics }) {
  if (statements.length === 0) return { lineageRecords: [], statementEntries: {} };
  const out = runLineageForStatements({
    store, index, statements,
    catalogDigest: catalogDigestOf(catalog), catalogRecords: catalog,
    inputs: { dialect: sqlArgs.dialect, identifierCase: sqlArgs.identifierCase, defaultSchema: sqlArgs.defaultSchema },
    run: runners, workerVersion: workerVersions().lineage, force,
    diag: (d) => { diagnostics.push(d); },
  });
  return { lineageRecords: out.lineageRecords, statementEntries: out.statementEntries };
}

/** The wrapper fragments of `javaFacts` under the MyBatis-Plus bridge's options, and their lineage. */
export function wrapperFragmentLineageOf({ javaFacts, mpOpts, ...lineage }) {
  const statements = wrapperFragmentStatements(javaFacts, mpOpts);
  return { fragments: statements.length, ...lineageOfStatements({ statements, ...lineage }) };
}

/**
 * The statements written in Java annotations, MyBatis and JPA native alike, for
 * the overlay: the same ones `analyze` reads, with no progress printed. Without
 * the SQL lane's python there are none, as there were none in the pack.
 */
export function annotationStatementsOf({ javaFacts, statementRecords, runpy, pyOk, mybatisArgs }) {
  if (!pyOk) return [];
  const mappers = annotationMappersOf(javaFacts, statementRecords);
  const annotated = mappers.files.length > 0 ? flattenAnnotationMappers(mappers.files, { runpy, mybatisArgs }) : [];
  return [...annotated, ...nativeQueryStatements(javaFacts)];
}
