import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, interpolate, richText, VIEWER_STRINGS } from '../src/viewer/i18n.mjs';
import { TRUST_LEVELS } from '../src/core/trust.mjs';

// The viewer's i18n shell (SPEC §17.11, §15 M9). What is under test here is the
// SHELL, not the translation: that English is the default and the fallback,
// that a missing key is visible rather than swallowed, that the Korean
// catalogue covers exactly the English key set, and that the copy of this
// module inside the page has not drifted from the module itself.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KO = JSON.parse(fs.readFileSync(path.join(ROOT, 'viewer', 'i18n', 'ko.json'), 'utf8'));
const HTML = fs.readFileSync(path.join(ROOT, 'viewer', 'index.html'), 'utf8');
const CATALOG = { en: VIEWER_STRINGS.en, ko: KO };

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
  assert.notEqual(t('tab.overview'), VIEWER_STRINGS.en['tab.overview'], 'ko must actually translate a tab name');
  assert.equal(t('err.generic', { message: 'unknown-key: no such column' }).includes('unknown-key: no such column'), true,
    "the engine's own sentence is relayed inside the translated frame");
  assert.deepEqual([...t.missing], [], 'no key of the real catalogue is missing');
  assert.deepEqual([...t.fellBack], [], 'nothing the page asked for fell back to English');
  const en = makeT(CATALOG, 'en');
  assert.equal(en('tab.overview'), 'Overview');
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
    'ov.map.title', 'ov.map.hint', 'ov.gaps.note', 'ov.grades.title', 'ov.grades.note',
    'ov.hubtables.by',
  ];
  for (const k of added) {
    assert.equal(typeof VIEWER_STRINGS.en[k], 'string', `${k} is missing from en`);
    assert.equal(typeof KO[k], 'string', `${k} is missing from ko`);
    assert.match(KO[k], /[가-힣]/, `${k} is not translated`);
    assert.ok(HTML.includes(`'${k}'`), `${k} is in the catalogue but nothing in the page asks for it`);
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
  ];
  for (const k of added) {
    assert.equal(typeof VIEWER_STRINGS.en[k], 'string', `${k} is missing from en`);
    assert.equal(typeof KO[k], 'string', `${k} is missing from ko`);
    assert.match(KO[k], /[가-힣]/, `${k} is not translated`);
    assert.ok(HTML.includes(`'${k}'`), `${k} is in the catalogue but nothing in the page asks for it`);
  }
  // The four chip labels are what a masthead pill prints, so they stay short.
  for (const k of ['mast.build', 'mast.fresh.behind', 'mast.fresh.overlay', 'mast.fresh.current',
    'mast.trust.uncertified', 'mast.trust.golden_pass', 'mast.trust.golden_fail']) {
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
  const asked = [...HTML.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(asked.length > 20, `expected the page to use the catalogue, found ${asked.length} calls`);
  const missing = [...new Set(asked)].filter((k) => !Object.hasOwn(VIEWER_STRINGS.en, k)).sort();
  assert.deepEqual(missing, [], `the page asks for keys the catalogue does not have:\n${missing.join('\n')}`);
});

test('every key a data-t attribute names exists in en', () => {
  const attrs = [...HTML.matchAll(/data-t(?:-rich|-title|-ph)?="([^"]+)"/g)].map((m) => m[1]);
  // `data-t-fold="hint.x"` names a PAIR: the one-line lead that stands on the
  // page and the paragraph under the fold. Both must exist, or a tab hint would
  // render its own key name at reading size.
  for (const m of HTML.matchAll(/data-t-fold="([^"]+)"/g)) attrs.push(`${m[1]}.lead`, `${m[1]}.more`);
  assert.ok(attrs.length > 30, `expected the page's static chrome to be keyed, found ${attrs.length}`);
  const missing = [...new Set(attrs)].filter((k) => !Object.hasOwn(VIEWER_STRINGS.en, k)).sort();
  assert.deepEqual(missing, [], `data-t names keys the catalogue does not have:\n${missing.join('\n')}`);
});

test('every en key is actually referenced by the page — no dead strings to translate', () => {
  const lits = new Set([...HTML.matchAll(/'([^'\\\n]*)'/g)].map((m) => m[1]));
  for (const m of HTML.matchAll(/data-t(?:-rich|-title|-ph)?="([^"]+)"/g)) lits.add(m[1]);
  const unused = Object.keys(VIEWER_STRINGS.en).filter((k) => !lits.has(k)).sort();
  assert.deepEqual(unused, [], `catalogue keys nothing in the page uses:\n${unused.join('\n')}`);
});

// ---------------------------------------------------------------------------
// The page carries a copy of this module (it cannot import from src/): the two
// must not drift. Same guard as test/graphlayout.test.mjs.
// ---------------------------------------------------------------------------

function block(text, what) {
  const a = text.indexOf('// --- i18n (verbatim copy of src/viewer/i18n.mjs) ---');
  const b = text.indexOf('// --- end i18n ---');
  assert.ok(a >= 0 && b > a, `no i18n block found in ${what}`);
  return text.slice(text.indexOf('\n', a) + 1, b).trim();
}

test('viewer/index.html carries this module VERBATIM (minus `export `) — no drift', () => {
  const mod = fs.readFileSync(path.join(ROOT, 'src/viewer/i18n.mjs'), 'utf8');
  const want = block(mod, 'src/viewer/i18n.mjs').replace(/^export /gm, '');
  const got = block(HTML, 'viewer/index.html');
  assert.equal(got, want);
});

test('the page copy declares everything the module exports', () => {
  const inPage = block(HTML, 'viewer/index.html');
  for (const fn of ['interpolate', 'richText', 'makeT']) {
    assert.ok(inPage.includes(`function ${fn}(`), `page copy is missing ${fn}`);
  }
  assert.ok(inPage.includes('const VIEWER_STRINGS'), 'page copy is missing VIEWER_STRINGS');
});

test('the page copy is the catalogue the module ships — the same keys, the same strings', () => {
  // The drift test above compares text; this one proves the text MEANS the same
  // thing, by evaluating the page's copy and diffing the catalogue it declares.
  const inPage = block(HTML, 'viewer/index.html');
  // eslint-disable-next-line no-new-func
  const pageStrings = new Function(`${inPage}\nreturn VIEWER_STRINGS;`)();
  assert.deepEqual(pageStrings.en, VIEWER_STRINGS.en);
});
