/**
 * Login (with optional 2FA), refresh rotation with reuse detection and a short grace window, logout
 * (ADR-004, FR-IAM-01/03/04, FR-AUT-04/06).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getEnv } from '../../config/env.js';
import { withSystem, withTenant } from '../../db/pool.js';
import { decryptField } from '../../lib/crypto.js';
import { ApiError } from '../../lib/errors.js';
import { als } from '../../lib/logger.js';
import {
  hashRefreshToken,
  newRefreshToken,
  signAccessToken,
  signMfaToken,
  tenantOfRefreshToken,
  verifyMfaToken,
  verifyPassword,
  type Principal,
} from '../../lib/security.js';
import { hashRecoveryCode, verifyTotp } from '../../lib/totp.js';
import { recordAudit, safeIp } from '../audit/audit.js';

const invalid = () => new ApiError(401, 'invalid_credentials', 'Invalid workspace, email or password.');
const sessionExpired = () => new ApiError(401, 'invalid_token', 'Session expired. Please sign in again.');
const REFRESH_GRACE_SECONDS = 10;

export interface SessionUser {
  id: string;
  full_name: string;
  roles: string[];
  permissions: string[];
  mfa_enabled: boolean;
  mfa_enrollment_required: boolean;
}
export interface Session {
  accessToken: string;
  expiresIn: number;
  /** Absent when a concurrent refresh was answered inside the grace window: the cookie is already current. */
  refreshToken?: string;
  user: SessionUser;
}
export type LoginResult = { kind: 'session'; session: Session } | { kind: 'mfa'; mfaToken: string };

export interface UserRow {
  id: string;
  tenant_id: string;
  full_name: string;
  password_hash: string;
  email_verified: boolean;
  failed_attempts: number;
  locked_until: Date | null;
  totp_enabled: boolean;
  totp_secret_enc: string | null;
  totp_last_step: string | null;
  totp_recovery_hashes: string[];
}

export const USER_COLS =
  'id, tenant_id, full_name, password_hash, email_verified, failed_attempts, locked_until, totp_enabled, totp_secret_enc, totp_last_step, totp_recovery_hashes';

export async function loadPrincipal(c: PoolClient, u: UserRow, sessionId?: string): Promise<Principal> {
  const { rows } = await c.query<{ name: string; permission: string | null }>(
    `SELECT r.name, rp.permission
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE ur.user_id = $1`,
    [u.id],
  );
  const roles = [...new Set(rows.map((r) => r.name))].sort();
  const required = (await c.query<{ mfa_required_roles: string[] }>('SELECT mfa_required_roles FROM tenant_settings')).rows[0]?.mfa_required_roles ?? [];
  const modules = (await c.query<{ module: string }>('SELECT module FROM tenant_modules WHERE enabled ORDER BY module')).rows.map((r) => r.module);
  return {
    userId: u.id,
    tenantId: u.tenant_id,
    roles,
    permissions: [...new Set(rows.flatMap((r) => (r.permission ? [r.permission] : [])))].sort(),
    mfaEnrollRequired: !u.totp_enabled && roles.some((r) => required.includes(r)),
    modules,
    sessionId,
  };
}

const toUser = (u: UserRow, p: Principal): SessionUser => ({
  id: u.id,
  full_name: u.full_name,
  roles: p.roles,
  permissions: p.permissions,
  mfa_enabled: u.totp_enabled,
  mfa_enrollment_required: !!p.mfaEnrollRequired,
});

export async function issue(
  c: PoolClient,
  u: UserRow,
  familyId: string,
  ip: string | undefined,
  ua: string | undefined,
): Promise<{ session: Session; refreshId: string }> {
  const env = getEnv();
  const principal = await loadPrincipal(c, u, familyId);
  const { token, expiresIn } = await signAccessToken(principal);
  const refresh = newRefreshToken(u.tenant_id);
  const refreshId = randomUUID();
  await c.query(
    `INSERT INTO refresh_tokens (id, tenant_id, user_id, family_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8)`,
    [refreshId, u.tenant_id, u.id, familyId, refresh.hash, env.REFRESH_DAYS, safeIp(ip), (ua ?? '').slice(0, 300) || null],
  );
  return { refreshId, session: { accessToken: token, expiresIn, refreshToken: refresh.raw, user: toUser(u, principal) } };
}

