// What the npm package, the MCP Registry entry and the Claude Code plugin must agree on.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { createTools } from '../src/tools.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const entry = require('../server.json');
const plugin = require('../plugin/.claude-plugin/plugin.json');
const marketplace = require('../.claude-plugin/marketplace.json');
const pluginServers = require('../plugin/.mcp.json');

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

test('the plugin is at the version of the package, and the marketplace of this repository lists it', () => {
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.plugins.length, 1);
  const [listed] = marketplace.plugins;
  assert.equal(listed.name, plugin.name);
  assert.equal(listed.source, './plugin');
  // Claude Code reads the version of plugin.json first: it is written there only.
  assert.equal(listed.version, undefined);
});

test('the plugin starts this package, with the API key of its option', () => {
  const server = pluginServers.mcpServers.conv2pdf;
  // The command of the README: Claude Code then keeps one server when the user added it by hand too.
  assert.deepEqual([server.command, ...server.args], ['npx', '-y', pkg.name]);
  assert.deepEqual(server.env, { CONV2PDF_API_KEY: '${user_config.api_key}' });
  // Sensitive: the key goes to the credential store of the system, not to a settings file.
  assert.equal(plugin.userConfig.api_key.sensitive, true);
});

test('the skill names every tool of the server, and no tool it does not have', async () => {
  const skill = await fs.readFile(new URL('../plugin/skills/conv2pdf/SKILL.md', import.meta.url), 'utf8');
  const tools = createTools({ api: {}, hasKey: false }).tools.map((tool) => tool.name);
  for (const tool of tools) assert.ok(skill.includes(`\`${tool}\``), `the skill does not name ${tool}`);
  const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
  const fields = ['output_path', 'size_bytes'];
  assert.deepEqual(named.filter((name) => !tools.includes(name) && !fields.includes(name)), []);
});

test('the skill has the front matter the Agent Skills format asks for', async () => {
  const skill = await fs.readFile(new URL('../plugin/skills/conv2pdf/SKILL.md', import.meta.url), 'utf8');
  const [, frontMatter] = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const field = (name) => frontMatter.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1].trim();
  // The name is the one of the folder of the skill.
  assert.equal(field('name'), 'conv2pdf');
  assert.ok(field('description').length <= 1024, `description is ${field('description').length} characters long`);
  assert.ok(field('compatibility').length <= 500);
});

function npm(server) {
  return server.packages[0];
}
