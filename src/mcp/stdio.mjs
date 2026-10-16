// stdio.mjs — MCP server over stdio (JSON-RPC 2.0). SPEC §13, standard MCP.
//
// The protocol logic is a PURE function `handleRpc(request, deps)` (unit-testable
// without any I/O); `serve()` is a thin line-delimited loop around it. A real MCP
// client (e.g. Claude Code) speaks this to query the analysis: initialize →
// tools/list → tools/call.
//
// Key protocol choices (mirroring the MCP spec + the reference implementation):
//  - A TOOL failure is NOT a JSON-RPC error: it returns result.isError=true with
//    the reason as text, so the model reads it and picks another path.
//  - A SERVER/protocol failure (unknown method, bad request) IS a JSON-RPC error.
//  - Notifications (no id) get no response.

import { PROTOCOL_VERSIONS, serverInfo as defaultServerInfo } from './protocol_versions.mjs';

/**
 * Handle one JSON-RPC request object. Pure.
 * @param {object} req  a parsed JSON-RPC request
 * @param {{toolList:()=>object, callTool:(name:string,args:object)=>object, serverInfo?:object}} deps
 * @returns {object|null} a JSON-RPC response object, or null for a notification
 */
export function handleRpc(req, deps) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return rpcError(req && req.id != null ? req.id : null, -32600, 'invalid JSON-RPC request');
  }
  const isNotification = req.id === undefined || req.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: req.id, result });

  switch (req.method) {
    case 'initialize': {
      const asked = req.params && req.params.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: deps.serverInfo || defaultServerInfo,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications: no response
    case 'ping':
      return reply({});
    case 'tools/list': {
      const cat = deps.toolList();
      return reply({ tools: cat.tools });
    }
    case 'tools/call': {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      // A notification (no id) never gets a response, even on a bad request.
      if (!name) return isNotification ? null : rpcError(req.id, -32602, 'tools/call requires params.name');
      return callRpcTool(deps, name, args, reply);
    }
    default:
      return isNotification ? null : rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

function callRpcTool(deps, name, args, reply) {
  const success = (value) => reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const failure = (error) => reply({ content: [{ type: 'text', text: `error${error?.code ? ` [${error.code}]` : ''}: ${error?.message}` }], isError: true });
  try {
    const out = deps.callTool(name, args);
    return out && typeof out.then === 'function' ? Promise.resolve(out).then(success, failure) : success(out);
  } catch (error) { return failure(error); }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Run an stdio JSON-RPC loop. Reads line-delimited JSON from `input`, writes
 * line-delimited JSON responses to `output`.
 * @param {{input?:NodeJS.ReadableStream, output?:NodeJS.WritableStream, deps:object}} cfg
 * @returns {Promise<void>} resolves when input ends
 */
export function serve({ input = process.stdin, output = process.stdout, deps }) {
  return new Promise((resolve) => {
    let buf = '';
    const pending = new Set();
    const replyInOrder = orderedReplies(output, pending);
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          write(output, rpcError(null, -32700, 'parse error'));
          continue;
        }
        const resp = handleRpc(req, deps);
        replyInOrder(resp);
      }
    });
    finishOnDisconnect(input, output, deps, pending, resolve);
  });
}

function finishOnDisconnect(input, output, deps, pending, resolve) {
  let ended = false, disconnected = false;
  const disconnect = () => { if (!disconnected) { disconnected = true; deps.onDisconnect?.(); } };
  const finish = () => Promise.allSettled([...pending]).then(() => { disconnect(); resolve(); });
  const abort = () => { disconnect(); void finish(); };
  // EOF is a half-close: a piped client can still be waiting for its answers.
  input.once('end', () => { ended = true; void finish(); });
  input.once('close', () => { if (!ended) abort(); });
  input.once('error', abort);
  output.once('close', abort);
  output.once('error', abort);
}

function orderedReplies(output, pending) {
  let tail = null;
  return (response) => {
    if (!tail && !(response && typeof response.then === 'function')) { if (response) write(output, response); return; }
    const task = (tail ?? Promise.resolve()).then(() => response).then((value) => { if (value && !output.destroyed) write(output, value); }).finally(() => pending.delete(task));
    pending.add(task); tail = task;
  };
}

function write(output, obj) {
  output.write(JSON.stringify(obj) + '\n');
}
