/**
 * Data-subject rights (FR-PRV-05/06, US-114/115, ADR-005).
 *   export: everything the system holds about one person, as JSON.
 *   erase : pseudonymise the person. The ledger is untouched, so totals never change (BRU-PRV-1).
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { hashPassword, type Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';

async function subject(c: PoolClient, id: string) {
  const u = (
    await c.query<{ id: string; email: string; full_name: string; is_active: boolean; email_verified: boolean; created_at: Date; last_login_at: Date | null; totp_enabled: boolean; erased_at: Date | null }>(
      'SELECT id, email, full_name, is_active, email_verified, created_at, last_login_at, totp_enabled, erased_at FROM users WHERE id = $1',
      [id],
    )
  ).rows[0];
  if (!u) throw notFound('Person');
  return u;
}

export const exportSubject = (p: Principal, userId: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const u = await subject(c, userId);
    const roles = (await c.query<{ name: string }>('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.name', [userId])).rows.map((r) => r.name);
    const sessions = (
      await c.query('SELECT family_id, min(created_at) AS started_at, max(created_at) AS last_active_at, (array_agg(ip::text ORDER BY created_at DESC))[1] AS ip, (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent FROM refresh_tokens WHERE user_id = $1 GROUP BY family_id ORDER BY max(created_at) DESC', [userId])
    ).rows;
    const consents = (await c.query('SELECT kind, version, accepted_at, ip::text AS ip FROM consents WHERE user_id = $1 ORDER BY accepted_at', [userId])).rows;
    const activity = (await c.query('SELECT occurred_at, action, entity_type, entity_id, ip::text AS ip FROM audit_log WHERE actor_user_id = $1 ORDER BY id DESC LIMIT 1000', [userId])).rows;
    const authored = (
      await c.query<{ entries: string; drafts: string }>(
        'SELECT (SELECT count(*) FROM journal_entries WHERE created_by = $1) AS entries, (SELECT count(*) FROM journal_drafts WHERE created_by = $1) AS drafts',
        [userId],
      )
    ).rows[0]!;
    await recordAudit(c, { tenantId: p.tenantId, action: 'privacy.exported', actorUserId: p.userId, entityType: 'user', entityId: userId, ip });
    return {
      exported_at: new Date().toISOString(),
      format_version: 1,
      person: u,
      roles,
      sessions,
      consents,
      activity,
      authored: { journal_entries: Number(authored.entries), journal_drafts: Number(authored.drafts) },
      note: 'Journal entries this person created remain in the ledger as financial records; they now show the pseudonym if the person is erased.',
    };
  });

async function lastAdmin(c: PoolClient, userId: string): Promise<boolean> {
  const r = await c.query<{ others: string; is_admin: boolean }>(
    `SELECT (SELECT count(*) FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
              WHERE r.name = 'TenantAdmin' AND u.is_active AND u.id <> $1) AS others,
            EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.name = 'TenantAdmin') AS is_admin`,
    [userId],
  );
  return !!r.rows[0]?.is_admin && Number(r.rows[0]?.others) === 0;
}

export const eraseSubject = (p: Principal, userId: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if (userId === p.userId) throw new ApiError(409, 'not_allowed', 'You cannot erase your own account. Ask another administrator.');
    const demo = (await c.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [p.tenantId])).rows[0]?.is_demo;
    if (demo) throw new ApiError(403, 'demo_restricted', 'Not available in the shared demo workspace.');
    const u = await subject(c, userId);
    if (u.erased_at) throw new ApiError(409, 'already_erased', 'This person has already been erased.');
    if (await lastAdmin(c, userId)) throw new ApiError(409, 'last_admin', 'This is the only administrator. Make someone else an administrator first.');

    const alias = userId.slice(0, 8);
    await c.query(
      `UPDATE users SET email = $2, full_name = 'Erased user', password_hash = $3, is_active = false, email_verified = false,
              totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, totp_recovery_hashes = '{}',
              failed_attempts = 0, locked_until = NULL, erased_at = now() WHERE id = $1`,
      [userId, `erased-${alias}@erased.invalid`, await hashPassword(randomBytes(24).toString('base64url'))],
    );
    await c.query('DELETE FROM email_tokens WHERE user_id = $1', [userId]);
    await c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()), ip = NULL, user_agent = NULL WHERE user_id = $1', [userId]);
    await c.query('UPDATE consents SET ip = NULL WHERE user_id = $1', [userId]);
    // The audit log stays append-only; the database allows clearing the ip column, and only that, in this mode.
    await c.query("SELECT set_config('app.erasure', 'on', true)");
    const cleared = await c.query('UPDATE audit_log SET ip = NULL WHERE actor_user_id = $1 AND ip IS NOT NULL', [userId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'privacy.erased', actorUserId: p.userId, entityType: 'user', entityId: userId, ip, detail: { audit_ips_cleared: cleared.rowCount ?? 0 } });
    return { id: userId, erased: true, alias: `erased-${alias}@erased.invalid` };
  });
