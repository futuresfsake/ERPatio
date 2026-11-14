/** Financial statements (FR-FIN-12, US-040). Amounts are computed in integer units from the ledger. */
import { withTenant } from '../../db/pool.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';

interface Sums {
  account_id: string;
  code: string;
  name: string;
  type: string;
  d: string;
  c: string;
}

interface Line {
  account_id: string;
  code: string;
  name: string;
  amount: string;
}

const sumUnits = (rows: { amount: bigint }[]) => rows.reduce((s, r) => s + r.amount, 0n);

function toLines(rows: { s: Sums; amount: bigint }[]): Line[] {
  return rows.map((r) => ({ account_id: r.s.account_id, code: r.s.code, name: r.s.name, amount: fromUnits(r.amount) }));
}

export const incomeStatement = (p: Principal, from: string, to: string) =>
  withTenant(p.tenantId, async (c) => {
    const { rows } = await c.query<Sums>(
      `SELECT a.id AS account_id, a.code, a.name, a.type, sum(l.debit)::text AS d, sum(l.credit)::text AS c
         FROM accounts a
         JOIN journal_lines l ON l.account_id = a.id AND l.entry_date BETWEEN $1 AND $2 AND NOT l.closing
        WHERE a.type IN ('revenue', 'expense')
        GROUP BY a.id, a.code, a.name, a.type
        ORDER BY a.code`,
      [from, to],
    );
    const revenue = rows.filter((s) => s.type === 'revenue').map((s) => ({ s, amount: toUnits(s.c) - toUnits(s.d) }));
    const expenses = rows.filter((s) => s.type === 'expense').map((s) => ({ s, amount: toUnits(s.d) - toUnits(s.c) }));
    const tr = sumUnits(revenue);
    const te = sumUnits(expenses);
    return {
      from,
      to,
      revenue: { rows: toLines(revenue), total: fromUnits(tr) },
      expenses: { rows: toLines(expenses), total: fromUnits(te) },
      net_income: fromUnits(tr - te),
    };
  });

export const balanceSheet = (p: Principal, asOf: string) =>
  withTenant(p.tenantId, async (c) => {
    const { rows } = await c.query<Sums>(
      `SELECT a.id AS account_id, a.code, a.name, a.type, sum(l.debit)::text AS d, sum(l.credit)::text AS c
         FROM accounts a
         JOIN journal_lines l ON l.account_id = a.id AND l.entry_date <= $1
        GROUP BY a.id, a.code, a.name, a.type
        ORDER BY a.code`,
      [asOf],
    );
    const net = (s: Sums) => toUnits(s.d) - toUnits(s.c); // debit-positive
    const assets = rows.filter((s) => s.type === 'asset').map((s) => ({ s, amount: net(s) }));
    const liabilities = rows.filter((s) => s.type === 'liability').map((s) => ({ s, amount: -net(s) }));
    const equity = rows.filter((s) => s.type === 'equity').map((s) => ({ s, amount: -net(s) }));
    // After a year-end close the closed years' result sits in retained earnings and their revenue and expense net to zero,
    // so this is the current open year's result only.
    const earnings = -rows.filter((s) => s.type === 'revenue' || s.type === 'expense').reduce((acc, s) => acc + net(s), 0n);
    const ta = sumUnits(assets);
    const tl = sumUnits(liabilities);
    const te = sumUnits(equity) + earnings;
    return {
      as_of: asOf,
      assets: { rows: toLines(assets), total: fromUnits(ta) },
      liabilities: { rows: toLines(liabilities), total: fromUnits(tl) },
      equity: { rows: toLines(equity), earnings: fromUnits(earnings), total: fromUnits(te) },
      balanced: ta === tl + te,
    };
  });
