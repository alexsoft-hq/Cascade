import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { readSourceFor, sourceRootsOf, extractXmlStatement, extractJavaMethod, extractCreateTable, extractWebFunction, webLang, WEB_FALLBACK_LINES, WHOLE_FILE_CAP } from '../src/viewer/source.mjs';
import { diskSourceIo } from '../src/cli/commands/view.mjs';

// Every extractor answers with the 1-based line range it cut, because the page
// draws a gutter of REAL file lines beside the code and marks those lines. This
// is the shorthand the range assertions below read with.
const pick = (cut) => ({ from: cut.from, to: cut.to });

// ---------------------------------------------------------------------------
// extractXmlStatement
// ---------------------------------------------------------------------------

const MAPPER_XML = `<mapper>
  <select id="a">SQL_A</select>
  <update id="b">SQL_B</update>
</mapper>`;

test('extractXmlStatement: returns the full element for a given id (double-quoted)', () => {
  const cut = extractXmlStatement(MAPPER_XML, 'a');
  assert.equal(cut.snippet, '<select id="a">SQL_A</select>');
});

test('extractXmlStatement: returns the full element for a second id', () => {
  const cut = extractXmlStatement(MAPPER_XML, 'b');
  assert.equal(cut.snippet, '<update id="b">SQL_B</update>');
});

test('extractXmlStatement: reports the 1-based line range it cut, so the page can number the gutter', () => {
  // MAPPER_XML: line 1 is <mapper>, line 2 the select, line 3 the update.
  assert.deepEqual(pick(extractXmlStatement(MAPPER_XML, 'a')), { from: 2, to: 2 });
  assert.deepEqual(pick(extractXmlStatement(MAPPER_XML, 'b')), { from: 3, to: 3 });
  // A multi-line element reports its own first and last line.
  const xml = ['<mapper>', '  <select id="x">', '    SELECT 1', '  </select>', '</mapper>'].join('\n');
  const cut = extractXmlStatement(xml, 'x');
  assert.deepEqual(pick(cut), { from: 2, to: 4 });
  assert.equal(cut.snippet.split('\n').length, 3, 'the range spans exactly the lines of the cut');
});

test('extractXmlStatement: returns null for an absent id', () => {
  assert.equal(extractXmlStatement(MAPPER_XML, 'c'), null);
});

test('extractXmlStatement: handles single-quoted id attributes', () => {
  const xml = `<mapper><select id='a'>SQL_A</select></mapper>`;
  assert.equal(extractXmlStatement(xml, 'a').snippet, `<select id='a'>SQL_A</select>`);
});

test('extractXmlStatement: a statement with nested tags (include/if) is returned whole, closed by its OWN close tag', () => {
  const xml = `<mapper>
  <select id="x">
    <include refid="Base_Column_List"/>
    <if test="name != null">AND name = #{name}</if>
  </select>
</mapper>`;
  const snip = extractXmlStatement(xml, 'x').snippet;
  assert.ok(snip.startsWith('<select id="x">'));
  assert.ok(snip.endsWith('</select>'));
  assert.ok(snip.includes('<include refid="Base_Column_List"/>'));
  assert.ok(snip.includes('<if test="name != null">AND name = #{name}</if>'));
});

// ---------------------------------------------------------------------------
// extractJavaMethod
// ---------------------------------------------------------------------------

const JAVA_LINES = [
  'package com.x;',
  '',
  'public class Foo {',
  '    public void bar() {',
  '        if (true) {',
  '            doSomething();',
  '        }',
  '        for (int i = 0; i < 10; i++) {',
  '            System.out.println(i);',
  '        }',
  '    }',
  '',
  '    public void other() {',
  '    }',
  '}',
];
const JAVA = JAVA_LINES.join('\n');

test('extractJavaMethod: with a line number, starts at the signature line and ends at the balanced closing brace', () => {
  const { snippet, note } = extractJavaMethod(JAVA, null, 4); // 1-based: "public void bar() {"
  assert.equal(note, undefined);
  const lines = snippet.split('\n');
  assert.equal(lines[0].trim(), 'public void bar() {');
  assert.equal(lines[lines.length - 1].trim(), '}');
  assert.ok(snippet.includes('doSomething();'));
  assert.ok(snippet.includes('for (int i = 0; i < 10; i++) {'));
  // brace balance must not overrun into the sibling method
  assert.ok(!snippet.includes('other()'));
});

test('extractJavaMethod: with no line, finds the method by name', () => {
  const { snippet } = extractJavaMethod(JAVA, 'other');
  const lines = snippet.split('\n');
  assert.equal(lines[0].trim(), 'public void other() {');
  assert.equal(lines[lines.length - 1].trim(), '}');
  assert.ok(!snippet.includes('bar('));
});

test('extractJavaMethod: an interface/abstract method ending in ";" (no body) returns just that line', () => {
  const iface = ['public interface Bar {', '    void doThing(String x);', '}'].join('\n');
  const { snippet } = extractJavaMethod(iface, 'doThing');
  assert.equal(snippet, '    void doThing(String x);');
});

