import type { Command } from 'commander';
import { defaultStore } from '../credentials.js';
import { runGit, type Deps } from '../forge.js';
import { registerApi } from './api.js';
import { registerAuth } from './auth.js';
import { registerIssue } from './issue.js';
import { registerPr } from './pr.js';
import { registerRepo } from './repo.js';
import { registerRun } from './run.js';

/** The gh-style command groups (issue #74; docs/compat/github.md). */
export function registerGhCommands(program: Command, deps: Deps): void {
  registerIssue(program, deps);
  registerPr(program, deps);
  registerRun(program, deps);
  registerRepo(program, deps);
  registerApi(program, deps);
  registerAuth(program, deps);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Deps bound to this process. */
export function processDeps(): Deps {
  return {
    fetch,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    cwd: process.cwd(),
    env: process.env,
    git: runGit,
    store: () => defaultStore(),
    stdin: readStdin,
    exit: (code) => {
      process.exitCode = code;
    },
  };
}
