// The real binary, started as an MCP client starts it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { BIN, QUOTA, RESULT, fakeApi, startServer, workspace } from './helpers.js';

const { version } = createRequire(import.meta.url)('../package.json');

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
};

test('handshake, tool list and a clean exit when the input closes', { timeout: 20_000 }, async (t) => {
  const server = startServer(t);
  server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const init = JSON.parse(await server.line());
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.serverInfo, { name: 'conv2pdf', title: 'conv2pdf', version, websiteUrl: 'https://conv2pdf.com/en/api/' });

  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = JSON.parse(await server.line());
  assert.equal(list.id, 2);
  assert.deepEqual(list.result.tools.map((tool) => tool.name), [
    'convert_to_pdf', 'convert_heic_to_jpg', 'convert_pdf_to_word', 'convert_pdf_to_images', 'merge_pdfs',
    'extract_pdf_pages', 'rotate_pdf', 'add_page_numbers', 'add_watermark', 'compress_pdf', 'protect_pdf',
    'unlock_pdf', 'get_quota',
  ]);
  for (const tool of list.result.tools) {
    assert.equal(typeof tool.title, 'string');
    assert.equal(tool.annotations.title, tool.title);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(await server.stop(), 0);
});

test('2026-07-28 without a handshake: discover, then a call that converts a file', { timeout: 20_000 }, async (t) => {
  const api = await fakeApi();
  const files = await workspace({ 'report.docx': 'a word document' });
  t.after(async () => { await api.close(); await files.cleanup(); });
  const server = startServer(t, { CONV2PDF_API_KEY: 'cpdf_live_test', CONV2PDF_API_URL: api.url });

  server.send({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: META } });
  const discover = JSON.parse(await server.line());
  assert.equal(discover.result.resultType, 'complete');
  assert.equal(discover.result.supportedVersions[0], '2026-07-28');

  server.send({ jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'convert_to_pdf', arguments: { input_path: files.file('report.docx') }, _meta: META } });
  const called = JSON.parse(await server.line());
  assert.equal(called.result.resultType, 'complete');
  assert.deepEqual(called.result.structuredContent, { output_path: files.file('report.pdf'), size_bytes: RESULT.length, quota: QUOTA });
  assert.deepEqual(await fs.readFile(files.file('report.pdf')), RESULT);
  assert.equal(api.calls[0].headers['user-agent'], `conv2pdf-mcp/${version}`);
  assert.equal(api.calls[0].headers.authorization, 'Bearer cpdf_live_test');
  assert.equal(await server.stop(), 0);
});

test('a line that is not JSON gets a parse error and the server keeps going', { timeout: 20_000 }, async (t) => {
  const server = startServer(t);
  server.send('{"jsonrpc": ');
  server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(JSON.parse(await server.line()), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the line is not valid JSON' } });
  assert.deepEqual(JSON.parse(await server.line()), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(await server.stop(), 0);
});

test('without an API key, or with a blank one, a call says how to set the key and the API is not called', { timeout: 20_000 }, async (t) => {
  const api = await fakeApi();
  t.after(() => api.close());
  for (const key of ['', '   ']) {
    const server = startServer(t, { CONV2PDF_API_KEY: key, CONV2PDF_API_URL: api.url });
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_quota', arguments: {} } });
    const { result } = JSON.parse(await server.line());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^No conv2pdf API key\. Set the CONV2PDF_API_KEY environment variable/);
    assert.match(result.content[0].text, /dashboard\/#developer/);
    assert.equal(await server.stop(), 0);
  }
  assert.equal(api.calls.length, 0);
});

test('closing the input while a conversion runs stops the server', { timeout: 20_000 }, async (t) => {
  let release;
  const api = await fakeApi((call) => (call.method === 'POST' ? new Promise((resolve) => { release = () => resolve({ status: 500, body: {} }); }) : undefined));
  const files = await workspace({ 'report.docx': 'a word document' });
  t.after(async () => { release?.(); await api.close(); await files.cleanup(); });
  const server = startServer(t, { CONV2PDF_API_KEY: 'cpdf_live_test', CONV2PDF_API_URL: api.url });

  server.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'convert_to_pdf', arguments: { input_path: files.file('report.docx') } } });
  while (api.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await server.stop(), 0);
  // The file reserved for the result does not stay behind.
  assert.deepEqual(await fs.readdir(files.dir), ['report.docx']);
});

test('a cancelled call gets no response, and the next request is answered', { timeout: 20_000 }, async (t) => {
  let release;
  const api = await fakeApi((call) => (call.method === 'POST' ? new Promise((resolve) => { release = () => resolve({ status: 500, body: {} }); }) : undefined));
  const files = await workspace({ 'report.docx': 'a word document' });
  t.after(async () => { release?.(); await api.close(); await files.cleanup(); });
  const server = startServer(t, { CONV2PDF_API_KEY: 'cpdf_live_test', CONV2PDF_API_URL: api.url });

  server.send({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'convert_to_pdf', arguments: { input_path: files.file('report.docx') } } });
  while (api.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow', reason: 'test' } });
  server.send({ jsonrpc: '2.0', id: 'next', method: 'ping' });
  assert.deepEqual(JSON.parse(await server.line()), { jsonrpc: '2.0', id: 'next', result: {} });
  assert.equal(await server.stop(), 0);
  // Once the server is done, the file reserved for the result is gone.
  assert.deepEqual(await fs.readdir(files.dir), ['report.docx']);
});

test('--version and --help print and exit', () => {
  assert.equal(execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).trim(), version);
  assert.match(execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }), /CONV2PDF_API_KEY/);
});
