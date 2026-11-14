import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { blindIndex, decryptField, encryptField, isEncrypted, rewrapTenantKeys } from '../src/lib/crypto.js';
import { withTenant } from '../src/db/pool.js';
import { runRetention } from '../src/modules/privacy/retention.js';
import { accountIds, auth, entry, loginAs, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
beforeAll(() => { api = newApi(); });
beforeEach(resetData);
afterEach(() => {
  delete process.env.MASTER_KEY;
  delete process.env.MASTER_KEY_PREVIOUS;
  resetEnvCache();
});
afterAll(shutdown);

describe('field-level encryption (FR-PRV-02, US-111)', () => {
  let a: Seeded;
  let b: Seeded;
  beforeEach(async () => {
    a = await seedTenant('enc-a', { x: ['Viewer'] });
    b = await seedTenant('enc-b', { y: ['Viewer'] });
  });

  it('round-trips, and the stored value is ciphertext', async () => {
    const enc = await withTenant(a.tenantId, (c) => encryptField(c, a.tenantId, 'TIN 123-456-789'));
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain('123');
    expect(enc.startsWith('enc1.1.')).toBe(true);
    expect(await withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, enc))).toBe('TIN 123-456-789');
    const key = (await owner.query('SELECT wrapped_key, master_kid FROM tenant_keys WHERE tenant_id = $1', [a.tenantId])).rows[0];
    expect(key.wrapped_key.startsWith(key.master_kid + '.')).toBe(true);
  });

  it('the same plaintext encrypts differently each time (random nonce)', async () => {
    const [x, y] = await withTenant(a.tenantId, async (c) => [await encryptField(c, a.tenantId, 'same'), await encryptField(c, a.tenantId, 'same')]);
    expect(x).not.toBe(y);
  });

  it('another tenant cannot read it, and tampering is detected', async () => {
    const enc = await withTenant(a.tenantId, (c) => encryptField(c, a.tenantId, 'secret'));
    await expect(withTenant(b.tenantId, (c) => decryptField(c, b.tenantId, enc))).rejects.toThrow();
    await expect(withTenant(b.tenantId, (c) => decryptField(c, a.tenantId, enc))).rejects.toThrow(); // key rows are hidden by RLS
    const flipped = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + enc.slice(-1);
    await expect(withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, flipped))).rejects.toThrow();
    await expect(withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, 'plain text'))).rejects.toThrow('Not an encrypted field');
  });

  it('concurrent first use creates one key and both values stay readable', async () => {
    const [x, y] = await Promise.all([
      withTenant(a.tenantId, (c) => encryptField(c, a.tenantId, 'one')),
      withTenant(a.tenantId, (c) => encryptField(c, a.tenantId, 'two')),
    ]);
    expect((await owner.query('SELECT count(*)::int AS n FROM tenant_keys WHERE tenant_id = $1', [a.tenantId])).rows[0].n).toBe(1);
    expect(await withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, x))).toBe('one');
    expect(await withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, y))).toBe('two');
  });

  it('a blind index is stable per tenant, case-insensitive, and differs between tenants', () => {
    expect(blindIndex(a.tenantId, 'Jane@Example.com ')).toBe(blindIndex(a.tenantId, 'jane@example.com'));
    expect(blindIndex(a.tenantId, 'jane@example.com')).not.toBe(blindIndex(b.tenantId, 'jane@example.com'));
    expect(blindIndex(a.tenantId, 'a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('master-key rotation: re-wrap the tenant keys, then the old key can be retired (FR-SEC-10)', async () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    process.env.MASTER_KEY = k1;
    resetEnvCache();
    const enc = await withTenant(a.tenantId, (c) => encryptField(c, a.tenantId, 'survives rotation'));

    process.env.MASTER_KEY = k2;
    delete process.env.MASTER_KEY_PREVIOUS;
    resetEnvCache();
    await expect(withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, enc))).rejects.toThrow(/unknown master key/); // old key retired too early

    process.env.MASTER_KEY_PREVIOUS = k1;
    resetEnvCache();
    expect(await withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, enc))).toBe('survives rotation'); // both keys known
    const client = await owner.connect();
    try {
      expect(await rewrapTenantKeys(client)).toBe(1);
      expect(await rewrapTenantKeys(client)).toBe(0); // idempotent
    } finally { client.release(); }

    delete process.env.MASTER_KEY_PREVIOUS;
    resetEnvCache();
    expect(await withTenant(a.tenantId, (c) => decryptField(c, a.tenantId, enc))).toBe('survives rotation'); // only the new key now
  });
});

