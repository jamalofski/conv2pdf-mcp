// The Model Context Protocol over stdio, for a server that only offers tools.
//
// No dependency and no state: one JSON-RPC message per line in, one per line out. Both
// protocol eras are served by the same process, chosen request by request as the
// specification asks of a "dual-era" server:
//   - 2026-07-28: no handshake, each request carries its protocol version and the client
//     capabilities in `_meta`, and `server/discover` describes the server;
//   - 2025-11-25 and earlier: `initialize`, then plain requests.
// Specification: https://modelcontextprotocol.io/specification/2026-07-28

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

// JSON-RPC codes, then the one the MCP specification reserves (2026-07-28).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

// The tool list only changes with a new version of the package: a client may keep it
// for an hour, and it is the same for everyone.
const CACHE_HINTS = { ttlMs: 60 * 60 * 1000, cacheScope: 'public' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id === undefined ? null : id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * A tools-only MCP server.
 *   info: { name, title, version, websiteUrl }
 *   instructions: guidance for the model
 *   tools: [{ name, title, description, inputSchema, annotations }]
 *   callTool(name, args, { signal }): the tool result, { content, structuredContent?, isError? }
 * Returns { handle(message), close() }: `handle` resolves to the response to write, or to
 * undefined when there is none (a notification, a cancelled request).
 */
export function createServer({ info, instructions, tools, callTool }) {
  const names = new Set(tools.map((tool) => tool.name));
  // The requests being processed, to abort one when the client cancels it.
  const running = new Map();

  async function runTool(id, params) {
    const name = isObject(params) ? params.name : undefined;
    if (!names.has(name)) return { error: [INVALID_PARAMS, `Unknown tool: ${String(name).slice(0, 100)}`] };
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) return { error: [INVALID_PARAMS, 'Invalid params: "arguments" must be an object'] };
    const controller = new AbortController();
    running.set(id, controller);
    try {
      const result = await callTool(name, args, { signal: controller.signal });
      return controller.signal.aborted ? { cancelled: true } : { result };
    } catch (error) {
      if (controller.signal.aborted) return { cancelled: true };
      throw error;
    } finally {
      running.delete(id);
    }
  }

  async function handle(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(undefined, INVALID_REQUEST, 'Invalid request: expected one JSON-RPC 2.0 request or notification');
    }
    const { id, method, params } = message;
    if (id === undefined) {
      // On stdio a client cancels a request with a notification; the others need no action.
      if (method === 'notifications/cancelled' && isObject(params)) running.get(params.requestId)?.abort();
      return undefined;
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      return rpcError(undefined, INVALID_REQUEST, 'Invalid request: "id" must be a string or a number');
    }
    if (params !== undefined && !isObject(params)) {
      return rpcError(id, INVALID_REQUEST, 'Invalid request: "params" must be an object');
    }

    try {
      // The body decides the era: a request that carries its version in `_meta` belongs
      // to 2026-07-28, any other to the handshake era.
      const meta = isObject(params) && isObject(params._meta) ? params._meta : {};
      const claimed = meta[META_VERSION];

      if (claimed !== undefined) {
        if (typeof claimed !== 'string') {
          return rpcError(id, INVALID_PARAMS, `Invalid params: _meta field ${META_VERSION} must be a string`);
        }
        if (!MODERN_VERSIONS.includes(claimed)) {
          return rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
            supported: SUPPORTED_VERSIONS,
            requested: claimed,
          });
        }
        if (!isObject(meta[META_CLIENT_CAPABILITIES])) {
          return rpcError(id, INVALID_PARAMS, `Invalid params: missing required _meta field ${META_CLIENT_CAPABILITIES}`);
        }
        const complete = (result, cacheable) => ({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            ...result,
            ...(cacheable ? CACHE_HINTS : {}),
            _meta: { [META_SERVER_INFO]: info },
          },
        });
        if (method === 'server/discover') {
          return complete({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions }, true);
        }
        if (method === 'tools/list') return complete({ tools }, true);
        if (method === 'tools/call') {
          const outcome = await runTool(id, params);
          if (outcome.cancelled) return undefined;
          return outcome.error ? rpcError(id, ...outcome.error) : complete(outcome.result, false);
        }
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 100)}`);
      }

      if (method === 'initialize') {
        const requested = isObject(params) ? params.protocolVersion : undefined;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            // The requested version when we speak it, else our latest of this era: the
            // client decides whether it can do with it.
            protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: info,
            instructions,
          },
        };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
      if (method === 'tools/call') {
        const outcome = await runTool(id, params);
        if (outcome.cancelled) return undefined;
        return outcome.error ? rpcError(id, ...outcome.error) : { jsonrpc: '2.0', id, result: outcome.result };
      }
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 100)}`);
    } catch (error) {
      return rpcError(id, INTERNAL_ERROR, `Internal error: ${error && error.message ? error.message : 'unknown'}`);
    }
  }

  // Stops the requests still running: the client is gone, nobody reads their result.
  function close() {
    for (const controller of running.values()) controller.abort();
  }

  return { handle, close };
}

/**
 * Connects a server to a pair of streams: newline-delimited JSON-RPC, nothing else on
 * the output. Resolves when the input ends and the last response is written.
 */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const pending = new Set();
    let buffer = '';
    let ended = false;
    const write = (response) => output.write(`${JSON.stringify(response)}\n`);
    const settle = () => { if (ended && pending.size === 0) resolve(); };

    const dispatch = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(rpcError(undefined, PARSE_ERROR, 'Parse error: the line is not valid JSON'));
        return;
      }
      const task = server.handle(message).then((response) => { if (response) write(response); });
      pending.add(task);
      task.finally(() => { pending.delete(task); settle(); });
    };

    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) dispatch(line);
      }
    });
    // A closed input is the client's way to stop the server.
    input.on('end', () => {
      ended = true;
      server.close();
      settle();
    });
  });
}