test('extractJavaMethod: a name that does not exist returns the file head with a note', () => {
  const { snippet, note, from, to } = extractJavaMethod(JAVA, 'nope');
  assert.ok(note && note.includes('nope'));
  assert.equal(snippet, JAVA_LINES.slice(0, Math.min(JAVA_LINES.length, 40)).join('\n'));
  assert.deepEqual({ from, to }, { from: 1, to: JAVA_LINES.length }, 'the head window still says which lines it is');
});

test('extractJavaMethod: the range is the signature line through the balanced closing brace', () => {
  // JAVA_LINES: line 4 is "public void bar() {", line 11 its closing brace.
  assert.deepEqual(pick(extractJavaMethod(JAVA, null, 4)), { from: 4, to: 11 });
  // Found by NAME, the same method reports the same range.
  assert.deepEqual(pick(extractJavaMethod(JAVA, 'bar')), { from: 4, to: 11 });
  // ...and the sibling method is lines 13-14.
  assert.deepEqual(pick(extractJavaMethod(JAVA, 'other')), { from: 13, to: 14 });
  // An interface method with no body is one line, and says so.
  const iface = ['public interface Bar {', '    void doThing(String x);', '}'].join('\n');
  assert.deepEqual(pick(extractJavaMethod(iface, 'doThing')), { from: 2, to: 2 });
});

// ---------------------------------------------------------------------------
// extractCreateTable
// ---------------------------------------------------------------------------

const DDL = [
  'CREATE TABLE `pms_product` (',
  '  `id` INT PRIMARY KEY,',
  '  `name` VARCHAR(100)',
  ');',
].join('\n');

test('extractCreateTable: returns the statement through the trailing ;', () => {
  const cut = extractCreateTable(DDL, 'pms_product');
  assert.equal(cut.snippet, DDL);
  assert.deepEqual(pick(cut), { from: 1, to: 4 });
});

test('extractCreateTable: backtick-insensitive — DDL with no backticks around the table name still matches', () => {
  const noTicks = 'CREATE TABLE pms_product (\n  id INT\n);';
  assert.equal(extractCreateTable(noTicks, 'pms_product').snippet, noTicks);
});

test('extractCreateTable: the range is where the statement sits in the FILE, not where it sits in the cut', () => {
  const withHeader = ['-- schema', '-- generated', '', DDL].join('\n');
  const cut = extractCreateTable(withHeader, 'pms_product');
  assert.deepEqual(pick(cut), { from: 4, to: 7 });
  assert.equal(cut.snippet, DDL);
});

test('extractCreateTable: returns null when the table is absent', () => {
  assert.equal(extractCreateTable(DDL, 'no_such_table'), null);
});

test('extractCreateTable: with two tables in the same DDL, extracts only the requested one', () => {
  const twoTables = [DDL, '', 'CREATE TABLE `pms_order` (', '  `id` INT', ');'].join('\n');
  const snip = extractCreateTable(twoTables, 'pms_order').snippet;
  assert.ok(snip.startsWith('CREATE TABLE `pms_order`'));
  assert.ok(snip.endsWith(');'));
  assert.ok(!snip.includes('pms_product'));
});

// ---------------------------------------------------------------------------
// readSourceFor
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve('/repo'); // an absolute root in this platform's spelling

// Injected readFile: keyed by absolute path, records every path it was asked
// to read so tests can assert both WHAT was read and (for the escape guard)
// that nothing was read at all.
// `realPath` is the identity here: these paths are not on disk, so there is no
// link to follow. The links are tested against a real tree further down.
function makeIo(filesByAbsPath, ddlPath, roots) {
  const calls = [];
  const readFile = (abs) => {
    calls.push(abs);
    return Object.prototype.hasOwnProperty.call(filesByAbsPath, abs) ? filesByAbsPath[abs] : null;
  };
  return { io: { readFile, realPath: (p) => p, ddlPath, ...(roots ? { roots } : {}) }, calls };
}

test('readSourceFor: statement node -> ok, lang xml, snippet is the extracted element; reads the resolved absolute path', () => {
  const g = new Graph();
  const sid = nodeId('statement', 'PmsProductMapper.selectByPrimaryKey');
  g.addNode({ id: sid, file: 'PmsProductMapper.xml' });
  const xml = '<mapper><select id="selectByPrimaryKey">SELECT 1</select></mapper>';
  const expectedAbs = path.resolve(REPO_ROOT, 'PmsProductMapper.xml');
  const { io, calls } = makeIo({ [expectedAbs]: xml });

  const res = readSourceFor(g, REPO_ROOT, sid, io);

  assert.deepEqual(calls, [expectedAbs]);
  assert.equal(res.kind, 'statement');
  assert.equal(res.ok, true);
  assert.equal(res.lang, 'xml');
  assert.equal(res.snippet, '<select id="selectByPrimaryKey">SELECT 1</select>');
});

test('readSourceFor: statement node whose file is unreadable -> ok:false with a note', () => {
  const g = new Graph();
  const sid = nodeId('statement', 'PmsProductMapper.selectByPrimaryKey');
  g.addNode({ id: sid, file: 'PmsProductMapper.xml' });
  const { io } = makeIo({}); // readFile returns null for every path
  const res = readSourceFor(g, REPO_ROOT, sid, io);
  assert.equal(res.ok, false);
  assert.equal(res.file, 'PmsProductMapper.xml');
  assert.ok(res.note && res.note.includes('cannot read'));
});

