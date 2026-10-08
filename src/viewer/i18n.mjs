// i18n.mjs — the viewer's string catalogue and its lookup (SPEC §17.11).
//
// Two rules decide what belongs here.
//
//   1. ENGLISH IS THE DEFAULT and the FALLBACK. A key a translation has not
//      reached is answered in English, never blanked and never thrown over: a
//      half-translated page must still be a usable page.
//   2. ONLY THE CHROME IS TRANSLATED. Tab names, header labels, buttons,
//      toggles, hints, empty states, error banners and the project selector are
//      the PAGE's own words, so the page owns them. Everything the ENGINE said
//      — a grade, a limit, a truncation note, an `empty` reason, a trust level,
//      a tool's error message — is relayed exactly as it arrived. That is the
//      honesty contract: a translated grade is a grade this project invented,
//      and no reader could check it against the engine's own answer.
//
// The Korean catalogue is NOT in this file, and not in the page either: the
// English-only gate (test/gates.test.mjs) scans `src/` and `viewer/index.html`
// for non-English characters, and a translation is the one place such text is
// expected. It lives in `viewer/i18n/ko.json`, served by the viewer server at
// `GET /i18n/ko.json`, and test/i18n.test.mjs holds it to exactly this key set.
//
// THE VOICE (RM23). Every string here is one senior developer explaining a
// screen to a junior who knows Spring and SQL but has never seen this tool.
// Say what a thing is FOR before what it is; use the reader's nouns (API,
// controller, service, mapper, SQL, table, column); one idea per sentence; a
// number is a fact, not a hedge. Where the engine's own vocabulary has to
// appear, say once in plain words what it means and then use it.
// test/i18n_voice.test.mjs holds the mechanical half of that: no em dash and no
// middle dot in a catalogue string, a lead of at most 90 characters, a `more`
// of at most four sentences, and every Korean sentence in the polite -hamnida
// register rather than the flat note-taking one.
//
// Pure: no DOM, no fetch, no state beyond the missing-key ledger a caller can
// read back. THE PAGE RUNS THIS FILE: the viewer is one global scope and cannot
// `import` from src/, so `cascade view` hands it this text at
// `GET /viewer/lib/i18n.js` minus the `export ` keywords. There is no copy to
// drift from any more; test/i18n.test.mjs checks that what is served is this.

/**
 * Substitute `{name}` placeholders. A placeholder with no matching parameter is
 * LEFT AS IT IS: showing `{id}` says a caller forgot an argument, where an
 * empty gap silently reads as a sentence that was always meant to have a hole
 * in it. (It also lets a string legitimately contain braces — the Flow tab's
 * placeholder names the route `GET /product/updateInfo/{id}`.)
 * @param {string} text
 * @param {object} [params]
 * @returns {string}
 */
export function interpolate(text, params) {
  const has = (name) => params && typeof params === 'object' && Object.hasOwn(params, name) && params[name] != null;
  // `{n|route|routes}` is the word for the count `n`, so an English line reads
  // "1 route" and "2 routes" rather than "route(s)". Only the word is written;
  // the number is its own `{n}`.
  return String(text).replace(/\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (whole, name, one, other) => {
    if (!has(name)) return whole;
    if (one === undefined) return String(params[name]);
    return Number(params[name]) === 1 ? one : other;
  });
}

/**
 * Split a catalogue string into plain / `code` / **bold** runs. The page turns
 * these into elements itself, so a translation can carry emphasis WITHOUT the
 * catalogue carrying markup the page would have to inject as HTML.
 * @param {string} text
 * @returns {{tag:(null|'code'|'b'), text:string}[]}
 */
export function richText(text) {
  const s = String(text);
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ tag: null, text: s.slice(last, m.index) });
    out.push(m[1] != null ? { tag: 'code', text: m[1] } : { tag: 'b', text: m[2] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ tag: null, text: s.slice(last) });
  if (out.length === 0) out.push({ tag: null, text: '' });
  return out;
}

/**
 * A translator over a catalogue `{en:{…}, ko:{…}, …}`.
 *
 * `t(key, params)` NEVER throws and never returns undefined: the requested
 * language first, English second, and — if neither has the key — the key
 * itself, recorded in `t.missing`. A missing key must be visible in the page
 * (as its own name) and countable in a test, not swallowed.
 *
 * @param {object} catalog  language code -> {key: string}
 * @param {string} lang     the language wanted ('en' when unknown)
 * @returns {((key:string, params?:object)=>string) & {lang:string, missing:Set<string>, fellBack:Set<string>}}
 */
export function makeT(catalog, lang) {
  const cat = catalog && typeof catalog === 'object' ? catalog : {};
  const base = cat.en && typeof cat.en === 'object' ? cat.en : {};
  const wantedLang = typeof lang === 'string' && cat[lang] && typeof cat[lang] === 'object' ? lang : 'en';
  const want = wantedLang === 'en' ? base : cat[wantedLang];
  const t = (key, params) => {
    const k = String(key);
    let s = Object.hasOwn(want, k) ? want[k] : undefined;
    if (typeof s !== 'string') {
      s = Object.hasOwn(base, k) ? base[k] : undefined;
      if (typeof s === 'string' && want !== base) t.fellBack.add(k);
    }
    if (typeof s !== 'string') {
      t.missing.add(k);
      return k;
    }
    return interpolate(s, params);
  };
  t.lang = wantedLang;
  t.missing = new Set();   // keys no catalogue had — the page shows the key
  t.fellBack = new Set();  // keys this language lacked but English had
  return t;
}

/**
 * The chrome, in English. Every string the PAGE writes for itself; nothing the
 * engine wrote. A translation must carry exactly these keys — no more, so a
 * stale key cannot linger, and no fewer, so nothing silently falls back.
 */
