import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiDocs } from '../src/lib/route.js';
import { SYSTEM_ROLES } from '../src/lib/permissions.js';
import { createUser } from '../src/modules/tenants/provision.js';
import { PASSWORD, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

/**
 * Every protected operation the API declares, called three ways: with no token (401), as a person who holds no permission at
 * all (403), and as a viewer (403 exactly when the viewer lacks the permission, and never a server error either way).
 * It is generated from the route table, so a route added tomorrow is covered the day it is added.
 */
let api: Api;
let t: Seeded;
let nobody: string;
let viewer: string;
const ID = '00000000-0000-4000-8000-000000000001';
const concrete = (path: string) => path.replace(/\{[A-Za-z]+\}/g, ID);

beforeAll(async () => {
  api = newApi();
  await resetData();
  t = await seedTenant('mx-co', { vic: ['Viewer'] }, false, { modules: ['finance', 'supply_chain', 'production', 'hcm', 'bi'] });
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const email = 'nobody@mx-co.test';
    await createUser(c, { tenantId: t.tenantId, email, fullName: 'Nobody', password: PASSWORD, roles: [] });
    await c.query('COMMIT');
  } finally { c.release(); }
  nobody = (await api.post('/api/v1/auth/login').send({ workspace: 'mx-co', email: 'nobody@mx-co.test', password: PASSWORD })).body.access_token;
  viewer = await tokenFor(api, t, 'vic');
});
afterAll(async () => { await resetData(); await shutdown(); });

const call = (method: string, path: string, token?: string) => {
  const r = (api as unknown as Record<string, (p: string) => import('supertest').Test>)[method]!(path);
  const withAuth = token ? r.set(auth(token)) : r;
  return ['post', 'put', 'patch'].includes(method) ? withAuth.send({}) : withAuth;
};

describe('authorization matrix', () => {
  it('knows the routes (guards against the table going empty)', () => {
    const guarded = apiDocs.filter((d) => d.guard.kind === 'permission');
    expect(guarded.length).toBeGreaterThan(150);
  });

  it('refuses every protected operation without a token', async () => {
    const bad: string[] = [];
    for (const d of apiDocs.filter((x) => x.guard.kind !== 'public')) {
      const r = await call(d.method, concrete(d.path));
      if (r.status !== 401) bad.push(`${d.method.toUpperCase()} ${d.path} -> ${r.status}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('refuses every permission-protected operation to someone who holds no permission', async () => {
    const bad: string[] = [];
    for (const d of apiDocs.filter((x) => x.guard.kind === 'permission')) {
      const r = await call(d.method, concrete(d.path), nobody);
      if (r.status !== 403) bad.push(`${d.method.toUpperCase()} ${d.path} -> ${r.status}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('gives a viewer exactly what a viewer holds, and never a server error', async () => {
    const held = new Set(SYSTEM_ROLES.Viewer);
    const bad: string[] = [];
    for (const d of apiDocs.filter((x) => x.guard.kind === 'permission')) {
      // Skip the one operation that would run a real five-minute-limited export.
      if (d.path.endsWith('/export')) continue;
      const r = await call(d.method, concrete(d.path), viewer);
      const allowed = held.has(d.guard.permission as never);
      if (allowed && (r.status === 403 || r.status >= 500)) bad.push(`${d.method.toUpperCase()} ${d.path} allowed but -> ${r.status}`);
      if (!allowed && r.status !== 403) bad.push(`${d.method.toUpperCase()} ${d.path} not allowed but -> ${r.status}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
