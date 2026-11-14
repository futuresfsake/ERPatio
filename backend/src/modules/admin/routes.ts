import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission, TENANT_PERMISSIONS } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import * as svc from './service.js';

const Email = z.email().max(254);
const RoleIds = z.array(z.uuid()).min(1).max(20);
const Perms = z.array(z.enum(TENANT_PERMISSIONS as [string, ...string[]])).max(40);
const InviteBody = z.object({ email: Email, full_name: z.string().trim().min(1).max(200), role_ids: RoleIds });
const UserPatch = z.object({ full_name: z.string().trim().min(1).max(200), is_active: z.boolean() }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const RolesBody = z.object({ role_ids: RoleIds });
const RoleBody = z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(200).optional(), permissions: Perms });
const RolePatch = z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(200), permissions: Perms }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export function adminRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/users', tag: 'admin', summary: 'People in this workspace',
    guard: requirePermission(P.USERS_READ), handler: ({ principal }) => svc.listUsers(principal) });

  route(r, prefix, { method: 'post', path: '/users', tag: 'admin', summary: 'Invite a person by email', status: 201,
    guard: requirePermission(P.USERS_MANAGE), body: InviteBody,
    handler: ({ principal, body, req }) => svc.inviteUser(principal, { email: body.email, fullName: body.full_name, roleIds: body.role_ids }, req.ip) });

  route(r, prefix, { method: 'patch', path: '/users/:id', tag: 'admin', summary: 'Rename, deactivate or reactivate a person',
    guard: requirePermission(P.USERS_MANAGE), params: IdParam, body: UserPatch,
    handler: ({ principal, params, body, req }) => svc.updateUser(principal, params.id, { fullName: body.full_name, isActive: body.is_active }, req.ip) });

  route(r, prefix, { method: 'patch', path: '/users/:id/roles', tag: 'admin', summary: 'Replace a person\'s roles',
    guard: requirePermission(P.USERS_MANAGE), params: IdParam, body: RolesBody,
    handler: ({ principal, params, body, req }) => svc.setUserRoles(principal, params.id, body.role_ids, req.ip) });

  route(r, prefix, { method: 'post', path: '/users/:id/resend-invite', tag: 'admin', summary: 'Send the invitation again',
    guard: requirePermission(P.USERS_MANAGE), params: IdParam, handler: ({ principal, params }) => svc.resendInvite(principal, params.id) });

  route(r, prefix, { method: 'get', path: '/roles', tag: 'admin', summary: 'Roles and their permissions',
    guard: requirePermission(P.USERS_READ), handler: ({ principal }) => svc.listRoles(principal) });

  route(r, prefix, { method: 'get', path: '/permissions', tag: 'admin', summary: 'Permissions a role can contain',
    guard: requirePermission(P.USERS_READ), handler: async () => svc.permissionCatalogue() });

  route(r, prefix, { method: 'post', path: '/roles', tag: 'admin', summary: 'Create a custom role', status: 201,
    guard: requirePermission(P.ROLES_MANAGE), body: RoleBody,
    handler: ({ principal, body, req }) => svc.createRole(principal, { name: body.name, description: body.description, permissions: body.permissions as never }, req.ip) });

  route(r, prefix, { method: 'patch', path: '/roles/:id', tag: 'admin', summary: 'Change a custom role',
    guard: requirePermission(P.ROLES_MANAGE), params: IdParam, body: RolePatch,
    handler: ({ principal, params, body, req }) => svc.updateRole(principal, params.id, { name: body.name, description: body.description, permissions: body.permissions as never }, req.ip) });

  route(r, prefix, { method: 'delete', path: '/roles/:id', tag: 'admin', summary: 'Delete an unused custom role', status: 204,
    guard: requirePermission(P.ROLES_MANAGE), params: IdParam,
    handler: ({ principal, params, req }) => svc.deleteRole(principal, params.id, req.ip) });

  route(r, prefix, { method: 'get', path: '/tenant', tag: 'admin', summary: 'This workspace and its subscribed modules',
    guard: requirePermission(null), handler: ({ principal }) => svc.tenantInfo(principal) });

  return r;
}
