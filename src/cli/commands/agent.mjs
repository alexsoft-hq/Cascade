// agent.mjs — `cascade agent`: put the MCP server AND the rule that gets it used into a
// project, in one command.
//
// The server has been wireable for a while, and every page that shows how ends
// at the same place: a config with an absolute path in it. What no page said is
// WHEN the agent should ask. A model with the server attached and no rule about
// it edits a mapper without a question, because nothing in its context says a
// question is due, and half of what this tool is worth sits on that rule.
//
// So this writes both, and it can, because the tool knows its own path, its own
// project id and its own tool names. The rule goes in a MANAGED BLOCK between
// two markers, so the file stays the user's: text above and below it survives,
// and a second run replaces the block in place rather than appending a second
// copy. The merge rules and the text itself are in src/core/agent_setup.mjs;
// this block is the filesystem edge.

import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_CLIENTS, codexTomlBlock, filesFor, mcpServerEntry, mergeManagedBlock, mergeMcpConfig,
} from '../../core/agent_setup.mjs';
import { registryPath } from '../../core/paths.mjs';
import { readRegistry, findProject, projectIds } from '../../core/registry.mjs';
import { CLI_PATH, realPath } from '../env.mjs';
import { analyzeRoot } from '../lanes_run.mjs';

/**
 * WHICH PROJECT, and where its tree is. The registry is the authority, because
 * the id it holds is the id the server will answer to. `--project` names an
 * entry; otherwise the entry is the one whose `.cascade/` IS this root's,
 * compared as real paths so a symlinked temp directory is still the same
 * project.
 */
function projectAndRoot({ opt, die }, reg, regFile) {
  const projectFlag = opt('project');
  if (typeof projectFlag === 'string' && projectFlag.length > 0) {
    const projectEntry = findProject(reg, projectFlag);
    if (!projectEntry) {
      const ids = projectIds(reg);
      die(`unknown project ${JSON.stringify(projectFlag)}: `
        + `${ids.length > 0 ? `registered ids are ${ids.join(', ')}` : `the registry at ${regFile} is empty`}. `
        + 'Run `cascade init --root <dir>` and `cascade analyze` first, then this command');
    }
    return { projectEntry, root: analyzeRoot({ source: 'registry', dotCascade: path.resolve(projectEntry.dotCascadePath) }, undefined, process.cwd()).root };
  }
  const root = path.resolve(process.cwd(), opt('root', process.cwd()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`--root ${root} is not a directory`);
  const dot = realPath(path.join(root, '.cascade'));
  const projectEntry = reg.projects.find((p) => realPath(p.dotCascadePath) === dot) ?? null;
  if (!projectEntry) {
    die(`no project is registered for ${root}: nothing in ${regFile} points at ${path.join(root, '.cascade')}. `
      + `Run \`cascade init --root ${root}\` and \`cascade analyze\` first, then this command`);
  }
  return { projectEntry, root };
}

/**
 * PLAN EVERYTHING, THEN WRITE. A config that exists and does not parse stops the
 * whole command with nothing written, rather than after the first half.
 */
function planFiles({ die }, { clients, root, projectId, entry }) {
  const planned = [];
  for (const client of clients) {
    for (const f of filesFor(client, { projectId, entry })) {
      const abs = path.join(root, f.rel);
      if (planned.some((p) => p.abs === abs)) continue;
      const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      let content;
      try {
        if (f.kind === 'mcp-json') content = mergeMcpConfig(existing, f.entry);
        else if (f.kind === 'managed') content = mergeManagedBlock(existing, f.content);
        else content = f.content;
      } catch (e) {
        die(`${abs} is not something this command can merge into: ${e.message}. `
          + 'Nothing was written. Fix that file by hand, or move it aside and run this again');
      }
      planned.push({ abs, rel: f.rel, content, existing });
    }
  }
  return planned;
}

/** Without --write, print every file this command would put in place. */
function printPlan(planned) {
  for (const p of planned) {
    process.stdout.write(`--- ${p.rel} ---\n`);
    process.stdout.write(p.content.endsWith('\n') ? p.content : `${p.content}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write('nothing was written: pass --write to put these files in place\n');
}

/** With --write, put them in place and say which of the three things happened. */
function writePlan(planned) {
  for (const p of planned) {
    const state = p.existing === null ? 'created' : (p.existing === p.content ? 'unchanged' : 'updated');
    if (state !== 'unchanged') {
      fs.mkdirSync(path.dirname(p.abs), { recursive: true });
      fs.writeFileSync(p.abs, p.content, 'utf8');
    }
    process.stdout.write(`${state} ${p.rel}\n`);
  }
}

export function run(ctx) {
  const { opt, flag, die } = ctx;
  const clientArg = opt('client', 'claude-code');
  const clients = clientArg === 'all' ? [...AGENT_CLIENTS] : [clientArg];
  for (const c of clients) {
    if (!AGENT_CLIENTS.includes(c)) die(`--client ${JSON.stringify(clientArg)} is not one of ${AGENT_CLIENTS.join('|')}|all`);
  }
  const write = flag('write');

  // WHICH PROJECT. The registry is the authority, because the id it holds is
  // the id the server will answer to. `--project` names an entry; otherwise the
  // entry is the one whose `.cascade/` IS this root's, compared as real paths
  // so a symlinked temp directory is still the same project.
  const regFile = registryPath(process.env);
  let reg;
  try { reg = readRegistry(regFile); } catch (e) { die(e.message); }

  const { projectEntry, root } = projectAndRoot(ctx, reg, regFile);
  const projectId = projectEntry.id;

  // The path a client will start. Absolute, and through whatever symlink the
  // installer left behind, because a client starts the server from a working
  // directory nobody controls.
  const entry = mcpServerEntry({
    execPath: process.execPath,
    cliPath: CLI_PATH,
    projectId,
  });

  const planned = planFiles(ctx, { clients, root, projectId, entry });

  process.stdout.write(`cascade agent: project ${projectId} at ${root} (${clients.join(', ')})\n\n`);
  if (write) writePlan(planned); else printPlan(planned);
  if (clients.includes('codex')) {
    // Codex keeps ONE config for every project, so a per-project command that
    // edited a file in the home directory would be a surprise. It is printed.
    process.stdout.write('\nCodex reads one config for every project, so this part is yours to paste. Put it in ~/.codex/config.toml:\n\n');
    process.stdout.write(codexTomlBlock(entry));
  }
  if (write && clients.includes('claude-code')) {
    process.stdout.write(`\nnext: run \`claude\` in ${root} once and approve the cascade server when it asks, `
      + 'because Claude Code holds a project .mcp.json server at "Pending approval" until you do, '
      + 'and `claude mcp get cascade` prints that state\n');
  }
  process.exit(0);
}
