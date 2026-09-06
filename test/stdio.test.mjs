import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { handleRpc, serve } from '../src/mcp/stdio.mjs';
import { PROTOCOL_VERSIONS } from '../src/mcp/protocol_versions.mjs';

// ---------------------------------------------------------------------------
// Fixture — a mocked `deps` (the real one is src/mcp/catalog.mjs, but handleRpc
// only needs the shape: toolList()/callTool()/serverInfo). callTool answers a
// canned object for 'column_impact' and throws (with a .code) for anything
// else, so both the tools/call success path and the isError path are exercised.
// ---------------------------------------------------------------------------

const CANNED_RESULT = { answer: { column: 'pms_product.price' }, trust: { trustLevel: 'UNCERTIFIED' } };
const FAKE_SERVER_INFO = { name: 'cascade-test', version: '9.9.9' };

function makeDeps() {
  return {
    toolList: () => ({
      schema: 'x',
      tools: [{ name: 'column_impact', description: 'd', inputSchema: {} }],
    }),
    callTool: (name) => {
      if (name === 'column_impact') return CANNED_RESULT;
      throw Object.assign(new Error('nope'), { code: 'unknown-column' });
    },
    serverInfo: FAKE_SERVER_INFO,
  };
}

// ---------------------------------------------------------------------------
// handleRpc — initialize
// ---------------------------------------------------------------------------

test('initialize: returns jsonrpc/id/result with protocolVersion, capabilities.tools, serverInfo', () => {
  const req = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSIONS[0] } };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 1);
  assert.ok(resp.result);
  assert.equal(typeof resp.result.protocolVersion, 'string');
  assert.deepEqual(resp.result.capabilities.tools, {});
  assert.deepEqual(resp.result.serverInfo, FAKE_SERVER_INFO);
});

test('initialize: echoes back a KNOWN requested protocolVersion', () => {
  const known = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1]; // oldest known, still known
  const req = { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: known } };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.result.protocolVersion, known);
});

test('initialize: an UNKNOWN requested protocolVersion falls back to the newest known', () => {
  const req = { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25' } };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('initialize: garbage protocolVersion also falls back to the newest known', () => {
  const req = { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: 'garbage' } };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('initialize: uses the default serverInfo when deps does not provide one', () => {
  const deps = makeDeps();
  delete deps.serverInfo;
  const req = { jsonrpc: '2.0', id: 5, method: 'initialize', params: {} };
  const resp = handleRpc(req, deps);
  assert.equal(resp.result.serverInfo.name, 'cascade');
});

// ---------------------------------------------------------------------------
// handleRpc — ping
// ---------------------------------------------------------------------------

test('ping: returns an empty result object', () => {
  const req = { jsonrpc: '2.0', id: 6, method: 'ping' };
  const resp = handleRpc(req, makeDeps());
  assert.deepEqual(resp.result, {});
});

// ---------------------------------------------------------------------------
// handleRpc — tools/list
// ---------------------------------------------------------------------------

test('tools/list: returns result.tools sourced from deps.toolList()', () => {
  const req = { jsonrpc: '2.0', id: 7, method: 'tools/list' };
  const resp = handleRpc(req, makeDeps());
  assert.ok(Array.isArray(resp.result.tools));
  assert.deepEqual(resp.result.tools.map((t) => t.name), ['column_impact']);
});

// ---------------------------------------------------------------------------
// handleRpc — tools/call
// ---------------------------------------------------------------------------

test('tools/call success: result.content is a text block whose text JSON-decodes to the tool return', () => {
  const req = {
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'column_impact', arguments: { column: 'pms_product.price' } },
  };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.result.isError, undefined);
  assert.equal(resp.result.content.length, 1);
  assert.equal(resp.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(resp.result.content[0].text), CANNED_RESULT);
});

test('tools/call failure: isError:true result, NOT a top-level JSON-RPC error', () => {
  const req = {
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'nonexistent_tool', arguments: {} },
  };
  const resp = handleRpc(req, makeDeps());
  assert.equal('error' in resp, false);
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /unknown-column/);
  assert.match(resp.result.content[0].text, /nope/);
});

test('tools/call missing name: JSON-RPC error -32602', () => {
  const req = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { arguments: {} } };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.error.code, -32602);
});

