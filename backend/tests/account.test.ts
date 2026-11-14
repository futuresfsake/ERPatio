import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { setBreachChecker } from '../src/lib/breached.js';
import { MemoryMailer, setMailer } from '../src/lib/mailer.js';
import { slugify } from '../src/modules/auth/account.js';
import { PASSWORD, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api } from './helpers.js';

let api: Api;
let mail: MemoryMailer;
const GOOD = 'a-long-enough-passphrase';

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  mail = new MemoryMailer();
  setMailer(mail);
  setBreachChecker(undefined);
});
afterEach(() => {
  process.env.SIGNUP_ENABLED = 'true';
  resetEnvCache();
});
afterAll(async () => { setMailer(undefined); await shutdown(); });

const tokenIn = (m: { text: string }) => decodeURIComponent(/token=([^\s]+)/.exec(m.text)![1]!);
const signup = (over: Record<string, unknown> = {}) =>
  api.post('/api/v1/auth/signup').send({ company: 'Mabini Hardware Inc.', full_name: 'Ana Reyes', email: 'ana@mabini.test', password: GOOD, accept_privacy: true, ...over });

describe('slug generation', () => {
  it('turns a company name into a safe workspace code', () => {
    expect(slugify('Mabini Hardware Inc.')).toBe('mabini-hardware-inc');
    expect(slugify('  Café Niño & Sons!! ')).toBe('cafe-nino-sons');
    expect(slugify('A')).toBe('a-co');
    expect(slugify('admin')).toBe('admin-co');
    expect(slugify('x'.repeat(80))).toHaveLength(30);
    for (const s of ['Mabini Hardware Inc.', '日本語', '!!!', 'a b c d e f g h i j k l m n o p q r s t u v w x y z']) expect(slugify(s)).toMatch(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
  });
});

describe('sign-up (US-010)', () => {
  it('creates a workspace and an unverified administrator, records consent, and sends a confirmation email', async () => {
    const r = await signup();
    expect(r.status).toBe(202);
    const tenant = (await owner.query("SELECT id, slug, name, is_demo FROM tenants WHERE slug = 'mabini-hardware-inc'")).rows[0];
    expect(tenant).toMatchObject({ name: 'Mabini Hardware Inc.', is_demo: false });
    const u = (await owner.query('SELECT email, email_verified FROM users WHERE tenant_id = $1', [tenant.id])).rows[0];
    expect(u).toEqual({ email: 'ana@mabini.test', email_verified: false });
    expect((await owner.query('SELECT kind, version FROM consents WHERE tenant_id = $1', [tenant.id])).rows[0]).toEqual({ kind: 'privacy_notice', version: '2026-11' });
    expect((await owner.query('SELECT count(*)::int AS n FROM accounts WHERE tenant_id = $1', [tenant.id])).rows[0].n).toBe(16);
    expect((await owner.query('SELECT count(*)::int AS n FROM fiscal_periods WHERE tenant_id = $1', [tenant.id])).rows[0].n).toBe(36);
    expect((await owner.query('SELECT mfa_required_roles FROM tenant_settings WHERE tenant_id = $1', [tenant.id])).rows[0].mfa_required_roles).toEqual(['TenantAdmin']);
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.to).toBe('ana@mabini.test');
    expect(mail.outbox[0]!.text).toContain('/verify-email?token=');
  });

  it('stores only a hash of the emailed token', async () => {
    await signup();
    const raw = tokenIn(mail.outbox[0]!);
    const row = (await owner.query('SELECT token_hash FROM email_tokens')).rows[0];
    expect(row.token_hash).toHaveLength(64);
    expect(row.token_hash).not.toContain(raw.split('.')[1]);
  });

  it('cannot sign in until the email is confirmed; the link works once', async () => {
    await signup();
    const body = { workspace: 'mabini-hardware-inc', email: 'ana@mabini.test', password: GOOD };
    expect((await api.post('/api/v1/auth/login').send(body)).body.error.code).toBe('email_not_verified');
    const token = tokenIn(mail.outbox[0]!);
    expect((await api.post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await api.post('/api/v1/auth/login').send(body)).status).toBe(200);
    expect((await api.post('/api/v1/auth/verify-email').send({ token })).body.error.code).toBe('invalid_token');
  });

  it('rejects an expired or made-up token', async () => {
    await signup();
    const token = tokenIn(mail.outbox[0]!);
    await owner.query("UPDATE email_tokens SET expires_at = now() - interval '1 minute'");
    expect((await api.post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);
    expect((await api.post('/api/v1/auth/verify-email').send({ token: `${'0'.repeat(8)}-0000-4000-8000-000000000000.${'x'.repeat(40)}` })).status).toBe(400);
  });

  it('refuses weak, breached or consent-less sign-ups and creates nothing', async () => {
    expect((await signup({ password: 'short' })).body.error.code).toBe('weak_password');
    setBreachChecker(async () => true);
    expect((await signup()).body.error.code).toBe('breached_password');
    setBreachChecker(undefined);
    expect((await signup({ accept_privacy: false })).status).toBe(422);
    expect((await signup({ email: 'not-an-email' })).status).toBe(422);
    expect((await owner.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n).toBe(0);
    expect(mail.outbox).toHaveLength(0);
  });

  it('two companies with the same name get different workspace codes', async () => {
    await signup();
    await signup({ email: 'bea@other.test' });
    const slugs = (await owner.query('SELECT slug FROM tenants ORDER BY created_at')).rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs[0]).toBe('mabini-hardware-inc');
  });

  it('is closed unless SIGNUP_ENABLED', async () => {
    process.env.SIGNUP_ENABLED = 'false';
    resetEnvCache();
    expect((await signup()).status).toBe(404);
    expect((await api.get('/api/v1/public-config')).body).toEqual({ signup_enabled: false });
  });

  it('a new administrator must set up two-factor sign-in before using the app', async () => {
    await signup();
    await api.post('/api/v1/auth/verify-email').send({ token: tokenIn(mail.outbox[0]!) });
    const login = await api.post('/api/v1/auth/login').send({ workspace: 'mabini-hardware-inc', email: 'ana@mabini.test', password: GOOD });
    expect(login.body.user.mfa_enrollment_required).toBe(true);
    const tok = login.body.access_token as string;
    const blocked = await api.get('/api/v1/accounts').set(auth(tok));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('mfa_enrollment_required');
    expect((await api.get('/api/v1/auth/me').set(auth(tok))).status).toBe(200);
  });
});

describe('verification email can be re-sent', () => {
  it('sends only for an unverified account, and answers the same for everyone', async () => {
    await signup();
    mail.outbox.length = 0;
    const known = await api.post('/api/v1/auth/resend-verification').send({ workspace: 'mabini-hardware-inc', email: 'ana@mabini.test' });
    const unknown = await api.post('/api/v1/auth/resend-verification').send({ workspace: 'mabini-hardware-inc', email: 'nobody@mabini.test' });
    const noTenant = await api.post('/api/v1/auth/resend-verification').send({ workspace: 'ghost-co', email: 'ana@mabini.test' });
    for (const r of [known, unknown, noTenant]) expect(r.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(known.body).toEqual(noTenant.body);
    expect(mail.outbox).toHaveLength(1);
  });
});

describe('password reset (US-015)', () => {
  const who = { workspace: 'reset-co', email: 'rita@reset-co.test' };
  const login = (password: string) => api.post('/api/v1/auth/login').send({ ...who, password });

  it('answers identically for existing and unknown accounts, and only emails real ones', async () => {
    await seedTenant('reset-co', { rita: ['Accountant'] });
    const real = await api.post('/api/v1/auth/forgot-password').send(who);
    const fake = await api.post('/api/v1/auth/forgot-password').send({ ...who, email: 'nobody@reset-co.test' });
    const none = await api.post('/api/v1/auth/forgot-password').send({ workspace: 'ghost-co', email: who.email });
    expect([real.status, fake.status, none.status]).toEqual([202, 202, 202]);
    expect(real.body).toEqual(fake.body);
    expect(real.body).toEqual(none.body);
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.text).toContain('/reset-password?token=');
  });

  it('changes the password once, ends every session, and the old password stops working', async () => {
    await seedTenant('reset-co', { rita: ['Accountant'] });
    const first = await login(PASSWORD);
    const cookie = (first.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('erp_refresh='))!.split(';')[0]!;
    await api.post('/api/v1/auth/forgot-password').send(who);
    const token = tokenIn(mail.outbox[0]!);
    const next = 'a-brand-new-passphrase';
    expect((await api.post('/api/v1/auth/reset-password').send({ token, password: next })).status).toBe(200);
    expect((await login(PASSWORD)).status).toBe(401);
    expect((await login(next)).status).toBe(200);
    expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', cookie)).status).toBe(401);
    expect((await api.post('/api/v1/auth/reset-password').send({ token, password: 'yet-another-passphrase' })).body.error.code).toBe('invalid_token');
    expect((await owner.query("SELECT 1 FROM audit_log WHERE action = 'auth.password_reset'")).rowCount).toBe(1);
  });

  it('a weak or breached new password is refused and the link stays usable', async () => {
    await seedTenant('reset-co', { rita: ['Accountant'] });
    await api.post('/api/v1/auth/forgot-password').send(who);
    const token = tokenIn(mail.outbox[0]!);
    expect((await api.post('/api/v1/auth/reset-password').send({ token, password: 'short' })).body.error.code).toBe('weak_password');
    setBreachChecker(async () => true);
    expect((await api.post('/api/v1/auth/reset-password').send({ token, password: GOOD })).body.error.code).toBe('breached_password');
    setBreachChecker(undefined);
    expect((await api.post('/api/v1/auth/reset-password').send({ token, password: GOOD })).status).toBe(200);
  });

  it('a newer link replaces the older one, and an expired one is refused', async () => {
    await seedTenant('reset-co', { rita: ['Accountant'] });
    await api.post('/api/v1/auth/forgot-password').send(who);
    await api.post('/api/v1/auth/forgot-password').send(who);
    const [older, newer] = mail.outbox.map(tokenIn);
    expect((await api.post('/api/v1/auth/reset-password').send({ token: older, password: GOOD })).status).toBe(400);
    await owner.query("UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL");
    expect((await api.post('/api/v1/auth/reset-password').send({ token: newer, password: GOOD })).status).toBe(400);
  });

  it('a reset unlocks a locked account and confirms the address', async () => {
    await seedTenant('reset-co', { rita: ['Accountant'] });
    await owner.query("UPDATE users SET locked_until = now() + interval '1 hour', failed_attempts = 3, email_verified = false");
    await api.post('/api/v1/auth/forgot-password').send(who);
    await api.post('/api/v1/auth/reset-password').send({ token: tokenIn(mail.outbox[0]!), password: GOOD });
    expect((await login(GOOD)).status).toBe(200);
  });

  it('never resets the shared demo account', async () => {
    await seedTenant('reset-co', { rita: ['DemoUser'] }, true);
    await api.post('/api/v1/auth/forgot-password').send(who);
    expect(mail.outbox).toHaveLength(0);
    expect((await login(PASSWORD)).status).toBe(200);
  });
});

describe('the shared demo account is never locked (F-05)', () => {
  it('many wrong passwords do not shut visitors out', async () => {
    const demo = await seedTenant('demo-lock', { dee: ['DemoUser'] }, true);
    for (let i = 0; i < 9; i++) expect((await api.post('/api/v1/auth/login').send({ workspace: demo.slug, email: demo.users.dee!.email, password: 'wrong-password-123' })).status).toBe(401);
    expect((await api.post('/api/v1/auth/login').send({ workspace: demo.slug, email: demo.users.dee!.email, password: PASSWORD })).status).toBe(200);
    expect((await tokenFor(api, demo, 'dee')).length).toBeGreaterThan(20);
  });
});