describe('data-subject export and erasure (FR-PRV-05/06, US-114/115)', () => {
  let t: Seeded;
  let acc: Record<string, string>;
  let ada: string;
  let bob: string;

  beforeEach(async () => {
    t = await seedTenant('priv-co', { ada: ['TenantAdmin'], bob: ['Accountant'], cy: ['Accountant'] });
    acc = await accountIds(t.tenantId);
    ada = await tokenFor(api, t, 'ada');
    bob = await tokenFor(api, t, 'bob');
    await api.post('/api/v1/journal-entries').set(auth(bob)).send(entry(acc, '123.45')).expect(201);
  });

  const tb = async () => (await api.get('/api/v1/reports/trial-balance').query({ as_of: '2099-01-01' }).set(auth(ada))).body;

  it('exports what is held about a person, and audits the export', async () => {
    const r = await api.get(`/api/v1/privacy/subjects/${t.users.bob!.id}/export`).set(auth(ada));
    expect(r.status).toBe(200);
    expect(r.body.person).toMatchObject({ email: 'bob@priv-co.test', full_name: 'bob' });
    expect(r.body.roles).toEqual(['Accountant']);
    expect(r.body.consents).toEqual([]);
    expect(r.body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(r.body.activity.map((a: { action: string }) => a.action)).toContain('journal.posted');
    expect(r.body.authored.journal_entries).toBe(1);
    expect(JSON.stringify(r.body)).not.toMatch(/password_hash|totp_secret/);
    expect((await owner.query("SELECT 1 FROM audit_log WHERE action = 'privacy.exported'")).rowCount).toBe(1);
  });

  it('everyone can export their own data; only managers can export others\'', async () => {
    expect((await api.get('/api/v1/privacy/me/export').set(auth(bob))).body.person.email).toBe('bob@priv-co.test');
    expect((await api.get(`/api/v1/privacy/subjects/${t.users.cy!.id}/export`).set(auth(bob))).status).toBe(403);
    expect((await api.get(`/api/v1/privacy/subjects/${t.users.cy!.id}/export`).set(auth(ada))).status).toBe(200);
  });

  it('cannot export a person from another tenant', async () => {
    const other = await seedTenant('priv-other', { zed: ['Viewer'] });
    expect((await api.get(`/api/v1/privacy/subjects/${other.users.zed!.id}/export`).set(auth(ada))).status).toBe(404);
  });

  it('erasing a person pseudonymises them, clears their addresses, and leaves the ledger untouched', async () => {
    const before = await tb();
    const entries = (await owner.query('SELECT id, created_by, description, entry_no FROM journal_entries')).rows;
    const auditBefore = (await owner.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    expect((await owner.query('SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = $1 AND ip IS NOT NULL', [t.users.bob!.id])).rows[0].n).toBeGreaterThan(0);

    const r = await api.post(`/api/v1/privacy/subjects/${t.users.bob!.id}/erase`).set(auth(ada)).send({});
    expect(r.status).toBe(200);
    expect(r.body.alias).toMatch(/^erased-[0-9a-f]{8}@erased\.invalid$/);

    const u = (await owner.query('SELECT email, full_name, is_active, erased_at, totp_enabled FROM users WHERE id = $1', [t.users.bob!.id])).rows[0];
    expect(u).toMatchObject({ full_name: 'Erased user', is_active: false, totp_enabled: false });
    expect(u.email).toMatch(/@erased\.invalid$/);
    expect(u.erased_at).not.toBeNull();
    expect((await loginAs(api, t, 'bob')).status).toBe(401);

    expect((await owner.query('SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = $1 AND ip IS NOT NULL', [t.users.bob!.id])).rows[0].n).toBe(0);
    expect((await owner.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(auditBefore + 1); // rows kept, one event added
    const rt = (await owner.query('SELECT revoked_at, ip, user_agent FROM refresh_tokens WHERE user_id = $1', [t.users.bob!.id])).rows;
    expect(rt.every((x) => x.revoked_at !== null && x.ip === null && x.user_agent === null)).toBe(true);

    expect(await tb()).toEqual(before); // the ledger totals are unchanged
    expect((await owner.query('SELECT id, created_by, description, entry_no FROM journal_entries')).rows).toEqual(entries);
    const detail = await api.get(`/api/v1/journal-entries/${entries[0].id}`).set(auth(ada));
    expect(detail.status).toBe(200);
  });

  it('drafts and entries by an erased person show the pseudonym', async () => {
    const d = await api.post('/api/v1/journal-drafts').set(auth(bob)).send({ entry_date: '2026-11-02', description: 'wip', lines: [] });
    await api.post(`/api/v1/privacy/subjects/${t.users.bob!.id}/erase`).set(auth(ada)).send({});
    expect((await api.get(`/api/v1/journal-drafts/${d.body.id}`).set(auth(ada))).body.created_by_name).toBe('Erased user');
  });

  it('the audit log stays append-only: erasure mode permits clearing the ip and nothing else', async () => {
    const id = t.users.bob!.id;
    await expect(withTenant(t.tenantId, async (c) => { await c.query("SELECT set_config('app.erasure', 'on', true)"); await c.query("UPDATE audit_log SET action = 'x' WHERE actor_user_id = $1", [id]); })).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(t.tenantId, async (c) => { await c.query("SELECT set_config('app.erasure', 'on', true)"); await c.query('DELETE FROM audit_log WHERE actor_user_id = $1', [id]); })).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(t.tenantId, async (c) => { await c.query('UPDATE audit_log SET ip = NULL WHERE actor_user_id = $1', [id]); })).rejects.toMatchObject({ code: '42501' }); // not in erasure mode
    await expect(withTenant(t.tenantId, async (c) => { await c.query("SELECT set_config('app.erasure', 'on', true)"); await c.query("UPDATE audit_log SET ip = '1.2.3.4' WHERE actor_user_id = $1", [id]); })).rejects.toMatchObject({ code: '42501' }); // only clearing is allowed
    await expect(owner.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
  });

  it('refuses to erase yourself, someone twice, the last administrator, or anyone in the demo', async () => {
    expect((await api.post(`/api/v1/privacy/subjects/${t.users.ada!.id}/erase`).set(auth(ada)).send({})).body.error.code).toBe('not_allowed');
    await api.post(`/api/v1/privacy/subjects/${t.users.cy!.id}/erase`).set(auth(ada)).send({}).expect(200);
    expect((await api.post(`/api/v1/privacy/subjects/${t.users.cy!.id}/erase`).set(auth(ada)).send({})).body.error.code).toBe('already_erased');

    // a delegated privacy manager (a custom role, M1) must still not be able to remove the last administrator
    await owner.query("INSERT INTO role_permissions (role_id, permission, tenant_id) SELECT id, 'privacy:manage', tenant_id FROM roles WHERE name = 'Accountant' AND tenant_id = $1", [t.tenantId]);
    const bob2 = await tokenFor(api, t, 'bob');
    expect((await api.post(`/api/v1/privacy/subjects/${t.users.ada!.id}/erase`).set(auth(bob2)).send({})).body.error.code).toBe('last_admin');

    const demo = await seedTenant('priv-demo', { dee: ['DemoUser'], dan: ['DemoUser'] }, true);
    await owner.query("INSERT INTO role_permissions (role_id, permission, tenant_id) SELECT id, 'privacy:manage', tenant_id FROM roles WHERE name = 'DemoUser' AND tenant_id = $1", [demo.tenantId]);
    const dee = await tokenFor(api, demo, 'dee');
    expect((await api.post(`/api/v1/privacy/subjects/${demo.users.dan!.id}/erase`).set(auth(dee)).send({})).body.error.code).toBe('demo_restricted');
  });
});

describe('retention (FR-PRV-07, US-116)', () => {
  it('removes old technical records only, reports first, and never touches the ledger or audit log', async () => {
    const t = await seedTenant('keep-co', { kim: ['Accountant'] });
    const uid = t.users.kim!.id;
    const rt = (hash: string, expires: string, revoked: string | null) =>
      owner.query('INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at, revoked_at) VALUES ($1, $2, gen_random_uuid(), $3, now() + $4::interval, ' + (revoked ? 'now() + $5::interval' : 'NULL') + ')', revoked ? [t.tenantId, uid, hash, expires, revoked] : [t.tenantId, uid, hash, expires]);
    await rt('old-expired', '-60 days', null);
    await rt('old-revoked', '1 day', '-45 days');
    await rt('fresh', '5 days', null);
    await rt('recently-expired', '-3 days', null);
    const et = (hash: string, expires: string, used: string | null) =>
      owner.query('INSERT INTO email_tokens (tenant_id, user_id, purpose, token_hash, expires_at, used_at) VALUES ($1, $2, \'reset\', $3, now() + $4::interval, ' + (used ? 'now() + $5::interval' : 'NULL') + ')', used ? [t.tenantId, uid, hash, expires, used] : [t.tenantId, uid, hash, expires]);
    await et('mail-old', '-90 days', null);
    await et('mail-used-old', '-1 day', '-40 days');
    await et('mail-fresh', '30 minutes', null);
    const auditBefore = (await owner.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;

    const c = await owner.connect();
    try {
      expect(await runRetention(c, false)).toEqual({ apply: false, refresh_tokens: 2, email_tokens: 2 });
      expect((await owner.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n).toBe(4); // dry run deleted nothing
      expect(await runRetention(c, true)).toMatchObject({ apply: true, refresh_tokens: 2, email_tokens: 2 });
    } finally { c.release(); }
    expect((await owner.query('SELECT token_hash FROM refresh_tokens ORDER BY token_hash')).rows.map((r) => r.token_hash)).toEqual(['fresh', 'recently-expired']);
    expect((await owner.query('SELECT token_hash FROM email_tokens')).rows.map((r) => r.token_hash)).toEqual(['mail-fresh']);
    expect((await owner.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(auditBefore);
  });
});
