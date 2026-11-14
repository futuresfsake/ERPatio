import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, stepOf, verifyTotp } from '../src/lib/totp.js';
import { PASSWORD, auth, loginAs, newApi, owner, resetData, seedTenant, shutdown, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('mfa-co', { amy: ['Accountant'], vic: ['Viewer'] });
});
afterAll(shutdown);

const code = (secret: string, offset = 0) => hotp(base32Decode(secret), stepOf() + offset);
const cookieOf = (r: { headers: Record<string, unknown> }) => ((r.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('erp_refresh='));

async function enroll(tok: string) {
  const setup = await api.post('/api/v1/auth/2fa/setup').set(auth(tok)).send({});
  const secret = setup.body.secret as string;
  const enable = await api.post('/api/v1/auth/2fa/enable').set(auth(tok)).send({ code: code(secret) });
  return { secret, setup, enable };
}
const tokenOf = async (user = 'amy') => (await loginAs(api, t, user)).body.access_token as string;

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the published SHA-1 test vectors', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const k = base32Decode(secret);
    expect(hotp(k, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(k, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(k, Math.floor(20000000000 / 30), 8)).toBe('65353130');
  });
  it('accepts one step of drift, rejects older codes and replays', () => {
    const now = 1_700_000_000_000;
    const at = (offset: number) => hotp(base32Decode(secret), stepOf(now) + offset);
    expect(verifyTotp(secret, at(0), now)).toBe(stepOf(now));
    expect(verifyTotp(secret, at(-1), now)).toBe(stepOf(now) - 1);
    expect(verifyTotp(secret, at(1), now)).toBe(stepOf(now) + 1);
    expect(verifyTotp(secret, at(-2), now)).toBeNull();
    expect(verifyTotp(secret, at(0), now, stepOf(now))).toBeNull(); // already used
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
  it('base32 round-trips', () => {
    for (const n of [1, 5, 20, 33]) { const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 256)); expect(base32Decode(base32Encode(b)).equals(b)).toBe(true); }
  });
});

