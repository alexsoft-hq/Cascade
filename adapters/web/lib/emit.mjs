// emit.mjs — the record STREAM: its order, and the summary that counts it.
//
// WHAT THIS MODULE OWNS. Every fact this worker finds is one JSON line, and two
// things about that stream are contracts rather than conveniences:
//
//   THE ORDER. Files in sorted path order; within a file, by LINE, then the
//   `file` record first, then by kind, then by the order the walk found them.
//   An incremental run assembles the stream from cached shards, and two
//   assemblies of the same shards have to print the same bytes, or every pack
//   digest becomes a coin toss.
//
//   THE SUMMARY. The last line counts what the lines before it said, field by
//   field, so `cascade analyze` can print a lane line and a reader can check the
//   count against the records rather than take it.
//
// WHAT IT MUST NEVER KNOW ABOUT: the syntax tree, the declaration packs, the
// file walk. It is handed records and hands back an order and a tally.

/** A fresh, empty summary: every field the stream will be counted into. */
export function emptyCounts({ files, parseErrors, recoveredErrors, envFiles, apiFiles = 0 }) {
  const counts = {
    files, parseErrors, recoveredErrors,
    // The server handlers a file-tree router keeps beside its pages (RM56):
    // `pages/api/**` is code this frontend SERVES, not a screen. Counted so a
    // census can say how many pages it is not.
    apiFiles,
    vueFiles: 0, tsFiles: 0, jsFiles: 0, skippedFiles: 0,
    imports: 0, exports: 0, functions: 0, constants: 0, bindings: 0,
    classes: 0, assigns: 0,
    calls: 0, callsWithUrl: 0,
    urlByShape: { literal: 0, template: 0, constant: 0, unresolved: 0 },
    methodBySource: { 'callee-name': 0, config: 0, positional: 0 },
    routes: 0, byPack: {}, aliases: 0, proxies: 0, envRecords: 0,
    envFiles,
    platformSinks: { fetch: 0, xhr: 0, jquery: 0 },
    // The server-rendered pages this run read (RM48): how many template files,
    // how many inline `<script>` blocks went through the JavaScript reader, and
    // how many call sites came out of a form, a link or an include.
    templates: {
      files: 0, byEngine: {}, scripts: 0, forms: 0, links: 0, includes: 0, contextVars: 0,
    },
    // What a frontend written before modules put in the stream (RM47): the
    // names the framework's own registry holds, the templates read for their
    // tags, and the calls that went through a client the framework injected.
    registrations: { component: 0, controller: 0, directive: 0 },
    templatesRead: 0,
    injectedCalls: 0,
  };
  return counts;
}

/** A `file` record comes before everything else written on line 1 of that file. */
const KIND_RANK = (k) => (k === 'file' ? 0 : 1);

/**
 * One file's records in the order the stream prints them.
 *
 * Sorted rather than appended, because the walk finds a call inside a function
 * before it finds the function's own record, and a reader (and a shard) needs
 * the file read top to bottom.
 */
export function orderRecords(recs) {
  return recs.slice().sort((a, b) => (
    a.line - b.line
    || KIND_RANK(a.rec.kind) - KIND_RANK(b.rec.kind)
    || (a.rec.kind < b.rec.kind ? -1 : a.rec.kind > b.rec.kind ? 1 : 0)
    || a.order - b.order
  ));
}

/** Add one record to the summary. */
export function tally(rec, counts) {
  switch (rec.kind) {
    case 'file':
      if (rec.lang === 'template' || rec.lang === 'nexacro') counts.templates.files += 1;
      else if (rec.lang === 'vue') counts.vueFiles += 1;
      else if (rec.lang === 'ts' || rec.lang === 'tsx') counts.tsFiles += 1;
      else { counts.jsFiles += 1; if (rec.apiHandler === true) counts.apiFiles += 1; }
      if (rec.skipped) counts.skippedFiles += 1;
      break;
    case 'template':
      counts.templates.byEngine[rec.engine] = (counts.templates.byEngine[rec.engine] ?? 0) + 1;
      counts.templates.scripts += rec.scripts ?? 0;
      counts.templates.forms += rec.forms ?? 0;
      counts.templates.links += rec.links ?? 0;
      counts.templates.includes += (rec.includes ?? []).length;
      counts.templates.contextVars += (rec.contextVars ?? []).length;
      break;
    case 'import': counts.imports += 1; break;
    case 'export': counts.exports += 1; break;
    case 'function': counts.functions += 1; break;
    case 'constant': counts.constants += 1; break;
    case 'binding': counts.bindings += 1; break;
    case 'class': counts.classes += 1; break;
    case 'assign': counts.assigns += 1; break;
    case 'route':
      counts.routes += 1;
      counts.byPack[rec.pack] = (counts.byPack[rec.pack] ?? 0) + 1;
      if (typeof rec.templateFile === 'string') counts.templatesRead += 1;
      break;
    case 'registration':
      counts.registrations[rec.what] = (counts.registrations[rec.what] ?? 0) + 1;
      if (typeof rec.templateFile === 'string') counts.templatesRead += 1;
      break;
    case 'config':
      if (rec.what === 'alias') counts.aliases += 1;
      else if (rec.what === 'proxy') counts.proxies += 1;
      else if (rec.what === 'env') counts.envRecords += 1;
      break;
    case 'call': {
      counts.calls += 1;
      if (typeof rec.platformSink === 'string') {
        counts.platformSinks[rec.platformSink] = (counts.platformSinks[rec.platformSink] ?? 0) + 1;
      }
      if (rec.injected) counts.injectedCalls += 1;
      if (rec.method && rec.method.from) {
        counts.methodBySource[rec.method.from] = (counts.methodBySource[rec.method.from] ?? 0) + 1;
      }
      if (rec.url) {
        counts.callsWithUrl += 1;
        const first = rec.url.resolved && rec.url.resolved[0];
        if (!first) counts.urlByShape.unresolved += 1;
        else if (first.via === 'literal') counts.urlByShape.literal += 1;
        else if (first.via === 'template') counts.urlByShape.template += 1;
        else counts.urlByShape.constant += 1;
      }
      break;
    }
    default: break;
  }
}
