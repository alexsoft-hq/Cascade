import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWER_STRINGS } from '../src/viewer/i18n.mjs';

// The VOICE of the catalogue (RM23), held mechanically.
//
// Every string on this page is one senior developer explaining a screen to a
// junior who knows Spring and SQL but has never seen this tool. Most of that is
// a judgement a test cannot make. Four things it CAN make, and they are the
// four that went wrong before: the em dash used as a connector, a lead that
// grew into a paragraph, a `more` that grew into an essay, and Korean written
// in the flat note-taking register (해라체: "읽는다", "배치했다") instead of the
// polite one a colleague actually speaks (합니다체).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EN = VIEWER_STRINGS.en;
const KO = JSON.parse(fs.readFileSync(path.join(ROOT, 'viewer', 'i18n', 'ko.json'), 'utf8'));
const CATALOGUES = [['en', EN], ['ko', KO]];

// The masthead dateline separates its four facts with a middle dot. It is drawn
// by the page itself (`<span class="msep">·</span>` in viewer/index.html), not
// by a catalogue string, so no key is exempt today. The list stays here because
// the day a dateline key appears, this is where it must be named.
const DATELINE_KEYS = new Set([]);

test('no catalogue string uses an em dash or a middle dot', () => {
  // An em dash is how a paragraph avoids deciding where its sentence ends; a
  // middle dot is the dateline's punctuation and belongs to the dateline.
  for (const [lang, cat] of CATALOGUES) {
    for (const [k, v] of Object.entries(cat)) {
      if (DATELINE_KEYS.has(k)) continue;
      assert.equal(v.includes('—'), false, `${lang}/${k} carries an em dash: ${v}`);
      assert.equal(v.includes(' · '), false, `${lang}/${k} carries a middle dot: ${v}`);
    }
  }
});

test('a tab hint LEAD is one line: at most 90 characters, in both languages', () => {
  const leads = Object.keys(EN).filter((k) => /^hint\..*\.lead$/.test(k));
  assert.ok(leads.length >= 8, `expected a lead per tab hint, found ${leads.length}`);
  for (const k of leads) {
    for (const [lang, cat] of CATALOGUES) {
      assert.ok(cat[k].length <= 90, `${lang}/${k} is ${cat[k].length} characters: ${cat[k]}`);
    }
  }
});

