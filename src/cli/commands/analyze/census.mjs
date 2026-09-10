// analyze/census.mjs — what a run SAYS about itself.
//
// EVERY LINE HERE IS A PROMISE. A default that is never printed is
// indistinguishable from a hidden filter, so a run states what it read, what it
// left out and why, lane by lane. That is the whole of this module: it takes
// numbers the run already computed and turns them into the sentence a reader
// acts on. Nothing in here decides anything, opens a file or changes a graph —
// if a line here were wrong, the pack beside it would still be right, and that
// is the property that lets the census be read as evidence.

import path from 'node:path';
import { MODE_COLD } from '../../../core/invalidate.mjs';
import { cacheDir } from '../../../core/paths.mjs';
import { listOfFive } from '../../output.mjs';

export function sayNoSchemaFetched(profile, { ddls, snapshot, resolved, root }) {
  // THE ONE REMINDER. This project told `init` where its database is, nobody
  // has fetched the schema, and the run is about to produce a pack whose ERD
  // has no relationship lines and whose column answers are partial. That is a
  // supported answer and the run continues, but it is said HERE, at the top,
  // rather than left for whoever opens the empty diagram later.
  const recordedConnection = (profile.catalog?.source ?? 'none') === 'none'
    && typeof profile.catalog?.connectionFrom === 'string' && profile.catalog.connectionFrom.length > 0;
  if (recordedConnection && ddls.length === 0 && !snapshot) {
    // The profile stores that path relative to the manifest directory; the
    // reader is standing in the repository, so it is shown from there.
    const from = resolved.dotCascade
      ? path.relative(path.resolve(root), path.resolve(resolved.dotCascade, profile.catalog.connectionFrom)) || profile.catalog.connectionFrom
      : profile.catalog.connectionFrom;
    process.stderr.write(`no schema has been fetched: the profile records a database at ${from} `
      + 'and nothing has read it, so this pack gets no ERD relationship lines and partial column answers. '
      + 'Run `cascade catalog fetch --candidate 1` to pin one.\n');
  }
}

export function sayLaneLine({ sel, snapshot, snapshotProvenance, ddls, mappers, javaSrc, webSrc, openapiFiles, harFiles, otelFiles, root }) {
  // The lane line states BOTH what ran and what was left out: a default that is
  // never printed is indistinguishable from a hidden filter (SPEC §17.8).
  const excluded = sel.excludedTestRoots.length > 0
    ? `; ${sel.excludedTestRoots.length} test root(s) excluded (the standard src/test layout; pass --java-src to include): ${sel.excludedTestRoots.join(', ')}`
    : '';
  const catalogLine = snapshot
    ? `catalog ${snapshot} (pinned snapshot${snapshotProvenance ? `, ${snapshotProvenance.dialect} ${snapshotProvenance.serverIdentity} fetched ${snapshotProvenance.fetchedAt}` : ', provenance file missing'})`
    : `ddl ${ddls.length > 0 ? `${ddls.length} file(s) (${sel.sources.ddl}): ${ddls.join(', ')}` : 'none'}`;
  process.stderr.write(`lanes [${sel.lanes.join(',')}]: ${catalogLine}; `
    + `mappers ${mappers.length} dir(s) (${sel.sources.mappers}); `
    + `java-src ${javaSrc.length} root(s) (${sel.sources.javaSrc}${excluded}); `
    + `web ${webSrc.length > 0 ? `${webSrc.map((d) => path.relative(root, d) || '.').join(', ')} (${sel.sources.webSrc})` : 'none'}; `
    + `openapi ${openapiFiles.length > 0 ? `${openapiFiles.map((f) => path.relative(root, f)).join(', ')} (${sel.sources.openapi})` : 'none'}; `
    + `har ${harFiles.length > 0 ? `${harFiles.map((f) => path.relative(root, f)).join(', ')} (${sel.sources.har})` : 'none'}; `
    + `otel ${otelFiles.length > 0 ? `${otelFiles.map((f) => path.relative(root, f)).join(', ')} (${sel.sources.otel})` : 'none'}\n`);
}

/**
 * THE MAPPER XML THIS RUN READ, AND THE COPIES IT DID NOT (RM56).
 *
 * A tree that ships one mapper per database vendor reads one vendor's copies,
 * and a count with no explanation beside it reads as files going missing. So
 * the line says both numbers, and where the other copies went.
 */
