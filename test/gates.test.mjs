import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// M0 hygiene gates (SPEC §15 M0). All always-on: they scan the repository as it
// is, so an internal coordinate, a non-English runtime string or a licence slip
// fails the build rather than waiting for a reviewer to notice.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What every gate reads. `viewer/vendor` is excluded: it holds pre-built
// third-party bundles that are governed by NOTICE, not by our own style rules.
const SCAN_ROOTS = [
  // `viewer/index.html` is the page's markup and CSS; `viewer/js` is the page's
  // code, which used to be inside it. Both, or the gates would stop reading two
  // thirds of the viewer the day it was split into files.
  'src', 'bin', 'adapters', 'viewer/index.html', 'viewer/js', 'scripts', 'docs', 'README.md',
  // The Korean mirror of the README is a first page too, and a pasted path or a
  // colleague's address lands there exactly as easily as in the English one.
  'README.ko.md', 'NOTICE', 'test',
  // The governance files (SPEC §15 M11). They are the FIRST thing an outside
  // contributor reads, so a pasted internal host or a colleague's e-mail lands
  // there most easily of all.
  'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'DCO', 'CHANGELOG.md',
];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'vendor']);
const RUNTIME_ROOTS = ['src', 'bin', 'adapters', 'viewer/index.html', 'viewer/js', 'scripts'];

// EXCLUDED FROM EVERY GATE: the translation catalogues (SPEC §17.11).
// `viewer/i18n/*.json` is the ONE place in this repository where non-English
// text is expected — that is what a translation is. Excluding it is what lets
// the English-only gate below keep scanning `src`, `bin`, `adapters`, `scripts`
// and the viewer's own files without exception, and it is the whole reason the
// Korean strings live in a JSON file the viewer server hands out at
// `GET /i18n/ko.json` rather than inside the page.
const EXCLUDED_PATHS = ['viewer/i18n'];
const isExcluded = (rel) => EXCLUDED_PATHS.some((x) => rel === x || rel.startsWith(x + '/'));

// Binary assets the documentation carries: the viewer screenshots under
// docs/assets/screens. Every gate below reads a file as TEXT and looks at it
// line by line, which a PNG is not: it has no lines, it contains NUL bytes by
// definition, and the bytes it does have are noise a host or an address pattern
// could match by accident. So they are skipped by extension rather than by path,
// because the rule is about the KIND of file and not about one directory. SVG is
// deliberately absent: it is text, it is written by hand here, and it is scanned.
const BINARY_ASSET = /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|mp4|mov|webm|m4v)$/i;
const isBinaryAsset = (rel) => BINARY_ASSET.test(rel);

/** Every file under the given roots, sorted, as {rel, text}. */
function filesUnder(roots) {
  const out = [];
  const visit = (abs) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (SKIP_DIRS.has(name)) continue;
        visit(path.join(abs, name));
      }
      return;
    }
    if (!st.isFile()) return;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (isExcluded(rel) || isBinaryAsset(rel)) return;
    out.push({ rel, text: fs.readFileSync(abs, 'utf8') });
  };
  for (const r of roots) {
    const abs = path.join(ROOT, r);
    if (fs.existsSync(abs)) visit(abs);
  }
  return out;
}

const withLines = (text) => text.split('\n');

