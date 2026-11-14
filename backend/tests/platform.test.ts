import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, accountIds, auth, entry, newApi, owner, resetData, seedPlatform, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let platform: Seeded;
let acme: Seeded;
let opal: string;
let ada: string;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  platform = await seedPlatform();
  acme = await seedTenant('acme-co', { ada: ['TenantAdmin'], amy: ['Accountant'] });
  opal = await tokenFor(api, platform, 'opal');
  ada = await tokenFor(api, acme, 'ada');
});
afterAll(shutdown);

const tenants = async () => (await api.get('/api/v1/platform/tenants').set(auth(opal))).body as { id: string; slug: string; status: string; users: number; modules: { module: string; enabled: boolean }[] }[];

describe('operator access', () => {
  it('only the platform administrator reaches the platform routes', async () => {
    expect((await api.get('/api/v1/platform/tenants').set(auth(ada))).status).toBe(403);
    expect((await api.post(`/api/v1/platform/tenants/${acme.tenantId}/status`).set(auth(ada)).send({ status: 'suspended' })).status).toBe(403);
    expect((await api.get('/api/v1/platform/tenants')).status).toBe(401);
    expect((await api.get('/api/v1/platform/tenants').set(auth(opal))).status).toBe(200);
  });

  it('holding the permission is not enough: the caller must belong to the operator workspace', async () => {
    await owner.query("INSERT INTO role_permissions (role_id, permission, tenant_id) SELECT id, 'platform:manage', tenant_id FROM roles WHERE name = 'TenantAdmin' AND tenant_id = $1", [acme.tenantId]);
    const sneaky = await tokenFor(api, acme, 'ada');
    const r = await api.get('/api/v1/platform/tenants').set(auth(sneaky));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
  });

  it('lists workspaces with their size and subscription, and never lists the platform workspace', async () => {
    const list = await tenants();
    expect(list.map((x) => x.slug)).toEqual(['acme-co']);
    expect(list[0]).toMatchObject({ status: 'active', users: 2 });
    expect(list[0]!.modules.find((m) => m.module === 'finance')!.enabled).toBe(true);
  });
});

