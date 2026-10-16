// agent_setup.mjs — what `cascade agent` writes into a project, computed purely.
//
// Two things stand between a reader and an agent that actually uses this graph.
// The first is the MCP configuration: an absolute path to `bin/cascade.mjs`, a
// project id out of the registry, and one JSON shape per client, all typed by
// hand. The second is the rule, and it is the half that gets forgotten: a
// server with no instruction attached is a server the model never calls,
// because nothing in its context says a question is due before it edits a
// mapper.
//
// Both are things the tool can do for the reader, because the tool knows its
// own path, its own project id and its own tool names. This module holds the
// text and the merge rules; `bin/cascade.mjs` holds the filesystem.
//
// Pure: nothing here reads or writes a file. Every function takes the current
// content as a string (or null for "there is no such file yet") and returns the
// content that should be on disk.

/** The clients `cascade agent` knows how to configure. */
export const AGENT_CLIENTS = Object.freeze(['claude-code', 'cursor', 'codex']);

/** The key every client's MCP config holds this server under. */
export const SERVER_KEY = 'cascade';

export const BLOCK_BEGIN = '<!-- cascade:begin -->';
export const BLOCK_END = '<!-- cascade:end -->';

// The block, from its first marker to its last, wherever it sits in a file.
// `m` makes `^` and `$` line anchors, so a marker only counts on its own line,
// and the match is non-greedy so a file that somehow holds two blocks has its
// FIRST one replaced rather than everything between the two.
const BLOCK_RE = /^<!-- cascade:begin -->$[\s\S]*?^<!-- cascade:end -->$/m;

/**
 * The instruction the agent reads on every turn: when to ask, how to ask, and
 * how to read the answer.
 *
 * Every tool it names is a name the MCP catalog publishes, and a drift test
 * holds it to that. It is short on purpose: it lands in a file the model reads
 * before every turn, so a page of prose here is a page of prose on every turn.
 *
 * @param {string} projectId  the registered project id this server serves
 * @returns {string} the body, with no trailing newline and no markers
 */
export function rulesBody(projectId) {
  return `${structureRules(projectId)}\n\n${impactRules()}`;
}

function structureRules(projectId) {
  return `## Cascade: read code structure and change impact before editing

Use the \`cascade\` MCP server (project \`${projectId}\`) for persistent structure
and graded change impact. Its selected analysis lanes do not cover every file.

Start each session with \`session_briefing\` for scope, freshness and recorded connections.
For code discovery, inspect \`architecture\`, then \`code_search\` or
\`file_outline\`. Use \`code_context\` for a bounded set of declarations and their
relationships; use \`code_trace\` for callers/callees (callback references are not execution),
and \`code_snippet\` for verified source. Reuse structure across
sessions; search source for literals, unsupported areas and reported gaps.
\`index_status\` reports the indexed scope and freshness. Automatic refresh reads
saved files; it cannot see unsaved editor buffers.`;
}

function impactRules() {
  return `Before editing a mapper, entity, schema, controller, service or frontend:
1. Ask \`changed_impact\` with the files; check its freshness and overlay status.
2. For a column change, ask \`column_impact\`, \`endpoint_impact\` and
   \`screen_impact\`; include both readers and writers in the plan.
3. Use \`flow\` for a screen/API-to-table path and \`overview\` for impact coverage.
   Prefer \`compact: true\` with a small byte budget; read each needed lane's omitted counts
   and page it when necessary. A shortened list is not a complete impact census.

How to read an answer:
- Read \`trust\`, \`limits\`, \`truncated\` and any omitted counts before the list.
- \`EXACT\` is proved. \`SOUND_SET\` is a candidate set, so check each member.
  \`HEURISTIC\` and \`RUNTIME_ONLY\` are hints, not evidence.
- Empty means no match in the indexed scope, not proof of no callers or impact.
- Check \`basis.freshness\` as well as coverage. If it is \`behind\` or \`unknown\`,
  refresh the analysis or verify the affected source before drawing conclusions.
  A failed refresh is not a current answer.
- Structure relations explain organization; only the graded impact graph explains
  possible propagation. Directory groups do not establish architectural intent.

After editing, ask \`changed_impact\` again and report its evidence and limits.`;
}

/**
 * The same body wrapped in the markers that make it replaceable in a file the
 * user also writes in.
 * @param {string} projectId
 * @returns {string} the block, with no trailing newline
 */
export function rulesBlock(projectId) {
  return `${BLOCK_BEGIN}\n${rulesBody(projectId)}\n${BLOCK_END}`;
}

/**
 * The whole Cursor rule file: the same body under the frontmatter Cursor reads
 * to decide when to apply a rule. `alwaysApply: true` is the point of the rule,
 * so the agent carries it before it knows it needs it.
 * @param {string} projectId
 * @returns {string} the file content, newline-terminated
 */
export function cursorRuleFile(projectId) {
  return '---\n'
    + 'description: Read Cascade code structure and change impact before editing\n'
    + 'alwaysApply: true\n'
    + '---\n\n'
    + `${rulesBody(projectId)}\n`;
}

