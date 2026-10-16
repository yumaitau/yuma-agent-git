import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client, register, RunnerError, serve } from './agent.ts';

const USAGE = `Usage:
  yag-runner register --url <forge> --name <name> --labels <a,b> [--ephemeral] [--config <file>]
      (the one-time registration token comes from YAG_RUNNER_TOKEN or --token)
  yag-runner run [--config <file>] [--once] [--work-dir <dir>]`;

interface Config {
  url: string;
  runner_id: string;
  credential: string;
  name: string;
  labels: string[];
  ephemeral: boolean;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      name: { type: 'string' },
      labels: { type: 'string' },
      ephemeral: { type: 'boolean', default: false },
      config: { type: 'string' },
      once: { type: 'boolean', default: false },
      'work-dir': { type: 'string' },
    },
  });
  const configPath =
    values.config ?? join(homedir(), '.config', 'yag-runner', 'runner.json');

  if (positionals[0] === 'register') {
    const token = values.token ?? process.env.YAG_RUNNER_TOKEN;
    if (!values.url || !token || !values.name || !values.labels) {
      console.error(USAGE);
      return 2;
    }
    const labels = values.labels.split(',').map((l) => l.trim().toLowerCase());
    const registered = await register(values.url, {
      token,
      name: values.name,
      labels,
      ephemeral: values.ephemeral,
      capabilities: { os: platform(), arch: arch(), version: '0.1.0' },
    });
    const config: Config = {
      url: values.url,
      runner_id: registered.id,
      credential: registered.credential,
      name: values.name,
      labels,
      ephemeral: values.ephemeral,
    };
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(
      `Registered runner ${values.name} (${registered.id}); config in ${configPath}`,
    );
    return 0;
  }

  if (positionals[0] === 'run') {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Config;
    const client = new Client(config.url, config.credential);
    console.log(
      `Runner ${config.name} waiting for jobs labelled ${config.labels.join(', ')}`,
    );
    await serve(client, {
      // an ephemeral runner is deregistered by the forge after its one job
      once: values.once || config.ephemeral,
      workRoot: values['work-dir'],
      say: (line) => console.log(line),
    });
    return 0;
  }

  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof RunnerError && err.status === 401)
      console.error(
        'The forge no longer accepts this runner credential (revoked or ephemeral).',
      );
    else console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
