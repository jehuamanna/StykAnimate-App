// The scripting MCP server's protocol layer (scripting/README.md): what Claude Code reads from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PassThrough} from 'node:stream';
import {answer, serveStdio, toContent} from '../scripting/mcp-protocol.mjs';

const server = {name: 'test', version: '1.0.0', instructions: 'Use the tools.', tools: [
  {name: 'echo', description: 'Echoes.', inputSchema: {type: 'object'}, run: args => args},
  {name: 'text', description: 'Text.', inputSchema: {type: 'object'}, run: () => 'plain'},
  {name: 'broken', description: 'Fails.', inputSchema: {type: 'object'}, run: () => { throw new Error('It broke.'); }},
]};

test('initialize names the server and offers tools', async () => {
  const reply = await answer(server, {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}}});
  assert.equal(reply.id, 1);
  assert.deepEqual(reply.result.serverInfo, {name: 'test', version: '1.0.0'});
  assert.ok(reply.result.capabilities.tools);
  assert.equal(reply.result.instructions, 'Use the tools.');
});

test('tools/list lists each tool without its implementation', async () => {
  const reply = await answer(server, {jsonrpc: '2.0', id: 2, method: 'tools/list'});
  assert.deepEqual(reply.result.tools.map(tool => Object.keys(tool).sort()), Array(3).fill(['description', 'inputSchema', 'name']));
});

test('tools/call returns content, and a failing tool is a tool error the model can read', async () => {
  const echoed = await answer(server, {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'echo', arguments: {a: 1}}});
  assert.deepEqual(JSON.parse(echoed.result.content[0].text), {a: 1});
  const text = await answer(server, {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'text'}});
  assert.deepEqual(text.result.content, [{type: 'text', text: 'plain'}]);
  const broken = await answer(server, {jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'broken'}});
  assert.equal(broken.result.isError, true);
  assert.equal(broken.result.content[0].text, 'It broke.');
  const unknown = await answer(server, {jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'nope'}});
  assert.equal(unknown.error.code, -32602);
});

test('notifications get no reply; unknown requests get method-not-found', async () => {
  assert.equal(await answer(server, {jsonrpc: '2.0', method: 'notifications/initialized'}), null);
  assert.equal((await answer(server, {jsonrpc: '2.0', id: 7, method: 'resources/list'})).error.code, -32601);
});

test('image content passes through unchanged', () => {
  const content = {content: [{type: 'image', data: 'AA==', mimeType: 'image/png'}]};
  assert.equal(toContent(content), content);
});

test('stdio carries one message per line and answers each request', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const done = serveStdio(server, {input, output});
  const lines = [];
  output.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)));
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
  input.end();
  await done;
  await new Promise(resolve => setImmediate(resolve));
  const messages = lines.map(line => JSON.parse(line));
  assert.deepEqual(messages.find(m => m.id === 1)?.result, {});
  assert.equal(messages.find(m => m.error)?.error.code, -32700);
});

test('the page library parses as a classic script', () => {
  const source = readFileSync(new URL('../scripting/page-runtime.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(source));
});