export function sayMapperCensus({ sel, mappers, mapperFiles }) {
  const left = (sel.mapperAlternatives ?? []).length;
  if (mappers.length === 0 || left === 0) return;
  process.stderr.write(`mapper XML: ${mapperFiles.length} file(s), `
    + `${left} left out as other vendors' copies (profile mappers.alternatives)\n`);
}

export function sayVendoredWebRoots(profile, { sel, webSrc, resolved, root }) {
  // WHICH OF THOSE ROOTS NOBODY PACKAGED (RM47). A root the profile names is
  // read exactly like one a package.json gave, and the census has to say which
  // is which: nothing declares a framework for a vendored root, so the router
  // pack was read out of its source rather than out of a dependency list.
  if (webSrc.length > 0 && sel.sources.webSrc !== 'flag') {
    const vendored = (profile.webRoots ?? [])
      .filter((r) => r && typeof r.root === 'string' && (r.kind ?? 'declared') === 'vendored')
      .map((r) => path.relative(root, path.resolve(resolved.dotCascade ?? root, r.root)) || '.');
    if (vendored.length > 0) {
      process.stderr.write(`web roots from the profile: ${vendored.length} vendored (no package manifest): ${listOfFive(vendored)}\n`);
    }
  }
}

/**
 * WHO THIS PACK IS, AND WHERE ITS CALLS GO, said on the run that uses them.
 * The name is the profile's when it declares one and THIS RUN's discovery
 * otherwise, and the line says which, because a name nobody recorded is one
 * that goes away the next time discovery reads a different tree.
 */
export function sayIdentity(serviceNames, gatewayKeys) {
  if (serviceNames.names.length > 0 || gatewayKeys.length > 0) {
    const readIn = serviceNames.files.slice(0, 3).join(', ')
      + (serviceNames.files.length > 3 ? `, and ${serviceNames.files.length - 3} more` : '');
    process.stderr.write(`service name(s) [${serviceNames.names.join(', ')}]`
      + (serviceNames.from === 'discovery'
        ? ` (discovered in ${readIn}, not in the profile: run \`cascade init --force\` to record it)`
        : '')
      + `; gateway routes ${gatewayKeys.length}${gatewayKeys.length > 0 ? `: ${gatewayKeys.join(', ')}` : ''}\n`);
  }
}

export function sayScreenAxisAndTemplates(screenGate, { sel, webSrc, root }) {
  if (webSrc.length > 0 || sel.templateRoots.length > 0) {
    process.stderr.write(`screen axis ${screenGate.enabled ? 'ON' : 'OFF'} (${screenGate.from}): ${screenGate.reason}\n`);
  }
  // WHERE THIS RUN LOOKS FOR A PAGE (RM48), said before the lanes run: a view
  // name resolves against exactly these roots, and a root nobody recorded is why
  // a `@Controller` would come out with no screen.
  if (sel.templateRoots.length > 0) {
    process.stderr.write(`template roots ${sel.templateRoots.length} (${sel.sources.templateRoots}): `
      + `${sel.templateRoots.map((t) => `${path.relative(root, t.root) || '.'} ${t.engine} ${t.suffix}`).join(', ')}\n`);
  }
}

export function sayDdlChoice(sel) {
  // WHICH .sql FILES WERE CLASSIFIED HOW, one line each, whenever the engine —
  // rather than the user — decided. A catalog assembled from a set nobody named
  // is only trustworthy if the set is printed.
  if (sel.ddlChoice) {
    const ch = sel.ddlChoice;
    if (ch.chosen.length > 0 || ch.skipped.length > 0) {
      process.stderr.write(`DDL classification (dialect ${ch.dialect ?? 'undetermined'}`
        + `${ch.dialectFrom === 'profile' ? ', declared in the profile' : ch.dialectFrom === 'files' ? ', taken from the files themselves' : ''}):\n`);
      for (const c of ch.chosen) {
        process.stderr.write(`  applied  ${c.path}: schema, ${c.dialect ?? 'portable'} (${c.createTables} CREATE TABLE, ${c.alters} ALTER TABLE)\n`);
      }
      for (const c of ch.skipped) {
        process.stderr.write(`  left out ${c.path}: ${c.reason}\n`);
      }
      if (ch.migrations > 0) {
        process.stderr.write(`  ${ch.migrations} migration file(s) were NOT applied. To apply them, name them yourself IN ORDER:`
          + ' `cascade analyze --ddl <schema.sql> --ddl <first-migration.sql> --ddl <next.sql>`\n');
      }
      if (ch.testFiles > 0) {
        process.stderr.write(`  ${ch.testFiles} DDL file(s) under a \`src/test/\` root were left out, the same default that keeps`
          + ' test sources out of the Java lane. Pass one with --ddl to use it anyway\n');
      }
    }
  }
}

