/**
 * Dashboards and profitability (FR-BI). Figures come from the ledger and the subledgers through the same services the
 * reports use, so a dashboard can never disagree with a report. Sections for modules the workspace has not subscribed to are left out.
 */
import { withTenant } from '../../db/pool.js';
import { cached } from '../../lib/cache.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { aging } from '../subledger/service.js';
import { valuation } from '../stock/service.js';

const TTL = 30_000;
const has = (p: Principal, m: string) => (p.modules ?? ['finance']).includes(m);
const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (iso: string, n: number) => { const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

/** The ledger's position: any posting changes it, which retires cached figures at once. */
const ledgerVersion = (p: Principal) =>
  withTenant(p.tenantId, async (c) => String((await c.query<{ v: string }>('SELECT journal_seq::text AS v FROM tenant_counters WHERE tenant_id = $1', [p.tenantId])).rows[0]?.v ?? '0'));

async function plBetween(p: Principal, from: string, to: string) {
  return withTenant(p.tenantId, async (c) => {
    const r = (await c.query<{ rev: string | null; exp: string | null }>(
      `SELECT sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit END)::text AS rev, sum(CASE WHEN a.type = 'expense' THEN l.debit - l.credit END)::text AS exp
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
         JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id AND e.entry_date BETWEEN $2::date AND $3::date AND e.closing_year IS NULL
        WHERE l.tenant_id = $1 AND a.type IN ('revenue', 'expense')`, [p.tenantId, from, to])).rows[0]!;
    const rev = toUnits(r.rev ?? '0'); const exp = toUnits(r.exp ?? '0');
    return { revenue: fromUnits(rev), expenses: fromUnits(exp), net_income: fromUnits(rev - exp) };
  });
}

export const executive = async (p: Principal) => {
  const version = await ledgerVersion(p);
  return cached(p.tenantId, 'executive', TTL, version, async () => {
    const t = today();
    const year = t.slice(0, 4);
    const monthStart = `${t.slice(0, 7)}-01`;
    const out: Record<string, unknown> = { as_of: t };
    out.cash = await withTenant(p.tenantId, async (c) => {
      const r = (await c.query<{ b: string | null }>(
        `SELECT sum(l.debit - l.credit)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id AND e.entry_date <= $2::date
          WHERE l.tenant_id = $1 AND a.type = 'asset' AND a.code LIKE '10%'`, [p.tenantId, t])).rows[0]!;
      return { balance: fromUnits(toUnits(r.b ?? '0')) };
    });
    out.month = await plBetween(p, monthStart, t);
    out.year = await plBetween(p, `${year}-01-01`, t);
    // Six months of revenue and expense, oldest first, so a chart needs no further call.
    const months: { month: string; revenue: string; expenses: string }[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const start = addMonths(monthStart, -i);
      const end = i === 0 ? t : new Date(Date.parse(addMonths(start, 1)) - 86_400_000).toISOString().slice(0, 10);
      const x = await plBetween(p, start, end);
      months.push({ month: start.slice(0, 7), revenue: x.revenue, expenses: x.expenses });
    }
    out.months = months;
    const ar = await aging(p, 'invoice', t);
    const ap = await aging(p, 'bill', t);
    const overdue = (a: Awaited<ReturnType<typeof aging>>) => fromUnits(toUnits(a.totals.total!) - toUnits(a.totals.current!));
    out.receivables = { open: ar.totals.total, overdue: overdue(ar), customers_owing: ar.rows.length };
    out.payables = { open: ap.totals.total, overdue: overdue(ap), suppliers_owed: ap.rows.length };
    if (has(p, 'supply_chain')) out.inventory = { value: (await valuation(p, t)).total_value };
    return out;
  });
};

export const inventoryDashboard = async (p: Principal) => {
  const version = await ledgerVersion(p);
  return cached(p.tenantId, 'inventory', TTL, version, async () =>
    withTenant(p.tenantId, async (c) => {
      const val = await valuation(p, today());
      const top = [...val.rows].sort((a, b) => (toUnits(b.value) > toUnits(a.value) ? 1 : -1)).slice(0, 10);
      const below = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM items i JOIN item_stock s ON s.item_id = i.id AND s.tenant_id = i.tenant_id WHERE i.tenant_id = $1 AND i.is_active AND i.reorder_level > 0 AND s.qty <= i.reorder_level', [p.tenantId])).rows[0]!.n);
      const open = (await c.query<{ po: string; so: string; po_n: string; so_n: string }>(
        `SELECT COALESCE((SELECT sum(total) FROM purchase_orders WHERE tenant_id = $1 AND status = 'open'), 0)::text AS po, COALESCE((SELECT sum(total) FROM sales_orders WHERE tenant_id = $1 AND status = 'open'), 0)::text AS so,
                (SELECT count(*) FROM purchase_orders WHERE tenant_id = $1 AND status = 'open')::text AS po_n, (SELECT count(*) FROM sales_orders WHERE tenant_id = $1 AND status = 'open')::text AS so_n`, [p.tenantId])).rows[0]!;
      // Movers: what actually left stock in the last 90 days.
      const movers = (await c.query<{ sku: string; name: string; qty: string }>(
        `SELECT i.sku, i.name, (-sum(m.qty))::text AS qty FROM stock_movements m JOIN items i ON i.id = m.item_id AND i.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1 AND m.kind = 'issue' AND m.source_type = 'sales_order' AND m.move_date >= current_date - 90 GROUP BY i.sku, i.name ORDER BY sum(m.qty) LIMIT 5`, [p.tenantId])).rows;
      const stuck = (await c.query<{ sku: string; name: string; value: string }>(
        `SELECT i.sku, i.name, s.value::text FROM items i JOIN item_stock s ON s.item_id = i.id AND s.tenant_id = i.tenant_id
          WHERE i.tenant_id = $1 AND s.qty > 0 AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id AND m.kind = 'issue' AND m.move_date >= current_date - 90)
          ORDER BY s.value DESC LIMIT 5`, [p.tenantId])).rows;
      return {
        as_of: today(), total_value: val.total_value, reconciles: val.reconciles, items_below_reorder: below,
        open_purchase_orders: { count: Number(open.po_n), value: fromUnits(toUnits(open.po)) }, open_sales_orders: { count: Number(open.so_n), value: fromUnits(toUnits(open.so)) },
        top_by_value: top.map((x) => ({ sku: x.sku, name: x.name, qty: x.qty, value: x.value })), fast_movers: movers.map((m) => ({ ...m, qty: fromUnits(toUnits(m.qty)) })),
        no_movement_90_days: stuck.map((s) => ({ ...s, value: fromUnits(toUnits(s.value)) })),
      };
    }));
};

/** Margin by customer (invoices less credit notes) and by item (sales delivered against what the stock cost). */
export const profitability = async (p: Principal, from: string, to: string) => {
  const version = await ledgerVersion(p);
  return cached(p.tenantId, `profit:${from}:${to}`, TTL, version, async () =>
    withTenant(p.tenantId, async (c) => {
      const customers = (await c.query<{ party_id: string; code: string; name: string; invoiced: string; credited: string }>(
        `SELECT p.id AS party_id, p.code, p.name,
                COALESCE(sum(d.subtotal) FILTER (WHERE d.kind = 'invoice'), 0)::text AS invoiced, COALESCE(sum(d.subtotal) FILTER (WHERE d.kind = 'credit_note'), 0)::text AS credited
           FROM documents d JOIN parties p ON p.id = d.party_id AND p.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 AND d.status = 'posted' AND d.kind IN ('invoice', 'credit_note') AND d.doc_date BETWEEN $2::date AND $3::date GROUP BY p.id, p.code, p.name`, [p.tenantId, from, to])).rows
        .map((r) => ({ ...r, net_sales: fromUnits(toUnits(r.invoiced) - toUnits(r.credited)) })).sort((a, b) => (toUnits(b.net_sales) > toUnits(a.net_sales) ? 1 : -1));
      const items = has(p, 'supply_chain') ? (await c.query<{ item_id: string; sku: string; name: string; qty: string; sales: string; cost: string }>(
        `SELECT i.id AS item_id, i.sku, i.name, sum(l.delivered_qty)::text AS qty, sum(l.delivered_qty * l.unit_price)::text AS sales,
                COALESCE((SELECT -sum(m.value) FROM stock_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id AND m.source_type = 'sales_order' AND m.kind IN ('issue', 'return_in') AND m.move_date BETWEEN $2::date AND $3::date), 0)::text AS cost
           FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id AND o.tenant_id = l.tenant_id JOIN items i ON i.id = l.item_id AND i.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1 AND o.order_date BETWEEN $2::date AND $3::date AND l.delivered_qty > 0 GROUP BY i.id, i.sku, i.name`, [p.tenantId, from, to])).rows
        .map((r) => { const s = toUnits(r.sales); const k = toUnits(r.cost); return { ...r, qty: fromUnits(toUnits(r.qty)), sales: fromUnits(s), cost: fromUnits(k), margin: fromUnits(s - k), margin_pct: s === 0n ? null : Number(((s - k) * 10000n) / s) / 100 }; })
        .sort((a, b) => (toUnits(b.margin) > toUnits(a.margin) ? 1 : -1)) : [];
      return { from, to, customers, items };
    }));
};
