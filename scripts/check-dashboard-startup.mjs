#!/usr/bin/env node
// Execute the shipped bundle, not Vitest's separately transformed components.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const dist = new URL('../worker/dashboard/dist/', import.meta.url);
const origin = process.argv[2];
async function asset(path) {
  if (!origin) return readFile(new URL(path.replace(/^\//, ''), dist), 'utf8');
  const url = new URL(path, origin);
  assert.equal(url.origin, new URL(origin).origin);
  const response = await fetch(url);
  assert.equal(response.status, 200, `Asset ${path}`);
  return response.text();
}
const html = await asset('index.html');
for (const route of ['/', '/login']) {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (error) => errors.push(error));
  console.on('error', (...args) => errors.push(new Error(args.join(' '))));
  const dom = new JSDOM(html, {
    url: new URL(route, origin ?? 'https://dashboard.test').href,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: console,
  });
  try {
    // Deterministic anonymous API responses; no OAuth or network side effects.
    dom.window.fetch = async (input) => {
      const path = new URL(input, dom.window.location.href).pathname;
      if (path === '/api/v1/tokens') return Response.json({}, { status: 401 });
      if (path === '/auth/status') return Response.json({ github_configured: false });
      assert.equal(path, '/api/v1/repos', `Unexpected request: ${path}`);
      return Response.json({ repos: [], next_cursor: null });
    };
    const scripts = dom.window.document.querySelectorAll('script[type="module"][src]');
    assert.ok(scripts.length, 'Missing dashboard entrypoint');
    for (const script of scripts) {
      // Vite currently emits a single self-contained entry bundle.
      dom.window.eval(await asset(script.getAttribute('src')));
    }
    const deadline = Date.now() + 3000;
    while (
      !dom.window.document.querySelector('main h1') &&
      !errors.length &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(
      errors.map((error) => error.message),
      [],
      'Dashboard runtime errors',
    );
    assert.ok(dom.window.document.querySelector('.topnav'), 'Missing navigation');
    assert.equal(
      dom.window.document.querySelector('main h1')?.textContent,
      route === '/login' ? 'Sign in' : 'Repositories',
    );
    assert.ok(dom.window.document.querySelector('a[href="/login"]'));
    if (route === '/login') {
      while (
        !dom.window.document.querySelector('[role="alert"]') &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(dom.window.document.body.textContent, /Sign-in setup is incomplete/);
      assert.equal(dom.window.document.querySelector('a[href="/auth/github"]'), null);
    }
  } finally {
    dom.window.close();
  }
  globalThis.console.log(`Dashboard production startup passed: ${route}`);
}