export function sayWebWorker(webWorkerStats, { webFacts, profile, resolved, root, relOf }) {
  const t = webWorkerStats.templates;
  const u = webWorkerStats.urlByShape;
  process.stderr.write(`Web lane: ${webWorkerStats.files} file(s) (${webWorkerStats.vueFiles} .vue, ${webWorkerStats.tsFiles} .ts/.tsx, ${webWorkerStats.jsFiles} .js/.jsx`
    + `${(t.files ?? 0) > 0 ? `, ${t.files} template(s): ${Object.entries(t.byEngine ?? {}).sort().map(([e, n]) => `${n} ${e}`).join(', ')}` : ''}), `
    + `${webWorkerStats.parseErrors} parse error(s); ${webWorkerStats.callsWithUrl} call site(s) carry a URL `
    + `(${u.literal} literal, ${u.template} template, ${u.constant} constant, ${u.unresolved} unresolved), `
    + `${webWorkerStats.routes} route declaration(s), ${webWorkerStats.aliases} alias(es), ${webWorkerStats.proxies} proxy rule(s)\n`);
  if ((t.files ?? 0) > 0) {
    process.stderr.write(`  the pages: ${t.scripts ?? 0} inline script block(s), ${t.forms ?? 0} form(s), `
      + `${t.links ?? 0} link(s), ${t.includes ?? 0} include(s), `
      + `${t.contextVars ?? 0} variable(s) holding the context path\n`);
  }
  // WHAT A FILE-TREE ROUTER KEEPS BESIDE ITS PAGES (RM56). `pages/api/**` is
  // code this frontend SERVES, and a screen count with no word about it reads
  // as pages going missing.
  if ((webWorkerStats.apiFiles ?? 0) > 0) {
    process.stderr.write(`  the file tree: ${webWorkerStats.routes} page(s) declared by where they sit, `
      + `${webWorkerStats.apiFiles} file(s) under the router's api directory read as server handlers instead\n`);
  }

  for (const r of webFacts) {
    if (r.kind !== 'parse_error') continue;
    // A parse error on a real frontend file is a FINDING: that file's calls
    // and routes are absent from everything below, and nothing else would
    // say so.
    process.stderr.write(`  [warn] WEB_PARSE_ERROR ${r.file}:${r.line}:${r.col}: ${r.message}\n`);
  }
  // A ROOT NOBODY PACKAGED THAT SAID NOTHING (RM47). Discovery decided that
  // directory was served, and the run read it: if it holds no call this
  // lane could read a URL out of and no route declaration, that is worth a
  // line. A directory of somebody else's plugin scripts looks exactly like a
  // frontend from the outside, and silence there reads as "there is nothing
  // in this product", which is a different sentence.
  const vendoredRel = (profile.webRoots ?? [])
    .filter((r) => r && typeof r.root === 'string' && (r.kind ?? 'declared') === 'vendored')
    .map((r) => relOf(path.resolve(resolved.dotCascade ?? root, r.root)))
    .sort();
  const silent = vendoredRel.filter((rootRel) => {
    const under = (f) => typeof f === 'string' && (f === rootRel || f.startsWith(`${rootRel}/`));
    return !webFacts.some((r) => under(r.file)
      && ((r.kind === 'call' && r.url) || r.kind === 'route' || r.kind === 'registration'));
  });
  if (silent.length > 0) {
    process.stderr.write(`  [warn] WEB_ROOT_SAID_NOTHING ${silent.length} root(s) have no readable HTTP call `
      + `and no route declaration in them: ${listOfFive(silent)}. `
      + 'Take them out of webRoots in the profile if they are not a frontend of yours\n');
  }
}

/**
 * WHAT THE JAVA LANE, THE JPA LANE AND THE MyBatis-Plus LANE FOUND, and what
 * each of them could not resolve. Every one of these lines is reported whatever
 * the numbers, all-zero included: a rule that never fired has to be
 * distinguishable from a rule that is not there.
 *
 * @returns {Object} the lane stats the pack records, folded in the same order
 */
/**
 * WHAT THE JAVA LANE FOUND, and what it could not resolve. Every one of these
 * lines is reported whatever the numbers, all-zero included: a rule that never
 * fired has to be distinguishable from a rule that is not there.
 */
