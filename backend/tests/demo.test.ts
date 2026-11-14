import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_SLUG, seedDemo } from '../scripts/seed-demo.js';
import { accountIds, auth, entry, newApi, owner, resetData, seedTenant, shutdown, type Api } from './helpers.js';

let api: Api;
beforeAll(async () => {
  await resetData();
  api = newApi();
});
afterEach(() => {
  process.env.DEMO_MAX_ENTRIES = '100';
  resetEnvCache();
});
afterAll(shutdown);

const loginDemo = () => api.post('/api/v1/auth/login').send({ workspace: DEMO_SLUG, email: DEMO_EMAIL, password: DEMO_PASSWORD });

describe('public demo workspace (ADR-008)', () => {
  it('seeds a balanced ledger and lets the published credentials sign in', async () => {
    expect(await seedDemo(false)).toMatch(/ready with 14 journal entries/);
    const login = await loginDemo();
    expect(login.status).toBe(200);
    expect(login.body.user.roles).toEqual(['DemoUser']);
    const tb = await api.get('/api/v1/reports/trial-balance').set(auth(login.body.access_token));
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.total_debit).not.toBe('0.0000');
    expect((await api.get('/api/v1/audit-log').set(auth(login.body.access_token))).status).toBe(200);
  });

  it('is idempotent, and --reset restores the known state', async () => {
    expect(await seedDemo(false)).toMatch(/already present/);
    const tok = (await loginDemo()).body.access_token as string;
    const acc = await accountIds((await owner.query("SELECT id FROM tenants WHERE slug = $1", [DEMO_SLUG])).rows[0].id);
    await api.post('/api/v1/journal-entries').set(auth(tok)).send(entry(acc));
    expect((await api.get('/api/v1/journal-entries').set(auth(tok))).body.total).toBe(15);

    expect(await seedDemo(true)).toMatch(/ready/);
    const tok2 = (await loginDemo()).body.access_token as string;
    expect((await api.get('/api/v1/journal-entries').set(auth(tok2))).body.total).toBe(14);
    // append-only triggers are back in force after the maintenance reset
    await expect(owner.query('DELETE FROM journal_entries')).rejects.toThrow(/append-only/);
  });

  it('caps the number of entries visitors can add', async () => {
    process.env.DEMO_MAX_ENTRIES = '14';
    resetEnvCache();
    const tok = (await loginDemo()).body.access_token as string;
    const acc = await accountIds((await owner.query("SELECT id FROM tenants WHERE slug = $1", [DEMO_SLUG])).rows[0].id);
    const r = await api.post('/api/v1/journal-entries').set(auth(tok)).send(entry(acc));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('demo_limit');
  });

  it('refuses to reset a non-demo tenant that has the demo slug', async () => {
    await resetData();
    await seedTenant(DEMO_SLUG, { x: ['Viewer'] }, false);
    await expect(seedDemo(true)).rejects.toThrow(/not a demo tenant/);
    expect((await owner.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n).toBe(1);
  });
});
