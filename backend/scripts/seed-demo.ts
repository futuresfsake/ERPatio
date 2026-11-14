/**
 * Create (or reset) the public demo workspace with synthetic data only (FR-PRV-12, ADR-008).
 *
 *   npm run seed:demo             # create if missing
 *   npm run seed:demo -- --reset  # wipe the demo tenant and recreate it
 *
 * `--reset` only ever touches a tenant whose is_demo flag is true. Uses DATABASE_URL_DIRECT (owner
 * role) when set, otherwise DATABASE_URL.
 */
import 'dotenv/config';
import { getEnv } from '../src/config/env.js';
import { closePool, createPool, withTenant } from '../src/db/pool.js';
import { DEMO_ROLE, SYSTEM_ROLES } from '../src/lib/permissions.js';
import { createUser, provisionTenant } from '../src/modules/tenants/provision.js';
import { postEntry } from '../src/modules/ledger/service.js';
import * as sub from '../src/modules/subledger/service.js';
import * as stk from '../src/modules/stock/service.js';
import * as prd from '../src/modules/production/service.js';
import * as hcm from '../src/modules/hcm/service.js';
import { randomBytes } from 'node:crypto';
import type { Principal } from '../src/lib/security.js';

export const DEMO_SLUG = 'casa-verde-demo';
export const DEMO_NAME = 'Casa Verde Trading Corp. (Demo)';
export const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'demo@erpatio.app';
// Published on the login page on purpose: this workspace holds synthetic data only (ADR-008).
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'ERPatio-Demo-2026';

// [days ago, description, reference, [account code, debit, credit][]]
const ENTRIES: [number, string, string, [string, string, string][]][] = [
  [90, 'Owner capital investment', 'CAP-001', [['1010', '1000000', '0'], ['3000', '0', '1000000']]],
  [88, 'Purchase of delivery van', 'FA-001', [['1500', '250000', '0'], ['1010', '0', '250000']]],
  [85, 'Inventory purchase on credit', 'PO-1001', [['1200', '400000', '0'], ['2000', '0', '400000']]],
  [60, 'Sale on account - Santos Hardware', 'INV-2001', [['1100', '336000', '0'], ['4000', '0', '300000'], ['2100', '0', '36000']]],
  [60, 'Cost of goods sold - INV-2001', 'INV-2001', [['5000', '180000', '0'], ['1200', '0', '180000']]],
  [45, 'Customer payment - Santos Hardware', 'OR-3001', [['1010', '336000', '0'], ['1100', '0', '336000']]],
  [40, 'Supplier payment - PO-1001', 'CHK-0101', [['2000', '200000', '0'], ['1010', '0', '200000']]],
  [30, 'Office rent', 'RENT-10', [['6000', '45000', '0'], ['1010', '0', '45000']]],
  [30, 'Payroll', 'PAY-10', [['6100', '120000', '0'], ['1010', '0', '120000']]],
  [20, 'Cash sale - walk-in', 'INV-2002', [['1000', '112000', '0'], ['4000', '0', '100000'], ['2100', '0', '12000']]],
  [20, 'Cost of goods sold - INV-2002', 'INV-2002', [['5000', '60000', '0'], ['1200', '0', '60000']]],
  [10, 'Electricity and water', 'UTIL-10', [['6200', '8500', '0'], ['1010', '0', '8500']]],
  [5, 'Office supplies', 'PC-0005', [['6300', '3200', '0'], ['1000', '0', '3200']]],
  [2, 'Cash deposit to bank', 'DEP-0002', [['1010', '100000', '0'], ['1000', '0', '100000']]],
];

const isoDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

