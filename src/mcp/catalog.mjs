// catalog.mjs — the MCP tool catalog + single dispatcher (SPEC §13).
//
// One source of truth for tool name/description/inputSchema, and one place that
// runs a tool and returns its contract-valid response (or a structured error —
// never a silent failure, §9/§17.4). Both transports (stdio relay, HTTP) speak
// this same catalog, so they cannot drift.
//
// Descriptions state what each tool answers AND what it cannot — the AI reads
// the description to choose a tool, so honesty here is part of the contract.

import * as tools from './tools.mjs';
import * as codeTools from './tools_code.mjs';
import { pack_diff } from './tools_diff.mjs';
import { summary } from './tools_summary.mjs';
import { rules } from './tools_rules.mjs';
import { assertContract } from './contract.mjs';
import { axisLimits, axisKnownGaps } from '../core/lanes.mjs';

export const CATALOG_SCHEMA = 'cascade:mcp-catalog:1';

export const TOOLS = Object.freeze({
  architecture: {
    description: 'Directed module dependencies from recorded imports and calls, with grades and evidence examples. Directory groups are inferred, not business modules. Lists page independently with limit/offset; maxBytes bounds answer JSON.',
    inputSchema: { type: 'object', properties: { depth: { type: 'integer', minimum: 1, maximum: 8 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 2048, maximum: 262144 } } },
    fn: codeTools.architecture,
  },
  session_briefing: {
    description: 'Start a coding session with a copyable summary, directed module connections, recorded API/screen entrypoints, freshness and coverage. Uses selected persisted inputs; no inferred business intent. maxBytes bounds answer JSON, not tokens.',
    inputSchema: { type: 'object', properties: { depth: { type: 'integer', minimum: 1, maximum: 8 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 4096, maximum: 262144 } } },
    fn: codeTools.session_briefing,
  },
  code_trace: {
    description: 'Trace recorded declaration calls/references, including intermediate functions. Callback references are not execution proof; grades belong to original edges, not inferred paths. Partial analyzed coverage; maxBytes bounds answer JSON, not tokens.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string', minLength: 1 }, direction: { type: 'string', enum: ['inbound', 'outbound', 'both'] }, depth: { type: 'integer', minimum: 1, maximum: 8 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 2048, maximum: 262144 } }, required: ['symbol'] },
    fn: codeTools.code_trace,
  },
  code_search: {
    description: 'Find analyzed files and declarations by name/path substring in the persisted index. Stable paginated results; missing matches do not prove absence.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['all', 'file', 'declaration'] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } }, required: ['query'] },
    fn: codeTools.code_search,
  },
  file_outline: {
    description: 'Declarations recorded for one exact analyzed file, ordered by source line. Includes extent and coverage; this is not a full language-server outline.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } }, required: ['file'] },
    fn: codeTools.file_outline,
  },
  code_context: {
    description: 'Bounded task context: ranked name/path matches and adjacent recorded relations. maxBytes bounds answer JSON UTF-8 bytes, not tokens or the contract envelope. Omitted counts disclose cuts.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 1024, maximum: 262144 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['query'] },
    fn: codeTools.code_context,
  },
  code_snippet: {
    description: 'Read current source for an exact declaration id with exact extent, or a known file/range. Requires a matching indexed source hash and repository containment; rejects stale or unknown source. maxBytes bounds snippet text.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, file: { type: 'string' }, fromLine: { type: 'integer', minimum: 1 }, toLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 1000 }, maxBytes: { type: 'integer', minimum: 256, maximum: 262144 } } },
    fn: codeTools.code_snippet,
  },
  index_status: {
    description: 'Structure generation, recorded coverage, counts and live refresh status. A missing sidecar or incomplete coverage never means the repository has no code.',
    inputSchema: { type: 'object', properties: {} },
    fn: codeTools.index_status,
  },
  overview: {
    description: 'Pack census, route-to-table reach, code-axis counts, hubs, gaps and remedies. Read axes first: degraded axes make counts lower bounds; absent axis differs from zero. Unresolved-call count may be unknown. Unreached statements are not proven dead code. Mode defaults conservative; strict may exclude all call paths. Default depth has no hop cap (node cap still applies). Kind/type/grade censuses are complete; hubs and reach samples are capped at10 with true totals in truncated. Federation counts outbound routes separately from call sites, registered answering projects and unmatched routes. Diagnostics/gaps may carry remedy, count and examples; null remedy means no known single fix. groupRule distinguishes path grouping from declared attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'a narrowing: hops walked from each handler (default: no hop cap)' },
      },
    },
    fn: tools.overview,
  },
  search: {
    description:
      'Find a table, column or SQL statement by part of its name. This is the usual way in. '
      + 'It matches names and business comments, and not source-code full text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2 }, limit: { type: 'integer' } },
      required: ['query'],
    },
    fn: tools.search,
  },
  browse: {
    description: 'Paged table/column/statement/endpoint/symbol/screen census. Counts use the same conservative-by-default forward walk as flow, no hop cap; inspect limits for exclusions. Missing screen axis omits screens counts, not zero. kind=symbol requires query of2+ characters. Query matches IDs/comments/files/handlers case-insensitively, not source full text. table restricts columns. Sort: table statements|endpoints|groups|columns|name; column writes|reads|endpoints|name; statement tables|name; endpoint tables|statements|path; screen endpoints|tables|name; symbol name. Defaults busiest first; stable offset pagination. Empty not-shipped means missing axis, not absence.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['table', 'column', 'statement', 'endpoint', 'symbol', 'screen'] },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'], description: 'which grades the census walk follows; every count on every row is walked in it (default conservative)' },
        query: { type: 'string', description: 'case-insensitive substring; required (2+ chars) for kind=symbol' },
        table: { type: 'string', description: 'kind=column only: list just this table\'s columns' },
        sort: { type: 'string', description: 'a field of the row; the default is the busiest-first one for the kind' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'rows per page: 1..500 (default 200)' },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['kind'],
    },
    fn: tools.browse,
  },
  column_impact: {
    description:
      'If I change this column, which SQL statements read or write it? mode=read|write|both. '
      + 'This answers the statement (mapper) axis, where every edge is EXACT. For the HTTP '
      + 'endpoints above those statements, use endpoint_impact.',
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', description: 'schema.table.column or table.column' },
        mode: { type: 'string', enum: ['read', 'write', 'both'] },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
      required: ['column'],
    },
    fn: tools.column_impact,
  },
  endpoint_impact: {
    description:
      'If I change this column, which HTTP endpoints are affected? Walks the code axis '
      + '(column <- statement <- mapper <- service <- controller <- endpoint). Each endpoint '
      + 'carries the weakest link on its path: the SQL links are EXACT, but the call chain is '
      + 'SOUND_SET, which means the call may happen and we could not prove it, so endpoints '
      + 'come back SOUND_SET rather than confirmed. Empty reason "not-shipped" means the pack '
      + 'has no code axis, because the Java lane did not run; "none" means the code axis is '
      + 'there but no endpoint reaches this column. On a pack WITH a screen axis every row also '
      + 'carries `screens: {count, sample}`: the screens on the other side of that route, up to '
      + 'five of them named; ask `screen_impact` for the whole list. mode=strict|conservative|'
      + 'heuristic (default conservative). ON A SERVER THAT SERVES SEVERAL PROJECTS the answer '
      + 'crosses HTTP: a route in ANOTHER registered project that calls one of these routes is '
      + 'affected too, and comes back as a row carrying `project`. `answer.federation` says what '
      + 'was crossed, what was skipped and why, `basis.siblings` names every other pack this '
      + 'answer walked, and a row from another project carries no `screens` because its screens '
      + 'are that project\'s question. federate=false answers from this pack alone.',
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', description: 'schema.table.column or table.column' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        federate: { type: 'boolean', description: 'default true: follow HTTP calls into the other projects this server serves' },
        federationHops: { type: 'integer', minimum: 0, maximum: 8, description: 'how many crossings one answer may chain (default 3)' },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
      required: ['column'],
    },
    fn: tools.endpoint_impact,
  },
  screen_impact: {
    description:
      'If I change this column, table, statement or method, which SCREENS are affected? The far '
      + 'end of the round trip: it walks the same chain endpoint_impact does and carries it two '
      + 'lanes further out, through the frontend\'s own calls and the RENDERS edge from a route\'s '
      + 'component. Pass exactly one of column / table / statement / symbol. Each row is {screen '
      + '(its composed router path), label, grade, endpoints (the affected routes THIS screen goes '
      + 'through), observed}. The grade is the weakest link on the path, so a screen reached '
      + 'through one MAY_CALL is SOUND_SET even where the RENDERS edge itself is EXACT. `observed` '
      + 'is true when a browser recording (--har) confirms that screen really called one of those '
      + 'routes: it is a MARKER beside the grade, never a grade, and a RUNTIME_ONLY edge is below '
      + 'every mode\'s floor so no walk ever follows one. Empty "not-shipped" means this pack has '
      + 'no screen axis, because no router was read or screenAxis.enabled is false; "none" means '
      + 'the axis is there and no screen reaches this. mode=strict|conservative|heuristic (default '
      + 'conservative).',
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', description: 'schema.table.column or table.column' },
        table: { type: 'string' },
        statement: { type: 'string' },
        symbol: { type: 'string', description: 'owner#method' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
    },
    fn: tools.screen_impact,
  },
  transactions: {
    description:
      'The @Transactional boundaries, and what one commit can touch: the tables and columns '
      + 'reachable from the boundary method through the call graph. With method=<owner#name> '
      + 'you get one transaction\'s full column lists; without it, the list with '
      + 'per-transaction counts. The boundary itself is definitional (EXACT); the footprint '
      + 'follows the call graph (SOUND_SET). Empty "not-shipped" means there is no code axis; '
      + '"none" means the code axis is there but no @Transactional was found.',
    inputSchema: {
      type: 'object',
      properties: { method: { type: 'string', description: 'owner#name of a @Transactional method' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
    },
    fn: tools.transactions,
  },
  flow: {
    description: 'Graded impact chain; use code_trace for recorded intermediate declarations. Down: endpoint, symbol or screen to services/statements/tables; without a target lists endpoints (or kind=screen). Up: exactly one endpoint/column/table/statement/symbol to callers/routes/screens; no upstream list or screen target. Hop0 is handler/method/target. Rows carry weakest path grade; strict may exclude calls, so empty is not proof of absence. Default no hop cap, bounded by node cap; depth narrows traversal and beyond-cap results remain unknown. layers is an uncut census of walked nodes, not beyond-cap derived endpoints/tables; walk.beyond discloses those. Handler targets include their own route at hop1. Missing axes use not-shipped; upstream statement/symbol statements lane uses not-in-this-axis. observed is recording evidence, not an execution step. offset pages each lane independently: retain only that lane when following its nextOffset. Federation defaults on: crosses registered HTTP routes using committed sibling packs (not overlays), weakest crossing SOUND_SET at best, HEURISTIC if uncertain; rows carry project/federated/viaHttp, basis.siblings names packs, unmatched/skipped are disclosed. walk/layers describe only this project. compact=true deduplicates paths and bounds answer bytes; full mode remains default.',
    inputSchema: {
      type: 'object',
      properties: {
        compact: { type: 'boolean', description: 'default false; deduplicate paths and bound answer bytes when true' },
        maxBytes: { type: 'integer', minimum: 4096, maximum: 262144, description: 'compact=true only: answer byte budget, default 32768' },
        endpoint: { type: 'string', description: '"METHOD /path" key of an endpoint node: down, the code it runs; up, what calls it' },
        screen: { type: 'string', description: 'direction=down entry: a screen\'s composed router path, e.g. "/things/list"' },
        kind: { type: 'string', enum: ['endpoint', 'screen'], description: 'list mode only: which entries to list (default endpoint)' },
        symbol: { type: 'string', description: 'owner#method: the method to walk down from, or up from' },
        direction: { type: 'string', enum: ['down', 'up'], description: 'down (default): what this call runs through. up: which endpoints and screens can reach this target' },
        column: { type: 'string', description: 'direction=up target: schema.table.column or table.column' },
        table: { type: 'string', description: 'direction=up target: a table' },
        statement: { type: 'string', description: 'direction=up target: a mapper statement id' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'a narrowing: the most hops walked. Left out, a walk has no hop cap (both directions), as every census and impact tool walks' },
        limit: { type: 'integer', description: 'per-list cut: 1..200 (default 40) in chain mode, 1..500 (default 100) listing endpoints' },
        query: { type: 'string', description: 'list mode only: substring over "METHOD path handler"' },
        offset: { type: 'integer', minimum: 0, description: 'list mode: skip this many entries. Chain mode: cut every lane from here, in the walk\'s order, to fetch the next page of one lane' },
        federate: { type: 'boolean', description: 'default true: follow HTTP calls into the other projects this server serves' },
        federationHops: { type: 'integer', minimum: 0, maximum: 8, description: 'how many crossings one answer may chain (default 3)' },
      },
    },
    fn: tools.flow,
  },
  erd: {
    description:
      'An ERD recovered from the joins the mapper SQL makes, because this schema has no '
      + 'foreign keys. With table=<name> you get that table\'s join neighborhood (within '
      + 'hops) WITH its columns; without it, the whole-schema overview: tables, column counts '
      + 'and every relationship. Each table carries its `family`, by the one rule `summary` reads '
      + 'table names with (`familyRule` says it), so a table is in the same family on both. '
      + 'Each relationship carries the join columns and how many '
      + 'statements make that join, graded EXACT because the join is literal in the SQL. '
      + '`limit` caps the tables drawn (default 400, max 5000). Past it we keep the '
      + 'most-joined tables and always the focus table, `truncated.tables.total` is the true '
      + 'number in scope and `limits` says how many went. An ERD of a 4 000-table schema is '
      + 'megabytes, so this answer is bounded rather than silently large. ON A SERVER THAT '
      + 'SERVES SEVERAL PROJECTS the whole-schema view also carries `federated`: one entry per '
      + 'registered project a request from THIS project reaches over HTTP, with {project, '
      + 'buildDigest, tables, relationships, via}. `tables` are only the tables the walk from '
      + 'the crossed route(s) reaches there, `relationships` are THAT project\'s own joins '
      + 'between exactly those tables, and `via` names the route each cluster was reached '
      + 'through ({route, fromEndpoint, grade, ambiguous, tables}). NO RELATIONSHIP EVER JOINS '
      + 'TWO PROJECTS: two services share no foreign key, so the only thing connecting the '
      + 'clusters is the HTTP call `via` names. The crossing walk runs at mode=conservative, '
      + 'no hop cap (this tool takes no mode or depth of its own) and `limits` says so. '
      + '`answer.federation` says what was crossed, what was skipped and why, and '
      + '`basis.siblings` names every other pack this answer read. Ask a sibling table\'s '
      + 'columns of that project (`erd table=<name>` with its `project`). federate=false '
      + 'answers from this pack alone, byte for byte as it did before federation existed.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' }, hops: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 5000 },
        federate: { type: 'boolean', description: 'default true: follow HTTP calls into the other projects this server serves' },
        federationHops: { type: 'integer', minimum: 0, maximum: 8, description: 'how many crossings one answer may chain (default 3)' },
      },
    },
    fn: tools.erd,
  },
  coupling: {
    description: 'Database-mediated writer→reader group pairs, not direct calls. Groups use first route segment below deployment prefix unless declared otherwise; inferred groups are not business boundaries. axis=column default; table uses EXECUTES access. Statements belong to every group whose handlers reach them in the requested mode/depth (default conservative, no hop cap). Ranked pairs page with shared items; cells retain the whole count matrix. Shared statements reached by3+ groups are disclosed with capped samples; viaShared counts items carried only by such statements on at least one side. Self-only/write-only/read-only items are counted separately. Inspect walk cuts and mode exclusions before interpreting empty results; not-shipped means missing code axis.',
    inputSchema: {
      type: 'object',
      properties: {
        axis: { type: 'string', enum: ['column', 'table'], description: 'what two groups share (default column)' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'a narrowing: hops walked from each endpoint (default: no hop cap)' },
        limit: { type: 'integer', description: 'pairs per page: 1..500 (default 50)' },
        offset: { type: 'integer' },
      },
    },
    fn: tools.coupling,
  },
  map: {
    description: 'Bounded whole-pack relation map: inferred route groups, endpoints, reached tables and SQL joins; neighborhood focuses one node. Groups are naming patterns unless declared. touches aggregates access per endpoint/table; grade is strongest available path, each path graded by weakest link. layers statements replaces touch shortcuts with execute steps; screens adds screens reaching drawn routes (others counted, not drawn). Default conservative walk has no hop cap; strict can remove call reachability. Node limit and measured nodes+links maxBytes cut by kind, retaining connected nodes and groups; summary/limits disclose cuts and omitted tables. Federation adds only reached sibling routes, namespaced project IDs and project portals, never merges tables or infers cross-project joins. Read federation/basis.siblings for crossings and limits; sibling data comes from committed packs, not overlays. Missing code axis means not-shipped, not no dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'a narrowing: hops walked from each endpoint (default: no hop cap)' },
        federate: { type: 'boolean', description: 'default true: follow HTTP calls into the other projects this server serves' },
        federationHops: { type: 'integer', minimum: 0, maximum: 8, description: 'how many crossings one answer may chain (default 3)' },
        layers: {
          type: 'array', items: { type: 'string', enum: ['statements', 'screens'] },
          description: 'optional extra layers: "statements" and "screens" (default: neither)',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20000, description: 'node cap: 1..20000 (default 6000)' },
        maxBytes: { type: 'integer', minimum: 65536, maximum: 8388608, description: 'answer budget in MEASURED bytes of nodes+links: 65536..8388608 (default 524288)' },
      },
    },
    fn: tools.map,
  },
  neighborhood: {
    description:
      'The graph slice around one focus node, for a visual graph or impact view. Focus it '
      + 'with node="<kind>:<key>" or with column/table/statement/endpoint/symbol. '
      + 'direction=up walks to what depends on it (towards endpoints), down to what it '
      + 'reaches (towards columns), and both does either way. Returns nodes and graded edges, '
      + 'capped by limit, with the same grades the query tools report.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'full node id "<kind>:<key>"' },
        column: { type: 'string' }, table: { type: 'string' }, statement: { type: 'string' },
        endpoint: { type: 'string' }, symbol: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'both'] },
        hops: { type: 'integer' }, limit: { type: 'integer' },
      },
    },
    fn: tools.neighborhood,
  },
  changed_impact: {
    description:
      'The working-tree overlay: I edited these files, so what would it affect? On a server '
      + 'with a git base the dirty files are RE-PARSED on each call, and the answer describes '
      + 'the bytes on disk rather than the last analyzed ones. It returns the HTTP endpoints '
      + 'above and the DB columns below what you changed. `answer.overlay` carries the '
      + 'overlaySessionId, the sha256 of every dirty document, and which files were parsed or '
      + 'dropped. A row marked `provisional:true` exists ONLY in the overlay, because no '
      + 'certified run has seen it, so report it as a candidate rather than as confirmed, and '
      + 'freshness is then provisional-overlay. If HEAD moved past the pack, the overlay is '
      + 'DISCARDED and freshness is `behind`: run `cascade analyze`. Pass "files" to ask '
      + 'about specific paths instead of the live diff. A changed file with no node is listed '
      + 'in files.unmatched, where "0 impact" means unknown rather than safe. Grades are '
      + 'weakest-link, so endpoints reached through the call graph are SOUND_SET.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'changed paths (repo-root relative); optional if the server has a git base' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
    },
    fn: tools.changed_impact,
  },
  summary: {
    description:
      'The whole pack in about ten boxes a side, for a reader who needs the shape of the system '
      + 'before any one route: groups of routes by where their handler code sits, the table families '
      + 'they reach, and a link per group and family with the tables, routes and weakest grade behind '
      + 'it. Every box lists its members, so a group opens down to its routes and a family to its '
      + 'tables. READ `limits`: unless the profile declares moduleAttribution.packageDepth, a group is '
      + 'read from the package tree (below the package every handler shares) and a family from the '
      + 'words of the table names, which are patterns and not declared modules; a join table a rule '
      + 'pack names (Prisma\'s `_OrderToTag`) goes with the tables it joins. Families are read over every table '
      + 'of the pack, so `erd` puts a table in the same one. Groups are kept by how many routes they hold, families '
      + 'by how many routes reach them and then by size; the boxes past `limit` are folded '
      + 'into `otherGroups` and `otherFamilies`, and their links into an `(others)` box, so nothing '
      + 'the walk reached is dropped. Name one `endpoint` or one `table` and `answer.through` also '
      + 'carries the paths through it: a route\'s families with the tables it reaches in each, or a '
      + 'table\'s groups with the routes that reach it, each with the weakest grade on the way.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] }, depth: { type: 'integer' }, limit: { type: 'integer' },
        endpoint: { type: 'string', description: 'one route, "VERB /path", whose paths through the boxes to add' },
        table: { type: 'string', description: 'one table whose paths through the boxes to add' },
      },
    },
    fn: summary,
  },
  pack_diff: {
    description:
      'What changed between two packs of ONE project: the routes, screens, tables, columns, '
      + 'statements and symbols that appeared or went away, the edges that appeared, went away or '
      + 'changed grade; changed node attributes (such as a column type or transaction marker); changed '
      + 'edge evidence (such as access); and source-location-only moves separately. It keeps the exact '
      + 'base and head values, including missing versus null and duplicate edge records. The endpoints and '
      + 'screens above additions, removals, regrades and content changes are a static upstream result from '
      + 'both packs; location-only moves do not add to them. The project you address is '
      + 'the head. The base is an earlier build of it: `base_commit` (a commit the project\'s pack '
      + 'history holds, seven characters or more) or `base_history` (an entry id); or `base`, another '
      + 'served pack of the SAME repository. Packs of different repositories are refused. READ '
      + '`answer.conditions` FIRST: a difference is a code '
      + 'change only when both packs were analyzed the same way (lanes, identity rule, axes, worker '
      + 'versions, profile digest, engine, flags, roots). When they were not, `limits` says so, and a '
      + 'removed node whose axis changed carries `axisChanged`, because an unread catalog and a '
      + 'dropped table look alike. A renamed method is one removal and one addition. This is recorded '
      + 'graph change, not every source/body change or a safety verdict. Lists are cut at `limit` '
      + '(default 50) with the totals in `truncated`.',
    inputSchema: {
      type: 'object',
      properties: {
        base_commit: { type: 'string', description: 'a commit this project\'s pack history holds (7+ characters)' },
        base_history: { type: 'string', description: 'a pack history entry id' },
        base: { type: 'string', description: 'another served project id, of the same repository' },
        limit: { type: 'integer' },
      },
    },
    fn: pack_diff,
  },
  table_usage: {
    description:
      'Which SQL statements touch this table, with their access, and per-column read and '
      + 'write counts. It does not pair a statement to a specific endpoint, which needs the '
      + 'code axis. Name the table the way your SQL spells it: we match the argument under '
      + 'the identity rule the pack was built with, so ORDERS finds a catalog `orders` on a '
      + 'fold-lower pack and `limits` says it did. An unknown name comes back with the '
      + 'closest ones the pack has.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
      required: ['table'],
    },
    fn: tools.table_usage,
  },
  rules: {
    description:
      'Which RULES does this engine run, and what did each one give in THIS pack? A rule is '
      + 'framework knowledge written as data (src/core/rules/packs/*.json): which decorator makes '
      + 'a route, which base type makes a mapper, what a Prisma call reads and writes. A link a '
      + 'rule gave names it in `evidence.rule`, and a node a rule decided names it in an evidence '
      + 'block of its own (`prismaEvidence.rule` on a statement). With no `rule`, the answer lists '
      + 'every kind ({name, lane, stage, gradeCap, draws}), every pack, and every rule with `gave: '
      + '{edges, nodes}` in this pack and `here` (it gave something), sorted by what it gave, the '
      + 'biggest first. `query` (a substring of the id, pack, kind or description), `kind`, `lane` '
      + '(java, ts, sql, web) and `here: true` narrow the list. `gave` also counts them by `byType` and '
      + '`byGrade` (the links) and `byKind` (the nodes). `gave` is null for a kind that only '
      + 'classifies (the database a file path names) where the pack names the rule nowhere: '
      + 'there is nothing to count, which is not the same as unused; a classifying rule a lane '
      + 'does name (TypeORM receivers, on the statement link they typed) is counted. With `rule`, '
      + 'the answer is that rule whole (description, why, grade, params, examples), `gave`, '
      + 'the `edges` it gave (both ends as {id, kind, label}, the grade and '
      + 'the sentence its lane wrote) and the `nodes` it marked, a page of `limit` (default 50) '
      + 'from `offset`. Whether the examples still hold is `cascade rules test`, which runs them '
      + 'through the workers; this answer does not run them.',
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: 'a rule id, such as nestjs.routes: that rule whole, and what it gave here' },
        query: { type: 'string', description: 'list only: a case-insensitive substring of the id, pack, kind or description' },
        kind: { type: 'string', description: 'list only: one rule kind, such as java.type-role' },
        lane: { type: 'string', enum: ['java', 'ts', 'sql', 'web'], description: 'list only: the rules of one lane' },
        here: { type: 'boolean', description: 'list only: only the rules that gave something in this pack' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'with rule: edges and nodes per page, 1..500 (default 50)' },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    fn: rules,
  },
  projects: {
    description:
      'Which projects does THIS SERVER serve, and what is in memory? It answers from the '
      + 'registry alone, loading no pack, so call it first when you do not know which '
      + '`project` id to pass to the other tools. Per project you get the id (the value the '
      + '`project` argument takes), its `.cascade/` directory, the analysis lanes its stack '
      + 'declares, `lastCertifiedAt` (what the registry recorded at its last analyze, which '
      + 'is not a freshness check on the pack), whether its pack is currently loaded and how '
      + 'many bytes of pack JSON that is. `cache` is the pack cache itself: loaded / bytes / '
      + 'budgetBytes / evictions / hits / misses. The byte figures are the pack file plus its '
      + 'fact index, which is a proxy for heap rather than a heap measurement. `federation` is '
      + 'read from the project\'s route index (`routes.json`, written beside its pack) and never '
      + 'from the pack itself: `{index: "present", serves, calls}` is how many routes it serves '
      + 'and how many it calls and does not serve, and `{index: "absent"}` means this project is '
      + 'not federated at all, so no answer crosses into or out of it until `cascade analyze` '
      + 'runs there again. This tool describes the SERVER, so its basis carries project "*" and '
      + 'no build digest: nothing here is an answer about any project\'s code.',
    inputSchema: { type: 'object', properties: {} },
    // Server-level: it answers from the host, not from a pack, so the dispatcher
    // neither routes it to a project nor requires a graph on the context.
    serverLevel: true,
    fn: tools.projects,
  },
});

