/**
 * Receivables and payables (customers, suppliers, invoices, bills, receipts, payments, tax codes, aging).
 * Every posting writes a balanced journal entry in the same transaction, so the subledger and the ledger cannot drift.
 * Amounts are bigint units (4 places) in code; each line is rounded to the cent, half up.
 */
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { insertEntry } from '../ledger/service.js';
import type { EntryIn } from '../ledger/schemas.js';
import type { DocumentIn, PartyIn, PartyPatch, PaymentIn, TaxCodeIn } from './schemas.js';

export type DocKind = 'invoice' | 'bill';
export type PartyKind = 'customer' | 'supplier';

const CENT = 100n; // units per 0.01

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ parties
const PARTY_COLS = 'id, kind, code, name, email, phone, (tin_enc IS NOT NULL) AS has_tin, terms_days, is_active';

export const listParties = (p: Principal, kind: PartyKind, active?: string) =>
  withTenant(p.tenantId, async (c) =>
    (await c.query(
      'SELECT ' + PARTY_COLS + ' FROM parties WHERE tenant_id = $1 AND kind = $2 AND ($3::boolean IS NULL OR is_active = $3::boolean) ORDER BY code',
      [p.tenantId, kind, active === undefined ? null : active === 'true'],
    )).rows);

export const createParty = (p: Principal, kind: PartyKind, a: PartyIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const tin = a.tin ? await encryptField(c, p.tenantId, a.tin) : null;
    const { rows } = await c.query(
      'INSERT INTO parties (tenant_id, kind, code, name, email, phone, tin_enc, terms_days) ' +
      'VALUES ($1, $2, upper($3), $4, $5, $6, $7, $8) RETURNING ' + PARTY_COLS,
      [p.tenantId, kind, a.code, a.name, a.email ?? null, a.phone ?? null, tin, a.terms_days],
    );
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.created`, actorUserId: p.userId, entityType: 'party', entityId: rows[0].id, ip, detail: { code: rows[0].code } });
    return rows[0];
  });

export const updateParty = (p: Principal, kind: PartyKind, id: string, patch: PartyPatch, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const has = (k: keyof PartyPatch) => k in patch;
    const tin = patch.tin ? await encryptField(c, p.tenantId, patch.tin) : null;
    const { rows } = await c.query(
      `UPDATE parties SET
         name = COALESCE($4, name),
         email = CASE WHEN $5 THEN $6 ELSE email END,
         phone = CASE WHEN $7 THEN $8 ELSE phone END,
         tin_enc = CASE WHEN $9 THEN $10 ELSE tin_enc END,
         terms_days = COALESCE($11, terms_days),
         is_active = COALESCE($12, is_active)
       WHERE tenant_id = $1 AND kind = $2 AND id = $3 RETURNING ` + PARTY_COLS,
      [p.tenantId, kind, id, patch.name ?? null, has('email'), patch.email ?? null, has('phone'), patch.phone ?? null,
        has('tin'), tin, patch.terms_days ?? null, patch.is_active ?? null],
    );
    if (!rows[0]) throw notFound(kind === 'customer' ? 'Customer' : 'Supplier');
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.updated`, actorUserId: p.userId, entityType: 'party', entityId: id, ip, detail: { fields: Object.keys(patch).sort() } });
    return rows[0];
  });

