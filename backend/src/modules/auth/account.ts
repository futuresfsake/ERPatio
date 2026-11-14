/**
 * Self-service sign-up, e-mail verification and password reset (US-010, US-015, US-120, US-121, US-123).
 * Everything that could reveal whether an account exists answers the same way whether or not it does.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getEnv } from '../../config/env.js';
import { getPool, withSystem, withTenant } from '../../db/pool.js';
import { isBreached } from '../../lib/breached.js';
import { ApiError } from '../../lib/errors.js';
import { als } from '../../lib/logger.js';
import { getMailer } from '../../lib/mailer.js';
import { hashPassword, hashRefreshToken, passwordPolicyError, tenantOfRefreshToken } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { createUser, provisionTenant } from '../tenants/provision.js';

export const PRIVACY_VERSION = '2026-11';
const VERIFY_MINUTES = 48 * 60;
const RESET_MINUTES = 30;
const RESERVED = new Set(['admin', 'api', 'app', 'www', 'login', 'signup', 'support', 'static', 'assets']);

export async function assertPasswordAcceptable(password: string): Promise<void> {
  const weak = passwordPolicyError(password);
  if (weak) throw new ApiError(422, 'weak_password', weak);
  if (await isBreached(password)) throw new ApiError(422, 'breached_password', 'That password has appeared in a known data breach. Choose a different one.');
}

export function slugify(company: string): string {
  let s = company.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  if (s.length < 3) s = `${s}-co`.replace(/^-/, 'co-');
  if (RESERVED.has(s)) s = `${s}-co`;
  return s;
}

export const linkTo = (path: string, raw: string) => `${getEnv().APP_URL}${path}?token=${encodeURIComponent(raw)}`;

export async function createToken(c: PoolClient, tenantId: string, userId: string, purpose: 'verify' | 'reset', minutes: number): Promise<string> {
  // A new token replaces any older unused one of the same kind.
  await c.query("UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", [userId, purpose]);
  const raw = `${tenantId}.${randomBytes(32).toString('base64url')}`;
  await c.query(
    'INSERT INTO email_tokens (tenant_id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))',
    [tenantId, userId, purpose, hashRefreshToken(raw), minutes],
  );
  return raw;
}

const sendVerification = (to: string, name: string, raw: string) =>
  getMailer().send({
    to,
    subject: 'Confirm your ERPatio email address',
    text: `Hello ${name},\n\nConfirm your email address to finish setting up your workspace:\n${linkTo('/verify-email', raw)}\n\nThe link works once and expires in 48 hours. If you did not sign up, ignore this message.\n`,
  });

const sendReset = (to: string, name: string, raw: string) =>
  getMailer().send({
    to,
    subject: 'Reset your ERPatio password',
    text: `Hello ${name},\n\nUse this link to choose a new password:\n${linkTo('/reset-password', raw)}\n\nThe link works once and expires in 30 minutes. If you did not ask for this, ignore this message; your password has not changed.\n`,
  });

export interface SignupInput {
  company: string;
  fullName: string;
  email: string;
  password: string;
  acceptPrivacy: boolean;
}

export async function signup(input: SignupInput, ip: string | undefined): Promise<void> {
  if (!getEnv().SIGNUP_ENABLED) throw new ApiError(404, 'signup_disabled', 'Sign-up is not open.');
  if (!input.acceptPrivacy) throw new ApiError(422, 'consent_required', 'You must accept the privacy notice to create a workspace.');
  await assertPasswordAcceptable(input.password);

  const client = await getPool().connect();
  let token: string;
  try {
    await client.query('BEGIN');
    let tenantId: string | undefined;
    const base = slugify(input.company);
    for (let attempt = 0; attempt < 6 && !tenantId; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 26)}-${randomBytes(2).toString('hex')}`;
      await client.query('SAVEPOINT slug_try');
      try {
        tenantId = await provisionTenant(client, { slug, name: input.company.trim(), mfaRequiredRoles: ['TenantAdmin'], plan: 'trial' });
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        await client.query('ROLLBACK TO SAVEPOINT slug_try');
      }
    }
    if (!tenantId) throw new ApiError(409, 'conflict', 'Could not reserve a workspace code. Try a different company name.');
    const userId = await createUser(client, { tenantId, email: input.email, fullName: input.fullName.trim(), password: input.password, roles: ['TenantAdmin'], verified: false });
    await client.query('INSERT INTO consents (tenant_id, user_id, kind, version, ip) VALUES ($1, $2, $3, $4, $5)', [tenantId, userId, 'privacy_notice', PRIVACY_VERSION, ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null]);
    await recordAudit(client, { tenantId, action: 'tenant.signup', actorUserId: userId, ip, detail: { privacy_version: PRIVACY_VERSION } });
    token = await createToken(client, tenantId, userId, 'verify', VERIFY_MINUTES);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  await sendVerification(input.email, input.fullName.trim(), token);
}

async function tokenRow(c: PoolClient, raw: string, purpose: 'verify' | 'reset') {
  const row = (
    await c.query<{ id: string; user_id: string; expired: boolean; used: boolean }>(
      `SELECT id, user_id, expires_at <= now() AS expired, used_at IS NOT NULL AS used
         FROM email_tokens WHERE token_hash = $1 AND purpose = $2 FOR UPDATE`,
      [hashRefreshToken(raw), purpose],
    )
  ).rows[0];
  if (!row || row.expired || row.used) throw new ApiError(400, 'invalid_token', 'That link is invalid or has expired. Request a new one.');
  return row;
}

export async function verifyEmail(raw: string, ip: string | undefined): Promise<void> {
  const tenantId = tenantOfRefreshToken(raw);
  if (!tenantId) throw new ApiError(400, 'invalid_token', 'That link is invalid or has expired. Request a new one.');
  const ctx = als.getStore();
  if (ctx) ctx.tenantId = tenantId;
  await withTenant(tenantId, async (c) => {
    const t = await tokenRow(c, raw, 'verify');
    await c.query('UPDATE email_tokens SET used_at = now() WHERE id = $1', [t.id]);
    await c.query('UPDATE users SET email_verified = true WHERE id = $1', [t.user_id]);
    await recordAudit(c, { tenantId, action: 'auth.email_verified', actorUserId: t.user_id, ip });
  });
}

async function findTenant(workspace: string) {
  const tenant = await withSystem(async (c) => (await c.query<{ id: string; status: string }>('SELECT id, status FROM resolve_tenant($1)', [workspace])).rows[0]);
  return tenant && tenant.status === 'active' ? tenant : undefined;
}

/** Always resolves the same way, whether or not the account exists (FR-AUT-06). */
export async function resendVerification(workspace: string, email: string): Promise<void> {
  const tenant = await findTenant(workspace);
  if (!tenant) return;
  const out = await withTenant(tenant.id, async (c) => {
    const u = (await c.query<{ id: string; full_name: string; email: string }>('SELECT id, full_name, email FROM users WHERE lower(email) = lower($1) AND is_active AND NOT email_verified', [email.trim()])).rows[0];
    if (!u) return null;
    return { u, raw: await createToken(c, tenant.id, u.id, 'verify', VERIFY_MINUTES) };
  });
  if (out) await sendVerification(out.u.email, out.u.full_name, out.raw);
}

