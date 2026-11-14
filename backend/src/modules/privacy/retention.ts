/**
 * Retention engine (FR-PRV-07, US-116). Removes short-lived technical records past their useful life.
 * Financial records and the audit log are NOT touched here: they follow the statutory period (BRU-PRV-1).
 *
 * Runs on the owner connection across all tenants. The owner needs BYPASSRLS (Neon's default role has it);
 * without it RLS would hide the rows and nothing would be deleted.
 */
import type { PoolClient } from 'pg';

export const RETENTION_DAYS = { refresh_tokens: 30, email_tokens: 30 } as const;

export interface RetentionReport {
  apply: boolean;
  refresh_tokens: number;
  email_tokens: number;
}

export async function runRetention(c: PoolClient, apply: boolean): Promise<RetentionReport> {
  const rt = 'FROM refresh_tokens WHERE (expires_at < now() - make_interval(days => $1)) OR (revoked_at < now() - make_interval(days => $1))';
  const et = 'FROM email_tokens WHERE (used_at < now() - make_interval(days => $1)) OR (expires_at < now() - make_interval(days => $1))';
  const count = async (from: string, days: number) => Number((await c.query<{ n: string }>('SELECT count(*) AS n ' + from, [days])).rows[0]!.n);
  const report: RetentionReport = {
    apply,
    refresh_tokens: await count(rt, RETENTION_DAYS.refresh_tokens),
    email_tokens: await count(et, RETENTION_DAYS.email_tokens),
  };
  if (apply) {
    await c.query('DELETE ' + rt, [RETENTION_DAYS.refresh_tokens]);
    await c.query('DELETE ' + et, [RETENTION_DAYS.email_tokens]);
  }
  return report;
}
