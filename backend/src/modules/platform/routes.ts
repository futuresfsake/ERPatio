import { Router } from 'express';
import { z } from 'zod';
import { MODULES, P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import * as svc from './service.js';

const StatusBody = z.object({ status: z.enum(['active', 'suspended']) });
const ModulesBody = z.object({ modules: z.partialRecord(z.enum(MODULES as [string, ...string[]]), z.boolean()) });
const SupportBody = z.object({ reason: z.string().trim().min(8).max(300) });

export function platformRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/platform/tenants', tag: 'platform', summary: 'All workspaces',
    guard: requirePermission(P.PLATFORM_MANAGE), handler: ({ principal }) => svc.listTenants(principal) });

  route(r, prefix, { method: 'post', path: '/platform/tenants/:id/status', tag: 'platform', summary: 'Suspend or reactivate a workspace',
    guard: requirePermission(P.PLATFORM_MANAGE), params: IdParam, body: StatusBody,
    handler: ({ principal, params, body, req }) => svc.setTenantStatus(principal, params.id, body.status, req.ip) });

  route(r, prefix, { method: 'patch', path: '/platform/tenants/:id/modules', tag: 'platform', summary: 'Switch modules on or off for a workspace',
    guard: requirePermission(P.PLATFORM_MANAGE), params: IdParam, body: ModulesBody,
    handler: ({ principal, params, body, req }) => svc.setTenantModules(principal, params.id, body.modules, req.ip) });

  route(r, prefix, { method: 'post', path: '/platform/tenants/:id/support-session', tag: 'platform', summary: 'Open a read-only, time-boxed support session (reason required)', status: 201,
    guard: requirePermission(P.PLATFORM_MANAGE), params: IdParam, body: SupportBody,
    handler: ({ principal, params, body, req }) => svc.startSupportSession(principal, params.id, body.reason, req.ip) });

  return r;
}