export function sayJavaLane(jstats) {
  process.stderr.write(`Java lane: ${jstats.endpoints} endpoints, ${jstats.calls} calls, ${jstats.dispatch} dispatch, ${jstats.implementsStmt} stmt-bindings `
    + `(${jstats.unresolvedCalls} unresolved, ${jstats.externalCalls} external, ${jstats.unboundMapperMethods} mapper method(s) with no statement in this pack)\n`);
  process.stderr.write(`Java lane: ${jstats.parseErrors} parse error(s) over ${jstats.parsedFiles} file(s) with facts\n`);
  // WHAT THE INHERITANCE RULES DID (RM20 §1-§2). Both are reported whatever
  // the numbers, including all-zero: "0 inherited fields" on a project with
  // no generic base class is an answer, and leaving the line out would make
  // a rule that never fired indistinguishable from a rule that is not there.
  const ir = jstats.identifierReceivers ?? { total: 0, inheritedField: 0, generatedField: 0, staticReceiver: 0, unresolved: 0 };
  process.stderr.write(`Java lane: ${ir.total} receiver(s) the file never declares: `
    + `${ir.inheritedField} resolved to a field inherited from a superclass, `
    + `${ir.generatedField ?? 0} to a field a Lombok annotation generates, `
    + `${ir.staticReceiver} are a TYPE (a static call, resolved and not followed), `
    + `${ir.unresolved} unexplained\n`);
  // WHY the calls that are still unresolved are, not just how many. The
  // count above is what a reader calibrates trust on, and one of these four
  // reasons is a thing they can fix in a minute.
  const byReason = Object.entries(jstats.unresolvedCallsByReason ?? {}).filter(([, n]) => n > 0);
  if (byReason.length > 0) {
    process.stderr.write(`Java lane: ${jstats.unresolvedCalls} call(s) still unresolved (`
      + `${byReason.map(([k, n]) => `${k} ${n}`).join(', ')})\n`);
  }
  for (const t of (jstats.typesOutsideRoots ?? []).slice(0, 3)) {
    process.stderr.write(`  [warn] TYPE_OUTSIDE_ROOTS ${t.package}.${t.simple}: ${t.calls} call(s) name it and no analyzed source root holds it. `
      + 'If the module is in this tree, pass --java-src <module>/src/main/java\n');
  }
  const im = jstats.inheritedMembers ?? { synthesized: 0, calls: 0 };
  process.stderr.write(`Java lane: ${jstats.callsByRule['interface-dispatch-inherited'] ?? 0} dispatch edge(s) to a method the implementor only INHERITS: `
    + `${im.synthesized} member(s) instantiated for their concrete class, ${im.calls} call(s) carried into them\n`);
  // The calls SPRING makes and no line of source writes. Said out loud with what
  // the rule deliberately did NOT follow beside it, so a reader can tell "there
  // are none here" from "there are some and this lane left them alone".
  const ma = jstats.modelAttribute ?? { methods: 0, edges: 0, onAdvice: 0, onSuperclass: 0, inheritedHandlers: 0 };
  if (ma.methods + ma.onAdvice + ma.onSuperclass > 0) {
    process.stderr.write(`Java lane: ${ma.methods} @ModelAttribute method(s) on a controller, ${ma.edges} handler edge(s) drawn; `
      + `${ma.onAdvice} on a @ControllerAdvice, ${ma.onSuperclass} on a base class and ${ma.inheritedHandlers} inherited handler(s) NOT followed\n`);
  }
  if (jstats.duplicateFqns.count > 0) {
    // Not a warning: a multi-module repo declaring one FQN twice is normal
    // (jeecg-boot's local-api / cloud-api pair). Said out loud so nobody
    // reading the census concludes the analysis doubled or dropped a type.
    const d = jstats.duplicateFqns;
    process.stderr.write(`Java lane: ${d.count} type(s) declared in more than one file (${d.declarations} declarations: `
      + `${Object.entries(d.byKind).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ')}): `
      + `one node each, the graph keeps the last declaration read: ${d.types.slice(0, 3).map((t) => t.fqn).join(', ')}\n`);
  }
}

