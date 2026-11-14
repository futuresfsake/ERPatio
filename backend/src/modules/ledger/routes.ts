import { Router } from 'express';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import * as svc from './service.js';
import { AccountIn, AccountPatch, AuditQuery, EntryIn, IdParam, PageQuery, ReverseIn, TbQuery } from './schemas.js';

export function ledgerRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/accounts', tag: 'finance', summary: 'List the chart of accounts',
    guard: requirePermission(P.ACCOUNTS_READ), handler: ({ principal }) => svc.listAccounts(principal) });

  route(r, prefix, { method: 'post', path: '/accounts', tag: 'finance', summary: 'Create an account', status: 201,
    guard: requirePermission(P.ACCOUNTS_WRITE), body: AccountIn,
    handler: ({ principal, body, req }) => svc.createAccount(principal, body, req.ip) });

  route(r, prefix, { method: 'patch', path: '/accounts/:id', tag: 'finance', summary: 'Rename or (de)activate an account',
    guard: requirePermission(P.ACCOUNTS_WRITE), params: IdParam, body: AccountPatch,
    handler: ({ principal, params, body, req }) => svc.updateAccount(principal, params.id, body, req.ip) });

  route(r, prefix, { method: 'get', path: '/journal-entries', tag: 'finance', summary: 'List journal entries',
    guard: requirePermission(P.JOURNAL_READ), query: PageQuery,
    handler: ({ principal, query }) => svc.listEntries(principal, query.limit, query.offset) });

  route(r, prefix, { method: 'post', path: '/journal-entries', tag: 'finance', summary: 'Post a balanced journal entry', status: 201,
    guard: requirePermission(P.JOURNAL_POST), body: EntryIn,
    handler: ({ principal, body, req }) => svc.postEntry(principal, body, req.ip) });

  route(r, prefix, { method: 'get', path: '/journal-entries/:id', tag: 'finance', summary: 'Get one journal entry with lines',
    guard: requirePermission(P.JOURNAL_READ), params: IdParam,
    handler: ({ principal, params }) => svc.getEntry(principal, params.id) });

  route(r, prefix, { method: 'post', path: '/journal-entries/:id/reverse', tag: 'finance', summary: 'Reverse a posted entry', status: 201,
    guard: requirePermission(P.JOURNAL_REVERSE), params: IdParam, body: ReverseIn,
    handler: ({ principal, params, body, req }) => svc.reverseEntry(principal, params.id, (body as { entry_date?: string }).entry_date, req.ip) });

  route(r, prefix, { method: 'get', path: '/reports/trial-balance', tag: 'reports', summary: 'Trial balance as of a date',
    guard: requirePermission(P.REPORTS_READ), query: TbQuery,
    handler: ({ principal, query }) => svc.trialBalance(principal, query.as_of ?? new Date().toISOString().slice(0, 10)) });

  route(r, prefix, { method: 'get', path: '/audit-log', tag: 'audit', summary: 'Recent audit events',
    guard: requirePermission(P.AUDIT_READ), query: AuditQuery,
    handler: ({ principal, query }) => svc.recentAudit(principal, query.limit) });

  return r;
}