describe('suspending a workspace', () => {
  it('blocks sign-in and refresh, records it in that workspace\'s own log, and can be undone', async () => {
    const login = await api.post('/api/v1/auth/login').send({ workspace: 'acme-co', email: acme.users.amy!.email, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_refresh='))!.split(';')[0]!;
    expect((await api.post(`/api/v1/platform/tenants/${acme.tenantId}/status`).set(auth(opal)).send({ status: 'suspended' })).body.status).toBe('suspended');
    expect((await api.post('/api/v1/auth/login').send({ workspace: 'acme-co', email: acme.users.amy!.email, password: PASSWORD })).status).toBe(401);
    expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', cookie)).status).toBe(401);
    expect((await owner.query("SELECT detail FROM audit_log WHERE tenant_id = $1 AND action = 'platform.tenant_suspended'", [acme.tenantId])).rowCount).toBe(1);
    expect((await api.post(`/api/v1/platform/tenants/${acme.tenantId}/status`).set(auth(opal)).send({ status: 'active' })).status).toBe(200);
    expect((await api.post('/api/v1/auth/login').send({ workspace: 'acme-co', email: acme.users.amy!.email, password: PASSWORD })).status).toBe(200);
  });

  it('suspending one workspace never signs anyone out of another (regression: owner queries must filter by tenant)', async () => {
    const beta = await seedTenant('beta-co', { bo: ['TenantAdmin'] });
    const login = await api.post('/api/v1/auth/login').send({ workspace: 'beta-co', email: beta.users.bo!.email, password: PASSWORD });
    const betaCookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_refresh='))!.split(';')[0]!;
    await api.post(`/api/v1/platform/tenants/${acme.tenantId}/status`).set(auth(opal)).send({ status: 'suspended' }).expect(200);
    expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', betaCookie)).status).toBe(200);
    const list = await tenants();
    expect(list.find((x) => x.slug === 'beta-co')).toMatchObject({ users: 1, status: 'active' });
    expect(list.find((x) => x.slug === 'acme-co')).toMatchObject({ users: 2, status: 'suspended' });
  });

  it('cannot touch the platform workspace itself, or something that does not exist', async () => {
    expect((await api.post(`/api/v1/platform/tenants/${platform.tenantId}/status`).set(auth(opal)).send({ status: 'suspended' })).body.error.code).toBe('not_allowed');
    expect((await api.post('/api/v1/platform/tenants/00000000-0000-4000-8000-000000000000/status').set(auth(opal)).send({ status: 'suspended' })).status).toBe(404);
    expect((await api.post(`/api/v1/platform/tenants/${acme.tenantId}/status`).set(auth(opal)).send({ status: 'deleted' })).status).toBe(422);
  });
});

describe('switching modules', () => {
  it('turns a module on or off for one workspace, and the workspace feels it at its next sign-in', async () => {
    const r = await api.patch(`/api/v1/platform/tenants/${acme.tenantId}/modules`).set(auth(opal)).send({ modules: { hcm: true, finance: false } });
    expect(r.status).toBe(200);
    expect(r.body.find((m: { module: string }) => m.module === 'hcm').enabled).toBe(true);
    const tok = await tokenFor(api, acme, 'ada');
    expect((await api.get('/api/v1/accounts').set(auth(tok))).body.error.code).toBe('module_disabled');
    expect((await api.get('/api/v1/tenant').set(auth(tok))).body.modules.find((m: { module: string }) => m.module === 'hcm').enabled).toBe(true);
    expect((await owner.query("SELECT detail FROM audit_log WHERE action = 'platform.modules_changed'")).rows[0].detail.modules).toEqual({ hcm: true, finance: false });
  });

  it('rejects unknown or empty module changes and leaves other workspaces alone', async () => {
    const other = await seedTenant('beta-co', { bo: ['TenantAdmin'] });
    expect((await api.patch(`/api/v1/platform/tenants/${acme.tenantId}/modules`).set(auth(opal)).send({ modules: { teleport: true } })).status).toBe(422);
    expect((await api.patch(`/api/v1/platform/tenants/${acme.tenantId}/modules`).set(auth(opal)).send({ modules: {} })).status).toBe(422);
    await api.patch(`/api/v1/platform/tenants/${acme.tenantId}/modules`).set(auth(opal)).send({ modules: { finance: false } });
    const t = (await tenants()).find((x) => x.id === other.tenantId)!;
    expect(t.modules.find((m) => m.module === 'finance')!.enabled).toBe(true);
  });
});

describe('support sessions (T-12)', () => {
  const open = (reason: string, tenantId = acme.tenantId) => api.post(`/api/v1/platform/tenants/${tenantId}/support-session`).set(auth(opal)).send({ reason });

  it('needs a real reason and is audited in the workspace with that reason', async () => {
    expect((await open('help')).status).toBe(422);
    const r = await open('Customer asked us to look at the March trial balance');
    expect(r.status).toBe(201);
    expect(r.body.tenant.slug).toBe('acme-co');
    expect(r.body.expires_in).toBeLessThanOrEqual(900);
    const log = (await owner.query("SELECT detail FROM audit_log WHERE tenant_id = $1 AND action = 'platform.support_session_started'", [acme.tenantId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0].detail).toMatchObject({ reason: 'Customer asked us to look at the March trial balance', operator: platform.users.opal!.id });
  });

  it('can read the books but cannot change anything, and cannot refresh itself', async () => {
    const acc = await accountIds(acme.tenantId);
    await api.post('/api/v1/journal-entries').set(auth(ada)).send(entry(acc)).expect(201);
    const support = (await open('Investigating a reported posting problem')).body.access_token as string;
    expect((await api.get('/api/v1/journal-entries').set(auth(support))).body.total).toBe(1);
    expect((await api.get('/api/v1/reports/balance-sheet').set(auth(support))).status).toBe(200);
    expect((await api.get('/api/v1/audit-log').set(auth(support))).status).toBe(200);
    for (const [method, path] of [['post', '/api/v1/journal-entries'], ['post', '/api/v1/accounts'], ['post', '/api/v1/journal-drafts'], ['patch', '/api/v1/settings'], ['post', '/api/v1/users'], ['get', '/api/v1/users'], ['get', '/api/v1/platform/tenants']] as const) {
      const r = await api[method](path).set(auth(support)).send({});
      expect([method, path, r.status]).toEqual([method, path, 403]);
    }
    expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio')).status).toBe(401); // no cookie, nothing to refresh
  });

  it('is refused for a suspended workspace and for a non-operator', async () => {
    await api.post(`/api/v1/platform/tenants/${acme.tenantId}/status`).set(auth(opal)).send({ status: 'suspended' });
    expect((await open('Checking on the suspended workspace')).body.error.code).toBe('not_active');
    expect((await api.post(`/api/v1/platform/tenants/${acme.tenantId}/support-session`).set(auth(ada)).send({ reason: 'I am a tenant admin' })).status).toBe(403);
  });
});