/** The JPA lane's own census, and the first ten things it could not resolve. */
export function sayJpaLane(jpaStats) {
  const byType = Object.entries(jpaStats.statementsByType).filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
  process.stderr.write(`JPA lane: ${jpaStats.entities} entities (+${jpaStats.mappedSuperclasses} mapped superclass(es)), `
    + `${jpaStats.repositories} repositories, ${jpaStats.statements} statements (${byType}), `
    + `${jpaStats.joins} association join(s), ${jpaStats.unresolvedStatements} statement(s) with an unresolved part, `
    + `naming strategy ${jpaStats.namingStrategy} (${jpaStats.namingStrategyDeclared ? 'declared' : 'ASSUMED: derived names are HEURISTIC'})\n`);
  // WHAT THE FETCH PLAN LEFT OUT. A lazy association a page touches after the
  // query has run is a real read, and it happens where this lane cannot see it.
  // The number says how much of the row is behind that door.
  if (jpaStats.lazyAssociationsNotFollowed > 0) {
    process.stderr.write(`JPA lane: ${jpaStats.lazyAssociationsNotFollowed} lazy association(s) were not followed, `
      + 'so a page that touches one after the query has run makes a second query this lane does not show. '
      + 'The statements that skipped one say so in their own limits\n');
  }
  for (const u of jpaStats.unresolved.slice(0, 10)) {
    process.stderr.write(`  [warn] JPA_UNRESOLVED ${u.statement ?? '(mapping)'}: ${u.reason} (${u.detail})\n`);
  }
  if (jpaStats.unresolved.length > 10) {
    process.stderr.write(`  … ${jpaStats.unresolved.length - 10} more JPA_UNRESOLVED (all of them are on the statement nodes)\n`);
  }
}

/** The MyBatis-Plus lane's own census, generic CRUD and wrappers included. */
export function sayMpLane(mpStats) {
  const byVerb = Object.entries(mpStats.statementsByVerb).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
  process.stderr.write(`MyBatis-Plus lane: ${mpStats.entities} entities (${mpStats.entitiesTableDeclared} with @TableName), `
    + `${mpStats.statements} generic-CRUD statements (${byVerb}), `
    + `${mpStats.wrappers} condition wrapper(s): ${mpStats.wrappersWithColumns} resolved to columns, `
    + `${mpStats.wrappersRuntimeOnly} built outside the method (columns decided at run time), `
    + `${mpStats.logicDeleteRewrites} @TableLogic delete(s) rewritten as writes, `
    + `naming strategy ${mpStats.namingStrategy} (${mpStats.namingStrategyDeclared ? 'declared' : 'ASSUMED: derived names are HEURISTIC'})\n`);
  if (mpStats.sqlFragments > 0) {
    process.stderr.write(`MyBatis-Plus lane: ${mpStats.sqlFragments} raw SQL fragment(s) in wrappers; `
      + `counted where they LAND, on ${mpStats.fragmentsResolved + mpStats.fragmentsUnresolved} statement(s): `
      + `${mpStats.fragmentsResolved} read by the SQL analyzer (${mpStats.fragmentColumns} column fact(s)), `
      + `${mpStats.fragmentsUnresolved} unresolved (the text is on the statement)\n`);
  }
  if (mpStats.opsUninterpretedTotal > 0) {
    process.stderr.write(`  [warn] MP_OP_UNINTERPRETED ${mpStats.opsUninterpretedTotal} wrapper op(s) this lane has no reading for: `
      + `${Object.entries(mpStats.opsUninterpreted).map(([n, c]) => `${n} x${c}`).join(', ')}. Whatever column they name is NOT in the statements above\n`);
  }
  for (const u of mpStats.unresolved.slice(0, 10)) {
    process.stderr.write(`  [warn] MP_UNRESOLVED ${u.statement ?? '(mapping)'}: ${u.reason} (${u.detail})\n`);
  }
  if (mpStats.unresolved.length > 10) {
    process.stderr.write(`  … ${mpStats.unresolved.length - 10} more MP_UNRESOLVED (all of them are on the statement nodes)\n`);
  }
}

/**
 * The three Java-side lanes, in the order they ran, folded into the one
 * `laneStats` object the pack records.
 */
export function sayJavaLanes({ jstats, jpaStats, mpStats, runJpa, runMp }) {
  let laneStats = jstats;
  sayJavaLane(jstats);
  if (runJpa) {
    laneStats = { ...jstats, jpa: jpaStats };
    sayJpaLane(jpaStats);
  }
  if (runMp) {
    laneStats = { ...laneStats, mybatisPlus: mpStats };
    sayMpLane(mpStats);
  }
  return laneStats;
}

