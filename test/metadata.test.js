// What the npm package and the MCP Registry entry must agree on.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const entry = require('../server.json');

test('the registry entry describes this package, at this version', () => {
  const [npm] = entry.packages;
  assert.equal(entry.packages.length, 1);
  assert.equal(npm.registryType, 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.equal(entry.version, pkg.version);
  // The registry checks the ownership of the package through this name.
  assert.equal(entry.name, pkg.mcpName);
});

test('the registry entry fits the limits of the registry schema', () => {
  assert.match(entry.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(entry.description.length <= 100, `description is ${entry.description.length} characters long`);
  assert.ok(entry.title.length <= 100);
  assert.deepEqual(npm(entry).environmentVariables.map((variable) => variable.name), ['CONV2PDF_API_KEY']);
  assert.equal(npm(entry).environmentVariables[0].isSecret, true);
});

test('the changelog has a section for this version, and the package ships what it runs', async () => {
  const changelog = await fs.readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(changelog, new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')} `, 'm'));
  assert.deepEqual(pkg.files, ['bin', 'src']);
  assert.equal(pkg.bin['conv2pdf-mcp'], 'bin/conv2pdf-mcp.js');
  assert.equal(pkg.dependencies, undefined);
});

function npm(server) {
  return server.packages[0];
}
