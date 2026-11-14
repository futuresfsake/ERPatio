import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import * as svc from './service.js';

const Range = z.object({ from: z.iso.date(), to: z.iso.date() }).refine((v) => v.from <= v.to, 'The start cannot be after the end');

export function biRouter(prefix: string): Router {
  const r = Router();
  const guard = requirePermission(P.DASHBOARD_READ);
  route(r, prefix, { method: 'get', path: '/dashboards/executive', tag: 'dashboards', summary: 'Cash, receivables, payables, profit and six-month trend', guard, handler: ({ principal }) => svc.executive(principal) });
  route(r, prefix, { method: 'get', path: '/dashboards/inventory', tag: 'dashboards', summary: 'Stock value, reorder, open orders, movers', guard, handler: ({ principal }) => svc.inventoryDashboard(principal) });
  route(r, prefix, { method: 'get', path: '/reports/profitability', tag: 'reports', summary: 'Margin by customer and by item for a period', guard, query: Range, handler: ({ principal, query }) => svc.profitability(principal, query.from, query.to) });
  return r;
}