/** Report shape shared by the gates: "<file>:<line>: <hit>". */
function hits(files, matcher) {
  const found = [];
  for (const f of files) {
    withLines(f.text).forEach((line, i) => {
      for (const hit of matcher(line, f.rel)) found.push(`${f.rel}:${i + 1}: ${hit}`);
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Gate 1 — no internal coordinates
// ---------------------------------------------------------------------------

// Private IPv4 ranges (RFC 1918). A literal from an internal network must never
// reach a public repository.
const PRIVATE_IPV4 = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;

// Hosts this project may legitimately name. Each entry says why it is here.
const ALLOWED_HOSTS = new Set([
  'github.com',        // source/issue links, and the upstream URLs cited in NOTICE
  'api.github.com',    // GitHub REST API
  'localhost',         // local servers
  '127.0.0.1',         // ditto (the viewer binds here)
  '0.0.0.0',           // bind-any in server examples
  'www.w3.org',        // SVG/XML namespace URIs
  'www.apache.org',    // Apache-2.0 licence text (LICENSE, NOTICE)
  'opensource.org',    // OSI licence pages (MIT text in NOTICE)
  'spdx.org',          // SPDX licence identifiers
  'mybatis.org',       // the MyBatis mapper DTD every mapper XML declares in its DOCTYPE
  // The two template languages' own NAMESPACE identifiers (RM48). A Thymeleaf
  // page opens with `xmlns:th="https://www.thymeleaf.org"` and a JSP with
  // `<%@ taglib uri="http://java.sun.com/jsp/jstl/core" %>`; both are a
  // standard's identifier, exactly like the W3C and MyBatis ones above, and a
  // fixture that dropped them would not be the file the reader has to read.
  'www.thymeleaf.org',
  'java.sun.com',
  // The OTLP schema URL every OpenTelemetry export stamps on its resource
  // (`"schemaUrl": "https://opentelemetry.io/schemas/1.24.0"`). It is in the
  // real-agent trace fixture because the agent wrote it, and a standard's own
  // identifier can no more be somebody's internal address than the W3C
  // namespace above can.
  'opentelemetry.io',
  // CODE_OF_CONDUCT.md is the Contributor Covenant 2.1 VERBATIM, and its own
  // text carries these three links. Removing them would break the CC BY 4.0
  // attribution the licence requires, so the allowlist grows instead.
  'www.contributor-covenant.org',  // the Covenant's homepage, FAQ and translations
  'creativecommons.org',           // the CC BY 4.0 deed the Covenant is licensed under
  'mozilla.org',                   // Mozilla's code-of-conduct enforcement ladder, cited by the Covenant
  'docs.github.com',               // GitHub's private vulnerability reporting docs (SECURITY.md)
  'developercertificate.org',      // the canonical DCO 1.1 text this repository vendors
  'keepachangelog.com',            // the CHANGELOG format this file follows
  'semver.org',                    // the versioning scheme the CHANGELOG declares
  'www.npmjs.com',                 // this package's own registry page
  'registry.npmjs.org',            // the registry itself, cited where a vendored bundle came from
]);

// Names that are RESERVED BY STANDARD and can therefore never be somebody's
// real coordinate, however they are spelled: RFC 2606 reserves example.com,
// example.org and example.net (and, by delegation, every subdomain of them —
// db.example.com, api.example.com) for documentation, and .invalid for names
// that must never resolve. Fixtures need those subdomains: a DB connection
// example is clearer as db.example.com than as a contortion around the bare
// domain, and neither can leak an internal address.
const RESERVED_NAME = /(^|\.)(example\.(com|org|net)|invalid)$/i;
const isReserved = (host) => RESERVED_NAME.test(host);

const URL_RE = /\bhttps?:\/\/([^\s"'`)>\]},;\\]+)/g;

function urlHits(line) {
  const out = [];
  for (const m of line.matchAll(URL_RE)) {
    const host = m[1].split('/')[0].split('@').pop();
    // A template placeholder (`http://${host}`) names no host at all.
    if (host.includes('$') || host.includes('{')) continue;
    const bare = host.replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(bare) && !isReserved(bare)) out.push(`host ${bare} is not in the gate allowlist (${m[0]})`);
  }
  return out;
}

// An address that is neither the documentation domain nor a no-reply sender is
// somebody's real e-mail.
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
// macOS and Linux home directories. `/home/<name>/` catches Linux, `/Users/<name>/` macOS;
// a bare `/Users/` or `/home/` (no user segment) is not a coordinate and is allowed.
const HOME_PATH = /(?:\/Users|\/home)\/[A-Za-z0-9_.-]+\//g;

function emailHits(line) {
  const out = [];
  for (const m of line.matchAll(EMAIL_RE)) {
    const [full, local, domain] = m;
    if (isReserved(domain)) continue; // an address at a reserved name is nobody's
    if (local.toLowerCase() === 'noreply' || local.toLowerCase() === 'no-reply') continue;
    out.push(`e-mail address ${full}`);
  }
  return out;
}

/**
 * Optional extra literals, one per line, from a gitignored `.cascade-denylist`
 * (blank lines and `#` comments ignored). It lets a contributor grep for their
 * own employer's names without those names ever entering the repository.
 * @returns {{used:boolean, terms:string[], file:string}}
 */
function loadDenylist() {
  const file = path.join(ROOT, '.cascade-denylist');
  if (!fs.existsSync(file)) return { used: false, terms: [], file };
  const terms = fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  return { used: true, terms, file };
}

test('gate: no internal coordinates (private IPs, non-allowlisted hosts, personal e-mail)', () => {
  const files = filesUnder(SCAN_ROOTS);
  assert.ok(files.length > 20, `expected the gate to scan the repository, got ${files.length} files`);

  const found = [
    ...hits(files, (line) => [...line.matchAll(PRIVATE_IPV4)].map((m) => `private IPv4 literal ${m[0]}`)),
    ...hits(files, (line) => urlHits(line)),
    ...hits(files, (line) => emailHits(line)),
    // A developer's home directory names the developer: `/Users/<name>/…` or
    // `/home/<name>/…` must never be pasted into docs or code (paths in the
    // repository are relative, or come from the environment at run time).
    ...hits(files, (line) => [...line.matchAll(HOME_PATH)].map((m) => `home-directory path ${m[0]}`)),
  ];
  assert.deepEqual(found, [], `internal coordinates found:\n${found.join('\n')}`);
});

test('gate: reserved documentation names pass the host gate; anything else does not', () => {
  // RFC 2606 subdomains a fixture legitimately needs...
  assert.deepEqual(urlHits('the datasource url is http://db.example.com:3306/orders'), []);
  assert.deepEqual(urlHits('https://api.example.org/v1 and http://www.example.net/'), []);
  assert.deepEqual(urlHits('https://broker.invalid/queue'), []);
  // ...and a name that is NOT reserved is still a finding. The host is
  // assembled at run time so that this very line does not trip the file gate.
  const notReserved = urlHits('see http://' + 'intranet.' + 'somecompany.tld/wiki');
  assert.equal(notReserved.length, 1, 'a non-reserved host must still be reported');
  assert.match(notReserved[0], /is not in the gate allowlist/);
  // "example.com.evil.tld" ENDS with a reserved label in the middle only — the
  // anchor is on the end of the host, so it is not reserved.
  assert.equal(urlHits('http://' + 'example.com.' + 'attacker.tld/x').length, 1);
});

test('gate: optional .cascade-denylist literals (and it says whether one was used)', () => {
  const { used, terms, file } = loadDenylist();
  // Visible either way — a gate that quietly does nothing is worse than no gate.
  console.log(used
    ? `denylist: ${file} used — ${terms.length} extra literal(s)`
    : 'denylist: absent — pattern gate only');
  if (!used || terms.length === 0) return;

  const files = filesUnder(SCAN_ROOTS);
  const lowered = terms.map((t) => t.toLowerCase());
  const found = hits(files, (line) => {
    const l = line.toLowerCase();
    return lowered.filter((t) => l.includes(t)).map(() => 'denylisted literal');
  });
  assert.deepEqual(found, [], `denylisted literals found (${found.length}); the terms themselves are not printed`);
});

// ---------------------------------------------------------------------------
// Gate 2 — English runtime strings (SPEC §17.11)
// ---------------------------------------------------------------------------

// Hangul (syllables + jamo), Hiragana/Katakana, and CJK ideographs.
const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/g;

test('gate: the runtime speaks English — no Hangul/CJK in src, bin, adapters, the viewer page or scripts', () => {
  const files = filesUnder(RUNTIME_ROOTS);
  assert.ok(files.length > 10, `expected the gate to scan the runtime, got ${files.length} files`);
  const found = hits(files, (line) => {
    const m = line.match(CJK);
    return m ? [`non-English characters: ${[...new Set(m)].join('')}`] : [];
  });
  assert.deepEqual(found, [], `non-English runtime text found:\n${found.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Gate 2a — a runtime string never cites a document the reader cannot open
// ---------------------------------------------------------------------------

// The specification this engine was built against is private, and so are the
// round briefs and the handover note. A code COMMENT may cite them: it is the
// developer's own note and only a contributor reads it. A runtime STRING may
// not, because it is printed into somebody else's terminal, written into
// somebody else's repository (the `.gitignore` `cascade init` leaves behind), or
// handed to a model as a tool description. A pointer there is a dead end that
// also advertises something the reader cannot have, so the rule itself goes in
// the sentence instead.
//
// The test is deliberately coarse, and coarse in the safe direction: a line that
// is not a comment, contains a quote, and contains one of the tokens. It will
// occasionally flag a line that is really a docstring, and that is fine: a
// docstring in a public repository is read by the same person.
const PRIVATE_DOC_TOKENS = [
  ['SPEC §', 'a section number of the private specification'],
  ['SPEC invariant', 'an invariant number from the private specification'],
  ['§', 'a section sign, which here always points at the private specification'],
  ['HANDOFF', 'the private handover note'],
];
const ROUND_TOKEN = /\bRM\d+/;
const QUOTED = /['"`]/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|#|<!--)/;

test('gate: no runtime string cites the private specification, a round or the handover note', () => {
  const files = filesUnder(RUNTIME_ROOTS);
  assert.ok(files.length > 10, `expected the gate to scan the runtime, got ${files.length} files`);
  const found = hits(files, (line) => {
    if (COMMENT_LINE.test(line)) return [];   // a comment is the developer's own note
    if (!QUOTED.test(line)) return [];        // no literal on this line
    const out = [];
    for (const [token, why] of PRIVATE_DOC_TOKENS) {
      if (line.includes(token)) out.push(`runtime string cites ${why}: "${token}"`);
    }
    const m = ROUND_TOKEN.exec(line);
    if (m) out.push(`runtime string cites a round number a reader cannot look up: "${m[0]}"`);
    return out;
  });
  assert.deepEqual(found, [], `a runtime string points at what a reader cannot open:\n${found.join('\n')}`);
});

test('gate: the private-document gate really would fire on a planted string', () => {
  // The same matcher, over a synthetic file, so the gate above is known to bite
  // rather than merely to pass. Each planted line is one shape the rule has to
  // catch; the last three are the shapes it must NOT catch.
  const matcher = (line) => {
    if (COMMENT_LINE.test(line)) return [];
    if (!QUOTED.test(line)) return [];
    const out = [];
    for (const [token] of PRIVATE_DOC_TOKENS) if (line.includes(token)) out.push(token);
    const m = ROUND_TOKEN.exec(line);
    if (m) out.push(m[0]);
    return out;
  };
  const planted = [
    `  die('the pack is stale (SPEC §11.2)');`,
    `  reason: 'refused by SPEC invariant I-1',`,
    `  note: 'see §14.4 for the expiry rule',`,
    `  throw new Error('read HANDOFF first');`,
    `  message: 'changed in RM29, so the shard layout moved',`,
  ];
  const clean = [
    `  // the pack is stale (SPEC §11.2) — a comment, and comments stay`,
    `  const cold = plan.reason;`,
    `  die('the pack is stale: rebuild it with cascade analyze');`,
  ];
  for (const line of planted) {
    assert.notDeepEqual(matcher(line), [], `the gate would have missed: ${line}`);
  }
  for (const line of clean) {
    assert.deepEqual(matcher(line), [], `the gate would have wrongly flagged: ${line}`);
  }
});

test('gate: the translation catalogues are the one excluded path — and the exclusion is load-bearing', () => {
  // Nothing under viewer/i18n reaches any gate...
  for (const roots of [SCAN_ROOTS, RUNTIME_ROOTS, [...SCAN_ROOTS, 'viewer']]) {
    const scanned = filesUnder(roots).map((f) => f.rel);
    assert.equal(scanned.some((r) => r.startsWith('viewer/i18n/')), false,
      'viewer/i18n must never be handed to a gate');
  }
  // ...and it really does hold non-English text, so the exclusion is a decision
  // about translations rather than a line nobody would have noticed.
  const ko = fs.readFileSync(path.join(ROOT, 'viewer', 'i18n', 'ko.json'), 'utf8');
  assert.match(ko, /[\uac00-\ud7a3]/, 'viewer/i18n/ko.json is meant to BE the Korean translation');
  // The page and the module it is served stay English, gate or no gate.
  const pageFiles = ['viewer/index.html', 'src/viewer/i18n.mjs',
    ...fs.readdirSync(path.join(ROOT, 'viewer', 'js')).sort().map((f) => `viewer/js/${f}`)];
  for (const rel of pageFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(new RegExp(CJK.source).test(text), false, `${rel} must carry no non-English text`);
  }
});

// ---------------------------------------------------------------------------
// Gate 2c — the web lane names no project and no wrapper from the corpus
// ---------------------------------------------------------------------------
//
// SPEC §3.4 / §6 / §18.2: the engine must not have been written against any one
// project. The web lane is where that is easiest to break, because a real
// frontend's HTTP wrapper has a NAME, and matching that name would make the
// lane work on one repository and silently fail on the next. So the rule is
// mechanical: the bridge, the worker, their declaration packs and the fixture
// they are tested on may not contain a project name or a wrapper name from the
// five frontends this round was measured against.
//
// The words are matched on WORD BOUNDARIES, because `mall` is inside `small`
// and a substring test would forbid ordinary English.
const CORPUS_WORDS = ['defHttp', 'VAxios', 'litemall', 'jeecg', 'ruoyi', 'mall'];

// A library's OWN published method name is not a wrapper name: `request` is
// part of axios's documented API, and a declaration pack that cannot say so
// cannot describe axios at all. It is allowed exactly there, and nowhere else.
const CORPUS_ALLOWED = [
  { file: 'adapters/web/packs/http-clients.json', word: 'request', why: 'axios publishes `request` as its own generic method; the pack is a declaration of that library, not a rule about a project' },
];

test('gate: no project name and no wrapper name from the corpus is in a rule, a default or a fixture', () => {
  // The web lane is the bridge, the modules it was split into (RM49), the worker
  // and the declaration packs. The DIRECTORIES are read rather than listed, so a
  // module added tomorrow is covered by this gate without anybody remembering.
  const files = [
    'src/adapters/web_bridge.mjs',
    'adapters/web/webfacts.mjs',
    ...fs.readdirSync(path.join(ROOT, 'src', 'adapters', 'web')).sort()
      .filter((f) => f.endsWith('.mjs')).map((f) => `src/adapters/web/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'adapters', 'web', 'lib')).sort()
      .filter((f) => f.endsWith('.mjs')).map((f) => `adapters/web/lib/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'adapters', 'web', 'packs')).sort()
      .map((f) => `adapters/web/packs/${f}`),
  ];
  const fixture = path.join(ROOT, 'test', 'fixtures', 'web-smoke');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) { walk(abs); continue; }
      files.push(path.relative(ROOT, abs).split(path.sep).join('/'));
    }
  };
  walk(fixture);
  assert.ok(files.length >= 20, `expected the lane and its fixture, found ${files.length} file(s)`);

  const hits = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const word of CORPUS_WORDS) {
      if (!new RegExp(`\\b${word}\\b`).test(text)) continue;
      hits.push(`${rel}: ${word}`);
    }
  }
  assert.deepEqual(hits, [], `a rule written against one project's spelling works on one project:\n${hits.join('\n')}`);

  // The one allowance is real, and it is still there: an allowlist nobody
  // prunes is how an exception becomes the rule.
  for (const a of CORPUS_ALLOWED) {
    const text = fs.readFileSync(path.join(ROOT, a.file), 'utf8');
    assert.match(text, new RegExp(`\\b${a.word}\\b`), `${a.file} no longer contains ${a.word} (${a.why}); drop the entry`);
  }
});

// ---------------------------------------------------------------------------
// Gate 2b — no NUL bytes in a source file
// ---------------------------------------------------------------------------

// A literal 0x00 in a text file is never intentional here: it survives an editor
// round-trip invisibly, it makes `grep` treat the whole file as binary (so every
// other gate above silently stops finding anything in it), and git will diff it
// as binary. Control characters that a program genuinely needs — the NUL git
// uses to delimit `--format` fields, for instance — are written as ESCAPES.
test('gate: no source file carries a literal NUL byte', () => {
  const found = [];
  for (const r of SCAN_ROOTS) {
    const abs = path.join(ROOT, r);
    if (!fs.existsSync(abs)) continue;
    const visit = (p) => {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(p).sort()) {
          if (SKIP_DIRS.has(name)) continue;
          visit(path.join(p, name));
        }
        return;
      }
      if (!st.isFile()) return;
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      if (isExcluded(rel) || isBinaryAsset(rel)) return;
      const buf = fs.readFileSync(p);
      const at = buf.indexOf(0);
      if (at >= 0) found.push(`${rel}: NUL byte at offset ${at}`);
    };
    visit(abs);
  }
  assert.deepEqual(found, [], `literal NUL bytes found (write them as escapes instead):\n${found.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Gate 2c — the layering direction (SPEC §4, invariant I-3)
// ---------------------------------------------------------------------------

// A lane is a PLUG-IN and `src/core/` is the thing it plugs into, so the
// dependency may only ever run adapters → core. `src/core/overlay.mjs` imported
// `../adapters/sql_bridge.mjs` and `../adapters/java_bridge.mjs` for three
// milestones: the core could not be reasoned about, or reused, without the two
// lanes it was supposed to be independent of, and the M11 documents had to
// admit the violation in writing rather than fix it. Nothing caught it, because
// nothing looked — this is the gate that looks.
//
// The fix is injection: the bridges arrive as functions (src/core/assemble.mjs)
// and src/cli/ — the layer allowed to know both sides — wires them.
//
// It matches IMPORTS ONLY (`import … from`, `export … from`, `import(...)`), so
// a comment or a doc string may still NAME an adapter file; several deliberately
// do, to say which lane consumes a profile key.
const IMPORT_FROM = /(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module specifier a JavaScript source imports. */
function importSpecifiers(text) {
  const out = [];
  for (const re of [IMPORT_FROM, BARE_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
  }
  return out;
}

test('gate: nothing under src/core/ imports from adapters — the core is what a lane plugs INTO (I-3)', () => {
  const files = filesUnder(['src/core']).filter((f) => f.rel.endsWith('.mjs'));
  assert.ok(files.length > 20, `expected the gate to scan the core, got ${files.length} files`);
  const found = [];
  for (const f of files) {
    for (const spec of importSpecifiers(f.text)) {
      // Both spellings of the same thing: a relative hop out of core into the
      // adapters directory, and a package-absolute one.
      const norm = spec.replace(/\\/g, '/');
      const resolved = norm.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), norm))
        : norm;
      if (/(^|\/)adapters\//.test(resolved)) {
        found.push(`${f.rel}: imports ${spec}`);
      }
    }
  }
  assert.deepEqual(found, [], 'src/core must not depend on src/adapters (SPEC §4, I-3): the direction is adapters -> core. '
    + 'A lane the core needs is INJECTED — see src/core/assemble.mjs and the LANE_BRIDGES object in src/cli/lanes_run.mjs:\n'
    + found.join('\n'));
});

test('gate: the layering gate really would fail on a planted import', () => {
  // The gate above passes today. That is only evidence if the same check FAILS
  // on the import it exists to forbid — including the spellings that are not a
  // plain top-of-file `import x from '../adapters/y.mjs'`.
  const planted = [
    "import { addJavaFacts } from '../adapters/java_bridge.mjs';",
    "export { buildGraphFromSql } from '../adapters/sql_bridge.mjs';",
    "const m = await import('../adapters/jpa_bridge.mjs');",
    "import 'src/adapters/java_bridge.mjs';",
  ];
  for (const line of planted) {
    const specs = importSpecifiers(`// src/core/example.mjs\n${line}\n`);
    assert.equal(specs.length, 1, `no specifier found in: ${line}`);
    const resolved = specs[0].startsWith('.')
      ? path.posix.normalize(path.posix.join('src/core', specs[0]))
      : specs[0];
    assert.match(resolved, /(^|\/)adapters\//, `the gate would MISS: ${line}`);
  }
  // …and it does not fire on a comment that merely names an adapter file, which
  // several core modules do on purpose (profile.mjs names the consuming lane).
  assert.deepEqual(importSpecifiers("// see src/adapters/java_bridge.mjs for the rule\n"), []);
  assert.deepEqual(importSpecifiers("const where = 'src/adapters/jpa_bridge.mjs';\n"), []);
});

