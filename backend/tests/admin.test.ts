import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMailer, setMailer } from '../src/lib/mailer.js';
import { auth, loginAs, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let mail: MemoryMailer;
let t: Seeded;
let ada: string; // TenantAdmin
let amy: string; // Accountant
let vic: string; // Viewer
let roleId: Record<string, string>;
const GOOD = 'a-long-enough-passphrase';

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  mail = new MemoryMailer();
  setMailer(mail);
  t = await seedTenant('admin-co', { ada: ['TenantAdmin'], amy: ['Accountant'], vic: ['Viewer'] });
  [ada, amy, vic] = [await tokenFor(api, t, 'ada'), await tokenFor(api, t, 'amy'), await tokenFor(api, t, 'vic')];
  const roles = (await api.get('/api/v1/roles').set(auth(ada))).body as { id: string; name: string }[];
  roleId = Object.fromEntries(roles.map((r) => [r.name, r.id]));
});
afterAll(async () => { setMailer(undefined); await shutdown(); });

const invite = (body: object, tok = ada) => api.post('/api/v1/users').set(auth(tok)).send(body);
const tokenIn = (m: { text: string }) => decodeURIComponent(/token=([^\s]+)/.exec(m.text)![1]!);
const users = async (tok = ada) => (await api.get('/api/v1/users').set(auth(tok))).body as { id: string; email: string; is_active: boolean; invite_pending: boolean; roles: { name: string }[] }[];

describe('inviting people (US-016)', () => {
  it('sends an invitation; the person chooses a password and signs in with the granted role', async () => {
    const r = await invite({ email: 'New.Hire@admin-co.test', full_name: 'New Hire', role_ids: [roleId['Accountant']] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: 'new.hire@admin-co.test', invite_pending: true, is_active: true });
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.subject).toContain('invited');
    expect((await api.post('/api/v1/auth/login').send({ workspace: 'admin-co', email: 'new.hire@admin-co.test', password: 'guess-guess-guess' })).status).toBe(401);
    expect((await api.post('/api/v1/auth/reset-password').send({ token: tokenIn(mail.outbox[0]!), password: GOOD })).status).toBe(200);
    const login = await api.post('/api/v1/auth/login').send({ workspace: 'admin-co', email: 'new.hire@admin-co.test', password: GOOD });
    expect(login.status).toBe(200);
    expect(login.body.user.roles).toEqual(['Accountant']);
    expect((await users()).find((u) => u.email === 'new.hire@admin-co.test')!.invite_pending).toBe(false);
  });

  it('refuses duplicates, unknown roles and anyone without the right permission', async () => {
    const body = { email: 'dup@admin-co.test', full_name: 'Dup', role_ids: [roleId['Viewer']] };
    expect((await invite(body)).status).toBe(201);
    expect((await invite({ ...body, email: 'DUP@admin-co.test' })).body.error.code).toBe('email_taken');
    expect((await invite({ ...body, email: 'x@admin-co.test', role_ids: ['00000000-0000-4000-8000-000000000000'] })).body.error.code).toBe('invalid_role');
    expect((await invite({ ...body, email: 'y@admin-co.test', role_ids: [] })).status).toBe(422);
    expect((await invite({ ...body, email: 'z@admin-co.test' }, amy)).status).toBe(403);
    expect((await api.get('/api/v1/users').set(auth(vic))).status).toBe(403);
  });

  it('resends only while the invitation is unanswered', async () => {
    const r = await invite({ email: 'late@admin-co.test', full_name: 'Late', role_ids: [roleId['Viewer']] });
    mail.outbox.length = 0;
    expect((await api.post(`/api/v1/users/${r.body.id}/resend-invite`).set(auth(ada)).send({})).status).toBe(200);
    expect(mail.outbox).toHaveLength(1);
    await api.post('/api/v1/auth/reset-password').send({ token: tokenIn(mail.outbox[0]!), password: GOOD });
    expect((await api.post(`/api/v1/users/${r.body.id}/resend-invite`).set(auth(ada)).send({})).body.error.code).toBe('not_pending');
  });

  it('cannot reach people in another workspace', async () => {
    const other = await seedTenant('other-co', { oz: ['TenantAdmin'] });
    expect((await api.patch(`/api/v1/users/${other.users.oz!.id}`).set(auth(ada)).send({ is_active: false })).status).toBe(404);
    expect((await api.patch(`/api/v1/users/${other.users.oz!.id}/roles`).set(auth(ada)).send({ role_ids: [roleId['Viewer']] })).status).toBe(404);
    expect((await users()).map((u) => u.email).some((e) => e.includes('other-co'))).toBe(false);
  });

  it('is closed in the shared demo workspace', async () => {
    const demo = await seedTenant('demo-admin', { dee: ['TenantAdmin'] }, true);
    const tok = await tokenFor(api, demo, 'dee');
    const roles = (await api.get('/api/v1/roles').set(auth(tok))).body as { id: string; name: string }[];
    expect((await invite({ email: 'a@demo.test', full_name: 'A', role_ids: [roles[0]!.id] }, tok)).body.error.code).toBe('demo_restricted');
    expect((await api.post('/api/v1/roles').set(auth(tok)).send({ name: 'Extra', permissions: ['accounts:read'] })).body.error.code).toBe('demo_restricted');
  });
});