describe('enrolment (US-023)', () => {
  it('shows the secret once, keeps it encrypted, and returns recovery codes after a correct code', async () => {
    const tok = await tokenOf();
    const setup = await api.post('/api/v1/auth/2fa/setup').set(auth(tok)).send({});
    expect(setup.status).toBe(200);
    expect(setup.body.otpauth_url).toContain('otpauth://totp/ERPatio:');
    const stored = (await owner.query('SELECT totp_secret_enc FROM users WHERE email = $1', [t.users.amy!.email])).rows[0].totp_secret_enc as string;
    expect(stored.startsWith('enc1.')).toBe(true);
    expect(stored).not.toContain(setup.body.secret);
    expect((await api.post('/api/v1/auth/2fa/enable').set(auth(tok)).send({ code: '000000' })).body.error.code).toBe('invalid_code');
    const ok = await api.post('/api/v1/auth/2fa/enable').set(auth(tok)).send({ code: code(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(8);
    const hashes = (await owner.query('SELECT totp_recovery_hashes FROM users WHERE email = $1', [t.users.amy!.email])).rows[0].totp_recovery_hashes as string[];
    expect(hashes).toHaveLength(8);
    expect(hashes.join('')).not.toContain(ok.body.recovery_codes[0].replace('-', ''));
    expect((await api.post('/api/v1/auth/2fa/setup').set(auth(tok)).send({})).body.error.code).toBe('already_enabled');
  });

  it('is not available in the shared demo workspace', async () => {
    const demo = await seedTenant('demo-mfa', { dee: ['DemoUser'] }, true);
    const tok = (await loginAs(api, demo, 'dee')).body.access_token as string;
    expect((await api.post('/api/v1/auth/2fa/setup').set(auth(tok)).send({})).body.error.code).toBe('demo_restricted');
  });
});

describe('signing in with a second factor', () => {
  async function enrolled() {
    const tok = await tokenOf();
    const { secret, enable } = await enroll(tok);
    return { secret, recovery: enable.body.recovery_codes as string[] };
  }

  it('the password step returns a step token and no session; the code completes it', async () => {
    const { secret } = await enrolled();
    const step1 = await loginAs(api, t, 'amy');
    expect(step1.status).toBe(200);
    expect(step1.body.mfa_required).toBe(true);
    expect(step1.body.access_token).toBeUndefined();
    expect(cookieOf(step1)).toBeUndefined();
    const step2 = await api.post('/api/v1/auth/login/mfa').send({ mfa_token: step1.body.mfa_token, code: code(secret, 1) });
    expect(step2.status).toBe(200);
    expect(step2.body.user.mfa_enabled).toBe(true);
    expect(cookieOf(step2)).toMatch(/HttpOnly/i);
    expect((await api.get('/api/v1/accounts').set(auth(step2.body.access_token))).status).toBe(200);
  });

  it('a code cannot be used twice, and a wrong one is refused', async () => {
    const { secret } = await enrolled();
    const c = code(secret, 1);
    const a = await loginAs(api, t, 'amy');
    expect((await api.post('/api/v1/auth/login/mfa').send({ mfa_token: a.body.mfa_token, code: c })).status).toBe(200);
    const b = await loginAs(api, t, 'amy');
    const replay = await api.post('/api/v1/auth/login/mfa').send({ mfa_token: b.body.mfa_token, code: c });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('invalid_code');
    expect((await api.post('/api/v1/auth/login/mfa').send({ mfa_token: b.body.mfa_token, code: '111111' })).status).toBe(401);
  });

  it('the step token cannot act as an access token, and a forged one is refused', async () => {
    await enrolled();
    const step = await loginAs(api, t, 'amy');
    expect((await api.get('/api/v1/accounts').set(auth(step.body.mfa_token))).status).toBe(401);
    expect((await api.get('/api/v1/auth/me').set(auth(step.body.mfa_token))).status).toBe(401);
    expect((await api.post('/api/v1/auth/login/mfa').send({ mfa_token: 'x'.repeat(40), code: '123456' })).status).toBe(401);
  });

  it('wrong codes count towards lock-out like wrong passwords', async () => {
    const { secret } = await enrolled();
    for (let i = 0; i < 5; i++) {
      const s = await loginAs(api, t, 'amy');
      expect((await api.post('/api/v1/auth/login/mfa').send({ mfa_token: s.body.mfa_token, code: '000000' })).status).toBe(401);
    }
    const locked = await loginAs(api, t, 'amy');
    expect(locked.status).toBe(401); // locked: even the first step now refuses
    const actions = (await owner.query('SELECT action FROM audit_log')).rows.map((r) => r.action);
    expect(actions).toContain('auth.account_locked');
    expect(secret.length).toBeGreaterThan(10);
  });

  it('a recovery code works once', async () => {
    const { recovery } = await enrolled();
    const a = await loginAs(api, t, 'amy');
    expect((await api.post('/api/v1/auth/login/mfa').send({ mfa_token: a.body.mfa_token, code: recovery[0] })).status).toBe(200);
    const b = await loginAs(api, t, 'amy');
    expect((await api.post('/api/v1/auth/login/mfa').send({ mfa_token: b.body.mfa_token, code: recovery[0] })).status).toBe(401);
    const c = await loginAs(api, t, 'amy');
    expect((await api.post('/api/v1/auth/login/mfa').send({ mfa_token: c.body.mfa_token, code: recovery[1] })).status).toBe(200);
    expect((await owner.query("SELECT 1 FROM audit_log WHERE action = 'auth.recovery_code_used'")).rowCount).toBe(2);
  });

  it('turning it off needs the password and a code', async () => {
    const { secret } = await enrolled();
    const s = await api.post('/api/v1/auth/login/mfa').send({ mfa_token: (await loginAs(api, t, 'amy')).body.mfa_token, code: code(secret, 1) });
    const tok = s.body.access_token as string;
    expect((await api.post('/api/v1/auth/2fa/disable').set(auth(tok)).send({ password: 'wrong-password-123', code: code(secret, 1) })).status).toBe(403);
    expect((await api.post('/api/v1/auth/2fa/disable').set(auth(tok)).send({ password: PASSWORD, code: '000000' })).status).toBe(422);
    expect((await api.post('/api/v1/auth/2fa/disable').set(auth(tok)).send({ password: PASSWORD, code: code(secret, 1) })).status).toBe(200);
    expect((await loginAs(api, t, 'amy')).body.mfa_required).toBeUndefined();
  });
});

describe('mandatory two-factor for chosen roles (FR-AUT-04)', () => {
  it('blocks the app until enrolled, then lets the person through and forbids turning it off', async () => {
    const strict = await seedTenant('strict-co', { sam: ['Accountant'], vic: ['Viewer'] }, false, { mfaRequiredRoles: ['Accountant'] });
    const login = await loginAs(api, strict, 'sam');
    expect(login.body.user.mfa_enrollment_required).toBe(true);
    const tok = login.body.access_token as string;
    expect((await api.get('/api/v1/accounts').set(auth(tok))).body.error.code).toBe('mfa_enrollment_required');
    expect((await api.post('/api/v1/journal-entries').set(auth(tok)).send({})).body.error.code).toBe('mfa_enrollment_required');
    const setup = await api.post('/api/v1/auth/2fa/setup').set(auth(tok)).send({});
    const enable = await api.post('/api/v1/auth/2fa/enable').set(auth(tok)).send({ code: code(setup.body.secret) });
    expect((await api.get('/api/v1/accounts').set(auth(enable.body.access_token))).status).toBe(200);
    const disable = await api.post('/api/v1/auth/2fa/disable').set(auth(enable.body.access_token)).send({ password: PASSWORD, code: code(setup.body.secret, 1) });
    expect(disable.body.error.code).toBe('mfa_required');
    // a role that is not on the list is not forced
    const viewer = await loginAs(api, strict, 'vic');
    expect(viewer.body.user.mfa_enrollment_required).toBe(false);
    expect((await api.get('/api/v1/accounts').set(auth(viewer.body.access_token))).status).toBe(200);
  });
});

describe('sessions (US-122)', () => {
  it('lists where you are signed in, marks the current one, and signs others out', async () => {
    const a = await loginAs(api, t, 'amy');
    const b = await loginAs(api, t, 'amy');
    const list = await api.get('/api/v1/auth/sessions').set(auth(a.body.access_token));
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.find((s: { current: boolean }) => !s.current) as { id: string };
    expect((await api.delete(`/api/v1/auth/sessions/${other.id}`).set(auth(a.body.access_token))).status).toBe(204);
    const bCookie = cookieOf(b)!.split(';')[0]!;
    expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', bCookie)).status).toBe(401);
    expect((await api.delete(`/api/v1/auth/sessions/${other.id}`).set(auth(a.body.access_token))).status).toBe(404);
  });

  it('cannot see or revoke someone else\'s session', async () => {
    const amy = await loginAs(api, t, 'amy');
    const vic = await loginAs(api, t, 'vic');
    const mine = (await api.get('/api/v1/auth/sessions').set(auth(amy.body.access_token))).body[0] as { id: string };
    expect((await api.get('/api/v1/auth/sessions').set(auth(vic.body.access_token))).body.map((s: { id: string }) => s.id)).not.toContain(mine.id);
    expect((await api.delete(`/api/v1/auth/sessions/${mine.id}`).set(auth(vic.body.access_token))).status).toBe(404);
  });

  it('sign out everywhere ends every session', async () => {
    const a = await loginAs(api, t, 'amy');
    const b = await loginAs(api, t, 'amy');
    const r = await api.post('/api/v1/auth/sessions/revoke-all').set(auth(a.body.access_token)).send({});
    expect(r.body.revoked).toBe(2);
    for (const x of [a, b]) expect((await api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', cookieOf(x)!.split(';')[0]!)).status).toBe(401);
  });
});

describe('concurrent refresh grace window (F-03)', () => {
  it('a second tab refreshing at the same moment is answered without signing anyone out', async () => {
    const login = await loginAs(api, t, 'amy');
    const old = cookieOf(login)!.split(';')[0]!;
    const refresh = (c: string) => api.post('/api/v1/auth/refresh').set('X-Requested-With', 'erpatio').set('Cookie', c);
    const first = await refresh(old);
    expect(first.status).toBe(200);
    const fresh = cookieOf(first)!.split(';')[0]!;
    const second = await refresh(old); // the same, just-rotated cookie, from another tab
    expect(second.status).toBe(200);
    expect(second.body.access_token).toBeTruthy();
    expect(cookieOf(second)).toBeUndefined(); // the browser already holds the newer cookie
    expect((await refresh(fresh)).status).toBe(200); // and the chain is still alive
  });
});

describe('permission denials are recorded (F-17, US-109)', () => {
  it('writes an audit event with the permission and route, never the body', async () => {
    const vic = await loginAs(api, t, 'vic');
    expect((await api.post('/api/v1/journal-entries').set(auth(vic.body.access_token)).send({ secret_note: 'do-not-log' })).status).toBe(403);
    let rows: { detail: Record<string, string> }[] = [];
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      rows = (await owner.query("SELECT detail FROM audit_log WHERE action = 'security.permission_denied'")).rows;
      if (!rows.length) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows[0]!.detail).toEqual({ permission: 'journal:post', method: 'POST', path: '/journal-entries' });
    expect(JSON.stringify(rows)).not.toContain('do-not-log');
  });
});
