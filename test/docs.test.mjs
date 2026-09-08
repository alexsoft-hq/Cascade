// docs.test.mjs — the documentation drift gate.
//
// Documentation rots the moment a flag is added and nobody remembers the page
// that lists it. So the page is not the authority: the BINARY is. This test
// runs `cascade` with no arguments, reads the command names and flags out of
// the usage text it prints, and fails when `docs/cli.md` does not mention one.
// The same rule for the query surface: `toolList()` is the authority and
// `docs/mcp.md` must name every tool in it.
//
// It runs in the OTHER direction too — a page that documents a command the
// binary no longer has is exactly as wrong as one that misses a new one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolList } from '../src/mcp/catalog.mjs';
import { rulesBlock, rulesBody } from '../src/core/agent_setup.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'cascade.mjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The usage text, from the binary itself. */
function usageText() {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.ok(r.stderr.startsWith('usage: cascade <'), `expected a usage line, got: ${r.stderr.slice(0, 200)}`);
  return r.stderr;
}

/** The command names, out of the `<a|b|c>` list on the first usage line. */
function commandsOf(usage) {
  const m = /^usage: cascade <([^>]+)>/.exec(usage);
  assert.ok(m, 'the first usage line must list the commands as <a|b|c>');
  return m[1].split('|');
}

/**
 * Every long flag the usage text mentions. `--no-` (from the `--no-<lane>`
 * template) is not a flag name and is dropped; so is a trailing hyphen.
 */
function flagsOf(usage) {
  const found = new Set();
  for (const m of usage.matchAll(/--[a-z][a-z-]*/g)) {
    const flag = m[0];
    if (flag.endsWith('-')) continue;
    found.add(flag);
  }
  return [...found].sort();
}

test('docs/cli.md documents every command the binary lists — and no command it does not', () => {
  const usage = usageText();
  const cli = read('docs/cli.md');
  const commands = commandsOf(usage);
  assert.ok(commands.length >= 10, `expected the usage to list the commands, got ${commands.join(',')}`);

  const missing = commands.filter((c) => !new RegExp(`^## \`cascade ${c}\\b`, 'm').test(cli));
  assert.deepEqual(missing, [], `docs/cli.md has no "## \`cascade <name>\`" section for: ${missing.join(', ')}`);

  // ...and the other direction: a section for a command that no longer exists.
  // A command name can carry a hyphen (`otel-methods`), so the capture has to
  // as well: reading it as `otel` would report a command the binary "no longer
  // has" the moment somebody documents one correctly.
  const documented = [...cli.matchAll(/^## `cascade ([a-z][a-z-]*)/gm)].map((m) => m[1]);
  const stale = [...new Set(documented)].filter((c) => !commands.includes(c));
  assert.deepEqual(stale, [], `docs/cli.md documents commands the binary does not have: ${stale.join(', ')}`);
});

test('docs/cli.md mentions every flag in the usage text', () => {
  const usage = usageText();
  const cli = read('docs/cli.md');
  const flags = flagsOf(usage);
  assert.ok(flags.length > 20, `expected the usage to carry the flags, got ${flags.length}`);
  const missing = flags.filter((f) => !cli.includes(f));
  assert.deepEqual(missing, [], `docs/cli.md never mentions: ${missing.join(' ')}`);
});

test('the exit codes the usage text promises are documented', () => {
  const usage = usageText();
  const cli = read('docs/cli.md');
  // Both of the non-obvious ones are stated in the usage, so both must be on
  // the page: a reader who scripts `analyze` needs to know 3 is not a crash.
  assert.match(usage, /exits 3/, 'analyze still documents its rejection exit code');
  assert.match(usage, /Exit 4/, 'verify still documents its disagreement exit code');
  assert.match(cli, /\| `3` \|/);
  assert.match(cli, /\| `4` \|/);
});

test('docs/mcp.md names every tool in the catalog — and no tool the catalog does not have', () => {
  const mcp = read('docs/mcp.md');
  const names = toolList().tools.map((t) => t.name);
  assert.ok(names.length >= 12, `expected the catalog to carry the tools, got ${names.length}`);
  const missing = names.filter((n) => !new RegExp(`\`${n}\``).test(mcp));
  assert.deepEqual(missing, [], `docs/mcp.md never names: ${missing.join(' ')}`);
});

// The rules block `cascade agent` writes is documentation too — the kind that
// is read by a model rather than by a person, on every turn, inside somebody
// else's repository. It rots the same way a page does: a tool gets renamed and
// the block keeps naming the old one, and the agent's call comes back
// `unknown-tool` at the moment it mattered. So the catalog is the authority
// here as well.
test('the rules block names only tools the catalog has, and still names the six the README promises', () => {
  const block = rulesBody('demo');
  const names = new Set(toolList().tools.map((t) => t.name));
  const mentioned = [...block.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1]);

  // Every backticked token SHAPED like a tool name (lower case, an underscore
  // in it) must be one. That is the shape a rename leaves behind.
  const toolShaped = [...new Set(mentioned.filter((n) => n.includes('_')))];
  assert.ok(toolShaped.length >= 4, `expected the block to name tools, found ${toolShaped.join(', ')}`);
  const gone = toolShaped.filter((n) => !names.has(n));
  assert.deepEqual(gone, [], `the block names tools the catalog does not have: ${gone.join(', ')}`);

  // ...and the six the README puts in front of a reader are all still there, in
  // the catalog and in the block. `flow` and `overview` carry no underscore, so
  // only this half covers them.
  for (const n of ['changed_impact', 'column_impact', 'endpoint_impact', 'screen_impact', 'flow', 'overview']) {
    assert.ok(names.has(n), `the catalog no longer publishes ${n}`);
    assert.ok(mentioned.includes(n), `the rules block no longer tells the agent about ${n}`);
  }

  // It lands in a file the model reads before every turn, so its length is part
  // of its contract.
  const lines = rulesBlock('demo').split('\n');
  assert.ok(lines.length < 40, `the block is ${lines.length} lines; under 40 is the budget`);
  assert.equal(lines[0], '<!-- cascade:begin -->');
  assert.equal(lines[lines.length - 1], '<!-- cascade:end -->');
});

test('every docs page a docs page links to exists', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`)
    .concat(fs.readdirSync(path.join(ROOT, 'docs', 'setup')).map((f) => `docs/setup/${f}`));
  const broken = [];
  for (const rel of pages) {
    const dir = path.dirname(path.join(ROOT, rel));
    for (const m of read(rel).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = path.resolve(dir, m[1]);
      if (!fs.existsSync(target)) broken.push(`${rel} -> ${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `broken links between docs pages:\n${broken.join('\n')}`);
});

