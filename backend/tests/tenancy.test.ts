import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/pool.js';
import { accountIds, auth, entry, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let a: Seeded;
let b: Seeded;
let tokA: string;
let tokB: string;
let accA: Record<string, string>;
let accB: Record<string, string>;
let entryB: string;

beforeAll(async () => {
  await resetData();
  api = newApi();
  a = await seedTenant('tenant-a', { ann: ['Accountant'] });
  b = await seedTenant('tenant-b', { bob: ['Accountant'] });
  tokA = await tokenFor(api, a, 'ann');
  tokB = await tokenFor(api, b, 'bob');
  accA = await accountIds(a.tenantId);
  accB = await accountIds(b.tenantId);
  const r = await api.post('/api/v1/journal-entries').set(auth(tokB)).send(entry(accB));
  entryB = r.body.id;
});
afterAll(shutdown);

describe('cross-tenant leak tests (R-02, T-06): tenant A asking for tenant B ids', () => {
  it('cannot read, reverse or change B\'s records: every id-bearing endpoint answers 404', async () => {
    const probes = [
      api.get(`/api/v1/journal-entries/${entryB}`).set(auth(tokA)),
      api.post(`/api/v1/journal-entries/${entryB}/reverse`).set(auth(tokA)).send({}),
      api.patch(`/api/v1/accounts/${accB['1010']}`).set(auth(tokA)).send({ name: 'pwned' }),
    ];
    for (const r of await Promise.all(probes)) expect(r.status).toBe(404);
    const still = await owner.query('SELECT name FROM accounts WHERE id = $1', [accB['1010']]);
    expect(still.rows[0].name).toBe('Cash in Bank');
  });

  it('list endpoints only ever return the caller\'s rows', async () => {
    const accounts = await api.get('/api/v1/accounts').set(auth(tokA));
    const ids = (accounts.body as { id: string }[]).map((x) => x.id);
    expect(ids.sort()).toEqual(Object.values(accA).sort());
    expect((await api.get('/api/v1/journal-entries').set(auth(tokA))).body.total).toBe(0);
    expect((await api.get('/api/v1/audit-log').set(auth(tokA))).status).toBe(403); // Accountant has no audit:read
  });

  it('cannot post a line against B\'s account', async () => {
    const r = await api.post('/api/v1/journal-entries').set(auth(tokA)).send(entry({ ...accA, '1010': accB['1010']! }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('invalid_account');
  });
});

describe('row-level security enforced by the database itself', () => {
  it('a tenant session sees only its own rows', async () => {
    const n = await withTenant(b.tenantId, async (c) => (await c.query('SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS t FROM accounts')).rows[0]);
    expect(n).toEqual({ n: 22, t: 1 });
  });

  it('a session with no tenant context sees nothing (fail closed)', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE erpatio_app');
      for (const t of ['accounts', 'users', 'journal_entries', 'audit_log', 'refresh_tokens', 'tenants'])
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n).toBe(0); // eslint-disable-line no-restricted-syntax
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('WITH CHECK blocks writing a row that belongs to another tenant', async () => {
    await expect(
      withTenant(a.tenantId, (c) =>
        c.query("INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, 'EVIL', 'x', 'asset')", [b.tenantId])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('composite foreign keys make a cross-tenant reference impossible even for the table owner', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, debit, credit)
           SELECT $1, e.id, 9, $3, 1, 0 FROM journal_entries e WHERE e.id = $2`,
          [a.tenantId, entryB, accB['1010']],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('the application role cannot lift RLS or bypass it', async () => {
    const r = await owner.query("SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'erpatio_app'");
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false, rolcanlogin: false });
    const forced = await owner.query("SELECT relname FROM pg_class WHERE relforcerowsecurity AND relnamespace = 'public'::regnamespace");
    expect(forced.rows.map((x) => x.relname).sort()).toEqual(
      ['accounts', 'audit_log', 'bom_lines', 'boms', 'bank_matches', 'bank_statement_lines', 'credit_applications', 'consents', 'doc_counters', 'item_stock', 'items', 'document_lines', 'documents', 'email_tokens', 'fiscal_periods', 'journal_draft_lines', 'journal_drafts', 'journal_entries', 'journal_lines', 'parties', 'purchase_order_lines', 'purchase_orders', 'sales_order_lines', 'sales_orders', 'stock_movements', 'payment_allocations', 'payment_voids', 'payments', 'refresh_tokens', 'role_permissions', 'roles', 'tax_codes', 'tenant_counters', 'tenant_keys', 'tenant_modules', 'tenant_settings', 'user_roles', 'users', 'work_order_components', 'work_orders'].sort(),
    );
  });
});
