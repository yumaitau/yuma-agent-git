/**
 * Secret scanning benchmark (issue #66): the CPU push protection spends on a
 * 1 MiB push. Bundles the real detectors with esbuild (as bench-policy.ts
 * does) and times `scanText` over files that together make 1 MiB of source,
 * one of them with a secret near the end. Blob reads are I/O and not counted.
 * The target is under 200 ms at p95.
 *
 * Usage: npm run bench:secrets -w worker [-- files=64 runs=200]
 */
import { dirname } from 'node:path';
import { build } from 'esbuild';

interface Detectors {
  scanText(text: string): { detector: string }[];
}

const workerDir = dirname(import.meta.dirname);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const FILES = Number(args.files ?? 64);
const RUNS = Number(args.runs ?? 200);
const TOTAL = 1024 * 1024;

const result = await build({
  stdin: {
    contents: "export { scanText } from './src/security/secrets/detectors';",
    resolveDir: workerDir,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
});
const code = (result.outputFiles[0] as { text: string }).text;
const detectors = (await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)) as Detectors;

// source-like text: assignments, tokens and quoted strings the patterns look at
const line = (i: number): string =>
  [
    `const token_${i} = process.env.TOKEN_${i} ?? "";`,
    `export const apiKey${i}: string = config.get("api_key_${i}");`,
    `// see https://example.com/docs/${i} for the secret rotation guide`,
    `password = "${'x'.repeat(8)}${i}"`,
    `if (value.startsWith("sk_test_${i}")) throw new Error("bad key ${i}");`,
  ][i % 5] as string;
const files: string[] = [];
for (let f = 0; f < FILES; f++) {
  let text = '';
  for (let i = 0; text.length < TOTAL / FILES; i++) text += `${line(i + f)}\n`;
  files.push(text);
}
files[FILES - 1] += `AWS_ACCESS_KEY_ID=${'AKIA'}${'Q3JXZ7M5N4P6R2TW'}\n`;

// worst case: one file of unterminated key headers, open assignments and base64
const hostile = [
  `-----BEGIN RSA ${'PRIVATE'} KEY-----\n`,
  'secret_token_value = "',
  'A1b2C3d4'.repeat(16),
  '\n',
].join('');
const worst = [hostile.repeat(Math.ceil(TOTAL / hostile.length)).slice(0, TOTAL)];

function bench(name: string, set: string[]): void {
  const times: number[] = [];
  let found = 0;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    found = 0;
    for (const text of set) found += detectors.scanText(text).length;
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const at = (p: number): string =>
    (times[Math.min(times.length - 1, Math.floor(p * times.length))] as number).toFixed(
      1,
    );
  const bytes = set.reduce((n, t) => n + t.length, 0);
  console.log(
    `${name}: ${set.length} files, ${(bytes / 1024).toFixed(0)} KiB, ${found} finding(s), ${RUNS} runs`,
  );
  console.log(`  p50 ${at(0.5)} ms  p95 ${at(0.95)} ms  max ${at(1)} ms`);
}

bench('source push', files);
bench('worst case', worst);
