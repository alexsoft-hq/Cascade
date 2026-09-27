// java_sql.test.mjs — the SQL a Java source carries, as the working-tree overlay reads it when the SQL lane's python is missing.
//
// A pack built with python holds the lineage of every native query and every
// MyBatis annotation. An overlay run later without python used to answer as if
// those statements did not exist: an edit that changed nothing lost its
// columns. A native query needs no python to be a statement, and its lineage is
// in the fact cache; a MyBatis annotation has to go through the python
// flattener, so without python the overlay declines instead of answering short.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationStatementsOf } from '../src/cli/java_sql.mjs';

const NATIVE = {
  kind: 'repository', fqn: 'com.example.OwnerRepository', file: 'com/example/OwnerRepository.java',
  methods: [{ name: 'byName', line: 7, query: { native: true, text: 'select id from owners where last_name = ?1' } }],
};
const ANNOTATION = {
  kind: 'mapperAnnotationSql', ownerFqn: 'com.example.OwnerMapper', method: 'all',
  verb: 'select', text: 'select id from owners', line: 9, file: 'com/example/OwnerMapper.java',
};
const noPython = (what) => { throw new Error(`no python for ${what}`); };
const neverRun = () => { throw new Error('the flattener ran'); };

test('without python a native query is still a statement, for its lineage to be read from the cache', () => {
  const statements = annotationStatementsOf({ javaFacts: [NATIVE], statementRecords: [], runpy: neverRun, requirePython: noPython, mybatisArgs: [] });
  assert.deepEqual(statements.map((s) => [s.namespace, s.id, s.sql]), [['com.example.OwnerRepository', 'byName', 'select id from owners where last_name = ?']]);
});

test('without python a MyBatis annotation declines the overlay rather than vanishing from the answer', () => {
  assert.throws(
    () => annotationStatementsOf({ javaFacts: [NATIVE, ANNOTATION], statementRecords: [], runpy: neverRun, requirePython: noPython, mybatisArgs: [] }),
    /no python for the 1 MyBatis statement annotation\(s\)/,
  );
});