/** Sentences, counted the way a reader counts them: a full stop plus a space. */
function sentences(text) {
  return String(text).replace(/\{\w+\}/g, 'X').split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

test('a tab hint MORE is at most four short sentences, in both languages', () => {
  const mores = Object.keys(EN).filter((k) => /^hint\..*\.more$/.test(k));
  assert.ok(mores.length >= 8, `expected a paragraph per tab hint, found ${mores.length}`);
  for (const k of mores) {
    for (const [lang, cat] of CATALOGUES) {
      const n = sentences(cat[k]).length;
      assert.ok(n <= 4, `${lang}/${k} is ${n} sentences; four is the most a fold should hold`);
    }
  }
});

// ---------------------------------------------------------------------------
// Korean: 합니다체 everywhere a sentence ends
// ---------------------------------------------------------------------------

// A Korean verb ending in `다` right before a full stop (or at the end of the
// string) is a sentence-final form. The polite register this page is written in
// puts `니` before it — "합니다", "있습니다", "봅니다". The flat one does not:
// "읽는다", "배치했다", "아니다". So the rule is exactly: a sentence may end in
// `다` only as `니다`.
const SENTENCE_FINAL = /([가-힣])다(?=[.!?]|$)/g;

// Exceptions, if a Korean sentence ever has to end on an engine word or an id
// instead of a verb. None are needed today: every ko string either ends in
// 합니다체 or is a label with no sentence in it at all (a tab name, a legend
// heading, a count like "({n}종)").
const KO_SENTENCE_EXCEPTIONS = new Set([]);

test('every Korean sentence ends in 합니다체, never the flat 해라체', () => {
  const offenders = [];
  for (const [k, v] of Object.entries(KO)) {
    if (KO_SENTENCE_EXCEPTIONS.has(k)) continue;
    for (const m of v.matchAll(SENTENCE_FINAL)) {
      if (m[1] !== '니') offenders.push(`${k}: …${v.slice(Math.max(0, m.index - 18), m.index + 2)}`);
    }
  }
  assert.deepEqual(offenders, [], `these Korean sentences are still in the flat register:\n${offenders.join('\n')}`);
});

test('the Korean catalogue really is written out, not left as English', () => {
  // The register test above passes trivially on a string with no Korean verb in
  // it, so this one holds the other end: nearly every value carries Hangul.
  const hangul = /[가-힣]/;
  const translated = Object.values(KO).filter((v) => hangul.test(v));
  assert.ok(translated.length > Object.keys(KO).length * 0.8,
    `only ${translated.length}/${Object.keys(KO).length} ko strings carry Hangul`);
});

// ---------------------------------------------------------------------------
// The engine's own sentences reach the same readers, so they follow the same
// two rules a machine can check: no em dash, and no middle dot.
// ---------------------------------------------------------------------------

test('the MCP tool descriptions carry no em dash and no middle dot either', async () => {
  const { toolList } = await import('../src/mcp/catalog.mjs');
  for (const t of toolList().tools) {
    assert.equal(t.description.includes('—'), false, `${t.name}'s description carries an em dash`);
    assert.equal(t.description.includes(' · '), false, `${t.name}'s description carries a middle dot`);
  }
});

// ---------------------------------------------------------------------------
// RM24: the same two rules over the SOURCE, not over one catalogue
// ---------------------------------------------------------------------------
//
// The catalogue test above only sees strings the catalogue holds. The CLI, the
// engine's error messages and the two workers print sentences of their own, and
// those reach exactly the same reader. There is no list of them to iterate, so
// the check runs over the files: strip the comments, and anything left holding
// an em dash or a middle dot is a string literal by construction.
//
// The rule is about text a PERSON READS AT RUNTIME, so comments keep their
// dashes: a comment is written for whoever edits the file next.

/** Strip line comments and block comments from JS, keeping every string literal. */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = ''; // last significant character, to tell `/` division from a regex
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      let nl = '';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') nl += '\n'; i++; }
      i += 2;
      out += ` ${nl}`; // the newlines stay, so a line number still means something
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i++; break; }
        i++;
      }
      prev = c;
      continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*%<>~^]/.test(prev)) {
      // a regex literal: `/` right after an operator or an opening bracket
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { out += src[i]; i++; break; }
        out += src[i];
        i++;
      }
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Strip `#` comments and docstrings from Python, keeping every other string. */
function stripPyComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lineHasCode = false;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { out += c; lineHasCode = false; i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const q = src.slice(i, i + 3) === c.repeat(3) ? c.repeat(3) : c;
      // A string that OPENS a statement is a docstring: prose about the code,
      // not something the code prints.
      const docstring = !lineHasCode;
      let body = q;
      i += q.length;
      while (i < n) {
        if (src[i] === '\\') { body += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src.slice(i, i + q.length) === q) { body += q; i += q.length; break; }
        body += src[i];
        i++;
      }
      out += docstring ? body.replace(/[^\n]/g, ' ') : body;
      lineHasCode = true;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lineHasCode = true;
    i++;
  }
  return out;
}

/** Strip line comments and block comments from Java, keeping every string literal. */
function stripJavaComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      let nl = '';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') nl += '\n'; i++; }
      i += 2;
      out += ` ${nl}`;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Literals that may keep an em dash, each with the reason it is not prose.
// A DDL COMMENT in a fixture is DATA: it is there to prove the extractor
// carries a comment through byte for byte, punctuation included, which is what
// a real Chinese or Korean schema comment looks like. Rewriting it would delete
// the coverage instead of fixing a sentence.
const DASH_ALLOWED = [
  { file: 'adapters/sql/test_catalog_ddl.py', text: 'Product code (SKU) — unique', why: 'DDL fixture data' },
  { file: 'adapters/sql/test_catalog_ddl.py', text: 'Deletion status — 0/1', why: 'DDL fixture data' },
  { file: 'adapters/sql/test_catalog_ddl.py', text: 'Product master — catalogue', why: 'DDL fixture data' },
];

function walkMjs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMjs(p, acc);
    else if (e.name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

/** Every offending line of one file, once its comments are gone. */
function dashLines(rel, strip) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let stripped = strip(src);
  for (const a of DASH_ALLOWED) {
    if (a.file === rel) stripped = stripped.split(a.text).join(' ');
  }
  const original = src.split('\n');
  const out = [];
  stripped.split('\n').forEach((line, i) => {
    if (line.includes('—')) out.push(`${rel}:${i + 1} em dash: ${original[i].trim()}`);
    if (line.includes(' · ')) out.push(`${rel}:${i + 1} middle dot: ${original[i].trim()}`);
  });
  return out;
}

