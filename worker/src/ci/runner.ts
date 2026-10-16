import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { q1, run } from '../db/client';
import { getChangeset } from '../core/changesets';
import { getBlob } from '../core/blobs';
import { getTree } from '../core/trees';
import { tarEntry, tarEnd } from '../bridge/tar';
import { storeArtifact } from './artifacts';
import { advancePipelines } from './planner';
import { runnerServices } from './spec';
import { createMasker, type Masker } from './mask';
import { ApiError } from '../core/errors';
import { prepareJob } from './inject';
import {
  MAX_IMAGE_BYTES,
  MAX_LOG_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  parsePolicy,
  type CiRun,
} from './config';

const encoder = new TextEncoder();
/**
 * New, empty microVM per run. It never receives Worker bindings or registry
 * secrets. Opted-in jobs get their own secrets and OIDC request token as
 * command environment only (issue #50), masked in the log.
 */
export class CiRunnerDO extends DurableObject<Env> {
  private log = '';
  private logBytes = 0;
  private masker?: Masker;

  async fetch(request: Request): Promise<Response> {
    const { run_id: id } = (await request.json()) as { run_id: string };
    if (typeof id !== 'string' || id.length > 80)
      return new Response('invalid run', { status: 400 });
    const path = new URL(request.url).pathname;
    if (path === '/cancel' || path === '/expire') {
      await this.stop(id, path === '/expire');
      return Response.json({ ok: true });
    }
    if (path !== '/run') return new Response('not found', { status: 404 });
    const job = await q1<CiRun>(this.env, 'SELECT * FROM ci_runs WHERE id = ?', [id]);
    if (!job || job.state !== 'queued') return Response.json({ skipped: true });
    if (this.env.CI_ENABLED !== 'true' || !this.ctx.container)
      return new Response('CI disabled', { status: 503 });
    const policy = parsePolicy(JSON.parse(job.config));
    const deadline = Date.now() + policy.timeout_seconds * 1000;
    // The built-in pool claims like a self-hosted runner (ci/runners.ts), at most once.
    const claimed = await this.env.DB.prepare(
      "UPDATE ci_runs SET state = 'running', runner_id = 'cloudflare', started_at = ?, deadline = ? WHERE id = ? AND state = 'queued' AND runs_on IS NULL",
    )
      .bind(Date.now(), deadline, id)
      .run();
    if (!claimed.meta.changes) return Response.json({ skipped: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const imageKey = `ci/images/${id}.tar`;
    let state = 'passed';
    let error: string | null = null;
    let published: string | null = null;
    try {
      await this.ctx.storage.put('run_id', id);
      await this.ctx.storage.setAlarm(deadline);
      watchdog = setTimeout(
        () => {
          void this.alarm().catch(() => {});
        },
        Math.max(1, deadline - Date.now()),
      );
      this.append('Preparing runner…\n');
      await this.checkpoint(job);
      await this.start(id, deadline);
      this.append('Reading repository source…\n');
      await this.checkpoint(job);
      await this.command(['mkdir', '-p', '/workspace']);
      const source = await this.source(job);
      this.append('Transferring source to runner…\n');
      await this.checkpoint(job);
      await this.command(['tar', '-xf', '-', '-C', '/workspace', '--no-same-owner'], {
        stdin: source,
      });
      for (const service of runnerServices(job.config)) {
        await this.assertRunning(id, deadline);
        this.append(`\nStarting service ${service.name} (${service.image})…\n`);
        await this.checkpoint(job);
        // Same VM and host network as the steps, so a service listens on localhost.
        await this.command([
          'docker',
          '--host',
          'unix:///var/run/docker.sock',
          'run',
          '-d',
          '--rm',
          '--network=host',
          '--name',
          `yag-svc-${service.name}`,
          ...Object.entries(service.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          service.image,
        ]);
      }
      // Credentials exist only from here on, inside this run's VM.
      const access = await prepareJob(this.env, job, policy, deadline).catch(
        (err: unknown) => {
          this.append(
            `\nJob credentials could not be prepared${err instanceof ApiError ? `: ${err.message}` : '.'}\n`,
          );
          throw err;
        },
      );
      this.masker = createMasker(access.mask);
      if (access.summary) this.append(`\n${access.summary}\n`);
      for (const file of access.files) {
        await this.command(
          [
            '/bin/sh',
            '-c',
            'umask 077 && mkdir -p "$(dirname "$0")" && cat > "$0"',
            file.path,
          ],
          { stdin: new Blob([file.content]).stream() },
          true,
        );
      }
      for (const command of policy.commands) {
        await this.assertRunning(id, deadline);
        this.append(this.masked().mask(`\n$ ${command}\n`));
        await this.checkpoint(job);
        await this.command(['/bin/bash', '-euo', 'pipefail', '-c', command], {
          cwd: '/workspace',
          env: access.env,
        });
        await this.checkpoint(job);
      }
      if (job.publish) {
        await this.assertRunning(id, deadline);
        if (!policy.image || policy.image.split('/')[0] !== this.env.CI_REGISTRY_HOST)
          throw new Error('Registry is not configured');
        const localTag = `yag-build:${id}`;
        this.append('\nBuilding container image…\n');
        await this.command(
          [
            'docker',
            '--host',
            'unix:///var/run/docker.sock',
            'build',
            '--network=host',
            '-f',
            policy.dockerfile,
            '-t',
            localTag,
            '.',
          ],
          { cwd: '/workspace' },
        );
        const save = await this.ctx.container.exec(
          ['docker', '--host', 'unix:///var/run/docker.sock', 'save', localTag],
          { stderr: 'ignore' },
        );
        if (!save.stdout) throw new Error('Image export failed');
        await storeArtifact(this.env.OBJECTS, imageKey, save.stdout, MAX_IMAGE_BYTES);
        if ((await save.exitCode) !== 0) throw new Error('Image export failed');
        // Destroy every process and filesystem from the untrusted build before credentials exist.
        await this.ctx.container.destroy();
        await this.assertRunning(id, deadline);
        await this.start(id, deadline);
        const artifact = await this.env.OBJECTS.get(imageKey);
        if (!artifact) throw new Error('Image export missing');
        await this.command(
          ['docker', '--host', 'unix:///var/run/docker.sock', 'load'],
          { stdin: artifact.body },
          true,
        );
        const host = this.env.CI_REGISTRY_HOST;
        const username = this.env.CI_REGISTRY_USERNAME;
        const password = this.env.CI_REGISTRY_PASSWORD;
        if (!host || !username || !password)
          throw new Error('Registry credentials unavailable');
        const input = new Blob([password]).stream();
        await this.command(
          [
            'docker',
            '--host',
            'unix:///var/run/docker.sock',
            'login',
            host,
            '--username',
            username,
            '--password-stdin',
          ],
          { stdin: input },
          true,
        );
        published = `${policy.image}:cs-${job.head_cs}`;
        await this.command(
          ['docker', '--host', 'unix:///var/run/docker.sock', 'tag', localTag, published],
          {},
          true,
        );
        await this.assertRunning(id, deadline);
        await this.command(
          ['docker', '--host', 'unix:///var/run/docker.sock', 'push', published],
          {},
          true,
        );
        this.append(`\nPublished ${published}\n`);
      }
      await this.assertRunning(id, deadline);
    } catch {
      // Commands may contain sensitive output. Store only bounded build logs, never exception payloads.
      state = Date.now() >= deadline ? 'timed_out' : 'failed';
      error =
        state === 'timed_out'
          ? 'Run exceeded its time limit'
          : 'A command or runner operation failed. See the build log.';
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      // Do not mark a run terminal or release capacity until its VM is destroyed.
      await this.ctx.container.destroy();
      await this.env.OBJECTS.delete(imageKey);
      await run(this.env, 'DELETE FROM ci_job_tokens WHERE run_id = ?', [id]);
      const logKey = `ci/logs/${job.repo_id}/${id}.txt`;
      await this.env.OBJECTS.put(logKey, this.log, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      });
      await run(
        this.env,
        `UPDATE ci_runs SET state = CASE WHEN state = 'running' THEN ? ELSE state END,
        finished_at = COALESCE(finished_at, ?), log_key = ?, image = CASE WHEN state = 'running' THEN ? ELSE image END, error = COALESCE(error, ?)
        WHERE id = ?`,
        [state, Date.now(), logKey, state === 'passed' ? published : null, error, id],
      );
      await this.ctx.storage.deleteAlarm();
      await this.advance();
    }
    return Response.json({ ok: true });
  }

  /** A finished run frees a slot and may unblock pipeline jobs; cron retries on failure. */
  private async advance(): Promise<void> {
    try {
      await advancePipelines(this.env);
    } catch (err) {
      console.warn(
        'CI pipeline advance failed',
        err instanceof Error ? err.message : 'unknown error',
      );
    }
  }

  async alarm(): Promise<void> {
    const id = await this.ctx.storage.get<string>('run_id');
    if (id) await this.stop(id, true);
  }

  private async stop(id: string, expired: boolean): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (expired) {
        const job = await q1<CiRun>(this.env, 'SELECT * FROM ci_runs WHERE id = ?', [id]);
        if (!job || job.state !== 'running' || !job.deadline || job.deadline > Date.now())
          return;
      }
      await this.ctx.container?.destroy();
      await this.env.OBJECTS.delete(`ci/images/${id}.tar`);
      await run(
        this.env,
        "UPDATE ci_runs SET state = ?, finished_at = ?, error = ? WHERE id = ? AND state IN ('queued','running')",
        [
          expired ? 'timed_out' : 'cancelled',
          Date.now(),
          expired ? 'Run exceeded its time limit' : null,
          id,
        ],
      );
    });
    await this.advance();
  }

  private async start(id: string, deadline: number): Promise<void> {
    this.append('\nStarting a fresh runner…\n');
    // Check and start under the same gate as cancellation and the deadline alarm.
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.assertRunning(id, deadline);
      const container = this.ctx.container!;
      if (container.running) await container.destroy();
      container.start({
        image: container.images.ci,
        instance: 'standard-2',
        enableInternet: true,
      });
      await container.setInactivityTimeout(10_000);
    });
    try {
      await this.command(['/usr/local/bin/yag-runner-boot']);
    } catch (error) {
      // Only the trusted boot script has run; no source or credentials are present.
      console.error(
        'CI container startup failed',
        error instanceof Error ? error.message : 'unknown error',
      );
      this.append('Runner startup failed before repository commands could run.\n');
      throw error;
    }
  }
  private append(text: string): void {
    const size = encoder.encode(text).byteLength;
    if (this.logBytes + size > MAX_LOG_BYTES) throw new Error('Log limit exceeded');
    this.log += text;
    this.logBytes += size;
  }

  private masked(): Masker {
    return (this.masker ??= createMasker([]));
  }

  private async checkpoint(job: CiRun): Promise<void> {
    const key = `ci/logs/${job.repo_id}/${job.id}.txt`;
    await this.env.OBJECTS.put(key, this.log, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
    await run(this.env, 'UPDATE ci_runs SET log_key = ? WHERE id = ?', [key, job.id]);
  }

  private async command(
    argv: string[],
    options: ContainerExecOptions = {},
    silent = false,
  ): Promise<void> {
    const process = await this.ctx.container!.exec(argv, {
      ...options,
      env: {
        ...options.env,
        HOME: '/root',
        CI: 'true',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
      },
      stdout: silent ? 'ignore' : 'pipe',
      stderr: silent ? 'ignore' : 'combined',
    });
    if (process.stdout) {
      const reader = process.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          this.append(this.masked().push(decoder.decode(chunk.value, { stream: true })));
        }
        this.append(this.masked().push(decoder.decode()) + this.masked().flush());
      } finally {
        reader.releaseLock();
      }
    }
    const code = await process.exitCode;
    if (code !== 0) {
      if (!silent) this.append(`\nCommand exited with status ${code}.\n`);
      throw new Error('Command failed');
    }
  }

  private async assertRunning(id: string, deadline: number): Promise<void> {
    const row = await q1<CiRun>(this.env, 'SELECT * FROM ci_runs WHERE id = ?', [id]);
    if (row?.state !== 'running' || Date.now() >= deadline)
      throw new Error('Run no longer active');
  }

  private async source(job: CiRun): Promise<ReadableStream<Uint8Array>> {
    const cs = await getChangeset(this.env, job.repo_id, job.head_cs);
    if (!cs?.root_tree) throw new Error('Revision has no source tree');
    const files: { path: string; hash: string; mode: string }[] = [];
    let declaredBytes = 0;
    let visited = 0;
    const walk = async (hash: string, prefix: string, depth: number): Promise<void> => {
      if (++visited > MAX_SOURCE_FILES || depth > 40)
        throw new Error('Source tree exceeds CI limits');
      const tree = await getTree(this.env, job.repo_id, hash);
      if (!tree) throw new Error('Missing source tree');
      for (const entry of tree.entries) {
        if (
          entry.name === '.' ||
          entry.name === '..' ||
          entry.name.includes('/') ||
          entry.name.includes('\\') ||
          [...entry.name].some((c) => c.charCodeAt(0) < 32)
        )
          throw new Error('Unsafe source path');
        const path = prefix + entry.name;
        if (entry.kind === 'tree') await walk(entry.hash, `${path}/`, depth + 1);
        else {
          if (entry.mode === '120000')
            throw new Error('CI source symlinks are not supported');
          declaredBytes += entry.size ?? 0;
          if (files.length >= MAX_SOURCE_FILES || declaredBytes > MAX_SOURCE_BYTES)
            throw new Error('Source exceeds CI limits');
          files.push({ path, hash: entry.hash, mode: entry.mode ?? '100644' });
        }
      }
    };
    await walk(cs.root_tree, '', 0);
    let index = 0;
    let actualBytes = 0;
    const env = this.env;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= files.length) {
          controller.enqueue(tarEnd());
          controller.close();
          return;
        }
        const file = files[index++];
        const blob = await getBlob(env, job.repo_id, file.hash);
        if (!blob) throw new Error('Missing source blob');
        actualBytes += blob.content.byteLength;
        if (actualBytes > MAX_SOURCE_BYTES) throw new Error('Source exceeds CI limits');
        controller.enqueue(
          tarEntry(file.path, blob.content, {
            mode: file.mode === '100755' ? 0o755 : 0o644,
            mtime: 0,
          }),
        );
      },
    });
  }
}
