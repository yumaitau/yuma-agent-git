#!/usr/bin/env node
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { YagApi } from './api.js';
import { ObjectCache } from './cache.js';
import { checkout } from './checkout.js';
import { loadConfig, saveConfig } from './config.js';
import { commit, status } from './workcopy.js';

/**
 * `yag` — thin client for yuma-agent-git. Sparse by construction: it fetches
 * only the objects it wants, verifies every content address, and keeps a
 * bounded LRU cache so checkouts resume for free.
 */

function cacheRoot(): string {
  return process.env.YAG_CACHE_DIR ?? join(homedir(), '.yag', 'objects');
}

async function client(dir = process.cwd()): Promise<{ api: YagApi; cache: ObjectCache }> {
  const config = await loadConfig(dir);
  const token = process.env.YAG_TOKEN ?? config.token;
  return {
    api: new YagApi({ api: config.api, repo: config.repo, token }),
    cache: new ObjectCache(cacheRoot()),
  };
}

function author(): { name: string; email: string } {
  return {
    name: process.env.YAG_AUTHOR_NAME ?? 'yag',
    email: process.env.YAG_AUTHOR_EMAIL ?? 'yag@localhost',
  };
}

const program = new Command();

program
  .name('yag')
  .description('Thin client for yuma-agent-git (sparse checkout, object cache)')
  .version('0.1.0');

program
  .command('init')
  .argument('<dir>', 'working directory')
  .requiredOption('--repo <slug>', 'repository slug (owner/name)')
  .requiredOption('--api <url>', 'API base URL')
  .option('--token <token>', 'bearer token (or set YAG_TOKEN)')
  .action(async (dir: string, opts: { repo: string; api: string; token?: string }) => {
    await saveConfig(dir, { api: opts.api, repo: opts.repo, token: opts.token });
    console.log(`initialized ${dir}/.yag for ${opts.repo}`);
  });

