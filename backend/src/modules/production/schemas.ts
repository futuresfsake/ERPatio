import { z } from 'zod';

const isoDate = z.iso.date();
const qty = z.string().regex(/^\d{1,11}(\.\d{1,4})?$/).refine((v) => Number(v) > 0, 'Quantity must be above zero');
const money = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Amount must be a decimal with at most 4 places');

export const BomIn = z.object({
  item_id: z.uuid(),
  output_qty: qty,
  note: z.string().trim().max(300).optional(),
  lines: z.array(z.object({ item_id: z.uuid(), quantity: qty })).min(1).max(100),
});
export type BomIn = z.infer<typeof BomIn>;

export const WoIn = z.object({
  item_id: z.uuid(),
  quantity: qty,
  planned_date: isoDate,
  reference: z.string().trim().max(100).optional(),
});
export type WoIn = z.infer<typeof WoIn>;

export const IssueIn = z.object({
  date: isoDate,
  lines: z.array(z.object({ item_id: z.uuid(), quantity: qty })).min(1).max(100).optional(),
});
export type IssueIn = z.infer<typeof IssueIn>;

export const CompleteIn = z.object({ date: isoDate, quantity: qty, conversion_cost: money.default('0') });
export type CompleteIn = z.infer<typeof CompleteIn>;
export const CloseIn = z.object({ date: isoDate });

export const WoListQuery = z.object({
  status: z.enum(['draft', 'released', 'completed', 'closed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export const BomListQuery = z.object({ item_id: z.uuid().optional() });
