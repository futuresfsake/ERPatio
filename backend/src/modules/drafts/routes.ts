import { Router } from 'express';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import { DraftIn, DraftQuery, RejectBody } from './schemas.js';
import * as svc from './service.js';

export function draftsRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/journal-drafts', tag: 'finance', summary: 'List draft entries',
    guard: requirePermission(P.JOURNAL_READ), query: DraftQuery,
    handler: ({ principal, query }) => svc.listDrafts(principal, query.status) });

  route(r, prefix, { method: 'post', path: '/journal-drafts', tag: 'finance', summary: 'Save a draft entry', status: 201,
    guard: requirePermission(P.JOURNAL_POST), body: DraftIn,
    handler: ({ principal, body, req }) => svc.createDraft(principal, body, req.ip) });

  route(r, prefix, { method: 'get', path: '/journal-drafts/:id', tag: 'finance', summary: 'Get one draft with lines',
    guard: requirePermission(P.JOURNAL_READ), params: IdParam,
    handler: ({ principal, params }) => svc.getDraft(principal, params.id) });

  route(r, prefix, { method: 'patch', path: '/journal-drafts/:id', tag: 'finance', summary: 'Replace the contents of a draft',
    guard: requirePermission(P.JOURNAL_POST), params: IdParam, body: DraftIn,
    handler: ({ principal, params, body, req }) => svc.updateDraft(principal, params.id, body, req.ip) });

  route(r, prefix, { method: 'delete', path: '/journal-drafts/:id', tag: 'finance', summary: 'Delete a draft', status: 204,
    guard: requirePermission(P.JOURNAL_POST), params: IdParam,
    handler: ({ principal, params, req }) => svc.deleteDraft(principal, params.id, req.ip) });

  route(r, prefix, { method: 'post', path: '/journal-drafts/:id/submit', tag: 'finance', summary: 'Submit a draft for approval',
    guard: requirePermission(P.JOURNAL_POST), params: IdParam,
    handler: ({ principal, params, req }) => svc.submitDraft(principal, params.id, req.ip) });

  route(r, prefix, { method: 'post', path: '/journal-drafts/:id/reject', tag: 'finance', summary: 'Send a submitted draft back with a note',
    guard: requirePermission(P.JOURNAL_APPROVE), params: IdParam, body: RejectBody,
    handler: ({ principal, params, body, req }) => svc.rejectDraft(principal, params.id, body.note, req.ip) });

  route(r, prefix, { method: 'post', path: '/journal-drafts/:id/post', tag: 'finance', summary: 'Post a draft to the ledger (approves it when approval is required)', status: 201,
    guard: requirePermission(P.JOURNAL_POST), params: IdParam,
    handler: ({ principal, params, req }) => svc.postDraft(principal, params.id, req.ip) });

  return r;
}