test('readSourceFor: symbol node -> ok, lang java, snippet is the extracted method', () => {
  const g = new Graph();
  const symId = nodeId('symbol', 'com.x.PmsProductMapper#selectByPrimaryKey');
  g.addNode({ id: symId, file: 'PmsProductMapper.java', owner: 'com.x.PmsProductMapper', line: 3 });
  const java = [
    'package com.x;',
    'public interface PmsProductMapper {',
    '    Product selectByPrimaryKey(int id) {',
    '        return null;',
    '    }',
    '}',
  ].join('\n');
  const expectedAbs = path.resolve(REPO_ROOT, 'PmsProductMapper.java');
  const { io, calls } = makeIo({ [expectedAbs]: java });

  const res = readSourceFor(g, REPO_ROOT, symId, io);

  assert.deepEqual(calls, [expectedAbs]);
  assert.equal(res.kind, 'symbol');
  assert.equal(res.ok, true);
  assert.equal(res.lang, 'java');
  assert.ok(res.snippet.includes('selectByPrimaryKey'));
  assert.ok(res.snippet.trim().endsWith('}'));
});

test('readSourceFor: table node with io.ddlPath set -> ok, lang sql, snippet is the CREATE TABLE statement', () => {
  const g = new Graph();
  const tid = nodeId('table', 'pms_product');
  g.addNode({ id: tid });
  const ddlAbs = path.resolve(REPO_ROOT, 'schema.sql');
  const { io } = makeIo({ [ddlAbs]: DDL }, ddlAbs);

  const res = readSourceFor(g, REPO_ROOT, tid, io);

  assert.equal(res.kind, 'table');
  assert.equal(res.ok, true);
  assert.equal(res.lang, 'sql');
  assert.equal(res.snippet, DDL);
});

test('readSourceFor: unknown node id -> ok:false, note mentions "not in pack"', () => {
  const g = new Graph();
  const { io } = makeIo({});
  const missingId = nodeId('table', 'does-not-exist');
  const res = readSourceFor(g, REPO_ROOT, missingId, io);
  assert.equal(res.ok, false);
  assert.ok(res.note.includes('not in pack'));
});

test('readSourceFor: path-escape guard — a node file of "../secret.txt" is never read and the result is ok:false', () => {
  const g = new Graph();
  const sid = nodeId('statement', 'ns.escape');
  g.addNode({ id: sid, file: '../secret.txt' });
  const secretAbs = path.resolve(REPO_ROOT, '../secret.txt'); // resolves outside /repo
  const { io, calls } = makeIo({ [secretAbs]: 'TOP SECRET' });

  const res = readSourceFor(g, REPO_ROOT, sid, io);

  assert.equal(res.ok, false);
  assert.deepEqual(calls, [], 'readFile must not be called for a path outside repoRoot');
});

test('readSourceFor: a member the class only INHERITS opens the ANCESTOR\'s file, at the ancestor\'s line', () => {
  // The node is `TenantDaoImpl#deleteById`; the code that runs is `BaseDao`'s.
  // Opening the impl would show a file that does not contain the method at all.
  const g = new Graph();
  const symId = nodeId('symbol', 'com.x.impl.AaaDaoImpl#deleteById');
  g.addNode({
    id: symId, file: 'com/x/Base.java', owner: 'com.x.impl.AaaDaoImpl', line: 4,
    inherited: true, inheritedFrom: 'com.x.Base#deleteById',
  });
  // A sibling symbol of the SAME owner, so the owner-fallback would have picked
  // the impl file if the node's own `file` were not honoured.
  g.addNode({ id: nodeId('symbol', 'com.x.impl.AaaDaoImpl#queryAaa'), file: 'com/x/impl/AaaDaoImpl.java', owner: 'com.x.impl.AaaDaoImpl' });
  const base = [
    'package com.x;',
    'public abstract class Base<E, M> {',
    '    protected M mapper;',
    '    public boolean deleteById(int id) {',
    '        return mapper.deleteById(id) > 0;',
    '    }',
    '}',
  ].join('\n');
  const expectedAbs = path.resolve(REPO_ROOT, 'com/x/Base.java');
  const { io, calls } = makeIo({ [expectedAbs]: base });

  const res = readSourceFor(g, REPO_ROOT, symId, io);

  assert.deepEqual(calls, [expectedAbs], 'the ancestor file, and only it');
  assert.equal(res.ok, true);
  assert.equal(res.file, 'com/x/Base.java');
  assert.ok(res.snippet.includes('mapper.deleteById(id)'), res.snippet);
});

// ---------------------------------------------------------------------------
// What the PANE needs: the absolute path, the range, the file length, and the
// whole file on request (RM27b)
// ---------------------------------------------------------------------------

