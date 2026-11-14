import { z } from 'zod';
import { isMoney } from '../../lib/money.js';

export const money = z.string().refine(isMoney, 'Amount must be a decimal with at most 4 places');
const isoDate = z.iso.date();

export const AccountIn = z.object({
  code: z.string().regex(/^[A-Za-z0-9.-]{1,20}$/),
  name: z.string().trim().min(1).max(200),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
});
export type AccountIn = z.infer<typeof AccountIn>;

export const AccountPatch = z
  .object({ name: z.string().trim().min(1).max(200), is_active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type AccountPatch = z.infer<typeof AccountPatch>;

export const EntryIn = z.object({
  entry_date: isoDate,
  description: z.string().trim().min(1).max(500),
  reference: z.string().max(100).optional(),
  lines: z
    .array(
      z.object({
        account_id: z.uuid(),
        debit: money.default('0'),
        credit: money.default('0'),
        memo: z.string().max(500).optional(),
      }),
    )
    .min(2)
    .max(200),
});
export type EntryIn = z.infer<typeof EntryIn>;

export const IdParam = z.object({ id: z.uuid() });
export const ReverseIn = z.object({ entry_date: isoDate.optional() }).optional().transform((v) => v ?? {});
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export const TbQuery = z.object({ as_of: isoDate.optional() });
export const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