/**
 * The routing argument every project-scoped tool accepts. It is injected into
 * the published schemas by `toolList()` rather than repeated in each entry, so
 * a tool cannot be added that forgets it (SPEC §13: the server serves several
 * projects, and the tool says which one it means).
 */
export const PROJECT_ARG = Object.freeze({
  type: 'string',
  description: 'registry project id; required when more than one project is served',
});

function withProjectArg(schema) {
  const s = schema && typeof schema === 'object' ? schema : { type: 'object' };
  return { ...s, properties: { ...(s.properties ?? {}), project: PROJECT_ARG } };
}

/** The catalog as an MCP tools/list payload (name/description/inputSchema only). */
export function toolList() {
  return {
    schema: CATALOG_SCHEMA,
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      // Every project-scoped tool publishes `project`; the server-level one does
      // not take it (it IS the list of projects).
      inputSchema: t.serverLevel ? t.inputSchema : withProjectArg(t.inputSchema),
    })),
  };
}

/**
 * Run one tool. Returns a contract-valid response on success.
 * @param {string} name
 * @param {object} args
 * @param {{graph:object, basis:object, trust?:object, limits?:Array, pack?:object}} ctx
 * @returns {object} contract-valid response
 * @throws {DispatchError} with a `.code` (unknown-tool | bad-input | unknown-column | ... | contract-violation)
 */
