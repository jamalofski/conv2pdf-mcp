// A fake conv2pdf API on a local port, and a way to drive the real server over stdio.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/conv2pdf-mcp.js', import.meta.url));

export const QUOTA = { plan: 'dev', quota: 300, used: 12, soft_cap_limit: 330, status: 'ok' };
export const RESULT = Buffer.from('%PDF-1.7 fake result\n');

/** A temporary folder with the given files, removed by `cleanup()`. */
export async function workspace(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conv2pdf-mcp-'));
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  return { dir, file: (name) => path.join(dir, name), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * Starts a fake API. Every request is recorded in `calls`; for a conversion, with the
 * names and contents of the uploaded files and the form fields.
 * `respond(call)` may return { status, body, headers } to answer a call itself, or
 * nothing to let the fake API succeed.
 */
export async function fakeApi(respond = () => undefined) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, path: req.url, headers: req.headers };
    if (req.method === 'POST') {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      call.files = [];
      call.fields = {};
      for (const [name, value] of form.entries()) {
        if (typeof value === 'string') call.fields[name] = value;
        else call.files.push({ name: value.name, content: Buffer.from(await value.arrayBuffer()).toString() });
      }
    }
    calls.push(call);
    const custom = await respond(call, calls);
    if (custom) {
      res.writeHead(custom.status, { 'content-type': 'application/json', ...custom.headers });
      res.end(JSON.stringify(custom.body ?? {}));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/convert/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job1', status: 'success', download_url: '/v1/download/job1', size_bytes: RESULT.length, quota: QUOTA }));
    } else if (req.method === 'GET' && req.url === '/v1/download/job1') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="result.pdf"' });
      res.end(RESULT);
    } else if (req.method === 'DELETE' && req.url === '/v1/job/job1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"deleted":true}');
    } else if (req.method === 'GET' && req.url === '/v1/quota') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(QUOTA));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/**
 * Starts the real server as an MCP client does, and exchanges JSON-RPC lines with it.
 * `t` is the test context: the process is killed when the test ends, so that a failed
 * assertion never leaves the runner waiting for it.
 */
export function startServer(t, env = {}) {
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, CONV2PDF_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  const lines = [];
  const waiting = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (waiting.length) waiting.shift()(line);
      else lines.push(line);
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    send: (message) => child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
    /** The next line of stdout, as text. */
    line: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiting.push(resolve))),
    /** Closes the input, as a client does to stop the server, and resolves to the exit code. */
    stop: () => { child.stdin.end(); return exited; },
    exited,
  };
}
