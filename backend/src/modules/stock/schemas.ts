import { z } from 'zod';

const isoDate = z.iso.date();
const qty = z.string().regex(/^\d{1,11}(\.\d{1,4})?$/).refine((v) => Number(v) > 0, 'Quantity must be above zero');
const cost = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Amount must be a decimal with at most 4 places');

export const ItemIn = z.object({
  sku: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  name: z.string().trim().min(1).max(200),
  uom: z.string().trim().min(1).max(20).default('pc'),
});
export type ItemIn = z.infer<typeof ItemIn>;
export const ItemPatch = z
  .object({ name: z.string().trim().min(1).max(200), uom: z.string().trim().min(1).max(20), is_active: z.boolean(), reorder_level: cost })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type ItemPatch = z.infer<typeof ItemPatch>;

export const PoIn = z.object({
  party_id: z.uuid(), order_date: isoDate, reference: z.string().trim().max(100).optional(),
  lines: z.array(z.object({ item_id: z.uuid(), quantity: qty, unit_cost: cost })).min(1).max(100),
});
export type PoIn = z.infer<typeof PoIn>;
export const SoIn = z.object({
  party_id: z.uuid(), order_date: isoDate, reference: z.string().trim().max(100).optional(),
  lines: z.array(z.object({ item_id: z.uuid(), quantity: qty, unit_price: cost })).min(1).max(100),
});
export type SoIn = z.infer<typeof SoIn>;

export const ReceiveIn = z.object({
  date: isoDate,
  lines: z.array(z.object({ line_id: z.uuid(), quantity: qty })).min(1).max(100),
});
export type ReceiveIn = z.infer<typeof ReceiveIn>;

export const FromOrderIn = z.object({ doc_date: isoDate.optional(), tax_code_id: z.uuid().nullable().optional() }).optional().transform((v) => v ?? {});
export type FromOrderIn = z.infer<typeof FromOrderIn>;

export const AdjustIn = z.object({
  item_id: z.uuid(), date: isoDate, direction: z.enum(['in', 'out']), quantity: qty,
  unit_cost: cost.optional(), reason: z.string().trim().min(3).max(300),
});
export type AdjustIn = z.infer<typeof AdjustIn>;

export const OrderListQuery = z.object({
  status: z.enum(['draft', 'open', 'closed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export const AsOfQuery = z.object({ as_of: isoDate.optional() });
