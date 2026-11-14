/** Year-end close: moves the year's revenue and expense into retained earnings with one flagged journal entry. */
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { insertEntry } from '../ledger/service.js';

async function plan(c: PoolClient, tenantId: string, year: number) {
  const status = (await c.query<{ n: number; open_drafts: number }>(
    `SELECT count(*)::int AS n,
            (SELECT count(*)::int FROM journal_drafts WHERE entry_date BETWEEN make_date($2, 1, 1) AND make_date($2, 12, 31)) AS open_drafts
       FROM fiscal_periods WHERE tenant_id = $1 AND year = $2`, [tenantId, year])).rows[0]!;
  if (status.n === 0) throw new ApiError(404, 'not_found', `Fiscal year ${year} does not exist.`);
  const closed = (await c.query<{ id: string }>('SELECT id FROM journal_entries WHERE tenant_id = $1 AND closing_year = $2', [tenantId, year])).rows[0];
  const re = (await c.query<{ re_account_id: string | null }>('SELECT re_account_id FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0]?.re_account_id;
  const rows = (await c.query<{ account_id: string; code: string; name: string; type: string; d: string; c: string }>(
    `SELECT a.id AS account_id, a.code, a.name, a.type, sum(l.debit)::text AS d, sum(l.credit)::text AS c
       FROM accounts a
       JOIN journal_lines l ON l.account_id = a.id AND l.tenant_id = a.tenant_id
       JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
        AND e.entry_date BETWEEN make_date($2, 1, 1) AND make_date($2, 12, 31) AND e.closing_year IS NULL
      WHERE a.tenant_id = $1 AND a.type IN ('revenue', 'expense')
      GROUP BY a.id, a.code, a.name, a.type ORDER BY a.code`, [tenantId, year])).rows;
  // Debit-positive balance per account; closing flips each to zero.
  const accounts = rows.map((r) => ({ ...r, net: toUnits(r.d) - toUnits(r.c) })).filter((r) => r.net !== 0n);
  const profit = -accounts.reduce((s, r) => s + r.net, 0n); // credits exceed debits => profit
  return { accounts, profit, re, closed: closed?.id ?? null, openDrafts: status.open_drafts };
}

export const closingPreview = (p: Principal, year: number) =>
  withTenant(p.tenantId, async (c) => {
    const x = await plan(c, p.tenantId, year);
    return {
      year, already_closed: !!x.closed, open_drafts: x.openDrafts, net_income: fromUnits(x.profit),
      accounts: x.accounts.map((a) => ({ account_id: a.account_id, code: a.code, name: a.name, type: a.type, balance: fromUnits(a.net < 0n ? -a.net : a.net), side: a.net < 0n ? 'credit' : 'debit' })),
    };
  });

export const closeYear = (p: Principal, year: number, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    // One close at a time per workspace: the counter row lock also serialises this against postings.
    await c.query('SELECT 1 FROM tenant_counters WHERE tenant_id = $1 FOR UPDATE', [p.tenantId]);
    const x = await plan(c, p.tenantId, year);
    if (x.closed) throw new ApiError(409, 'year_closed', `Fiscal year ${year} has already been closed.`);
    if (x.openDrafts > 0) throw new ApiError(409, 'unposted_drafts', 'Post or delete the draft entries dated in this year first.');
    if (!x.re) throw new ApiError(409, 'no_retained_earnings', 'Choose a retained-earnings account in settings first.');
    if (x.accounts.length === 0) throw new ApiError(422, 'nothing_to_close', `Fiscal year ${year} has no revenue or expense to close.`);

    const lines = x.accounts.map((a) => ({
      account_id: a.account_id, debit: a.net < 0n ? fromUnits(-a.net) : '0', credit: a.net > 0n ? fromUnits(a.net) : '0', memo: `Close ${a.code}`,
    }));
    if (x.profit !== 0n)
      lines.push({ account_id: x.re, debit: x.profit < 0n ? fromUnits(-x.profit) : '0', credit: x.profit > 0n ? fromUnits(x.profit) : '0', memo: `Fiscal ${year} result` });
    const id = await insertEntry(c, p, {
      entry_date: `${year}-12-31`, description: `Year-end close ${year}`, reference: `CLOSE-${year}`, lines,
    }, ip, null, { closingYear: year, detail: { closing_year: year } });
    await recordAudit(c, { tenantId: p.tenantId, action: 'fiscal_year.closed', actorUserId: p.userId, entityType: 'journal_entry', entityId: id, ip, detail: { year, net_income: fromUnits(x.profit) } });
    return { year, journal_entry_id: id, net_income: fromUnits(x.profit), accounts_closed: x.accounts.length };
  });
