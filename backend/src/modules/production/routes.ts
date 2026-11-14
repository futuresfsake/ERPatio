import { Router } from 'express';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import { AsOfQuery } from '../stock/schemas.js';
import * as svc from './service.js';
import { BomIn, BomListQuery, CloseIn, CompleteIn, IssueIn, WoIn, WoListQuery } from './schemas.js';

export function productionRouter(prefix: string): Router {
  const r = Router();
  const tag = 'production';
  const read = requirePermission(P.PRODUCTION_READ);
  const write = requirePermission(P.PRODUCTION_WRITE);

  route(r, prefix, { method: 'get', path: '/boms', tag, summary: 'List bills of materials', guard: read, query: BomListQuery, handler: ({ principal, query }) => svc.listBoms(principal, query.item_id) });
  route(r, prefix, { method: 'post', path: '/boms', tag, summary: 'Save a new version of a bill of materials (it becomes the active one)', status: 201, guard: write, body: BomIn,
    handler: ({ principal, body, req }) => svc.createBom(principal, body, req.ip) });
  route(r, prefix, { method: 'get', path: '/boms/:id', tag, summary: 'One bill of materials with its estimated cost', guard: read, params: IdParam, handler: ({ principal, params }) => svc.getBom(principal, params.id) });

  route(r, prefix, { method: 'get', path: '/work-orders', tag, summary: 'List work orders', guard: read, query: WoListQuery, handler: ({ principal, query }) => svc.listWorkOrders(principal, query) });
  route(r, prefix, { method: 'post', path: '/work-orders', tag, summary: 'Save a draft work order from the active bill of materials', status: 201, guard: write, body: WoIn,
    handler: ({ principal, body, req }) => svc.createWorkOrder(principal, body, req.ip) });
  route(r, prefix, { method: 'get', path: '/work-orders/:id', tag, summary: 'One work order with component usage', guard: read, params: IdParam, handler: ({ principal, params }) => svc.getWorkOrder(principal, params.id) });
  route(r, prefix, { method: 'delete', path: '/work-orders/:id', tag, summary: 'Delete a draft work order', guard: write, params: IdParam, handler: ({ principal, params, req }) => svc.deleteWorkOrder(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/work-orders/:id/release', tag, summary: 'Release: number it and freeze the components', guard: write, params: IdParam, handler: ({ principal, params, req }) => svc.releaseWorkOrder(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/work-orders/:id/cancel', tag, summary: 'Cancel an order that has not started', guard: write, params: IdParam, handler: ({ principal, params, req }) => svc.cancelWorkOrder(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/work-orders/:id/issue', tag, summary: 'Issue materials to the order', guard: write, params: IdParam, body: IssueIn, handler: ({ principal, params, body, req }) => svc.issueMaterials(principal, params.id, body, req.ip) });
  route(r, prefix, { method: 'post', path: '/work-orders/:id/complete', tag, summary: 'Report finished output', guard: write, params: IdParam, body: CompleteIn, handler: ({ principal, params, body, req }) => svc.completeWorkOrder(principal, params.id, body, req.ip) });
  route(r, prefix, { method: 'post', path: '/work-orders/:id/close', tag, summary: 'Close short and write off remaining work in progress', guard: write, params: IdParam, body: CloseIn, handler: ({ principal, params, body, req }) => svc.closeWorkOrder(principal, params.id, body.date, req.ip) });
  route(r, prefix, { method: 'get', path: '/reports/wip', tag: 'reports', summary: 'Work in progress by order against the ledger', guard: read, query: AsOfQuery,
    handler: ({ principal, query }) => svc.wipReport(principal, query.as_of ?? new Date().toISOString().slice(0, 10)) });
  return r;
}