/** The tax identification number is shown only on request, decrypted, and the read is audited. */
export const revealTin = (p: Principal, kind: PartyKind, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = (await c.query<{ tin_enc: string | null }>('SELECT tin_enc FROM parties WHERE tenant_id = $1 AND kind = $2 AND id = $3', [p.tenantId, kind, id])).rows[0];
    if (!r) throw notFound(kind === 'customer' ? 'Customer' : 'Supplier');
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.tin_viewed`, actorUserId: p.userId, entityType: 'party', entityId: id, ip });
    return { tin: r.tin_enc ? await decryptField(c, p.tenantId, r.tin_enc) : null };
  });

// ------------------------------------------------------------------ tax codes
const TAX_SELECT =
  'SELECT t.id, t.code, t.name, t.rate::text, t.kind, t.account_id, a.code AS account_code, t.is_active ' +
  'FROM tax_codes t JOIN accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id';

export const listTaxCodes = (p: Principal) =>
  withTenant(p.tenantId, async (c) =>
    (await c.query(TAX_SELECT + ' WHERE t.tenant_id = $1 ORDER BY t.code', [p.tenantId])).rows);

export const createTaxCode = (p: Principal, a: TaxCodeIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const acct = await c.query('SELECT 1 FROM accounts WHERE tenant_id = $1 AND id = $2 AND is_active', [p.tenantId, a.account_id]);
    if (!acct.rowCount) throw new ApiError(422, 'invalid_account', 'The tax account must exist and be active.');
    const ins = await c.query(
      'INSERT INTO tax_codes (tenant_id, code, name, rate, kind, account_id) VALUES ($1, upper($2), $3, $4, $5, $6) RETURNING id',
      [p.tenantId, a.code, a.name, a.rate, a.kind, a.account_id],
    );
    await recordAudit(c, { tenantId: p.tenantId, action: 'tax_code.created', actorUserId: p.userId, entityType: 'tax_code', entityId: ins.rows[0].id, ip, detail: { code: a.code.toUpperCase(), rate: a.rate } });
    return (await c.query(TAX_SELECT + ' WHERE t.tenant_id = $1 AND t.id = $2', [p.tenantId, ins.rows[0].id])).rows[0];
  });

export const setTaxCodeActive = (p: Principal, id: string, active: boolean, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = await c.query('UPDATE tax_codes SET is_active = $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, id, active]);
    if (!r.rowCount) throw notFound('Tax code');
    await recordAudit(c, { tenantId: p.tenantId, action: 'tax_code.updated', actorUserId: p.userId, entityType: 'tax_code', entityId: id, ip, detail: { is_active: active } });
    return (await c.query(TAX_SELECT + ' WHERE t.tenant_id = $1 AND t.id = $2', [p.tenantId, id])).rows[0];
  });

// ------------------------------------------------------------------ documents
const partyKindFor = (k: DocKind): PartyKind => (k === 'invoice' ? 'customer' : 'supplier');

interface Computed { lines: { net: bigint; tax: bigint }[]; subtotal: bigint; tax: bigint; total: bigint }

/** Totals from the lines. The tax code must be active and of the right side (output on invoices, input on bills). */
async function compute(c: PoolClient, tenantId: string, kind: DocKind, data: DocumentIn): Promise<Computed> {
  const codeIds = [...new Set(data.lines.map((l) => l.tax_code_id).filter((x): x is string => !!x))];
  const rates = new Map<string, bigint>();
  if (codeIds.length) {
    const { rows } = await c.query<{ id: string; rate: string; kind: string }>(
      'SELECT id, rate::text, kind FROM tax_codes WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND is_active', [tenantId, codeIds]);
    const wanted = kind === 'invoice' ? 'output' : 'input';
    for (const r of rows) {
      if (r.kind !== wanted) throw new ApiError(422, 'invalid_tax_code', `A ${kind} can only use ${wanted} tax codes.`);
      rates.set(r.id, toUnits(r.rate));
    }
    if (rates.size !== codeIds.length) throw new ApiError(422, 'invalid_tax_code', 'Every tax code must exist and be active.');
  }
  const acctIds = [...new Set(data.lines.map((l) => l.account_id))];
  const ok = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND is_active', [tenantId, acctIds])).rows[0]?.n);
  if (ok !== acctIds.length) throw new ApiError(422, 'invalid_account', 'Every line must use an existing, active account.');

  const out: Computed = { lines: [], subtotal: 0n, tax: 0n, total: 0n };
  for (const l of data.lines) {
    const net = ((toUnits(l.quantity) * toUnits(l.unit_price) + 500000n) / 1000000n) * CENT;
    const rate = l.tax_code_id ? (rates.get(l.tax_code_id) ?? 0n) : 0n;
    const tax = (((net * rate) / 100n + 500000n) / 1000000n) * CENT;
    out.lines.push({ net, tax });
    out.subtotal += net;
    out.tax += tax;
  }
  out.total = out.subtotal + out.tax;
  if (out.total <= 0n) throw new ApiError(422, 'invalid_total', 'The document total must be above zero.');
  return out;
}

async function assertParty(c: PoolClient, tenantId: string, kind: DocKind, partyId: string) {
  const r = (await c.query<{ kind: string; is_active: boolean; terms_days: number }>('SELECT kind, is_active, terms_days FROM parties WHERE tenant_id = $1 AND id = $2', [tenantId, partyId])).rows[0];
  if (!r || r.kind !== partyKindFor(kind)) throw new ApiError(422, 'invalid_party', `Choose an existing ${partyKindFor(kind)}.`);
  if (!r.is_active) throw new ApiError(422, 'inactive_party', 'This party is inactive.');
  return r;
}

async function writeLines(c: PoolClient, tenantId: string, docId: string, data: DocumentIn, calc: Computed) {
  await c.query('DELETE FROM document_lines WHERE tenant_id = $1 AND document_id = $2', [tenantId, docId]);
  await c.query(
    `INSERT INTO document_lines (tenant_id, document_id, line_no, description, account_id, quantity, unit_price, tax_code_id, net, tax, po_line_id, so_line_id)
     SELECT $1, $2, t.n, t.d, t.a, t.q, t.p, t.x, t.net, t.tax, t.po, t.so
       FROM unnest($3::text[], $4::uuid[], $5::numeric[], $6::numeric[], $7::uuid[], $8::numeric[], $9::numeric[], $10::uuid[], $11::uuid[]) WITH ORDINALITY AS t(d, a, q, p, x, net, tax, po, so, n)`,
    [tenantId, docId, data.lines.map((l) => l.description), data.lines.map((l) => l.account_id), data.lines.map((l) => l.quantity),
      data.lines.map((l) => l.unit_price), data.lines.map((l) => l.tax_code_id ?? null),
      calc.lines.map((l) => fromUnits(l.net)), calc.lines.map((l) => fromUnits(l.tax)),
      data.lines.map((l) => l.po_line_id ?? null), data.lines.map((l) => l.so_line_id ?? null)],
  );
}

const DOC_SELECT = `
  SELECT d.id, d.kind, d.doc_no, d.party_id, p.code AS party_code, p.name AS party_name, d.doc_date, d.due_date, d.reference, d.notes,
         d.status, d.subtotal::text, d.tax_total::text, d.total::text, d.paid_total::text, (d.total - d.paid_total)::text AS balance,
         d.journal_entry_id, d.void_entry_id, d.created_at, d.posted_at
    FROM documents d JOIN parties p ON p.id = d.party_id AND p.tenant_id = d.tenant_id`;

async function loadDoc(c: PoolClient, tenantId: string, kind: DocKind, id: string) {
  const d = (await c.query(DOC_SELECT + ' WHERE d.tenant_id = $1 AND d.kind = $2 AND d.id = $3', [tenantId, kind, id])).rows[0];
  if (!d) throw notFound(kind === 'invoice' ? 'Invoice' : 'Bill');
  const lines = (await c.query(
    `SELECT l.line_no, l.description, l.account_id, a.code AS account_code, l.quantity::text, l.unit_price::text,
            l.tax_code_id, t.code AS tax_code, l.net::text, l.tax::text, l.po_line_id, l.so_line_id
       FROM document_lines l JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
       LEFT JOIN tax_codes t ON t.id = l.tax_code_id AND t.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.document_id = $2 ORDER BY l.line_no`, [tenantId, id])).rows;
  const payments = (await c.query(
    `SELECT a.payment_id, y.pay_date, y.method, y.reference, a.amount::text, (v.payment_id IS NOT NULL) AS voided FROM payment_allocations a
       JOIN payments y ON y.id = a.payment_id AND y.tenant_id = a.tenant_id
       LEFT JOIN payment_voids v ON v.payment_id = y.id AND v.tenant_id = y.tenant_id
      WHERE a.tenant_id = $1 AND a.document_id = $2 ORDER BY y.pay_date, y.created_at`, [tenantId, id])).rows;
  return { ...d, lines, payments };
}

export const listDocuments = (p: Principal, kind: DocKind, q: { status?: string; party_id?: string; limit: number; offset: number }) =>
  withTenant(p.tenantId, async (c) => {
    const args = [p.tenantId, kind, q.status ?? null, q.party_id ?? null];
    const where = 'd.tenant_id = $1 AND d.kind = $2 AND ($3::text IS NULL OR d.status = $3) AND ($4::uuid IS NULL OR d.party_id = $4)';
    const total = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM documents d WHERE ' + where, args)).rows[0]?.n ?? 0);
    const rows = (await c.query(DOC_SELECT + ' WHERE ' + where + ' ORDER BY d.doc_date DESC, d.doc_no DESC NULLS FIRST, d.created_at DESC LIMIT $5 OFFSET $6', [...args, q.limit, q.offset])).rows;
    return { items: rows, total, limit: q.limit, offset: q.offset };
  });

export const getDocument = (p: Principal, kind: DocKind, id: string) => withTenant(p.tenantId, (c) => loadDoc(c, p.tenantId, kind, id));

export const createDraft = (p: Principal, kind: DocKind, data: DocumentIn, ip?: string) =>
  withTenant(p.tenantId, (c) => createDraftInTx(c, p, kind, data, ip));

export async function createDraftInTx(c: PoolClient, p: Principal, kind: DocKind, data: DocumentIn, ip?: string) {
  {
    const party = await assertParty(c, p.tenantId, kind, data.party_id);
    const due = data.due_date ?? addDays(data.doc_date, party.terms_days);
    if (due < data.doc_date) throw new ApiError(422, 'invalid_due_date', 'The due date cannot be before the document date.');
    const calc = await compute(c, p.tenantId, kind, data);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, kind, party_id, doc_date, due_date, reference, notes, subtotal, tax_total, total, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [p.tenantId, kind, data.party_id, data.doc_date, due, data.reference ?? null, data.notes ?? null,
        fromUnits(calc.subtotal), fromUnits(calc.tax), fromUnits(calc.total), p.userId],
    );
    await writeLines(c, p.tenantId, rows[0]!.id, data, calc);
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.draft_created`, actorUserId: p.userId, entityType: 'document', entityId: rows[0]!.id, ip, detail: { total: fromUnits(calc.total) } });
    return loadDoc(c, p.tenantId, kind, rows[0]!.id);
  }
}

