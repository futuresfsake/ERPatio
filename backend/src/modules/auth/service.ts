/** Login, refresh rotation with reuse detection, logout (ADR-004, FR-IAM-01/03/04, FR-AUT-06). */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getEnv } from '../../config/env.js';
import { withSystem, withTenant } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import { als } from '../../lib/logger.js';
import {
  hashRefreshToken,
  newRefreshToken,
  signAccessToken,
  tenantOfRefreshToken,
  verifyPassword,
  type Principal,
} from '../../lib/security.js';
import { recordAudit, safeIp } from '../audit/audit.js';

const invalid = () => new ApiError(401, 'invalid_credentials', 'Invalid workspace, email or password.');
const sessionExpired = () => new ApiError(401, 'invalid_token', 'Session expired. Please sign in again.');

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; full_name: string; roles: string[]; permissions: string[] };
}

interface UserRow {
  id: string;
  tenant_id: string;
  full_name: string;
  password_hash: string;
  email_verified: boolean;
  failed_attempts: number;
  locked_until: Date | null;
}

async function loadPrincipal(c: PoolClient, u: UserRow): Promise<Principal> {
  const { rows } = await c.query<{ name: string; permission: string | null }>(
    `SELECT r.name, rp.permission
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE ur.user_id = $1`,
    [u.id],
  );
  return {
    userId: u.id,
    tenantId: u.tenant_id,
    roles: [...new Set(rows.map((r) => r.name))].sort(),
    permissions: [...new Set(rows.flatMap((r) => (r.permission ? [r.permission] : [])))].sort(),
  };
}

async function issue(
  c: PoolClient,
  u: UserRow,
  familyId: string,
  ip: string | undefined,
  ua: string | undefined,
): Promise<{ session: Session; refreshId: string }> {
  const env = getEnv();
  const principal = await loadPrincipal(c, u);
  const { token, expiresIn } = await signAccessToken(principal);
  const refresh = newRefreshToken(u.tenant_id);
  const refreshId = randomUUID();
  await c.query(
    `INSERT INTO refresh_tokens (id, tenant_id, user_id, family_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8)`,
    [refreshId, u.tenant_id, u.id, familyId, refresh.hash, env.REFRESH_DAYS, safeIp(ip), (ua ?? '').slice(0, 300) || null],
  );
  return {
    refreshId,
    session: {
      accessToken: token,
      expiresIn,
      refreshToken: refresh.raw,
      user: { id: u.id, full_name: u.full_name, roles: principal.roles, permissions: principal.permissions },
    },
  };
}

type Outcome = { kind: 'ok'; session: Session } | { kind: 'bad' } | { kind: 'unverified' };

export async function login(
  workspace: string,
  email: string,
  password: string,
  ip: string | undefined,
  ua: string | undefined,
): Promise<Session> {
  const env = getEnv();
  const tenant = await withSystem(async (c) => {
    const r = await c.query<{ id: string; status: string }>('SELECT id, status FROM resolve_tenant($1)', [workspace]);
    return r.rows[0];
  });
  if (!tenant || tenant.status !== 'active') {
    await verifyPassword(password, null); // equalise timing
    throw invalid();
  }
  const ctx = als.getStore();
  if (ctx) ctx.tenantId = tenant.id;

  const outcome = await withTenant<Outcome>(tenant.id, async (c) => {
    const { rows } = await c.query<UserRow>(
      `SELECT id, tenant_id, full_name, password_hash, email_verified, failed_attempts, locked_until
         FROM users WHERE lower(email) = lower($1) AND is_active FOR UPDATE`,
      [email.trim()],
    );
    const user = rows[0];
    if (!user) {
      await verifyPassword(password, null);
      return { kind: 'bad' };
    }
    if (user.locked_until && user.locked_until > new Date()) {
      await verifyPassword(password, null);
      await recordAudit(c, { tenantId: tenant.id, action: 'auth.login_blocked', actorUserId: user.id, ip });
      return { kind: 'bad' };
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      const locked = user.failed_attempts + 1 >= env.LOCKOUT_THRESHOLD;
      await c.query(
        `UPDATE users SET failed_attempts = $2,
                locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
          WHERE id = $1`,
        [user.id, locked ? 0 : user.failed_attempts + 1, locked, env.LOCKOUT_MINUTES],
      );
      await recordAudit(c, { tenantId: tenant.id, action: locked ? 'auth.account_locked' : 'auth.login_failed', actorUserId: user.id, ip });
      return { kind: 'bad' };
    }
    if (!user.email_verified) return { kind: 'unverified' };
    await c.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const { session } = await issue(c, user, randomUUID(), ip, ua);
    await recordAudit(c, { tenantId: tenant.id, action: 'auth.login', actorUserId: user.id, ip });
    return { kind: 'ok', session };
  });

  // Raised only after the transaction committed, so counters and audit rows persist.
  if (outcome.kind === 'unverified') throw new ApiError(403, 'email_not_verified', 'Verify your email before signing in.');
  if (outcome.kind !== 'ok') throw invalid();
  return outcome.session;
}

export async function refresh(raw: string, ip: string | undefined, ua: string | undefined): Promise<Session> {
  const tenantId = tenantOfRefreshToken(raw);
  if (!tenantId) throw sessionExpired();
  const ctx = als.getStore();
  if (ctx) ctx.tenantId = tenantId;

  const session = await withTenant<Session | null>(tenantId, async (c) => {
    const { rows } = await c.query<{
      id: string; user_id: string; family_id: string; revoked_at: Date | null; replaced_by: string | null; expired: boolean;
    }>(
      `SELECT id, user_id, family_id, revoked_at, replaced_by, expires_at <= now() AS expired
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashRefreshToken(raw)],
    );
    const tok = rows[0];
    if (!tok) return null;
    if (tok.revoked_at || tok.replaced_by) {
      // A rotated token was presented again: assume theft and revoke the whole chain (T-02).
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [tok.family_id]);
      await recordAudit(c, { tenantId, action: 'auth.refresh_reuse_detected', actorUserId: tok.user_id, ip, detail: { family_id: tok.family_id } });
      return null;
    }
    if (tok.expired) return null;
    const u = (
      await c.query<UserRow>(
        `SELECT id, tenant_id, full_name, password_hash, email_verified, failed_attempts, locked_until
           FROM users WHERE id = $1 AND is_active`,
        [tok.user_id],
      )
    ).rows[0];
    if (!u) return null;
    const { session: s, refreshId } = await issue(c, u, tok.family_id, ip, ua);
    await c.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [tok.id, refreshId]);
    await recordAudit(c, { tenantId, action: 'auth.refresh', actorUserId: u.id, ip });
    return s;
  });
  if (!session) throw sessionExpired();
  return session;
}

export async function logout(raw: string | undefined, ip: string | undefined): Promise<void> {
  const tenantId = raw ? tenantOfRefreshToken(raw) : null;
  if (!raw || !tenantId) return;
  await withTenant(tenantId, async (c) => {
    const { rows } = await c.query<{ family_id: string; user_id: string }>(
      'SELECT family_id, user_id FROM refresh_tokens WHERE token_hash = $1',
      [hashRefreshToken(raw)],
    );
    const tok = rows[0];
    if (!tok) return;
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [tok.family_id]);
    await recordAudit(c, { tenantId, action: 'auth.logout', actorUserId: tok.user_id, ip });
  });
}