test('no runtime string in the CLI or the engine carries an em dash or a middle dot', () => {
  const files = ['bin/cascade.mjs', ...walkMjs(path.join(ROOT, 'src')).map((p) => path.relative(ROOT, p)).sort()];
  assert.ok(files.length > 40, `expected the whole engine, found ${files.length} file(s)`);
  const offenders = files.flatMap((rel) => dashLines(rel, stripJsComments));
  assert.deepEqual(offenders, [], `these runtime strings are still punctuated like a machine wrote them:\n${offenders.join('\n')}`);
});

/**
 * The web worker's own source: the entry file and the modules RM49 split its
 * body into. The DIRECTORY is read rather than listed, so a module added
 * tomorrow is held to these rules without anybody remembering. `vendor/` is
 * outside them on purpose: the parser in there is third-party text governed by
 * NOTICE, and it is not ours to repunctuate (adapters/web/vendor/README.md
 * says so too).
 */
function webWorkerFiles() {
  const dir = path.join(ROOT, 'adapters', 'web');
  const top = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => `adapters/web/${e.name}`);
  const lib = fs.readdirSync(path.join(dir, 'lib'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => `adapters/web/lib/${e.name}`);
  return [...top, ...lib].sort();
}

test('every worker prints the same way: no em dash, no middle dot', () => {
  const py = fs.readdirSync(path.join(ROOT, 'adapters', 'sql'))
    .filter((f) => f.endsWith('.py')).sort().map((f) => `adapters/sql/${f}`);
  assert.ok(py.length >= 6, `expected the SQL worker's python, found ${py.length} file(s)`);
  // The web lane's worker is JavaScript and lives beside the other two. Only
  // the top level of `adapters/web/` is walked, NOT `adapters/web/vendor`: the
  // parser in there is third-party text governed by NOTICE, and it is not ours
  // to repunctuate (adapters/web/vendor/README.md says so too).
  const web = webWorkerFiles();
  assert.ok(web.length >= 6, `expected the web worker and its modules, found ${web.length} file(s)`);
  const offenders = [
    ...py.flatMap((rel) => dashLines(rel, stripPyComments)),
    ...dashLines('adapters/java/JavaFacts.java', stripJavaComments),
    ...web.flatMap((rel) => dashLines(rel, stripJsComments)),
  ];
  assert.deepEqual(offenders, [], `these worker strings are still punctuated like a machine wrote them:\n${offenders.join('\n')}`);
});

test('the web worker is English, carries no NUL byte, and the vendored parser is left alone', () => {
  // The same three rules the rest of the runtime lives under, applied to the
  // one adapter that is JavaScript. `vendor/` is deliberately outside all of
  // them and this test states which files it did and did not read.
  const dir = path.join(ROOT, 'adapters', 'web');
  const own = webWorkerFiles();
  assert.deepEqual(own, [
    'adapters/web/lib/ast.mjs', 'adapters/web/lib/calls.mjs', 'adapters/web/lib/emit.mjs',
    'adapters/web/lib/imports.mjs', 'adapters/web/lib/routers.mjs', 'adapters/web/lib/templates.mjs',
    'adapters/web/webfacts.mjs',
  ]);
  const CJK = /[\u1100-\u11ff\u3000-\u30ff\u3130-\u318f\u4e00-\u9fff\uac00-\ud7af]/;
  for (const rel of own) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    assert.equal(buf.indexOf(0), -1, `${rel} carries a literal NUL byte`);
    assert.equal(CJK.test(buf.toString('utf8')), false, `${rel} carries non-English text`);
  }
  // The parser is present and is NOT one of the files above.
  assert.ok(fs.existsSync(path.join(dir, 'vendor', 'babel-parser.cjs')),
    'the vendored parser must be here; the exclusion is only meaningful because there is something to exclude');
});

test('the dash allowlist stays honest: every entry is still in its file', () => {
  // An allowlist nobody prunes is how an exception becomes the rule. Each entry
  // must still exist, so a rewritten fixture takes its exemption with it.
  for (const a of DASH_ALLOWED) {
    const src = fs.readFileSync(path.join(ROOT, a.file), 'utf8');
    assert.ok(src.includes(a.text), `${a.file} no longer contains the allowlisted ${JSON.stringify(a.text)} (${a.why}); drop the entry`);
  }
});