/** Counts a failed password or 2FA attempt and locks the account after the threshold. The shared demo account is never locked. */
async function registerFailure(c: PoolClient, u: UserRow, ip: string | undefined, action = 'auth.login_failed'): Promise<void> {
  const env = getEnv();
  const demo = (await c.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [u.tenant_id])).rows[0]?.is_demo;
  const locked = !demo && u.failed_attempts + 1 >= env.LOCKOUT_THRESHOLD;
  await c.query(
    `UPDATE users SET failed_attempts = $2,
            locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
      WHERE id = $1`,
    [u.id, locked || demo ? 0 : u.failed_attempts + 1, locked, env.LOCKOUT_MINUTES],
  );
  await recordAudit(c, { tenantId: u.tenant_id, action: locked ? 'auth.account_locked' : action, actorUserId: u.id, ip });
}

/** Checks a 6-digit code or a recovery code. A used code is consumed so it cannot be replayed. */
async function checkSecondFactor(c: PoolClient, u: UserRow, code: string): Promise<boolean> {
  const clean = code.trim();
  if (/^\d{6}$/.test(clean) && u.totp_secret_enc) {
    const secret = await decryptField(c, u.tenant_id, u.totp_secret_enc);
    const step = verifyTotp(secret, clean, Date.now(), u.totp_last_step === null ? null : Number(u.totp_last_step));
    if (step === null) return false;
    await c.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
    return true;
  }
  const h = hashRecoveryCode(clean);
  if (!u.totp_recovery_hashes.includes(h)) return false;
  await c.query('UPDATE users SET totp_recovery_hashes = array_remove(totp_recovery_hashes, $2) WHERE id = $1', [u.id, h]);
  await recordAudit(c, { tenantId: u.tenant_id, action: 'auth.recovery_code_used', actorUserId: u.id });
  return true;
}

type Outcome = { kind: 'ok'; result: LoginResult } | { kind: 'bad' } | { kind: 'unverified' };

export async function login(
  workspace: string,
  email: string,
  password: string,
  ip: string | undefined,
  ua: string | undefined,
): Promise<LoginResult> {
  const tenant = await withSystem(async (c) => (await c.query<{ id: string; status: string }>('SELECT id, status FROM resolve_tenant($1)', [workspace])).rows[0]);
  if (!tenant || tenant.status !== 'active') {
    await verifyPassword(password, null); // equalise timing
    throw invalid();
  }
  const ctx = als.getStore();
  if (ctx) ctx.tenantId = tenant.id;

  const outcome = await withTenant<Outcome>(tenant.id, async (c) => {
    const user = (
      await c.query<UserRow>('SELECT ' + USER_COLS + ' FROM users WHERE lower(email) = lower($1) AND is_active FOR UPDATE', [email.trim()])
    ).rows[0];
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
      await registerFailure(c, user, ip);
      return { kind: 'bad' };
    }
    if (!user.email_verified) return { kind: 'unverified' };
    if (user.totp_enabled) {
      return { kind: 'ok', result: { kind: 'mfa', mfaToken: await signMfaToken(user.id, tenant.id) } };
    }
    await c.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const { session } = await issue(c, user, randomUUID(), ip, ua);
    await recordAudit(c, { tenantId: tenant.id, action: 'auth.login', actorUserId: user.id, ip });
    return { kind: 'ok', result: { kind: 'session', session } };
  });

  // Raised only after the transaction committed, so counters and audit rows persist.
  if (outcome.kind === 'unverified') throw new ApiError(403, 'email_not_verified', 'Verify your email before signing in.');
  if (outcome.kind !== 'ok') throw invalid();
  return outcome.result;
}

