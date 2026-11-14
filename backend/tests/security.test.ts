import { Writable } from 'node:stream';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getEnv, resetEnvCache } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { fromUnits, isMoney, toUnits } from '../src/lib/money.js';
import { unguardedRoutes } from '../src/lib/permissions.js';
import { apiDocs } from '../src/lib/route.js';
import supertest from 'supertest';
import { PASSWORD, newApi, resetData, seedTenant, shutdown, loginAs, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
beforeAll(async () => {
  await resetData();
  api = newApi();
  t = await seedTenant('sec-co', { sam: ['Viewer'] });
});
afterAll(shutdown);

describe('default deny (FR-AUT-07, US-124)', () => {
  it('every route in the real app declares a guard', () => {
    expect(unguardedRoutes(createApp())).toEqual([]);
  });

  it('the checker really detects an unguarded route', () => {
    const a = express();
    a.get('/oops', (_req, res) => void res.send('open'));
    expect(unguardedRoutes(a)).toEqual(['GET /oops']);
  });

  it('every non-public route answers 401 without a token', async () => {
    const protectedRoutes = apiDocs.filter((d) => d.guard.kind !== 'public');
    expect(protectedRoutes.length).toBeGreaterThan(8);
    for (const d of protectedRoutes) {
      const url = d.path.replace(/\{[A-Za-z]+\}/g, '00000000-0000-4000-8000-000000000000');
      const r = await api[d.method](url).send(d.method === 'get' ? undefined : {});
      expect([d.method, url, r.status]).toEqual([d.method, url, 401]);
    }
  });

  it('the public allow-list is exactly the intended set', () => {
    const open = apiDocs.filter((d) => d.guard.kind === 'public').map((d) => `${d.method} ${d.path}`).sort();
    expect(open).toEqual([
      'get /api/v1/openapi.json', 'get /api/v1/public-config', 'get /health', 'get /ready',
      'post /api/v1/auth/forgot-password', 'post /api/v1/auth/login', 'post /api/v1/auth/login/mfa', 'post /api/v1/auth/logout',
      'post /api/v1/auth/refresh', 'post /api/v1/auth/resend-verification', 'post /api/v1/auth/reset-password',
      'post /api/v1/auth/signup', 'post /api/v1/auth/verify-email',
    ]);
  });
});

describe('transport, headers and error hygiene (FR-SEC-03, FR-SEC-12)', () => {
  it('sets security headers and hides the framework', async () => {
    const r = await api.get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toMatch(/[0-9a-f-]{8,}/);
    expect((await api.get('/api/v1/accounts')).headers['cache-control']).toBe('no-store');
  });

  it('ignores a malicious request id and still issues a safe one', async () => {
    const r = await api.get('/health').set('X-Request-ID', 'x'.repeat(200));
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses one JSON error shape and never echoes submitted values', async () => {
    const secret = 'my-super-secret-password-value';
    const r = await api.post('/api/v1/auth/login').send({ workspace: 'sec-co', email: 'not-an-email', password: secret });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'validation_error', request_id: expect.any(String) });
    expect(JSON.stringify(r.body)).not.toContain(secret);
    expect(JSON.stringify(r.body)).not.toContain('not-an-email');
  });

  it('answers malformed JSON with 400 and unknown routes with a JSON 404', async () => {
    const bad = await api.post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"oops"');
    expect(bad.status).toBe(400);
    const nf = await api.get('/api/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('not_found');
  });

  it('rejects oversized bodies', async () => {
    const r = await api.post('/api/v1/auth/login').send({ workspace: 'x'.repeat(200_000) });
    expect(r.status).toBe(413);
  });

  it('does not allow cross-origin credentialed requests from unknown origins', async () => {
    const r = await api.get('/health').set('Origin', 'https://evil.example');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('SQL metacharacters in input are data, not code', async () => {
    const r = await loginAs(api, t, 'sam', 'x');
    expect(r.status).toBe(401);
    const inj = await api.post('/api/v1/auth/login').send({ workspace: "x'; DROP TABLE users;--", email: 'a@b.co', password: 'x' });
    expect(inj.status).toBe(401);
    // '_' and '%' are LIKE wildcards: 's_m@...' must never match the user 'sam@...'.
    const wild = await api.post('/api/v1/auth/login').send({ workspace: 'sec-co', email: 's_m@sec-co.test', password: PASSWORD });
    expect(wild.status).toBe(401);
  });
});

describe('rate limiting (FR-SEC-04)', () => {
  afterEach(() => {
    process.env.AUTH_RATE_PER_MINUTE = '1000';
    resetEnvCache();
  });

  it('returns 429 with Retry-After once the per-IP limit is exceeded', async () => {
    process.env.AUTH_RATE_PER_MINUTE = '3';
    resetEnvCache();
    const limited = supertest(createApp());
    const codes: number[] = [];
    let last: supertest.Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await limited.post('/api/v1/auth/login').send({ workspace: 'sec-co', email: 'sam@sec-co.test', password: 'nope' });
      codes.push(last.status);
    }
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    expect(last!.headers['retry-after']).toBeDefined();
    expect(last!.body.error.code).toBe('rate_limited');
  });
});

describe('PII never reaches logs (FR-PRV-03, BRU-PRV-2)', () => {
  it('masks emails and tokens in messages and fields', () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const log = createLogger(sink, 'info');
    log.info({ email: 'jane.doe@example.com', note: 'Authorization: Bearer abc.def.ghi', password: 'hunter2hunter2' }, 'login by jane.doe@example.com');
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'not_a_real_signature'].join('.'); // built at run time: not a real token
    log.info({ jwt: fakeJwt }, 'token');
    const out = chunks.join('');
    expect(out).not.toMatch(/jane\.doe|@example|hunter2|abc\.def\.ghi|eyJhbGciOi/);
    expect(out).toContain('[email]');
  });
});