async function lockDraft(c: PoolClient, tenantId: string, kind: DocKind, id: string) {
  const d = (await c.query<{ status: string }>('SELECT status FROM documents WHERE tenant_id = $1 AND kind = $2 AND id = $3 FOR UPDATE', [tenantId, kind, id])).rows[0];
  if (!d) throw notFound(kind === 'invoice' ? 'Invoice' : 'Bill');
  if (d.status !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft can be changed. Void a posted document instead.');
}

export const updateDraft = (p: Principal, kind: DocKind, id: string, data: DocumentIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await lockDraft(c, p.tenantId, kind, id);
    const party = await assertParty(c, p.tenantId, kind, data.party_id);
    const due = data.due_date ?? addDays(data.doc_date, party.terms_days);
    if (due < data.doc_date) throw new ApiError(422, 'invalid_due_date', 'The due date cannot be before the document date.');
    const calc = await compute(c, p.tenantId, kind, data);
    await c.query(
      `UPDATE documents SET party_id = $3, doc_date = $4, due_date = $5, reference = $6, notes = $7, subtotal = $8, tax_total = $9, total = $10
        WHERE tenant_id = $1 AND id = $2`,
      [p.tenantId, id, data.party_id, data.doc_date, due, data.reference ?? null, data.notes ?? null, fromUnits(calc.subtotal), fromUnits(calc.tax), fromUnits(calc.total)],
    );
    await writeLines(c, p.tenantId, id, data, calc);
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.draft_updated`, actorUserId: p.userId, entityType: 'document', entityId: id, ip, detail: { total: fromUnits(calc.total) } });
    return loadDoc(c, p.tenantId, kind, id);
  });

export const deleteDraft = (p: Principal, kind: DocKind, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await lockDraft(c, p.tenantId, kind, id);
    await c.query('DELETE FROM documents WHERE tenant_id = $1 AND id = $2', [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.draft_deleted`, actorUserId: p.userId, entityType: 'document', entityId: id, ip });
    return { deleted: true };
  });