test('readSourceFor: an answer carries the absolute path, the range it cut and how long the file is', () => {
  const g = new Graph();
  const sid = nodeId('statement', 'PmsProductMapper.selectByPrimaryKey');
  g.addNode({ id: sid, file: 'PmsProductMapper.xml' });
  const xml = ['<mapper>', '  <select id="selectByPrimaryKey">', '    SELECT 1', '  </select>', '</mapper>', ''].join('\n');
  const abs = path.resolve(REPO_ROOT, 'PmsProductMapper.xml');
  const { io } = makeIo({ [abs]: xml });

  const res = readSourceFor(g, REPO_ROOT, sid, io);

  assert.equal(res.abs, abs, 'the pane opens an editor at a path, and only the server knows the absolute one');
  assert.deepEqual({ from: res.from, to: res.to }, { from: 2, to: 4 });
  assert.equal(res.fileLines, 6);
  assert.equal(res.text, undefined, 'without ?whole the answer carries the snippet alone');
});

test('readSourceFor: whole=1 returns the file instead of the snippet, and keeps the SAME range', () => {
  const g = new Graph();
  const symId = nodeId('symbol', 'com.x.Foo#bar');
  g.addNode({ id: symId, file: 'Foo.java', owner: 'com.x.Foo', line: 4 });
  const abs = path.resolve(REPO_ROOT, 'Foo.java');
  const { io } = makeIo({ [abs]: JAVA });

  const snip = readSourceFor(g, REPO_ROOT, symId, { ...io, whole: false });
  const whole = readSourceFor(g, REPO_ROOT, symId, { ...io, whole: true });

  assert.deepEqual({ from: whole.from, to: whole.to }, { from: snip.from, to: snip.to },
    'the whole-file view marks the very lines the snippet was');
  assert.equal(whole.text, JAVA);
  assert.equal(whole.snippet, undefined);
  assert.equal(whole.fileLines, JAVA_LINES.length);
  assert.equal(whole.note, undefined, 'a file under the cap is complete and says nothing');
});

test('readSourceFor: a file past the cap is cut, and the answer SAYS it was cut', () => {
  const g = new Graph();
  const symId = nodeId('symbol', 'com.x.Big#bar');
  g.addNode({ id: symId, file: 'Big.java', owner: 'com.x.Big', line: 1 });
  // One line of code, then a megabyte and a half of generated filler.
  const big = 'void bar() { }\n' + 'x'.repeat(WHOLE_FILE_CAP + 500_000);
  const abs = path.resolve(REPO_ROOT, 'Big.java');
  const { io } = makeIo({ [abs]: big });

  const whole = readSourceFor(g, REPO_ROOT, symId, { ...io, whole: true });

  assert.equal(whole.ok, true);
  assert.equal(whole.text.length, WHOLE_FILE_CAP, 'exactly the cap, never a byte past it');
  assert.ok(whole.note.includes(String(big.length)), `the note names the real size: ${whole.note}`);
  assert.ok(whole.note.includes(String(WHOLE_FILE_CAP)), 'and how much of it came back');
  // The snippet view of the same node is unaffected: it was never the whole file.
  const snip = readSourceFor(g, REPO_ROOT, symId, { ...io, whole: false });
  assert.equal(snip.note, undefined);
});

test('readSourceFor: a miss carries the same fields, all empty, so the page has no shape to guess', () => {
  const g = new Graph();
  const { io } = makeIo({});
  const res = readSourceFor(g, REPO_ROOT, nodeId('table', 'does-not-exist'), io);
  assert.deepEqual([res.ok, res.abs, res.from, res.to, res.fileLines], [false, null, null, null, null]);
});

test('readSourceFor: the DDL preview carries the DDL file\'s own absolute path and range', () => {
  const g = new Graph();
  const tid = nodeId('table', 'pms_product');
  g.addNode({ id: tid });
  const ddlAbs = path.resolve(REPO_ROOT, 'db', 'schema.sql');
  const withHeader = ['-- generated', '', DDL].join('\n');
  const { io } = makeIo({ [ddlAbs]: withHeader }, ddlAbs);

  const res = readSourceFor(g, REPO_ROOT, tid, io);

  assert.equal(res.abs, ddlAbs);
  assert.equal(res.file, path.join('db', 'schema.sql'));
  assert.deepEqual({ from: res.from, to: res.to }, { from: 3, to: 6 });
  assert.equal(res.fileLines, 6);
});

// ---------------------------------------------------------------------------
// The frontend lane (RM31): a web function, and a screen's component
// ---------------------------------------------------------------------------

const ROWS_JS = [
  "import request from '@/utils/request'",  // 1
  '',                                       // 2
  'export function listRows(query) {',      // 3
  '  return request({',                     // 4
  "    url: '/rows',",                      // 5
  "    method: 'get'",                      // 6
  '  })',                                   // 7
  '}',                                      // 8
  '',                                       // 9
  'export function saveRow(data) {',        // 10
  '  return request({ url: 1 })',           // 11
  '}',                                      // 12
  '',
].join('\n');

const ROWS_VUE = [
  '<template>',                             // 1
  '  <div>{{ rows.length }}</div>',         // 2
  '</template>',                            // 3
  '',                                       // 4
  '<script>',                               // 5
  "import { listRows } from '@/api/rows'",  // 6
  'export default {',                       // 7
  '  methods: {',                           // 8
  '    getList() {',                        // 9
  '      return listRows()',                // 10
  '    },',                                 // 11
  '  },',                                   // 12
  '}',                                      // 13
  '</script>',                              // 14
  '',                                       // 15
  '<style scoped>',                         // 16
  '.rows { color: red }',                   // 17
  '</style>',                               // 18
  '',
].join('\n');

