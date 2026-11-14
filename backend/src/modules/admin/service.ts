/**
 * People and roles administration (US-016, US-017, US-024).
 * Two rules run through everything here:
 *   1. You can only hand out permissions you hold yourself (no privilege escalation).
 *   2. A workspace always keeps at least one active administrator.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { getMailer } from '../../lib/mailer.js';
import { MODULE_OF, PERMISSION_LABELS, TENANT_PERMISSIONS, type Permission } from '../../lib/permissions.js';
import { hashPassword, type Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { createToken, linkTo } from '../auth/account.js';

const INVITE_MINUTES = 72 * 60;

async function notDemo(c: PoolClient, tenantId: string) {
  const demo = (await c.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [tenantId])).rows[0]?.is_demo;
  if (demo) throw new ApiError(403, 'demo_restricted', 'People and roles cannot be changed in the shared demo workspace.');
}

async function rolesById(c: PoolClient, ids: string[]) {
  const rows = (
    await c.query<{ id: string; name: string; permissions: string[] }>(
      `SELECT r.id, r.name, COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.id = ANY($1::uuid[]) GROUP BY r.id`,
      [ids],
    )
  ).rows;
  if (rows.length !== new Set(ids).size) throw new ApiError(422, 'invalid_role', 'One of the roles does not exist.');
  return rows;
}

/** Rule 1: the actor must already hold every permission of every role they assign. */
function assertCanGrant(p: Principal, perms: string[]) {
  const missing = perms.filter((x) => !p.permissions.includes(x));
  if (missing.length) throw new ApiError(403, 'cannot_grant', `You cannot grant permissions you do not hold yourself (${missing.slice(0, 3).join(', ')}).`);
}