test('the docs site has an index, a concepts page and a Jekyll config', () => {
  for (const rel of ['docs/index.md', 'docs/concepts.md', 'docs/cli.md', 'docs/mcp.md', 'docs/viewer.md', 'docs/_config.yml']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing`);
  }
  // Zero-npm: the site is Jekyll's built-in pipeline on GitHub Pages, so the
  // config must not pull a gem-based build in through a Gemfile.
  assert.equal(fs.existsSync(path.join(ROOT, 'docs', 'Gemfile')), false, 'the docs site must not need a bundler');
  assert.equal(fs.existsSync(path.join(ROOT, 'docs', 'package.json')), false, 'the docs site must not need npm');
});

test('the index links every page of the site, and the setup pages it claims exist', () => {
  const index = read('docs/index.md');
  for (const rel of ['concepts.md', 'cli.md', 'mcp.md', 'viewer.md', 'measured.md',
    'setup/agents.md', 'setup/sql-lane.md', 'setup/java-lane.md', 'setup/web-lane.md',
    'setup/db-catalog.md', 'ko/index.md']) {
    assert.ok(index.includes(`(${rel})`), `docs/index.md does not link ${rel}`);
  }
});

// ---------------------------------------------------------------------------
// The specification this engine was built against is a PRIVATE document, and so
// are the round briefs and the handover note. A reader landing on this
// repository cannot follow a pointer into any of them, so a pointer is a dead
// end that also advertises something they cannot have. The rule is therefore
// blunt: the rule itself goes in the sentence, and the section number does not
// go anywhere a reader can see. Code comments are the developer's own notes and
// are out of scope; everything a reader opens is in scope.
// ---------------------------------------------------------------------------

/** Every reader-facing document: the whole docs site plus the root files. */
function readerFacingPages() {
  const out = ['README.md', 'README.ko.md', 'CONTRIBUTING.md', 'SECURITY.md',
    'CODE_OF_CONDUCT.md', 'NOTICE', 'CHANGELOG.md'];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (!/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(entry.name)) out.push(child);
    }
  };
  walk('docs');
  return out;
}

test('no reader-facing page points at a document the reader cannot open', () => {
  const banned = [
    ['SPEC §', 'a section number of the private specification'],
    ['cascade-design', 'the private design repository'],
    ['HANDOFF', 'the private handover note'],
    ['rename pending', 'the name is decided: Cascade'],
    ['working name', 'the name is decided: Cascade'],
  ];
  const hits = [];
  for (const rel of readerFacingPages()) {
    const text = read(rel);
    text.split('\n').forEach((line, i) => {
      for (const [needle, why] of banned) {
        if (line.includes(needle)) hits.push(`${rel}:${i + 1}: "${needle}" (${why}): ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], `reader-facing pages point at what a reader cannot open:\n${hits.join('\n')}`);
});

