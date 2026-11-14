import { z } from 'zod';
import { money } from '../ledger/schemas.js';

const isoDate = z.iso.date();
const code = z.string().regex(/^[A-Za-z0-9.-]{1,20}$/);

export const PartyIn = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  tin: z.string().trim().min(1).max(40).optional(),
  terms_days: z.number().int().min(0).max(365).default(30),
});
export type PartyIn = z.infer<typeof PartyIn>;

export const PartyPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(254).nullable(),
    phone: z.string().trim().max(40).nullable(),
    tin: z.string().trim().min(1).max(40).nullable(),
    terms_days: z.number().int().min(0).max(365),
    is_active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type PartyPatch = z.infer<typeof PartyPatch>;

export const TaxCodeIn = z.object({
  code,
  name: z.string().trim().min(1).max(100),
  rate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).refine((v) => Number(v) <= 100, 'Rate must be 0 to 100'),
  kind: z.enum(['output', 'input']),
  account_id: z.uuid(),
});
export type TaxCodeIn = z.infer<typeof TaxCodeIn>;
export const TaxCodePatch = z.object({ is_active: z.boolean() });

const qty = z.string().regex(/^\d{1,11}(\.\d{1,4})?$/).refine((v) => Number(v) > 0, 'Quantity must be above zero');

export const DocumentIn = z.object({
  party_id: z.uuid(),
  doc_date: isoDate,
  due_date: isoDate.optional(),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        account_id: z.uuid(),
        quantity: qty.default('1'),
        unit_price: money,
        tax_code_id: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type DocumentIn = z.infer<typeof DocumentIn>;

export const DocListQuery = z.object({
  status: z.enum(['draft', 'posted', 'void']).optional(),
  party_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export const PartyListQuery = z.object({ active: z.enum(['true', 'false']).optional() });
export const VoidIn = z.object({ void_date: isoDate.optional() }).optional().transform((v) => v ?? {});

export const PaymentIn = z.object({
  party_id: z.uuid(),
  pay_date: isoDate,
  bank_account_id: z.uuid(),
  method: z.enum(['bank', 'cash', 'check', 'card', 'online']).default('bank'),
  reference: z.string().trim().max(100).optional(),
  allocations: z.array(z.object({ document_id: z.uuid(), amount: money })).min(1).max(100),
});
export type PaymentIn = z.infer<typeof PaymentIn>;

export const AgingQuery = z.object({ as_of: isoDate.optional() });
export const VatQuery = z.object({ from: isoDate, to: isoDate });
