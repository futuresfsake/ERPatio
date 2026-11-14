import { Router } from 'express';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import * as svc from './service.js';
import { AdjustIn, AsOfQuery, FromOrderIn, ItemIn, ItemPatch, OrderListQuery, PoIn, ReceiveIn, SoIn } from './schemas.js';

export function stockRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/items', tag: 'supply-chain', summary: 'List items with stock on hand', guard: requirePermission(P.INVENTORY_READ),
    handler: ({ principal }) => svc.listItems(principal) });
  route(r, prefix, { method: 'post', path: '/items', tag: 'supply-chain', summary: 'Create an item', status: 201, guard: requirePermission(P.INVENTORY_WRITE), body: ItemIn,
    handler: ({ principal, body, req }) => svc.createItem(principal, body, req.ip) });
  route(r, prefix, { method: 'patch', path: '/items/:id', tag: 'supply-chain', summary: 'Rename or (de)activate an item', guard: requirePermission(P.INVENTORY_WRITE), params: IdParam, body: ItemPatch,
    handler: ({ principal, params, body, req }) => svc.updateItem(principal, params.id, body, req.ip) });
  route(r, prefix, { method: 'get', path: '/items/:id/stock-card', tag: 'supply-chain', summary: 'Movements for one item with running balance', guard: requirePermission(P.INVENTORY_READ), params: IdParam,
    handler: ({ principal, params }) => svc.stockCard(principal, params.id) });
  route(r, prefix, { method: 'post', path: '/stock-adjustments', tag: 'supply-chain', summary: 'Adjust stock up or down (reason required)', status: 201, guard: requirePermission(P.INVENTORY_WRITE), body: AdjustIn,
    handler: ({ principal, body, req }) => svc.adjustStock(principal, body, req.ip) });
  route(r, prefix, { method: 'get', path: '/reports/stock-valuation', tag: 'reports', summary: 'Stock value by item against the ledger', guard: requirePermission(P.INVENTORY_READ), query: AsOfQuery,
    handler: ({ principal, query }) => svc.valuation(principal, query.as_of ?? new Date().toISOString().slice(0, 10)) });
  route(r, prefix, { method: 'get', path: '/stock-commitments', tag: 'supply-chain', summary: 'Open purchase and sales quantities per item', guard: requirePermission(P.ORDERS_READ),
    handler: ({ principal }) => svc.reorderView(principal) });

  route(r, prefix, { method: 'get', path: '/reports/reorder', tag: 'reports', summary: 'Items at or below their reorder level', guard: requirePermission(P.INVENTORY_READ),
    handler: ({ principal }) => svc.reorderReport(principal) });
  route(r, prefix, { method: 'post', path: '/purchase-orders/:id/bill', tag: 'supply-chain', summary: 'Draft a bill for goods received and not yet billed', status: 201, guard: requirePermission(P.PAYABLES_WRITE), params: IdParam, body: FromOrderIn,
    handler: ({ principal, params, body, req }) => svc.billFromOrder(principal, params.id, body, req.ip) });
  route(r, prefix, { method: 'post', path: '/sales-orders/:id/invoice', tag: 'supply-chain', summary: 'Draft an invoice for goods delivered and not yet invoiced', status: 201, guard: requirePermission(P.RECEIVABLES_WRITE), params: IdParam, body: FromOrderIn,
    handler: ({ principal, params, body, req }) => svc.invoiceFromOrder(principal, params.id, body, req.ip) });
  route(r, prefix, { method: 'post', path: '/purchase-orders/:id/return', tag: 'supply-chain', summary: 'Return received goods to the supplier (before billing)', guard: requirePermission(P.INVENTORY_WRITE), params: IdParam, body: ReceiveIn,
    handler: ({ principal, params, body, req }) => svc.returnGoods(principal, 'po', params.id, body, req.ip) });
  route(r, prefix, { method: 'post', path: '/sales-orders/:id/return', tag: 'supply-chain', summary: 'Take back delivered goods from the customer (before invoicing)', guard: requirePermission(P.INVENTORY_WRITE), params: IdParam, body: ReceiveIn,
    handler: ({ principal, params, body, req }) => svc.returnGoods(principal, 'so', params.id, body, req.ip) });

  const sides = [
    { k: 'po', path: 'purchase-orders', body: PoIn, act: 'receive', actSummary: 'Receive goods against' },
    { k: 'so', path: 'sales-orders', body: SoIn, act: 'deliver', actSummary: 'Deliver goods against' },
  ] as const;
  for (const s of sides) {
    const tag = 'supply-chain';
    route(r, prefix, { method: 'get', path: `/${s.path}`, tag, summary: `List ${s.path}`, guard: requirePermission(P.ORDERS_READ), query: OrderListQuery,
      handler: ({ principal, query }) => svc.listOrders(principal, s.k, query) });
    route(r, prefix, { method: 'post', path: `/${s.path}`, tag, summary: `Save a draft in ${s.path}`, status: 201, guard: requirePermission(P.ORDERS_WRITE), body: s.body as never,
      handler: ({ principal, body, req }) => svc.createOrder(principal, s.k, body as never, req.ip) });
    route(r, prefix, { method: 'get', path: `/${s.path}/:id`, tag, summary: `Get one order from ${s.path}`, guard: requirePermission(P.ORDERS_READ), params: IdParam,
      handler: ({ principal, params }) => svc.getOrder(principal, s.k, params.id) });
    route(r, prefix, { method: 'put', path: `/${s.path}/:id`, tag, summary: 'Replace a draft order', guard: requirePermission(P.ORDERS_WRITE), params: IdParam, body: s.body as never,
      handler: ({ principal, params, body, req }) => svc.updateOrder(principal, s.k, params.id, body as never, req.ip) });
    route(r, prefix, { method: 'delete', path: `/${s.path}/:id`, tag, summary: 'Delete a draft order', guard: requirePermission(P.ORDERS_WRITE), params: IdParam,
      handler: ({ principal, params, req }) => svc.deleteOrder(principal, s.k, params.id, req.ip) });
    route(r, prefix, { method: 'post', path: `/${s.path}/:id/approve`, tag, summary: 'Approve a draft order and give it a number', guard: requirePermission(P.ORDERS_WRITE), params: IdParam,
      handler: ({ principal, params, req }) => svc.approveOrder(principal, s.k, params.id, req.ip) });
    route(r, prefix, { method: 'post', path: `/${s.path}/:id/cancel`, tag, summary: 'Cancel an order that has not moved stock', guard: requirePermission(P.ORDERS_WRITE), params: IdParam,
      handler: ({ principal, params, req }) => svc.cancelOrder(principal, s.k, params.id, req.ip) });
    route(r, prefix, { method: 'post', path: `/${s.path}/:id/${s.act}`, tag, summary: `${s.actSummary} an order`, guard: requirePermission(P.INVENTORY_WRITE), params: IdParam, body: ReceiveIn,
      handler: ({ principal, params, body, req }) => svc.fulfil(principal, s.k, params.id, body, req.ip) });
  }
  return r;
}
