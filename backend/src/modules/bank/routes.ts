import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import * as svc from './service.js';

const isoDate = z.iso.date();
const AccountParam = z.object({ accountId: z.uuid() });
const LineParam = z.object({ id: z.uuid() });
const ImportIn = z.object({
  lines: z.array(z.object({
    date: isoDate,
    description: z.string().trim().min(1).max(300),
    reference: z.string().trim().max(100).optional(),
    amount: z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/).refine((v) => Number(v) !== 0, 'Amount cannot be zero'),
  })).min(1).max(1000),
});
const AsOf = z.object({ as_of: isoDate.optional() });
const MatchIn = z.object({ statement_line_id: z.uuid(), journal_line_id: z.uuid() });
const PostIn = z.object({ account_id: z.uuid(), memo: z.string().trim().max(500).optional() });
const today = () => new Date().toISOString().slice(0, 10);

export function bankRouter(prefix: string): Router {
  const r = Router();
  route(r, prefix, { method: 'post', path: '/bank/:accountId/statement-lines', tag: 'bank', summary: 'Import bank statement lines (repeat imports add nothing)', status: 201,
    guard: requirePermission(P.BANK_MANAGE), params: AccountParam, body: ImportIn,
    handler: ({ principal, params, body, req }) => svc.importLines(principal, params.accountId, body.lines, req.ip) });
  route(r, prefix, { method: 'get', path: '/bank/:accountId/reconciliation', tag: 'bank', summary: 'Unmatched lines, suggestions and the difference to the ledger',
    guard: requirePermission(P.BANK_MANAGE), params: AccountParam, query: AsOf,
    handler: ({ principal, params, query }) => svc.reconciliation(principal, params.accountId, query.as_of ?? today()) });
  route(r, prefix, { method: 'post', path: '/bank/:accountId/auto-match', tag: 'bank', summary: 'Match the unambiguous lines automatically',
    guard: requirePermission(P.BANK_MANAGE), params: AccountParam, query: AsOf,
    handler: ({ principal, params, query, req }) => svc.autoMatch(principal, params.accountId, query.as_of ?? today(), req.ip) });
  route(r, prefix, { method: 'post', path: '/bank/matches', tag: 'bank', summary: 'Match a statement line with a ledger line', status: 201,
    guard: requirePermission(P.BANK_MANAGE), body: MatchIn,
    handler: ({ principal, body, req }) => svc.match(principal, body.statement_line_id, body.journal_line_id, req.ip) });
  route(r, prefix, { method: 'delete', path: '/bank/matches/:id', tag: 'bank', summary: 'Undo a match', guard: requirePermission(P.BANK_MANAGE), params: LineParam,
    handler: ({ principal, params, req }) => svc.unmatch(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/bank/statement-lines/:id/post', tag: 'bank', summary: 'Post a statement line to another account and match it', status: 201,
    guard: requirePermission(P.BANK_MANAGE), params: LineParam, body: PostIn,
    handler: ({ principal, params, body, req }) => svc.postStatementLine(principal, params.id, body.account_id, body.memo, req.ip) });
  return r;
}
