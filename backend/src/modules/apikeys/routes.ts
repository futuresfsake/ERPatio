import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import { WEBHOOK_EVENTS } from '../audit/outbox.js';
import * as billing from '../billing/service.js';
import * as keys from './service.js';
import * as hooks from '../webhooks/service.js';

const KeyIn = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string().max(60)).min(1).max(60),
  expires_in_days: z.number().int().min(1).max(730).optional(),
  rate_limit_per_min: z.number().int().min(10).max(6000).optional(),
});
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
const HookIn = z.object({ url: z.string().trim().max(500), events });
const HookPatch = z.object({ is_active: z.boolean(), events }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export function integrationsRouter(prefix: string): Router {
  const r = Router();
  const manage = requirePermission(P.INTEGRATIONS_MANAGE);
  route(r, prefix, { method: 'get', path: '/api-keys', tag: 'integrations', summary: 'List API keys (never the key itself)', guard: manage, handler: ({ principal }) => keys.listKeys(principal) });
  route(r, prefix, { method: 'post', path: '/api-keys', tag: 'integrations', summary: 'Create an API key; shown once', status: 201, guard: manage, body: KeyIn, handler: ({ principal, body, req }) => keys.createKey(principal, body, req.ip) });
  route(r, prefix, { method: 'delete', path: '/api-keys/:id', tag: 'integrations', summary: 'Revoke an API key', guard: manage, params: IdParam, handler: ({ principal, params, req }) => keys.revokeKey(principal, params.id, req.ip) });

  route(r, prefix, { method: 'get', path: '/webhook-events', tag: 'integrations', summary: 'Events a webhook can subscribe to', guard: manage, handler: async () => [...WEBHOOK_EVENTS] });
  route(r, prefix, { method: 'get', path: '/webhooks', tag: 'integrations', summary: 'List webhook endpoints', guard: manage, handler: ({ principal }) => hooks.listEndpoints(principal) });
  route(r, prefix, { method: 'post', path: '/webhooks', tag: 'integrations', summary: 'Add a webhook endpoint; the signing secret is shown once', status: 201, guard: manage, body: HookIn, handler: ({ principal, body, req }) => hooks.createEndpoint(principal, body, req.ip) });
  route(r, prefix, { method: 'patch', path: '/webhooks/:id', tag: 'integrations', summary: 'Change events or switch a webhook on or off', guard: manage, params: IdParam, body: HookPatch, handler: ({ principal, params, body, req }) => hooks.updateEndpoint(principal, params.id, body, req.ip) });
  route(r, prefix, { method: 'delete', path: '/webhooks/:id', tag: 'integrations', summary: 'Remove a webhook', guard: manage, params: IdParam, handler: ({ principal, params, req }) => hooks.deleteEndpoint(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/webhooks/:id/test', tag: 'integrations', summary: 'Queue a test event', status: 201, guard: manage, params: IdParam, handler: ({ principal, params, req }) => hooks.sendTest(principal, params.id, req.ip) });
  route(r, prefix, { method: 'get', path: '/webhooks/:id/deliveries', tag: 'integrations', summary: 'Recent deliveries and their outcome', guard: manage, params: IdParam, handler: ({ principal, params }) => hooks.listDeliveries(principal, params.id) });

  route(r, prefix, { method: 'get', path: '/billing/usage', tag: 'billing', summary: 'Plan, limits and usage', guard: requirePermission(P.BILLING_READ), handler: ({ principal }) => billing.usage(principal) });
  return r;
}