program
  .command('clone')
  .argument('<repo>', 'repository slug (owner/name)')
  .argument('<dir>', 'new working directory')
  .requiredOption('--api <url>', 'server URL')
  .option('--rev <rev>', 'revision to check out', 'ref:main')
  .option('--token <token>', 'bearer token (or set YAG_TOKEN)')
  .action(
    async (
      repo: string,
      dir: string,
      opts: { api: string; rev: string; token?: string },
    ) => {
      const { mkdir, readdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      if ((await readdir(dir)).length) throw new Error('Clone destination must be empty');
      await saveConfig(dir, { api: opts.api, repo, token: opts.token });
      const { api, cache } = await client(dir);
      const result = await checkout({ api, cache, dir, rev: opts.rev, prefixes: [] });
      console.log(
        `Checked out ${result.files.length} files into ${dir}. Run yag status to get started.`,
      );
    },
  );

program
  .command('pr')
  .description('Open a pull request from the checked-out changeset')
  .requiredOption('-t, --title <title>', 'pull request title')
  .option('--body <body>', 'description', '')
  .option('--draft', 'start as a draft', false)
  .action(async (opts: { title: string; body: string; draft: boolean }) => {
    const { loadState } = await import('./config.js');
    const { api } = await client();
    const state = await loadState(process.cwd());
    const result = await api.createPull({ ...opts, head_cs: state.cs });
    const config = await loadConfig(process.cwd());
    console.log(
      `${config.api.replace(/\/$/, '')}/r/${config.repo}/pulls/${result.pull.id}`,
    );
  });
const ci = program.command('ci').description('Run checks and inspect Cloudflare CI');
ci.command('run')
  .option('--publish', 'build and publish a default-branch image (admin only)', false)
  .action(async (opts: { publish: boolean }) => {
    const { loadState } = await import('./config.js');
    const { api } = await client();
    const state = await loadState(process.cwd());
    const result = await api.runCI(state.cs, opts.publish);
    console.log(`${result.run.id} ${result.run.state}`);
  });
ci.command('status').action(async () => {
  const { api } = await client();
  const status = await api.ciStatus();
  console.log(
    status.enabled ? 'Cloudflare CI enabled' : 'Cloudflare runner deployment pending',
  );
  for (const job of status.runs)
    console.log(`${job.id} ${job.head_cs.slice(0, 8)} ${job.state}`);
});

const work = program
  .command('work')
  .description('Work queue: list, claim, heartbeat and release issues');
work
  .command('list')
  .option('--readiness <readiness>', 'only items with this readiness')
  .option('--risk <risk>', 'only items with this risk')
  .action(async (opts: { readiness?: string; risk?: string }) => {
    const { readinessOption, riskOption, formatWorkItem } = await import('./work.js');
    const { api } = await client();
    const { items } = await api.listWork({
      readiness: opts.readiness ? readinessOption.parse(opts.readiness) : undefined,
      risk: opts.risk ? riskOption.parse(opts.risk) : undefined,
    });
    for (const item of items) console.log(formatWorkItem(item));
  });
work
  .command('claim')
  .description('Claim the best ready item; exits 2 when nothing is ready')
  .option('--lease <seconds>', 'lease length (30 to 3600)')
  .option('--max-risk <risk>', 'highest risk to take')
  .action(async (opts: { lease?: string; maxRisk?: string }) => {
    const { formatWorkItem, riskOption, secondsOption } = await import('./work.js');
    const { api } = await client();
    const item = await api.claimWork({
      lease_seconds: opts.lease ? secondsOption.parse(opts.lease) : undefined,
      max_risk: opts.maxRisk ? riskOption.parse(opts.maxRisk) : undefined,
    });
    if (!item) {
      console.error('Nothing ready to claim.');
      process.exitCode = 2;
      return;
    }
    console.log(formatWorkItem(item));
  });
work
  .command('heartbeat')
  .argument('<number>', 'issue number you hold')
  .option('--lease <seconds>', 'new lease length (30 to 3600)')
  .action(async (number: string, opts: { lease?: string }) => {
    const { numberOption, secondsOption } = await import('./work.js');
    const { api } = await client();
    const result = await api.heartbeatWork(numberOption.parse(number), {
      lease_seconds: opts.lease ? secondsOption.parse(opts.lease) : undefined,
    });
    console.log(`lease until ${new Date(result.lease_expires_at).toISOString()}`);
  });
work
  .command('release')
  .argument('<number>', 'issue number you hold')
  .requiredOption('--outcome <outcome>', 'ready, in-review, blocked or done')
  .option('--reason <reason>', 'why, for the history')
  .action(async (number: string, opts: { outcome: string; reason?: string }) => {
    const { formatWorkItem, numberOption, outcomeOption } = await import('./work.js');
    const { api } = await client();
    const item = await api.releaseWork(numberOption.parse(number), {
      outcome: outcomeOption.parse(opts.outcome),
      reason: opts.reason,
    });
    console.log(formatWorkItem(item));
  });
work
  .command('set')
  .argument('<number>', 'issue number')
  .option('--readiness <readiness>', 'new readiness (ready needs approval rights)')
  .option('--risk <risk>', 'low, medium or high (needs approval rights)')
  .option('--priority <n>', 'higher is claimed first')
  .option('--depends-on <numbers...>', 'issue numbers this waits on')
  .option('--reason <reason>', 'why, for the history')
  .action(
    async (
      number: string,
      opts: {
        readiness?: string;
        risk?: string;
        priority?: string;
        dependsOn?: string[];
        reason?: string;
      },
    ) => {
      const { formatWorkItem, numberOption, readinessOption, riskOption } =
        await import('./work.js');
      const { api } = await client();
      const item = await api.updateWork(numberOption.parse(number), {
        readiness: opts.readiness ? readinessOption.parse(opts.readiness) : undefined,
        risk: opts.risk ? riskOption.parse(opts.risk) : undefined,
        priority: opts.priority === undefined ? undefined : Number(opts.priority),
        depends_on: opts.dependsOn?.map((n) => numberOption.parse(n)),
        reason: opts.reason,
      });
      console.log(formatWorkItem(item));
    },
  );

/**
 * Inside a CI job with `permissions.id_token: write`, an ID token for
 * `yag:attest`; null outside CI, and an error when `required` there.
 */
async function ciIdToken(required: boolean): Promise<string | null> {
  const { ATTEST_AUDIENCE } = await import('./release.js');
  const url = process.env.YAG_ID_TOKEN_REQUEST_URL;
  const request = process.env.YAG_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !request) {
    if (!required) return null;
    throw new Error(
      'Run this in a CI job whose pipeline has permissions.id_token: write',
    );
  }
  const res = await fetch(
    `${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(ATTEST_AUDIENCE)}`,
    { method: 'POST', headers: { authorization: `Bearer ${request}` } },
  );
  if (!res.ok) throw new Error(`ID token request failed: HTTP ${res.status}`);
  return ((await res.json()) as { value: string }).value;
}