export function sayWebBridge(webBridgeStats, webBridgeMs) {
  const w = webBridgeStats;
  const reasons = Object.entries(w.unresolved.byReason)
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  // One line per DISTINCT answer, not per instance: a package whose four
  // clients all resolved to the same prefix has one thing to say.
  const prefixes = [...new Set(Object.entries(w.prefix).sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([dir, p]) => p.instances.map((i) => `${dir || '.'}: ${i.value === '' ? '(none)' : i.value} (${i.from})`)))]
    .join('; ') || 'none';
  process.stderr.write(`Web lane: ${w.calls.withUrl} call site(s), `
    + `${w.resolved.SOUND_SET + w.resolved.HEURISTIC} resolved (${w.resolved.SOUND_SET} sound, ${w.resolved.HEURISTIC} heuristic), `
    + `${w.unresolved.total} unresolved (${reasons}), ${w.outboundEndpoints} outside-pack; prefix ${prefixes}\n`);
  process.stderr.write(`Web lane: ${w.instances} client instance(s), ${w.wrappers.count} wrapper(s) `
    + `(deepest ${w.wrappers.maxDepth}), ${w.matches.exact} exact and ${w.matches.template} template match(es), `
    + `${w.assumedAliases} call(s) through an assumed alias; bridge ${webBridgeMs} ms\n`);
  for (const u of w.unmatchedUrls.slice(0, 5)) {
    process.stderr.write(`  [warn] WEB_NO_ROUTE ${u.url} (${u.count} call site(s)): nothing in this pack serves it\n`);
  }
  const s = webBridgeStats.screens;
  const pg = s.byKind ?? { router: 0, page: 0 };
  // …and the third kind of screen (RM56): a Nexacro form, which no route
  // declares and no handler renders. Named only where there is one.
  const forms = Number.isInteger(pg.nexacro) && pg.nexacro > 0 ? ` and ${pg.nexacro} Nexacro form(s)` : '';
  process.stderr.write(`Web lane: ${s.enabled ? `${s.screens} screen(s) from ${s.declared} route declaration(s), ${pg.page} page(s) a controller renders${forms}` : `the screen axis is off, so 0 screen(s) from ${s.declared} route declaration(s)`}, `
    + `${s.withComponent} with a component (${s.componentUnresolved} unresolved), `
    + `${s.renders.EXACT} exact, ${s.renders.SOUND_SET} candidate and ${s.renders.HEURISTIC ?? 0} heuristic RENDERS edge(s); `
    + `${w.functions.created} frontend function node(s) (${w.functions.withHttp} send a request, ${w.functions.reachingHttp} lead to one), `
    + `${w.callsEdges.EXACT + w.callsEdges.SOUND_SET + w.callsEdges.HEURISTIC} CALLS edge(s) `
    + `(${w.callsEdges.EXACT} exact, ${w.callsEdges.SOUND_SET} sound, ${w.callsEdges.HEURISTIC} heuristic; `
    + `${w.callsByRule['passed-as-value'] ?? 0} of them a function handed over as a value)\n`);
  // THE PAGES (RM48). A template a handler names is a page; one nothing
  // names is a fragment or dead markup, and saying how many of each is what
  // stops a silence from reading as "this application has no pages".
  const tp = webBridgeStats.templates;
  if (tp && tp.files > 0) {
    process.stderr.write(`Web lane: ${tp.files} template(s) (${Object.entries(tp.byEngine).sort().map(([e, n]) => `${n} ${e}`).join(', ')}), `
      + `${tp.rendered} of them rendered by a handler or pulled into one, ${tp.unrendered} named by nothing; `
      + `${tp.views} handler(s) name a view (${tp.viewNames} view name(s), ${tp.redirects} redirect(s), `
      + `${tp.unresolvedViews} return(s) this engine could not read)\n`);
    for (const u of (tp.unresolvedViewNames ?? []).slice(0, 5)) {
      process.stderr.write(`  [warn] VIEW_NAME_UNRESOLVED ${u.name} (${u.count} handler(s)): no template under a declared template root answers to that name, so that page is not here\n`);
    }
  }
  for (const u of s.unresolvedSpecifiers.slice(0, 5)) {
    process.stderr.write(`  [warn] SCREEN_COMPONENT_UNRESOLVED ${u.specifier} (${u.count} route declaration(s)): this lane read no file at that specifier, so those screens render nothing\n`);
  }
  for (const u of (s.unresolvedNames ?? []).slice(0, 5)) {
    process.stderr.write(`  [warn] SCREEN_COMPONENT_UNREGISTERED ${u.name} (${u.count} time(s)): nothing in the files this lane read registers that name, so no edge was drawn for it\n`);
  }
  if (s.serverDriven.detected) {
    process.stderr.write(`  [warn] SCREENS_FROM_SERVER a call fetches the menu (${s.serverDriven.menuEndpoints.join(', ')}) and ${s.declared} route(s) are declared in the source: `
      + `${s.declared < s.serverDriven.ceiling ? 'most screens arrive when the app runs' : `screens beyond the ${s.declared} declared arrive when the app runs`}, `
      + 'so the screens here are the ones the source states, not the ones the product has\n');
  }
}

