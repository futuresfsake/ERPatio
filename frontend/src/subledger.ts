/** Receivables and payables endpoints. One shape serves both sides; the `side` picks the URL names. */
import { api } from './api';

export type Side = 'ar' | 'ap';
export const SIDES = {
  ar: { party: 'customer', parties: 'customers', Party: 'Customer', Parties: 'Customers', doc: 'invoice', docs: 'invoices', Doc: 'Invoice', Docs: 'Invoices', pay: 'receipts', PayOne: 'Receipt', prefix: 'INV', aging: 'receivables', read: 'receivables:read', write: 'receivables:write', paid: 'Received', owed: 'Owed to you' },
  ap: { party: 'supplier', parties: 'suppliers', Party: 'Supplier', Parties: 'Suppliers', doc: 'bill', docs: 'bills', Doc: 'Bill', Docs: 'Bills', pay: 'vendor-payments', PayOne: 'Payment', prefix: 'BILL', aging: 'payables', read: 'payables:read', write: 'payables:write', paid: 'Paid', owed: 'You owe' },
} as const;

export interface Party { id: string; kind: string; code: string; name: string; email: string | null; phone: string | null; has_tin: boolean; terms_days: number; is_active: boolean }
export interface PartyInput { code: string; name: string; email?: string; phone?: string; tin?: string; terms_days: number }
export interface TaxCode { id: string; code: string; name: string; rate: string; kind: 'output' | 'input'; account_id: string; account_code: string; is_active: boolean }

export interface DocLine { line_no: number; description: string; account_id: string; account_code: string; quantity: string; unit_price: string; tax_code_id: string | null; tax_code: string | null; net: string; tax: string }
export interface Doc {
  id: string; kind: 'invoice' | 'bill'; doc_no: string | null; party_id: string; party_code: string; party_name: string; doc_date: string; due_date: string;
  reference: string | null; notes: string | null; status: 'draft' | 'posted' | 'void'; subtotal: string; tax_total: string; total: string; paid_total: string; balance: string;
  journal_entry_id: string | null; void_entry_id: string | null; posted_at: string | null;
}
export interface DocDetail extends Doc { lines: DocLine[]; payments: { payment_id: string; pay_date: string; method: string; reference: string | null; amount: string; voided: boolean }[] }
export interface DocInput {
  party_id: string; doc_date: string; due_date?: string; reference?: string; notes?: string;
  lines: { description: string; account_id: string; quantity: string; unit_price: string; tax_code_id: string | null }[];
}
export interface DocPage { items: Doc[]; total: number; limit: number; offset: number }
export interface PaymentInput { party_id: string; pay_date: string; bank_account_id: string; method: string; reference?: string; allocations: { document_id: string; amount: string }[] }

export interface AgingRow { party_id: string; code: string; name: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string; total: string }
export interface Aging { as_of: string; rows: AgingRow[]; totals: Record<string, string>; ledger_balance: string; reconciles: boolean }
export interface VatReport { from: string; to: string; rows: { code: string; name: string; kind: string; rate: string; base: string; tax: string }[]; output_tax: string; input_tax: string; payable: string }

export interface ClosingPreview { year: number; already_closed: boolean; open_drafts: number; net_income: string; accounts: { account_id: string; code: string; name: string; type: string; balance: string; side: 'debit' | 'credit' }[] }

export const sub = {
  parties: (s: Side) => api<Party[]>(`/${SIDES[s].parties}`),
  createParty: (s: Side, p: PartyInput) => api<Party>(`/${SIDES[s].parties}`, { method: 'POST', json: p }),
  updateParty: (s: Side, id: string, p: Partial<{ is_active: boolean; name: string }>) => api<Party>(`/${SIDES[s].parties}/${id}`, { method: 'PATCH', json: p }),
  docs: (s: Side, status?: string) => api<DocPage>(`/${SIDES[s].docs}?limit=100${status ? `&status=${status}` : ''}`),
  doc: (s: Side, id: string) => api<DocDetail>(`/${SIDES[s].docs}/${id}`),
  createDoc: (s: Side, d: DocInput) => api<DocDetail>(`/${SIDES[s].docs}`, { method: 'POST', json: d }),
  updateDoc: (s: Side, id: string, d: DocInput) => api<DocDetail>(`/${SIDES[s].docs}/${id}`, { method: 'PUT', json: d }),
  deleteDoc: (s: Side, id: string) => api<{ deleted: boolean }>(`/${SIDES[s].docs}/${id}`, { method: 'DELETE' }),
  postDoc: (s: Side, id: string) => api<DocDetail>(`/${SIDES[s].docs}/${id}/post`, { method: 'POST' }),
  voidDoc: (s: Side, id: string) => api<DocDetail>(`/${SIDES[s].docs}/${id}/void`, { method: 'POST', json: {} }),
  pay: (s: Side, p: PaymentInput) => api<{ id: string; amount: string }>(`/${SIDES[s].pay}`, { method: 'POST', json: p }),
  voidPayment: (s: Side, id: string) => api<{ id: string; voided: boolean }>(`/${SIDES[s].pay}/${id}/void`, { method: 'POST', json: {} }),
  closingPreview: (year: number) => api<ClosingPreview>(`/fiscal-years/${year}/closing-preview`),
  closeYear: (year: number) => api<{ year: number; net_income: string }>(`/fiscal-years/${year}/close`, { method: 'POST' }),
  taxCodes: () => api<TaxCode[]>('/tax-codes'),
  aging: (s: Side, asOf: string) => api<Aging>(`/reports/aging/${SIDES[s].aging}?as_of=${asOf}`),
  vat: (from: string, to: string) => api<VatReport>(`/reports/vat?from=${from}&to=${to}`),
};