export function callTool(name, args, ctx) {
  const spec = TOOLS[name];
  if (!spec) {
    throw new DispatchError('unknown-tool', `unknown tool: ${name}. available: ${Object.keys(TOOLS).join(', ')}`);
  }
  // A server-level tool (`projects`) describes the SERVER: it has no pack and
  // therefore no graph, and demanding one would force a pack to be loaded just
  // to list the projects — the opposite of the lazy loading §15 M8 asks for.
  if (!spec.serverLevel && (!ctx || !ctx.graph)) throw new DispatchError('bad-input', 'ctx.graph is required');
  if (!ctx || !ctx.basis) throw new DispatchError('bad-input', 'ctx.basis is required');
  let resp;
  try {
    // `pack` is the pack's OWN metadata (project, digest, build time, lanes,
    // base commit) — the `overview` tool relays it rather than re-deriving it
    // from the graph, so it has to survive the hop into the tool.
    // `changedFiles` is the server's live git diff (a function or an array):
    // without it `changed_impact` with no `files` cannot use the working tree
    // and fails as bad-input, so it has to survive the hop into the tool too.
    // A pack that DECLARES its axes (SPEC §10.4) states an axis it could not
    // ship exactly once, here, so every tool inherits it: the axis names land in
    // `trust.knownGaps` and the reasons in `limits`. A pack with no declaration
    // (an older one) changes nothing — the tools then infer the axis from the
    // graph shape, as they always did.
    const axes = ctx.pack && ctx.pack.axes ? ctx.pack.axes : null;
    const gaps = [...(ctx.trust?.knownGaps ?? []), ...axisKnownGaps(axes)];
    resp = spec.fn(ctx.graph, args || {}, {
      basis: ctx.basis,
      trust: { ...(ctx.trust ?? {}), knownGaps: [...new Set(gaps)] },
      limits: [...(ctx.limits ?? []), ...axisLimits(axes)],
      pack: ctx.pack, structure: ctx.structure, indexStatus: ctx.indexStatus,
      // The project's reading convention (SPEC §6.2). Today the only key the
      // query layer consumes is moduleAttribution.packageDepth, which decides
      // how `coupling` and `map` group endpoints into modules.
      profile: ctx.profile,
      changedFiles: ctx.changedFiles,
      // The LIVE working-tree overlay (SPEC §10): a function the server calls
      // per request, because the answer must describe the bytes on disk NOW.
      // Without it `changed_impact` answers from the base pack and says so.
      overlay: ctx.overlay,
      // The multi-project host, for the server-level tool only: {list, stats}.
      // A single-pack server has none, and `projects` then says so rather than
      // inventing a registry (SPEC §15 M8).
      projects: ctx.projects,
      // SIBLING ACCESS (RM44), for the tools that can cross an HTTP call into
      // another served project: {self, ids, indexOf, ctxFor}. A single-pack
      // server has none, and the answer then LISTS the calls that leave the
      // pack instead of following them.
      federation: ctx.federation, history: ctx.history, packJson: ctx.packJson, // history and exact raw pack, for pack_diff
    });
  } catch (e) {
    if (e && e.name === 'ToolError') throw new DispatchError(e.code, e.message);
    throw e;
  }
  // A response the tool built MUST satisfy the contract before it leaves — a
  // server bug that produced an invalid response is a 500, not a silent answer.
  try {
    assertContract(resp);
  } catch (e) {
    throw new DispatchError('contract-violation', e.message);
  }
  return resp;
}

export class DispatchError extends Error {
  constructor(code, message) { super(message); this.name = 'DispatchError'; this.code = code; }
}
