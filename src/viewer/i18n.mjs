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
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => (
    params && typeof params === 'object' && Object.hasOwn(params, name) && params[name] != null
      ? String(params[name])
      : whole
  ));
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
    'mast.limits': '{n} limits',
    // BUILD IDENTITY, one click behind the line. The digest and the base commit
    // are what you need to tell two builds apart or to chase a mismatch, and
    // they are the first thing a reader who has never seen this tool has to
    // skip past. So the line says which project and which analyzers, and this
    // little control opens the rest. Nothing is dropped, only demoted.
    'mast.build': 'build',
    'mast.build.title': 'the fingerprint of this build and the commit it was made from',
    // A TRACE INFORMED THIS PACK, said as quietly as freshness and trust are.
    // The source word and the span count are the capture's own numbers and are
    // interpolated, never rewritten; the coverage note beside them is the
    // engine's own sentence and rides in the tooltip verbatim. Nothing shows
    // when no capture was read.
    'mast.trace': 'trace: {source}, {n} spans',
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
    'mast.fresh.unknown.title': 'there is no git commit to compare this build against, so there is nothing to say about how old it is. That is the resting state of a pack, not a failure.',
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
    'crail.groups': 'api groups',
    'crail.groups.title': 'an API group is the first segment of a route, like the /product in /product/list. It is a naming habit, not a module anyone declared. The overview answer does not count groups, so this number fills in once the Graph map has been drawn.',
    'crail.endpoints': 'endpoints',
    'crail.services': 'services',
    'crail.sql': 'SQL',
    'crail.tables': 'tables',
    'crail.columns': 'columns',
    'crail.screens': 'screens',
    'crail.notshipped': 'not shipped',
    'crail.notshipped.title': 'this project was analysed without the part that counts these, so the number is missing rather than zero',
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
    'tab.overview': 'Overview',
    'tab.explore': 'Explore',
    'tab.flow': 'Flow',
    'tab.impact': 'Impact',
    'tab.coupling': 'Coupling',
    'tab.graph': 'Graph',
    'tab.erd': 'ERD',
    'tab.tx': 'Transactions',
    // ---- shared toolbar vocabulary -------------------------------------
    'mode.title': 'how sure a call has to be before we follow it',
    'mode.conservative': 'conservative: also follow likely calls',
    'mode.strict': 'strict: only calls we can prove',
    'mode.heuristic': 'heuristic: also follow guessed rules',
    'view.title': 'chain draws the whole path left to right. by hop groups the same rows one step at a time.',
    'view.lanes': 'chain',
    'view.layers': 'by hop',
    'btn.draw': 'Draw',
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
    'hint.overview.lead': 'What this project has, how much of it reaches a table, and what we could not see.',
    'hint.overview.more': 'Every number on this tab comes from one `overview` call, so the page counts nothing itself. The dials say how much of the code runs from an HTTP route all the way down to a table. A statement no endpoint reaches is one the endpoints we analysed never call, usually a generated mapper method. That is a different thing from dead code.',
    'load.overview': 'following every endpoint down to the tables…',
    // ---- Overview: the headings of the panels under the ribbon -----------
    // The panel NAMES are the page's; every number and every word inside them
    // is the `overview` answer's own.
    'ov.gaps.title': 'What we could not see',
    'ov.gaps.note': '{n} kinds of blind spot',
    // HOW MUCH OF THIS PROJECT LEAVES IT. A call to a route this project does
    // not serve stops the chain, unless another registered project serves that
    // route and the server can carry the answer across.
    'ov.federation.note': '{n} call(s) leave this project, {k} answered by a registered project and {m} not.',
    // WHO THIS PROJECT TALKS TO (RM45). The census above is one sentence; this
    // panel is the list behind it, one row per registered project that answers
    // a route this one calls, and one last row for the calls nobody answers.
    'ov.connected.title': 'Connected projects',
    'ov.connected.note': 'the routes this project calls and does not serve, and the registered project that answers each one. Click a row to go there.',
    'ov.connected.calls': '{n} call site(s) over {r} route(s)',
    'ov.connected.more': '+{n} more',
    'ov.connected.route.title': '{n} method(s) in this project make this call',
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
    'chip.fed.on.title': 'hide the {n} node(s) that came from {k} other registered project(s)',
    'chip.fed.off.title': 'draw the {n} node(s) that came from {k} other registered project(s)',
    'gcount.federated': '**{n}** nodes from **{k}** connected project(s)',
    'gcount.federated.off': '(hidden)',
    'tip.fedproject': 'in {p}, another registered project on this server',
    'tip.fedskeleton': 'a connected project. {n} of its routes are on this map, because this project calls them.',
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
    'erdleg.connected.on.title': 'hide the {n} connected project(s) on this sheet',
    'erdleg.connected.off.title': 'draw the {n} connected project(s) this project reaches over an HTTP call',
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
    'erd.side.connected.counts': '{tables} table(s), {rels} relationship(s)',
    'erd.side.connected.open': 'open the ERD of {p}',
    'erd.side.connected.hidden': 'they are not on the sheet right now. The switch in the legend above the picture draws them.',
    'erd.side.map.fedonly': 'this project has no table of its own. Its requests end in {n} other registered project(s): {p}.',
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
    'ov.gap.http-calls-leaving-pack.label': 'API calls to other services',
    'ov.gap.screen-components-unresolved.label': 'screens with no component found',
    'ov.gap.endpoints-without-statement.label': 'endpoints that reach no SQL',
    'ov.gap.statements-not-reached.label': 'SQL no endpoint reaches',
    'ov.gap.duplicate-types.label': 'types declared twice',
    'ov.gap.mode-floor.label': 'connections this mode leaves out',
    'ov.gap.not-shipped.label': 'SQL with no Java side to call it',
    'ov.gap.no-catalog.label': 'no database schema was read',
    'ov.gap.multi-handler-routes.label': 'routes two controllers both declare',
    'ov.gap.tables-not-reached.label': 'tables no endpoint reaches',
    'ov.gap.openapi-drift.label': 'routes the API document disagrees on',
    'ov.gap.screens-from-server.label': 'screens the server adds at run time',
    'ov.gap.screens-seen-at-run-time.label': 'screens known only from a recording',
    'ov.gap.runtime-evidence.label': 'what a trace saw actually run',
    'ov.gap.generated-code.label': 'machine-written code',
    'ov.gap.generated-walk-skip.label': 'steps inside generated code we skipped',
    'ov.gap.node-cap.label': 'chains too big to walk in one go',
    'ov.gap.depth-cap.label': 'chains we stopped at the depth limit',
    'ov.gap.jpa-statements-unresolved.label': 'JPA queries we could only partly read',
    'ov.gap.mp-columns-runtime-only.label': 'columns decided when the query runs',
    'ov.nodes.title': 'What we found',
    'ov.nodes.count': '({n} kinds)',
    'ov.edges.title': 'Connections, by type and certainty',
    'ov.code.title': 'The Java side',
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
    // The two tooltips and the footnote of the code panel.
    'ov.code.symbols.title': 'methods we read out of the Java source',
    'ov.code.external.title': 'a library or framework class with no source here, so a chain that runs into one stops there',
    'ov.code.tx.title': 'methods marked `@Transactional`, so everything under one runs in a single commit',
    'ov.code.mapper.title': 'methods that are themselves a SQL statement',
    'ov.code.nomapper': '{n} statement(s) have no mapper method',
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
    'screen.noimpact': 'A screen is the top of the chain, so there is nothing above it to ask about.',
    'load.screen': 'following this screen down to the tables…',
    // ---- the evidence rail, beside every answer --------------------------
    // Only the HEADING is the page's. The field labels under it name the
    // engine's own contract fields and stay in the engine's language.
    'rail.rests': 'What this answer is based on',
    // ---- Overview hero: the four KPI dials -------------------------------
    // One card per step of the chain, drawn from `reach` — the very fields
    // the ribbon below the hero is drawn from. The label says what is being
    // counted; the `rest` line says what the number LEAVES OUT.
    'kpi.endpoints': 'endpoints that reach SQL',
    'kpi.statements': 'SQL statements reached',
    'kpi.tables': 'tables reached',
    'kpi.columns': 'columns reached',
    'kpi.screens': 'screens that reach a table',
    'kpi.rest.endpoints': '{n} reach no SQL',
    'kpi.rest.statements': '{n} nothing calls',
    'kpi.rest.tables': '{n} sit behind no route',
    'kpi.rest.columns': '{n} nothing reaches',
    'kpi.rest.screens': '{n} reach none',
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
    // ---- Overview hero: the cartography ----------------------------------
    'ov.map.title': 'The whole picture',
    'ov.map.hint': 'hover to light one chain, click to keep it lit, double-click to open it on the Graph tab',
    'ov.map.wheel': 'Click the map to zoom with the wheel',
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
    'ribbon.say.endpoints': '{reached} of {total} endpoints reach a SQL statement. The other {rest} reach none. They may touch no database at all, or we could not tell what one of their calls points to.',
    'ribbon.say.statements': '{reached} of {total} statements are reached from an endpoint. Nothing we analysed calls the other {rest}, which are usually generated mapper methods. That is a different thing from dead code.',
    'ribbon.say.tables': '{reached} of {total} tables are reached from an endpoint. No endpoint reaches the other {rest}. Some statement may still write them; what is missing is the HTTP route above.',
    'ribbon.say.columns': '{reached} of {total} columns are reached from an endpoint. Nothing reaches the other {rest}.',
    // ---- Explore tab ----------------------------------------------------
    'hint.explore.lead': 'Search a table, column or SQL statement, then open one to see what it touches.',
    'hint.explore.more': 'Type part of a name and pick a result. Click a column to see the SQL statements that read or write it, and the APIs above those statements. Each answer says how sure we are and what we could not prove.',
    'explore.edits': 'My edits',
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
    'edits.frontendcalls': '{n} frontend call(s)',
    'edits.frontendcalls.title': 'how many frontend functions call this route',
    // ---- Flow tab -------------------------------------------------------
    'hint.flow.lead': 'Pick one API and follow it from the route down to the tables it ends at.',
    'hint.flow.more': 'Read it left to right: the endpoint, the service methods it may run through, the mapper statements those reach, and the tables at the end. A solid line is a call we can prove; a dashed line is one we think happens but could not confirm. Hover a row to light its chain, and click it for the path, the source and the SQL.',
    'flow.depth.title': 'how many calls deep to follow',
    'load.flow': 'following the chain…',
    // ---- Flow / Impact side panels (both tabs draw with one function) ----
    // The grade NAMES beside these lines are the engine's and are printed as
    // they arrived; only the sentence explaining each one is the page's.
    'chain.legend.title': 'how to read the lines',
    'chain.legend.exact': 'we can see it in the code',
    'chain.legend.sound': 'this call may happen, we could not confirm it',
    'chain.legend.heuristic': 'a naming rule guessed this one',
    'chain.legend.links': '{n} connections',
    'chain.walk.note': 'followed {walked} nodes, depth {depth}, mode {mode}',
    'chain.walk.other': ', plus {n} we reached that this picture has no place for',
    'chain.other.view': 'other view: ',
    'chain.other.explore': 'Explore',
    'chain.other.explore.title': 'the same target as plain lists of statements and endpoints',
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
    'chain.hop': 'hop {n}',
    'chain.band.candidate': 'may be called ({n})',
    'chain.band.candidate.stmt': 'reached through a call we could not confirm ({n})',
    'chain.band.heuristic': 'matched by a naming rule ({n})',
    // ---- Flow / Impact: what a column says when it has nothing to show ----
    'chain.empty.notinaxis': 'What you picked is already on this side of the chain, so there is nothing to list here.',
    'chain.empty.nomode': 'Nothing here. {n} connection(s) are decided at run time, or we could not tell what they point to, so no mode reaches them.',
    'chain.empty.bymode': 'Nothing here at mode={mode}. We left out {n} connection(s) this mode does not trust. ',
    'chain.empty.switch': 'Switch to {mode}',
    'chain.cap': 'This column is full. Try a narrower entry, or a smaller depth.',
    'chain.cap.more.title': 'show more rows in each column',
    'chain.cut': '{n} more row(s) here did not fit. ',
    'chain.cut.raise': 'Show more',
    'chain.folded': '{n} node(s) at this hop have no row of their own: a mapper method is shown inside its statement.',
    'chain.derived.note': 'These {field} came from the edges of a node we had already reached, so no node of the walk sits at this hop.',
    'chain.norows': 'nothing at this hop',
    'chain.derived.label': 'read, not walked',
    'chain.derived.what': 'read, not walked: {n} {field} came from the edges of a node we had already reached.',
    'chain.hop.nodes': '{n} node(s) at this hop',
    'chain.tag.runtime': 'columns at run time',
    'chain.nolayers': 'Nothing to group: this run reached nothing past the entry itself.',
    'chain.beyond': '{n} more {unit}(s) sit one hop past the depth limit. A node we reached names them, but we never went on to them, so they are under no hop below.',
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
    'chain.tag.frontend': 'web {n}',
    'chain.tag.frontend.title': 'how many frontend functions call this route',
    // A row from ANOTHER project. The server followed an HTTP call out of this
    // pack into a project it also serves, so the code below the badge lives in
    // a different deployable and answers to a different build.
    'chain.tag.project.title': 'this row is in another registered project, reached over an HTTP call out of this one',
    'chain.card.otherproject': 'This row is in {p}. This page shows one project at a time, so switch the selector to {p} to open its source or walk it further.',
    'chain.nosource': 'no source: we never saw this type in the code',
    // ---- Impact tab -----------------------------------------------------
    'hint.impact.lead': 'Pick a column, table or method and see which APIs would be affected if you changed it.',
    'hint.impact.more': 'Read it left to right: the thing you are changing, the SQL statements that touch it, the service methods above them, and the endpoints that can reach it. Each row carries the weakest link on its path, so one unconfirmed call makes the whole row unconfirmed.',
    'impact.depth.title': 'how many calls back to follow',
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
    'rail.filter.ph': 'filter, or exact name + Enter',
    // The rail's OWN empty state. A filter that matched none of the rows on
    // screen is the page's own doing, so it says so in the page's own words:
    // the engine's `not-shipped` / `none` belong to a list that was empty
    // before anybody typed, and borrowing one of those here would blame the
    // pack for a miss the filter made.
    'rail.filter.none': 'no row matches {q}',
    'rail.keys': '↑↓ move, Enter picks, / filters',
    'rail.count': '{n} shown of {m}',
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
    'rail.lead.explore': 'Pick a table, column or statement from the list to see what touches it.',
    'rail.lead.flow': 'Pick an endpoint from the list to follow it down to the tables it ends at.',
    'rail.lead.impact': 'Pick a table or column from the list to see which APIs a change would affect.',
    'rail.picks': 'Start with one of these',
    // A stat chip on a row says what its number counts.
    'rail.stat.statements.title': 'how many SQL statements touch this',
    'rail.stat.endpoints.title': 'how many endpoints reach this, following calls at mode=conservative, depth 8',
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
    'rail.stat.screens.title': 'how many screens reach this, following the frontend calls at mode=conservative, depth 8',
    'rail.stat.screenapi.title': 'how many API routes this screen reaches, following the calls its own code makes',
    'rail.stat.screentables.title': 'how many tables this screen ends at',
    'rail.stat.seen': 'seen',
    'rail.stat.seen.title': 'a recording confirms the browser really made one of these calls from this screen',
    // Flow buckets its rows under the API group each endpoint belongs to.
    'rail.group.endpoints': '{n} endpoints',
    'rail.group.reach': '{n} reach SQL',
    'rail.group.screens': '{n} screens',
    'rail.group.reachapi': '{n} reach an API',
    // Flow can be walked from either end of the round trip, so its rail says
    // which end its list is of.
    'rail.flowkind.title': 'draw the chain from an API route, or from the screen that calls one',
    'rail.lead.flow.screen': 'Pick a screen from the list to follow it down to the tables it ends at.',
    // Impact opens a table into its own columns, one request per table.
    'rail.tree.title': 'show the columns of this table',
    'rail.tree.loading': 'loading the columns…',
    // The masthead counts every endpoint node; this rail counts the ones the
    // pack SERVES. On jeecg that is 978 against 969, and two numbers on one
    // screen that do not match read as a bug until something connects them.
    'rail.count.outbound': '{n} served; {m} more are routes this pack calls and does not serve',
    // ---- one way back ---------------------------------------------------
    // The same control on every tab that can narrow, at the right end of its
    // own toolbar, disabled while the tab already is its opening state.
    'btn.showall': 'Show all',
    'btn.showall.title': 'back to this tab as it opened: nothing picked, nothing filtered',
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
    'coupling.depth.title': 'how many calls deep we follow each endpoint',
    'coupling.all': 'show all groups',
    'coupling.all.title': 'off: show only the groups that appear in a pair',
    'load.coupling': 'following every endpoint…',
    'err.coupling': 'error (sharing {axis}, mode={mode}, depth {depth}): {message}',
    'cp.empty.bymode': 'No coupling shows at mode={mode}. We left out {n} connection(s) this mode does not trust.',
    'cp.empty.switch': 'Try mode={mode}',
    'cp.empty.none': 'No group writes anything another group reads, {depth} calls deep.',
    'cp.diag.title': '{group} writes and reads its own {unit}. One group on its own is not coupling, so it is counted apart.',
    'cp.pastcut': 'This pair did not fit the list, so its {unit} were not sent.',
    'cp.pairs.note': 'writer, then reader, ranked by how many {unit} they share. Click one for the list.',
    'cp.pairs.title': 'the {unit} these two share',
    'cp.viashared.tag.title': '{n} of them, on at least one side, are carried only by statements that three or more groups reach',
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
    'graph.mode.title': 'how sure a call has to be before the map follows it',
    'graph.mode.strict': 'strict',
    'graph.mode.conservative': 'conservative',
    'graph.mode.heuristic': 'heuristic',
    'graph.depth.title': 'how many calls deep we follow each endpoint',
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
    'btn.impact.column.title': 'which APIs would be affected if you changed this column',
    'btn.impact.table.title': 'which APIs would be affected if you changed this table',
    'btn.erd.title': 'this table on the schema map',
    'btn.table.title': 'the SQL and the columns that touch this table',
    'btn.around.title': 'draw the rings around this node',
    'btn.recentre.title': 'put this node in the middle and draw its neighbors',
    'btn.tx.flow.title': 'follow this method down to the tables',
    'btn.tx.impact.title': 'which APIs can reach this transaction',
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
    'chip.show.title': 'show the {n} {kind} node(s). The count stays either way.',
    'chip.hide.title': 'hide the {n} {kind} node(s). The count stays either way.',
    'chip.sql.on.title': 'turn the SQL layer off, so endpoints point straight at the tables again',
    'chip.sql.off.title': 'ask the engine again with the SQL layer on, so each mapper statement gets its own node',
    'chip.screens.on': 'screens on ({n})',
    'chip.screens.off': 'screens off',
    'chip.screens.on.title': 'turn the screens layer off, so this map is the server side alone',
    'chip.screens.off.title': 'ask the engine again with the screens layer on, so every screen that reaches a route gets its own node',
    'gcount.groups': '**{n}** groups',
    'gcount.endpoints': '**{n}** endpoints',
    'gcount.tables': '**{n}** / {total} tables touched',
    'gcount.statements': '**{n}** statements',
    'gcount.screens': '**{n}** / {total} screens reach a route',
    'gcount.links': '**{n}** lines drawn',
    'gcount.folded': '**{n}** endpoints folded in',
    'gcount.unfolded': '**{n}** endpoints in **{g}** open group(s), **{n2}** still folded',
    'gcount.nodes': '**{n}** nodes',
    'gcount.ofanswer': 'of {nodes} / {links} in the answer',
    'gcount.hops': '{hops} hops, direction {dir}',
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
    'mapleg.dashed.title': '{grade}: a call we could not confirm. Drawn dashed on the 2D canvas only.',
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
    'map.lead.chip.title': '{id}, {degree} connections drawn',
    'map.lead.unreached': '{n} of the {total} tables here are on no endpoint’s line, so they are not drawn. They are in the schema, and nothing we analysed reaches them.',
    'map.lead.allreached': 'every table in this project is reached from an endpoint.',
    // ---- the map's tooltip and the card beside it -------------------------
    // Everything a reader hovers or clicks used to be written in English inside
    // a Korean page: the tooltip's clauses, the card's heading, its buttons and
    // every list heading under it. Each is a sentence, so each is a key.
    'tip.endpoints': '{n} endpoints',
    'tip.groupnote': 'An API path prefix, which is a naming habit.',
    'tip.connections': '{n} connections drawn',
    'tip.columns': '{n} columns',
    'tip.ingroup': 'group {g}',
    'tip.screenapi': '{n} routes reached',
    'tip.screentables': '{n} tables at the end',
    'tip.seen': 'a recording confirms a call from this screen',
    'map.card.head': '{kind}, {n} connections',
    'map.card.clear': 'Clear',
    'map.card.group': 'groups ({n})',
    'map.card.screen': 'screens ({n})',
    'map.card.endpoint': 'endpoints ({n})',
    'map.card.statement': 'statements ({n})',
    'map.card.table': 'tables ({n})',
    'map.card.stmt': '{n} statements',
    'map.card.more': 'and {n} more of this kind. The picture has them all.',
    'map.gone': 'That node is not on the map any more. A chip hid its kind.',
    'map.group.note': 'the first segment of a route. It is a naming habit, not a boundary anyone declared.',
    'around.hop.title': 'how many hops it took to reach this node',
    'around.unreached.title': 'nothing in this slice reaches it, so it waits on the ring outside the last hop we measured',
    'around.noedge': 'no line in this slice touches it',
    // ---- ERD tab --------------------------------------------------------
    'hint.erd.lead': 'The whole schema, laid out by the joins the mapper SQL makes between tables.',
    'hint.erd.more': 'A line here is a join some SQL statement makes, not a foreign key: we do not read constraints. A bigger table has more relationships, and a thicker line means more statements make that join. The legend groups tables by the name prefix before the first underscore, which is a naming habit rather than a declared boundary. Click a table to light it and its neighbors, scroll to zoom, and drag a node to pin it.',
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
    'erdleg.hublabels': 'names on the {n} busiest tables',
    'erdleg.hublabels.some': 'names on {m} of the {n} busiest tables',
    'erdleg.somelabelled': '{m} of {n} tables named',
    'erdleg.thickness': 'line thickness: 1 to {n} statements',
    'erdleg.thickness.title': 'the line gets thicker the more statements make that join',
    'erdleg.prefixes': 'name prefixes:',
    'erdleg.prefixes.title': 'the part of a table name before the first underscore. It is a naming habit, not a boundary we found in the code.',
    'erdleg.noprefix': '(no prefix)',
    'erdleg.nogroups': 'no table name here has a prefix to group by',
    // ---- ERD side panels and the strip under the canvas -------------------
    'erd.side.map': 'whole-schema map',
    'erd.side.map.brief': '{tables} tables, {relationships} relationships.',
    'erd.side.map.body': 'A bigger table has more relationships, and a thicker line means more statements make that join. Click a table to light it up.',
    'erd.side.map.isolated': '{n} of them join to nothing in the SQL. They are in the strip under the map.',
    'erd.side.hubs': 'hub tables',
    'erd.side.hubs.by': '(by relationships)',
    'erd.side.rels': 'relationships',
    'erd.side.rels.none': 'no SQL here joins this table to another',
    'erd.side.cols': 'columns',
    'erd.side.cols.loading': 'loading…',
    'erd.side.count': '({n})',
    'erd.side.clear': 'Clear',
    'erd.card.title': 'we work this out from which side joins on a primary key',
    'erd.iso.title': 'joined to nothing',
    'erd.iso.count': '({n} tables)',
    'erd.iso.brief': 'No SQL joins these tables to anything, so we can’t place them on the map. They’re still in the schema.',
    'erd.iso.body': 'That does not mean they stand alone. A join written in Java, or one no statement we read makes, leaves no trace here.',
    // ---- Transactions tab ------------------------------------------------
    'hint.tx.lead': 'Each `@Transactional` method is one commit, and this is what it can touch.',
    'hint.tx.more': 'Everything a `@Transactional` method reaches is written and read inside the same commit. A wide footprint across many tables is where one change ripples furthest. Click a transaction to see its columns and its source.',
    'load.tx': 'loading transactions…',
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