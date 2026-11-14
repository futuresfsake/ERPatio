import { z } from 'zod';
import { money } from '../ledger/schemas.js';

/** A draft is work in progress: it may be empty or unbalanced. Balance is enforced when it is submitted or posted. */
export const DraftIn = z.object({
  entry_date: z.iso.date(),
  description: z.string().trim().max(500).default(''),
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
    .max(200)
    .default([]),
});
export type DraftIn = z.infer<typeof DraftIn>;

export const DraftQuery = z.object({ status: z.enum(['draft', 'submitted']).optional() });
export const RejectBody = z.object({ note: z.string().trim().min(3).max(300) });