async function controlAccount(c: PoolClient, tenantId: string, kind: DocKind): Promise<string> {
  const col = kind === 'invoice' ? 'ar_account_id' : 'ap_account_id'; // constant, never from input
  const r = (await c.query<{ id: string | null }>('SELECT ' + col + ' AS id FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!r?.id) throw new ApiError(409, 'no_control_account', `Set the ${kind === 'invoice' ? 'receivables' : 'payables'} control account in settings first.`);
  return r.id;
}

export const postDocument = (p: Principal, kind: DocKind, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await lockDraft(c, p.tenantId, kind, id);
    const doc = (await c.query<{ party_id: string; doc_date: string; reference: string | null }>(
      'SELECT party_id, doc_date::text, reference FROM documents WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0]!;
    const party = (await c.query<{ code: string; name: string; is_active: boolean }>('SELECT code, name, is_active FROM parties WHERE tenant_id = $1 AND id = $2', [p.tenantId, doc.party_id])).rows[0]!;
    if (!party.is_active) throw new ApiError(422, 'inactive_party', 'This party is inactive.');
    const lines = (await c.query<{ description: string; account_id: string; net: string; tax: string; tax_account_id: string | null; quantity: string; po_line_id: string | null; so_line_id: string | null }>(
      `SELECT l.description, l.account_id, l.net::text, l.tax::text, t.account_id AS tax_account_id, l.quantity::text, l.po_line_id, l.so_line_id
         FROM document_lines l LEFT JOIN tax_codes t ON t.id = l.tax_code_id AND t.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1 AND l.document_id = $2 ORDER BY l.line_no`, [p.tenantId, id])).rows;

    // Recompute from the stored lines: the totals on the row are never trusted at posting time.
    let subtotal = 0n;
    let tax = 0n;
    const taxByAccount = new Map<string, bigint>();
    for (const l of lines) {
      subtotal += toUnits(l.net);
      tax += toUnits(l.tax);
      if (l.tax_account_id && toUnits(l.tax) > 0n) taxByAccount.set(l.tax_account_id, (taxByAccount.get(l.tax_account_id) ?? 0n) + toUnits(l.tax));
    }
    const total = subtotal + tax;
    if (total <= 0n) throw new ApiError(422, 'invalid_total', 'The document total must be above zero.');

    // Billing or invoicing an order line is counted here, at posting, so two drafts cannot bill the same goods twice.
    for (const l of lines) {
      const link = kind === 'bill' ? l.po_line_id : l.so_line_id;
      if (!link) continue;
      const tbl = kind === 'bill' ? 'purchase_order_lines SET billed_qty = billed_qty + $3 WHERE tenant_id = $1 AND id = $2 AND billed_qty + $3 <= received_qty'
        : 'sales_order_lines SET invoiced_qty = invoiced_qty + $3 WHERE tenant_id = $1 AND id = $2 AND invoiced_qty + $3 <= delivered_qty';
      const done = await c.query('UPDATE ' + tbl, [p.tenantId, link, l.quantity]);
      if (!done.rowCount) throw new ApiError(409, 'over_billing', `${kind === 'bill' ? 'Billing' : 'Invoicing'} more than has been ${kind === 'bill' ? 'received' : 'delivered'} and not yet ${kind === 'bill' ? 'billed' : 'invoiced'}.`);
    }

    const control = await controlAccount(c, p.tenantId, kind);
    const no = (await c.query<{ seq: string }>('UPDATE doc_counters SET seq = seq + 1 WHERE tenant_id = $1 AND kind = $2 RETURNING seq', [p.tenantId, kind])).rows[0]!.seq;
    const label = `${kind === 'invoice' ? 'INV' : 'BILL'}-${no}`;

    const je: EntryIn['lines'] = [];
    const side = (amount: bigint, debit: boolean) => ({ debit: debit ? fromUnits(amount) : '0', credit: debit ? '0' : fromUnits(amount) });
    if (kind === 'invoice') {
      je.push({ account_id: control, ...side(total, true), memo: `${label} ${party.name}` });
      for (const l of lines) if (toUnits(l.net) > 0n) je.push({ account_id: l.account_id, ...side(toUnits(l.net), false), memo: l.description.slice(0, 500) });
      for (const [acct, amt] of taxByAccount) je.push({ account_id: acct, ...side(amt, false), memo: `${label} output tax` });
    } else {
      for (const l of lines) if (toUnits(l.net) > 0n) je.push({ account_id: l.account_id, ...side(toUnits(l.net), true), memo: l.description.slice(0, 500) });
      for (const [acct, amt] of taxByAccount) je.push({ account_id: acct, ...side(amt, true), memo: `${label} input tax` });
      je.push({ account_id: control, ...side(total, false), memo: `${label} ${party.name}` });
    }
    const entryId = await insertEntry(c, p, {
      entry_date: doc.doc_date,
      description: `${kind === 'invoice' ? 'Invoice' : 'Bill'} ${label} - ${party.name}`.slice(0, 500),
      reference: doc.reference ?? label,
      lines: je,
    }, ip, null, { detail: { document: label } });
    await c.query(
      `UPDATE documents SET status = 'posted', doc_no = $3, subtotal = $4, tax_total = $5, total = $6, journal_entry_id = $7, posted_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [p.tenantId, id, no, fromUnits(subtotal), fromUnits(tax), fromUnits(total), entryId],
    );
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.posted`, actorUserId: p.userId, entityType: 'document', entityId: id, ip, detail: { doc_no: Number(no), total: fromUnits(total) } });
    return loadDoc(c, p.tenantId, kind, id);
  });

/** Voiding reverses the ledger entry and frees nothing: the number stays used, the document stays on record. */
export const voidDocument = (p: Principal, kind: DocKind, id: string, on: string | undefined, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const d = (await c.query<{ status: string; paid_total: string; journal_entry_id: string | null; doc_no: string }>(
      'SELECT status, paid_total::text, journal_entry_id, doc_no FROM documents WHERE tenant_id = $1 AND kind = $2 AND id = $3 FOR UPDATE', [p.tenantId, kind, id])).rows[0];
    if (!d) throw notFound(kind === 'invoice' ? 'Invoice' : 'Bill');
    if (d.status !== 'posted' || !d.journal_entry_id) throw new ApiError(409, 'not_posted', 'Only a posted document can be voided.');
    if (toUnits(d.paid_total) > 0n) throw new ApiError(409, 'has_payments', 'This document has payments against it. Reverse them before voiding.');
    const lines = (await c.query<{ account_id: string; debit: string; credit: string; memo: string | null }>(
      'SELECT account_id, debit::text, credit::text, memo FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no', [p.tenantId, d.journal_entry_id])).rows;
    const label = `${kind === 'invoice' ? 'INV' : 'BILL'}-${d.doc_no}`;
    const entryId = await insertEntry(c, p, {
      entry_date: on ?? today(),
      description: `Void of ${label}`,
      reference: `VOID-${label}`,
      lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined })),
    }, ip, d.journal_entry_id, { detail: { document: label, void: true } });
    await c.query("UPDATE documents SET status = 'void', void_entry_id = $3 WHERE tenant_id = $1 AND id = $2", [p.tenantId, id, entryId]);
    await c.query('UPDATE purchase_order_lines o SET billed_qty = o.billed_qty - l.quantity FROM document_lines l WHERE l.tenant_id = $1 AND l.document_id = $2 AND l.po_line_id = o.id AND o.tenant_id = $1', [p.tenantId, id]);
    await c.query('UPDATE sales_order_lines o SET invoiced_qty = o.invoiced_qty - l.quantity FROM document_lines l WHERE l.tenant_id = $1 AND l.document_id = $2 AND l.so_line_id = o.id AND o.tenant_id = $1', [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.voided`, actorUserId: p.userId, entityType: 'document', entityId: id, ip, detail: { doc_no: Number(d.doc_no) } });
    return loadDoc(c, p.tenantId, kind, id);
  });

// ------------------------------------------------------------------ payments
export const recordPayment = (p: Principal, kind: 'receipt' | 'payment', data: PaymentIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const docKind: DocKind = kind === 'receipt' ? 'invoice' : 'bill';
    const party = (await c.query<{ kind: string; name: string }>('SELECT kind, name FROM parties WHERE tenant_id = $1 AND id = $2', [p.tenantId, data.party_id])).rows[0];
    if (!party || party.kind !== partyKindFor(docKind)) throw new ApiError(422, 'invalid_party', `Choose an existing ${partyKindFor(docKind)}.`);
    const bank = await c.query("SELECT 1 FROM accounts WHERE tenant_id = $1 AND id = $2 AND is_active AND type = 'asset'", [p.tenantId, data.bank_account_id]);
    if (!bank.rowCount) throw new ApiError(422, 'invalid_account', 'The cash or bank account must be an active asset account.');

    const ids = data.allocations.map((a) => a.document_id);
    if (new Set(ids).size !== ids.length) throw new ApiError(422, 'duplicate_allocation', 'Each document can appear once.');
    // Lock in a fixed order so two payments against the same documents cannot deadlock.
    const docs = (await c.query<{ id: string; status: string; party_id: string; total: string; paid_total: string; doc_no: string }>(
      `SELECT id, status, party_id, total::text, paid_total::text, doc_no FROM documents
        WHERE tenant_id = $1 AND kind = $2 AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE`, [p.tenantId, docKind, ids])).rows;
    if (docs.length !== ids.length) throw new ApiError(422, 'invalid_document', 'Every allocation must point at an existing document of the right kind.');
    const byId = new Map(docs.map((d) => [d.id, d]));

    let amount = 0n;
    for (const a of data.allocations) {
      const d = byId.get(a.document_id)!;
      const part = toUnits(a.amount);
      if (part <= 0n) throw new ApiError(422, 'invalid_amount', 'Allocation amounts must be above zero.');
      if (d.status !== 'posted') throw new ApiError(409, 'not_posted', 'You can only pay a posted document.');
      if (d.party_id !== data.party_id) throw new ApiError(422, 'party_mismatch', 'Every document must belong to the chosen party.');
      if (part > toUnits(d.total) - toUnits(d.paid_total)) throw new ApiError(422, 'over_allocation', `The allocation exceeds what is still owed on ${docKind === 'invoice' ? 'INV' : 'BILL'}-${d.doc_no}.`);
      amount += part;
    }

    const control = await controlAccount(c, p.tenantId, docKind);
    const label = kind === 'receipt' ? 'Receipt' : 'Payment';
    const je: EntryIn['lines'] = kind === 'receipt'
      ? [{ account_id: data.bank_account_id, debit: fromUnits(amount), credit: '0', memo: `${label} from ${party.name}` }, { account_id: control, debit: '0', credit: fromUnits(amount), memo: `${label} from ${party.name}` }]
      : [{ account_id: control, debit: fromUnits(amount), credit: '0', memo: `${label} to ${party.name}` }, { account_id: data.bank_account_id, debit: '0', credit: fromUnits(amount), memo: `${label} to ${party.name}` }];
    const entryId = await insertEntry(c, p, {
      entry_date: data.pay_date, description: `${label} - ${party.name}`.slice(0, 500), reference: data.reference, lines: je,
    }, ip, null, { detail: { payment: kind } });

    const pay = (await c.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, kind, party_id, pay_date, amount, method, bank_account_id, reference, journal_entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [p.tenantId, kind, data.party_id, data.pay_date, fromUnits(amount), data.method, data.bank_account_id, data.reference ?? null, entryId, p.userId])).rows[0]!;
    for (const a of data.allocations) {
      await c.query('INSERT INTO payment_allocations (tenant_id, payment_id, document_id, amount) VALUES ($1, $2, $3, $4)', [p.tenantId, pay.id, a.document_id, a.amount]);
      await c.query('UPDATE documents SET paid_total = paid_total + $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, a.document_id, a.amount]);
    }
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.recorded`, actorUserId: p.userId, entityType: 'payment', entityId: pay.id, ip, detail: { amount: fromUnits(amount), documents: ids.length } });
    return { id: pay.id, kind, party_id: data.party_id, pay_date: data.pay_date, amount: fromUnits(amount), journal_entry_id: entryId };
  });