describe('configuration guards (NFR-08)', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; resetEnvCache(); });

  it('refuses to boot in production with the dev secret, insecure cookies or wildcard CORS', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = 'a'.repeat(48);
    resetEnvCache();
    expect(() => getEnv()).toThrow(/COOKIE_SECURE/);
    process.env.COOKIE_SECURE = 'true';
    process.env.CORS_ORIGINS = '*';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/CORS/);
    process.env.CORS_ORIGINS = 'https://erpatio.example';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/MASTER_KEY/);
    process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.SIGNUP_ENABLED = 'true';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/SMTP_URL/);
    process.env.SIGNUP_ENABLED = 'false';
    resetEnvCache();
    // the webhook relaxations that tests rely on must never be allowed in production
    expect(() => getEnv()).toThrow(/WEBHOOK_ALLOW/);
    process.env.WEBHOOK_ALLOW_INSECURE = 'false';
    process.env.WEBHOOK_ALLOW_PRIVATE = 'false';
    resetEnvCache();
    expect(() => getEnv()).not.toThrow();
  });
});

describe('API documentation', () => {
  it('serves an OpenAPI document that marks protected operations', async () => {
    const r = await api.get('/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(r.body.paths['/api/v1/journal-entries'].post['x-guard']).toBe('journal:post');
    expect(r.body.paths['/api/v1/auth/login'].post.security).toBeUndefined();
  });
});

describe('money helpers', () => {
  it('parses and formats without floating point', () => {
    expect(toUnits('0.1') + toUnits('0.2')).toBe(toUnits('0.3'));
    expect(fromUnits(toUnits('1234567.89'))).toBe('1234567.8900');
    expect(fromUnits(-5n)).toBe('-0.0005');
    expect(['1', '1.5', '999999999999999.9999'].every(isMoney)).toBe(true);
    expect(['', '-1', '1.', '.5', '1e3', '1.00001', '9999999999999999'].some(isMoney)).toBe(false);
  });
});