export function sayHarLane(harStats) {
  process.stderr.write(`HAR lane: ${harStats.files} recording(s), ${harStats.entries} request(s): `
    + `${harStats.matched} matched a route this pack serves, ${harStats.unmatched} matched none, ${harStats.assets} static asset(s); `
    + `${harStats.pairs} screen-to-route pair(s) observed over ${harStats.screensObserved} screen(s) and ${harStats.endpointsObserved} route(s), `
    + `${harStats.pagesWithoutScreen} page(s) the source never declared\n`);
  for (const u of harStats.unreadable) {
    process.stderr.write(`  [warn] HAR_UNREADABLE ${u.file}: ${u.reason}\n`);
  }
  for (const u of harStats.unmatchedPaths.slice(0, 5)) {
    process.stderr.write(`  [warn] HAR_NO_ROUTE ${u.method} ${u.path} (${u.count} request(s)): nothing in this pack serves it, so the recording says the browser asked for something this analysis cannot place\n`);
  }
}

/**
 * What really ran, beside what could really run. The bridge itself ran inside
 * `assembleGraph` (it needs every node the other lanes put in the graph); this
 * is its census.
 */
export function sayRuntimeEvidence(runtimeStats, otelTraces) {
  // ---- the TRACES: what really ran, beside what could really run --------
  // The bridge itself ran inside `assembleGraph` above (it needs every node
  // the other lanes put in the graph). This is its census.
  if (runtimeStats) {
    const rs = runtimeStats;
    // A file read as an AGENT LOG says so, with the lines it could not use, so
    // a reader who pointed at the wrong log sees a count of nothing rather
    // than a silent pass.
    for (const rec of otelTraces) {
      if (rec.form !== 'log') continue;
      process.stderr.write(`Runtime evidence: ${rec.file} was read as an agent log, one export per line: `
        + `${rec.spans} span(s) in it, ${rec.skippedLines} line(s) carried none\n`);
    }
    process.stderr.write(`Runtime evidence: ${rs.files} trace(s), ${rs.spans} span(s) (${rs.unusable} carried nothing this lane reads), `
      + `${rs.observations} observation(s): ${rs.matched.dispatch} dispatch, ${rs.matched.statement} statement and ${rs.matched.endpoint} route observation(s) matched this pack, `
      + `${rs.unmatched.dispatch + rs.unmatched.statement + rs.unmatched.endpoint} matched none\n`);
    process.stderr.write(`Runtime evidence: ${rs.edgesObserved} static edge(s) marked observed `
      + `(${rs.dispatchDirect} a call the source states, ${rs.dispatchThroughInterface} a candidate set the trace narrowed), `
      + `${rs.edgesAdded} RUNTIME_ONLY edge(s) added for a hop no static rule explains, `
      + `${rs.statementsObserved} statement(s) and ${rs.endpointsObserved} route(s) observed`
      + `${rs.window ? `, window ${rs.window.from} to ${rs.window.to}` : ''}\n`);
    process.stderr.write('Runtime evidence: a grade was neither raised nor lowered by any of this. '
      + 'What the trace did not visit is unknown, not absent\n');
    for (const u of rs.unreadable) {
      process.stderr.write(`  [warn] OTEL_UNREADABLE ${u.file}: ${u.reason}\n`);
    }
    for (const u of rs.unmatchedKeys.slice(0, 5)) {
      process.stderr.write(`  [warn] OTEL_NO_MATCH ${u.kind} ${u.key} (${u.count} observation(s)): the trace saw it and nothing in this pack is keyed that way\n`);
    }
  }
}

/**
 * The drift census, in the two directions that matter: routes a document
 * declares that nothing here serves, and routes this code serves that no
 * document mentions. Both are findings, and neither is visible from one source
 * alone.
 */
