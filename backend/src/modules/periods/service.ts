/** Fiscal periods, period close and lock (FR-FIN-06/07) and tenant settings (FR-FIN-05). */
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { monthRanges } from '../../lib/fiscal.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';

export const listPeriods = (p: Principal) =>
  withTenant(p.tenantId, async (c) =>
    (
      await c.query(
        `SELECT fp.id, fp.year, fp.month, fp.start_date, fp.end_date, fp.status, fp.closed_at,
                (SELECT count(*)::int FROM journal_drafts d WHERE d.entry_date BETWEEN fp.start_date AND fp.end_date) AS open_drafts
           FROM fiscal_periods fp ORDER BY fp.year, fp.month`,
      )
    ).rows,
  );

export const createFiscalYear = (p: Principal, year: number, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const exists = await c.query('SELECT 1 FROM fiscal_periods WHERE year = $1 LIMIT 1', [year]);
    if (exists.rowCount) throw new ApiError(409, 'year_exists', `Fiscal year ${year} already exists.`);
    for (const m of monthRanges(year))
      await c.query(
        'INSERT INTO fiscal_periods (tenant_id, year, month, start_date, end_date) VALUES ($1, $2, $3, $4, $5)',
        [p.tenantId, year, m.month, m.start, m.end],
      );
    await recordAudit(c, { tenantId: p.tenantId, action: 'fiscal_year.created', actorUserId: p.userId, ip, detail: { year } });
    return { year, periods: 12 };
  });

interface PeriodRow {
  id: string;
  year: number;
  month: number;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
}

async function lockPeriod(c: import('pg').PoolClient, id: string): Promise<PeriodRow> {
  const row = (
    await c.query<PeriodRow>('SELECT id, year, month, start_date, end_date, status FROM fiscal_periods WHERE id = $1 FOR UPDATE', [id])
  ).rows[0];
  if (!row) throw notFound('Fiscal period');
  return row;
}

export const closePeriod = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const per = await lockPeriod(c, id);
    if (per.status === 'closed') throw new ApiError(409, 'already_closed', 'This period is already closed.');
    // FR-FIN-07: unposted drafts block the close.
    const n = (
      await c.query<{ n: number }>('SELECT count(*)::int AS n FROM journal_drafts WHERE entry_date BETWEEN $1 AND $2', [per.start_date, per.end_date])
    ).rows[0]!.n;
    if (n > 0)
      throw new ApiError(409, 'unposted_drafts', `${n} draft ${n === 1 ? 'entry is' : 'entries are'} dated in this period. Post or delete ${n === 1 ? 'it' : 'them'} first.`);
    await c.query("UPDATE fiscal_periods SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1", [id, p.userId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'period.closed', actorUserId: p.userId, entityType: 'fiscal_period', entityId: id, ip, detail: { year: per.year, month: per.month } });
    return { id, status: 'closed' as const };
  });

export const reopenPeriod = (p: Principal, id: string, reason: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const per = await lockPeriod(c, id);
    if (per.status === 'open') throw new ApiError(409, 'already_open', 'This period is already open.');
    await c.query("UPDATE fiscal_periods SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = $1", [id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'period.reopened', actorUserId: p.userId, entityType: 'fiscal_period', entityId: id, ip, detail: { year: per.year, month: per.month, reason } });
    return { id, status: 'open' as const };
  });

export const getSettings = (p: Principal) =>
  withTenant(p.tenantId, async (c) => {
    const r = await c.query<{ require_approval: boolean }>('SELECT require_approval FROM tenant_settings');
    return { require_approval: r.rows[0]?.require_approval ?? false };
  });

export const updateSettings = (p: Principal, requireApproval: boolean, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, require_approval) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET require_approval = EXCLUDED.require_approval, updated_at = now()`,
      [p.tenantId, requireApproval],
    );
    await recordAudit(c, { tenantId: p.tenantId, action: 'settings.updated', actorUserId: p.userId, ip, detail: { require_approval: requireApproval } });
    return { require_approval: requireApproval };
  });
