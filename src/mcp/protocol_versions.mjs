// protocol_versions.mjs — MCP protocol versions this server understands, newest
// first. On initialize, echo the client's version if known, else offer the
// newest known (the client then decides). SPEC §13 negotiation.

export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

export const serverInfo = Object.freeze({ name: 'cascade', version: '0.0.1' });