const release = program
  .command('release')
  .description('Releases: tags with notes, checksummed assets and build provenance');
release.command('list').action(async () => {
  const { formatRelease } = await import('./release.js');
  const { api } = await client();
  for (const r of await api.listReleases()) console.log(formatRelease(r));
});
release
  .command('view')
  .argument('<tag>')
  .action(async (tag: string) => {
    const { formatRelease } = await import('./release.js');
    const { api } = await client();
    const r = await api.getRelease(tag);
    console.log(formatRelease(r));
    for (const a of r.assets) console.log(`  ${a.name} ${a.size} sha256:${a.sha256}`);
    if (r.body) console.log(`\n${r.body}`);
  });
release
  .command('create')
  .description('Create a release from an existing tag and upload files as assets')
  .argument('<tag>')
  .argument('[files...]', 'asset files to upload')
  .option('--name <name>', 'release title (default: the tag)')
  .option('--notes <markdown>', 'release notes')
  .option('--notes-file <path>', 'read release notes from a file')
  .option(
    '--generate-notes',
    'append notes from pull requests and commits since the previous release',
  )
  .option('--previous-tag <tag>', 'start generated notes from this tag')
  .option('--draft', 'keep it hidden from readers until published')
  .option('--prerelease', 'never mark it as latest')
  .action(
    async (
      tag: string,
      files: string[],
      opts: {
        name?: string;
        notes?: string;
        notesFile?: string;
        generateNotes?: boolean;
        previousTag?: string;
        draft?: boolean;
        prerelease?: boolean;
      },
    ) => {
      const { readFile } = await import('node:fs/promises');
      const { basename } = await import('node:path');
      const { formatRelease, sha256Hex } = await import('./release.js');
      const { api } = await client();
      // in CI the assets record the run that built them, so it can attest them
      const idToken = files.length > 0 ? await ciIdToken(false) : null;
      const created = await api.createRelease({
        tag,
        name: opts.name,
        body: opts.notesFile ? await readFile(opts.notesFile, 'utf8') : opts.notes,
        generate_notes: opts.generateNotes,
        previous_tag: opts.previousTag,
        draft: opts.draft,
        prerelease: opts.prerelease,
      });
      for (const file of files) {
        const bytes = await readFile(file);
        const asset = await api.uploadAsset(
          created.id,
          basename(file),
          bytes,
          await sha256Hex(bytes),
          idToken ?? undefined,
        );
        console.log(`uploaded ${asset.name} sha256:${asset.sha256}`);
      }
      console.log(formatRelease({ ...created, assets: files }));
    },
  );
release
  .command('upload')
  .argument('<tag>')
  .argument('<files...>')
  .action(async (tag: string, files: string[]) => {
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const { sha256Hex } = await import('./release.js');
    const { api } = await client();
    const r = await api.getRelease(tag);
    const idToken = await ciIdToken(false);
    for (const file of files) {
      const bytes = await readFile(file);
      const asset = await api.uploadAsset(
        r.id,
        basename(file),
        bytes,
        await sha256Hex(bytes),
        idToken ?? undefined,
      );
      console.log(`uploaded ${asset.name} sha256:${asset.sha256}`);
    }
  });
release
  .command('publish')
  .description('Publish a draft release')
  .argument('<tag>')
  .action(async (tag: string) => {
    const { formatRelease } = await import('./release.js');
    const { api } = await client();
    const r = await api.getRelease(tag);
    console.log(formatRelease(await api.updateRelease(r.id, { draft: false })));
  });
