import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SUPPORTED_VERSIONS, createServer } from '../src/protocol.js';

const INFO = { name: 'demo', version: '1.2.3' };
const TOOLS = [{ name: 'echo', title: 'Echo', description: 'Echoes.', inputSchema: { type: 'object' } }];

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

function server(callTool = async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })) {
  return createServer({ info: INFO, instructions: 'How to use it.', tools: TOOLS, callTool });
}
const request = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const modern = (method, params = {}, meta = META) => request(method, { ...params, _meta: meta });

test('handshake era: initialize echoes a version the server speaks', async () => {
  const response = await server().handle(request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
  assert.deepEqual(response.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: INFO,
    instructions: 'How to use it.',
  });
});

test('handshake era: an unknown version, or 2026-07-28, gets the latest version of that era', async () => {
  for (const protocolVersion of ['1999-01-01', '2026-07-28', undefined]) {
    const response = await server().handle(request('initialize', { protocolVersion }));
    assert.equal(response.result.protocolVersion, '2025-11-25');
  }
});

test('handshake era: ping, tools/list and tools/call', async () => {
  const mcp = server();
  assert.deepEqual((await mcp.handle(request('ping'))).result, {});
  assert.deepEqual((await mcp.handle(request('tools/list'))).result, { tools: TOOLS });
  const called = await mcp.handle(request('tools/call', { name: 'echo', arguments: { a: 1 } }));
  assert.deepEqual(called.result, { content: [{ type: 'text', text: '{"a":1}' }] });
  assert.equal((await mcp.handle(request('resources/list'))).error.code, -32601);
});

test('2026-07-28: server/discover names the versions of both eras', async () => {
  const response = await server().handle(modern('server/discover'));
  assert.deepEqual(response.result, {
    resultType: 'complete',
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    instructions: 'How to use it.',
    ttlMs: 3600000,
    cacheScope: 'public',
    _meta: { 'io.modelcontextprotocol/serverInfo': INFO },
  });
  assert.equal(SUPPORTED_VERSIONS[0], '2026-07-28');
});

test('2026-07-28: tools/list is cacheable, a tool result is not', async () => {
  const mcp = server();
  const list = (await mcp.handle(modern('tools/list'))).result;
  assert.deepEqual(list.tools, TOOLS);
  assert.equal(list.resultType, 'complete');
  assert.equal(list.cacheScope, 'public');
  const called = (await mcp.handle(modern('tools/call', { name: 'echo', arguments: { a: 1 } }))).result;
  assert.equal(called.resultType, 'complete');
  assert.equal(called.content[0].text, '{"a":1}');
  assert.equal('ttlMs' in called, false);
});

test('2026-07-28: ping and initialize do not exist', async () => {
  const mcp = server();
  assert.equal((await mcp.handle(modern('ping'))).error.code, -32601);
  assert.equal((await mcp.handle(modern('initialize'))).error.code, -32601);
});

test('2026-07-28: an unsupported version is refused with the supported ones', async () => {
  const meta = { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' };
  const { error } = await server().handle(modern('tools/list', {}, meta));
  assert.equal(error.code, -32022);
  assert.deepEqual(error.data, { supported: SUPPORTED_VERSIONS, requested: '2099-01-01' });
});

test('2026-07-28: a request without client capabilities, or with a version that is not a string, is malformed', async () => {
  const mcp = server();
  const { error } = await mcp.handle(modern('tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }));
  assert.equal(error.code, -32602);
  assert.match(error.message, /clientCapabilities/);
  const wrongType = await mcp.handle(modern('tools/list', {}, { ...META, 'io.modelcontextprotocol/protocolVersion': 20260728 }));
  assert.equal(wrongType.error.code, -32602);
});

test('an unknown tool and arguments that are not an object are protocol errors', async () => {
  const mcp = server();
  for (const build of [request, modern]) {
    const unknown = await mcp.handle(build('tools/call', { name: 'nope', arguments: {} }));
    assert.equal(unknown.error.code, -32602);
    assert.match(unknown.error.message, /Unknown tool: nope/);
    assert.equal((await mcp.handle(build('tools/call', { name: 'echo', arguments: 'x' }))).error.code, -32602);
  }
  assert.equal((await mcp.handle(request('tools/call'))).error.code, -32602);
});

test('a call without arguments gets an empty object', async () => {
  const response = await server().handle(request('tools/call', { name: 'echo' }));
  assert.equal(response.result.content[0].text, '{}');
});

test('messages that are not JSON-RPC requests are refused, with a null id when none can be read', async () => {
  const mcp = server();
  for (const message of [[], 'ping', { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: null, method: 'ping' }]) {
    const response = await mcp.handle(message);
    assert.equal(response.error.code, -32600);
    assert.equal(response.id, null);
  }
  const arrayParams = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'ping', params: [1] });
  assert.equal(arrayParams.error.code, -32600);
  assert.equal(arrayParams.id, 7);
});

test('a notification gets no response', async () => {
  const mcp = server();
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'unknown' } }), undefined);
});

test('a cancelled call is aborted and gets no response', { timeout: 5000 }, async () => {
  let aborted = false;
  const mcp = server((name, args, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
  }));
  const pending = mcp.handle(request('tools/call', { name: 'echo', arguments: {} }, 'call-1'));
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } });
  assert.equal(await pending, undefined);
  assert.equal(aborted, true);
});

test('close() aborts the calls still running', { timeout: 5000 }, async () => {
  const mcp = server((name, args, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  const pending = mcp.handle(request('tools/call', { name: 'echo', arguments: {} }));
  mcp.close();
  assert.equal(await pending, undefined);
});

test('an exception in a tool is an internal error, not a crash', async () => {
  const mcp = server(async () => { throw new Error('boom'); });
  const response = await mcp.handle(request('tools/call', { name: 'echo', arguments: {} }));
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /boom/);
});
