/**
 * Platform operator tools (US-022, FR-TEN-09, T-12). The one place that legitimately crosses tenants, so it is
 * small, audited in the affected tenant's own log, and available only to the operator's own tenant.
 *   - list tenants, suspend or reactivate, switch modules
 *   - a support session: read-only, time-boxed, needs a reason, no refresh token
 */
import { setPlan } from '../billing/service.js';
import { withOwner, withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { MODULES, P } from '../../lib/permissions.js';
import { signAccessToken, type Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';

export const PLATFORM_SLUG = 'platform';
const SUPPORT_PERMISSIONS = [P.ACCOUNTS_READ, P.JOURNAL_READ, P.REPORTS_READ, P.AUDIT_READ];

/** Belt and braces: even with the permission, the caller must belong to the operator's own tenant. */
export async function assertPlatformOperator(p: Principal): Promise<void> {
  const slug = await withTenant(p.tenantId, async (c) => (await c.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [p.tenantId])).rows[0]?.slug);
  if (slug !== PLATFORM_SLUG) throw new ApiError(403, 'forbidden', 'You do not have permission to do that.');
}

async function target(tenantId: string) {
  const t = await withOwner(async (c) => (await c.query<{ id: string; slug: string; name: string; status: string; is_demo: boolean }>('SELECT id, slug, name, status, is_demo FROM tenants WHERE id = $1', [tenantId])).rows[0]);
  if (!t) throw notFound('Workspace');
  if (t.slug === PLATFORM_SLUG) throw new ApiError(409, 'not_allowed', 'The platform workspace cannot be managed here.');
  return t;
}

export async function listTenants(p: Principal) {
  await assertPlatformOperator(p);
  const tenants = await withOwner(async (c) => (await c.query<{ id: string; slug: string; name: string; status: string; is_demo: boolean; created_at: Date }>('SELECT id, slug, name, status, is_demo, created_at FROM tenants WHERE slug <> $1 ORDER BY created_at', [PLATFORM_SLUG])).rows);
  const out = [];
  for (const t of tenants.slice(0, 500)) {
    // Per-tenant context, so this stays correct even if the owner role were subject to row-level security.
    const detail = await withOwner(async (c) => ({
      users: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM users WHERE tenant_id = $1 AND is_active', [t.id])).rows[0]!.n),
      entries: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM journal_entries WHERE tenant_id = $1', [t.id])).rows[0]!.n),
      modules: (await c.query<{ module: string; enabled: boolean }>('SELECT module, enabled FROM tenant_modules WHERE tenant_id = $1 ORDER BY module', [t.id])).rows,
    }), t.id);
    out.push({ ...t, ...detail });
  }
  return out;
}

export async function setTenantStatus(p: Principal, tenantId: string, status: 'active' | 'suspended', ip?: string) {
  await assertPlatformOperator(p);
  const t = await target(tenantId);
  await withOwner(async (c) => {
    await c.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenantId, status]);
    if (status === 'suspended') await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [tenantId]);
    await recordAudit(c, { tenantId, action: status === 'suspended' ? 'platform.tenant_suspended' : 'platform.tenant_reactivated', actorUserId: p.userId, ip, detail: { operator: p.userId } });
  }, tenantId);
  return { id: t.id, slug: t.slug, status };
}

export async function setTenantPlan(p: Principal, tenantId: string, plan: string, ip?: string) {
  await assertPlatformOperator(p);
  await target(tenantId);
  return setPlan(p, tenantId, plan, ip);
}

export async function setTenantModules(p: Principal, tenantId: string, modules: Partial<Record<string, boolean>>, ip?: string) {
  await assertPlatformOperator(p);
  await target(tenantId);
  const wanted = Object.entries(modules).filter(([m]) => (MODULES as string[]).includes(m)) as [string, boolean][];
  if (wanted.length === 0) throw new ApiError(422, 'validation_error', 'Name at least one module.');
  return withOwner(async (c) => {
    for (const [m, on] of wanted) await c.query('UPDATE tenant_modules SET enabled = $3, updated_at = now() WHERE tenant_id = $1 AND module = $2', [tenantId, m, on]);
    await recordAudit(c, { tenantId, action: 'platform.modules_changed', actorUserId: p.userId, ip, detail: { operator: p.userId, modules: Object.fromEntries(wanted) } });
    return (await c.query<{ module: string; enabled: boolean }>('SELECT module, enabled FROM tenant_modules WHERE tenant_id = $1 ORDER BY module', [tenantId])).rows;
  }, tenantId);
}

/** A read-only, 15-minute window into one workspace. Cannot refresh, cannot write, always audited with a reason. */
export async function startSupportSession(p: Principal, tenantId: string, reason: string, ip?: string) {
  await assertPlatformOperator(p);
  const t = await target(tenantId);
  if (t.status !== 'active') throw new ApiError(409, 'not_active', 'That workspace is suspended.');
  const modules = await withOwner(async (c) => {
    await recordAudit(c, { tenantId, action: 'platform.support_session_started', actorUserId: p.userId, ip, detail: { operator: p.userId, reason } });
    return (await c.query<{ module: string }>('SELECT module FROM tenant_modules WHERE tenant_id = $1 AND enabled ORDER BY module', [tenantId])).rows.map((r) => r.module);
  }, tenantId);
  const { token, expiresIn } = await signAccessToken({
    userId: p.userId,
    tenantId,
    roles: ['Support (read-only)'],
    permissions: SUPPORT_PERMISSIONS,
    modules,
    impersonator: p.userId,
  });
  return { access_token: token, expires_in: expiresIn, tenant: { id: t.id, slug: t.slug, name: t.name } };
}