export const listPayments = (p: Principal, kind: 'receipt' | 'payment', limit: number, offset: number) =>
  withTenant(p.tenantId, async (c) => {
    const total = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM payments WHERE tenant_id = $1 AND kind = $2', [p.tenantId, kind])).rows[0]?.n ?? 0);
    const rows = (await c.query(
      `SELECT y.id, y.kind, y.party_id, p.name AS party_name, y.pay_date, y.amount::text, y.method, y.reference, y.journal_entry_id, (v.payment_id IS NOT NULL) AS voided
         FROM payments y JOIN parties p ON p.id = y.party_id AND p.tenant_id = y.tenant_id
         LEFT JOIN payment_voids v ON v.payment_id = y.id AND v.tenant_id = y.tenant_id
        WHERE y.tenant_id = $1 AND y.kind = $2 ORDER BY y.pay_date DESC, y.created_at DESC LIMIT $3 OFFSET $4`, [p.tenantId, kind, limit, offset])).rows;
    return { items: rows, total, limit, offset };
  });

// ------------------------------------------------------------------ reports
/** Open items grouped by days past due, as of a date. Payments dated after the cut-off do not count. */
export const aging = (p: Principal, kind: DocKind, asOf: string) =>
  withTenant(p.tenantId, async (c) => {
    const rows = (await c.query<Record<string, string>>(
      `WITH items AS (
         SELECT d.party_id, d.due_date,
                d.total - COALESCE((SELECT sum(a.amount) FROM payment_allocations a JOIN payments y ON y.id = a.payment_id AND y.tenant_id = a.tenant_id
                                     WHERE a.tenant_id = d.tenant_id AND a.document_id = d.id AND y.pay_date <= $3::date
                                       AND NOT EXISTS (SELECT 1 FROM payment_voids v WHERE v.tenant_id = y.tenant_id AND v.payment_id = y.id AND v.void_date <= $3::date)), 0) AS owed,
                ($3::date - d.due_date) AS late
           FROM documents d
          WHERE d.tenant_id = $1 AND d.kind = $2 AND d.status = 'posted' AND d.doc_date <= $3::date)
       SELECT p.id AS party_id, p.code, p.name,
              COALESCE(sum(owed) FILTER (WHERE late <= 0), 0)::text AS current,
              COALESCE(sum(owed) FILTER (WHERE late BETWEEN 1 AND 30), 0)::text AS d1_30,
              COALESCE(sum(owed) FILTER (WHERE late BETWEEN 31 AND 60), 0)::text AS d31_60,
              COALESCE(sum(owed) FILTER (WHERE late BETWEEN 61 AND 90), 0)::text AS d61_90,
              COALESCE(sum(owed) FILTER (WHERE late > 90), 0)::text AS d90_plus,
              sum(owed)::text AS total
         FROM items JOIN parties p ON p.id = items.party_id AND p.tenant_id = $1
        WHERE owed > 0 GROUP BY p.id, p.code, p.name ORDER BY p.code`, [p.tenantId, kind, asOf])).rows;
    const keys = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'total'] as const;
    const sums: Record<string, bigint> = Object.fromEntries(keys.map((k) => [k, 0n]));
    for (const r of rows) for (const k of keys) sums[k]! += toUnits(r[k]!);

    // The control account in the ledger should agree with the open items; manual entries to it show up as a difference.
    const col = kind === 'invoice' ? 'ar_account_id' : 'ap_account_id';
    const sign = kind === 'invoice' ? 'l.debit - l.credit' : 'l.credit - l.debit';
    const gl = (await c.query<{ bal: string | null }>(
      'SELECT sum(' + sign + ')::text AS bal FROM journal_lines l ' +
      'JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id AND e.entry_date <= $2::date ' +
      'WHERE l.tenant_id = $1 AND l.account_id = (SELECT ' + col + ' FROM tenant_settings WHERE tenant_id = $1)', [p.tenantId, asOf])).rows[0]?.bal ?? '0';
    return {
      as_of: asOf, kind, rows,
      totals: Object.fromEntries(keys.map((k) => [k, fromUnits(sums[k]!)])),
      ledger_balance: fromUnits(toUnits(gl)),
      reconciles: toUnits(gl) === sums.total,
    };
  });

