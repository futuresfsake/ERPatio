/**
 * Tenant provisioning (FR-TEN-04, US-031 seed template).
 *
 * Runs on the *owner* connection, never through the API: there is intentionally no public endpoint
 * that creates tenants until email verification (US-120) exists.
 */
import type { PoolClient } from 'pg';
import { ALL_PERMISSIONS, DEMO_ROLE, MODULES, SYSTEM_ROLES } from '../../lib/permissions.js';
import { defaultFiscalYears, monthRanges } from '../../lib/fiscal.js';
import { hashPassword } from '../../lib/security.js';

/** Simplified chart of accounts for a small trading company (Gap G-17: simplified template). */
export const DEFAULT_COA: [code: string, name: string, type: string][] = [
  ['1000', 'Cash on Hand', 'asset'],
  ['1010', 'Cash in Bank', 'asset'],
  ['1100', 'Accounts Receivable', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['1210', 'Work in Progress', 'asset'],
  ['1300', 'Input VAT', 'asset'],
  ['1500', 'Equipment', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['2050', 'Goods Received Not Invoiced', 'liability'],
  ['2100', 'VAT Payable', 'liability'],
  ['3000', "Owner's Capital", 'equity'],
  ['3100', 'Retained Earnings', 'equity'],
  ['4000', 'Sales Revenue', 'revenue'],
  ['4100', 'Other Income', 'revenue'],
  ['5000', 'Cost of Goods Sold', 'expense'],
  ['5100', 'Inventory Adjustments', 'expense'],
  ['5200', 'Conversion Cost Applied', 'expense'],
  ['5300', 'Production Variance', 'expense'],
  ['6000', 'Rent Expense', 'expense'],
  ['6100', 'Salaries Expense', 'expense'],
  ['6200', 'Utilities Expense', 'expense'],
  ['6300', 'Office Supplies Expense', 'expense'],
];

async function setTenant(c: PoolClient, tenantId: string) {
  await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

export async function provisionTenant(
  c: PoolClient,
  o: { slug: string; name: string; isDemo?: boolean; fiscalYears?: number[]; mfaRequiredRoles?: string[]; modules?: string[] },
): Promise<string> {
  const tid = (
    await c.query<{ id: string }>('INSERT INTO tenants (slug, name, is_demo) VALUES ($1, $2, $3) RETURNING id', [o.slug, o.name, o.isDemo ?? false])
  ).rows[0]!.id;
  await setTenant(c, tid);
  await c.query('INSERT INTO tenant_counters (tenant_id) VALUES ($1)', [tid]);
  await c.query('INSERT INTO tenant_settings (tenant_id, mfa_required_roles) VALUES ($1, $2)', [tid, o.mfaRequiredRoles ?? []]);
  const on = new Set(o.modules ?? ['finance']);
  for (const m of MODULES) await c.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES ($1, $2, $3)', [tid, m, on.has(m)]);
  for (const year of o.fiscalYears ?? defaultFiscalYears())
    for (const m of monthRanges(year))
      await c.query('INSERT INTO fiscal_periods (tenant_id, year, month, start_date, end_date) VALUES ($1, $2, $3, $4, $5)', [tid, year, m.month, m.start, m.end]);
  const roles: Record<string, string[]> = { ...SYSTEM_ROLES };
  if (o.isDemo) roles[DEMO_ROLE[0]] = DEMO_ROLE[1];
  for (const [name, perms] of Object.entries(roles)) {
    const rid = (
      await c.query<{ id: string }>('INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, $2, true) RETURNING id', [tid, name])
    ).rows[0]!.id;
    for (const perm of perms.filter((p) => (ALL_PERMISSIONS as string[]).includes(p)))
      await c.query('INSERT INTO role_permissions (role_id, permission, tenant_id) VALUES ($1, $2, $3)', [rid, perm, tid]);
  }
  for (const [code, name, type] of DEFAULT_COA)
    await c.query('INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, $2, $3, $4)', [tid, code, name, type]);
  // Control accounts for the subledgers, the document counters, and the standard Philippine VAT codes.
  await c.query(
    `UPDATE tenant_settings SET
       ar_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '1100'),
       ap_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '2000'),
       re_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '3100'),
       inventory_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '1200'),
       cogs_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '5000'),
       grni_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '2050'),
       adjustment_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '5100'),
       sales_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '4000'),
       wip_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '1210'),
       conversion_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '5200'),
       variance_account_id = (SELECT id FROM accounts WHERE tenant_id = $1 AND code = '5300') WHERE tenant_id = $1`,
    [tid],
  );
  for (const kind of ['invoice', 'bill', 'po', 'so', 'credit_note', 'debit_note', 'wo']) await c.query('INSERT INTO doc_counters (tenant_id, kind) VALUES ($1, $2)', [tid, kind]);
  await c.query(
    `INSERT INTO tax_codes (tenant_id, code, name, rate, kind, account_id)
     SELECT $1, v.code, v.name, 12, v.kind, a.id FROM (VALUES ('OUT12', 'Output VAT 12%', 'output', '2100'), ('IN12', 'Input VAT 12%', 'input', '1300')) v(code, name, kind, acct)
       JOIN accounts a ON a.tenant_id = $1 AND a.code = v.acct`,
    [tid],
  );
  return tid;
}

export async function createUser(
  c: PoolClient,
  o: { tenantId: string; email: string; fullName: string; password: string; roles: string[]; verified?: boolean },
): Promise<string> {
  await setTenant(c, o.tenantId);
  const uid = (
    await c.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, password_hash, email_verified)
       VALUES ($1, lower($2), $3, $4, $5) RETURNING id`,
      [o.tenantId, o.email, o.fullName, await hashPassword(o.password), o.verified ?? true],
    )
  ).rows[0]!.id;
  for (const r of o.roles)
    await c.query(
      'INSERT INTO user_roles (user_id, role_id, tenant_id) SELECT $1, id, $2 FROM roles WHERE tenant_id = $2 AND name = $3',
      [uid, o.tenantId, r],
    );
  return uid;
}
