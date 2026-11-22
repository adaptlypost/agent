import { readFileSync } from 'node:fs';

const declared = readFileSync(new URL('declared-tools.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean);

const source = readFileSync(new URL('src/index.ts', import.meta.url), 'utf8');
const registered = [...source.matchAll(/(?:registerTool|\btool)\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);

const added = registered.filter((t) => !declared.includes(t));
const removed = declared.filter((t) => !registered.includes(t));

if (added.length || removed.length) {
  console.error('The tools this server exposes no longer match declared-tools.txt.');
  if (added.length) console.error(`  added:   ${added.join(', ')}`);
  if (removed.length) console.error(`  removed: ${removed.join(', ')}`);
  console.error('\nAdd or remove the names in declared-tools.txt, or register the tool on the');
  console.error('stdio transport only.');
  process.exit(1);
}

console.log(`${registered.length} tools, matching declared-tools.txt`);