export async function forgotPassword(workspace: string, email: string): Promise<void> {
  const tenant = await findTenant(workspace);
  if (!tenant) return;
  const out = await withTenant(tenant.id, async (c) => {
    const demo = (await c.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [tenant.id])).rows[0]?.is_demo;
    if (demo) return null; // the shared demo password never changes
    const u = (await c.query<{ id: string; full_name: string; email: string }>('SELECT id, full_name, email FROM users WHERE lower(email) = lower($1) AND is_active', [email.trim()])).rows[0];
    if (!u) return null;
    await recordAudit(c, { tenantId: tenant.id, action: 'auth.password_reset_requested', actorUserId: u.id });
    return { u, raw: await createToken(c, tenant.id, u.id, 'reset', RESET_MINUTES) };
  });
  if (out) await sendReset(out.u.email, out.u.full_name, out.raw);
}

export async function resetPassword(raw: string, password: string, ip: string | undefined): Promise<void> {
  const tenantId = tenantOfRefreshToken(raw);
  if (!tenantId) throw new ApiError(400, 'invalid_token', 'That link is invalid or has expired. Request a new one.');
  await assertPasswordAcceptable(password);
  const hash = await hashPassword(password);
  const ctx = als.getStore();
  if (ctx) ctx.tenantId = tenantId;
  await withTenant(tenantId, async (c) => {
    const t = await tokenRow(c, raw, 'reset');
    await c.query('UPDATE email_tokens SET used_at = now() WHERE id = $1', [t.id]);
    // Owning the mailbox is proof of the address, so a reset also verifies it. Every session ends.
    await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL, email_verified = true WHERE id = $1', [t.user_id, hash]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [t.user_id]);
    await recordAudit(c, { tenantId, action: 'auth.password_reset', actorUserId: t.user_id, ip });
  });
}
