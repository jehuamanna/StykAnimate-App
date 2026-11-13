// A Model Context Protocol server over stdio: JSON-RPC 2.0, one message per line (the MCP "stdio" transport).
// Only what a tools-only server needs: initialize, ping, tools/list and tools/call. No dependency, so the scripting
// module stays a folder of its own (scripting/README.md).
//
// `serveStdio({name, version, instructions, tools})` reads stdin until it closes. Each tool is
// `{name, description, inputSchema, run(args) => result}`; a result is a string, `{content: [...]}` (MCP content
// blocks, passed through), or anything else (sent as JSON text). A thrown error becomes a tool error the model reads.
import {createInterface} from 'node:readline';

export const PROTOCOL_VERSION = '2025-06-18';

/** The MCP content of a tool's return value. */
export function toContent(value) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return {content: [{type: 'text', text}]};
}

/** Answers one JSON-RPC message; returns the reply, or null for a notification. */
export async function answer(server, message) {
  const {id, method, params} = message ?? {};
  const reply = result => ({jsonrpc: '2.0', id, result});
  const error = (code, text) => ({jsonrpc: '2.0', id: id ?? null, error: {code, message: text}});
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return id === undefined ? null : error(-32600, 'Invalid request.');
  const notification = id === undefined;
  switch (method) {
    case 'initialize':
      return reply({protocolVersion: params?.protocolVersion === PROTOCOL_VERSION ? PROTOCOL_VERSION : PROTOCOL_VERSION,
        capabilities: {tools: {listChanged: false}}, serverInfo: {name: server.name, version: server.version}, instructions: server.instructions});
    case 'ping': return reply({});
    case 'tools/list':
      return reply({tools: server.tools.map(({name, description, inputSchema}) => ({name, description, inputSchema}))});
    case 'tools/call': {
      const tool = server.tools.find(candidate => candidate.name === params?.name);
      if (!tool) return error(-32602, `Unknown tool ${JSON.stringify(params?.name)}.`);
      try { return reply(toContent(await tool.run(params?.arguments ?? {}))); }
      catch (failure) { return reply({...toContent(String(failure?.message ?? failure)), isError: true}); }
    }
    default:
      return notification ? null : error(-32601, `Method ${method} is not supported.`);
  }
}

/** Serves the tools over stdin and stdout until stdin closes. Logging goes to stderr: stdout carries only messages. */
export function serveStdio(server, {input = process.stdin, output = process.stdout} = {}) {
  const lines = createInterface({input, crlfDelay: Infinity});
  const write = message => { if (message) output.write(`${JSON.stringify(message)}\n`); };
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { write({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error.'}}); return; }
    // Calls run concurrently and answer when done: replies carry their ids.
    Promise.resolve(answer(server, message)).then(write, failure => write({jsonrpc: '2.0', id: message?.id ?? null, error: {code: -32603, message: String(failure?.message ?? failure)}}));
  });
  return new Promise(resolve => lines.once('close', resolve));
}
