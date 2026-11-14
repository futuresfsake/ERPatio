import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import * as svc from './service.js';

const today = () => new Date().toISOString().slice(0, 10);
const IncomeQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const BalanceQuery = z.object({ as_of: z.iso.date().optional() });

export function reportsRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/reports/income-statement', tag: 'reports', summary: 'Income statement for a date range',
    guard: requirePermission(P.REPORTS_READ), query: IncomeQuery,
    handler: ({ principal, query }) => {
      const to = query.to ?? today();
      return svc.incomeStatement(principal, query.from ?? `${to.slice(0, 4)}-01-01`, to);
    } });

  route(r, prefix, { method: 'get', path: '/reports/balance-sheet', tag: 'reports', summary: 'Balance sheet as of a date',
    guard: requirePermission(P.REPORTS_READ), query: BalanceQuery,
    handler: ({ principal, query }) => svc.balanceSheet(principal, query.as_of ?? today()) });

  return r;
}
