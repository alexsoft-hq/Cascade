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
  return `## Cascade: ask the impact graph before touching data-facing code

This project has a change-impact graph served over MCP by the \`cascade\` server
(project \`${projectId}\`). It knows which SQL statements, HTTP endpoints and screens reach
every table and column, with a grade on each edge.

Ask before you edit any of these:
- a MyBatis mapper XML or an annotated mapper, a JPA entity or repository, a DDL file
- a controller, a route, or a service method a controller reaches
- a frontend screen, or a frontend function that calls the backend

How to ask:
1. \`changed_impact\` with the files you are about to change, or have changed and
   not committed. It lists the endpoints, screens, tables and columns in the
   blast radius, and it reads your working tree, so it is never behind.
2. Before renaming or retyping a column, run \`column_impact\`, then
   \`endpoint_impact\` and \`screen_impact\` on it, and put every reader AND writer
   they name into your plan.
3. \`flow\` on an endpoint or a screen shows the whole path down to the tables it
   ends at. \`overview\` first when you do not know what is in the pack.

How to read an answer:
- \`trust\`, \`limits\` and \`truncated\` come with every answer. Read them before
  the list. Each \`limits\` entry names something the graph could not see.
- \`EXACT\` is proved. \`SOUND_SET\` is a candidate set, so check each member.
  \`HEURISTIC\` and \`RUNTIME_ONLY\` are hints, not evidence.
- An empty list means "none" only when \`empty\` says \`none\`. \`not-shipped\` and
  \`degraded\` mean unknown, which is not the same as zero.
- A \`basis.freshness\` of \`behind\` means the pack predates the code you see.
  \`changed_impact\` still answers from the working tree.

After the edit, run \`changed_impact\` again and put the endpoints and screens it
names into the commit message or the pull request, so a reviewer sees the same
radius you did.`;
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
    + 'description: Ask the Cascade impact graph before changing data-facing code\n'
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
 * @param {{execPath:string, cliPath:string, projectId:string}} spec
 * @returns {{command:string, args:string[]}}
 */
export function mcpServerEntry({ execPath, cliPath, projectId }) {
  return { command: execPath, args: [cliPath, 'mcp', '--project', projectId] };
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
 * The TOML block Codex wants in its own config file. Codex keeps one config for
 * every project rather than one per repository, so this is printed for the
 * reader to paste rather than written by this command.
 *
 * @param {{command:string, args:string[]}} entry
 * @returns {string} the block, newline-terminated
 */
export function codexTomlBlock(entry) {
  const str = (s) => JSON.stringify(String(s));
  return `[mcp_servers.${SERVER_KEY}]\n`
    + `command = ${str(entry.command)}\n`
    + `args = [${entry.args.map(str).join(', ')}]\n`;
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
    // No config file: Codex reads one TOML for every project, and a per-project
    // command that edits a file in the home directory would be a surprise.
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
