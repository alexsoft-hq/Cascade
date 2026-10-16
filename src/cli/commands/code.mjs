// The same code-intelligence tools over the CLI, with the serving freshness barrier.
const ACTIONS = Object.freeze({
  briefing: 'session_briefing', architecture: 'architecture', search: 'code_search', outline: 'file_outline',
  trace: 'code_trace', context: 'code_context', snippet: 'code_snippet', status: 'index_status',
});

export async function run(cli) {
  const action = cli.argv[1];
  if (!Object.hasOwn(ACTIONS, action ?? '')) {
    return cli.die(`cascade code: choose ${Object.keys(ACTIONS).join(', ')}`);
  }
  const args = {};
  for (const key of ['query', 'file', 'symbol', 'kind', 'direction']) {
    const value = cli.opt(key);
    if (value !== undefined) args[key] = value;
  }
  for (const [flag, key] of Object.entries({
    limit: 'limit', offset: 'offset', depth: 'depth', 'max-bytes': 'maxBytes',
    'max-lines': 'maxLines', 'from-line': 'fromLine', 'to-line': 'toLine',
  })) {
    const value = cli.opt(flag);
    if (value !== undefined) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return cli.die(`--${flag} must be a whole number`);
      args[key] = Number(value);
    }
  }
  const ids = cli.optAll('project');
  if (ids.length > 1) return cli.die('cascade code selects one --project per query');
  if (ids.length === 1) args.project = ids[0];
  let host;
  let failure;
  try {
    host = cli.servedHost('code');
    const result = await host.callToolAsync(ACTIONS[action], args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    failure = `cascade code${error.code ? ` [${error.code}]` : ''}: ${error.message}`;
  } finally {
    await host?.close?.();
  }
  if (failure) cli.die(failure);
}
