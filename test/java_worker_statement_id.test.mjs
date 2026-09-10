// java_worker_statement_id.test.mjs — what the worker records about a MyBatis
// statement called by its STRING ID, and about the bean a field asks for by
// name (javafacts/11), read back off real compiled-and-run output.
//
// THE SHAPE THIS IS FOR. eGovFrame, which every Korean public sector project is
// built on, writes no mapper interface at all. A DAO extends a session base and
// names the statement outright:
//
//   @Repository("SampleDAO")
//   public class SampleDAO extends EgovAbstractMapper {
//       public List<?> selectSampleList(SampleVO vo) {
//           return selectList("SampleDAO.selectSampleList", vo);
//       }
//   }
//
// The worker decides NOTHING about it. It records the literal, where the call
// is, and what was written when the literal is not there to read. Whether that
// receiver is a MyBatis session, and whether any statement of that name exists,
// are both decided in src/adapters/java/persistence.mjs, which holds the type
// records and the SQL lane's statement nodes (I-1/I-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { JAVA_WORKER_VERSION } from '../src/core/worker_versions.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

const SOURCES = {
  'SampleDAO.java': `package com.example;
import java.util.List;
import org.egovframe.rte.psl.dataaccess.EgovAbstractMapper;
import org.springframework.stereotype.Repository;

@Repository("SampleDAO")
public class SampleDAO extends EgovAbstractMapper {

    private static final String LIST_ID = "SampleDAO.selectSampleList";
    private static final String NOT_AN_ID = "select * from sample";

    // 1. the literal, which IS the key MyBatis looks the statement up by.
    public List<?> selectSampleList(SampleVO vo) {
        return selectList("SampleDAO.selectSampleList", vo);
    }

    // 2. a static final String of THIS class, initialised with the literal.
    public List<?> viaConstant(SampleVO vo) {
        return selectList(LIST_ID, vo);
    }

    // 3. a first argument no single file can read. Recorded AS WRITTEN, so the
    //    run can say how many it could not read and what they looked like.
    public int updateBuilt(SampleVO vo, String suffix) {
        return update("SampleDAO." + suffix, vo);
    }

    // 4. a session method whose first argument is not a statement id at all.
    //    No id, and nothing to say: it is a string, not a namespace and an id.
    public int insertRaw(SampleVO vo) {
        return insert(NOT_AN_ID, vo);
    }

    public int deleteSample(SampleVO vo) {
        return delete("SampleDAO.deleteSample", vo);
    }
}
`,
  'SampleService.java': `package com.example;
import javax.annotation.Resource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

@Service("sampleService")
public class SampleService {

    // The bean the container really puts here, by name.
    @Resource(name = "SampleDAO")
    private SampleDAO sampleDao;

    @Qualifier("otherDao")
    private SampleDAO otherDao;

    // A field nobody named: nothing to record.
    private SampleVO scratch;

    public void run(SampleVO vo) {
        sampleDao.selectSampleList(vo);
        otherDao.deleteSample(vo);
    }
}
`,
  'SampleVO.java': 'package com.example;\npublic class SampleVO { }\n',
};

function runWorker(jdk, dir) {
  const buildDir = path.join(dir, 'classes');
  fs.mkdirSync(buildDir, { recursive: true });
  execFileSync(jdk.javac, ['-d', buildDir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const src = path.join(dir, 'src');
  const out = execFileSync(jdk.java, ['-cp', buildDir, 'JavaFacts', '--root', src, src], { maxBuffer: 1 << 26 })
    .toString('utf8');
  return out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function writeSources(dir) {
  const src = path.join(dir, 'src', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), body);
}

test('javafacts/11: a session call records the statement id it names, or what it could not read', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-java-stmtid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSources(dir);
  const records = runWorker(jdk, dir);
  assert.equal(records[0].version, JAVA_WORKER_VERSION, 'the mirrored version must be the one the worker stamps');

  const calls = records.filter((r) => r.kind === 'call');
  const by = (method) => calls.filter((c) => c.from === `com.example.SampleDAO#${method}`)[0];

  // 1. the literal.
  const literal = by('selectSampleList');
  assert.equal(literal.stmtId, 'SampleDAO.selectSampleList');
  assert.equal(literal.stmtIdFrom, 'literal');
  assert.equal(literal.stmtArg, undefined, 'a readable id records no unreadable argument');
  assert.ok(literal.line > 0, 'the site carries its line, so a census can name it');

  // 2. the class's own constant, read in the one file that declares it.
  const constant = by('viaConstant');
  assert.equal(constant.stmtId, 'SampleDAO.selectSampleList');
  assert.equal(constant.stmtIdFrom, 'constant');

  // 3. a concatenation: no id, and the expression as written.
  const built = by('updateBuilt');
  assert.equal(built.stmtId, undefined);
  assert.equal(built.stmtArg, '"SampleDAO." + suffix');

  // 4. a string that is not a namespace and an id is not a statement id, and
  //    reading it as one would put a statement in the graph nobody declared.
  const raw = by('insertRaw');
  assert.equal(raw.stmtId, undefined);
  assert.equal(raw.stmtArg, 'NOT_AN_ID');

  // A call that is not one of the ten session methods carries none of this.
  const other = calls.find((c) => c.method === 'run' || c.from.endsWith('#run'));
  if (other) assert.equal(other.stmtId, undefined);
});

test('javafacts/11: a class records the bean name it declares, and a field the one it asks for', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-java-beanname-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSources(dir);
  const records = runWorker(jdk, dir);

  const types = new Map(records.filter((r) => r.kind === 'type').map((r) => [r.fqn, r]));
  assert.equal(types.get('com.example.SampleDAO').beanName, 'SampleDAO', '@Repository("x") names the bean');
  assert.equal(types.get('com.example.SampleService').beanName, 'sampleService');
  assert.equal(types.get('com.example.SampleVO').beanName, null, 'a plain class declares no bean name');

  const fields = records.filter((r) => r.kind === 'field' && r.owner === 'com.example.SampleService');
  const byName = new Map(fields.map((f) => [f.name, f]));
  assert.equal(byName.get('sampleDao').beanName, 'SampleDAO', '@Resource(name = "x") asks for x');
  assert.equal(byName.get('otherDao').beanName, 'otherDao', '@Qualifier("x") asks for x');
  assert.equal(byName.get('scratch').beanName, null, 'a field nobody named asks for nothing');
});
