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
import { assertContract } from './contract.mjs';
import { axisLimits, axisKnownGaps } from '../core/lanes.mjs';

export const CATALOG_SCHEMA = 'cascade:mcp-catalog:1';

export const TOOLS = Object.freeze({
  overview: {
    description:
      'Start here. What is IN this pack, and how much of it is wired from an HTTP route '
      + 'down to a table. One answer gives you the node counts by kind, the edge counts by '
      + 'type AND grade, the grade totals, how many endpoints reach no SQL statement, how '
      + 'many statements / tables / columns are reached from at least one endpoint, the '
      + 'code axis (symbols, external types with no source, @Transactional boundaries, '
      + 'mapper methods) and `hubs` (the tables most endpoints arrive at, and the endpoints '
      + 'that touch the most tables). `axes` is the pack\'s OWN declaration, word for word: '
      + 'for each axis (catalog / statements / column / code / web / screen) whether it is '
      + 'shipped, degraded or not-shipped, and why. Read it before you read any count, '
      + 'because a degraded axis makes every number under it a lower bound. It is `{}` for a '
      + 'pack built before axes were declared. `gaps` is what we could not see, all '
      + 'computed: a pack with no code axis (not-shipped), how many calls we could not '
      + 'resolve (or that the pack does not record it, which is unknown rather than zero), '
      + 'external symbols, endpoints without a statement, statements and tables not reached, '
      + 'endpoints still expanding at the depth cap, and what the mode floor refused. A '
      + 'statement no endpoint reaches is "not reached from the endpoints we analysed", '
      + 'usually a generated mapper method, and that is NOT a claim the code is dead. mode='
      + 'strict|conservative|heuristic (default conservative), depth 1..8 (default 8). '
      + 'mode=strict usually reaches nothing, because controller to service is a call we '
      + 'cannot prove. The schema-bounded censuses (nodes, edges, grades, statementTypes) '
      + 'are COMPLETE: one row per kind, type and grade, never cut. `hubs` and the reach '
      + 'samples are cut at 10 with their true totals in `truncated`, so treat them as a '
      + 'headline and ask `flow`, `erd`, `coupling` or `search` for the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'hops walked from each handler (default 8)' },
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
    description:
      'LIST one kind of thing in this pack, with the numbers you would pick by already on '
      + 'each row. Use it when you do not have a name yet: `search` needs one, this does not. '
      + 'kind=table gives {table, comment, columns, statementsRead, statementsWrite, endpoints, '
      + 'groups, screens}; kind=column {column, table, type, pk, comment, reads, writes, '
      + 'endpoints, screens}; '
      + 'kind=statement {statement, type, tables, hasUnresolved, hasStringSubst, file, line, '
      + 'endpoints}; kind=endpoint {endpoint, httpMethod, path, group, handlerShort, handlers, '
      + 'statements, tables}; kind=symbol {symbol, owner, short, file, line, transactional, '
      + 'mapperMethod, external}. `endpoints` on a row is how many HTTP endpoints reach it, '
      + 'from ONE per-pack walk at mode=conservative, depth 8, which is the same forward walk '
      + '`flow` draws and `map` and `coupling` count on, so a wider or deeper walk could reach '
      + 'more and `limits` says so. `screens` on a table or a column row is the same number '
      + 'one lane further out, from the `walkScreens` census `browse kind=screen` lists and '
      + 'the overview counts; it is ABSENT (not 0) on a pack with no screen axis. '
      + 'kind=symbol REQUIRES query (2 characters or more), because '
      + 'a pack carries tens of thousands of methods. `query` is a case-insensitive substring '
      + 'over the row\'s id plus its comment (a table or a column), its file (a statement) or '
      + 'its handler methods (an endpoint). `table=` narrows kind=column to one table\'s '
      + 'columns. `sort` is one of statements|endpoints|groups|columns|name for a table, '
      + 'writes|reads|endpoints|name for a column, tables|name for a statement, '
      + 'tables|statements|path for an endpoint, endpoints|tables|name for a screen, and name '
      + 'for a symbol; the default is the '
      + 'first of those, which puts the busiest row first. `counts` gives the pack total for '
      + 'every kind, so a caller knows what the other kinds hold without asking. A route this '
      + 'pack CALLS over HTTP and does not serve is neither listed nor counted. Empty '
      + '"not-shipped" means the lane that would have produced this kind never ran; '
      + '"not-in-this-axis" means the query matched none of the rows that exist. limit 1..500 '
      + '(default 200), offset pages it.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['table', 'column', 'statement', 'endpoint', 'symbol', 'screen'] },
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
      + 'heuristic (default conservative).',
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', description: 'schema.table.column or table.column' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
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
    description:
      'The chain behind one API call: if I hit this endpoint, which code does it run through '
      + 'and which tables does it end at? Returns entry, services, mapper statements and '
      + 'tables. Service and statement rows carry hops and the walked path; table rows carry '
      + 'hops and the statement they came through (via). Walking DOWN, hop 0 is the handler '
      + 'method (endpoint=<METHOD /path>, or the endpoint itself when it has no handler edge) '
      + 'or the method you passed (symbol=<owner#name>). Walking UP, hop 0 is the TARGET, the '
      + 'column, table, statement or method you are changing, and a handler method used as '
      + 'the target includes its own route at hop 1. Every row carries the WEAKEST grade on '
      + 'its path, so a chain through one MAY_CALL is SOUND_SET even where its last edge is '
      + 'EXACT. mode=strict often returns NOTHING, because controller to service is a call we '
      + 'cannot prove and it sits below the strict floor; the limits and walk.note then say '
      + 'so, and an empty band there is the mode rather than an absence. depth (1..8, default '
      + '6) bounds the walk, and what lies past the cap is unknown, not absent. `layers` is '
      + 'the SAME walk folded per hop: one entry per hop 1..depth-reached with how many nodes '
      + '/ services / statements / tables sit there and their link grades. It is a census, '
      + 'never cut by limit, and its grade counts sum to walk.byLinkGrade. Layers cover '
      + 'WALKED nodes only, so a table that a reached statement names but the walk never '
      + 'stepped onto (its statement sat at the depth cap) is in no layer and is counted in '
      + 'walk.beyond.tables instead. direction=up runs from a column, table, statement or '
      + 'method back to the HTTP endpoints that can reach it, which is the change-impact '
      + 'question, and every endpoint carries the weakest grade on its path. Walking up, pass '
      + 'exactly one of column/table/statement/symbol, because an endpoint has nothing '
      + 'upstream. The lanes are then target, mapper statements, service layer and endpoints '
      + '(no tables lane: the target IS that side), depth defaults to 8, the handler method '
      + 'is a service row flagged `handler`, and the endpoints are DERIVED from its HANDLES '
      + 'edges rather than walked, so a route above a handler that sat at the depth cap is in '
      + 'no layer and is counted in walk.beyond.endpoints. A statement or symbol target '
      + 'reports the statements lane as "not-in-this-axis", because nothing upstream of those '
      + 'is a statement, rather than "none". Each endpoint row also carries `walkedPath`: its '
      + 'handler\'s path plus the HANDLES edge (`path` on that row is the ROUTE). Empty '
      + '"not-shipped" on the services or endpoints lanes means the pack has no code axis, '
      + 'because the Java lane did not run, and NOT that no endpoint reaches this. There is '
      + 'no list mode upstream. direction=down also starts at a SCREEN (screen=<its composed '
      + 'router path>), which is the other end of the round trip: the lanes are then its own '
      + 'component functions, the api functions they call, the routes those call, and the '
      + 'services, statements and tables below them, with depth defaulting to 8 because a screen '
      + 'is further out than a handler. On a pack with a frontend the UP direction gains the same '
      + 'two lanes at the far end (webFunctions, then screens), and `walk.laneNames` says which '
      + 'lanes this answer has. A row marked observed:true was confirmed by a browser recording '
      + '(--har), which is a marker beside the grade and never a step of the walk. Without '
      + 'endpoint/screen/symbol it lists the walkable endpoints (query=<substring> over "METHOD '
      + 'path handler"), or the walkable screens with kind=screen (query over path, label, title '
      + 'and component). Lists are cut by limit, and chain mode does not page.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: '"METHOD /path" key of an endpoint node (direction=down only)' },
        screen: { type: 'string', description: 'direction=down entry: a screen\'s composed router path, e.g. "/things/list"' },
        kind: { type: 'string', enum: ['endpoint', 'screen'], description: 'list mode only: which entries to list (default endpoint)' },
        symbol: { type: 'string', description: 'owner#method: the method to walk down from, or up from' },
        direction: { type: 'string', enum: ['down', 'up'], description: 'down (default): what this call runs through. up: which endpoints can reach this target' },
        column: { type: 'string', description: 'direction=up target: schema.table.column or table.column' },
        table: { type: 'string', description: 'direction=up target: a table' },
        statement: { type: 'string', description: 'direction=up target: a mapper statement id' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'max hops walked (default 6 down, 8 up)' },
        limit: { type: 'integer', description: 'per-list cut: 1..200 (default 40) in chain mode, 1..500 (default 100) listing endpoints' },
        query: { type: 'string', description: 'list mode only: substring over "METHOD path handler"' },
        offset: { type: 'integer', description: 'list mode only' },
      },
    },
    fn: tools.flow,
  },
  erd: {
    description:
      'An ERD recovered from the joins the mapper SQL makes, because this schema has no '
      + 'foreign keys. With table=<name> you get that table\'s join neighborhood (within '
      + 'hops) WITH its columns; without it, the whole-schema overview: tables, column counts '
      + 'and every relationship. Each relationship carries the join columns and how many '
      + 'statements make that join, graded EXACT because the join is literal in the SQL. '
      + '`limit` caps the tables drawn (default 400, max 5000). Past it we keep the '
      + 'most-joined tables and always the focus table, `truncated.tables.total` is the true '
      + 'number in scope and `limits` says how many went. An ERD of a 4 000-table schema is '
      + 'megabytes, so this answer is bounded rather than silently large.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, hops: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 5000 } },
    },
    fn: tools.erd,
  },
  coupling: {
    description:
      'Which API group writes what another API group reads? Two groups can depend on each '
      + 'other through the database with no call edge between them, and this finds those '
      + 'pairs. A group is the FIRST PATH SEGMENT of an endpoint (/product/update/{id} gives '
      + 'product; an empty one gives (root)). It is a naming habit, not a module boundary '
      + 'anyone declared. axis=column (default) pairs groups through a shared column; '
      + 'axis=table through a shared table, where the EXECUTES access decides the side '
      + '(write or delete makes a writer, read makes a reader). Returns `groups` with '
      + 'per-group endpoint, write and read counts, ranked `pairs` (writer, then reader, with '
      + 'the shared items, cut by limit), `cells` (every pair without its items, so the whole '
      + 'matrix and never cut) and a `summary`. We attribute a statement to EVERY group whose '
      + 'endpoints can reach it, using the SAME forward walk `flow` draws, at this view\'s '
      + 'own default depth 8 (the Flow tab defaults to 6). Every HANDLES target of a route is '
      + 'walked, and mode and depth apply. So a statement behind a shared service counts for '
      + 'all of them: `sharedStatements` lists the ones reached by 3 or more groups (a capped '
      + 'disclosure rather than a page), each pair\'s `viaShared` counts the items that ON AT '
      + 'LEAST ONE SIDE are carried only by statements 3 or more groups reach, and '
      + '`sharedVia` names up to 5 of THAT pair\'s own such statements. Sharing inside one '
      + 'group is not coupling, so it is counted apart as summary.selfOnlyItems, and an item '
      + 'only written or only read within the walk is summary.writeOnlyItems / readOnlyItems, '
      + 'which is why items === coupledItems + selfOnlyItems + writeOnlyItems + '
      + 'readOnlyItems. `walk` counts what the walks did NOT look at (depth cap, node cap, '
      + 'links below the mode floor), so an empty matrix can be the mode rather than an '
      + 'absence. A direct call from one group to another is not in this view, and empty '
      + '"not-shipped" means the pack has no code axis and therefore no endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        axis: { type: 'string', enum: ['column', 'table'], description: 'what two groups share (default column)' },
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'hops walked from each endpoint (default 8)' },
        limit: { type: 'integer', description: 'pairs per page: 1..500 (default 50)' },
        offset: { type: 'integer' },
      },
    },
    fn: tools.coupling,
  },
  map: {
    description:
      'The WHOLE pack as one relation map: the picture you open before you have a question. '
      + 'For one node\'s surroundings, use `neighborhood`. Returns every API group, every '
      + 'endpoint under it, every table those endpoints reach, and the joins the mapper SQL '
      + 'makes between those tables, as `nodes` [{id, kind: group|endpoint|table|statement, '
      + 'label, group?, degree, + the kind\'s facts}] and `links` [{source, target, kind: '
      + 'member|touches|joins|executes, access?, grade, statements?, witness?}]. A group is '
      + 'the FIRST PATH SEGMENT of an endpoint (/product/update/{id} gives product; an empty '
      + 'one gives (root)), which is a naming habit rather than a declared module boundary, '
      + 'and `member` is the group to endpoint link. A `touches` link is endpoint to table, '
      + 'ONE per pair, with `access` aggregated (read / write / delete / read+write) over the '
      + 'statements that endpoint reaches and `statements` counting them. Its `grade` is the '
      + 'STRONGEST of the paths that produce it, each graded by its WEAKEST link (the walk to '
      + 'the statement, then that statement\'s own SQL edge), the same rule `flow` grades its '
      + 'tables lane by, so one confirmed route makes the touch EXACT while a table an '
      + 'endpoint can only reach through a call we could not prove stays SOUND_SET. '
      + 'layers:["statements"] adds the mapper statements as their own nodes and REPLACES '
      + 'each `touches` shortcut with the two real steps (endpoint executes statement, '
      + 'statement executes table). layers:["screens"] adds the OTHER end of the round trip: '
      + 'one node per SCREEN that reaches a route this pack serves, and one `calls` link per '
      + '(screen, route) pair, from the same forward walk `browse kind=screen` lists and the '
      + 'overview counts. A screen that reaches no drawn route is not on the map, and '
      + '`summary.screens` against `summary.screensTotal` says how many those are. '
      + '`joins` are the JOINS edges between drawn tables, '
      + 'undirected and once, with the count of statements that make the join. Attribution is '
      + 'by reachability, the SAME forward walk `flow` draws and `coupling` counts on, at '
      + 'depth 8 by default. mode=strict usually draws no endpoint to table line at all, '
      + 'because controller to service is a call we cannot prove. `summary` gives groups / '
      + 'endpoints / tables (the whole schema) / tablesTouched (how many are on the map) / '
      + 'links / the walk\'s cut census, and `summary.shown` how many of each kind survived '
      + 'the node cap. `limit` is that cap (default 6000, max 20000) and `maxBytes` is the '
      + 'ANSWER budget in measured bytes of the nodes and links payload (default 524288, max '
      + '8388608). A whole-pack map of a 3 800-endpoint project serialises to megabytes, so '
      + 'the byte budget is what actually bounds it. Past either one, the answer is cut BY '
      + 'KIND, statements first, then endpoints, then tables, and NEVER groups, keeping the '
      + 'best-connected of the kind being cut, and `limits` names exactly how many of each '
      + 'went and which budget cut it (`summary.cutBy`, `summary.bytes`). Tables no endpoint '
      + 'reaches are NOT drawn and their number is disclosed. Empty "not-shipped" means the '
      + 'pack has no code axis and therefore no endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['strict', 'conservative', 'heuristic'] },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'hops walked from each endpoint (default 8)' },
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
      + 'fact index, which is a proxy for heap rather than a heap measurement. This tool '
      + 'describes the SERVER, so its basis carries project "*" and no build digest: nothing '
      + 'here is an answer about any project\'s code.',
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
      pack: ctx.pack,
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
