#!/usr/bin/env node
import { Command } from 'commander';

/**
 * `yag` — thin client for yuma-agent-git.
 *
 * Never tells the server what it has; fetches only the objects it wants
 * (sparse checkout protocol, architecture §2.4).
 */
const program = new Command();

program
  .name('yag')
  .description('Thin client for yuma-agent-git (sparse checkout, object cache)')
  .version('0.1.0');

program.parseAsync(process.argv);