export async function loginMfa(mfaToken: string, code: string, ip: string | undefined, ua: string | undefined): Promise<Session> {
  let who: { userId: string; tenantId: string };
  try {
    who = await verifyMfaToken(mfaToken);
  } catch {
    throw new ApiError(401, 'invalid_token', 'That sign-in step expired. Start again.');
  }
  const ctx = als.getStore();
  if (ctx) ctx.tenantId = who.tenantId;
  const outcome = await withTenant<Session | null>(who.tenantId, async (c) => {
    const user = (await c.query<UserRow>('SELECT ' + USER_COLS + ' FROM users WHERE id = $1 AND is_active AND totp_enabled FOR UPDATE', [who.userId])).rows[0];
    if (!user) return null;
    if (user.locked_until && user.locked_until > new Date()) return null;
    if (!(await checkSecondFactor(c, user, code))) {
      await registerFailure(c, user, ip, 'auth.mfa_failed');
      return null;
    }
    await c.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const { session } = await issue(c, user, randomUUID(), ip, ua);
    await recordAudit(c, { tenantId: who.tenantId, action: 'auth.login', actorUserId: user.id, ip, detail: { mfa: true } });
    return session;
  });
  if (!outcome) throw new ApiError(401, 'invalid_code', 'That code is not valid.');
  return outcome;
}

export async function refresh(raw: string, ip: string | undefined, ua: string | undefined): Promise<Session> {
  const tenantId = tenantOfRefreshToken(raw);
  if (!tenantId) throw sessionExpired();
  const ctx = als.getStore();
  if (ctx) ctx.tenantId = tenantId;

  const session = await withTenant<Session | null>(tenantId, async (c) => {
    const { rows } = await c.query<{
      id: string; user_id: string; family_id: string; revoked_at: Date | null; replaced_by: string | null; expired: boolean; in_grace: boolean;
    }>(
      `SELECT t.id, t.user_id, t.family_id, t.revoked_at, t.replaced_by, t.expires_at <= now() AS expired,
              (t.replaced_by IS NOT NULL
               AND t.revoked_at > now() - make_interval(secs => $2)
               AND EXISTS (SELECT 1 FROM refresh_tokens s WHERE s.id = t.replaced_by AND s.revoked_at IS NULL AND s.expires_at > now())) AS in_grace
         FROM refresh_tokens t WHERE t.token_hash = $1 FOR UPDATE`,
      [hashRefreshToken(raw), REFRESH_GRACE_SECONDS],
    );
    const tok = rows[0];
    if (!tok) return null;
    const active = (await c.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [tenantId])).rows[0]?.status === 'active';
    const user = active ? (await c.query<UserRow>('SELECT ' + USER_COLS + ' FROM users WHERE id = $1 AND is_active', [tok.user_id])).rows[0] : undefined;
    if (tok.revoked_at || tok.replaced_by) {
      // Two tabs refreshing at the same moment: the second presents a token that was rotated a moment ago.
      // Answer with an access token only; the browser already holds the newer cookie from the first response.
      if (tok.in_grace && user) {
        const principal = await loadPrincipal(c, user, tok.family_id);
        const { token, expiresIn } = await signAccessToken(principal);
        return { accessToken: token, expiresIn, user: toUser(user, principal) };
      }
      // Otherwise a rotated token came back later: assume theft and revoke the whole chain (T-02).
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [tok.family_id]);
      await recordAudit(c, { tenantId, action: 'auth.refresh_reuse_detected', actorUserId: tok.user_id, ip, detail: { family_id: tok.family_id } });
      return null;
    }
    if (tok.expired || !user) return null;
    const { session: s, refreshId } = await issue(c, user, tok.family_id, ip, ua);
    await c.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [tok.id, refreshId]);
    await recordAudit(c, { tenantId, action: 'auth.refresh', actorUserId: user.id, ip });
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
