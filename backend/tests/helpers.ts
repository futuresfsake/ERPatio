import supertest from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { createUser, provisionTenant } from '../src/modules/tenants/provision.js';
import { TEST_DB } from './config.js';

export const PASSWORD = 'correct-horse-battery';
export const owner = new pg.Pool({ connectionString: TEST_DB, max: 3 });

export async function resetData(): Promise<void> {
  await owner.query('TRUNCATE tenants, tenant_counters, tenant_settings, fiscal_periods, journal_drafts, journal_draft_lines, audit_log, refresh_tokens, user_roles, role_permissions, roles, users, accounts, journal_entries, journal_lines CASCADE');
}

export async function shutdown(): Promise<void> {
  await closePool();
  await owner.end();
}

export interface Seeded {
  tenantId: string;
  slug: string;
  users: Record<string, { id: string; email: string }>;
}

export async function seedTenant(slug: string, users: Record<string, string[]>, isDemo = false): Promise<Seeded> {
  // Fixed years keep the tests independent of the date they run on.
  const fiscalYears = [2025, 2026, 2027];
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const tenantId = await provisionTenant(c, { slug, name: `Tenant ${slug}`, isDemo, fiscalYears });
    const out: Seeded['users'] = {};
    for (const [name, roles] of Object.entries(users)) {
      const email = `${name}@${slug}.test`;
      out[name] = { id: await createUser(c, { tenantId, email, fullName: name, password: PASSWORD, roles }), email };
    }
    await c.query('COMMIT');
    return { tenantId, slug, users: out };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export const newApi = () => supertest(createApp());
export type Api = ReturnType<typeof newApi>;

export async function loginAs(api: Api, t: Seeded, user: string, password = PASSWORD) {
  return api.post('/api/v1/auth/login').send({ workspace: t.slug, email: t.users[user]!.email, password });
}

export async function tokenFor(api: Api, t: Seeded, user: string): Promise<string> {
  const r = await loginAs(api, t, user);
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.access_token as string;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function accountIds(tenantId: string): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ id: string; code: string }>('SELECT id, code FROM accounts WHERE tenant_id = $1', [tenantId]);
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

export const entry = (acc: Record<string, string>, amount = '100.00', date = '2026-11-01') => ({
  entry_date: date,
  description: 'Test entry',
  lines: [
    { account_id: acc['1010']!, debit: amount, credit: '0' },
    { account_id: acc['4000']!, debit: '0', credit: amount },
  ],
});