/** Output tax on invoices against input tax on bills for a date range, by tax code. */
export const vatReport = (p: Principal, from: string, to: string) =>
  withTenant(p.tenantId, async (c) => {
    const rows = (await c.query<{ code: string; name: string; kind: string; rate: string; base: string; tax: string }>(
      `SELECT t.code, t.name, t.kind, t.rate::text, sum(l.net)::text AS base, sum(l.tax)::text AS tax
         FROM document_lines l
         JOIN documents d ON d.id = l.document_id AND d.tenant_id = l.tenant_id
         JOIN tax_codes t ON t.id = l.tax_code_id AND t.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1 AND d.status = 'posted' AND d.doc_date BETWEEN $2::date AND $3::date
        GROUP BY t.code, t.name, t.kind, t.rate ORDER BY t.kind DESC, t.code`, [p.tenantId, from, to])).rows;
    let out = 0n;
    let inp = 0n;
    for (const r of rows) {
      if (r.kind === 'output') out += toUnits(r.tax);
      else inp += toUnits(r.tax);
    }
    return { from, to, rows, output_tax: fromUnits(out), input_tax: fromUnits(inp), payable: fromUnits(out - inp) };
  });

/** Undo a receipt or payment: the ledger entry is reversed, every document gets its balance back, the payment stays on record. */
export const voidPayment = (p: Principal, kind: 'receipt' | 'payment', id: string, on: string | undefined, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const pay = (await c.query<{ journal_entry_id: string; pay_date: string; amount: string }>(
      'SELECT journal_entry_id, pay_date::text, amount::text FROM payments WHERE tenant_id = $1 AND kind = $2 AND id = $3', [p.tenantId, kind, id])).rows[0];
    if (!pay) throw notFound(kind === 'receipt' ? 'Receipt' : 'Payment');
    // No row lock on the payment (the app role cannot update it): two simultaneous voids collide on the primary key of
    // payment_voids and on the one-reversal-per-entry index, and the loser rolls back whole.
    if ((await c.query('SELECT 1 FROM payment_voids WHERE tenant_id = $1 AND payment_id = $2', [p.tenantId, id])).rowCount)
      throw new ApiError(409, 'already_voided', 'This payment has already been voided.');
    const date = on ?? today();
    if (date < pay.pay_date) throw new ApiError(422, 'invalid_date', 'The void date cannot be before the payment date.');
    const lines = (await c.query<{ account_id: string; debit: string; credit: string; memo: string | null }>(
      'SELECT account_id, debit::text, credit::text, memo FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no', [p.tenantId, pay.journal_entry_id])).rows;
    const entryId = await insertEntry(c, p, {
      entry_date: date, description: `Void of ${kind}`, reference: `VOID-${kind}`,
      lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined })),
    }, ip, pay.journal_entry_id, { detail: { void: true, payment: kind } });
    // Lock the documents in a fixed order, then give each its balance back.
    const allocs = (await c.query<{ document_id: string; amount: string }>(
      'SELECT document_id, amount::text FROM payment_allocations WHERE tenant_id = $1 AND payment_id = $2 ORDER BY document_id', [p.tenantId, id])).rows;
    for (const a of allocs) {
      await c.query('SELECT 1 FROM documents WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, a.document_id]);
      await c.query('UPDATE documents SET paid_total = paid_total - $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, a.document_id, a.amount]);
    }
    await c.query('INSERT INTO payment_voids (tenant_id, payment_id, void_date, journal_entry_id, voided_by) VALUES ($1, $2, $3, $4, $5)', [p.tenantId, id, date, entryId, p.userId]);
    await recordAudit(c, { tenantId: p.tenantId, action: `${kind}.voided`, actorUserId: p.userId, entityType: 'payment', entityId: id, ip, detail: { amount: pay.amount } });
    return { id, voided: true, void_date: date, journal_entry_id: entryId };
  });