// ---------------------------------------------------------------------------
// Gate 3 — licence
// ---------------------------------------------------------------------------

test('gate: LICENSE is Apache-2.0 and package.json agrees, with no runtime dependencies', () => {
  const licence = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(licence, /Apache License/);
  assert.match(licence, /Version 2\.0/);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal('dependencies' in pkg, false, 'the engine is dependency-free by design (SPEC §4)');
});

/**
 * Every `vendor` directory in the tree, wherever it sits. The gate below reads
 * this rather than a hard-coded `viewer/vendor`, because the day a second lane
 * vendors something is exactly the day nobody remembers to widen the gate.
 * @param {string[]} roots  directories to search under
 * @returns {string[]} repo-relative directory paths, sorted
 */
function vendorDirs(roots) {
  const out = [];
  const visit = (abs) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(abs, e.name);
      if (e.name === 'vendor') { out.push(path.relative(ROOT, full).split(path.sep).join('/')); continue; }
      visit(full);
    }
  };
  for (const r of roots) visit(path.join(ROOT, r));
  return out.sort();
}

/** Every `.js`/`.cjs` bundle inside a vendor directory, repo-relative. */
function vendoredBundles(dirRel) {
  const abs = path.join(ROOT, dirRel);
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith('.js') || f.endsWith('.cjs'))
    .sort()
    .map((f) => `${dirRel}/${f}`);
}

