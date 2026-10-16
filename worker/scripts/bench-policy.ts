/**
 * Agent policy benchmark (issue #62, ADR 0003): the CPU a push spends in the
 * policy step. Bundles the real engine and default pack with esbuild (as
 * gen-api-docs.ts does), then times, per push, what pre-receive does for an
 * agent: parse each changed package.json, evaluate the default pack and hash
 * the payload. D1 reads (pause, policy row, approval) are I/O and not counted.
 *
 * Usage: npm run bench:policy -w worker [-- files=200 runs=2000]
 */
import { dirname } from 'node:path';
import { build } from 'esbuild';

interface Engine {
  pack: unknown;
  policySchema: { parse(value: unknown): unknown };
  evaluatePolicy(policy: unknown, input: unknown): { outcome: string };
  npmDependencies(content: string): unknown[];
}

const workerDir = dirname(import.meta.dirname);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const FILES = Number(args.files ?? 200);
const RUNS = Number(args.runs ?? 2000);

const result = await build({
  stdin: {
    contents: [
      "export { evaluatePolicy, npmDependencies, policySchema } from './src/policy/engine';",
      "export { default as pack } from '../policies/default.json';",
    ].join('\n'),
    resolveDir: workerDir,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});`,
  },
  write: false,
  logLevel: 'error',
});
const code = (result.outputFiles[0] as { text: string }).text;
const engine = (await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)) as Engine;
const policy = engine.policySchema.parse(engine.pack);

const manifest = JSON.stringify({
  dependencies: Object.fromEntries(
    Array.from({ length: 80 }, (_, i) => [`dep-${i}`, `^${i}.0.0`]),
  ),
  devDependencies: { pad: 'github:someone/pad' },
});
const files = Array.from({ length: FILES }, (_, i) => ({
  path:
    i === 0
      ? 'package.json'
      : i === 1
        ? '.github/workflows/ci.yml'
        : `src/m${i}/f${i}.ts`,
  op: 'mod',
  size: 4096,
}));

async function onePush(): Promise<string> {
  const dependencies = engine.npmDependencies(manifest);
  const input = {
    action: 'push',
    ref: 'feature',
    files,
    force_push: false,
    dependencies,
  };
  const { outcome } = engine.evaluatePolicy(policy, input);
  const payload = {
    action: 'push',
    repo: 'r',
    payload: { ref: 'feature', old: 'a', new: 'b' },
  };
  await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return outcome;
}

for (let i = 0; i < 200; i++) await onePush(); // warm up the JIT
const times: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const start = performance.now();
  await onePush();
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const at = (p: number): string =>
  (times[Math.floor((times.length - 1) * p)] as number).toFixed(3);
console.log(
  `policy step for a ${FILES}-file push (${RUNS} runs, outcome ${await onePush()}): ` +
    `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, p99 ${at(0.99)} ms, max ${at(1)} ms`,
);
if (Number(at(0.95)) >= 10) {
  console.error('p95 is over the 10 ms budget');
  process.exit(1);
}
