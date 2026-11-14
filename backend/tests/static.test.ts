import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { unguardedRoutes } from '../src/lib/permissions.js';
import { shutdown } from './helpers.js';

let api: ReturnType<typeof supertest>;

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'erpatio-static-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>ERPatio</title><div id="root"></div>');
  process.env.STATIC_DIR = dir;
  resetEnvCache();
  const app = createApp();
  expect(unguardedRoutes(app)).toEqual([]);
  api = supertest(app);
});
afterAll(async () => {
  delete process.env.STATIC_DIR;
  resetEnvCache();
  await shutdown();
});

describe('serving the React build from Express (ADR-007)', () => {
  it('serves the app shell at / and for client-side deep links', async () => {
    for (const url of ['/', '/journal/some-id', '/trial-balance']) {
      const r = await api.get(url);
      expect([url, r.status]).toEqual([url, 200]);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.text).toContain('<title>ERPatio</title>');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
  });

  it('never answers an unknown API path with the app shell', async () => {
    const r = await api.get('/api/v1/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/json/);
  });

  it('sends a strict CSP: same-origin scripts, fonts and no third parties', async () => {
    const csp = (await api.get('/')).headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/https:(?!\/\/)/);
    expect(csp).toContain("object-src 'none'");
  });
});
