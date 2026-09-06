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
      let out;
      try {
        out = deps.callTool(name, args);
      } catch (e) {
        // Tool/dispatch failure → isError result (not a JSON-RPC error), so the
        // model sees the reason and its code.
        const code = e && e.code ? ` [${e.code}]` : '';
        return reply({ content: [{ type: 'text', text: `error${code}: ${e && e.message}` }], isError: true });
      }
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
    }
    default:
      return isNotification ? null : rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
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
        if (resp) write(output, resp);
      }
    });
    input.on('end', () => resolve());
    input.on('close', () => resolve());
  });
}

function write(output, obj) {
  output.write(JSON.stringify(obj) + '\n');
}