test('gate: every vendored bundle, in EVERY vendor directory, is credited in NOTICE', () => {
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  const dirs = vendorDirs(['viewer', 'adapters']);
  // Both lanes that vendor something must be seen, or the gate is checking one
  // directory and calling it "every".
  assert.ok(dirs.includes('viewer/vendor'), `expected viewer/vendor among ${dirs.join(', ')}`);
  assert.ok(dirs.includes('adapters/web/vendor'), `expected adapters/web/vendor among ${dirs.join(', ')}`);

  const missing = [];
  let checked = 0;
  for (const dir of dirs) {
    for (const rel of vendoredBundles(dir)) {
      checked += 1;
      // The FULL relative path, not the bare file name: a NOTICE that credits
      // `index.js` credits nothing in particular.
      if (!notice.includes(rel)) missing.push(rel);
    }
  }
  assert.ok(checked >= 3, `expected the vendored bundles to be checked, got ${checked}`);
  assert.deepEqual(missing, [], `these vendored bundles are not named in NOTICE:\n${missing.join('\n')}`);
});

// The sha256 of the vendored parser, from the row of its own README that names
// it. Two things have to agree: the bytes on disk and the number the
// documentation publishes. Either one moving alone is the failure.
const PARSER_REL = 'adapters/web/vendor/babel-parser.cjs';

