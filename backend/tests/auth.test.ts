import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, auth, loginAs, newApi, owner, resetData, seedTenant, shutdown, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('acme', { alice: ['Accountant'] });
});
afterAll(shutdown);

const cookieOf = (r: { headers: Record<string, unknown> }) =>
  ((r.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith('erp_refresh='))!;
const refreshWith = (cookie: string) =>
  api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', cookie.split(';')[0]!);

describe('login', () => {
  it('returns an access token and sets an HttpOnly, SameSite=Strict refresh cookie', async () => {
    const r = await loginAs(api, t, 'alice');
    expect(r.status).toBe(200);
    expect(r.body.user.roles).toEqual(['Accountant']);
    expect(r.body.user.permissions).toContain('journal:post');
    const cookie = cookieOf(r);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(JSON.stringify(r.body)).not.toContain('refresh');
  });

  it('gives identical responses for unknown user, wrong password and unknown workspace (no enumeration)', async () => {
    const wrongPw = await loginAs(api, t, 'alice', 'wrong-password-123');
    const unknownUser = await api.post('/api/v1/auth/login').send({ workspace: 'acme', email: 'nobody@acme.test', password: PASSWORD });
    const unknownTenant = await api.post('/api/v1/auth/login').send({ workspace: 'ghost', email: 'alice@acme.test', password: PASSWORD });
    for (const r of [wrongPw, unknownUser, unknownTenant]) expect(r.status).toBe(401);
    const strip = (b: { error: { request_id: string } & Record<string, unknown> }) => ({ ...b.error, request_id: undefined });
    expect(strip(unknownUser.body)).toEqual(strip(wrongPw.body));
    expect(strip(unknownTenant.body)).toEqual(strip(wrongPw.body));
  });

  it('locks the account after 5 failures and then rejects even the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await loginAs(api, t, 'alice', 'wrong-password-123')).status).toBe(401);
    expect((await loginAs(api, t, 'alice')).status).toBe(401);
    const log = await owner.query("SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY id", [t.tenantId]);
    const actions = log.rows.map((r) => r.action);
    expect(actions).toContain('auth.account_locked');
    expect(actions).toContain('auth.login_blocked');
  });

  it('rejects an unverified email only after the password is right', async () => {
    await owner.query('UPDATE users SET email_verified = false WHERE tenant_id = $1', [t.tenantId]);
    expect((await loginAs(api, t, 'alice', 'wrong-password-123')).status).toBe(401);
    const r = await loginAs(api, t, 'alice');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('email_not_verified');
  });

  it('refuses a deactivated user', async () => {
    await owner.query('UPDATE users SET is_active = false WHERE tenant_id = $1', [t.tenantId]);
    expect((await loginAs(api, t, 'alice')).status).toBe(401);
  });

  it('stores only a hash of the password and of the refresh token', async () => {
    const r = await loginAs(api, t, 'alice');
    const raw = cookieOf(r).split(';')[0]!.split('=')[1]!;
    const hashes = await owner.query('SELECT password_hash FROM users');
    expect(hashes.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    const tok = await owner.query('SELECT token_hash FROM refresh_tokens');
    expect(tok.rows[0].token_hash).not.toContain(raw);
    expect(tok.rows[0].token_hash).toHaveLength(64);
  });
});

describe('access token', () => {
  it('rejects missing, malformed, and tampered tokens', async () => {
    expect((await api.get('/api/v1/auth/me')).status).toBe(401);
    expect((await api.get('/api/v1/auth/me').set('Authorization', 'Bearer nonsense')).status).toBe(401);
    const r = await loginAs(api, t, 'alice');
    const [h, p, s] = (r.body.access_token as string).split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), perms: ['audit:read'] })).toString('base64url');
    expect((await api.get('/api/v1/auth/me').set(auth(`${h}.${forged}.${s}`))).status).toBe(401);
  });

  it('rejects an alg=none token', async () => {
    const hdr = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: t.users.alice!.id, tid: t.tenantId, perms: ['audit:read'], exp: 9999999999 })).toString('base64url');
    expect((await api.get('/api/v1/auth/me').set(auth(`${hdr}.${body}.`))).status).toBe(401);
  });
});

describe('refresh rotation', () => {
  it('rotates the token and revokes the whole chain when an old token is replayed', async () => {
    const login = await loginAs(api, t, 'alice');
    const first = cookieOf(login);
    const r2 = await refreshWith(first);
    expect(r2.status).toBe(200);
    const second = cookieOf(r2);
    expect(second.split(';')[0]).not.toEqual(first.split(';')[0]);

    // Replaying the first (already rotated) token long after the rotation is treated as theft.
    await owner.query("UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL AND replaced_by IS NOT NULL");
    expect((await refreshWith(first)).status).toBe(401);
    // ... which also kills the legitimately rotated token.
    expect((await refreshWith(second)).status).toBe(401);
    const actions = (await owner.query('SELECT action FROM audit_log')).rows.map((r) => r.action);
    expect(actions).toContain('auth.refresh_reuse_detected');
  });

  it('requires the CSRF header and a cookie', async () => {
    const login = await loginAs(api, t, 'alice');
    const cookie = cookieOf(login).split(';')[0]!;
    expect((await api.post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(403);
    expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio')).status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const cookie = cookieOf(await loginAs(api, t, 'alice'));
    const out = await api.post('/api/v1/auth/logout').set('X-Requested-With', 'erpatio').set('Cookie', cookie.split(';')[0]!);
    expect(out.status).toBe(204);
    expect((await refreshWith(cookie)).status).toBe(401);
  });

  it('refuses an expired refresh token', async () => {
    const cookie = cookieOf(await loginAs(api, t, 'alice'));
    await owner.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'");
    expect((await refreshWith(cookie)).status).toBe(401);
  });
});
