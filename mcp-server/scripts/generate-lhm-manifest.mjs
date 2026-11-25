import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const MANIFEST = new URL('../../lhm.plugin.json', import.meta.url);
const check = process.argv.includes('--check');

for (const name of Object.keys(process.env)) {
  if (name.startsWith('MCP_') || name.startsWith('ADAPTLYPOST_')) delete process.env[name];
}

const { createMcpServer } = await import('../src/index.ts');
const { withPortableToolSchemas } = await import('../src/portable-tool-schemas.ts');

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer('http');
await server.connect(withPortableToolSchemas(serverTransport));
const client = new Client({ name: 'lhm-manifest', version: '1.0.0' });
await client.connect(clientTransport);

const listAll = async (method, key) => {
  const items = [];
  let cursor;
  do {
    const page = await method({ cursor });
    items.push(...page[key]);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
};

const tools = await listAll((params) => client.listTools(params), 'tools');
const resources = await listAll((params) => client.listResources(params), 'resources');
const templates = await listAll((params) => client.listResourceTemplates(params), 'resourceTemplates');
await client.close();

const current = readFileSync(MANIFEST, 'utf8');
const manifest = { ...JSON.parse(current), tools, resources };
if (templates.length) manifest.resourceTemplates = templates;
else delete manifest.resourceTemplates;
const generated = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  if (generated !== current) {
    console.error('lhm.plugin.json does not match the HTTP server. Run `bun run generate:lhm` in mcp-server.');
    process.exit(1);
  }
  console.log(`lhm.plugin.json matches the HTTP server: ${tools.length} tools, ${resources.length} resources`);
} else {
  writeFileSync(MANIFEST, generated);
  console.log(`Wrote ${tools.length} tools and ${resources.length} resources to lhm.plugin.json`);
}