// ---------------------------------------------------------------------------
// The Korean mirror. Two things rot on their own: a page the index promises and
// nobody wrote, and a translation that has drifted so far from its original
// that a reader cannot find the English sentence it came from. The second is
// why every Korean page carries a link back to the page it mirrors.
// ---------------------------------------------------------------------------

/** Every Markdown page under docs/ko, as repository-relative paths. */
function koreanPages() {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.md')) out.push(child);
    }
  };
  walk('docs/ko');
  return out;
}

test('the Korean index promises only pages that exist, and every Korean page links back to its English original', () => {
  const pages = koreanPages();
  assert.ok(pages.length >= 5, `expected the Korean mirror to have pages, got ${pages.length}`);

  // 1. Everything docs/ko/index.md links to resolves to a file on disk.
  const indexDir = path.join(ROOT, 'docs', 'ko');
  const missing = [];
  for (const m of read('docs/ko/index.md').matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
    const target = path.resolve(indexDir, m[1]);
    if (!fs.existsSync(target)) missing.push(m[1]);
  }
  assert.deepEqual(missing, [], `docs/ko/index.md links pages that do not exist: ${missing.join(', ')}`);

  // 2. Every Korean page has an English original, and links to it. The original
  //    is the same path with the `ko/` segment removed, which is what makes the
  //    mirror checkable at all: a Korean page with no counterpart is a page
  //    nobody can compare against.
  const unlinked = [];
  for (const rel of pages) {
    const english = rel.replace('docs/ko/', 'docs/');
    const englishAbs = path.join(ROOT, english);
    if (!fs.existsSync(englishAbs)) { unlinked.push(`${rel}: no English original at ${english}`); continue; }
    const dir = path.dirname(path.join(ROOT, rel));
    const linked = [...read(rel).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)]
      .some((m) => path.resolve(dir, m[1]) === englishAbs);
    if (!linked) unlinked.push(`${rel}: no link back to ${english}`);
  }
  assert.deepEqual(unlinked, [], `the Korean mirror has drifted from its originals:\n${unlinked.join('\n')}`);
});

test('no docs page makes a forbidden claim', () => {
  // The forbidden claims, as they would actually be written. This is a coarse
  // net on purpose: it is meant to catch the sentence somebody adds in a hurry.
  const forbidden = [
    /\bcomplete impact\b/i,
    /\bfull(?:ly)? complete\b/i,
    /\b100% accurate\b/i,
    /\blanguage[- ]agnostic\b/i,
    /\bsafe refactoring guaranteed\b/i,
    /\bguarantees? safe refactor/i,
    /\breplaces? (?:a )?(?:SAST|CodeQL)\b/i,
    /\b(?:SAST|CodeQL) replacement\b/i,
  ];
  const pages = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
    'docs/index.md', 'docs/concepts.md', 'docs/cli.md', 'docs/mcp.md', 'docs/viewer.md',
    'docs/measured.md', 'docs/setup/agents.md', 'docs/setup/sql-lane.md',
    'docs/setup/java-lane.md', 'docs/setup/web-lane.md', 'docs/setup/db-catalog.md'];
  // A whole SECTION can exist to say what this tool does not claim — §1.4 in the
  // README, "Contributions we do not accept" in CONTRIBUTING, "NOT verified" in
  // the changelog. Inside one of those, the forbidden phrase IS the content, so
  // the scan follows the nearest heading and steps over those sections.
  const DISCLAIMER_HEADING = /not goals|do not accept|what is not|not verified|forbidden|does not claim|known defect/i;
  const hits = [];
  for (const rel of pages) {
    const text = read(rel);
    let inDisclaimer = false;
    text.split('\n').forEach((line, i) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) inDisclaimer = DISCLAIMER_HEADING.test(heading[1]);
      if (inDisclaimer) return;
      // ...and, outside one, a line that disclaims the phrase in place.
      if (/\bnot\b|\bnever\b|\bcannot\b|\bdo not\b|\bdoes not\b|forbidden|MUST NOT|reject/i.test(line)) return;
      for (const re of forbidden) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `SPEC §1.4 forbids these claims:\n${hits.join('\n')}`);
});