async function otherActiveAdmins(c: PoolClient, exceptUserId: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT count(DISTINCT u.id) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'TenantAdmin' AND u.is_active AND u.erased_at IS NULL AND u.id <> $1`,
    [exceptUserId],
  );
  return Number(r.rows[0]!.n);
}
const isAdmin = async (c: PoolClient, userId: string) =>
  (await c.query('SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.name = \'TenantAdmin\'', [userId])).rowCount! > 0;

// ------------------------------------------------------------------------------------------- users
const USER_LIST =
  `SELECT u.id, u.email, u.full_name, u.is_active, u.email_verified, u.totp_enabled, u.last_login_at, u.created_at, u.erased_at,
          u.password_changed_at IS NULL AND u.last_login_at IS NULL AS invite_pending,
          COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name) ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id`;

export const listUsers = (p: Principal) =>
  withTenant(p.tenantId, async (c) => (await c.query(USER_LIST + ' GROUP BY u.id ORDER BY lower(u.full_name)')).rows);

const oneUser = async (c: PoolClient, id: string) => {
  const row = (await c.query(USER_LIST + ' WHERE u.id = $1 GROUP BY u.id', [id])).rows[0];
  if (!row) throw notFound('Person');
  return row;
};

/** Writes the one-time token inside the caller's transaction and returns the message; the caller sends it after commit. */
async function prepareInvite(c: PoolClient, p: Principal, userId: string, email: string, name: string) {
  const company = (await c.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [p.tenantId])).rows[0]!.name;
  const raw = await createToken(c, p.tenantId, userId, 'reset', INVITE_MINUTES);
  return {
    to: email,
    subject: `You have been invited to ${company} on ERPatio`,
    text: `Hello ${name},\n\nYou have been invited to ${company} on ERPatio. Choose your password to get started:\n${linkTo('/reset-password', raw)}\n\nThe link works once and expires in 72 hours.\n`,
  };
}

export const inviteUser = async (p: Principal, input: { email: string; fullName: string; roleIds: string[] }, ip?: string) => {
  const { user, mail } = await withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    const roles = await rolesById(c, input.roleIds);
    for (const r of roles) assertCanGrant(p, r.permissions);
    let id: string;
    try {
      id = (
        await c.query<{ id: string }>(
          'INSERT INTO users (tenant_id, email, full_name, password_hash, email_verified) VALUES ($1, lower($2), $3, $4, false) RETURNING id',
          [p.tenantId, input.email, input.fullName, await hashPassword(randomBytes(24).toString('base64url'))], // unusable until they choose one
        )
      ).rows[0]!.id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'email_taken', 'Someone in this workspace already uses that email address.');
      throw e;
    }
    for (const r of roles) await c.query('INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)', [id, r.id, p.tenantId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'user.invited', actorUserId: p.userId, entityType: 'user', entityId: id, ip, detail: { roles: roles.map((r) => r.name) } });
    return { user: await oneUser(c, id), mail: await prepareInvite(c, p, id, input.email, input.fullName) };
  });
  await getMailer().send(mail);
  return user;
};

export const resendInvite = async (p: Principal, id: string) => {
  const mail = await withTenant(p.tenantId, async (c) => {
    const u = (await c.query<{ email: string; full_name: string; pending: boolean; is_active: boolean }>('SELECT email, full_name, is_active, password_changed_at IS NULL AND last_login_at IS NULL AS pending FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw notFound('Person');
    if (!u.pending || !u.is_active) throw new ApiError(409, 'not_pending', 'This person has already set a password. Use "Forgot password" instead.');
    return prepareInvite(c, p, id, u.email, u.full_name);
  });
  await getMailer().send(mail);
  return { sent: true };
};

export const updateUser = (p: Principal, id: string, patch: { fullName?: string; isActive?: boolean }, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    const u = (await c.query<{ is_active: boolean; erased_at: Date | null }>('SELECT is_active, erased_at FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!u) throw notFound('Person');
    if (u.erased_at) throw new ApiError(409, 'erased', 'This person has been erased and cannot be changed.');
    if (patch.isActive === false && u.is_active) {
      if (id === p.userId) throw new ApiError(409, 'not_allowed', 'You cannot deactivate yourself.');
      if ((await isAdmin(c, id)) && (await otherActiveAdmins(c, id)) === 0)
        throw new ApiError(409, 'last_admin', 'This is the only active administrator. Make someone else an administrator first.');
    }
    await c.query('UPDATE users SET full_name = COALESCE($2, full_name), is_active = COALESCE($3, is_active) WHERE id = $1', [id, patch.fullName ?? null, patch.isActive ?? null]);
    if (patch.isActive === false && u.is_active) {
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]); // sessions end; an access token lives at most 15 minutes
      await recordAudit(c, { tenantId: p.tenantId, action: 'user.deactivated', actorUserId: p.userId, entityType: 'user', entityId: id, ip });
    } else if (patch.isActive === true && !u.is_active) {
      await recordAudit(c, { tenantId: p.tenantId, action: 'user.reactivated', actorUserId: p.userId, entityType: 'user', entityId: id, ip });
    }
    if (patch.fullName) await recordAudit(c, { tenantId: p.tenantId, action: 'user.renamed', actorUserId: p.userId, entityType: 'user', entityId: id, ip });
    return oneUser(c, id);
  });

export const setUserRoles = (p: Principal, id: string, roleIds: string[], ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    const u = (await c.query<{ erased_at: Date | null }>('SELECT erased_at FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!u) throw notFound('Person');
    if (u.erased_at) throw new ApiError(409, 'erased', 'This person has been erased and cannot be changed.');
    const roles = await rolesById(c, roleIds);
    for (const r of roles) assertCanGrant(p, r.permissions);
    const keepsAdmin = roles.some((r) => r.name === 'TenantAdmin');
    if (!keepsAdmin && (await isAdmin(c, id)) && (await otherActiveAdmins(c, id)) === 0)
      throw new ApiError(409, 'last_admin', 'This is the only active administrator. Make someone else an administrator first.');
    // Someone who is not an administrator yet may not make another administrator (rule 1 covers permissions; this covers the role name).
    if (keepsAdmin && !(await isAdmin(c, id)) && !p.roles.includes('TenantAdmin'))
      throw new ApiError(403, 'cannot_grant', 'Only an administrator can make someone an administrator.');
    await c.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
    for (const r of roles) await c.query('INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)', [id, r.id, p.tenantId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'user.roles_changed', actorUserId: p.userId, entityType: 'user', entityId: id, ip, detail: { roles: roles.map((r) => r.name) } });
    return oneUser(c, id);
  });

// ------------------------------------------------------------------------------------------- roles
const ROLE_LIST =
  `SELECT r.id, r.name, r.description, r.is_system,
          COALESCE(array_agg(DISTINCT rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions,
          (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id`;

export const listRoles = (p: Principal) => withTenant(p.tenantId, async (c) => (await c.query(ROLE_LIST + ' GROUP BY r.id ORDER BY r.is_system DESC, r.name')).rows);

export const permissionCatalogue = () => TENANT_PERMISSIONS.map((key) => ({ key, label: PERMISSION_LABELS[key], module: MODULE_OF[key] }));

function checkPermissionList(p: Principal, perms: string[]) {
  const known = new Set<string>(TENANT_PERMISSIONS);
  const unknown = perms.filter((x) => !known.has(x));
  if (unknown.length) throw new ApiError(422, 'invalid_permission', `Unknown permission: ${unknown[0]}.`);
  assertCanGrant(p, perms);
}

const oneRole = async (c: PoolClient, id: string) => (await c.query(ROLE_LIST + ' WHERE r.id = $1 GROUP BY r.id', [id])).rows[0];

export const createRole = (p: Principal, input: { name: string; description?: string; permissions: Permission[] }, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    checkPermissionList(p, input.permissions);
    let id: string;
    try {
      id = (await c.query<{ id: string }>('INSERT INTO roles (tenant_id, name, description, is_system) VALUES ($1, $2, $3, false) RETURNING id', [p.tenantId, input.name, input.description ?? null])).rows[0]!.id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'role_exists', 'A role with that name already exists.');
      throw e;
    }
    for (const perm of new Set(input.permissions)) await c.query('INSERT INTO role_permissions (role_id, permission, tenant_id) VALUES ($1, $2, $3)', [id, perm, p.tenantId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'role.created', actorUserId: p.userId, entityType: 'role', entityId: id, ip, detail: { name: input.name, permissions: [...new Set(input.permissions)].sort() } });
    return oneRole(c, id);
  });

async function customRole(c: PoolClient, id: string) {
  const r = (await c.query<{ is_system: boolean; name: string }>('SELECT is_system, name FROM roles WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) throw notFound('Role');
  if (r.is_system) throw new ApiError(409, 'system_role', 'Built-in roles cannot be changed. Create a custom role instead.');
  return r;
}

export const updateRole = (p: Principal, id: string, input: { name?: string; description?: string; permissions?: Permission[] }, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    await customRole(c, id);
    if (input.permissions) checkPermissionList(p, input.permissions);
    try {
      await c.query('UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1', [id, input.name ?? null, input.description ?? null]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'role_exists', 'A role with that name already exists.');
      throw e;
    }
    if (input.permissions) {
      await c.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      for (const perm of new Set(input.permissions)) await c.query('INSERT INTO role_permissions (role_id, permission, tenant_id) VALUES ($1, $2, $3)', [id, perm, p.tenantId]);
    }
    await recordAudit(c, { tenantId: p.tenantId, action: 'role.updated', actorUserId: p.userId, entityType: 'role', entityId: id, ip, detail: { fields: Object.keys(input).sort() } });
    return oneRole(c, id);
  });

export const deleteRole = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await notDemo(c, p.tenantId);
    await customRole(c, id);
    const used = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM user_roles WHERE role_id = $1', [id])).rows[0]!.n);
    if (used > 0) throw new ApiError(409, 'role_in_use', `${used} ${used === 1 ? 'person has' : 'people have'} this role. Change their roles first.`);
    await c.query('DELETE FROM roles WHERE id = $1', [id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'role.deleted', actorUserId: p.userId, entityType: 'role', entityId: id, ip });
  });

export const tenantInfo = (p: Principal) =>
  withTenant(p.tenantId, async (c) => {
    const t = (await c.query<{ slug: string; name: string; is_demo: boolean; base_currency: string }>('SELECT slug, name, is_demo, base_currency FROM tenants WHERE id = $1', [p.tenantId])).rows[0]!;
    const modules = (await c.query<{ module: string; enabled: boolean }>('SELECT module, enabled FROM tenant_modules ORDER BY module')).rows;
    return { ...t, modules };
  });