test('extractWebFunction: brace balance from the recorded line, in REAL file lines', () => {
  const cut = extractWebFunction(ROWS_JS, 3, null);
  assert.deepEqual(pick(cut), { from: 3, to: 8 });
  assert.ok(cut.snippet.startsWith('export function listRows'));
  assert.ok(cut.snippet.endsWith('}'));
  assert.equal(cut.note, undefined, 'the braces closed, so nothing is claimed about a window');
  // A one-line body closes on its own line.
  assert.deepEqual(pick(extractWebFunction(ROWS_JS, 10, null)), { from: 10, to: 12 });
});

test('extractWebFunction: inside a single-file component the lines are the FILE\'s, not the block\'s', () => {
  // `getList` is on line 9 OF THE FILE — the script block is not re-numbered,
  // so `path:line` from this answer is what an editor opens.
  const cut = extractWebFunction(ROWS_VUE, 9, 14);
  assert.deepEqual(pick(cut), { from: 9, to: 11 });
  assert.equal(cut.snippet.split('\n')[0].trim(), 'getList() {');
});

test('extractWebFunction: braces that never close fall back to a window, and SAY they did', () => {
  const runaway = ['const a = {'].concat(new Array(200).fill('  x: 1,')).join('\n');
  const cut = extractWebFunction(runaway, 1, null);
  assert.deepEqual(pick(cut), { from: 1, to: WEB_FALLBACK_LINES });
  assert.match(cut.note, /do not close within 60 lines/);
  // …and so does a line with no brace on it at all.
  const flat = ['const a = 1', 'const b = 2'].join('\n');
  assert.match(extractWebFunction(flat, 1, null).note, /no brace opens at line 1/);
});

test('webLang: the extension decides, and a .vue file is asked what its script is', () => {
  assert.equal(webLang('a/b.js', ''), 'js');
  assert.equal(webLang('a/b.mjs', ''), 'js');
  assert.equal(webLang('a/b.ts', ''), 'ts');
  assert.equal(webLang('a/b.tsx', ''), 'tsx');
  assert.equal(webLang('a/b.vue', ROWS_VUE), 'js', 'no lang attribute means JavaScript');
  assert.equal(webLang('a/b.vue', '<script lang="ts">\n</script>'), 'ts');
  assert.equal(webLang('a/b.vue', "<script setup lang='tsx'>\n</script>"), 'tsx');
});

test('readSourceFor: a web symbol reads its own file, its own extent and its own language', () => {
  const g = new Graph();
  const id = nodeId('symbol', 'src/api/rows.js#listRows');
  g.addNode({ id, file: 'src/api/rows.js', line: 3, lane: 'web' });
  const abs = path.resolve(REPO_ROOT, 'src/api/rows.js');
  const { io, calls } = makeIo({ [abs]: ROWS_JS });

  const res = readSourceFor(g, REPO_ROOT, id, io);

  assert.deepEqual([res.kind, res.ok, res.file, res.abs, res.lang], ['symbol', true, 'src/api/rows.js', abs, 'js']);
  assert.deepEqual({ from: res.from, to: res.to }, { from: 3, to: 8 });
  assert.equal(res.fileLines, 13);
  assert.ok(res.snippet.startsWith('export function listRows'));
  assert.deepEqual(calls, [abs], 'one file, read once');
});

test('readSourceFor: a web symbol inside a component stops at the end of the script block', () => {
  const g = new Graph();
  const id = nodeId('symbol', 'src/views/rows.vue#getList');
  g.addNode({ id, file: 'src/views/rows.vue', line: 9, lane: 'web' });
  const abs = path.resolve(REPO_ROOT, 'src/views/rows.vue');
  const { io } = makeIo({ [abs]: ROWS_VUE });

  const res = readSourceFor(g, REPO_ROOT, id, io);

  assert.deepEqual([res.ok, res.lang], [true, 'js']);
  assert.deepEqual({ from: res.from, to: res.to }, { from: 9, to: 11 });
});

test('readSourceFor: a SCREEN previews the whole component, with its script line marked', () => {
  const g = new Graph();
  const id = nodeId('screen', '/rows');
  g.addNode({ id, path: '/rows', component: 'src/views/rows.vue', lane: 'web', source: 'router' });
  const abs = path.resolve(REPO_ROOT, 'src/views/rows.vue');
  const { io } = makeIo({ [abs]: ROWS_VUE });

  const res = readSourceFor(g, REPO_ROOT, id, io);

  assert.deepEqual([res.kind, res.ok, res.file, res.lang], ['screen', true, 'src/views/rows.vue', 'js']);
  // The RANGE says what this preview covers; `mark` says where to look in it.
  assert.deepEqual({ from: res.from, to: res.to, mark: res.mark }, { from: 1, to: 19, mark: 5 });
  assert.ok(res.snippet.startsWith('<template>'), 'the template is part of what a screen shows');
  assert.ok(res.snippet.includes('<style scoped>'));
});