describe('roles on people (US-017)', () => {
  it('replaces roles, and the permissions are the union of all of them after the next sign-in', async () => {
    const amyId = t.users.amy!.id;
    const r = await api.patch(`/api/v1/users/${amyId}/roles`).set(auth(ada)).send({ role_ids: [roleId['Viewer'], roleId['FinanceManager']] });
    expect(r.status).toBe(200);
    expect(r.body.roles.map((x: { name: string }) => x.name)).toEqual(['FinanceManager', 'Viewer']);
    const login = await loginAs(api, t, 'amy');
    expect(login.body.user.roles).toEqual(['FinanceManager', 'Viewer']);
    expect(login.body.user.permissions).toContain('periods:manage');
    expect(login.body.user.permissions).toContain('journal:read');
  });

  it('nobody can grant more than they hold', async () => {
    // a delegated people-manager who is not an administrator
    const hr = (await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'People manager', permissions: ['users:read', 'users:manage'] })).body;
    const hrUser = await invite({ email: 'hr@admin-co.test', full_name: 'HR', role_ids: [hr.id] });
    await api.post('/api/v1/auth/reset-password').send({ token: tokenIn(mail.outbox[0]!), password: GOOD });
    const hrTok = (await api.post('/api/v1/auth/login').send({ workspace: 'admin-co', email: 'hr@admin-co.test', password: GOOD })).body.access_token as string;

    const asAdmin = await api.patch(`/api/v1/users/${t.users.vic!.id}/roles`).set(auth(hrTok)).send({ role_ids: [roleId['TenantAdmin']] });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.code).toBe('cannot_grant');
    expect((await api.patch(`/api/v1/users/${t.users.vic!.id}/roles`).set(auth(hrTok)).send({ role_ids: [roleId['Accountant']] })).body.error.code).toBe('cannot_grant');
    expect((await api.patch(`/api/v1/users/${t.users.vic!.id}/roles`).set(auth(hrTok)).send({ role_ids: [hr.id] })).status).toBe(200); // a role within their own reach
    expect(hrUser.status).toBe(201);
  });

  it('always keeps one active administrator', async () => {
    const adaId = t.users.ada!.id;
    expect((await api.patch(`/api/v1/users/${adaId}`).set(auth(ada)).send({ is_active: false })).body.error.code).toBe('not_allowed');
    expect((await api.patch(`/api/v1/users/${adaId}/roles`).set(auth(ada)).send({ role_ids: [roleId['Viewer']] })).body.error.code).toBe('last_admin');
    // with a second administrator the first may step down
    const eve = await invite({ email: 'eve@admin-co.test', full_name: 'Eve', role_ids: [roleId['TenantAdmin']] });
    expect(eve.status).toBe(201);
    expect((await api.patch(`/api/v1/users/${adaId}/roles`).set(auth(ada)).send({ role_ids: [roleId['Viewer']] })).status).toBe(200);
    // and now Eve is the last one
    await api.post('/api/v1/auth/reset-password').send({ token: tokenIn(mail.outbox[0]!), password: GOOD });
    const eveTok = (await api.post('/api/v1/auth/login').send({ workspace: 'admin-co', email: 'eve@admin-co.test', password: GOOD })).body.access_token as string;
    expect((await api.patch(`/api/v1/users/${eve.body.id}/roles`).set(auth(eveTok)).send({ role_ids: [roleId['Viewer']] })).body.error.code).toBe('last_admin');
  });
});