export function sayOpenApiLane(openapiStats) {
  // ---- the OpenAPI bridge's own line (RM29) -----------------------------
  // The drift census, in the two directions that matter: routes a document
  // declares that nothing here serves, and routes this code serves that no
  // document mentions. Both are findings, and neither is visible from one
  // source alone.
  if (openapiStats) {
    process.stderr.write(`OpenAPI lane: ${openapiStats.paths} declared route(s) over ${openapiStats.documents.length} document(s): `
      + `${openapiStats.matchedServed} also served by this code, ${openapiStats.onlyInDocument} declared and not served, `
      + `${openapiStats.onlyInCode} served and not declared\n`);
    for (const id of openapiStats.drift.onlyInDocument.slice(0, 5)) {
      process.stderr.write(`  [warn] OPENAPI_NOT_SERVED ${id.slice('endpoint:'.length)}: a document declares it and nothing in this pack handles it\n`);
    }
    for (const id of openapiStats.drift.onlyInCode.slice(0, 5)) {
      process.stderr.write(`  [warn] OPENAPI_NOT_DECLARED ${id.slice('endpoint:'.length)}: this code serves it and no document read here declares it\n`);
    }
  }
}

/**
 * WHAT THIS RUN PRODUCED, last, so it is the thing still on screen: the pack
 * and its digest, the routes index beside it, the axes it declares, and what it
 * recomputed against what it reused. A reader can tell a cold run from an
 * incremental one — and see why a cold one was cold — from these lines alone.
 */
export function sayResult({ writeDir, writeIndexFile, pack, routesIndex, axes, lanes, st, plan, result, projectId, base, webSrc, mappers, ddls }) {
  process.stderr.write(`wrote ${path.join(writeDir, 'pack.json')}: ${pack.counts.nodes} nodes, ${pack.counts.edges} edges, lanes [${lanes.join(',')}], digest ${pack.digest}\n`);
  process.stderr.write(`routes index: ${routesIndex.serves.length} served, ${routesIndex.calls.length} outbound\n`);
  process.stderr.write(`axes: ${Object.entries(axes).map(([k, v]) => `${k}=${v.status}`).join(' ')}\n`);
  // The web lane's own reuse line, in the same words as the Java lane's, so a
  // reader can see which of the two paid for this run.
  const webLine = webSrc.length === 0 ? '' : (st.mode === MODE_COLD
    ? `, read ${st.reparsedWeb} web file(s)`
    : `, reparsed ${st.reparsedWeb} web file(s) (${st.reusedWeb} reused, ${st.droppedWeb} dropped)`);
  process.stderr.write(st.mode === MODE_COLD
    ? `cold (${st.reason}): parsed ${st.reparsedJava} java file(s)${webLine}, ${st.recomputedLineage} lineage shard(s) over ${st.statements} statement(s), pack digest ${pack.digest}\n`
    : `incremental: reparsed ${st.reparsedJava} java files (${st.reusedJava} reused, ${st.droppedJava} dropped)${webLine}, `
      + `lineage recomputed ${st.recomputedLineage} statements (${st.reusedLineage} reused), `
      + `mapper statements ${mappers.length === 0 ? 'not run' : st.statementsReused ? 'reused' : 'recomputed'}, `
      + `catalog ${ddls.length === 0 ? 'not run' : st.catalogReused ? 'reused' : 'recomputed'}, `
      + `pack digest ${pack.digest}\n`);
  for (const n of plan.notes ?? []) process.stderr.write(`  note: ${n}\n`);
  const shardLanes = Object.values(result.index.files);
  process.stderr.write(`facts index ${writeIndexFile}: ${shardLanes.filter((e) => e.lane !== 'web').length} java shard(s), `
    + `${shardLanes.filter((e) => e.lane === 'web').length} web shard(s), `
    + `${Object.keys(result.index.statements).length} lineage shard(s)${projectId ? ` in ${cacheDir(projectId, process.env)}/cas` : ' (IN MEMORY: not reusable, see above)'}\n`);
  if (base?.dirty) {
    process.stderr.write(`base ${base.commit.slice(0, 12)} + ${base.dirtyFiles.length} DIRTY analysis input(s): this pack describes the WORKING TREE, not that commit: `
      + `${base.dirtyFiles.slice(0, 5).join(', ')}${base.dirtyFiles.length > 5 ? `, … ${base.dirtyFiles.length - 5} more` : ''}\n`);
}
}