test('readSourceFor: a screen with no component says which kind of nothing it is', () => {
  const g = new Graph();
  const declared = nodeId('screen', '/unresolved');
  const seen = nodeId('screen', '/only-recorded');
  g.addNode({ id: declared, path: '/unresolved', component: null, source: 'router' });
  g.addNode({ id: seen, path: '/only-recorded', component: null, source: 'har', observed: true });
  const { io } = makeIo({});

  const a = readSourceFor(g, REPO_ROOT, declared, io);
  assert.equal(a.ok, false);
  assert.match(a.note, /named no component this lane could resolve/);

  const b = readSourceFor(g, REPO_ROOT, seen, io);
  assert.equal(b.ok, false);
  assert.match(b.note, /seen in a recording and declared in no source/);
});

// ---------------------------------------------------------------------------
// WHERE THE PANE MAY READ (RM67): the project root and every source root the
// run recorded as analyzed, and nothing else. A frontend passed with
// --web-src ../front lives beside the project, so its files are recorded as
// `../front/...` and must be read; every other way out must not be.
// ---------------------------------------------------------------------------

const FRONT = path.resolve('/front');
const SECRET = path.resolve('/outside/secret.txt');

test('sourceRootsOf: the project root and every source root the run recorded, absolute, and no flag taken for a path', () => {
  const meta = {
    base: { repoPath: REPO_ROOT },
    ddl: path.resolve(REPO_ROOT, 'db/schema.sql'),
    analysis: { selection: {
      javaRoots: ['app/src/main/java'],
      mapperDirs: ['app/src/main/resources/mapper'],
      webRoots: [FRONT],
      tsRoots: ['api/src'],
      templateRoots: [{ root: 'app/src/main/resources/templates', engine: 'thymeleaf', suffix: '.html' }],
      ddls: ['db/schema.sql'],
      sqlArgs: ['--dialect', 'mysql'],
      packagePrefixes: ['com.x'],
    } },
  };
  assert.deepEqual(sourceRootsOf(meta).sort(), [
    REPO_ROOT,
    path.resolve(REPO_ROOT, 'app/src/main/java'),
    path.resolve(REPO_ROOT, 'app/src/main/resources/mapper'),
    FRONT,
    path.resolve(REPO_ROOT, 'api/src'),
    path.resolve(REPO_ROOT, 'app/src/main/resources/templates'),
    path.resolve(REPO_ROOT, 'db/schema.sql'),
  ].sort());
});

test('sourceRootsOf: a pack from before the selection was recorded reads its project root and its DDL; one with no repository path reads nothing', () => {
  assert.deepEqual(sourceRootsOf({ base: { repoPath: REPO_ROOT } }), [REPO_ROOT]);
  const ddl = path.resolve('/db/schema.sql');
  assert.deepEqual(sourceRootsOf({ base: { repoPath: REPO_ROOT }, ddl }).sort(), [REPO_ROOT, ddl].sort());
  assert.deepEqual(sourceRootsOf({ base: { repoPath: null }, analysis: { selection: { webRoots: [FRONT] } } }), []);
  assert.deepEqual(sourceRootsOf(null), []);
});

test('readSourceFor: a frontend analyzed beside the project (--web-src ../front) is read from its own root', () => {
  const g = new Graph();
  const fn = nodeId('symbol', '../front/src/api/rows.js#listRows');
  g.addNode({ id: fn, file: '../front/src/api/rows.js', line: 3, lane: 'web' });
  const screen = nodeId('screen', '/rows');
  g.addNode({ id: screen, path: '/rows', component: '../front/src/views/rows.vue', lane: 'web', source: 'router' });
  const js = path.resolve(FRONT, 'src/api/rows.js');
  const vue = path.resolve(FRONT, 'src/views/rows.vue');
  const { io, calls } = makeIo({ [js]: ROWS_JS, [vue]: ROWS_VUE }, undefined, [REPO_ROOT, FRONT]);

  const a = readSourceFor(g, REPO_ROOT, fn, io);
  assert.deepEqual([a.ok, a.file, a.abs, a.lang], [true, '../front/src/api/rows.js', js, 'js']);
  assert.deepEqual({ from: a.from, to: a.to }, { from: 3, to: 8 });
  const b = readSourceFor(g, REPO_ROOT, screen, io);
  assert.deepEqual([b.ok, b.file, b.abs, b.mark], [true, '../front/src/views/rows.vue', vue, 5]);
  assert.deepEqual(calls, [js, vue]);
});

// Every kind of node the pane reads a file for goes through the same door.
const FILE_NODES = [
  ['a web function', (file) => ({ id: nodeId('symbol', 'x.js#f'), file, line: 1, lane: 'web' })],
  ['a screen', (file) => ({ id: nodeId('screen', '/x'), path: '/x', component: file, lane: 'web', source: 'router' })],
  ['a statement', (file) => ({ id: nodeId('statement', 'ns.x'), file })],
  ['a Java method', (file) => ({ id: nodeId('symbol', 'com.x.X#f'), file, owner: 'com.x.X', line: 1 })],
];

