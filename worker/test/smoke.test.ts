import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { makeApp, seedSchema, sha256 } from './helpers';
import type { TestEnv } from './helpers';

const testEnv = env as unknown as TestEnv;

describe('smoke', () => {
  beforeEach(async () => {
    await seedSchema(testEnv);
  });

  afterEach(async () => {
    await testEnv.OBJECTS.delete('smoke/hello');
  });

  it('GET /healthz returns { ok: true }', async () => {
    const res = await makeApp(testEnv)(new Request('http://x/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('D1 binding responds', async () => {
    const row = await testEnv.DB.prepare('SELECT 1 AS one').first<{
      one: number;
    }>();
    expect(row?.one).toBe(1);
  });

  it('R2 binding responds and bytes round-trip', async () => {
    await testEnv.OBJECTS.put('smoke/hello', 'world');
    const obj = await testEnv.OBJECTS.get('smoke/hello');
    expect(await obj?.text()).toBe('world');
  });

  it('sha256 helper hashes bytes', async () => {
    // sha256("abc")
    expect(await sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('worker entry', () => {
  it('serves /healthz through the exported Worker fetch handler', async () => {
    const res = await SELF.fetch('http://x/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses anonymous API calls, even to unrouted paths', async () => {
    const res = await SELF.fetch('http://x/api/v1/nope/nothing');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: 'unauthorized', message: 'authentication required' },
    });
  });
});