/** The 64-hex digest the README records on the row naming `babel-parser.cjs`. */
function documentedParserSha() {
  const readme = fs.readFileSync(path.join(ROOT, 'adapters', 'web', 'vendor', 'README.md'), 'utf8');
  const row = readme.split('\n').find((l) => l.includes('babel-parser.cjs') && /\b[0-9a-f]{64}\b/.test(l));
  assert.ok(row, 'adapters/web/vendor/README.md has no row naming babel-parser.cjs with a sha256');
  return /\b([0-9a-f]{64})\b/.exec(row)[1];
}

test('gate: the vendored parser is the exact bytes its README publishes', () => {
  const abs = path.join(ROOT, PARSER_REL);
  assert.ok(fs.existsSync(abs), `${PARSER_REL} is missing; the web lane cannot parse anything without it`);
  const actual = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  assert.equal(actual, documentedParserSha(),
    `${PARSER_REL} does not hash to the sha256 in adapters/web/vendor/README.md. `
    + 'The parser is pinned on purpose: every fact shard folds the worker version into its key, and two '
    + 'generations of a parser must not be able to share one key. Re-copy the tarball, or update the README '
    + 'and bump VERSION in adapters/web/webfacts.mjs together');
});

test('gate: the two vendor gates really would fail on a planted change', () => {
  // A gate that has never been seen to fail is a comment. Both are exercised
  // here against a synthetic vendor tree and a synthetic README row.
  const notice = 'we credit viewer/vendor/force-graph.min.js and nothing else\n';
  const planted = ['viewer/vendor/force-graph.min.js', 'adapters/web/vendor/babel-parser.cjs'];
  const missed = planted.filter((rel) => !notice.includes(rel));
  assert.deepEqual(missed, ['adapters/web/vendor/babel-parser.cjs'],
    'the NOTICE gate must report a bundle the NOTICE does not name');

  // ...and the hash gate: the same file, one byte different, must not pass.
  const abs = path.join(ROOT, PARSER_REL);
  const real = fs.readFileSync(abs);
  const tampered = Buffer.concat([real, Buffer.from('\n')]);
  const tamperedHash = createHash('sha256').update(tampered).digest('hex');
  assert.notEqual(tamperedHash, documentedParserSha(),
    'appending one byte to the vendored parser must change the digest the gate compares');
});