test('readSourceFor: nothing outside the recorded roots is read, however the path is spelled', () => {
  const spellings = [
    ['a parent escape', '../outside/secret.txt'],
    ['an escape through a recorded root', '../front/../outside/secret.txt'],
    ['a sibling that shares a root\'s prefix', '../front-evil/src/x.js'],
    ['an absolute path', SECRET],
    ['an escape from deep inside', 'src/../../outside/secret.txt'],
  ];
  for (const [kind, make] of FILE_NODES) {
    for (const [how, file] of spellings) {
      const g = new Graph();
      const node = make(file);
      g.addNode(node);
      const { io, calls } = makeIo({ [SECRET]: 'TOP SECRET', [path.resolve(REPO_ROOT, file)]: 'TOP SECRET' }, undefined, [REPO_ROOT, FRONT]);
      const res = readSourceFor(g, REPO_ROOT, node.id, io);
      assert.equal(res.ok, false, `${kind}, ${how}`);
      assert.deepEqual(calls, [], `${kind}, ${how}: nothing is read`);
      assert.equal(res.abs, null);
      assert.match(res.note, /^refused .+: it is not under a source root this pack analyzed$/, `${kind}, ${how}`);
    }
  }
});

test('readSourceFor: a percent-encoded dot is a name, never decoded into an escape', () => {
  const g = new Graph();
  const file = '%2e%2e/%2e%2e/outside/secret.txt';
  g.addNode({ id: nodeId('symbol', 'x.js#f'), file, line: 1, lane: 'web' });
  const literal = path.resolve(REPO_ROOT, file);
  const { io, calls } = makeIo({ [SECRET]: 'TOP SECRET' }, undefined, [REPO_ROOT, FRONT]);
  const res = readSourceFor(g, REPO_ROOT, nodeId('symbol', 'x.js#f'), io);
  assert.equal(res.ok, false);
  assert.ok(literal.startsWith(REPO_ROOT + path.sep), 'the literal name sits inside the project');
  assert.deepEqual(calls, [literal], 'the name as written, which is not there, and never the decoded one');
  assert.equal(res.note, 'cannot read ' + file);
});

test('readSourceFor: a caller that cannot follow links is refused outright rather than served unconfined', () => {
  const g = new Graph();
  g.addNode({ id: nodeId('symbol', 'x.js#f'), file: 'x.js', line: 1, lane: 'web' });
  assert.throws(() => readSourceFor(g, REPO_ROOT, nodeId('symbol', 'x.js#f'), { readFile: () => 'x' }), /realPath/);
});

test('readSourceFor: the DDL is read only where the pack recorded it', () => {
  const g = new Graph();
  const tid = nodeId('table', 'pms_product');
  g.addNode({ id: tid });
  const ddl = path.resolve('/outside/schema.sql');
  const refused = makeIo({ [ddl]: DDL }, ddl, [REPO_ROOT]);
  const res = readSourceFor(g, REPO_ROOT, tid, refused.io);
  assert.equal(res.ok, false);
  assert.deepEqual(refused.calls, []);
  assert.match(res.note, /^refused .+: it is not under a source root this pack analyzed$/);
  const recorded = makeIo({ [ddl]: DDL }, ddl, [REPO_ROOT, ddl]);
  const ok = readSourceFor(g, REPO_ROOT, tid, recorded.io);
  assert.deepEqual([ok.ok, ok.abs, ok.snippet], [true, ddl, DDL]);
});

// ---- the same door, on a real tree with real links ---------------------------

/**
 * A project, a frontend beside it, and a folder outside both, on disk. The
 * project root is recorded as the run was pointed at it; a root outside the
 * repository is recorded by its real path, and a file by its path from the
 * project root to its real path, which is how analyze records them.
 */
