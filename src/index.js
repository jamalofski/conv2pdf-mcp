import { createRequire } from 'node:module';

import { DEFAULT_BASE_URL, createClient } from './api.js';
import { createServer, serveStdio } from './protocol.js';
import { INSTRUCTIONS, createTools } from './tools.js';

export const { version } = createRequire(import.meta.url)('../package.json');

/**
 * Runs the MCP server on the standard streams until the client closes the input.
 *   CONV2PDF_API_KEY: the API key, required to call a tool
 *   CONV2PDF_API_URL: another root for the API, for the tests
 */
export function main({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const apiKey = (env.CONV2PDF_API_KEY ?? '').trim();
  const api = createClient({
    apiKey,
    baseUrl: env.CONV2PDF_API_URL || DEFAULT_BASE_URL,
    userAgent: `conv2pdf-mcp/${version}`,
  });
  const { tools, callTool } = createTools({ api, hasKey: apiKey !== '' });
  const server = createServer({
    info: { name: 'conv2pdf', title: 'conv2pdf', version, websiteUrl: 'https://conv2pdf.com/en/api/' },
    instructions: INSTRUCTIONS,
    tools,
    callTool,
  });
  return serveStdio(server, { input, output });
}