/**
 * Put the managed block into a file the user also owns.
 *
 *  - a file that already has the block gets it replaced where it sits, so the
 *    text above and below is untouched;
 *  - a file without it gets the block after one blank line;
 *  - a file that does not exist yet holds only the block.
 *
 * Running it twice on its own output returns that output unchanged, which is
 * what lets `cascade agent --write` say `unchanged` and mean it.
 *
 * @param {(string|null)} existing  the current content, or null when there is no file
 * @param {string} block  from `rulesBlock`
 * @returns {string} the content to write, newline-terminated
 */
export function mergeManagedBlock(existing, block) {
  const body = block.replace(/\n+$/, '');
  const text = typeof existing === 'string' ? existing : '';
  if (text.trim() === '') return `${body}\n`;
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, () => body);
  const base = text.endsWith('\n') ? text : `${text}\n`;
  return `${base}\n${body}\n`;
}

/**
 * The MCP server entry every client config carries. Absolute paths only: a
 * client starts the server from a working directory nobody controls, so a
 * relative path is the single most common reason a client reports the server as
 * failed.
 *
 * @param {{execPath:string, cliPath:string, projectId:string, cascadeHome?:string}} spec
 * @returns {{command:string, args:string[]}}
 */
export function mcpServerEntry({ execPath, cliPath, projectId, cascadeHome }) {
  return { command: execPath, args: [cliPath, 'mcp', '--project', projectId],
    ...(cascadeHome ? { env: { CASCADE_HOME: cascadeHome } } : {}) };
}

/**
 * Set `mcpServers.cascade` in a client config and leave every other key and
 * every other server exactly where it was.
 *
 * A file that exists and does not parse is NOT rewritten: it is somebody's
 * configuration, and a tool that overwrites what it could not read has thrown
 * away work it never looked at. The caller turns this throw into an exit.
 *
 * @param {(string|null)} existing  the current content, or null when there is no file
 * @param {{command:string, args:string[]}} entry
 * @returns {string} the content to write, two-space indent and a trailing newline
 * @throws {AgentSetupError} when the existing content is not a JSON object
 */
export function mergeMcpConfig(existing, entry) {
  let obj = {};
  if (typeof existing === 'string' && existing.trim() !== '') {
    try {
      obj = JSON.parse(existing);
    } catch (e) {
      throw new AgentSetupError(`it is not valid JSON (${e.message})`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new AgentSetupError('the top level of the file is not a JSON object');
    }
  }
  const current = obj.mcpServers;
  const servers = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  // The spread keeps `mcpServers` where it already was in the file, and appends
  // it at the end only when the file did not have one.
  const next = { ...obj, mcpServers: { ...servers, [SERVER_KEY]: entry } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * The TOML block for a trusted project's or the user's Codex config file.
 * Print it for an explicit merge instead of overwriting an existing TOML file.
 *
 * @param {{command:string, args:string[]}} entry
 * @returns {string} the block, newline-terminated
 */
export function codexTomlBlock(entry) {
  const str = (s) => JSON.stringify(String(s));
  return `[mcp_servers.${SERVER_KEY}]\n`
    + `command = ${str(entry.command)}\n`
    + `args = [${entry.args.map(str).join(', ')}]\n`
    + (entry.env ? `env = { ${Object.entries(entry.env).map(([key, value]) => `${str(key)} = ${str(value)}`).join(', ')} }\n` : '');
}

/**
 * WHAT EACH CLIENT GETS, as repository-relative paths and the kind of merge
 * each one needs. Nothing here touches the disk: the caller reads the current
 * content, calls the merge named by `kind`, and writes the result.
 *
 * `kind` is one of:
 *   `mcp-json`   read + set `mcpServers.cascade` + write (`mergeMcpConfig`)
 *   `managed`    the block, in a file the user also writes in (`mergeManagedBlock`)
 *   `whole`      the file is wholly ours, so `content` is the file
 *
 * @param {string} client  one of AGENT_CLIENTS
 * @param {{projectId:string, entry:{command:string, args:string[]}}} spec
 * @returns {{rel:string, kind:string, content?:string, entry?:object}[]}
 */
export function filesFor(client, { projectId, entry }) {
  if (client === 'claude-code') {
    return [
      { rel: '.mcp.json', kind: 'mcp-json', entry },
      { rel: 'CLAUDE.md', kind: 'managed', content: rulesBlock(projectId) },
    ];
  }
  if (client === 'cursor') {
    return [
      { rel: '.cursor/mcp.json', kind: 'mcp-json', entry },
      { rel: '.cursor/rules/cascade.mdc', kind: 'whole', content: cursorRuleFile(projectId) },
    ];
  }
  if (client === 'codex') {
    // Print TOML for the user to merge into project or user configuration.
    // An existing TOML file may carry unrelated settings this command does not parse.
    return [
      { rel: 'AGENTS.md', kind: 'managed', content: rulesBlock(projectId) },
    ];
  }
  throw new AgentSetupError(`unknown client ${JSON.stringify(client)}: it is one of ${AGENT_CLIENTS.join(', ')}`);
}

export class AgentSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentSetupError';
  }
}