function besideTree(t) {
  // Real, so every link in this tree is one the test made.
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-src-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const put = (rel, text) => {
    const f = path.join(top, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  put('repo/src/api/rows.js', ROWS_JS);
  put('front/src/api/rows.js', ROWS_JS);
  put('front/src/views/rows.vue', ROWS_VUE);
  put('outside/secret.js', 'export function stolen() {\n  return "TOP SECRET"\n}\n');
  fs.symlinkSync(path.join(top, 'outside/secret.js'), path.join(top, 'repo/src/api/leak.js'));
  fs.symlinkSync(path.join(top, 'outside'), path.join(top, 'front/src/linked'));
  fs.symlinkSync(path.join(top, 'repo/src/api/rows.js'), path.join(top, 'front/src/api/shared.js'));
  const repo = path.join(top, 'repo');
  const front = fs.realpathSync(path.join(top, 'front'));
  const meta = { base: { repoPath: repo }, analysis: { selection: { javaRoots: [], webRoots: [front] } } };
  // As a lane records a file: from the project root to the file's real path.
  const recorded = (abs) => path.relative(repo, fs.realpathSync(abs)).split(path.sep).join('/');
  // As a pack could name a link it walked through, without following it.
  const walked = (abs) => path.relative(repo, abs).split(path.sep).join('/');
  return { top, repo, front, meta, recorded, walked };
}

const webFn = (g, file, line = 3) => {
  const id = nodeId('symbol', `${file}#f`);
  g.addNode({ id, file, line, lane: 'web' });
  return id;
};

test('readSourceFor on disk: the frontend beside the project is read, its screen too', (t) => {
  const { top, repo, meta, recorded } = besideTree(t);
  const g = new Graph();
  const fn = webFn(g, recorded(path.join(top, 'front/src/api/rows.js')));
  const screen = nodeId('screen', '/rows');
  g.addNode({ id: screen, path: '/rows', component: recorded(path.join(top, 'front/src/views/rows.vue')), lane: 'web', source: 'router' });
  const a = readSourceFor(g, repo, fn, diskSourceIo(meta));
  assert.equal(a.ok, true, a.note);
  assert.ok(a.snippet.startsWith('export function listRows'));
  const b = readSourceFor(g, repo, screen, diskSourceIo(meta, { whole: true }));
  assert.equal(b.ok, true, b.note);
  assert.equal(b.text, ROWS_VUE);
});

test('readSourceFor on disk: a project root recorded through a link still reads the frontend recorded by its real path', (t) => {
  // macOS's temporary folder is such a link (/var -> /private/var): the run
  // records the project root as it was pointed at, a root outside the
  // repository by its real path, and a file from the one to the other.
  const { top, front } = besideTree(t);
  fs.symlinkSync(top, path.join(top, 'alias'));
  const repo = path.join(top, 'alias', 'repo');
  const meta = { base: { repoPath: repo }, analysis: { selection: { webRoots: [front] } } };
  const g = new Graph();
  const fn = webFn(g, path.relative(repo, path.join(front, 'src/api/rows.js')).split(path.sep).join('/'));
  const res = readSourceFor(g, repo, fn, diskSourceIo(meta));
  assert.equal(res.ok, true, res.note);
  assert.ok(res.snippet.startsWith('export function listRows'));
  // ...and the project's own file, by the linked spelling.
  const own = webFn(g, 'src/api/rows.js');
  assert.equal(readSourceFor(g, repo, own, diskSourceIo(meta)).ok, true);
});

test('readSourceFor on disk: a link out of a recorded root is refused, a file link and a folder link alike', (t) => {
  const { top, repo, meta, walked } = besideTree(t);
  for (const link of ['repo/src/api/leak.js', 'front/src/linked/secret.js']) {
    const g = new Graph();
    const fn = webFn(g, walked(path.join(top, link)), 1);
    const res = readSourceFor(g, repo, fn, diskSourceIo(meta, { whole: true }));
    assert.equal(res.ok, false, link);
    assert.equal(res.abs, null);
    assert.ok(!JSON.stringify(res).includes('TOP SECRET'), `${link}: the target's text never comes back`);
    assert.match(res.note, /^refused .+: it is a link to a file outside the source roots this pack analyzed$/, link);
  }
});

test('readSourceFor on disk: a link from one recorded root into another is read', (t) => {
  const { top, repo, meta, walked } = besideTree(t);
  const g = new Graph();
  const fn = webFn(g, walked(path.join(top, 'front/src/api/shared.js')));
  const res = readSourceFor(g, repo, fn, diskSourceIo(meta));
  assert.equal(res.ok, true, res.note);
  assert.ok(res.snippet.startsWith('export function listRows'));
});

test('readSourceFor on disk: a root an old pack recorded that is gone is said, and nothing under it is read', (t) => {
  const { top, repo, front, meta } = besideTree(t);
  const gone = path.join(top, 'gone-front');
  const old = { ...meta, analysis: { selection: { webRoots: [front, gone] } } };
  const g = new Graph();
  const fn = webFn(g, path.relative(repo, path.join(gone, 'src/api/rows.js')).split(path.sep).join('/'));
  const res = readSourceFor(g, repo, fn, diskSourceIo(old));
  assert.equal(res.ok, false);
  assert.match(res.note, /^cannot read .+: the source root it was analyzed under, .+gone-front, no longer exists$/);
  // The frontend that IS still there reads as before.
  const here = webFn(g, path.relative(repo, path.join(front, 'src/api/rows.js')).split(path.sep).join('/'));
  assert.equal(readSourceFor(g, repo, here, diskSourceIo(old)).ok, true);
});

test('readSourceFor on disk: a node id that names a path is not a way in: only a node the pack holds is read', (t) => {
  const { repo, meta } = besideTree(t);
  const res = readSourceFor(new Graph(), repo, 'symbol:../outside/secret.js#stolen', diskSourceIo(meta));
  assert.equal(res.ok, false);
  assert.match(res.note, /^node not in pack/);
});

test('readSourceFor: a route no analyzed code answers (a call the frontend makes outward) says there is no handler, and never throws', () => {
  const g = new Graph();
  const eid = nodeId('endpoint', 'ANY /login');
  g.addNode({ id: eid, path: '/login', httpMethod: 'ANY', outbound: true, source: 'web' });
  const { io, calls } = makeIo({});

  const res = readSourceFor(g, REPO_ROOT, eid, io);

  assert.deepEqual(calls, [], 'nothing is read for a route with no handler');
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'endpoint');
  assert.match(res.note, /no handler/);
});
