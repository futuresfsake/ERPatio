/**
 * Plans, limits and usage metering (FR-TEN-07/08). Usage is counted where it happens: every journal entry bumps the month's
 * counter in the same transaction that posts it, and a plan with a cap refuses the entry that would go over it (402), rolling the
 * posting back whole. There is no payment processor behind this: it meters and limits, and the operator sets the plan.
 */
import type { PoolClient } from 'pg';
import { withOwner, withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';

/** Called by the ledger for every posting. Counts it, and refuses it if the plan's monthly cap is already used up. */
export async function countEntry(c: PoolClient, tenantId: string): Promise<void> {
  const cap = (await c.query<{ m: number | null }>('SELECT pl.max_entries_per_month AS m FROM tenants t JOIN plans pl ON pl.code = t.plan_code WHERE t.id = $1', [tenantId])).rows[0]?.m ?? null;
  const used = (await c.query<{ entries: number }>(
    `INSERT INTO usage_monthly (tenant_id, month, entries) VALUES ($1, date_trunc('month', now())::date, 1)
     ON CONFLICT (tenant_id, month) DO UPDATE SET entries = usage_monthly.entries + 1 RETURNING entries`, [tenantId])).rows[0]!.entries;
  if (cap !== null && used > cap) throw new ApiError(402, 'plan_limit', `Your plan allows ${cap} journal entries a month and this month's allowance is used up. Ask your administrator to change the plan.`);
}

/** Called before a person is added. */
export async function assertUserSlot(c: PoolClient, tenantId: string): Promise<void> {
  const r = (await c.query<{ m: number | null; n: string }>(
    `SELECT pl.max_users AS m, (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active)::text AS n
       FROM tenants t JOIN plans pl ON pl.code = t.plan_code WHERE t.id = $1`, [tenantId])).rows[0];
  if (r && r.m !== null && Number(r.n) >= r.m) throw new ApiError(402, 'plan_limit', `Your plan allows ${r.m} active users. Deactivate someone or ask for a bigger plan.`);
}

export const usage = (p: Principal) =>
  withTenant(p.tenantId, async (c) => {
    const plan = (await c.query<{ code: string; name: string; max_users: number | null; max_entries_per_month: number | null; price_monthly: string }>(
      'SELECT pl.code, pl.name, pl.max_users, pl.max_entries_per_month, pl.price_monthly::text FROM tenants t JOIN plans pl ON pl.code = t.plan_code WHERE t.id = $1', [p.tenantId])).rows[0]!;
    const month = (await c.query<{ entries: number }>("SELECT entries FROM usage_monthly WHERE tenant_id = $1 AND month = date_trunc('month', now())::date", [p.tenantId])).rows[0]?.entries ?? 0;
    const counts = (await c.query<{ users: string; keys: string; hooks: string }>(
      `SELECT (SELECT count(*) FROM users WHERE tenant_id = $1 AND is_active)::text AS users,
              (SELECT count(*) FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::text AS keys,
              (SELECT count(*) FROM webhook_endpoints WHERE tenant_id = $1 AND is_active)::text AS hooks`, [p.tenantId])).rows[0]!;
    const history = (await c.query<{ month: string; entries: number }>("SELECT to_char(month, 'YYYY-MM') AS month, entries FROM usage_monthly WHERE tenant_id = $1 ORDER BY month DESC LIMIT 6", [p.tenantId])).rows;
    return {
      plan: { code: plan.code, name: plan.name, price_monthly: plan.price_monthly },
      limits: { users: plan.max_users, entries_per_month: plan.max_entries_per_month },
      usage: { users: Number(counts.users), entries_this_month: month, api_keys: Number(counts.keys), webhooks: Number(counts.hooks) },
      history: history.reverse(),
    };
  });

export const listPlans = () => withOwner(async (c) => (await c.query('SELECT code, name, max_users, max_entries_per_month, price_monthly::text FROM plans ORDER BY price_monthly, code')).rows);

/** Operator only (checked by the platform module): move a workspace to another plan. Refuses a plan the workspace already exceeds. */
export async function setPlan(operator: Principal, tenantId: string, planCode: string, ip?: string) {
  return withOwner(async (c) => {
    const plan = (await c.query<{ max_users: number | null }>('SELECT max_users FROM plans WHERE code = $1', [planCode])).rows[0];
    if (!plan) throw new ApiError(422, 'invalid_plan', 'That plan does not exist.');
    const t = (await c.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1', [tenantId])).rows[0];
    if (!t) throw notFound('Workspace');
    const users = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM users WHERE tenant_id = $1 AND is_active', [tenantId])).rows[0]!.n);
    if (plan.max_users !== null && users > plan.max_users) throw new ApiError(409, 'over_plan', `This workspace has ${users} active users, more than ${planCode} allows (${plan.max_users}).`);
    await c.query('UPDATE tenants SET plan_code = $2 WHERE id = $1', [tenantId, planCode]);
    await recordAudit(c, { tenantId, action: 'platform.plan_changed', actorUserId: operator.userId, ip, detail: { operator: operator.userId, plan: planCode } });
    return { id: tenantId, plan_code: planCode };
  }, tenantId);
}