release
  .command('delete')
  .description('Delete a release and its assets (the tag stays)')
  .argument('<tag>')
  .action(async (tag: string) => {
    const { api } = await client();
    await api.deleteRelease((await api.getRelease(tag)).id);
    console.log(`deleted release ${tag}`);
  });
release
  .command('download')
  .description(
    'Download assets and check each against its SHA-256; exits 1 on a mismatch',
  )
  .argument('<tag>')
  .option('--dir <dir>', 'where to write the files', '.')
  .action(async (tag: string, opts: { dir: string }) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { sha256Hex } = await import('./release.js');
    const { api } = await client();
    const r = await api.getRelease(tag);
    await mkdir(opts.dir, { recursive: true });
    for (const asset of r.assets) {
      const bytes = await api.downloadAsset(r.id, asset.id);
      if ((await sha256Hex(bytes)) !== asset.sha256) {
        console.error(`${asset.name}: SHA-256 mismatch, not written`);
        process.exitCode = 1;
        continue;
      }
      await writeFile(join(opts.dir, asset.name), bytes);
      console.log(`${asset.name} ok sha256:${asset.sha256}`);
    }
  });
release
  .command('attest')
  .description(
    'Inside a CI job with permissions.id_token: write, sign build provenance for the assets',
  )
  .argument('<tag>')
  .option('--asset <names...>', 'only these assets (default: all this run uploaded)')
  .action(async (tag: string, opts: { asset?: string[] }) => {
    const value = (await ciIdToken(true)) as string;
    const { api } = await client();
    const r = await api.getRelease(tag);
    const attestation = await api.attestRelease(r.id, {
      id_token: value,
      assets: opts.asset,
    });
    console.log(`attestation ${attestation.id} from run ${attestation.run_id}`);
  });
release
  .command('verify')
  .description(
    'Verify build provenance offline against the published keys; exits 1 if any asset is not covered',
  )
  .argument('<tag>')
  .action(async (tag: string) => {
    const { envelopeSchema, jwksSchema, uncovered, verifyEnvelope } =
      await import('./release.js');
    const { api } = await client();
    const r = await api.getRelease(tag);
    const jwks = jwksSchema.parse(await api.jwks());
    const statements = [];
    for (const a of await api.listAttestations(r.id)) {
      const result = await verifyEnvelope(envelopeSchema.parse(a.envelope), jwks);
      if (result.ok) statements.push(result.statement);
      else console.error(`attestation ${a.id}: ${result.reason}`);
    }
    const missing = uncovered(r.assets, statements);
    for (const name of missing) console.error(`${name}: no verified provenance`);
    if (missing.length > 0 || r.assets.length === 0) {
      process.exitCode = 1;
      return;
    }
    console.log(
      `provenance ok: ${r.assets.length} assets, ${statements.length} attestations`,
    );
  });

async function verifyChangeset(cs: string): Promise<void> {
  const {
    formatPredicate,
    provenanceKeysSchema,
    provenanceRecordSchema,
    verifyProvenance,
  } = await import('./provenance.js');
  const { api } = await client();
  const keys = provenanceKeysSchema.parse(await api.provenanceKeys());
  const records = await api.provenance(cs);
  let verified = 0;
  for (const raw of records) {
    const record = provenanceRecordSchema.safeParse(raw);
    if (!record.success) {
      console.error('a record is malformed');
      continue;
    }
    const check = await verifyProvenance(record.data, keys, cs);
    if (!check.ok) {
      console.error(`record ${record.data.id}: ${check.reason}`);
      continue;
    }
    verified++;
    console.log(`record ${record.data.id} verified (key ${check.keyId})`);
    for (const line of formatPredicate(check.predicate)) console.log(`  ${line}`);
  }
  if (verified === 0) {
    console.error(`${cs}: no verified provenance`);
    process.exitCode = 1;
  }
}

const provenance = program
  .command('provenance')
  .description('Signed source provenance for protected branch updates');
provenance
  .command('verify')
  .description(
    'Verify the signed provenance of a changeset offline against the published keys; exits 1 if none verifies',
  )
  .argument('<cs>', 'changeset id')
  .action(verifyChangeset);
program
  .command('verify')
  .description('Same as `yag provenance verify`')
  .argument('<cs>', 'changeset id')
  .action(verifyChangeset);