test('tools/call with no params at all: JSON-RPC error -32602', () => {
  const req = { jsonrpc: '2.0', id: 11, method: 'tools/call' };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.error.code, -32602);
});

// ---------------------------------------------------------------------------
// handleRpc — unknown method / invalid request
// ---------------------------------------------------------------------------

test('unknown method (with id): JSON-RPC error -32601', () => {
  const req = { jsonrpc: '2.0', id: 12, method: 'frobnicate' };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.error.code, -32601);
  assert.equal(resp.id, 12);
});

test('invalid request: missing jsonrpc field -> -32600, id echoed', () => {
  const req = { id: 13, method: 'ping' };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.error.code, -32600);
  assert.equal(resp.id, 13);
});

test('invalid request: missing method -> -32600, id echoed', () => {
  const req = { jsonrpc: '2.0', id: 14 };
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.error.code, -32600);
  assert.equal(resp.id, 14);
});

test('invalid request: no id present -> -32600 with id null', () => {
  const req = { method: 'ping' }; // missing jsonrpc, and no id at all
  const resp = handleRpc(req, makeDeps());
  assert.equal(resp.error.code, -32600);
  assert.equal(resp.id, null);
});

// ---------------------------------------------------------------------------
// handleRpc — notifications (no id) get no response
// ---------------------------------------------------------------------------

test('notifications/initialized: returns null', () => {
  const req = { jsonrpc: '2.0', method: 'notifications/initialized' };
  assert.equal(handleRpc(req, makeDeps()), null);
});

test('notifications/cancelled: returns null', () => {
  const req = { jsonrpc: '2.0', method: 'notifications/cancelled' };
  assert.equal(handleRpc(req, makeDeps()), null);
});

test('unknown method without an id (a notification): returns null, no error emitted', () => {
  const req = { jsonrpc: '2.0', method: 'frobnicate' };
  assert.equal(handleRpc(req, makeDeps()), null);
});

// ---------------------------------------------------------------------------
// handleRpc — id echo
// ---------------------------------------------------------------------------

test('response.id always equals the request id when an id is present', () => {
  for (const id of [1, 'abc', 42]) {
    const resp = handleRpc({ jsonrpc: '2.0', id, method: 'ping' }, makeDeps());
    assert.equal(resp.id, id);
  }
});

// ---------------------------------------------------------------------------
// serve — line-delimited loop (light integration via PassThrough streams)
// ---------------------------------------------------------------------------

function collectLines(output) {
  let buf = '';
  output.on('data', (chunk) => { buf += chunk; });
  return () => buf.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

test('serve: a valid tools/list request line produces one JSON-RPC response line', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const getLines = collectLines(output);

  const donePromise = serve({ input, output, deps: makeDeps() });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  input.end();
  await donePromise;

  const lines = getLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 1);
  assert.deepEqual(lines[0].result.tools.map((t) => t.name), ['column_impact']);
});

test('serve: a notification line (no id) produces no output line', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const getLines = collectLines(output);

  const donePromise = serve({ input, output, deps: makeDeps() });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.end();
  await donePromise;

  assert.deepEqual(getLines(), []);
});

test('serve: a malformed JSON line yields a -32700 parse-error response with id null', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const getLines = collectLines(output);

  const donePromise = serve({ input, output, deps: makeDeps() });
  input.write('{not json\n');
  input.end();
  await donePromise;

  const lines = getLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[0].id, null);
});

test('serve: blank lines are skipped (no output, no crash) and valid lines around them still respond', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const getLines = collectLines(output);

  const donePromise = serve({ input, output, deps: makeDeps() });
  input.write('\n');
  input.write('   \n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping' }) + '\n');
  input.write('\n');
  input.end();
  await donePromise;

  const lines = getLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 20);
  assert.deepEqual(lines[0].result, {});
});

test('serve: multiple request lines each produce a response, in order', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const getLines = collectLines(output);

  const donePromise = serve({ input, output, deps: makeDeps() });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'ping' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/list' }) + '\n');
  input.end();
  await donePromise;

  const lines = getLines();
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 30);
  assert.equal(lines[1].id, 31);
});

test('serve: the returned promise resolves when input ends', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const donePromise = serve({ input, output, deps: makeDeps() });
  input.end();
  await assert.doesNotReject(donePromise);
});
