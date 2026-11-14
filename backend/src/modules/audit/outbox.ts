/**
 * Transactional outbox for webhooks: an audited action that a webhook endpoint subscribes to writes its delivery row in the
 * same transaction. If the change rolls back, so does the event; if it commits, the event is certain to be sent (at least once).
 * The payload carries identifiers and the audit detail only, never names or contact data: a receiver fetches the record through the API.
 */
import type { PoolClient } from 'pg';

export const WEBHOOK_EVENTS = [
  'journal.posted', 'invoice.posted', 'bill.posted', 'credit_note.posted', 'debit_note.posted', 'receipt.recorded', 'payment.recorded',
  'purchase_order.approved', 'purchase_order.received', 'sales_order.approved', 'sales_order.delivered', 'work_order.completed',
  'stock.adjusted', 'customer.created', 'supplier.created', 'item.created', 'ping',
] as const;
const EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

export async function enqueueWebhooks(c: PoolClient, e: { tenantId: string; action: string; entityType?: string; entityId?: string; detail?: Record<string, unknown> }): Promise<void> {
  if (!EVENT_SET.has(e.action)) return;
  const eps = await c.query<{ id: string }>('SELECT id FROM webhook_endpoints WHERE tenant_id = $1 AND is_active AND events @> ARRAY[$2]::text[]', [e.tenantId, e.action]);
  for (const ep of eps.rows) {
    await c.query(
      `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload)
       VALUES ($1, $2, $3::text, jsonb_build_object('event', $3::text, 'occurred_at', now(), 'data', jsonb_build_object('entity_type', $4::text, 'entity_id', $5::text, 'detail', $6::jsonb)))`,
      [e.tenantId, ep.id, e.action, e.entityType ?? null, e.entityId ?? null, JSON.stringify(e.detail ?? {})]);
  }
}