describe('deactivating and reactivating (US-016)', () => {
  it('ends sessions and blocks sign-in, keeps the records, and can be undone', async () => {
    const amyId = t.users.amy!.id;
    const login = await loginAs(api, t, 'amy');
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_refresh='))!.split(';')[0]!;
    expect((await api.patch(`/api/v1/users/${amyId}`).set(auth(ada)).send({ is_active: false })).body.is_active).toBe(false);
    expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', cookie)).status).toBe(401);
    expect((await loginAs(api, t, 'amy')).status).toBe(401);
    expect((await users()).find((u) => u.id === amyId)).toBeDefined(); // history is retained
    expect((await api.patch(`/api/v1/users/${amyId}`).set(auth(ada)).send({ is_active: true })).body.is_active).toBe(true);
    expect((await loginAs(api, t, 'amy')).status).toBe(200);
    const actions = (await owner.query("SELECT action, detail FROM audit_log WHERE action LIKE 'user.%' ORDER BY id")).rows;
    expect(actions.map((a) => a.action)).toEqual(['user.deactivated', 'user.reactivated']);
    expect(JSON.stringify(actions)).not.toContain('@');
  });

  it('renames a person', async () => {
    const r = await api.patch(`/api/v1/users/${t.users.vic!.id}`).set(auth(ada)).send({ full_name: 'Victoria Cruz' });
    expect(r.body.full_name).toBe('Victoria Cruz');
    expect((await api.patch(`/api/v1/users/${t.users.vic!.id}`).set(auth(ada)).send({})).status).toBe(422);
  });
});

