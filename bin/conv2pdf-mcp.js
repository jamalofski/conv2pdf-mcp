#!/usr/bin/env node
import { main, version } from '../src/index.js';

const HELP = `conv2pdf-mcp ${version}
MCP server of the conv2pdf API. An MCP client starts it and talks to it over stdio:

  {
    "mcpServers": {
      "conv2pdf": {
        "command": "npx",
        "args": ["-y", "conv2pdf-mcp"],
        "env": { "CONV2PDF_API_KEY": "cpdf_live_..." }
      }
    }
  }

Documentation: https://github.com/jamalofski/conv2pdf-mcp
`;

const argument = process.argv[2];
if (argument === '--version' || argument === '-v') {
  process.stdout.write(`${version}\n`);
} else if (argument === '--help' || argument === '-h') {
  process.stdout.write(HELP);
} else {
  await main();
}
