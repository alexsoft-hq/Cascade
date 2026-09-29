import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, interpolate, richText, VIEWER_STRINGS } from '../src/viewer/i18n.mjs';
import { TRUST_LEVELS } from '../src/core/trust.mjs';
import { handleViewerLib } from '../src/mcp/http.mjs';
import { limitTitleKeys, limitTopic, LIMIT_TOPICS, LIMIT_AXIS_KEYS } from '../src/viewer/limit_titles.mjs';
import { axisLimits, AXES, AXIS_STATUS } from '../src/core/lanes.mjs';

// The viewer's i18n shell (SPEC §17.11, §15 M9). What is under test here is the
// SHELL, not the translation: that English is the default and the fallback,
// that a missing key is visible rather than swallowed, that the Korean
// catalogue covers exactly the English key set, and that the page is served
// this very module rather than a copy of it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KO = JSON.parse(fs.readFileSync(path.join(ROOT, 'viewer', 'i18n', 'ko.json'), 'utf8'));
const HTML = fs.readFileSync(path.join(ROOT, 'viewer', 'index.html'), 'utf8');
// THE PAGE, as text: its markup AND the scripts it loads. Which key the page
// asks for used to be a question about one file; since the page's code moved
// into viewer/js/*.js it is a question about all of them, and a scan that read
// only the HTML would say every key was dead.
const JS_DIR = path.join(ROOT, 'viewer', 'js');
// The SVG pictures of an answer (src/viewer/chain_svg.mjs, the whole chain, and
// src/viewer/summary_card.mjs, the card) write the page's own words too, from the
// same catalogue, so they are read as part of the page; and so does
// src/viewer/limit_titles.mjs, which names the key a limit's title comes from.
const PAGE = [HTML, ...fs.readdirSync(JS_DIR).sort()
  .map((f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8')),
...['chain_svg.mjs', 'summary_card.mjs', 'limit_titles.mjs'].map((f) => fs.readFileSync(path.join(ROOT, 'src', 'viewer', f), 'utf8'))].join('\n');
const CATALOG = { en: VIEWER_STRINGS.en, ko: KO };

/**
 * Does the page ask for this key? Three ways it can: as a quoted literal in the
 * code (`t('tab.flow')`, or a table of key names the code reads through), as a
 * `data-t…` attribute in the markup, or as a `data-t-fold` pair, which names one
 * key for the line that stands on the page and one for the paragraph under the
 * fold.
 *
 * This asks per KEY rather than scanning the page for every quoted string,
 * because an apostrophe in a comment ("one node's neighborhood") pairs with the
 * next quote and hides every literal after it.
 */
const FOLD_KEYS = new Set([...PAGE.matchAll(/data-t-fold="([^"]+)"/g)]
  .flatMap((m) => [`${m[1]}.lead`, `${m[1]}.more`]));
const ATTR_KEYS = new Set([...PAGE.matchAll(/data-t(?:-rich|-title|-ph)?="([^"]+)"/g)].map((m) => m[1]));
// ...and a fourth way: the page BUILDS the key, from a prefix and a value the
// engine gave it (`'mast.trust.'+level`, `'ov.gap.'+kind+'.label'`). A literal
// that ends in a dot is such a prefix, and every key under it is asked for.
const KEY_PREFIXES = [...new Set([...PAGE.matchAll(/'([a-z][\w-]*(?:\.[\w-]+)*\.)'/g)].map((m) => m[1]))];
const usedByPage = (k) => PAGE.includes(`'${k}'`) || ATTR_KEYS.has(k) || FOLD_KEYS.has(k)
  || KEY_PREFIXES.some((p) => k.startsWith(p));

// ---------------------------------------------------------------------------
// interpolate
// ---------------------------------------------------------------------------

test('interpolate: {name} is replaced by the parameter of that name', () => {
  assert.equal(interpolate('lanes: {lanes}', { lanes: 'sql + java' }), 'lanes: sql + java');
});

test('interpolate: several placeholders, and the same one twice', () => {
  assert.equal(interpolate('{a} then {b} then {a}', { a: '1', b: '2' }), '1 then 2 then 1');
});

test('interpolate: a placeholder with NO parameter is left standing, not blanked', () => {
  // A visible `{id}` says a caller forgot an argument; an empty gap reads as a
  // sentence that was always meant to have a hole in it.
  assert.equal(interpolate('an endpoint (GET /p/{id})'), 'an endpoint (GET /p/{id})');
  assert.equal(interpolate('{a}/{b}', { a: 'x' }), 'x/{b}');
  assert.equal(interpolate('{a}', { a: null }), '{a}');
});

test('interpolate: a number, a zero and a false are all rendered', () => {
  assert.equal(interpolate('{n} of {m}, {f}', { n: 0, m: 12, f: false }), '0 of 12, false');
});

// ---------------------------------------------------------------------------
// richText — `code` and **bold** runs, as data the page turns into elements
// ---------------------------------------------------------------------------

test('richText: plain text is one run', () => {
  assert.deepEqual(richText('just words'), [{ tag: null, text: 'just words' }]);
});

test('richText: backticks become a code run, asterisks a bold run', () => {
  assert.deepEqual(richText('one `overview` call and **Around <node>** too'), [
    { tag: null, text: 'one ' },
    { tag: 'code', text: 'overview' },
    { tag: null, text: ' call and ' },
    { tag: 'b', text: 'Around <node>' },
    { tag: null, text: ' too' },
  ]);
});

test('richText: an empty string is still one (empty) run, so replaceChildren has something to take', () => {
  assert.deepEqual(richText(''), [{ tag: null, text: '' }]);
});

// ---------------------------------------------------------------------------
// makeT — the lookup, the fallback and the missing-key ledger
// ---------------------------------------------------------------------------

test('makeT: the wanted language wins', () => {
  const t = makeT({ en: { a: 'A' }, ko: { a: 'K' } }, 'ko');
  assert.equal(t('a'), 'K');
  assert.equal(t.lang, 'ko');
});

test('makeT: a key the language lacks falls back to English, and says it did', () => {
  const t = makeT({ en: { a: 'A', b: 'B' }, ko: { a: 'K' } }, 'ko');
  assert.equal(t('b'), 'B');
  assert.deepEqual([...t.fellBack], ['b']);
  assert.deepEqual([...t.missing], []);
});

test('makeT: a key NO catalogue has returns the key, records it, and never throws', () => {
  const t = makeT({ en: { a: 'A' } }, 'en');
  assert.equal(t('nope.at.all'), 'nope.at.all');
  assert.deepEqual([...t.missing], ['nope.at.all']);
  // Recorded once, however often it is asked for.
  t('nope.at.all');
  assert.equal(t.missing.size, 1);
});

test('makeT: an unknown language is English, not an empty page', () => {
  const t = makeT({ en: { a: 'A' } }, 'xx');
  assert.equal(t.lang, 'en');
  assert.equal(t('a'), 'A');
});

test('makeT: a catalogue that is missing, null or the wrong shape still answers', () => {
  for (const bad of [undefined, null, 42, 'text', []]) {
    const t = makeT(bad, 'ko');
    assert.equal(t('anything'), 'anything');
    assert.deepEqual([...t.missing], ['anything']);
  }
});

test('makeT: a non-string entry (a number, an object) counts as MISSING, not as a value', () => {
  const t = makeT({ en: { a: 7, b: { x: 1 } } }, 'en');
  assert.equal(t('a'), 'a');
  assert.equal(t('b'), 'b');
});

test('makeT: interpolation runs on the translated string', () => {
  const t = makeT({ en: { m: 'error: {message}' }, ko: { m: '[{message}]' } }, 'ko');
  assert.equal(t('m', { message: 'unknown-column: price' }), '[unknown-column: price]');
});

test('makeT: a parameter value carrying braces is substituted once, never re-scanned', () => {
  const t = makeT({ en: { m: 'error: {message}' } }, 'en');
  assert.equal(t('m', { message: 'bad {other}' }), 'error: bad {other}');
});

// ---------------------------------------------------------------------------
// The catalogues themselves
// ---------------------------------------------------------------------------

test('ko carries EXACTLY the en key set — no missing key, no stale one', () => {
  const en = Object.keys(VIEWER_STRINGS.en).sort();
  const ko = Object.keys(KO).sort();
  assert.deepEqual(ko.filter((k) => !en.includes(k)), [], 'ko has keys en does not');
  assert.deepEqual(en.filter((k) => !ko.includes(k)), [], 'ko is missing keys en has');
  assert.deepEqual(ko, en);
  assert.ok(en.length > 60, `expected the chrome catalogue to be substantial, got ${en.length} keys`);
});

test('every ko string is a non-empty string', () => {
  for (const [k, v] of Object.entries(KO)) {
    assert.equal(typeof v, 'string', `${k} is not a string`);
    assert.ok(v.trim().length > 0, `${k} is empty`);
  }
});

test('a translation keeps the placeholders of the string it translates', () => {
  // A dropped `{message}` would quietly swallow the engine's own words.
  const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [k, en] of Object.entries(VIEWER_STRINGS.en)) {
    assert.deepEqual(names(KO[k]), names(en), `${k}: the translation changed the placeholders`);
  }
});

test('en itself carries no Hangul, and ko is really a translation', () => {
  const hangul = /[가-힣]/;
  assert.equal(hangul.test(JSON.stringify(VIEWER_STRINGS.en)), false);
  const translated = Object.entries(KO).filter(([, v]) => hangul.test(v));
  assert.ok(translated.length > Object.keys(KO).length * 0.8,
    `only ${translated.length}/${Object.keys(KO).length} ko strings carry Hangul`);
});

test('the real catalogues, end to end: Korean answers, English is the floor', () => {
  const t = makeT(CATALOG, 'ko');
  assert.notEqual(t('tab.start'), VIEWER_STRINGS.en['tab.start'], 'ko must actually translate a tab name');
  assert.equal(t('err.generic', { message: 'unknown-key: no such column' }).includes('unknown-key: no such column'), true,
    "the engine's own sentence is relayed inside the translated frame");
  assert.deepEqual([...t.missing], [], 'no key of the real catalogue is missing');
  assert.deepEqual([...t.fellBack], [], 'nothing the page asked for fell back to English');
  const en = makeT(CATALOG, 'en');
  assert.equal(en('tab.start'), 'Start');
});

test('the round\'s new chrome is keyed and translated: the theme toggle, the chips, the dials', () => {
  // Every key RM21 added. They are the page's OWN words — a theme name, a card
  // label, the remainder a share leaves out — so each one must exist in both
  // catalogues and actually be translated in ko.
  const added = [
    'theme.title', 'theme.dark', 'theme.light',
    'mast.trust', 'mast.limits',
    'kpi.endpoints', 'kpi.statements', 'kpi.tables', 'kpi.columns',
    'kpi.rest.endpoints', 'kpi.rest.statements', 'kpi.rest.tables', 'kpi.rest.columns',
    'ov.grades.title', 'ov.grades.note',
    'ov.hubtables.by',
  ];
  for (const k of added) {
    assert.equal(typeof VIEWER_STRINGS.en[k], 'string', `${k} is missing from en`);
    assert.equal(typeof KO[k], 'string', `${k} is missing from ko`);
    assert.match(KO[k], /[가-힣]/, `${k} is not translated`);
    assert.ok(usedByPage(k), `${k} is in the catalogue but nothing in the page asks for it`);
  }
  // The four remainders each keep their {n}: a share is only honest beside the
  // number it leaves out.
  for (const k of added.filter((x) => x.startsWith('kpi.rest.'))) {
    assert.match(VIEWER_STRINGS.en[k], /\{n\}/, `${k} (en) lost its count`);
    assert.match(KO[k], /\{n\}/, `${k} (ko) lost its count`);
  }
  // The theme names are what the segment prints, so they stay short.
  for (const k of ['theme.dark', 'theme.light']) {
    assert.ok(VIEWER_STRINGS.en[k].length <= 12, `${k} (en) is too long for a segment`);
    assert.ok(KO[k].length <= 12, `${k} (ko) is too long for a segment`);
  }
});

// EVERY blind spot the engine can disclose, read out of the file that emits
// them (RM36). The list is not typed here on purpose: a gap kind added to
// src/core/overview.mjs with no label would otherwise reach the panel as a raw
// slug and nobody would find out until a reader saw it. The page still falls
// back to the slug rather than throwing (test/viewer_page.test.mjs holds that),
// so a missing label is a wording defect and not a broken screen.
const OVERVIEW_SRC = fs.readFileSync(path.join(ROOT, 'src/core/overview.mjs'), 'utf8');
const GAP_LABEL_KINDS = [...new Set(
  [...OVERVIEW_SRC.matchAll(/\bkind: '([a-z0-9-]+)'/g)].map((m) => m[1]),
)].sort();

test('every blind spot the overview can emit has a plain label in both catalogues', () => {
  assert.ok(GAP_LABEL_KINDS.length >= 20,
    `expected the overview to disclose many kinds, found ${GAP_LABEL_KINDS.length}`);
  for (const kind of GAP_LABEL_KINDS) {
    const k = `ov.gap.${kind}.label`;
    assert.equal(typeof VIEWER_STRINGS.en[k], 'string', `${k} is missing from en`);
    assert.equal(typeof KO[k], 'string', `${k} is missing from ko`);
    assert.match(KO[k], /[가-힣]/, `${k} is not translated`);
    // A label is a chip head, so it stays short, and it is the reader's words:
    // a label that is still the slug would be this round doing nothing.
    assert.ok(VIEWER_STRINGS.en[k].length <= 40, `${k} (en) is too long for a chip: ${VIEWER_STRINGS.en[k]}`);
    assert.notEqual(VIEWER_STRINGS.en[k], kind.replace(/-/g, ' '), `${k} (en) is still the engine's slug`);
    // A label is a phrase on a chip, not a sentence: no full stop, and it never
    // carries the hyphenated slug it replaces.
    assert.equal(/[.]$/.test(VIEWER_STRINGS.en[k]), false, `${k} (en) is a sentence, not a label`);
    assert.equal(VIEWER_STRINGS.en[k].includes(kind), false, `${k} (en) still carries the raw kind`);
  }
});

// EVERY DIAGNOSTIC KIND THE ENGINE CAN EMIT (RM67-C5), read out of the engine's
// source, the way the gap kinds above are: every diagnostic is built as an
// object literal with `kind: 'SOME_KIND'`, or through the profile validator's
// `add('SOME_KIND', '<severity>', ...)`, and nothing else in the engine spells a
// kind that way. A list typed here would go stale the day a lane adds one.
function engineSources(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) engineSources(p, acc);
    else if (e.name.endsWith('.mjs')) acc.push(fs.readFileSync(p, 'utf8'));
  }
  return acc;
}
const ENGINE_SRC = engineSources(path.join(ROOT, 'src')).join('\n');
const DIAGNOSTIC_KINDS = [...new Set([
  ...[...ENGINE_SRC.matchAll(/\bkind: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]),
  ...[...ENGINE_SRC.matchAll(/\badd\('([A-Z][A-Z0-9_]+)', '(?:info|warn|error)'/g)].map((m) => m[1]),
])].sort();

test('every diagnostic and every gap the engine can emit has a title, and every gap its cause, in both catalogues', () => {
  // The scan must see the whole engine, or it holds nothing: the kinds of every
  // lane, the profile validator's, and the schema reader's.
  assert.ok(DIAGNOSTIC_KINDS.length >= 80, `expected every lane's diagnostics, found ${DIAGNOSTIC_KINDS.length}`);
  for (const k of ['SHARD_UNUSABLE', 'TS_PREFIX_UNREAD', 'PROFILE_DEFAULT_ASSUMED', 'CATALOG_CREATE_TABLE_UNREAD', 'CATALOG_RULE_ASSUMED']) {
    assert.ok(DIAGNOSTIC_KINDS.includes(k), `${k} was not found by the scan`);
  }
  const missing = [];
  const hangul = /[가-힣]/;
  for (const kind of DIAGNOSTIC_KINDS) {
    const k = `diag.title.${kind}`;
    if (typeof VIEWER_STRINGS.en[k] !== 'string') missing.push(`${k} (en)`);
    if (typeof KO[k] !== 'string' || !hangul.test(KO[k])) missing.push(`${k} (ko)`);
  }
  for (const kind of GAP_LABEL_KINDS) {
    for (const k of [`ov.gap.${kind}.label`, `gap.cause.${kind}`]) {
      if (typeof VIEWER_STRINGS.en[k] !== 'string') missing.push(`${k} (en)`);
      if (typeof KO[k] !== 'string' || !hangul.test(KO[k])) missing.push(`${k} (ko)`);
    }
  }
  assert.deepEqual(missing, [], 'a kind the page has no words for is shown as "analyzer warning: CODE"; give it a title in both languages');
  // A title is a phrase a reader scans, not the code said again.
  for (const kind of DIAGNOSTIC_KINDS) {
    const en = VIEWER_STRINGS.en[`diag.title.${kind}`];
    assert.ok(en.length <= 60, `diag.title.${kind} (en) is too long for a title: ${en}`);
    assert.equal(en.includes(kind), false, `diag.title.${kind} (en) still carries the code`);
    assert.equal(/[.]$/.test(en), false, `diag.title.${kind} (en) is a sentence, not a title`);
  }
});

// EVERY LIMIT SCOPE THE ENGINE CAN EMIT (RM67-U2f), read out of the engine's
// source the way the diagnostic kinds are. A limit is built as an object literal
// `{ scope: '<scope>', reason: ... }`, or by a helper whose first parameter is
// the scope and which is called with a literal (`groupingLimit('map', ctx)`), or
// with a name after a colon (`scope: \`axis:${axis}\``), which makes a family.
// `basis.scope: 'server'` carries no reason and is not a limit.
const LIMIT_HELPERS = [...ENGINE_SRC.matchAll(/\bfunction (\w+)\(scope\b/g)].map((m) => m[1]);
const LIMIT_SCOPES = [...new Set([
  ...[...ENGINE_SRC.matchAll(/\bscope: '([^']+)',\s*reason\b/g)].map((m) => m[1]),
  ...LIMIT_HELPERS.flatMap((h) => [...ENGINE_SRC.matchAll(new RegExp(`\\b${h}\\('([^']+)'`, 'g'))].map((m) => m[1])),
])].sort();
const LIMIT_FAMILIES = [...new Set([...ENGINE_SRC.matchAll(/\bscope: `([a-z-]+):\$\{/g)].map((m) => m[1]))].sort();
/** The title the page shows over a limit: the first key its catalogue has. */
const limitTitleOf = (limit) => limitTitleKeys(limit).find((c) => Object.hasOwn(VIEWER_STRINGS.en, c.key)) ?? null;
/** A sentence no topic starts with, so a scope's own title is what answers. */
const PLAIN = 'a sentence no topic starts with';

test('every limit scope the engine can emit has a title, in both catalogues', () => {
  // The scan must see every tool, the overlay and the summary, or it holds nothing.
  for (const s of ['map', 'flow', 'coupling', 'overlay', 'summary:groups', 'summary:walk', 'pack-diff:repository', 'endpoint_impact', 'browse', 'identifier-case']) {
    assert.ok(LIMIT_SCOPES.includes(s), `${s} was not found by the scan: ${LIMIT_SCOPES.join(', ')}`);
  }
  assert.equal(LIMIT_SCOPES.includes('server'), false, 'basis.scope is not a limit');
  assert.deepEqual(LIMIT_FAMILIES, ['axis', 'diagnostic', 'runtime-only-columns']);
  const hangul = /[가-힣]/;
  const missing = [];
  // An axis name may stay a Latin word in Korean ("SQL"); a title is a phrase, and is translated.
  const need = (key, what, phrase = true) => {
    if (typeof VIEWER_STRINGS.en[key] !== 'string') missing.push(`${key} (en) for ${what}`);
    if (typeof KO[key] !== 'string' || (phrase && !hangul.test(KO[key]))) missing.push(`${key} (ko) for ${what}`);
  };
  for (const scope of LIMIT_SCOPES) need(`limit.scope.${scope}`, scope);
  // A family other than axis and diagnostic is titled by what comes before its colon.
  for (const f of LIMIT_FAMILIES.filter((x) => x !== 'axis' && x !== 'diagnostic')) need(`limit.scope.${f}`, `${f}:<name>`);
  for (const topic of Object.keys(LIMIT_TOPICS)) need(`limit.topic.${topic}`, `the topic ${topic}`);
  need(LIMIT_AXIS_KEYS.note, 'an axis note');
  for (const axis of AXES) need(`ov.axis.name.${axis}`, `axis:${axis}`, false);
  assert.deepEqual(missing, [], 'a limit the page has no words for is shown as its scope and the engine\'s English; give it a title in both languages');
  // What the page shows: every scope answers with its own title.
  for (const scope of LIMIT_SCOPES) {
    assert.equal(limitTitleOf({ scope, reason: PLAIN }).key, `limit.scope.${scope}`, scope);
  }
  assert.equal(limitTitleOf({ scope: 'runtime-only-columns:pms_product', reason: PLAIN }).key, 'limit.scope.runtime-only-columns');
  // A title is a phrase a reader scans: short, no full stop, not the scope said again.
  const titles = [...LIMIT_SCOPES.map((s) => `limit.scope.${s}`), ...Object.keys(LIMIT_TOPICS).map((x) => `limit.topic.${x}`), LIMIT_AXIS_KEYS.note];
  for (const k of titles) {
    for (const [lang, cat] of [['en', VIEWER_STRINGS.en], ['ko', KO]]) {
      assert.ok(cat[k].length <= 60, `${lang}/${k} is too long for a title: ${cat[k]}`);
      assert.equal(/[.]$/.test(cat[k]), false, `${lang}/${k} is a sentence, not a title`);
    }
    assert.notEqual(VIEWER_STRINGS.en[k], k.replace(/^limit\.(?:scope|topic)\./, ''), `${k} (en) is the scope said again`);
  }
});

test('an axis limit is titled by what the axis says of itself, a diagnostic and a gap by their own titles', () => {
  // The real emitter, every axis and every status it can report, with a note on each.
  for (const axis of AXES) {
    for (const status of AXIS_STATUS) {
      const lim = axisLimits({ [axis]: { status, reason: 'why', notes: ['a note'] } });
      const want = status === 'shipped' ? ['note'] : [status, 'note'];
      assert.deepEqual(lim.map((l) => limitTitleOf(l)), want.map((w) => ({ key: LIMIT_AXIS_KEYS[w], axis })), `${axis} ${status}`);
    }
  }
  // An axis note that opens like a topic takes the topic's words (the web lane's calls with no client).
  assert.equal(limitTitleOf({ scope: 'axis:web', reason: '3 of 151 frontend call site(s) were traced to no client, so each' }).key, 'limit.topic.web-no-client');
  assert.equal(limitTitleOf({ scope: 'diagnostic:SHARD_UNUSABLE', reason: PLAIN }).key, 'diag.title.SHARD_UNUSABLE');
  for (const kind of GAP_LABEL_KINDS) {
    assert.equal(limitTitleOf({ scope: 'overview', reason: `${kind} (12): what it means` }).key, `ov.gap.${kind}.label`, kind);
  }
  assert.equal(limitTitleOf({ scope: 'overview', reason: `unresolved-calls (unknown): x` }).key, 'ov.gap.unresolved-calls.label');
});

test('every topic opens a sentence the engine really writes', () => {
  // Held against the source, placeholders and all: `depth cap ${depth} reached`
  // is what /^depth cap \d+ reached/ has to find. A sentence the engine rewords
  // would otherwise lose its title with nobody told.
  const src = ENGINE_SRC.replace(/\\`/g, '`');
  const dead = [];
  for (const [topic, openings] of Object.entries(LIMIT_TOPICS)) {
    for (const re of openings) {
      const body = re.source.replace(/^\^/, '').replace(/\\d\+/g, () => '(?:\\d+|\\$\\{[^}]+\\})');
      if (!new RegExp(`[\`']${body}`).test(src)) dead.push(`${topic}: ${re}`);
    }
  }
  assert.deepEqual(dead, [], 'these openings start no sentence in src/: the engine reworded one, so say its new opening here');
  assert.equal(limitTopic('depth cap 8 reached at 3 call(s), so deeper calls'), 'depth-cap');
  assert.equal(limitTopic('node cap reached. The chain from here is bigger'), 'walk-cap');
  assert.equal(limitTopic('node cap 400 reached, so 3 tables not drawn'), 'draw-cap');
  assert.equal(limitTopic(PLAIN), null);
});

// The masthead's quiet layer (RM36). The verdict words themselves are the
// engine's and are never keyed; these are the sentences that say what they mean.
test('the masthead\'s plain-language layer is keyed and translated, in both languages', () => {
  const added = [
    'mast.build', 'mast.build.title',
    'mast.fresh.behind', 'mast.fresh.behind.title',
    'mast.fresh.overlay', 'mast.fresh.overlay.title',
    'mast.fresh.current', 'mast.fresh.current.title',
    'mast.fresh.unknown.title',
    'mast.trust.uncertified', 'mast.trust.uncertified.title',
    'mast.trust.golden_pass', 'mast.trust.golden_pass.title',
    'mast.trust.golden_fail', 'mast.trust.golden_fail.title',
    'mast.trust.none.title',
    // RM53: the level for a corpus a RUN labelled, and the way out of the one
    // almost every project is in.
    'mast.trust.runtime_pass', 'mast.trust.runtime_pass.title', 'mast.trust.how',
  ];
  for (const k of added) {
    assert.equal(typeof VIEWER_STRINGS.en[k], 'string', `${k} is missing from en`);
    assert.equal(typeof KO[k], 'string', `${k} is missing from ko`);
    assert.match(KO[k], /[가-힣]/, `${k} is not translated`);
    assert.ok(usedByPage(k), `${k} is in the catalogue but nothing in the page asks for it`);
  }
  // The four chip labels are what a masthead pill prints, so they stay short.
  for (const k of ['mast.build', 'mast.fresh.behind', 'mast.fresh.overlay', 'mast.fresh.current',
    'mast.trust.uncertified', 'mast.trust.golden_pass', 'mast.trust.golden_fail', 'mast.trust.runtime_pass']) {
    assert.ok(VIEWER_STRINGS.en[k].length <= 40, `${k} (en) is too long for a chip: ${VIEWER_STRINGS.en[k]}`);
  }
  // The gloss key is DERIVED from the engine's value at run time, so the three
  // it can derive today really are the three the engine can emit. If that enum
  // grows, this is where it is noticed: an unglossed level still renders, as
  // itself, but nobody meant it to stay that way.
  for (const lvl of TRUST_LEVELS) {
    const k = `mast.trust.${lvl.toLowerCase()}`;
    assert.equal(typeof VIEWER_STRINGS.en[k], 'string', `${lvl} has no plain wording (${k})`);
    assert.equal(typeof VIEWER_STRINGS.en[`${k}.title`], 'string', `${lvl} has no explanation (${k}.title)`);
  }
  // And none of them says the verdict word it stands beside: a chip that reads
  // `behind` or `UNCERTIFIED` is the shouting this round took out.
  for (const [lang, cat] of [['en', VIEWER_STRINGS.en], ['ko', KO]]) {
    for (const k of ['mast.fresh.behind', 'mast.fresh.current', 'mast.trust.uncertified']) {
      for (const word of ['behind', 'unknown', 'UNCERTIFIED']) {
        assert.equal(cat[k].includes(word), false, `${lang}/${k} prints the verdict word ${word}`);
      }
    }
  }
});

test('the catalogue is chrome only: no engine vocabulary is translated', () => {
  // The honesty contract (SPEC §17.11 + §13): a grade, a trust level and an
  // `empty` reason are the ENGINE's words. If one ever became a catalogue key,
  // the page would be inventing evidence.
  const forbidden = ['EXACT', 'SOUND_SET', 'HEURISTIC', 'RUNTIME_ONLY', 'UNRESOLVED',
    'CERTIFIED', 'UNCERTIFIED', 'not-shipped', 'not-in-this-axis'];
  for (const [k, v] of Object.entries(VIEWER_STRINGS.en)) {
    for (const word of forbidden) {
      if (k === 'hint.graph.map.more' && word === 'SOUND_SET') continue; // named in prose, not translated as a value
      assert.equal(v.includes(word), false, `${k} carries the engine's own token ${word}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The page and the module
// ---------------------------------------------------------------------------

test("every key the page asks for with t('…') exists in en", () => {
  const asked = [...PAGE.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(asked.length > 20, `expected the page to use the catalogue, found ${asked.length} calls`);
  const missing = [...new Set(asked)].filter((k) => !Object.hasOwn(VIEWER_STRINGS.en, k)).sort();
  assert.deepEqual(missing, [], `the page asks for keys the catalogue does not have:\n${missing.join('\n')}`);
});

test('every key a data-t attribute names exists in en', () => {
  const attrs = [...PAGE.matchAll(/data-t(?:-rich|-title|-ph)?="([^"]+)"/g)].map((m) => m[1]);
  // `data-t-fold="hint.x"` names a PAIR: the one-line lead that stands on the
  // page and the paragraph under the fold. Both must exist, or a tab hint would
  // render its own key name at reading size.
  for (const m of PAGE.matchAll(/data-t-fold="([^"]+)"/g)) attrs.push(`${m[1]}.lead`, `${m[1]}.more`);
  assert.ok(attrs.length > 30, `expected the page's static chrome to be keyed, found ${attrs.length}`);
  const missing = [...new Set(attrs)].filter((k) => !Object.hasOwn(VIEWER_STRINGS.en, k)).sort();
  assert.deepEqual(missing, [], `data-t names keys the catalogue does not have:\n${missing.join('\n')}`);
});

test('every en key is actually referenced by the page — no dead strings to translate', () => {
  const unused = Object.keys(VIEWER_STRINGS.en).filter((k) => !usedByPage(k)).sort();
  assert.deepEqual(unused, [], `catalogue keys nothing in the page uses:\n${unused.join('\n')}`);
});

// ---------------------------------------------------------------------------
// The page does not carry a copy of this module any more: the server hands it
// the module itself, minus the `export ` keywords. This is the guard on that
// transform — and on there being nothing left to drift.
// ---------------------------------------------------------------------------

const LIB_DEPS = { viewerLibDir: path.join(ROOT, 'src', 'viewer') };

test('the page is served THIS module, minus its `export ` keywords', () => {
  const out = handleViewerLib('GET', '/viewer/lib/i18n.js', LIB_DEPS);
  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'application/javascript; charset=utf-8');
  const mod = fs.readFileSync(path.join(ROOT, 'src/viewer/i18n.mjs'), 'utf8');
  assert.equal(out.body, mod.replace(/^export /gm, ''));
  // ...and what comes out is a classic script: the names are declared, nothing
  // is exported, so they land in the one scope the page's files share.
  assert.equal(/^export /m.test(out.body), false);
  for (const fn of ['interpolate', 'richText', 'makeT']) {
    assert.ok(out.body.includes(`function ${fn}(`), `the served text is missing ${fn}`);
  }
  assert.ok(out.body.includes('const VIEWER_STRINGS'), 'the served text is missing VIEWER_STRINGS');
});

test('the page loads it, before the file that first needs it', () => {
  const at = (src) => HTML.indexOf(`<script src="${src}">`);
  assert.ok(at('/viewer/lib/i18n.js') > 0, 'the page does not load /viewer/lib/i18n.js');
  assert.ok(at('/viewer/lib/i18n.js') < at('/viewer/js/10_dom.js'),
    'I18N is built while 10_dom.js runs, so the catalogue has to be there already');
});

test('and no copy of it is left in the page', () => {
  assert.equal(PAGE.includes('const VIEWER_STRINGS ='), false, 'a second catalogue is a catalogue that will drift');
  assert.equal(PAGE.includes('function makeT('), false);
});
