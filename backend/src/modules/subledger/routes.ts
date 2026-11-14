import { Router } from 'express';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import * as svc from './service.js';
import { AgingQuery, DocListQuery, DocumentIn, PartyIn, PartyListQuery, PartyPatch, PaymentIn, TaxCodeIn, TaxCodePatch, VatQuery, VoidIn } from './schemas.js';
import { z } from 'zod';

const PayList = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) });

export function subledgerRouter(prefix: string): Router {
  const r = Router();

  // The same shape twice: customers/invoices/receipts (receivables) and suppliers/bills/payments (payables).
  const sides = [
    { party: 'customer', parties: 'customers', doc: 'invoice', docs: 'invoices', pay: 'receipt', pays: 'receipts', read: P.RECEIVABLES_READ, write: P.RECEIVABLES_WRITE, aging: 'receivables' },
    { party: 'supplier', parties: 'suppliers', doc: 'bill', docs: 'bills', pay: 'payment', pays: 'vendor-payments', read: P.PAYABLES_READ, write: P.PAYABLES_WRITE, aging: 'payables' },
  ] as const;

  for (const s of sides) {
    const tag = s.aging;

    route(r, prefix, { method: 'get', path: `/${s.parties}`, tag, summary: `List ${s.parties}`, guard: requirePermission(s.read), query: PartyListQuery,
      handler: ({ principal, query }) => svc.listParties(principal, s.party, query.active) });
    route(r, prefix, { method: 'post', path: `/${s.parties}`, tag, summary: `Create a ${s.party}`, status: 201, guard: requirePermission(s.write), body: PartyIn,
      handler: ({ principal, body, req }) => svc.createParty(principal, s.party, body, req.ip) });
    route(r, prefix, { method: 'patch', path: `/${s.parties}/:id`, tag, summary: `Update a ${s.party}`, guard: requirePermission(s.write), params: IdParam, body: PartyPatch,
      handler: ({ principal, params, body, req }) => svc.updateParty(principal, s.party, params.id, body, req.ip) });
    route(r, prefix, { method: 'get', path: `/${s.parties}/:id/tin`, tag, summary: `Show a ${s.party}'s tax number (audited)`, guard: requirePermission(s.write), params: IdParam,
      handler: ({ principal, params, req }) => svc.revealTin(principal, s.party, params.id, req.ip) });

    route(r, prefix, { method: 'get', path: `/${s.docs}`, tag, summary: `List ${s.docs}`, guard: requirePermission(s.read), query: DocListQuery,
      handler: ({ principal, query }) => svc.listDocuments(principal, s.doc, query) });
    route(r, prefix, { method: 'post', path: `/${s.docs}`, tag, summary: `Save a draft ${s.doc}`, status: 201, guard: requirePermission(s.write), body: DocumentIn,
      handler: ({ principal, body, req }) => svc.createDraft(principal, s.doc, body, req.ip) });
    route(r, prefix, { method: 'get', path: `/${s.docs}/:id`, tag, summary: `Get one ${s.doc}`, guard: requirePermission(s.read), params: IdParam,
      handler: ({ principal, params }) => svc.getDocument(principal, s.doc, params.id) });
    route(r, prefix, { method: 'put', path: `/${s.docs}/:id`, tag, summary: `Replace a draft ${s.doc}`, guard: requirePermission(s.write), params: IdParam, body: DocumentIn,
      handler: ({ principal, params, body, req }) => svc.updateDraft(principal, s.doc, params.id, body, req.ip) });
    route(r, prefix, { method: 'delete', path: `/${s.docs}/:id`, tag, summary: `Delete a draft ${s.doc}`, guard: requirePermission(s.write), params: IdParam,
      handler: ({ principal, params, req }) => svc.deleteDraft(principal, s.doc, params.id, req.ip) });
    route(r, prefix, { method: 'post', path: `/${s.docs}/:id/post`, tag, summary: `Post a ${s.doc} to the ledger`, guard: requirePermission(s.write), params: IdParam,
      handler: ({ principal, params, req }) => svc.postDocument(principal, s.doc, params.id, req.ip) });
    route(r, prefix, { method: 'post', path: `/${s.docs}/:id/void`, tag, summary: `Void a posted ${s.doc}`, guard: requirePermission(s.write), params: IdParam, body: VoidIn,
      handler: ({ principal, params, body, req }) => svc.voidDocument(principal, s.doc, params.id, (body as { void_date?: string }).void_date, req.ip) });

    route(r, prefix, { method: 'get', path: `/${s.pays}`, tag, summary: `List ${s.pays}`, guard: requirePermission(s.read), query: PayList,
      handler: ({ principal, query }) => svc.listPayments(principal, s.pay, query.limit, query.offset) });
    route(r, prefix, { method: 'post', path: `/${s.pays}`, tag, summary: `Record a ${s.pay}`, status: 201, guard: requirePermission(s.write), body: PaymentIn,
      handler: ({ principal, body, req }) => svc.recordPayment(principal, s.pay, body, req.ip) });

    route(r, prefix, { method: 'get', path: `/reports/aging/${s.aging}`, tag: 'reports', summary: `${s.aging} aging`, guard: requirePermission(s.read), query: AgingQuery,
      handler: ({ principal, query }) => svc.aging(principal, s.doc, query.as_of ?? new Date().toISOString().slice(0, 10)) });
  }

  route(r, prefix, { method: 'get', path: '/tax-codes', tag: 'finance', summary: 'List tax codes', guard: requirePermission(P.ACCOUNTS_READ),
    handler: ({ principal }) => svc.listTaxCodes(principal) });
  route(r, prefix, { method: 'post', path: '/tax-codes', tag: 'finance', summary: 'Create a tax code', status: 201, guard: requirePermission(P.TAXES_MANAGE), body: TaxCodeIn,
    handler: ({ principal, body, req }) => svc.createTaxCode(principal, body, req.ip) });
  route(r, prefix, { method: 'patch', path: '/tax-codes/:id', tag: 'finance', summary: 'Activate or deactivate a tax code', guard: requirePermission(P.TAXES_MANAGE), params: IdParam, body: TaxCodePatch,
    handler: ({ principal, params, body, req }) => svc.setTaxCodeActive(principal, params.id, body.is_active, req.ip) });
  route(r, prefix, { method: 'get', path: '/reports/vat', tag: 'reports', summary: 'Output and input tax for a period', guard: requirePermission(P.REPORTS_READ), query: VatQuery,
    handler: ({ principal, query }) => svc.vatReport(principal, query.from, query.to) });

  return r;
}