const audit = program.command('audit').description('Audit log tools');
audit
  .command('verify')
  .description('Recompute the audit hash chain; exits 1 if any event was altered')
  .option('--file <path>', 'verify an NDJSON export instead of fetching one')
  .option('--org <org>', 'org whose audit log to fetch')
  .option('--api <url>', 'server URL (default: from .yag/config.json)')
  .action(async (opts: { file?: string; org?: string; api?: string }) => {
    const { verifyAuditChain } = await import('./audit.js');
    let text: string;
    if (opts.file) {
      const { readFile } = await import('node:fs/promises');
      text = await readFile(opts.file, 'utf8');
    } else {
      if (!opts.org) throw new Error('--org or --file is required');
      const config = opts.api ? null : await loadConfig(process.cwd());
      const base = (opts.api ?? config?.api ?? '').replace(/\/$/, '');
      const token = process.env.YAG_TOKEN ?? config?.token;
      const res = await fetch(
        `${base}/api/v1/orgs/${encodeURIComponent(opts.org)}/audit?format=ndjson`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(`audit export failed: HTTP ${res.status}`);
      text = await res.text();
    }
    const result = await verifyAuditChain(text.split('\n'));
    if (!result.ok) {
      console.error(`audit chain INVALID at event ${result.id}: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`audit chain ok: ${result.events} events`);
    for (const [org, head] of Object.entries(result.heads)) console.log(`${org} ${head}`);
  });

const importCmd = program.command('import').description('Bulk imports (#72)');

async function importClient(api?: string): Promise<{ api: string; token?: string }> {
  const config = api ? null : await loadConfig(process.cwd());
  return {
    api: api ?? config?.api ?? '',
    token: process.env.YAG_TOKEN ?? config?.token,
  };
}

importCmd
  .command('github')
  .description(
    'Import a GitHub org (history with the same SHAs, issues, pulls, releases, LFS) into a yag org',
  )
  .requiredOption('--org <github-org>', 'GitHub organisation to import')
  .requiredOption('--into <org>', 'yag org that receives the repos')
  .requiredOption('--installation <id>', 'GitHub App installation id on the GitHub org')
  .option('--repo <name...>', 'only these repos (default: all the installation reaches)')
  .option('--wait', 'follow progress until the import finishes')
  .option('--api <url>', 'server URL (default: from .yag/config.json)')
  .action(
    async (opts: {
      org: string;
      into: string;
      installation: string;
      repo?: string[];
      wait?: boolean;
      api?: string;
    }) => {
      const { formatReport, startImport, waitForImport } = await import('./import.js');
      const { numberOption } = await import('./work.js');
      const client = await importClient(opts.api);
      const started = await startImport(client, opts.into, {
        source: 'github',
        github_org: opts.org,
        installation_id: numberOption.parse(opts.installation),
        ...(opts.repo ? { repos: opts.repo } : {}),
      });
      console.log(`import ${started.id} queued`);
      if (!opts.wait) return;
      let last = '';
      const report = await waitForImport(client, opts.into, started.id, {
        onProgress: (r) => {
          const line = formatReport(r)[0] as string;
          if (line !== last) console.error(line);
          last = line;
        },
      });
      for (const line of formatReport(report)) console.log(line);
      if (report.status !== 'done') process.exitCode = 1;
    },
  );

importCmd
  .command('status')
  .description('Show an import and its per-repo report')
  .argument('<org>', 'yag org')
  .argument('<id>', 'import id')
  .option('--resume', 'retry failed repos from their checkpoints first')
  .option('--api <url>', 'server URL (default: from .yag/config.json)')
  .action(async (org: string, id: string, opts: { resume?: boolean; api?: string }) => {
    const { formatReport, importStatus, resumeImport } = await import('./import.js');
    const client = await importClient(opts.api);
    if (opts.resume) await resumeImport(client, org, id);
    for (const line of formatReport(await importStatus(client, org, id)))
      console.log(line);
  });

const policy = program.command('policy').description('Agent policy tools (#62)');
policy
  .command('test')
  .description(
    'Run a policy against fixture cases on the server engine; exits 1 on a failure',
  )
  .argument('[policy]', 'policy JSON file (default: the server default pack)')
  .requiredOption('--fixtures <path>', 'a JSON file of cases, or a directory of them')
  .option('--api <url>', 'server URL (default: from .yag/config.json)')
  .action(async (file: string | undefined, opts: { fixtures: string; api?: string }) => {
    const { formatResults, testPolicy } = await import('./policy.js');
    const config = opts.api ? null : await loadConfig(process.cwd());
    const result = await testPolicy({
      api: opts.api ?? config?.api ?? '',
      token: process.env.YAG_TOKEN ?? config?.token,
      policy: file,
      fixtures: opts.fixtures,
    });
    for (const line of formatResults(result)) console.log(line);
    if (result.failed > 0) process.exitCode = 1;
  });

program
  .command('checkout')
  .argument('<rev>', 'revision: changeset id, ref:main, or a ref name')
  .option('--path <prefix...>', 'sparse prefixes (default: everything)')
  .action(async (rev: string, opts: { path?: string[] }) => {
    const dir = process.cwd();
    const { api, cache } = await client(dir);
    const result = await checkout({
      dir,
      rev,
      prefixes: opts.path ?? [],
      api,
      cache,
      onProgress: (m) => console.error(`yag: ${m}`),
    });
    console.log(`checked out ${result.files.length} files at ${result.cs}`);
  });

program.command('status').action(async () => {
  const st = await status(process.cwd());
  for (const path of st.modified) console.log(`modified: ${path}`);
  for (const path of st.deleted) console.log(`deleted:  ${path}`);
  for (const path of st.untracked) console.log(`untracked:${path}`);
  console.log(
    `${st.modified.length} modified, ${st.deleted.length} deleted, ${st.untracked.length} untracked`,
  );
});

program
  .command('commit')
  .requiredOption('-m, --message <message>', 'commit message')
  .option('--ref <name>', 'CAS-move this ref to the new changeset (e.g. main)')
  .action(async (opts: { message: string; ref?: string }) => {
    const dir = process.cwd();
    const { api } = await client(dir);
    const outcome = await commit({
      dir,
      api,
      message: opts.message,
      author: author(),
      ref: opts.ref,
    });
    if (outcome.stale) {
      console.error(
        `stale ref ${outcome.ref}: expected ${outcome.stale.expected ?? '(none)'}, actual ${outcome.stale.actual ?? '(none)'}`,
      );
      console.error(
        'Your commit is saved locally. Preserve it and replay your changes onto the latest branch head before retrying.',
      );
      process.exitCode = 3;
      return;
    }
    console.log(
      outcome.refMoved
        ? `landed ${outcome.id} on ${outcome.ref}`
        : `created ${outcome.id}`,
    );
  });

program
  .command('diff')
  .argument('[rev]', 'revision to compare against', 'ref:main')
  .action(async (rev: string) => {
    const dir = process.cwd();
    const { api } = await client(dir);
    const { loadState } = await import('./config.js');
    const state = await loadState(dir);
    const diff = await api.diff(state.cs, rev);
    for (const text of diff.texts ?? []) {
      console.log(`--- ${text.path}${text.side ? ` (${text.side})` : ''}`);
      console.log(text.unified);
    }
    for (const file of diff.files) {
      const marker = file.kind === 'add' ? 'A' : file.kind === 'del' ? 'D' : 'M';
      console.log(`${marker} ${file.path}${file.side ? ` (${file.side})` : ''}`);
    }
  });

program
  .command('log')
  .option('--path <path>', 'only changesets touching this path')
  .option('--limit <n>', 'max entries', '20')
  .action(async (opts: { path?: string; limit: string }) => {
    const dir = process.cwd();
    const { api } = await client(dir);
    const { loadState } = await import('./config.js');
    const state = await loadState(dir);
    const history = await api.history({
      cs: state.cs,
      path: opts.path,
      limit: Number(opts.limit) || 20,
    });
    for (const cs of history.changesets) {
      const date = new Date(cs.created_at).toISOString();
      console.log(`${cs.id.slice(0, 8)} ${date} ${cs.message.split('\n')[0]}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`yag: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
