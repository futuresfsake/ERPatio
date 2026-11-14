import { Router } from 'express';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import * as svc from './service.js';

export function privacyRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/privacy/me/export', tag: 'privacy', summary: 'Everything held about the signed-in person',
    guard: requirePermission(null), handler: ({ principal, req }) => svc.exportSubject(principal, principal.userId, req.ip) });

  route(r, prefix, { method: 'get', path: '/privacy/subjects/:id/export', tag: 'privacy', summary: 'Data-subject access export for one person',
    guard: requirePermission(P.PRIVACY_MANAGE), params: IdParam,
    handler: ({ principal, params, req }) => svc.exportSubject(principal, params.id, req.ip) });

  route(r, prefix, { method: 'post', path: '/privacy/subjects/:id/erase', tag: 'privacy', summary: 'Erase (pseudonymise) one person; the ledger is kept',
    guard: requirePermission(P.PRIVACY_MANAGE), params: IdParam,
    handler: ({ principal, params, req }) => svc.eraseSubject(principal, params.id, req.ip) });

  return r;
}