export const VIEWER_STRINGS = {
  en: {
    // ---- masthead ------------------------------------------------------
    'header.loading': 'loading…',
    // Tooltips on the dateline. The VALUES beside them are the engine's own
    // words — a digest, a commit, a lane name, a freshness verdict — and are
    // never translated, so only these labels live here.
    'mast.project': 'which project this page is showing',
    'mast.digest': 'a short fingerprint of this build, so you can tell two of them apart',
    'mast.base': 'the git commit this build was made from',
    'mast.lanes': 'which analyzers ran over this project',
    'mast.freshness': 'freshness',
    'mast.trust': 'trust',
    'mast.limits': '{n} project {n|limit|limits}',
    // BUILD IDENTITY, one click behind the line. The digest and the base commit
    // are what you need to tell two builds apart or to chase a mismatch, and
    // they are the first thing a reader who has never seen this tool has to
    // skip past. So the line says which project and which analyzers, and this
    // little control opens the rest. Nothing is dropped, only demoted.
    'mast.build': 'counts and build',
    'mast.build.title': 'the counts along the chain, the fingerprint of this build and the commit it was made from',
    // A TRACE INFORMED THIS PACK, said as quietly as freshness and trust are.
    // The source word and the span count are the capture's own numbers and are
    // interpolated, never rewritten; the coverage note beside them is the
    // engine's own sentence and rides in the tooltip verbatim. Nothing shows
    // when no capture was read.
    'mast.trace': 'trace: {source}, {n} {n|span|spans}',
    'mast.trace.title': 'a recording of this system running was read into this pack. A row it saw carries the seen mark, and a row without one was not visited by this recording rather than dead.',
    // FRESHNESS, said only when there is something to act on. The verdict word
    // itself is the engine's and is never rewritten: these are the plain
    // sentences that go BESIDE it, and every one of them carries the verdict
    // verbatim in its tooltip.
    'mast.fresh.behind': 'older than the code you have now',
    'mast.fresh.behind.title': 'this pack was built from an older commit than the one you have checked out. Run the analysis again to see what changed.',
    'mast.fresh.overlay': 'edits folded in on top of this build',
    'mast.fresh.overlay.title': 'your working edits sit on top of the last full analysis, so anything they touch is provisional until you build again.',
    'mast.fresh.current': 'up to date',
    'mast.fresh.current.title': 'this pack was built from the commit you have checked out, so nothing here is older than your code.',
    'mast.fresh.unknown.title': 'this page shows the pack as it was built and does not compare it with your working tree, so it cannot say whether the build is behind. It is not an error.',
    // TRUST, in the reader's words. The level itself is computed by the engine
    // and is relayed verbatim in the tooltip; these strings only say what it
    // means, at speaking volume instead of shouting volume. Each key is the
    // level LOWER-CASED, because the page looks the gloss up from the value it
    // was handed rather than holding a list of levels of its own (SPEC §14.3:
    // only src/core/trust.mjs writes those names). A level with no key here is
    // printed exactly as it arrived.
    'mast.trust.uncertified': 'not certified',
    'mast.trust.uncertified.title': 'there is no approved golden set for this project yet, so every edge carries its own grade and the answer as a whole is not scored.',
    'mast.trust.golden_pass': 'checks passing',
    'mast.trust.golden_pass.title': 'this project has an approved golden set and the last run matched it, so the answer as a whole was scored.',
    'mast.trust.golden_fail': 'checks failing',
    'mast.trust.golden_fail.title': 'this project has an approved golden set and the last run did not match it, so read what is here against that.',
    'mast.trust.runtime_pass': 'checked against what ran',
    'mast.trust.runtime_pass.title': 'the checks behind this were labelled by a recording of the program running, so they show that the answer covered what actually ran. They do not cover precision, and they say nothing about a route nobody exercised. The names beside this are the checks that could not be scored.',
    'mast.trust.none.title': 'no answer has come back yet, so there is no trust level to show.',
    // The way out of "not certified", which is the state almost every project is
    // in. Said here rather than on a chip: the masthead is silent about it now,
    // and this is the tooltip a reader who wants to change it will reach for.
    'mast.trust.how': 'two things move this: approve a golden set for this project with cascade golden propose and then cascade golden approve, or label the checks from a recording of the program with cascade golden propose --from-otel <trace>.',
    'legend.grade': 'how sure each line is:',
    // ---- the cascade rail (the header's second line) ---------------------
    // The six steps of the chain this engine follows, in the order it walks it.
    'crail.title': 'the steps this tool follows, in order. Every count comes straight from the overview answer.',
    'crail.groups': 'api groups by path',
    'crail.groups.title': 'an API group is the first segment of a route below the prefix the application is deployed under, like the users in /api/v1/users/list. It is how the routes are named, not a module anyone declared. Structure and Trace group routes this way too, and the map on Start says what its own boxes are.',
    'crail.modules': 'modules, as declared',
    'crail.modules.title': 'a module is the handler\'s package cut to {n} {n|segment|segments}, as the profile declares in moduleAttribution.packageDepth. Structure, Trace and the map on Start group routes this way too.',
    'crail.endpoints': 'endpoints',
    'crail.services': 'services',
    'crail.services.title': 'the methods the routes\' walks pass through between a controller method and the SQL, each counted once: the services lane Flow draws, and a method that sends its SQL from its own body, such as a service calling the ORM, which Flow draws inside the statement it sends. A controller method, a frontend function, a library method and a mapper or repository method that only declares a statement are not counted.',
    'crail.sql': 'SQL',
    'crail.tables': 'tables',
    'crail.columns': 'columns',
    'crail.screens': 'screens',
    'crail.notshipped': 'not collected',
    'crail.notshipped.title': 'this project was analysed without the part that counts these, so the number is missing rather than zero. Click to see why and what to set.',
    'crail.degraded.title': 'this part ran but could not see all of it, so the number below it is a lower bound',
    'legend.kind': 'what the dots are:',
    'legend.line': 'what the lines mean:',
    // The one line of the graph legend that is NOT about a grade. A trace saw
    // the call happen, so the line is drawn heavier. The dash pattern beside it
    // still carries the grade, untouched: this says a call ran, not that it is
    // any surer than the analyzer already said.
    'legend.observed': 'thicker line = a recording saw it run',
    'legend.observed.title': 'a recording of this system running saw this call happen. It stands beside the grade and never changes it, so a thin line was not visited by that recording rather than dead.',
    // ---- project selector ----------------------------------------------
    'project.select.title': 'which project this page is about. Switching clears every tab and asks the new project from scratch.',
    'project.none': 'no project is being served',
    'project.none.hint': 'Run `cascade init` and then `cascade analyze` in a repository, then reload this page.',
    // ---- language toggle -----------------------------------------------
    'lang.label': 'EN',
    'lang.title': 'the language of this page. Words the engine itself wrote, like grades and limits, stay in English so you can match them against the raw answer.',
    // ---- theme toggle ---------------------------------------------------
    // Two themes on one token system: the dark signal room (the default) and
    // the light engineering drawing. The reader chooses; the system is not
    // asked, because the default is the product's own.
    'theme.title': 'how this page is drawn. Dark gives every kind of node its own colour and makes a lit one glow. Light is ink on paper, where the shape carries the kind and a greyscale print still reads.',
    'theme.dark': 'Dark',
    'theme.light': 'Light',
    // ---- tabs ----------------------------------------------------------
    'tab.coupling': 'Coupling',
    'tab.graph': 'Graph',
    'tab.erd': 'Table links, by SQL joins',
    'tab.tx': 'Transactions',
    'tab.compare': 'Compare',
    'tab.rules': 'Rules',
    'trace.lim.todetail': 'It stopped at depth {depth}. Details lists every screen a change here is felt on, with no depth cap.',
    'detail.screens.routes': '{n} API',
    'detail.screens': 'Screens a change here is felt on, mode {mode}, with no depth cap',
    'detail.table.columns': 'columns, with how many statements read and write each',
    'detail.table.sql': 'SQL that touches it',
    'detail.table': 'table',
    'detail.ddl.title': 'view CREATE TABLE',
    'detail.access.title': 'what this statement does here, in the words the SQL analyzer recorded: read or write',
    'detail.column.routes': 'APIs above that SQL, mode {mode}',
    'detail.column.sql': 'SQL that reads or writes it, every grade ({r} read, {w} write)',
    'detail.column': 'column',
    'trace.detail.tx.none': 'No @Transactional method on its way down, in this mode and depth.',
    'trace.detail.tx.open': 'open this boundary on the Transactions tab',
    'trace.detail.tx.self': 'this one',
    'trace.detail.tx.lead': 'The @Transactional methods on its way down, in mode {mode} to depth {depth}. Each one opens on the Transactions tab.',
    'trace.detail.tx': 'Transactions it runs through',
    'trace.detail.handler': 'handler {h}',
    'trace.detail.statement': 'SQL statement',
    'trace.detail.symbol': 'method',
    'trace.detail.endpoint': 'API route',
    'load.detail': 'reading the details…',
    'trace.from.title': 'start the question again from this row, read the same way where it can be',
    'trace.from': 'Trace from here',
    'trace.lim.none': 'No cap cut this answer: it was followed to the end.',
    'trace.lim.noscreens': 'No frontend was analyzed, so which screens call this is unknown.',
    'trace.lim.page': '{lane}: {shown} of {total} fetched, **{n}** still to come. The button over the lane fetches more.',
    'trace.lim.beyond': '**{n}** more {n|row|rows} in {lane} {n|is|are} named just past the depth cap and were not walked.',
    'trace.lim.generated': '**{n}** steps inside generated code were skipped, as the profile declares.',
    'trace.lim.nodecap': 'The walk reached its node cap. This chain is bigger than one picture.',
    'trace.lim.deeper': 'Follow it all the way',
    'trace.lim.depth': '**{n}** rows stopped at depth {depth}, and what lies past them was not followed.',
    'trace.lim.title': 'What limited this answer',
    'trace.ans.up': 'Change this and it reaches {parts}.',
    'trace.ans.down': 'From here it reaches {parts}.',
    'trace.ans.none': 'Nothing is reached at the end of this walk: {parts}.',
    'trace.ans.and': ' and ',
    'trace.ans.mode': 'counted in {mode}, depth {depth}',
    'trace.ans.cut': 'The walk stopped at depth {depth}, so there may be more.',
    'trace.ans.address': 'This route\'s own address is graded {grade}, so every caller found by that address carries the same grade.',
    'trace.ans.zero': 'The {what} are counted in {mode}, which did not follow {n} {n|link|links}: there may be some past them.',
    'trace.ans.floor.route': 'In {mode} this reaches nothing: this route\'s own address is graded {grade}, and {mode} stops at it.',
    'trace.ans.floor': 'In {mode} this reaches nothing: {n} {n|link|links} on the way {n|is|are} graded below what {mode} follows.',
    'trace.ans.look': 'Look in {mode}',
    'trace.ans.more': '{n} more in the picture below',
    'trace.ans.endpoints': '{n} APIs',
    'trace.ans.endpoints.one': '{n} API',
    'trace.ans.screens': '{n} screens',
    'trace.ans.screens.one': '{n} screen',
    'trace.ans.statements': '{n} SQL statements',
    'trace.ans.statements.one': '{n} SQL statement',
    'trace.ans.tables': '{n} tables',
    'trace.ans.tables.one': '{n} table',
    'rail.lead.trace': 'Pick something from the list, or search any kind in the box above, to start.',
    'hint.trace.more': 'Search any API, screen, table, column, SQL statement or method, or pick one from the list. What it uses follows it down to the tables, and where it is used follows it up to the APIs and screens a change would touch. The answer is said in one sentence over the picture, with the ends it reaches. The box beside the picture says what limited it.',
    'hint.trace.lead': 'Pick one thing, then read what it uses, where it is used, or its details.',
    'trace.q.depth': 'depth {n}',
    'trace.q.mode': 'mode {mode}',
    'trace.nodir.column.down': 'A column is where a chain ends, so it uses nothing. Read where it is used.',
    'trace.nodir.table.down': 'A table is where a chain ends, so it uses nothing. Its columns are under Details.',
    'trace.nodir.statement.down': 'A statement uses only its own tables. They are under Details.',
    'trace.nodir.screen.up': 'A screen is the top of the chain, so nothing uses it.',
    'trace.depth.title': 'depth: the most links a walk follows from the target. All, the default, follows every one, as every tool does; a number narrows the walk, and what lies past it is unknown, not absent.',
    'trace.dir.detail.title': 'what it is, as lists: its SQL, its columns with reads and writes, or the transactions it runs through',
    'trace.dir.detail': 'Details',
    'trace.dir.up.title': 'follow it up: the code, APIs and screens that reach it, which is what a change here would touch',
    'trace.dir.up': '↑ Where it is used',
    'trace.dir.down.title': 'follow it down: the code it runs and the tables it ends at',
    'trace.dir.down': '↓ What it uses',
    'trace.dir.title': 'which way to read the target. Only the ways this kind of target has are shown.',
    'trace.entry.ph': 'an API, screen, table, column, SQL or method',
    'btn.trace': 'Trace',
    'tab.trace': 'Trace',
    'rules.loading': 'Reading the rule packs…',
    'rules.filter.ph': 'find a rule by its name, pack or what it says',
    'rules.kind.title': 'rules of one kind',
    'rules.kind.all': 'every kind',
    'rules.lane.title': 'rules one lane of the analysis runs',
    'rules.lane.all': 'every lane',
    'rules.scope.title': 'the rules that gave something in this project, or every rule the engine carries',
    'rules.scope.here': 'applies here ({n})',
    'rules.scope.all': 'all ({n})',
    'rules.summary': '{packs} {packs|pack|packs}, {rules} {rules|rule|rules}; {here} gave something in this project.',
    'rules.group.here': 'Gave something here',
    'rules.group.idle': 'Gave nothing here',
    'rules.group.classify': 'Classifies, so nothing to count',
    'rules.gave.links': '{n} {n|link|links}',
    'rules.gave.nodes': '{n} {kind} {n|node|nodes}',
    'rules.gave.none': 'none here',
    'rules.gave.classifies': 'classifies',
    'rules.gave.title': 'What it gave in this project',
    'rules.gave.classifies.long': 'A rule of this kind classifies, such as the database a file path names. The pack keeps no record of what it concluded, so there is nothing to count here, which is not the same as unused.',
    'rules.gave.nothing': 'Nothing in this project matched it. It is for a framework or a library this project does not use.',
    'rules.none.match': 'No rule matches these filters.',
    'rules.none.here': 'No rule in the rule packs drew a link or a node in this project. That is normal where the project uses no framework a pack describes. Rules that only classify leave nothing to count, and are listed under all.',
    'rules.none.pick': 'Pick a rule from the list, or show all of them.',
    'rules.more.idle': '{n} more {n|rule|rules} gave nothing here.',
    'rules.more.show': 'Show them',
    'rules.file': 'pack {pack}, file {file}',
    'rules.page': '{from} to {to} of {total}',
    'rules.page.prev': 'Previous',
    'rules.page.next': 'Next',
    'rules.cap': 'may give at most',
    'rules.cap.title': 'the strongest grade a link of this rule may carry. A link it gave can be weaker, where its lane could not read everything the link rests on.',
    'rules.empty': 'This engine carries no rule.',
    'rules.why': 'Why it is there',
    'rules.library': 'What it relies on in a library',
    'rules.library.source': 'Written in {source}',
    'rules.params': 'Params',
    'rules.examples': 'Examples ({n})',
    'rules.examples.held': 'Examples: {k} of {n} {k|holds|hold}',
    'rules.examples.notrun': 'Not run on this server: {why}',
    'rules.examples.unknown': 'Whether they hold was not asked of this server. `cascade rules test` runs them.',
    'rules.example.holds': 'holds',
    'rules.example.fails': 'does not hold',
    'rules.expect': 'expects {expect}',
    'rules.how': 'A rule is changed in its JSON pack (docs/rules.md), and `cascade rules test` runs every example.',
    'hint.rules.lead': 'What the engine knows about frameworks, and what each rule gave in this project.',
    'hint.rules.more': 'A rule is framework knowledge written as data: which decorator makes a route, which base type makes a mapper, what a Prisma call reads. A link a rule gave names it in its evidence, so the path on Flow and Impact says which rule made each step. Pick a rule to see the links it gave and open any of them. The list starts with what applies here.',
    // ---- shared toolbar vocabulary -------------------------------------
    // A MODE IS NAMED BY WHAT IT ADMITS (RM67). "Likely calls" was wrong for
    // the middle one: a candidate set is sure to contain the real target, which
    // is a guarantee, not a likelihood. The grade each mode adds is the
    // engine's token and the page prints it after these words (option[data-grade]).
    'mode.title': 'which links the walk follows. strict: only proven links. conservative: also candidate sets, sure to hold the real target. heuristic: also guesses from conventions, to check. No mode says a call will run or a change will break, and none follows a link decided at run time or one the analysis could not tell.',
    'mode.conservative': 'conservative: proven links + candidate sets',
    'mode.strict': 'strict: proven links only',
    'mode.heuristic': 'heuristic: proven links + candidate sets + guesses',
    // THE SAME WORDS FOR A GRADE WHEREVER ONE IS EXPLAINED (RM67): the chain
    // legend, the badge tooltips, "What this walk left out" and the map legend.
    // docs/concepts.md holds the definitions these say in one line.
    'grade.say.EXACT': 'proven: the source or a framework contract states it',
    'grade.say.SOUND_SET': 'a candidate set sure to hold the real target',
    'grade.say.HEURISTIC': 'a guess from a convention or an incomplete reading; check it',
    'grade.say.RUNTIME_ONLY': 'decided at run time; no mode follows it',
    'grade.say.UNRESOLVED': 'the analysis could not tell; no mode follows it',
    'view.title': 'chain draws the whole path left to right. by hop groups the same rows one step at a time.',
    'view.lanes': 'chain',
    'view.layers': 'by hop',
    'btn.draw': 'Draw',
    'btn.export': 'HTML file',
    'btn.export.menu': 'Save as',
    'btn.export.menu.title': 'save this picture as one HTML file, an SVG or a PNG',
    'btn.options': 'Options',
    'btn.options.title': 'how deep to follow, how to draw it, and whether the dots run',
    'tb.depth': 'depth',
    'btn.svg.title': 'save this picture as one SVG, for a slide or a document: every row, grade, cut and limit is drawn in it',
    'btn.png.title': 'save this picture as a PNG, made in this browser from the SVG: every row, grade, cut and limit is drawn in it',
    'export.png.failed': 'this browser could not turn the picture into a PNG. Save the SVG instead',
    'btn.export.title': 'save this picture as one HTML file that opens without Cascade: the answer, its grades and its limits are inside',
    'snap.title': 'Snapshot',
    'snap.question': '{dir}: {kind} {value}, mode {mode}, depth {depth}, up to {limit} {limit|row|rows}',
    'snap.when': 'exported {generated} from pack {digest}, built {built}, Cascade {version}',
    'snap.honesty': 'this answer: trust {trust}, {limits} {limits|limit|limits}, {truncated} {truncated|cut list|cut lists}, each one named in the rail beside the picture',
    'snap.honesty.picture': 'this answer: trust {trust}, {limits} {limits|limit|limits}, {truncated} {truncated|cut list|cut lists}, each one named under the picture',
    'chain.svg.dropped': '{n} {n|link is|links are} not drawn: the row each one comes from is in a list that was cut',
    'snap.only': 'This file holds this one answer. Anything else you ask here says it is not in the file.',
    'snap.miss': 'This file holds only the answer it was exported with. Open the project in Cascade to ask anything else.',
    'snap.miss.source': 'The source is read from the working tree, and this file does not carry one.',
    // ---- the fold, used on every tab ------------------------------------
    // The only words the fold itself carries: the accessible name of the
    // chevron. There is no "more" label — the chevron and `aria-expanded` say
    // it, and a word here would be a word on every block of the page.
    'fold.show': 'show the full text',
    'fold.hide': 'hide the full text',
    // ---- Overview tab ---------------------------------------------------
    // Every tab hint is a LEAD (one line, the Read level) and the paragraph it
    // used to print, under the fold. The lead is what a reader sees at a
    // glance; the paragraph is one activation away.
    'load.overview': 'following every endpoint down to the tables…',
    // ---- Overview: the headings of the panels under the ribbon -----------
    // The panel NAMES are the page's; every number and every word inside them
    // is the `overview` answer's own.
    'ov.gaps.title': 'What the analysis did not see',
    'ov.gaps.input': 'Inputs it did not have',
    'ov.gaps.unresolved': 'What it could not read',
    'ov.gaps.query': 'Links this mode does not follow',
    'ov.gaps.unreached': 'Not reached: worth a look, not an error',
    'ov.gaps.info': 'For the record',
    'ov.axis.notshipped': '{axis}: not collected',
    'ov.axis.degraded': '{axis}: only partly read',
    'ov.axis.name.catalog': 'database schema',
    'ov.axis.name.statements': 'SQL',
    'ov.axis.name.column': 'columns',
    'ov.axis.name.code': 'code',
    'ov.axis.name.web': 'frontend calls',
    'ov.axis.name.screen': 'screens',
    // HOW MUCH OF THIS PROJECT LEAVES IT. A call to a route this project does
    // not serve stops the chain, unless another registered project serves that
    // route and the server can carry the answer across.
    'ov.federation.note': '{n} {n|call leaves|calls leave} this project, {k} answered by a registered project and {m} not.',
    // WHO THIS PROJECT TALKS TO (RM45). The census above is one sentence; this
    // panel is the list behind it, one row per registered project that answers
    // a route this one calls, and one last row for the calls nobody answers.
    'ov.connected.title': 'Connected projects',
    'ov.connected.count': '({n} connected, {m} {m|route|routes} nobody here serves)',
    'ov.connected.note': 'the routes this project calls and does not serve, and the registered project that answers each one. Click a row to go there.',
    'ov.connected.calls': '{n} {n|call site|call sites} over {r} {r|route|routes}',
    'ov.connected.more': '+{n} more',
    'ov.connected.route.title': '{n} {n|method makes|methods make} this call',
    'ov.connected.open.title': 'open {p} on this page. Nothing is asked of the project you are leaving.',
    'ov.connected.unmatched': 'nobody serves these',
    'ov.connected.unmatched.note': 'these routes leave this project and no registered project serves them, so the chain stops at the call. Register the project that serves them and ask again.',
    // THE MAP, ONCE IT REACHES INTO ANOTHER PACK. A node from another project
    // keeps its kind's fill and wears a ring in that project's own hue, and the
    // skeleton it hangs off is drawn like a group because that is its job here.
    'mapleg.project': 'connected project',
    'mapleg.connected': 'connected',
    'mapleg.fedring.title': 'a ring around a node says it came from another registered project this server serves. The fill still says what kind of node it is, and the ring says which project it is in.',
    'chip.fed.on': 'connected projects {n}',
    'chip.fed.off': 'connected projects {n} hidden',
    'chip.fed.on.title': 'hide the {n} {n|node|nodes} that came from {k} other registered {k|project|projects}',
    'chip.fed.off.title': 'draw the {n} {n|node|nodes} that came from {k} other registered {k|project|projects}',
    'gcount.federated': '**{n}** {n|node|nodes} from **{k}** connected {k|project|projects}',
    'gcount.federated.off': '(hidden)',
    'tip.fedproject': 'in {p}, another registered project on this server',
    'tip.fedskeleton': 'a connected project. {n} of its {n|route|routes} {n|is|are} on this map, because this project calls them.',
    'tip.crossing': 'this project calls a route {p} serves',
    'tip.crossing.ambiguous': 'more than one registered project serves this route, so this line is a candidate',
    'map.card.fedproject': 'this node is in {p}. Everything about it is that project\'s own answer, so it is opened there.',
    'map.card.project': 'a connected project. What hangs off it is only what this project reaches by calling it.',
    'map.card.portal': 'the route this project calls',
    'map.card.open': 'Open in {p}',
    'map.card.open.title': 'switch the page to {p} and open this there. Nothing is asked of the project you are leaving.',
    'map.card.projectlist': 'connected projects ({n})',
    // THE ERD, ONCE IT REACHES INTO ANOTHER PACK. One framed cluster per
    // project, its own joins inside it, and a DASHED line from the route this
    // project called to the tables that route reaches over there.
    'erdleg.connected.on': 'connected projects {n}',
    'erdleg.connected.off': 'connected projects {n} hidden',
    'erdleg.connected.on.title': 'hide the {n} connected {n|project|projects} on this sheet',
    'erdleg.connected.off.title': 'draw the {n} connected {n|project|projects} this project reaches over an HTTP call',
    'erdleg.connected.title': 'the tables in {p} that a request from this project reaches',
    'erdleg.via': 'dashed: reached over an HTTP call, not a foreign key',
    'erdleg.via.title': 'a dashed line runs from the route this project called to the tables that route reaches over there. It is a call between two services, and two services share no foreign key, so no relationship on this sheet ever joins two projects.',
    'erd.via.tip': 'reached over an HTTP call at {grade}, not a foreign key',
    'erd.via.ambiguous': 'ambiguous',
    'erd.via.body': 'this project calls this route and another project serves it. The tables below are what that route reaches over there, and the line to each one is the call, not a key.',
    'erd.via.tables': 'tables this route reaches',
    'erd.via.reached': 'reached through',
    'erd.side.connected': 'Connected projects',
    'erd.side.connected.note': 'the projects a request from this one reaches over an HTTP call. Each keeps its own tables and its own joins, because two services share no foreign key.',
    'erd.side.connected.counts': '{tables} {tables|table|tables}, {rels} {rels|relationship|relationships}',
    'erd.side.connected.open': 'open the ERD of {p}',
    'erd.side.connected.hidden': 'they are not on the sheet right now. The switch in the legend above the picture draws them.',
    'erd.side.map.fedonly': 'this project has no table of its own. Its requests end in {n} other registered {n|project|projects}: {p}.',
    'erd.side.fed.body': 'this table is in {p}. The relationships below are that project\'s own, and the columns come from that project\'s answer.',
    'erd.side.fed.norels': 'none: no join inside this cluster touches this table',
    'erd.side.fed.cols': 'asked of {p}, the project that has this table',
    // THE NAME OF A BLIND SPOT, in the reader's words. The engine's own kind
    // slug stays on the chip's tooltip beside the count, so nothing is renamed
    // away: this is the label a person can read without the docs open. A kind
    // with no label here falls back to its slug, so a new one the engine starts
    // emitting shows up as itself rather than breaking the panel.
    //
    // Every label names what the COUNT counts, because the count stands beside
    // it: `mode-floor 412` has to read as 412 connections, not as 412 modes.
    // Each one was written against that kind's own note in src/core/overview.mjs
    // and says the same thing in one line. test/i18n.test.mjs reads the kinds
    // out of that file, so a kind added there without a label here fails.
    'ov.gap.unresolved-calls.label': 'calls we could not follow',
    'ov.gap.external-symbols.label': 'code outside this project',
    'ov.gap.http-calls-leaving-pack.label': 'API calls no route here answers',
    'ov.gap.screen-components-unresolved.label': 'screens with no component found',
    'ov.gap.endpoints-without-statement.label': 'endpoints that reach no SQL',
    'ov.gap.statements-not-reached.label': 'SQL no endpoint reaches',
    'ov.gap.duplicate-types.label': 'types declared twice',
    'ov.gap.mode-floor.label': 'links this mode leaves out',
    'ov.gap.not-shipped.label': 'SQL with no backend code to call it',
    'ov.gap.no-catalog.label': 'no database schema was read',
    'ov.gap.multi-handler-routes.label': 'routes two controllers both declare',
    'ov.gap.tables-not-reached.label': 'tables no endpoint reaches',
    'ov.gap.openapi-drift.label': 'routes the API document disagrees on',
    'ov.gap.contract-links.label': 'handlers paired by a generator\'s naming',
    'ov.gap.screens-from-server.label': 'screens the server adds at run time',
    'ov.gap.screens-seen-at-run-time.label': 'screens known only from a recording',
    'ov.gap.runtime-evidence.label': 'what a trace saw actually run',
    'ov.gap.generated-code.label': 'machine-written code',
    'ov.gap.generated-walk-skip.label': 'steps inside generated code we skipped',
    'ov.gap.node-cap.label': 'chains too big to walk in one go',
    'ov.gap.depth-cap.label': 'chains we stopped at the depth limit',
    'ov.gap.jpa-statements-unresolved.label': 'JPA queries we could only partly read',
    'ov.gap.mp-columns-runtime-only.label': 'columns decided when the query runs',
    'ov.gap.catalog-tables-unread.label': 'tables the schema reader could not read',
    'ov.gap.catalog-rules-assumed.label': 'schema read by an assumed database',
    'ov.gap.catalog-read-in-part.label': 'schema parts not read as written',
    'ov.nodes.title': 'What we found',
    'ov.nodes.count': '({n} {n|kind|kinds})',
    'ov.edges.title': 'Connections, by type and certainty',
    'ov.code.title': 'The backend code',
    'ov.code.symbols': 'methods',
    'ov.code.external': 'library types',
    'ov.code.mapper': 'mapper methods',
    'ov.hubtables.title': 'Tables, by how many APIs reach them',
    'ov.hubtables.by': 'by how many endpoints can reach them',
    'ov.hubendpoints.title': 'APIs, by how many tables they touch',
    // The other end of the round trip, listed the same way: the screens the
    // frontend declares, busiest first, each one a click away from its chain.
    'ov.hubscreens.title': 'Screens, by how many tables they reach',
    'ov.hubscreens.by': 'by how many tables each one ends at',
    'ov.hubscreens.none': 'This project was analysed without a frontend, so there is no screen to show here.',
    // A hub table shows its top five; the rest of what the ANSWER carries opens
    // under this line. It never says "all": the answer holds ten of forty-nine,
    // and the heading beside it is where the forty-nine is printed.
    'ov.hub.more': '{n} more of {total}',
    'ov.hub.mode': 'counted in {mode}',
    'ov.col.kind': 'kind',
    'ov.col.nodes': 'nodes',
    'ov.col.type': 'type',
    'ov.col.grade': 'grade',
    'ov.col.edges': 'edges',
    'ov.col.what': 'what',
    'ov.col.count': 'count',
    'ov.col.endpoint': 'API',
    'ov.col.screen': 'screen',
    'ov.col.tables': 'tables',
    'ov.col.statements': 'SQL',
    'ov.col.apis': 'APIs',
    // The two tooltips and the footnote of the code panel.
    'ov.code.symbols.title': 'methods we read out of the Java source',
    'ov.code.external.title': 'a library or framework class with no source here, so a chain that runs into one stops there',
    'ov.code.tx.title': 'methods marked `@Transactional`, so everything under one runs in a single commit',
    'ov.code.mapper.title': 'methods that are themselves a SQL statement',
    'ov.code.nomapper': '{n} {n|statement has|statements have} no mapper method',
    'ov.gap.table.title': 'what touches this table',
    // ---- Explore: the card behind one screen -----------------------------
    // A screen is a ROUTE the frontend declares plus the component it mounts.
    // The card says what it renders, which API routes those functions reach,
    // and which tables the request ends at. Every one of those is the `flow`
    // answer walked from this screen, so the card counts nothing itself.
    'screen.title': 'screen',
    'screen.component': 'component',
    // RM48: the other kind of screen. A router declares a path and mounts a
    // component; a controller answers a path and names a view, and the view
    // resolver turns that name into a file.
    'screen.template': 'template',
    'screen.renderedby': 'rendered on',
    'screen.kind.page': 'page',
    'screen.kind.page.title': 'a page the server renders: a controller returned this view name and the template engine turned it into the page the browser gets',
    'screen.renders': 'what this screen runs',
    'screen.endpoints': 'API routes it reaches',
    'screen.tables': 'tables at the end',
    'screen.sends': 'sends',
    'screen.sends.title': 'this function makes the HTTP call itself',
    'screen.leadsto': 'leads to',
    'screen.leadsto.title': 'this function calls something else that makes the HTTP call',
    // ---- the evidence rail, beside every answer --------------------------
    // Only the HEADING is the page's. The field labels under it name the
    // engine's own contract fields and stay in the engine's language.
    'rail.rests': 'What this answer is based on',
    'rail.limits': '{n} {n|limit|limits} on this answer',
    'rail.limits.project': '(the project has {n})',
    'limit.topic.handler-link': 'how sure the handler link is',
    'limit.axis.note': '{axis}: one thing it did not see',
    'limit.scope.browse': 'about this list',
    'limit.scope.changed-files': 'changed files with no node in the graph',
    'limit.scope.coupling': 'about this sharing table',
    'limit.scope.endpoint_impact': 'about this list of APIs',
    'limit.scope.erd': 'about this diagram',
    'limit.scope.federation': 'calls into other projects',
    'limit.scope.flow': 'about this trace',
    'limit.scope.identifier-case': 'a name matched by the case rule',
    'limit.scope.map': 'about this map',
    'limit.scope.neighborhood': 'about this neighborhood',
    'limit.scope.overlay': 'what the working-tree view cannot see',
    'limit.scope.overview': 'about this overview',
    'limit.scope.pack-diff': 'the two packs may not be analyzed alike',
    'limit.scope.pack-diff:repository': 'not recorded as one repository',
    'limit.scope.rules': 'a rule that only classifies',
    'limit.scope.screen': 'how screens are counted',
    'limit.scope.screen_impact': 'about this list of screens',
    'limit.scope.summary:families': 'how the table families are made',
    'limit.scope.summary:groups': 'how the boxes on the left are made',
    'limit.scope.summary:lopsided': 'one group holds most of the routes',
    'limit.scope.summary:walk': 'walks cut by the node cap',
    'limit.scope.runtime-only-columns': 'columns decided at run time',
    'limit.topic.depth-cap': 'stopped at the depth limit',
    'limit.topic.walk-cap': 'a walk stopped at the node cap',
    'limit.topic.draw-cap': 'cut to fit the answer size',
    'limit.topic.walk-empty': 'the walk reached no SQL',
    'limit.topic.mode-floor': 'links this mode does not follow',
    'limit.topic.no-mode': 'links no mode follows',
    'limit.topic.handler-floor': 'the handler link is below this mode',
    'limit.topic.multi-handler': 'a route declared by several handlers',
    'limit.topic.route-address': 'how sure the route address is',
    'limit.topic.generated': 'steps inside generated code skipped',
    'limit.topic.walk-basis': 'what the counts rest on',
    'limit.topic.grouping': 'what a group is',
    'limit.topic.grouping-breaks': 'path groups do not fit this project',
    'limit.topic.no-code': 'no backend code in this pack',
    'limit.topic.no-frontend': 'no frontend in this pack',
    'limit.topic.other-project': 'results from another project',
    'limit.topic.no-meta': 'no pack metadata',
    'limit.topic.web-no-client': 'frontend calls traced to no client',
    'limit.topic.code-outside-roots': 'calls into a module that was not analyzed',
    'limit.topic.prisma-disagrees': 'schema.prisma and the SQL schema disagree',
    'rail.truncated': 'cut short:',
    // A CUT LIST IN THE READER'S WORDS (RM67-U2h): one label per field path a
    // tool can cut, read out of the engine by test/viewer_cut_labels.test.mjs.
    // The chip's title still names the path and its order.
    'rail.cutof': '{what} {shown} of {total}',
    'rail.cut.affected': 'affected nodes',
    'rail.cut.calledEndpoints': 'endpoints the frontend calls',
    'rail.cut.cells': 'grid cells',
    'rail.cut.columns': 'columns',
    'rail.cut.downstreamColumns': 'downstream columns',
    'rail.cut.edges': 'links',
    'rail.cut.edges.added': 'added edges',
    'rail.cut.edges.changed': 'edges with changed evidence',
    'rail.cut.edges.moved': 'moved edges',
    'rail.cut.edges.regraded': 'edges whose grade changed',
    'rail.cut.edges.removed': 'removed edges',
    'rail.cut.endpoints': 'endpoints',
    'rail.cut.endpointsTouched': 'endpoints above the change',
    'rail.cut.entries': 'rows to pick from',
    'rail.cut.families': 'table families',
    'rail.cut.federated': 'tables from connected projects',
    'rail.cut.gaps': 'what the analysis did not see',
    'rail.cut.grades': 'grades',
    'rail.cut.groups': 'groups',
    'rail.cut.hubs.endpoints': 'busiest APIs',
    'rail.cut.hubs.tables': 'busiest tables',
    'rail.cut.items': 'list rows',
    'rail.cut.links': 'map lines',
    'rail.cut.nodes': 'nodes',
    'rail.cut.nodes.added': 'added nodes',
    'rail.cut.nodes.changed': 'nodes with changed attributes',
    'rail.cut.nodes.moved': 'moved nodes',
    'rail.cut.nodes.removed': 'removed nodes',
    'rail.cut.pairs': 'writer and reader pairs',
    'rail.cut.projects': 'projects',
    'rail.cut.reach.samples.endpointsWithoutStatement': 'APIs that reach no SQL',
    'rail.cut.reach.samples.unreachedStatements': 'SQL no API reaches',
    'rail.cut.reach.samples.unreachedTables': 'tables no API reaches',
    'rail.cut.relationships': 'relationships',
    'rail.cut.rules': 'rules',
    'rail.cut.screens': 'screens',
    'rail.cut.screensTouched': 'screens above the change',
    'rail.cut.services': 'services',
    'rail.cut.sharedStatements': 'SQL many groups share',
    'rail.cut.statementTypes': 'kinds of SQL',
    'rail.cut.statements': 'SQL statements',
    'rail.cut.tables': 'tables',
    'rail.cut.transactions': 'transactions',
    'rail.cut.upstreamEndpoints': 'upstream endpoints',
    'rail.cut.webFunctions': 'frontend functions',
    'rail.cut.webSymbols': 'frontend code',
    'rail.trust.label': 'verification: {say}',
    'rail.trust.bare': 'verification:',
    'rail.trust.unknown': 'no trust level',
    'rail.fresh': 'freshness {verdict}',
    'rail.basis': 'what it was built from',
    'rail.trust': 'what the trust level rests on',
    'rail.row.project': 'project',
    'rail.row.digest': 'digest',
    'rail.row.built': 'built',
    'rail.row.freshness': 'freshness',
    'rail.row.level': 'level',
    'rail.row.axes': 'axes',
    'rail.row.gates': 'checks not shown',
    // ---- Overview hero: the four KPI dials -------------------------------
    // One card per step of the chain, drawn from `reach` — the very fields
    // the ribbon below the hero is drawn from. The label says what is being
    // counted; the `rest` line says what the number LEAVES OUT.
    'kpi.endpoints': 'endpoints that reach SQL',
    'kpi.statements': 'SQL statements reached',
    'kpi.tables': 'tables reached',
    'kpi.columns': 'columns reached',
    'kpi.screens': 'screens that reach a table',
    'kpi.rest.endpoints': '{n} {n|reaches|reach} no SQL',
    'kpi.rest.statements': '{n} nothing calls',
    'kpi.rest.tables': '{n} reached by no API',
    'kpi.rest.columns': '{n} nothing reaches',
    'kpi.rest.screens': '{n} {n|reaches|reach} none',
    // A project whose requests are ANSWERED SOMEWHERE ELSE (RM47). The dial
    // stays this project's own share, because that is what it measures; this
    // says the other number beside it, so "0 of 9 screens reach a table" cannot
    // be read as "this product's screens reach nothing".
    'kpi.fed': '{here} here, {there} in connected projects',
    // The router of this frontend is filled in by the server at run time, so
    // the screens in the pack are the ones the source states, not the ones the
    // product has. Said under the dial, because the dial is a share of a
    // denominator that is itself a lower bound.
    'kpi.screens.serverdriven': 'the server fills this router in at run time, so this counts the routes the source states',
    'kpi.notcollected': 'not collected',
    'kpi.limit.catalog': 'no database schema was read: these are the tables the SQL named',
    'kpi.limit.column': 'a lower bound: a column counts only where the SQL names it',
    'kpi.limit.degraded': 'only partly read, so this share is a lower bound',
    'kpi.limit.notshipped': 'not collected in this analysis',
    'kpi.limit.why': 'why, and what to set',
    'kpi.limit.routes': '{n} of {m} {m|route|routes} graded {grade}',
    'kpi.limit.routes.floor': '{n} of {m} {m|route|routes} graded {grade}: mode {mode} stops at them',
    'kpi.sources': 'tables and columns from {sources}',
    'kpi.limit.routes.title': 'how sure each route\'s own address is, as its analyzer graded it. A walk reads a route\'s link to its handler as the first link of the path, so a mode that does not admit that grade stops at the route. Click to see what the analysis could not read and what to declare to make it sure.',
    // ---- Overview hero: the cartography ----------------------------------
    'ov.grades.title': 'How sure the lines are',
    'ov.grades.note': 'the line style says how sure, the colour says what kind',
    // ---- Overview hero: the cascade ribbon -------------------------------
    'ribbon.title': 'How far the chain gets',
    'ribbon.note': 'Each bar is one step of the chain. The dark part reached a table through some API; the striped part didn\'t. The bands between bars show how much carries over to the next step. Read at mode={mode}, depth {depth}.',
    'ribbon.hover': 'Point at a bar to see what it counts.',
    'ribbon.lane.endpoints': 'endpoints',
    'ribbon.lane.statements': 'statements',
    'ribbon.lane.tables': 'tables',
    'ribbon.lane.columns': 'columns',
    'ribbon.reached': 'reached',
    'ribbon.unreached': 'not reached',
    'ribbon.say.endpoints': '{reached} of {total} {total|endpoint|endpoints} {reached|reaches|reach} a SQL statement. The other {rest} {rest|reaches|reach} none. They may touch no database at all, or we could not tell what one of their calls points to.',
    'ribbon.say.statements': '{reached} of {total} {total|statement|statements} {reached|is|are} reached from an endpoint. Nothing we analysed calls the other {rest}, which {rest|is|are} usually generated mapper {rest|method|methods}. That is a different thing from dead code.',
    'ribbon.say.tables': '{reached} of {total} {total|table|tables} {reached|is|are} reached from an endpoint. No endpoint reaches the other {rest}. Some statement may still write them; what is missing is the HTTP route above.',
    'ribbon.say.columns': '{reached} of {total} {total|column|columns} {reached|is|are} reached from an endpoint. Nothing reaches the other {rest}.',
    // ---- Explore tab ----------------------------------------------------
    'explore.edits': 'What my uncommitted edits touch',
    'explore.edits.title': 'what your uncommitted git changes would affect',
    'load.search': 'searching…',
    'load.edits': 'reading the changes in your working tree…',
    'load.source': 'loading source…',
    'edits.nonode': 'no node here, so we cannot say what it affects',
    'edits.readnofacts': 'read, and it makes no HTTP call',
    'edits.methods': 'methods you edited',
    'edits.web': 'frontend functions you edited',
    'edits.screens': 'screens those functions are drawn on',
    'edits.called': 'endpoints these frontend functions call',
    'edits.upstream': 'upstream endpoints affected',
    'edits.downstream': 'downstream columns affected',
    'edits.frontendcalls': '{n} frontend {n|call|calls}',
    'edits.frontendcalls.title': 'how many frontend functions call this route',
    // ---- Flow tab -------------------------------------------------------
    'load.flow': 'following the chain…',
    // ---- Flow / Impact side panels (both tabs draw with one function) ----
    // The grade NAMES beside these lines are the engine's and are printed as
    // they arrived; only the sentence explaining each one is the page's.
    'chain.legend.title': 'how to read the lines',
    'chain.legend.links': 'lines {links}, row badges {rows}',
    'chain.walk.note': 'followed {walked} {walked|node|nodes}, depth {depth}, mode {mode}',
    'chain.walk.other': ', plus {n} we reached that this picture has no place for',
    'chain.path.up': 'path up from the target',
    'chain.path.down': 'path down from the entry',
    // ---- Flow / Impact: the column headings and the captions inside one ---
    // A column is named for what it HOLDS. The two band captions say what a
    // grade means for the rows under them; the grade NAME beside each row is
    // the engine's and is relayed, so only these sentences are the page's.
    'chain.lane.entry': 'entry',
    'chain.lane.target': 'target',
    'chain.lane.services': 'service layer',
    'chain.lane.statements': 'mapper statement',
    'chain.lane.tables': 'table',
    'chain.lane.endpoints': 'endpoint',
    // The two lanes that live in the browser. They are drawn only where the
    // walk has them: a backend-only pack has no frontend, and an empty column
    // there would read as "no screen reaches this".
    'chain.lane.webFunctions': 'frontend function',
    'chain.lane.screens': 'screen',
    'card.kicker.up': 'Change impact, read from the pack',
    'card.kicker.down': 'Call chain, read from the pack',
    'card.question.up': 'If this changes, here is everything above it',
    'card.question.down': 'Called here, here is everything below it',
    'card.lane.statements': 'SQL statements',
    'card.lane.services': 'service methods',
    'card.lane.endpoints': 'API endpoints',
    'card.lane.webFunctions': 'frontend functions',
    'card.lane.screens': 'screens',
    'card.lane.tables': 'tables',
    'card.more': '+{n} more',
    'card.none': 'none reached',
    'card.shownOnly': '(grades of the {n} shown)',
    'card.links': 'links walked',
    'card.basis': '{project}, pack {digest}, built {built}, mode {mode}, depth {depth}, Cascade {version}',
    'card.worth': 'trust {trust}, {limits} {limits|limit|limits}, {cut} {cut|cut list|cut lists}',
    'chain.hop': 'hop {n}',
    'chain.band.candidate': 'candidate set ({n}): the real target is among these',
    'chain.band.candidate.stmt': 'reached through a candidate call ({n})',
    'chain.band.heuristic': 'guessed ({n}): check these',
    // ---- Flow / Impact: what a column says when it has nothing to show ----
    'chain.empty.notinaxis': 'What you picked is already on this side of the chain, so there is nothing to list here.',
    'chain.empty.nomode': 'Nothing here. {n} {n|connection is|connections are} decided at run time, or we could not tell what they point to, so no mode reaches them.',
    'chain.empty.bymode': 'Nothing here in {mode}. The line over the picture says why.',
    'chain.empty.switch': 'Switch to {mode}',
    'chain.left.title': 'What this mode did not follow',
    'chain.left.route': 'This route\'s own link to its handler is graded {grade}, so mode {mode} stops at the route.',
    'chain.left.say': 'Mode {mode} did not follow {n} {n|link|links} of a grade it does not admit',
    'chain.left.nomode': 'No mode walks these: they are decided at run time, or we could not tell what they point to.',
    'chain.left.fix': 'What the analysis could not read, and what to declare',
    // ---- one row per kind of diagnostic, however many there are (RM67) ----
    'diag.group.lead': '{n} in all',
    'diag.group.causes': '{k} different {k|reason|reasons}',
    'diag.examples': 'the first {n}, in full',
    'diag.examples.more': 'and {n} more like these',
    'diag.todo.SHARD_UNUSABLE': 'Nothing is lost: each of these was read again from its source, and the next run reuses what this run wrote. If it shows up on every run, check that the cache directory stays the same between runs.',
    'rail.resize.title': 'drag to make this list wider or narrower. Double-click to put it back.',
    // ---- Flow / Impact lanes: counts, folds, the strip and the find box (RM67) ----
    'chain.nums': '{shown} drawn, {fetched} fetched, {total} in all',
    'chain.nums.title': 'how many rows the walk found in this lane',
    'chain.more.fetch': 'fetch {n} more',
    'chain.more.fetch.title': 'ask for the next rows of this lane, in the walk\'s own order ({order})',
    'chain.fold.more': '{n} more',
    'chain.fold.more.title': '{n} {n|row is|rows are} folded here to keep this lane short. Click to show them all.',
    'chain.fold.more.what': 'click to show',
    'chain.fold.group.title': '{n} {n|row|rows} of {owner} at this hop and grade {n|is|are} folded into one. Click to open them.',
    'chain.fold.group.what': '{n} {n|row|rows}',
    'chain.strip.jump': 'go to this lane in the picture',
    'chain.strip.jump.cut': 'go to this lane in the picture. The walk stopped at depth {depth}, so this count is a floor: there may be more.',
    'chain.find.ph': 'find in this picture',
    'chain.find.title': 'find a row by name or id. A folded row that matches is opened, and Enter goes to the next one.',
    'chain.find.count': '{n} found',
    'chain.legend.path': 'A line shows the grade of that one link. The badge on a row is the weakest link on its way from the start, so a row can be weaker than the line into it. A line into a table carries the table\'s badge: the answer does not grade that last step alone.',
    'chain.cut': '{n} more {n|row|rows} here did not fit. ',
    'chain.cut.raise': 'Show more',
    'chain.folded': '{n} {n|node|nodes} at this hop {n|has|have} no row of their own: a mapper method is shown inside its statement.',
    'chain.derived.note': 'These {field} came from the edges of a node we had already reached, so no node of the walk sits at this hop.',
    'chain.norows': 'nothing at this hop',
    'chain.derived.label': 'read, not walked',
    'chain.derived.what': 'read, not walked: {n} {field} came from the edges of a node we had already reached.',
    'chain.hop.nodes': '{n} {n|node|nodes} at this hop',
    'chain.tag.runtime': 'columns at run time',
    'chain.nolayers': 'Nothing to group: this run reached nothing past the entry itself.',
    'chain.beyond': '{n} more {unit} {n|sits|sit} one hop past the depth limit. A node we reached names them, but we never went on to them, so they are under no hop below.',
    'chain.end.title': 'end of the chain: {field}',
    'chain.tag.handler.title': 'a route points at this method, so this is where the request enters the code',
    'chain.tag.ext.title': 'we never saw this type in the source, so it is a library or framework class',
    'chain.tag.runtime.title': 'the columns come from a condition built at run time. The table is certain; the column list is only what we could read.',
    // The frontend rows. A `component` function is declared in the file the
    // route mounts; an `api` function is in a module that file imports.
    'chain.tag.component': 'component',
    'chain.tag.component.title': 'this function is declared in the file the route mounts as its screen',
    'chain.tag.api': 'api',
    'chain.tag.api.title': 'this function is in a module the component imports, not in the component itself',
    // THE OBSERVED MARK, one word, wherever a capture reached. It began on the
    // screen-to-route axis a browser recording confirms, and a trace now marks
    // the service method and the SQL statement a request really ran through, so
    // the sentence names the capture rather than one of its two shapes. It is a
    // MARKER beside the grade and never a grade: a row without it was not
    // visited by that capture, which is a different thing from dead.
    'chain.tag.seen': 'seen',
    'chain.tag.seen.title': 'a recording of this system running saw this really happen. It stands beside the grade and never changes it, and nothing here was walked from it.',
    'chain.tag.address': 'address unsure',
    'chain.tag.address.own': 'This route\'s own address is a guess: {why}.',
    'chain.tag.address.catchall': 'The call was matched to a catch-all route; a more specific route of this project may answer the same address under a prefix set in code.',
    'chain.tag.address.shift': 'The call was matched only after dropping {dropped} from the front of its address.',
    'chain.tag.address.port.default': 'The call goes to this machine on a port no file states; that this project answers it rests on Spring Boot\'s default port, which whatever starts the app may change.',
    'chain.tag.address.port.unknown': 'The call goes to this machine on a port no file states, and the port of at least one application is not known, so whether this project answers it is not settled.',
    'chain.tag.address.fallback': 'The front of the URL is the literal an environment value falls back to, which runs only where nothing sets that value.',
    'chain.tag.address.host': 'Every build names a host that is not this machine; its path is read as this project\'s only because the two were analyzed together.',
    'chain.tag.address.alias': 'The base URL was read through an import alias the engine assumed.',
    'chain.tag.address.guess': 'The front of the URL rests on a guess: {guess}.',
    'chain.tag.frontend': 'web {n}',
    'chain.tag.frontend.title': 'how many frontend functions call this route',
    // A row from ANOTHER project. The server followed an HTTP call out of this
    // pack into a project it also serves, so the code below the badge lives in
    // a different deployable and answers to a different build.
    'chain.tag.project.title': 'this row is in another registered project, reached over an HTTP call out of this one',
    'chain.card.otherproject': 'This row is in {p}. This page shows one project at a time, so switch the selector to {p} to open its source or walk it further.',
    'chain.nosource': 'no source: we never saw this type in the code',
    // ---- Impact tab -----------------------------------------------------
    'load.impact': 'following the chain back to the endpoints…',
    // ---- the browse rail, on Explore, Flow and Impact --------------------
    // Every tab opens showing the PACK, not an empty box: a left column that
    // lists one kind of thing with the numbers you would pick by, and a search
    // box that filters that list instead of being the only way in. The rows,
    // the counts and the chips are all one `browse` answer; the page filters
    // what it already holds and asks for nothing while you type.
    'rail.browse': 'Browse',
    'rail.browse.title': 'open the list of things you can pick from',
    'rail.close': 'Close the list',
    // The rail's OWN empty state. A filter that matched none of the rows on
    // screen is the page's own doing, so it says so in the page's own words:
    // the engine's `not-shipped` / `none` belong to a list that was empty
    // before anybody typed, and borrowing one of those here would blame the
    // pack for a miss the filter made.
    'rail.filter.none': 'no row matches {q}',
    'rail.keys': '↑↓ move, Enter picks, / filters',
    'rail.count': '{n} shown of {m}',
    'rail.count.mode': 'counted in {mode}',
    'rail.count.mode.title': 'the numbers on these rows come from one walk of the whole project in this mode, the one on Trace\'s own control, so they count what the answer beside them walks.',
    'rail.more': 'show more',
    'rail.more.title': 'ask the server for the next 200 rows',
    // The chips: one per kind this tab can list, each with its own total.
    'rail.kind.table': 'Tables',
    'rail.kind.column': 'Columns',
    'rail.kind.statement': 'Statements',
    'rail.kind.endpoint': 'Endpoints',
    'rail.kind.symbol': 'Methods',
    'rail.kind.screen': 'Screens',
    'rail.kind.symbol.hint': 'Type two letters in the filter to list methods.',
    // The sort select. The default is the busiest-first one, so the first
    // screen of a list is the part of the project people actually work on.
    'rail.sort.title': 'what puts a row at the top of this list',
    'rail.sort.name': 'name',
    'rail.sort.path': 'path',
    'rail.sort.statements': 'statements',
    'rail.sort.endpoints': 'endpoints',
    'rail.sort.groups': 'API groups',
    'rail.sort.columns': 'columns',
    'rail.sort.reads': 'reads',
    'rail.sort.writes': 'writes',
    'rail.sort.tables': 'tables',
    // What the right-hand side says before anything is picked: one sentence,
    // and five rows off the top of the list already loaded.
    'rail.picks': 'Start with one of these',
    // A stat chip on a row says what its number counts.
    'rail.stat.statements.title': 'how many SQL statements touch this',
    'rail.stat.sql': 'SQL',
    'rail.stat.api': 'API',
    'rail.stat.scr': 'screens',
    'rail.stat.r': 'reads',
    'rail.stat.w': 'writes',
    'rail.stat.tbl': 'tables',
    'rail.stat.endpoints.title': 'how many endpoints reach this, following calls at mode={mode} with no depth cap',
    'rail.stat.groups.title': 'how many API groups reach this table',
    'rail.stat.tables.title': 'how many tables this reaches',
    'rail.stat.reads.title': 'how many SQL statements read this column',
    'rail.stat.writes.title': 'how many SQL statements write this column',
    'rail.stat.handlers.title': 'how many controller methods declare this route',
    'rail.stat.pk.title': 'this column is part of the primary key',
    'rail.stat.unresolved.title': 'part of this statement could not be resolved, so what it touches is a lower bound',
    'rail.stat.subst.title': 'this statement splices text into its SQL at run time, so it can run SQL we never saw',
    // The screen rows, and the screen count on a table or a column row. A
    // screen reaches a route by the SAME forward walk the Flow tab draws.
    'rail.stat.screens.title': 'how many screens reach this, following the frontend calls at mode={mode} with no depth cap',
    'rail.stat.screenapi.title': 'how many API routes this screen reaches, following the calls its own code makes',
    'rail.stat.screentables.title': 'how many tables this screen ends at',
    'rail.stat.seen': 'seen',
    'rail.stat.seen.title': 'a recording confirms the browser really made one of these calls from this screen',
    // Flow buckets its rows under the API group each endpoint belongs to.
    'rail.group.endpoints': '{n} {n|endpoint|endpoints}',
    'rail.group.reach': '{n} {n|reaches|reach} SQL',
    'rail.group.screens': '{n} {n|screen|screens}',
    'rail.group.reachapi': '{n} {n|reaches|reach} an API',
    // Flow can be walked from either end of the round trip, so its rail says
    // which end its list is of.
    // Impact opens a table into its own columns, one request per table.
    'rail.tree.title': 'show the columns of this table',
    'rail.tree.loading': 'loading the columns…',
    'rail.tree.failed': 'The columns could not be read: {message}',
    'rail.tree.retry': 'Try again',
    'rail.stat.grade.title': 'how sure this route\'s own address is: its analyzer could not read everything the address rests on',
    'rail.screens.none': 'No screen was collected in this analysis.',
    'rail.screens.fix': 'What we could not see, and what to set',
    // The masthead counts every endpoint node; this rail counts the ones the
    // pack SERVES. On jeecg that is 978 against 969, and two numbers on one
    // screen that do not match read as a bug until something connects them.
    'rail.count.outbound': '{n} served here; {m} more are addresses this project only calls',
    // ---- one way back ---------------------------------------------------
    // The same control on every tab that can narrow, at the right end of its
    // own toolbar, disabled while the tab already is its opening state.
    'btn.showall': 'Show all',
    'btn.showall.title': 'back to this tab as it opened: nothing picked, nothing filtered',
    'trace.showall': 'Start over: nothing picked',
    // ---- the source pane --------------------------------------------------
    // The picture is the claim and the source is the evidence, so the evidence
    // is read at reading size beside the claim: one pane for the whole page,
    // with the file's own line numbers and the lines the answer is about marked.
    'src.range': 'lines {from} to {to}',
    'src.range.of': 'lines {from} to {to} of {lines}',
    'src.copy.title': 'copy this path and line number',
    'src.copied': 'copied',
    'src.mode.title': 'the method or statement on its own, or the whole file around it',
    'src.mode.snippet': 'snippet',
    'src.mode.whole': 'whole file',
    'src.editor.title': 'which editor the button beside this opens the file in',
    'src.open': 'Open in editor',
    'src.open.title': 'open this file at this line in your editor',
    'src.copyabs': 'Copy path',
    'src.copyabs.title': 'copy the full path and line number, to paste where you like',
    'src.close': 'Close the source pane',
    'src.none': 'There is no source to show for this one.',
    'src.why': 'why this is in the answer:',
    'src.resize.title': 'drag to make this pane wider or narrower',
    // ---- Coupling tab ---------------------------------------------------
    'hint.coupling.lead': 'Two API groups that share data through the database without calling each other.',
    'hint.coupling.more': 'Two API groups can depend on each other without ever calling each other: one writes a column, the other reads it. This table shows those pairs. A group is the first segment of a route, which is a naming habit rather than a boundary anyone declared. Click a cell to see the columns or tables the two share.',
    'coupling.axis.title': 'what the two groups share',
    'coupling.axis.column': 'columns',
    'coupling.axis.table': 'tables',
    'coupling.depth.title': 'how many calls deep we follow each endpoint: all, or fewer to narrow it',
    'coupling.all': 'show all groups',
    'coupling.all.title': 'off: show only the groups that appear in a pair',
    'load.coupling': 'following every endpoint…',
    'err.coupling': 'error (sharing {axis}, mode={mode}, depth {depth}): {message}',
    'cp.empty.bymode': 'No coupling shows at mode={mode}. We left out {n} {n|connection|connections} of a grade this mode does not admit.',
    'cp.empty.switch': 'Try mode={mode}',
    'cp.empty.none': 'No group writes anything another group reads, {depth} calls deep.',
    'cp.empty.none.all': 'No group writes anything another group reads, however deep the calls go.',
    'depth.all': 'all',
    'depth.none': 'not capped',
    'cp.diag.title': '{group} writes and reads its own {unit}. One group on its own is not coupling, so it is counted apart.',
    'cp.pastcut': 'This pair did not fit the list, so its {unit} were not sent.',
    'cp.pairs.note': 'writer, then reader, ranked by how many {unit} they share. Click one for the list.',
    'cp.pairs.title': 'the {unit} these two share',
    'cp.viashared.tag.title': '{n} of them, on at least one side, {n|is|are} carried only by statements that three or more groups reach',
    'cp.viashared.note': 'On at least one side, only statements that three or more groups reach carry them. That much of this pair is fan-out, and may not be a link between these two groups.',
    'cp.detail.note': '{writer} writes {n} {unit} that {reader} reads.',
    // ---- Graph tab ------------------------------------------------------
    'hint.graph.map.lead': 'The whole project in one picture, from API groups to the tables they reach.',
    'hint.graph.map.more': 'A big node is an API group and a small one a table its endpoints reach; a line between two tables is a join the mapper SQL makes. Line colour is what the API does to the table, blue for reads and red for writes or deletes, and thickness is how many statements do it. Hover a node to preview what it touches, click to keep it lit and list its connections, double-click to open **Around <node>**. Scroll to zoom, drag to pan or to move a node, Escape clears.',
    'hint.graph.around.lead': 'Everything within a few hops of one node, drawn as rings around it.',
    'hint.graph.around.more': 'The node you picked sits in the middle, what touches it is on ring 1, and what touches those is on ring 2. Columns start hidden when the middle is a table or a statement, because they would be most of the picture, and the chip still counts them. Line colour is the access, blue for reads and red for writes or deletes. Click a node to list its connections, double-click to move it to the middle, Escape clears.',
    'graph.back': 'Back to the map',
    'graph.back.title': 'back to the whole-project map',
    'graph.focus.ph.map': 'find a group, an endpoint like GET /brand/list, or a table on the map…',
    'graph.focus.ph.around': 'a table, a column like pms_product.price, a statement, an endpoint, or a method as owner#name…',
    'graph.rend.title': '2D draws on a canvas. 3D draws the same graph in WebGL.',
    'graph.fit.title': 'Fit the whole map in view. Nothing refits itself once you have zoomed or panned.',
    'graph.mode.title': 'which links the map follows. strict: only proven links. conservative: also candidate sets, sure to hold the real target. heuristic: also guesses, to check.',
    'graph.mode.strict': 'strict',
    'graph.mode.conservative': 'conservative',
    'graph.mode.heuristic': 'heuristic',
    'graph.depth.title': 'how many calls deep we follow each endpoint: all, or fewer to narrow it',
    'graph.dir.title': 'which way to follow the lines',
    'graph.dir.up': 'up: what depends on it (towards endpoints)',
    'graph.dir.both': 'both',
    'graph.dir.down': 'down: what it reaches (towards columns)',
    'graph.hops.title': 'how many rings out from the middle',
    'graph.find': 'Find',
    'graph.fold.folded': 'folded',
    'graph.fold.endpoints': 'endpoints',
    'graph.fold.title': 'folded: one node per API group, with its endpoints counted inside it. endpoints: every endpoint drawn around its own group',
    'graph.flow.on': 'Flow on',
    'graph.flow.off': 'Flow off',
    'graph.flow.title.on': 'the dots run the way the call goes: group, then endpoint, then table. Click to stop them.',
    'graph.flow.title.off': 'the lines are still. Click to run the dots along them.',
    'graph.flow.rest': 'still at rest',
    'graph.flow.rest.title': 'a map this size turns to speckle with a dot on every line, so it stays still until you point at something. A node you light up flows on its own, and Flow on runs every line.',
    'graph.flow.quiet': 'flow: lit lines only. {directed} directed lines is more than the {max} this map animates at rest.',
    'graph.rend.fallback': '3D is unavailable here (no WebGL), so this is drawn in 2D',
    'graph.rend.fallback.title': 'the browser reported no WebGL, or the 3D bundle did not load',
    'graph.novendor': 'viewer/vendor/force-graph.min.js did not load, and the map needs it. Serve this page with `cascade view`, which publishes /vendor, or check the browser console for the request that failed.',
    'graph.norenderer': 'the map renderer did not load',
    'graph.empty': 'Pick a node above: a table, a column, a statement, an endpoint, or a method as owner#name.',
    'graph.nodecap.title': 'the answer was cut at the node limit',
    'graph.nodecap.say': 'node cap: {cut}',
    'graph.nodecap.endpoints': '{shown} of {total} {total|endpoint|endpoints}',
    'graph.nodecap.tables': '{shown} of {total} {total|table|tables}',
    'graph.nodecap.statements': '{shown} of {total} {total|statement|statements}',
    'graph.nodecap.screens': '{shown} of {total} {total|screen|screens}',
    'load.map': 'reading the map…',
    'load.around': 'reading the neighborhood…',
    // ---- Graph: the buttons every card offers -----------------------------
    'btn.flow.title': 'follow this call down to the tables',
    'btn.flow.screen.title': 'follow this screen down to the tables it ends at',
    // This route is served by ANOTHER project, so following it means going
    // there: the page switches project and draws the chain in the pack that
    // answers the call.
    'btn.flow.other.title': 'open this route in {p}, the project that serves it. The page switches to that project.',
    'btn.graph.screen.title': 'put this screen in the middle of the map',
    'btn.impact.title': 'which APIs would be affected if you changed this',
    'btn.impact.table.title': 'which APIs would be affected if you changed this table',
    'btn.erd.title': 'this table on the schema map',
    'btn.table.title': 'the SQL and the columns that touch this table',
    'btn.around.title': 'draw the rings around this node',
    'btn.recentre.title': 'put this node in the middle and draw its neighbors',
    // ---- the count line under a picture -----------------------------------
    // What the drawing SHOWS, counted. The numbers are the answer's, and the
    // node-cap note is the engine's own words, relayed there. The EDGE KINDS in
    // the brackets are named here: `aggregate` and `touches` are this picture's
    // vocabulary for what it drew, not a grade or a trust level, and a Korean
    // reader was being handed five English words in the middle of their own
    // sentence.
    'link.aggregate': 'aggregate',
    'link.calls': 'calls',
    'link.member': 'member',
    'link.touches': 'touches',
    'link.executes': 'executes',
    'link.joins': 'joins',
    'chip.kinds': 'show:',
    'chip.sql.on': 'SQL layer on ({n})',
    'chip.sql.off': 'SQL layer off',
    'chip.show.title': 'show the {n} {kind} {n|node|nodes}. The count stays either way.',
    'chip.hide.title': 'hide the {n} {kind} {n|node|nodes}. The count stays either way.',
    'chip.sql.on.title': 'turn the SQL layer off, so endpoints point straight at the tables again',
    'chip.sql.off.title': 'ask the engine again with the SQL layer on, so each mapper statement gets its own node',
    'chip.screens.on': 'screens on ({n})',
    'chip.screens.off': 'screens off',
    'chip.screens.on.title': 'turn the screens layer off, so this map is the server side alone',
    'chip.screens.off.title': 'ask the engine again with the screens layer on, so every screen that reaches a route gets its own node',
    'gcount.groups': '**{n}** {n|group|groups}',
    'gcount.endpoints': '**{n}** {n|endpoint|endpoints}',
    'gcount.tables': '**{n}** of {total} {total|table|tables} touched',
    'gcount.statements': '**{n}** SQL {n|statement|statements}',
    'gcount.screens': '**{n}** of {total} {total|screen|screens} {n|reaches|reach} a route',
    'gcount.links': '**{n}** {n|line|lines} drawn',
    'gcount.folded': '**{n}** {n|endpoint|endpoints} folded into {n|its group|their groups}',
    'gcount.unfolded': '**{n}** {n|endpoint|endpoints} in **{g}** open {g|group|groups}, **{n2}** still folded',
    'gcount.nodes': '**{n}** {n|node|nodes}',
    'gcount.ofanswer': 'the answer has {nodes} {nodes|node|nodes} and {links} {links|link|links}',
    'gcount.bykind': '{kind} {n}',
    'gcount.hops': '{hops} {hops|hop|hops}, direction {dir}',
    'gcount.hidden': '{kinds} hidden',
    'gcount.nodecap': 'node cap reached',
    'gcount.drawnin': 'drawn in {rend}',
    'gcount.drawnin.title': 'which renderer drew this picture',
    // ---- Graph map: the legend, and the card beside the picture ----------
    // The dashed-line row NAMES a grade, so the grade itself is a parameter the
    // engine's vocabulary fills; the catalogue never spells one out.
    'mapleg.nodes': 'nodes:',
    'mapleg.lines': 'lines:',
    'mapleg.group': 'group',
    'mapleg.endpoint': 'endpoint',
    'mapleg.table': 'table',
    'mapleg.statement': 'statement',
    'mapleg.screen': 'screen',
    'mapleg.member': 'group → endpoint',
    'mapleg.reads': 'reads',
    'mapleg.writes': 'writes / deletes',
    'mapleg.join': 'table join',
    // The legend now stands INSIDE the canvas, so it has one row to say
    // everything in. The dashed swatch keeps its name and puts the sentence
    // that explains it one hover away.
    'mapleg.dashed': 'dashed = {grade}',
    'mapleg.dashed.title': '{grade}: a candidate set sure to hold the real target. Drawn dashed on the 2D canvas only.',
    'mapleg.grade.title': '{grade}: the dash pattern shows it',
    'map.lead.title': 'the whole project',
    'map.lead.brief': 'Every API group, the endpoints under it, and the tables those endpoints reach.',
    'map.lead.body': 'Every API group, the endpoints under it, and the tables those endpoints reach. A group is the first segment of a route, which is a naming habit rather than a module anyone declared. Click a node to keep it lit and list its connections here, or double-click to open it on its own.',
    // WHAT THE NUMBER BESIDE EACH TABLE IS depends on whether the map is
    // folded, so the heading says which: folded, a table's number is the API
    // groups that reach it; unfolded, it is the endpoints. Same list, two
    // different measurements, and a rank nobody can read is worse than none.
    'map.lead.tables': 'tables, by API groups reaching them',
    'map.lead.tables.open': 'tables, by endpoints reaching them',
    'map.lead.groups': 'largest groups',
    'map.lead.chip.title': '{id}, {degree} {degree|connection|connections} drawn',
    'map.lead.unreached': 'In {mode}, {n} of the {total} {total|table|tables} here {n|is|are} on no endpoint\'s line, so they are not drawn. They are in the schema, and nothing this mode walks reaches them.',
    'map.lead.allreached': 'every table in this project is reached from an endpoint.',
    // ---- the map's tooltip and the card beside it -------------------------
    // Everything a reader hovers or clicks used to be written in English inside
    // a Korean page: the tooltip's clauses, the card's heading, its buttons and
    // every list heading under it. Each is a sentence, so each is a key.
    'tip.endpoints': '{n} {n|endpoint|endpoints}',
    'tip.groupnote': 'An API path prefix, which is a naming habit.',
    'tip.connections': '{n} {n|connection|connections} drawn',
    'tip.columns': '{n} {n|column|columns}',
    'tip.ingroup': 'group {g}',
    'tip.screenapi': '{n} {n|route|routes} reached',
    'tip.screentables': '{n} {n|table|tables} at the end',
    'tip.seen': 'a recording confirms a call from this screen',
    'map.card.head': '{kind}, {n} {n|connection|connections}',
    'map.card.clear': 'Clear',
    'map.card.group': 'groups ({n})',
    'map.card.screen': 'screens ({n})',
    'map.card.endpoint': 'endpoints ({n})',
    'map.card.statement': 'statements ({n})',
    'map.card.table': 'tables ({n})',
    'map.card.stmt': '{n} {n|statement|statements}',
    'map.card.more': 'and {n} more of this kind. The picture has them all.',
    'map.gone': 'That node is not on the map any more. A chip hid its kind.',
    'map.group.note': 'the first segment of a route. It is a naming habit, not a boundary anyone declared.',
    'around.hop.title': 'how many hops it took to reach this node',
    'around.unreached.title': 'nothing in this slice reaches it, so it waits on the ring outside the last hop we measured',
    'around.noedge': 'no line in this slice touches it',
    // ---- ERD tab --------------------------------------------------------
    'hint.erd.lead': 'The whole schema, laid out by the joins the mapper SQL makes between tables.',
    'hint.erd.more': 'A line here is a join some SQL statement makes, not a foreign key: we do not read constraints. A bigger table has more relationships, and a thicker line means more statements make that join. The legend groups tables into families by the words their names start with, the same families the map on Start draws, which is a naming habit rather than a declared boundary. Click a table to light it and its neighbors, scroll to zoom, and drag a node to pin it.',
    'erd.find.ph': 'find a table to highlight… (Enter)',
    'erd.reset': 'Reset view',
    'load.erd': 'loading the ERD…',
    // ---- ERD: the stats line above the canvas -----------------------------
    // `erdleg.hublabels` is the disclosure that goes with the label rule: past
    // the drawn-table cap only the busiest tables are named, and a reader must
    // not read an unnamed rectangle as a table with nothing to say.
    'erdleg.drawn': '**{n}** tables drawn',
    'erdleg.rels': '**{n}** relationships',
    'erdleg.nojoin': '**{n}** joined to nothing',
    'erdleg.hublabels': 'names on the {n} busiest {n|table|tables}',
    'erdleg.hublabels.some': 'names on {m} of the {n} busiest {n|table|tables}',
    'erdleg.somelabelled': '{m} of {n} {n|table|tables} named',
    'erdleg.thickness': 'line thickness: 1 to {n} {n|statement|statements}',
    'erdleg.thickness.title': 'the line gets thicker the more statements make that join',
    'erdleg.prefixes': 'table families:',
    'erdleg.prefixes.title': 'tables whose names start with the same words, read the way the map on Start reads them. It is a naming habit, not a boundary we found in the code.',
    'erdleg.noprefix': '(no family)',
    'erdleg.nogroups': 'no table name here has a word to group by',
    // ---- ERD side panels and the strip under the canvas -------------------
    'erd.side.map': 'whole-schema map',
    'erd.side.map.brief': '{tables} {tables|table|tables}, {relationships} {relationships|relationship|relationships}.',
    'erd.side.map.body': 'A bigger table has more relationships, and a thicker line means more statements make that join. Click a table to light it up.',
    'erd.side.map.isolated': '{n} of them {n|joins|join} to nothing in the SQL. They are in the strip under the map.',
    'erd.side.hubs': 'hub tables',
    'erd.side.hubs.by': '(by relationships)',
    'erd.side.rels': 'relationships',
    'erd.side.rels.none': 'no SQL here joins this table to another',
    'erd.side.cols': 'columns',
    'erd.side.cols.loading': 'loading…',
    'erd.side.count': '({n})',
    'erd.side.clear': 'Clear',
    'erd.side.family': 'family {name}',
    'erd.card.title': 'we work this out from which side joins on a primary key',
    'erd.iso.title': 'joined to nothing',
    'erd.iso.count': '({n} {n|table|tables})',
    'erd.iso.brief': 'No SQL joins these tables to anything, so we can’t place them on the map. They’re still in the schema.',
    'erd.iso.body': 'That does not mean they stand alone. A join written in Java, or one no statement we read makes, leaves no trace here.',
    // ---- Transactions tab ------------------------------------------------
    'summary.loading': 'walking every route in the project…',
    'summary.rule.declared': 'Modules are handler packages cut to {n} {n|segment|segments}, as the profile declares. The header counts the same ones.',
    'summary.rule.code': 'Code areas are where the handler code sits, below {prefix}. They are not modules anyone declared, nor the API groups the header counts by path.',
    'summary.rule.path': 'Path areas are route path segments below {prefix}. The API groups the header counts stop at the first segment.',
    'summary.rule.words': 'Families are tables whose names start with the same word, below {prefix}.',
    'summary.rule.letters': 'Families are tables whose names start with the same letters, below {prefix}.',
    'summary.group.sub': '{routes} {routes|route|routes} → {tables} {tables|table|tables}',
    'summary.family.sub': '{tables} {tables|table|tables}',
    'summary.family.sub.routes': '{tables} {tables|table|tables}, {routes} {routes|route reaches|routes reach} it',
    'summary.others.groups': '{n} {nouns} with fewer routes, {routes} {routes|route|routes}',
    'summary.others.families': '{n} {n|family|families} fewer routes reach, {tables} {tables|table|tables}',
    'summary.link.title': '{routes} {routes|route|routes} → {tables} {tables|table|tables}, weakest grade {grade}',
    'summary.pick': 'Open a box to see its routes and tables. Pick one to keep only the lines through it; its button goes straight into Trace.',
    'hint.compare.lead': 'What changed in this project since an earlier build of it, as one report.',
    'hint.compare.more': 'Every certified analyze keeps the pack it replaces, and this tab compares the pack on screen with one of those, as one report to read from the top. Read the conditions first: a difference is a code change only when both builds were analyzed the same way. A changed attribute or evidence is shown with its value before and after, and a move in the source is listed apart. Print it or save it as Markdown from the buttons under the title; for any other commit, `cascade diff --base-commit <rev>` builds the base.',
    'compare.base.label': 'compare with an earlier build of this project',
    'compare.base.title': 'a build this project\'s pack history kept: it is the base, and the pack on screen is the head',
    'compare.none': 'this project has no earlier build kept yet',
    'compare.build': 'commit {commit}, built {built}',
    'compare.dirty': '(with uncommitted changes)',
    'compare.loading': 'comparing the two packs…',
    'compare.error': 'The comparison could not be made',
    'compare.base': 'base',
    'compare.head': 'head',
    'compare.report.title': 'Change report: {project}',
    'compare.report.basis': 'What is here is the recorded graph change between the two packs: not every change in the source, and no verdict on behavior or risk.',
    'compare.side': 'commit {commit}, built {built}, pack {digest}',
    'compare.side.nocommit': 'no commit recorded',
    'compare.print': 'Print',
    'compare.print.title': 'print this report as it stands on screen, every fold opened',
    'compare.download': 'Save as Markdown',
    'compare.download.title': 'write this report, from the answer on screen, as a Markdown file',
    'compare.filter.placeholder': 'filter the rows: an id, a route, a field name',
    'compare.filter.title': 'a row that does not carry the text is hidden; the totals in the headings stay whole',
    'compare.filter.count': '{shown} of {total} {total|row|rows} {shown|carries|carry} the text',
    'compare.conditions.same': 'Both packs were analyzed the same way',
    'compare.conditions.different': 'The packs were not analyzed the same way, so a difference below may come from the analysis',
    'compare.conditions.unknown': 'Not every analysis condition is recorded, so it cannot be said the packs were analyzed the same way',
    'compare.unknown': 'not recorded:',
    'compare.limits': 'Read before the counts',
    'compare.legacy': 'This server compared ids and grades only: node attributes and edge evidence were not compared, so a changed value is not in this report.',
    'compare.cut': '{field}: {shown} of {total} {total|row|rows} {shown|is|are} shown; the total is whole',
    'compare.summary': 'Summary',
    'compare.sum.content': 'Content',
    'compare.sum.content.v': '{added} {added|node|nodes} added, {removed} removed, {changed} with a changed attribute',
    'compare.sum.relations': 'Relationships',
    'compare.sum.relations.v': '{added} {added|edge|edges} added, {removed} removed',
    'compare.sum.evidence': 'Evidence',
    'compare.sum.evidence.v': '{regraded} {regraded|edge|edges} changed grade, {changed} changed what the evidence says',
    'compare.sum.location': 'Source location only',
    'compare.sum.location.v': '{nodes} {nodes|node|nodes} and {edges} {edges|edge|edges} moved in the source and mean the same',
    'compare.notcompared': 'not compared by this server',
    'compare.bykind': 'by kind',
    'compare.bytype': 'by edge type',
    'compare.legend': '+ added, - removed, ~ grade changed, * attribute or evidence changed, > moved in the source only',
    'compare.empty.samepack': 'The base and the head are the same pack',
    'compare.empty.same': 'The two packs record the same graph',
    'compare.empty.moved': 'Only source locations differ: {nodes} {nodes|node|nodes} and {edges} {edges|edge|edges} moved and mean the same',
    'compare.empty.legacy': 'Nothing was added, removed or regraded; attributes and evidence were not compared by this server',
    'compare.empty.note': 'Read the conditions above before taking this as no change: a pack analyzed another way can hide one.',
    'compare.endpoints': 'Endpoints above the change ({n})',
    'compare.screens': 'Screens above the change ({n})',
    'compare.ends.note': 'Read from both packs: above what was added in the head, above what was removed in the base, and above what changed or was regraded in either. A move in the source adds nothing here.',
    'compare.ends.gone': 'earlier build only',
    'compare.ends.new': 'new in this build',
    'compare.ends.unknown': 'not known to be in this build',
    'compare.check': 'What to check',
    'compare.check.conditions': 'The two packs are not known to be analyzed the same way: read the conditions panel, and analyze both the same way before reading a difference as a code change.',
    'compare.check.cut': 'A list is cut at the limit the page asks for. The totals are whole; the cascade diff command, with --limit set to at least that total, prints the rest.',
    'compare.check.ends': 'Open each of the {n} {n|endpoint|endpoints} and {m} {m|screen|screens} above the change with Flow and read the chain under it.',
    'compare.check.gone': '{n} of them are in the earlier build only: what called them from outside this project is not in the graph.',
    'compare.check.content': 'Read the {n} changed attribute {n|record|records} value by value: a column type, a transaction marker or a handler is a code change wherever it is used.',
    'compare.check.evidence': 'For the {n} {n|edge|edges} whose evidence changed, the relation is the same and what the engine read from the source is not: check the source it names.',
    'compare.check.regraded': '{n} {n|edge|edges} changed grade: the same relation is known with more or less certainty than before.',
    'compare.check.moved': '{n} {n|record|records} moved in the source only: the graph means the same, and nothing above them is counted as touched. A moved statement or handler can still deserve a look in the file diff.',
    'compare.check.legacy': 'This server did not compare attributes or evidence: a changed value can be missing from this report.',
    'compare.check.always': 'This report is the recorded graph change and nothing more: a change in a body the graph does not record, and any runtime behavior, is outside it.',
    'compare.changed': 'Changed attributes ({n})',
    'compare.changed.note': 'The same node, with a recorded attribute that reads differently. Every attribute is compared except the source location.',
    'compare.edges.changed': 'Changed evidence ({n})',
    'compare.edges.changed.note': 'The same relation, with evidence that reads differently. Duplicate records are kept as they are, base and head.',
    'compare.moved': 'Moved nodes ({n})',
    'compare.moved.note': 'Only the file, line or declaration position differs. The graph means the same, and nothing above these is counted as touched.',
    'compare.edges.moved': 'Moved edges ({n})',
    'compare.edges.moved.note': 'Only the source location fields of the evidence differ. A grade change on the same relation, if there is one, is listed under the edges whose grade changed.',
    'compare.meta': 'Answer metadata: basis and trust, as the engine gave them',
    'compare.meta.note': 'The basis and the trust of the answer this report was written from, exact and complete. The limits have their own panel above.',
    'compare.value.missing': '(not recorded)',
    'compare.field.location': '(source location)',
    'compare.records.lead': 'records: base {base}, head {head}',
    'compare.added': 'Added nodes ({n})',
    'compare.removed': 'Removed nodes ({n})',
    'compare.axis': 'the {axis} axis changed between the packs',
    'compare.edges.added': 'Added edges ({n})',
    'compare.edges.removed': 'Removed edges ({n})',
    'compare.edges.regraded': 'Edges whose grade changed ({n})',
    'compare.omitted': 'Rows not shown',
    'compare.omitted.none': 'Every row of every list is in this file.',
    'compare.cut.row': '{shown} of {total} shown, in {order} order',
    'compare.md.trust': 'trust level',
    'compare.md.raw': 'built at {built}, with uncommitted changes {dirty}',
    'compare.md.foot': 'Written from the pack_diff answer on screen, with the limit the page asks for (200 rows per list). Recorded graph change only: not every source change, and no verdict on behavior or risk.',
    'hint.tx.lead': 'Each `@Transactional` method is one commit, and this is what it can touch.',
    'hint.tx.more': 'Everything a `@Transactional` method reaches is written and read inside the same commit. A wide footprint across many tables is where one change ripples furthest. Click a transaction to see its columns and its source.',
    'load.tx': 'loading transactions…',
    // ---- RM67-U2c: five places, Start, the map, Analysis status ---------
    'tab.start': 'Start',
    'tab.structure': 'Structure',
    'tab.status': 'Analysis status',
    'tab.status.view': 'Scope and gaps',
    'hint.start.lead': 'Pick one thing, then ask what breaks if it changes or how far it reaches.',
    'hint.start.more': 'The box finds any API, screen, table, column, SQL statement or method. Each question opens Trace on that target, walked the way the question asks, and a question the target cannot answer says why. Under the questions are what this analysis can see and the gaps that change an answer, then the map of the whole pack, for when you have no target yet. The shares and the busiest lists come after the map, counted in the mode its control sets.',
    'start.ask.title': 'Ask about one thing',
    'start.entry.ph': 'find an API, screen, table, column, SQL or method (/ jumps here)',
    'start.picked': 'target',
    'start.clear': 'clear',
    'start.q.up': 'What breaks if I change it?',
    'start.q.up.sub': 'Follows {id} up to the code, APIs and screens that reach it.',
    'start.q.up.none': 'Pick a target above, or open the list of tables and pick one there.',
    'start.q.down': 'How far does it reach?',
    'start.q.down.sub': 'Follows {id} down through the code it runs to the tables at the end.',
    'start.q.down.none': 'Pick a target above, or open the list of APIs and pick one there.',
    'start.q.status': 'What did the analysis not see?',
    'start.q.status.sub': 'The inputs it did not have, what it could not read, and what to do about each.',
    'start.q.status.count': '{n} {n|thing|things} it could not see; {k} of them can change an answer.',
    'start.scope.title': 'What this analysis can see',
    'start.scope.lanes': 'read by',
    'start.scope.mode': 'counted in',
    'start.scope.mode.value': 'mode {mode}, depth {depth}, following {grades} links',
    'start.axis.from': 'from {src}',
    'start.gaps.title': 'Gaps that change an answer',
    'start.gaps.lead': 'What the analysis did not have or could not read. An answer that runs through one of these is shorter or less sure than it looks.',
    'start.gaps.none': 'Nothing the analysis was missing changes an answer here.',
    'start.gaps.more': 'and {n} more',
    'start.gaps.all': 'All {n} on Analysis status',
    'start.kpi.mode': 'The shares and the busiest lists below are counted in {mode}, depth {depth}.',
    'start.lead.routes': '{say}. Nothing on this page reaches SQL in this mode until their address is sure.',
    'start.lead.none': 'In {mode}, no API reaches a SQL statement. The gaps below say what the analysis could not read.',
    'start.lead.looking': 'The map, the shares and the busiest lists are counted in {mode} now. The gaps and Analysis status stay in {from}.',
    'start.lead.back': 'Back to {mode}',
    'summary.title': 'The map: which code reaches which tables',
    'summary.mode.title': 'which links the walks follow: this moves the map, the shares and the busiest lists below it together',
    'summary.rule.lane': 'API groups are the first segment of a route below the prefix the application is deployed under, the same ones the header counts.',
    'summary.crumb.all': 'Whole map',
    'summary.crumb.group': '{noun} {name}',
    'summary.crumb.family': 'family {name}',
    'summary.crumb.title': 'where you are on the map',
    'summary.none.routes': 'This project has no route, so there is no map to draw.',
    'summary.none.floor': 'No route reaches a table in mode {mode}. The walks left {n} {n|link|links} graded {grades} out, below this mode\'s floor.',
    'summary.none.tables': 'No route reaches a table in mode {mode}.',
    'summary.box.open': 'open this box in place: only its lines stay',
    'summary.box.close': 'close this box and go back to the whole map',
    'summary.rows.all': 'show all {n}',
    'summary.row.title': '{id}: pick it to see only the lines through it',
    'summary.through.route.title': '{n} {n|table|tables} this route reaches in this family, weakest grade {grade}',
    'summary.through.table.title': '{n} {n|route|routes} of this {noun} {n|reaches|reach} this table, weakest grade {grade}',
    'summary.totals': '{routes} {routes|route|routes} in {groups} {nouns} {routes|reaches|reach} {tables} {tables|table|tables} in {families} {families|family|families}.',
    'summary.box.group.lead': 'The families this {noun}\'s routes reach. Open one to see which of its tables.',
    'summary.box.family.lead': 'The {nouns} whose routes reach this family. Open one to see which of its routes.',
    'summary.link.row': '{routes} {routes|route|routes} → {tables} {tables|table|tables}',
    'summary.link.label': '{routes} → {tables} {tables|table|tables}',
    'summary.box.none': 'No line runs through this box in this mode.',
    'summary.through.loading': 'finding the paths through it…',
    'summary.through.none.route': 'This route reaches no table in mode {mode}.',
    'summary.through.none.table': 'No route reaches this table in mode {mode}.',
    'summary.through.route.lead': 'The families this route reaches in mode {mode}, with the tables in each.',
    'summary.through.table.lead': 'The {nouns} whose routes reach this table in mode {mode}, with those routes.',
    'summary.through.tables': '{n} {n|table|tables}',
    'summary.through.routes': '{n} {n|route|routes}',
    'summary.members.more': '{n} more',
    'hint.status.lead': 'What this analysis could and could not see, and what to do about each gap.',
    'hint.status.more': 'Every row here comes from the one `overview` answer Start is drawn from. A blind spot is set out by what you can do about it: an input to give, something to declare, a wider walk, or a place worth a look. The limits that change one answer are also said beside that answer on Trace. Rules, the framework knowledge the analysis ran with, is this place\'s second view.',
    'status.fresh.title': 'How fresh',
    'status.fresh.unknown': 'not compared with your working tree',
    'status.fresh.built': 'built {built} from commit {commit}, digest {digest}',
    'status.trust.title': 'Verification',
    'status.trust.none': 'no trust level',
    'status.trust.how': 'How to change this',
    'status.census.title': 'How it was counted',
    'status.census.mode': 'mode {mode}, depth {depth}',
    'status.census.lead': 'Every share on Start and every count here follows only {grades} links, from each route down.',
    'status.axes.title': 'The axes: what was read, and from where',
    'status.axes.lead': 'An axis is one kind of thing the analysis reads. One it did not collect, or read only in part, changes every answer that needs it.',
    'status.axes.none': 'This pack states no axes.',
    'status.axes.col.axis': 'axis',
    'status.axes.col.state': 'state',
    'status.axes.col.from': 'read from',
    'status.axes.col.touch': 'what it changes',
    'status.axis.ok': 'collected',
    'status.axis.part': 'only partly read',
    'status.axis.none': 'not collected',
    'ov.axis.name.jpa': 'JPA mappings',
    'ov.axis.name.mybatisPlus': 'MyBatis-Plus mappings',
    'status.axis.touch.catalog': 'The ERD\'s lines, the columns a SELECT * reads, and which table a bare column name belongs to.',
    'status.axis.touch.statements': 'Every walk that ends in SQL, and every table and column a walk reaches.',
    'status.axis.touch.column': 'Which columns a statement reads and writes, and so every column\'s impact.',
    'status.axis.touch.code': 'Every route, service and transaction. Without it no walk starts from an API.',
    'status.axis.touch.web': 'Which frontend functions call which API, and so every walk up to a screen.',
    'status.axis.touch.screen': 'Which screens call which API, and every screen count.',
    'status.axis.touch.jpa': 'The tables and columns an entity or a repository names, and how sure they are.',
    'status.axis.touch.mybatisPlus': 'The tables and columns a generic CRUD call reaches, and how sure they are.',
    'status.gaps.lead': 'Each row says its cause in plain words, what it touches, and what to do. The engine\'s own sentence is under the cause, folded.',
    'status.cause': 'cause',
    'status.touches': 'touches',
    'status.todo': 'what to do',
    'remedy.label': 'What to do',
    'remedy.declare': 'Declare {key} in the profile, for example {example}.',
    'remedy.flag': 'Analyze again with {example}.',
    'remedy.run': 'Run {command}.',
    'remedy.mode': 'Ask again in mode {mode}.',
    'remedy.none': 'No fix the engine knows of. It can only say what it could not read.',
    'status.kind.title': 'the engine\'s own name for this kind',
    'status.engine.words': 'the engine\'s own words',
    'status.cause.floor': 'cause: {n} {n|link|links} {mode} does not follow',
    'status.diags.title': 'What the analyzers warned about',
    'status.diags.lead': 'One row per kind, said in plain words. The engine\'s own sentences are under each, folded, with how many there are and how many differ.',
    'status.diags.none': 'No analyzer warned about anything.',
    'diag.todo.any': 'Each line names what it could not read, and most name the setting to declare.',
    'diag.title.AMBIGUOUS_CATALOG_SOURCE': 'several schema files, none picked',
    'diag.title.AMBIGUOUS_GATEWAY_ROUTE': 'two gateway routes claim one prefix',
    'diag.title.DISCOVERY_CAPPED': 'only part of the tree was searched for the app',
    'diag.title.FILE_CAP_REACHED': 'the file count cap was reached',
    'diag.title.MAPPER_STATEMENT_DECLARED_TWICE': 'mapper methods with SQL in two places',
    'diag.title.MAPPER_VENDOR_UNMATCHED': 'a mapper written only for another database',
    'diag.title.MISSING_INPUT': 'an input the analysis needed is missing',
    'diag.title.PATH_PREFIX_UNUSED': 'a declared path prefix fits no route',
    'diag.title.PIN_MOVED': 'the repository moved past its pinned commit',
    'diag.title.PREFIX_NOT_ON_CALLS': 'a prefix the frontend\'s calls do not carry',
    'diag.title.PRISMA_CATALOG_DISAGREES': 'schema.prisma and the SQL schema disagree',
    'diag.title.REPOSITORY_WITHOUT_HEAD': 'a git repository with no commit',
    'diag.title.SETTING_IN_CODE': 'a setting written in code, not in configuration',
    'diag.title.SHARD_CORRUPT': 'a cache file was damaged',
    'diag.title.SHARD_UNUSABLE': 'a cache file could not be reused',
    'diag.title.SNAPSHOT_PROVENANCE_STALE': 'a schema snapshot changed since it was recorded',
    'diag.title.TS_APPS_FOUND': 'several NestJS apps in the tree',
    'diag.title.TS_APP_NOT_FOUND': 'no NestJS app found',
    'diag.title.TS_BINDING_NOT_READ': 'a provider binding the engine does not read',
    'diag.title.TS_CONTROLLER_UNREAD': 'a controller not read',
    'diag.title.TS_DISPATCH_INCOMPLETE': 'calls whose target classes may be more',
    'diag.title.TS_FILES_LEFT_OUT': 'TypeScript files found and not read',
    'diag.title.TS_MODULE_IMPORT_UNREAD': 'a module import not read',
    'diag.title.TS_MODULE_UNREAD': 'a module\'s options not read',
    'diag.title.TS_ONE_APP': 'only one TypeScript app is read',
    'diag.title.TS_PREFIX_DECLARED': 'the profile\'s API prefix differs from the code\'s',
    'diag.title.TS_PREFIX_EXCLUDE_UNREAD': 'unread setting: API prefix exclude list',
    'diag.title.TS_PREFIX_UNREAD': 'unread setting: API prefix',
    'diag.title.TS_PRISMA_CALL_UNREAD': 'Prisma calls on a client not known to be one',
    'diag.title.TS_ROOT_MODULE_UNREAD': 'the root module not read',
    'diag.title.TS_ROUTER_MODULE_UNREAD': 'router module paths not read',
    'diag.title.TS_ROUTES_WITHOUT_CONTROLLER': 'routes on a class that is no controller',
    'diag.title.TS_SYMBOL_SHARED_WITH_WEB': 'functions both analyzers read',
    'diag.title.TS_TYPEORM_CALL_UNREAD': 'TypeORM calls that make no statement',
    'diag.title.TS_TYPEORM_MAPPING_UNREAD': 'part of the entity mapping not read',
    'diag.title.TS_TYPEORM_NAMING_ASSUMED': 'TypeORM naming taken from the profile',
    'diag.title.TS_TYPEORM_NAMING_DECLARED': 'TypeORM naming taken from the profile',
    'diag.title.TS_TYPEORM_RECEIVER_UNREAD': 'TypeORM calls on an unknown receiver',
    'diag.title.TS_TYPEORM_TABLE_MISSES_DDL': 'TypeORM tables the DDL does not have',
    'diag.title.TS_VERSIONING_UNREAD': 'unread setting: API versioning',
    'diag.title.UNREADABLE_DIRECTORY': 'a directory that could not be listed',
    'diag.title.UNREADABLE_FILE': 'a file that could not be read',
    'diag.title.UNREADABLE_INPUT': 'an input that could not be read',
    'diag.title.BAD_DIALECT': 'a SQL dialect this engine cannot route',
    'diag.title.BAD_IDENTIFIER_CASE': 'an identifier rule this engine cannot apply',
    'diag.title.CATALOG_ALTER_TABLE_UNNAMED': 'ALTER statements with no readable table name',
    'diag.title.CATALOG_ALTER_UNKNOWN_COLUMN': 'changes to a column the table does not have',
    'diag.title.CATALOG_ALTER_UNKNOWN_TABLE': 'changes to a table no file declared before',
    'diag.title.CATALOG_ALTER_UNREADABLE': 'ALTER or RENAME statements not read',
    'diag.title.CATALOG_CLAUSE_NOT_HELD': 'ALTER clauses the catalog does not hold',
    'diag.title.CATALOG_COLUMN_ADDED_TWICE': 'a column added where the table already has it',
    'diag.title.CATALOG_COLUMN_READ_FAILED': 'columns that failed to read',
    'diag.title.CATALOG_COLUMN_UNNAMED': 'columns with no name as the grammar reads them',
    'diag.title.CATALOG_CONNECTION_FOUND': 'a database connection found in the configuration',
    'diag.title.CATALOG_CONSTRAINT_DISABLED': 'disabled constraints, left unread',
    'diag.title.CATALOG_CREATE_CLAUSE_NOT_HELD': 'parts of CREATE TABLE the catalog does not hold',
    'diag.title.CATALOG_CREATE_TABLE_UNREAD': 'CREATE TABLE read only as part of another statement',
    'diag.title.CATALOG_CREATE_TABLE_UNREADABLE': 'CREATE TABLE statements the schema reader could not read',
    'diag.title.CATALOG_FILE_NOT_PARSED': 'a schema file read with its errors skipped',
    'diag.title.CATALOG_FILE_NOT_TOKENIZED': 'a schema file that could not be read whole',
    'diag.title.CATALOG_FILE_PART_NOT_HELD': 'schema file parts skipped, none the catalog holds',
    'diag.title.CATALOG_IF_EXISTS_ABSENT': 'IF EXISTS changes to a column that is not there',
    'diag.title.CATALOG_MODIFY_UNSAID_UNKNOWN': 'MODIFY leaves part of a column unsaid',
    'diag.title.CATALOG_OTHER_NOTE': 'another note from the schema reader',
    'diag.title.CATALOG_PARENT_TABLE_UNKNOWN': 'a table inherits from one no file declared',
    'diag.title.CATALOG_PRIMARY_KEY_BY_CONVENTION': 'a primary key named by the database\'s convention',
    'diag.title.CATALOG_PRIMARY_KEY_KEPT_NOT_NULL': 'a primary key column kept NOT NULL',
    'diag.title.CATALOG_PRIMARY_KEY_REPLACED': 'a second primary key, the first taken as dropped',
    'diag.title.CATALOG_PRIMARY_KEY_UNKNOWN': 'primary key changes the reader cannot tell',
    'diag.title.CATALOG_READ_IN_MODE': 'tables read in a compatibility mode',
    'diag.title.CATALOG_RULE_ASSUMED': 'schema read by the rules of an assumed database',
    'diag.title.CATALOG_TABLE_DECLARED_TWICE': 'a table declared twice in the schema files',
    'diag.title.CATALOG_TABLE_READ_FAILED': 'table declarations that failed to read',
    'diag.title.CATALOG_TABLE_UNNAMED': 'CREATE TABLE with no readable name',
    'diag.title.CATALOG_VENDOR_CHOSEN': 'one database\'s schema picked from several',
    'diag.title.CONFIG_IMPORTED_FROM_OUTSIDE_THE_TREE': 'configuration imported from outside the repository',
    'diag.title.CONTRACT_FROM_DOCUMENT': 'handlers paired through an interface not in the tree',
    'diag.title.OPENAPI_DECLARATION_UNUSED': 'a declared OpenAPI document this run did not read',
    'diag.title.ROUTE_MOUNT_FROM_DOCUMENT': 'routes placed where an OpenAPI document says',
    'diag.title.GATEWAY_ROUTES_KEPT': 'gateway routes kept as the profile declares them',
    'diag.title.GATE_STRICT': 'the calibration gate needs a sealed baseline',
    'diag.title.JPA_NAMING_FROM_CONFIGURATION': 'JPA naming read from the project\'s configuration',
    'diag.title.JPA_IMPLICIT_NAMING_ASSUMED': 'a default join table\'s name rests on an assumed strategy',
    'diag.title.JPA_NAMING_FROM_FACTORY': 'JPA naming set by how the factory is built',
    'diag.title.JPA_NAMING_UNREADABLE': 'a JPA naming strategy this engine cannot apply',
    'diag.title.MAPPER_ALTERNATIVES_KEPT': 'mapper vendor choice kept as the profile declares it',
    'diag.title.MAPPER_VENDOR_CHOSEN': 'one vendor\'s copy of each mapper picked',
    'diag.title.NOT_SHIPPED': 'a declared option this engine does not have',
    'diag.title.PROFILE_DEFAULT_ASSUMED': 'a setting not declared, so a default was used',
    'diag.title.RECORDED_NOT_ACTED': 'a setting recorded but not acted on',
    'diag.title.SERVICE_NAME_KEPT': 'service names kept as the profile declares them',
    'diag.title.SNAPSHOT_REQUIRED': 'the schema is read from a pinned snapshot',
    'diag.title.TEMPLATE_ROOTS_KEPT': 'template roots kept as the profile declares them',
    'diag.title.TS_BACKEND_KEPT': 'the NestJS app kept as the profile names it',
    'diag.title.UNSUPPORTED_TECHNOLOGY': 'code or a pack this engine has no lane for',
    'diag.title.WEB_ROOTS_KEPT': 'frontend roots kept as the profile declares them',
    'gap.touch.class.input': 'Every answer that needs this input.',
    'gap.touch.class.unresolved': 'Every chain that runs through what could not be read. It stops early here.',
    'gap.touch.class.query': 'This census only. A walk you ask on Trace says its own bounds.',
    'gap.touch.class.unreached': 'No answer is wrong. These are places no route leads to.',
    'gap.touch.class.info': 'No answer changes. It is said so the counts read right.',
    'gap.todo.class.input': 'Give the analysis the input the cause names, and analyze again.',
    'gap.todo.class.unresolved': 'Read the cause. Where it names a setting or a source root, declare it and analyze again.',
    'gap.todo.class.query': 'Ask the one you care about on Trace. If it says it stopped, ask again in a wider mode or deeper.',
    'gap.todo.class.unreached': 'Open one on Trace, Details, to see what does touch it.',
    'gap.todo.class.info': 'Nothing to do.',
    'gap.touch.no-catalog': 'The ERD\'s lines, the columns a SELECT * reads, and bare column names.',
    'gap.todo.no-catalog': 'Run `cascade catalog fetch --candidate 1`, or analyze again with `--ddl <schema.sql>`.',
    'gap.touch.not-shipped': 'Every walk from a route. This pack has no route, service or transaction.',
    'gap.todo.not-shipped': 'Analyze again with the backend\'s code: `--java-src <dir>` for Java, `--ts-src <dir>` for a TypeScript backend.',
    'gap.touch.unresolved-calls': 'A chain that needs one of those calls ends short of where it really goes.',
    'gap.todo.unresolved-calls': 'Open the cause for the reasons and their counts. If a package of this project sits in a module you did not pass, analyze again with that module\'s `--java-src`.',
    'gap.touch.external-symbols': 'A chain that runs into library code stops there.',
    'gap.todo.external-symbols': 'Nothing, unless that code is yours. Then analyze its source too.',
    'gap.touch.http-calls-leaving-pack': 'The routes this project calls and does not serve. What they reach is not in this pack.',
    'gap.todo.http-calls-leaving-pack': 'Register the project that serves those routes too. If they are this project\'s own routes behind an address prefix, declare that prefix in the profile and analyze again.',
    'gap.touch.screen-components-unresolved': 'Those screens. Nothing hangs off them, so no walk here starts from them.',
    'gap.todo.screen-components-unresolved': 'Declare the alias or the source root the router\'s imports use, then analyze again.',
    'gap.touch.endpoints-without-statement': 'These routes\' walks end before any SQL.',
    'gap.todo.endpoints-without-statement': 'Open one on Trace. A route that stops at itself needs a wider mode, and one that uses no database is fine.',
    'gap.touch.statements-not-reached': 'SQL no route here calls. A scheduled job, another service or reflection may.',
    'gap.todo.statements-not-reached': 'Open one on Trace, Details, before you call any of it dead code.',
    'gap.touch.tables-not-reached': 'Tables no route reaches, though some SQL may still run on them.',
    'gap.todo.tables-not-reached': 'Open one on Trace, Details, to see which SQL touches it.',
    'gap.touch.mode-floor': 'Links this mode does not follow. Every walk in this mode stops before them.',
    'gap.cause.no-catalog': 'No database schema was read. The {n} {n|table|tables} here {n|is|are} the {n|one|ones} a statement named.',
    'gap.cause.not-shipped': 'The backend code was not analyzed, so none of the {n} SQL {n|statement|statements} has a known caller.',
    'gap.cause.unresolved-calls': 'The analysis could not tell where {n} method {n|call goes|calls go}, so they are not in the graph, and a chain that needed one ends early.',
    'gap.cause.external-symbols': '{n} {n|type has|types have} no source here. They are library or framework code, where a chain stops.',
    'gap.cause.http-calls-leaving-pack': '{n} call {n|target has|targets have} no route in this project to answer them. Each is another service, or a route of this project behind a prefix nobody declared.',
    'gap.cause.multi-handler-routes': '{n} {n|route is|routes are} declared by more than one controller method. The counts follow all of them; a picture follows one and names the others.',
    'gap.cause.openapi-drift': '{n} {n|route is|routes are} in the API document or in the code, not in both.',
    'gap.cause.screens-from-server': 'The app fetches its menu from the server when it runs, so the {n} {n|screen|screens} here {n|is|are} only the {n|one|ones} its source declares.',
    'gap.cause.screens-seen-at-run-time': '{n} {n|screen is|screens are} known partly from a recording. They are shown beside the counts, never inside them.',
    'gap.cause.runtime-evidence': 'A trace confirmed or added {n} {n|link|links}. It changed no grade, and what it did not visit is unknown, not dead.',
    'gap.cause.screen-components-unresolved': '{n} screen {n|declaration names|declarations name} a component this lane could not find as a file, so what those screens show is unknown.',
    'gap.cause.endpoints-without-statement': '{n} {n|API reaches|APIs reach} no SQL in {mode}. Some use no database at all; others stop at a link this mode does not follow.',
    'gap.cause.statements-not-reached': '{n} SQL {n|statement is|statements are} reached from no API here. That does not make them dead: a job, another service or reflection may call them.',
    'gap.cause.tables-not-reached': '{n} {n|table is|tables are} reached from no API. Some SQL may still run on them.',
    'gap.cause.generated-code': '{n} {n|symbol is|symbols are} machine-written, as the profile declares.',
    'gap.cause.generated-walk-skip': '{n} {n|step|steps} from one generated symbol to another {n|was|were} not walked.',
    'gap.cause.node-cap': '{n} route {n|walk hits|walks hit} the node cap, so only part of what they reach was counted.',
    'gap.cause.depth-cap': '{n} {n|route|routes} still had calls to follow at the depth limit, so their counts are a floor.',
    'gap.cause.contract-links': '{n} {n|route has|routes have} a handler only because a rule paired them by a code generator\'s naming, which is a guess.',
    'gap.cause.duplicate-types': '{n} {n|type is|types are} declared in more than one file. Each is one node, so no count is doubled.',
    'gap.cause.jpa-statements-unresolved': '{n} JPA {n|query carries|queries carry} a part the analysis could not read, so their column lists are partial.',
    'gap.cause.mp-columns-runtime-only': '{n} MyBatis-Plus {n|statement builds|statements build} their column list when they run. The table is certain; the columns are what could be read.',
    'gap.cause.mode-floor': '{n} {n|link is|links are} graded below what {mode} follows, so every count here stops before them.',
    'gap.cause.catalog-tables-unread': 'The schema reader could not read the CREATE TABLE of {n} {n|table|tables}, so they are not in the catalog, or only in part. A statement that names one still reaches it, with only the columns it names.',
    'gap.cause.catalog-rules-assumed': '{n} {n|thing|things} in the catalog {n|rests|rest} on a rule of a database this run assumed, because the profile does not say which database the schema is for.',
    'gap.cause.catalog-read-in-part': '{n} {n|place|places} in the schema files {n|was|were} not read or applied as written, so the tables there may not be in the state the files leave.',
    'gap.todo.mode-floor': 'On Trace, walk again in the wider mode the answer names. It says what that adds.',
    'gap.touch.depth-cap': 'Those routes\' reach. Each count is a lower bound.',
    'gap.todo.depth-cap': 'Trace one of those routes. The walk says where it stopped.',
    'gap.touch.node-cap': 'Those routes\' reach. Only part of it was counted.',
    'gap.todo.node-cap': 'Trace one of those routes. Its lanes are fetched a page at a time.',
    'gap.touch.mp-columns-runtime-only': 'The column lists of those statements. The table is certain, but not every column is there.',
    'gap.todo.mp-columns-runtime-only': 'Nothing to declare. Those columns are decided when the query runs.',
    'gap.touch.jpa-statements-unresolved': 'Those statements\' column lists hold what could be read, not all of it.',
    'gap.touch.openapi-drift': 'The routes the document and the code disagree on.',
    'gap.todo.openapi-drift': 'Decide which is right, the document or the code. The engine judges neither.',
    'gap.touch.screens-from-server': 'Every screen count. Each is a lower bound.',
    'gap.todo.screens-from-server': 'Set `screenAxis.enabled` to false if you would rather have no screen axis than a partial one.',
    'gap.touch.contract-links': 'The routes a rule paired with a handler by a generator\'s naming.',
    'gap.todo.contract-links': 'Ask in mode heuristic to walk into that code.',
    'graph.adv': 'Advanced view',
    'graph.adv.title': '3D and the moving dots along the lines. Off, the map is flat and still.',
    'rail.lead.trace.up': 'Pick one from the list to see where it is used, which is what a change there would touch.',
    'rail.lead.trace.down': 'Pick one from the list to see what it runs through, down to the tables.',
    // ---- RM67-U2c: five places, Start, the map, Analysis status ---------
    'summary.rule.code.top': 'Code areas are where the handler code sits. They are not modules anyone declared, nor the API groups the header counts by path.',
    'summary.rule.path.top': 'API groups are the first segment of each route\'s path, as the header counts them.',
    'summary.noun.area': 'code area',
    'summary.nouns.area': 'code areas',
    'summary.noun.module': 'module',
    'summary.nouns.module': 'modules',
    'summary.noun.api': 'API group',
    'summary.nouns.api': 'API groups',
    'summary.noun.path': 'path area',
    'summary.nouns.path': 'path areas',
    'summary.rule.words.top': 'Families are tables whose names start with the same word.',
    'summary.rule.letters.top': 'Families are tables whose names start with the same letters.',
    'status.diag.label': 'analyzer warning: {kind}',
    // ---- what a list says when the engine sent nothing ---------------------
    // The engine's `empty` reason is a CODE; these are the page's plain-words
    // rendering of it. The code itself never changes.
    'empty.notshipped': 'not shipped: this project was analysed without the Java side, so there is nothing here to list',
    'empty.none': 'none: nothing reaches this',
    'empty.notinaxis': 'not on this side of the chain',
    // ---- banners --------------------------------------------------------
    'err.generic': 'error: {message}',
  },
};