describe('custom roles (US-024)', () => {
  const perms = ['accounts:read', 'journal:read', 'reports:read', 'audit:read'];

  it('lists the built-in roles with their permissions and how many people hold them', async () => {
    const roles = (await api.get('/api/v1/roles').set(auth(ada))).body as { name: string; is_system: boolean; permissions: string[]; user_count: number }[];
    expect(roles.map((r) => r.name)).toEqual(expect.arrayContaining(['TenantAdmin', 'FinanceManager', 'Accountant', 'Viewer']));
    expect(roles.find((r) => r.name === 'Viewer')).toMatchObject({ is_system: true, user_count: 1 });
    expect(roles.find((r) => r.name === 'TenantAdmin')!.permissions).not.toContain('platform:manage');
  });

  it('creates a role that takes effect at the next sign-in, and lists what can be granted', async () => {
    const cat = (await api.get('/api/v1/permissions').set(auth(ada))).body as { key: string }[];
    expect(cat.map((c) => c.key)).toContain('journal:approve');
    expect(cat.map((c) => c.key)).not.toContain('platform:manage');
    const role = await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Auditor', description: 'Reads everything, changes nothing', permissions: perms });
    expect(role.status).toBe(201);
    expect(role.body.permissions.sort()).toEqual([...perms].sort());
    await api.patch(`/api/v1/users/${t.users.vic!.id}/roles`).set(auth(ada)).send({ role_ids: [role.body.id] });
    const tok = await tokenFor(api, t, 'vic');
    expect((await api.get('/api/v1/audit-log').set(auth(tok))).status).toBe(200);
    expect((await api.post('/api/v1/accounts').set(auth(tok)).send({ code: '9', name: 'x', type: 'asset' })).status).toBe(403);
  });

  it('rejects unknown permissions, the platform permission, duplicates and non-managers', async () => {
    expect((await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Bad', permissions: ['accounts:destroy'] })).status).toBe(422);
    expect((await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Sneaky', permissions: ['platform:manage'] })).status).toBe(422);
    await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Once', permissions: perms }).expect(201);
    expect((await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Once', permissions: perms })).body.error.code).toBe('role_exists');
    expect((await api.post('/api/v1/roles').set(auth(amy)).send({ name: 'Mine', permissions: perms })).status).toBe(403);
  });

  it('cannot create a role with permissions the creator lacks', async () => {
    const mgr = (await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Role builder', permissions: ['roles:manage', 'users:read'] })).body;
    await api.patch(`/api/v1/users/${t.users.amy!.id}/roles`).set(auth(ada)).send({ role_ids: [mgr.id] });
    const tok = await tokenFor(api, t, 'amy');
    const r = await api.post('/api/v1/roles').set(auth(tok)).send({ name: 'Bigger', permissions: ['journal:approve'] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('cannot_grant');
  });

  it('built-in roles cannot be changed; a custom role in use cannot be deleted', async () => {
    expect((await api.patch(`/api/v1/roles/${roleId['Viewer']}`).set(auth(ada)).send({ permissions: ['accounts:read'] })).body.error.code).toBe('system_role');
    expect((await api.delete(`/api/v1/roles/${roleId['Viewer']}`).set(auth(ada))).body.error.code).toBe('system_role');
    const role = (await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Temp', permissions: perms })).body;
    await api.patch(`/api/v1/users/${t.users.vic!.id}/roles`).set(auth(ada)).send({ role_ids: [role.id] });
    expect((await api.delete(`/api/v1/roles/${role.id}`).set(auth(ada))).body.error.code).toBe('role_in_use');
    await api.patch(`/api/v1/users/${t.users.vic!.id}/roles`).set(auth(ada)).send({ role_ids: [roleId['Viewer']] });
    expect((await api.patch(`/api/v1/roles/${role.id}`).set(auth(ada)).send({ name: 'Renamed', permissions: ['accounts:read'] })).body).toMatchObject({ name: 'Renamed', permissions: ['accounts:read'] });
    expect((await api.delete(`/api/v1/roles/${role.id}`).set(auth(ada))).status).toBe(204);
  });

  it('audits every role change', async () => {
    const role = (await api.post('/api/v1/roles').set(auth(ada)).send({ name: 'Logged', permissions: perms })).body;
    await api.patch(`/api/v1/roles/${role.id}`).set(auth(ada)).send({ description: 'x' });
    await api.delete(`/api/v1/roles/${role.id}`).set(auth(ada));
    expect((await owner.query("SELECT action FROM audit_log WHERE action LIKE 'role.%' ORDER BY id")).rows.map((r) => r.action)).toEqual(['role.created', 'role.updated', 'role.deleted']);
  });
});

describe('module subscriptions (US-021)', () => {
  it('shows what the workspace has subscribed to', async () => {
    const info = (await api.get('/api/v1/tenant').set(auth(vic))).body;
    expect(info.slug).toBe('admin-co');
    expect(info.modules.find((m: { module: string }) => m.module === 'finance').enabled).toBe(true);
    expect(info.modules.find((m: { module: string }) => m.module === 'hcm').enabled).toBe(false);
  });

  it('a disabled module answers 403 for everyone while core administration keeps working', async () => {
    await owner.query("UPDATE tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'finance'", [t.tenantId]);
    const tok = await tokenFor(api, t, 'ada');
    for (const path of ['/api/v1/accounts', '/api/v1/journal-entries', '/api/v1/reports/trial-balance', '/api/v1/fiscal-periods']) {
      const r = await api.get(path).set(auth(tok));
      expect([path, r.status, r.body.error?.code]).toEqual([path, 403, 'module_disabled']);
    }
    expect((await api.get('/api/v1/users').set(auth(tok))).status).toBe(200);
    expect((await api.get('/api/v1/audit-log').set(auth(tok))).status).toBe(200);
  });
});
