import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const configSchema = z.object({
  api: z.string().url(),
  repo: z.string().min(1),
  token: z.string().optional(),
});
export type YagConfig = z.infer<typeof configSchema>;

export const stateSchema = z.object({
  cs: z.string(),
  root_tree: z.string(),
  entries: z.array(
    z.object({ path: z.string(), blob_hash: z.string(), mtime: z.number() }),
  ),
  sparse_prefixes: z.array(z.string()),
});
export type YagState = z.infer<typeof stateSchema>;

export function yagDir(dir: string): string {
  return join(dir, '.yag');
}

export async function loadConfig(dir: string): Promise<YagConfig> {
  const raw = await readFile(join(yagDir(dir), 'config.json'), 'utf8');
  return configSchema.parse(JSON.parse(raw));
}

export async function saveConfig(dir: string, config: YagConfig): Promise<void> {
  await mkdir(yagDir(dir), { recursive: true });
  await writeFile(
    join(yagDir(dir), 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
}

export async function loadState(dir: string): Promise<YagState> {
  const raw = await readFile(join(yagDir(dir), 'state.json'), 'utf8');
  return stateSchema.parse(JSON.parse(raw));
}

export async function saveState(dir: string, state: YagState): Promise<void> {
  await mkdir(yagDir(dir), { recursive: true });
  await writeFile(
    join(yagDir(dir), 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}
