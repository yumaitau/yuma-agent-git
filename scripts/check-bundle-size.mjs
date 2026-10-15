#!/usr/bin/env node
// Gzip budget for the dashboard SPA (issue #20): js + css + html < 250 KiB.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'worker/dashboard/dist');
const budget = 250 * 1024;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(js|css|html)$/.test(name)) out.push(path);
  }
  return out;
}

const files = walk(dist);
let total = 0;
for (const file of files) {
  const bytes = gzipSync(readFileSync(file)).length;
  total += bytes;
  console.log(`${bytes}\t${file.slice(repoRoot.length + 1)}`);
}
console.log(`dashboard gzip total: ${total} bytes (budget ${budget})`);
if (total > budget) {
  console.error(
    `dashboard bundle exceeds the 250 KiB gzip budget (${total} > ${budget})`,
  );
  process.exit(1);
}
