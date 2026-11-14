import supertest from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { flushSecurityEvents } from '../src/lib/security-events.js';
import { createUser, provisionTenant } from '../src/modules/tenants/provision.js';
import { TEST_DB } from './config.js';

export const PASSWORD = 'correct-horse-battery';
export const owner = new pg.Pool({ connectionString: TEST_DB, max: 3 });

export async function resetData(): Promise<void> {
  await flushSecurityEvents(); // a late audit write must not race the TRUNCATE
  await owner.query('TRUNCATE tenants, payroll_adjustments, payslips, payroll_runs, tax_brackets, statutory_rules, attendance, shifts, employees, work_order_components, work_orders, bom_lines, boms, bank_matches, bank_statement_lines, credit_applications, sales_order_lines, sales_orders, purchase_order_lines, purchase_orders, stock_movements, item_stock, items, payment_voids, payment_allocations, payments, document_lines, documents, parties, tax_codes, doc_counters, tenant_counters, tenant_settings, tenant_modules, tenant_keys, email_tokens, consents, fiscal_periods, journal_drafts, journal_draft_lines, audit_log, refresh_tokens, user_roles, role_permissions, roles, users, accounts, journal_entries, journal_lines CASCADE');
}

export async function shutdown(): Promise<void> {
  await flushSecurityEvents();
  await closePool();
  await owner.end();
}

export interface Seeded {
  tenantId: string;
  slug: string;
  users: Record<string, { id: string; email: string }>;
}

export async function seedTenant(slug: string, users: Record<string, string[]>, isDemo = false, opts: { mfaRequiredRoles?: string[]; modules?: string[] } = {}): Promise<Seeded> {
  // Fixed years keep the tests independent of the date they run on.
  const fiscalYears = [2025, 2026, 2027];
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const tenantId = await provisionTenant(c, { slug, name: `Tenant ${slug}`, isDemo, fiscalYears, mfaRequiredRoles: opts.mfaRequiredRoles, modules: opts.modules });
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

/** The operator's own workspace with one platform administrator ('opal'). Two-factor is not forced here so tests stay short. */
export async function seedPlatform(): Promise<Seeded> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const tenantId = await provisionTenant(c, { slug: 'platform', name: 'ERPatio platform', modules: [], fiscalYears: [2026] });
    const rid = (await c.query<{ id: string }>("INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, 'PlatformAdmin', true) RETURNING id", [tenantId])).rows[0]!.id;
    await c.query("INSERT INTO role_permissions (role_id, permission, tenant_id) VALUES ($1, 'platform:manage', $2)", [rid, tenantId]);
    const email = 'opal@platform.test';
    const id = await createUser(c, { tenantId, email, fullName: 'opal', password: PASSWORD, roles: ['PlatformAdmin'] });
    await c.query('COMMIT');
    return { tenantId, slug: 'platform', users: { opal: { id, email } } };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
