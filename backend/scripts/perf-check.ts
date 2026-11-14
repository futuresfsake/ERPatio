/**
 * Performance check on a large synthetic ledger. Builds a throwaway tenant with a lot of data, then times the queries a
 * user waits for (reports, dashboards, lists, aging). Run it against a scratch database, never a real one:
 *
 *   createdb erpatio_perf && DATABASE_URL=... DATABASE_URL_DIRECT=... npm run migrate
 *   DATABASE_URL=... DATABASE_URL_DIRECT=... ENTRIES=100000 npx tsx scripts/perf-check.ts
 *
 * It refuses to run unless the database name contains "perf" or "test". Local timing is not Neon timing: use it to find
 * queries that scale badly (a sequential scan over the ledger), not to promise a latency.
 */
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { createPool, closePool } from '../src/db/pool.js';
import { getEnv } from '../src/config/env.js';
import type { Principal } from '../src/lib/security.js';
import { provisionTenant, createUser } from '../src/modules/tenants/provision.js';
import { executive, inventoryDashboard, profitability } from '../src/modules/bi/service.js';
import { listEntries, trialBalance } from '../src/modules/ledger/service.js';
import { balanceSheet, incomeStatement } from '../src/modules/reports/service.js';
import { aging, listDocuments, vatReport } from '../src/modules/subledger/service.js';
import { valuation } from '../src/modules/stock/service.js';
import { clearCache } from '../src/lib/cache.js';

const env = getEnv();
const url = env.DATABASE_URL_DIRECT ?? env.DATABASE_URL;
const dbName = new URL(url).pathname;
if (!/perf|test/i.test(dbName) || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${new URL(url).hostname}${dbName}: use a local scratch database with "perf" in its name.`);
  process.exit(2);
}
const ENTRIES = Number(process.env.ENTRIES ?? 100_000);

const owner = createPool(url, 2);
const c = await owner.connect();
let tenantId: string;
let userId: string;
try {
  await c.query('BEGIN');
  tenantId = await provisionTenant(c, { slug: `perf-${Date.now() % 100000}`, name: 'Perf Co', fiscalYears: [2025, 2026], modules: ['finance', 'supply_chain', 'production', 'hcm', 'bi'] });
  userId = await createUser(c, { tenantId, email: 'perf@example.test', fullName: 'Perf', password: 'perf-perf-perf-1234', roles: ['TenantAdmin'] });
  await c.query('COMMIT');
} catch (e) { await c.query('ROLLBACK'); throw e; }

const t0 = performance.now();
// Bulk-load straight into the tables. Triggers stay on (period open, balance, append-only), so the data is as real as it gets.
await c.query('BEGIN');
await c.query('SET LOCAL statement_timeout = 0'); // a bulk load is not a request
await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
const acct = (code: string) => c.query<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = $1 AND code = $2', [tenantId, code]).then((r) => r.rows[0]!.id);
const [cash, ar, sales, rent, inv] = [await acct('1010'), await acct('1100'), await acct('4000'), await acct('6000'), await acct('1200')];
await c.query(
  `INSERT INTO journal_entries (id, tenant_id, entry_no, entry_date, description, created_by, posted_by)
   SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, g, date '2025-01-01' + (g % 700), 'Bulk ' || g, $2, $2 FROM generate_series(1, $3::int) g`, [tenantId, userId, ENTRIES]);
await c.query(
  `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, debit, credit)
   SELECT $1, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, l.n,
          CASE WHEN l.n = 1 THEN (ARRAY[$3, $4, $5]::uuid[])[1 + g % 3] ELSE (ARRAY[$6, $7]::uuid[])[1 + g % 2] END,
          CASE WHEN l.n = 1 THEN (g % 997) + 1 ELSE 0 END, CASE WHEN l.n = 2 THEN (g % 997) + 1 ELSE 0 END
     FROM generate_series(1, $2::int) g CROSS JOIN (VALUES (1), (2)) l(n)`, [tenantId, ENTRIES, cash, ar, inv, sales, rent]);
await c.query('UPDATE tenant_counters SET journal_seq = $2 WHERE tenant_id = $1', [tenantId, ENTRIES]);
await c.query('COMMIT');
console.log(`loaded ${ENTRIES} entries in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
await c.query('ANALYZE');
c.release();
await owner.end();

const p: Principal = { userId, tenantId, roles: ['TenantAdmin'], permissions: [], modules: ['finance', 'supply_chain', 'production', 'hcm', 'bi'] };
const rows: [string, number][] = [];
async function time(name: string, fn: () => Promise<unknown>) {
  clearCache();
  const t = performance.now();
  await fn();
  const first = performance.now() - t;
  rows.push([name, first]);
}
await time('trial balance (as of now)', () => trialBalance(p, '2026-12-31'));
await time('income statement (a year)', () => incomeStatement(p, '2025-01-01', '2025-12-31'));
await time('balance sheet', () => balanceSheet(p, '2026-12-31'));
await time('journal list, page 1', () => listEntries(p, 25, 0));
await time('journal list, deep page', () => listEntries(p, 25, Math.floor(ENTRIES / 2)));
await time('receivables aging', () => aging(p, 'invoice', '2026-06-30'));
await time('invoices list', () => listDocuments(p, 'invoice', { limit: 25, offset: 0 }));
await time('tax report', () => vatReport(p, '2025-01-01', '2025-12-31'));
await time('stock valuation', () => valuation(p, '2026-06-30'));
await time('executive dashboard (cold)', () => executive(p));
clearCache();
await executive(p);
const tw = performance.now();
await executive(p);
rows.push(['executive dashboard (warm, cached)', performance.now() - tw]);
await time('inventory dashboard', () => inventoryDashboard(p));
await time('profitability', () => profitability(p, '2025-01-01', '2025-12-31'));
console.log(`\nledger size: ${ENTRIES} entries, ${ENTRIES * 2} lines`);
for (const [name, ms] of rows) console.log(`${ms >= 1000 ? 'SLOW ' : ms >= 300 ? 'slow ' : '     '}${ms.toFixed(0).padStart(6)} ms  ${name}`);
await closePool();
