/** Two-factor enrolment, recovery codes and session management (US-023, US-122, FR-AUT-04/05). */
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { ApiError } from '../../lib/errors.js';
import { signAccessToken, verifyPassword, type Principal } from '../../lib/security.js';
import { generateSecret, newRecoveryCodes, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import { recordAudit } from '../audit/audit.js';
import { loadPrincipal, USER_COLS, type UserRow } from './service.js';

async function notDemo(c: PoolClient, tenantId: string) {
  const demo = (await c.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [tenantId])).rows[0]?.is_demo;
  if (demo) throw new ApiError(403, 'demo_restricted', 'This is not available in the shared demo workspace.');
}

async function me(c: PoolClient, p: Principal) {
  const u = (await c.query<UserRow & { email: string }>('SELECT ' + USER_COLS + ', email FROM users WHERE id = $1 AND is_active', [p.userId])).rows[0];
  if (!u) throw new ApiError(401, 'invalid_token', 'Session expired. Please sign in again.');
  return u;
}

export const getMe = (p: Principal) =>
  withTenant(p.tenantId, async (c) => {
    const u = await me(c, p);
    return {
      id: u.id,
      tenant_id: p.tenantId,
      full_name: u.full_name,
      email: u.email,
      roles: p.roles,
      permissions: p.permissions,
      mfa_enabled: u.totp_enabled,
      mfa_enrollment_required: !!p.mfaEnrollRequired,
      recovery_codes_left: u.totp_recovery_hashes.length,
    };
  });

export const setupMfa = (p: Principal) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    const u = await me(c, p);
    if (u.totp_enabled) throw new ApiError(409, 'already_enabled', 'Two-factor sign-in is already on.');
    const secret = generateSecret();
    await c.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [u.id, await encryptField(c, p.tenantId, secret)]);
    return { secret, otpauth_url: otpauthUrl('ERPatio', u.email, secret) };
  });

export const enableMfa = (p: Principal, code: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    const u = await me(c, p);
    if (u.totp_enabled) throw new ApiError(409, 'already_enabled', 'Two-factor sign-in is already on.');
    if (!u.totp_secret_enc) throw new ApiError(409, 'not_set_up', 'Start the setup first.');
    const secret = await decryptField(c, p.tenantId, u.totp_secret_enc);
    const step = verifyTotp(secret, code.trim());
    if (step === null) throw new ApiError(422, 'invalid_code', 'That code is not valid. Check the time on your phone and try again.');
    const rec = newRecoveryCodes();
    await c.query('UPDATE users SET totp_enabled = true, totp_last_step = $2, totp_recovery_hashes = $3 WHERE id = $1', [u.id, step, rec.hashes]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'auth.mfa_enabled', actorUserId: u.id, ip });
    // Hand back a fresh access token: the enrolment gate (if any) no longer applies.
    const principal = await loadPrincipal(c, { ...u, totp_enabled: true }, p.sessionId);
    const { token, expiresIn } = await signAccessToken(principal);
    return { recovery_codes: rec.plain, access_token: token, expires_in: expiresIn };
  });

export const disableMfa = (p: Principal, password: string, code: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    const u = await me(c, p);
    if (!u.totp_enabled || !u.totp_secret_enc) throw new ApiError(409, 'not_enabled', 'Two-factor sign-in is not on.');
    const required = (await c.query<{ mfa_required_roles: string[] }>('SELECT mfa_required_roles FROM tenant_settings')).rows[0]?.mfa_required_roles ?? [];
    if (p.roles.some((r) => required.includes(r))) throw new ApiError(409, 'mfa_required', 'Your role must use two-factor sign-in, so it cannot be turned off.');
    if (!(await verifyPassword(password, u.password_hash))) throw new ApiError(403, 'invalid_credentials', 'The password is not correct.');
    if (verifyTotp(await decryptField(c, p.tenantId, u.totp_secret_enc), code.trim()) === null) throw new ApiError(422, 'invalid_code', 'That code is not valid.');
    await c.query("UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, totp_recovery_hashes = '{}' WHERE id = $1", [u.id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'auth.mfa_disabled', actorUserId: u.id, ip });
    return { mfa_enabled: false };
  });

export const listSessions = (p: Principal) =>
  withTenant(p.tenantId, async (c) =>
    (
      await c.query<{ id: string; started_at: Date; last_active_at: Date; ip: string | null; user_agent: string | null }>(
        `SELECT family_id AS id, min(created_at) AS started_at, max(created_at) AS last_active_at,
                (array_agg(ip::text ORDER BY created_at DESC))[1] AS ip,
                (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent
           FROM refresh_tokens
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          GROUP BY family_id ORDER BY max(created_at) DESC`,
        [p.userId],
      )
    ).rows.map((r) => ({ ...r, current: r.id === p.sessionId })),
  );

export const revokeSession = (p: Principal, familyId: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL', [familyId, p.userId]);
    if (!r.rowCount) throw new ApiError(404, 'not_found', 'Session not found.');
    await recordAudit(c, { tenantId: p.tenantId, action: 'auth.session_revoked', actorUserId: p.userId, ip });
  });

export const revokeAllSessions = (p: Principal, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [p.userId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'auth.sessions_revoked_all', actorUserId: p.userId, ip, detail: { count: r.rowCount } });
    return { revoked: r.rowCount ?? 0 };
  });