export async function seedDemo(reset: boolean): Promise<string> {
  const env = getEnv();
  const owner = createPool(env.DATABASE_URL_DIRECT ?? env.DATABASE_URL, 2);
  const c = await owner.connect();
  let tenantId: string;
  let userId: string;
  let approverId: string;
  try {
    await c.query('BEGIN');
    const existing = (await c.query<{ id: string; is_demo: boolean }>('SELECT id, is_demo FROM tenants WHERE slug = $1', [DEMO_SLUG])).rows[0];
    if (existing && !existing.is_demo) throw new Error(`Tenant '${DEMO_SLUG}' exists and is not a demo tenant; refusing to touch it.`);
    if (existing && !reset) {
      await c.query('ROLLBACK');
      return `demo tenant already present; use --reset to recreate`;
    }
    if (existing) {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [existing.id]);
      // Append-only triggers are lifted for this one maintenance transaction, demo tenant only.
      const guarded = ['audit_log', 'journal_lines', 'journal_entries'];
      const subledger = ['webhook_deliveries', 'webhook_endpoints', 'api_keys', 'usage_monthly', 'payroll_adjustments', 'payslips', 'payroll_runs', 'attendance', 'shifts', 'employees', 'statutory_rules', 'tax_brackets', 'work_order_components', 'work_orders', 'bom_lines', 'boms', 'bank_matches', 'bank_statement_lines', 'credit_applications', 'sales_order_lines', 'sales_orders', 'purchase_order_lines', 'purchase_orders', 'stock_movements', 'item_stock', 'items', 'payment_voids', 'payment_allocations', 'payments', 'document_lines', 'documents', 'parties', 'tax_codes', 'doc_counters'];
      for (const t of [...guarded, 'payments', 'payment_allocations', 'payment_voids', 'stock_movements', 'credit_applications', 'bank_statement_lines', 'bom_lines', 'payslips', 'payroll_adjustments', 'payroll_runs']) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`); // eslint-disable-line no-restricted-syntax
      for (const t of [...subledger, ...guarded, 'journal_draft_lines', 'journal_drafts', 'refresh_tokens', 'email_tokens', 'consents', 'user_roles', 'role_permissions', 'roles', 'fiscal_periods', 'tenant_keys', 'tenant_modules', 'tenant_settings', 'users', 'accounts', 'tenant_counters'])
        await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [existing.id]); // eslint-disable-line no-restricted-syntax
      for (const t of [...guarded, 'payments', 'payment_allocations', 'payment_voids', 'stock_movements', 'credit_applications', 'bank_statement_lines', 'bom_lines', 'payslips', 'payroll_adjustments', 'payroll_runs']) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`); // eslint-disable-line no-restricted-syntax
      await c.query('DELETE FROM tenants WHERE id = $1 AND is_demo', [existing.id]);
    }
    tenantId = await provisionTenant(c, { slug: DEMO_SLUG, name: DEMO_NAME, isDemo: true, modules: ['finance', 'supply_chain', 'production', 'hcm'] });
    userId = await createUser(c, { tenantId, email: DEMO_EMAIL, fullName: 'Demo Accountant', password: DEMO_PASSWORD, roles: [DEMO_ROLE[0]] });
    // A second person who can approve payroll, so the sample run was approved by someone other than its preparer. Nobody can sign in as them.
    approverId = await createUser(c, { tenantId, email: 'payroll-approver@erpatio.app', fullName: 'Payroll Approver', password: randomBytes(24).toString('hex'), roles: ['PayrollApprover'] });
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await owner.end();
  }

  // Post the sample ledger through the real service layer: same rules as production.
  const principal: Principal = { userId, tenantId, roles: [DEMO_ROLE[0]], permissions: DEMO_ROLE[1] };
  const codes = await withTenant(tenantId, async (cl) =>
    new Map((await cl.query<{ id: string; code: string }>('SELECT id, code FROM accounts')).rows.map((r) => [r.code, r.id])),
  );
  for (const [days, description, reference, lines] of ENTRIES) {
    await postEntry(principal, {
      entry_date: isoDaysAgo(days), description, reference,
      lines: lines.map(([code, debit, credit]) => ({ account_id: codes.get(code)!, debit, credit })),
    }, 'seed');
  }

  // Receivables and payables, also through the real service: two invoices (one part-paid, one overdue), a bill, a draft.
  const taxes = await sub.listTaxCodes(principal);
  const tax = (code: string) => taxes.find((t: { code: string }) => t.code === code)!.id as string;
  const cust = (await sub.createParty(principal, 'customer', { code: 'CAFE', name: 'Casa Verde Cafe', terms_days: 30 }, 'seed')).id as string;
  const cust2 = (await sub.createParty(principal, 'customer', { code: 'BAKE', name: 'Maria Bakeshop', terms_days: 15 }, 'seed')).id as string;
  const supp = (await sub.createParty(principal, 'supplier', { code: 'MILL', name: 'Harina Mills', terms_days: 30 }, 'seed')).id as string;
  const line = (account: string, description: string, unit_price: string, code: string) =>
    ({ description, account_id: codes.get(account)!, quantity: '1', unit_price, tax_code_id: tax(code) });
  const i1 = await sub.createDraft(principal, 'invoice', { party_id: cust, doc_date: isoDaysAgo(20), lines: [line('4000', 'Monthly catering', '25000.00', 'OUT12')] }, 'seed');
  await sub.postDocument(principal, 'invoice', i1.id, 'seed');
  const i2 = await sub.createDraft(principal, 'invoice', { party_id: cust2, doc_date: isoDaysAgo(60), lines: [line('4000', 'Wholesale bread order', '8000.00', 'OUT12')] }, 'seed');
  await sub.postDocument(principal, 'invoice', i2.id, 'seed');
  await sub.recordPayment(principal, 'receipt', { party_id: cust, pay_date: isoDaysAgo(5), bank_account_id: codes.get('1010')!, method: 'bank', reference: 'Deposit', allocations: [{ document_id: i1.id, amount: '10000.00' }] }, 'seed');
  const b1 = await sub.createDraft(principal, 'bill', { party_id: supp, doc_date: isoDaysAgo(10), lines: [line('6000', 'Flour and sugar', '12000.00', 'IN12')] }, 'seed');
  await sub.postDocument(principal, 'bill', b1.id, 'seed');
  await sub.createDraft(principal, 'invoice', { party_id: cust, doc_date: isoDaysAgo(1), lines: [line('4000', 'Draft: weekend event', '15000.00', 'OUT12')] }, 'seed');
  // Supply chain: two items, a purchase order received in full, a sales order part-delivered, one still open.
  const flour = (await stk.createItem(principal, { sku: 'FLR-25', name: 'Flour 25kg', uom: 'sack' }, 'seed')).id as string;
  const sugar = (await stk.createItem(principal, { sku: 'SGR-50', name: 'Sugar 50kg', uom: 'sack' }, 'seed')).id as string;
  const open = async (k: 'po' | 'so', data: Parameters<typeof stk.createOrder>[2]) => {
    const o = await stk.createOrder(principal, k, data, 'seed');
    return stk.approveOrder(principal, k, o.id, 'seed');
  };
  const po1 = await open('po', { party_id: supp, order_date: isoDaysAgo(30), lines: [{ item_id: flour, quantity: '100', unit_cost: '950.00' }, { item_id: sugar, quantity: '40', unit_cost: '2300.00' }] });
  await stk.fulfil(principal, 'po', po1.id, { date: isoDaysAgo(28), lines: po1.lines.map((l: { id: string; quantity: string }) => ({ line_id: l.id, quantity: l.quantity })) }, 'seed');
  const so1 = await open('so', { party_id: cust, order_date: isoDaysAgo(12), lines: [{ item_id: flour, quantity: '30', unit_price: '1300.00' }] });
  await stk.fulfil(principal, 'so', so1.id, { date: isoDaysAgo(10), lines: [{ line_id: so1.lines[0].id, quantity: '20' }] }, 'seed');
  await open('po', { party_id: supp, order_date: isoDaysAgo(2), lines: [{ item_id: flour, quantity: '60', unit_cost: '960.00' }] });
  // Production: a loaf made from flour and sugar; one order finished, one released and waiting for materials.
  const loaf = (await stk.createItem(principal, { sku: 'BRD-01', name: 'Bread loaf', uom: 'pc' }, 'seed')).id as string;
  await prd.createBom(principal, { item_id: loaf, output_qty: '100', note: 'Standard loaf', lines: [{ item_id: flour, quantity: '8' }, { item_id: sugar, quantity: '1' }] }, 'seed');
  const w1 = await prd.releaseWorkOrder(principal, (await prd.createWorkOrder(principal, { item_id: loaf, quantity: '500', planned_date: isoDaysAgo(6) }, 'seed')).id, 'seed');
  await prd.issueMaterials(principal, w1.id, { date: isoDaysAgo(5) }, 'seed');
  await prd.completeWorkOrder(principal, w1.id, { date: isoDaysAgo(4), quantity: '500', conversion_cost: '3200.00' }, 'seed');
  await prd.releaseWorkOrder(principal, (await prd.createWorkOrder(principal, { item_id: loaf, quantity: '300', planned_date: isoDaysAgo(0) }, 'seed')).id, 'seed');
  // People and payroll for last month: three employees, a month of attendance, a run prepared by the demo user, approved and paid by the approver.
  const approver: Principal = { userId: approverId, tenantId, roles: ['PayrollApprover'], permissions: SYSTEM_ROLES.PayrollApprover! };
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const hire = ymd(new Date(Date.UTC(first.getUTCFullYear() - 1, 0, 6)));
  const emp = async (full_name: string, pay_type: 'monthly' | 'daily' | 'hourly', rate: string, department: string) =>
    (await hcm.createEmployee(principal, { full_name, hire_date: hire, pay_type, rate, department, position: department }, 'seed')).id as string;
  const [ana, ben, cora] = [await emp('Ana Reyes', 'monthly', '28000', 'Office'), await emp('Ben Cruz', 'daily', '800', 'Bakery'), await emp('Cora Diaz', 'hourly', '150', 'Delivery')];
  const shift = (await hcm.createShift(principal, { code: 'DAY', name: 'Day shift', start_time: '08:00', end_time: '17:00', break_minutes: 60 }, 'seed')).id as string;
  for (let d = new Date(first); d <= last; d = new Date(d.getTime() + 86_400_000)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const day = ymd(d);
    const late = d.getUTCDate() % 9 === 0;
    for (const e of [ana, ben, cora]) {
      await hcm.recordAttendance(principal, { employee_id: e, work_date: day, status: 'present', shift_id: shift, time_in: '08:00', time_out: late && e !== ana ? '19:00' : '17:00' }, 'seed');
    }
  }
  const pr = await hcm.createRun(principal, { period_start: ymd(first), period_end: ymd(last), pay_date: ymd(last), frequency: 'monthly' }, 'seed');
  await hcm.lockRun(approver, pr.id, 'seed');
  await hcm.payRun(approver, pr.id, codes.get('1010')!, ymd(last), 'seed');
  return `demo tenant '${DEMO_SLUG}' ready with ${ENTRIES.length} journal entries, 4 invoices, bills and receipts, sample stock, production and one paid payroll; sign in as ${DEMO_EMAIL}`;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed-demo.ts')) {
  seedDemo(process.argv.includes('--reset'))
    .then((m) => console.log(m))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => closePool());
}
