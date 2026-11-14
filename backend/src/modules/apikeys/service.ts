/**
 * API keys (FR-API-02/03). A key is `erpk_` plus 32 random bytes; only its SHA-256 is stored, so a database leak does not
 * leak keys. A key acts with the permissions it was given, never more than its creator holds right now, never anything
 * in API_KEY_FORBIDDEN, and stops working the moment its creator is deactivated or its workspace is suspended.
 * Each key has its own request budget per minute.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withOwner, withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { ALL_PERMISSIONS, API_KEY_FORBIDDEN, type Permission } from '../../lib/permissions.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';

export const API_KEY_PREFIX = 'erpk_';
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

// ------------------------------------------------------------------ using a key
interface Window { start: number; count: number }
const windows = new Map<string, Window>();
const lastTouched = new Map<string, number>();

/** Fixed one-minute window per key. In one process; with several instances each allows the budget, which is acceptable for a safety valve. */
function spend(keyId: string, limit: number): void {
  const now = Date.now();
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) { windows.set(keyId, { start: now, count: 1 }); return; }
  w.count += 1;
  if (w.count > limit) throw new ApiError(429, 'rate_limited', 'This API key has used its request budget for the minute.', { 'Retry-After': String(Math.max(1, Math.ceil((60_000 - (now - w.start)) / 1000))) });
}
export const resetApiKeyLimits = (): void => { windows.clear(); lastTouched.clear(); };

export async function authenticateApiKey(token: string): Promise<Principal> {
  if (token.length < 20 || token.length > 100) throw new Error('bad key');
  const h = hash(token);
  return withOwner(async (c) => {
    // Owner connection: every query below names the tenant, because row-level security does not filter here.
    const k = (await c.query<{ id: string; tenant_id: string; permissions: string[]; created_by: string; expires_at: Date | null; rate_limit_per_min: number; tenant_status: string; user_active: boolean }>(
      `SELECT k.id, k.tenant_id, k.permissions, k.created_by, k.expires_at, k.rate_limit_per_min, t.status AS tenant_status, u.is_active AS user_active
         FROM api_keys k JOIN tenants t ON t.id = k.tenant_id JOIN users u ON u.id = k.created_by AND u.tenant_id = k.tenant_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [h])).rows[0];
    if (!k || k.tenant_status !== 'active' || !k.user_active || (k.expires_at && k.expires_at.getTime() <= Date.now())) throw new Error('key not usable');
    spend(k.id, k.rate_limit_per_min);
    const held = new Set((await c.query<{ permission: string }>(
      `SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.tenant_id = ur.tenant_id
        WHERE ur.tenant_id = $1 AND ur.user_id = $2`, [k.tenant_id, k.created_by])).rows.map((r) => r.permission));
    const permissions = k.permissions.filter((x) => held.has(x) && !(API_KEY_FORBIDDEN as string[]).includes(x));
    const modules = (await c.query<{ module: string }>('SELECT module FROM tenant_modules WHERE tenant_id = $1 AND enabled', [k.tenant_id])).rows.map((r) => r.module);
    const now = Date.now();
    if (now - (lastTouched.get(k.id) ?? 0) > 60_000) {
      lastTouched.set(k.id, now);
      await c.query('UPDATE api_keys SET last_used_at = now() WHERE tenant_id = $1 AND id = $2', [k.tenant_id, k.id]);
    }
    return { userId: k.created_by, tenantId: k.tenant_id, roles: ['ApiKey'], permissions, modules, apiKeyId: k.id };
  });
}

// ------------------------------------------------------------------ managing keys
const notAKey = (p: Principal) => { if (p.apiKeyId) throw new ApiError(403, 'forbidden', 'An API key cannot manage keys.'); };

export interface KeyIn { name: string; permissions: string[]; expires_in_days?: number; rate_limit_per_min?: number }

export const createKey = (p: Principal, a: KeyIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    const wanted = [...new Set(a.permissions)];
    for (const x of wanted) {
      if (!(ALL_PERMISSIONS as string[]).includes(x)) throw new ApiError(422, 'invalid_permission', `Unknown permission: ${x}`);
      if ((API_KEY_FORBIDDEN as string[]).includes(x)) throw new ApiError(422, 'forbidden_permission', `An API key cannot hold ${x}.`);
      if (!p.permissions.includes(x as Permission)) throw new ApiError(403, 'cannot_grant', `You cannot give a key ${x}, because you do not have it yourself.`);
    }
    const active = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL', [p.tenantId])).rows[0]!.n);
    if (active >= 20) throw new ApiError(409, 'too_many_keys', 'Revoke a key you no longer use before creating another.');
    const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
    const expires = a.expires_in_days ? new Date(Date.now() + a.expires_in_days * 86_400_000) : null;
    const id = (await c.query<{ id: string }>(
      'INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, permissions, rate_limit_per_min, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [p.tenantId, a.name, key.slice(0, 12), hash(key), wanted, a.rate_limit_per_min ?? 300, p.userId, expires])).rows[0]!.id;
    await recordAudit(c, { tenantId: p.tenantId, action: 'api_key.created', actorUserId: p.userId, entityType: 'api_key', entityId: id, ip, detail: { name: a.name, permissions: wanted.length } });
    return { id, name: a.name, key, key_prefix: key.slice(0, 12), permissions: wanted, expires_at: expires, note: 'Copy this key now. It is not shown again.' };
  });

export const listKeys = (p: Principal) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    return (await c.query(
      `SELECT k.id, k.name, k.key_prefix, k.permissions, k.rate_limit_per_min, k.created_at, k.expires_at, k.last_used_at, k.revoked_at, u.full_name AS created_by_name
         FROM api_keys k JOIN users u ON u.id = k.created_by AND u.tenant_id = k.tenant_id WHERE k.tenant_id = $1 ORDER BY k.created_at DESC`, [p.tenantId])).rows;
  });

export const revokeKey = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    notAKey(p);
    const r = await c.query('UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL', [p.tenantId, id]);
    if (!r.rowCount) throw notFound('API key');
    windows.delete(id);
    await recordAudit(c, { tenantId: p.tenantId, action: 'api_key.revoked', actorUserId: p.userId, entityType: 'api_key', entityId: id, ip });
    return { revoked: true };
  });
