/** General-ledger rules (ADR-003). Validated here, enforced again by the database (triggers, CHECKs, FKs). */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getEnv } from '../../config/env.js';
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import type { AccountIn, AccountPatch, EntryIn } from './schemas.js';

// ------------------------------------------------------------------ accounts
export const listAccounts = (p: Principal) =>
  withTenant(p.tenantId, async (c) => (await c.query('SELECT id, code, name, type, is_active FROM accounts ORDER BY code')).rows);

export const createAccount = (p: Principal, a: AccountIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const { rows } = await c.query(
      'INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, upper($2), $3, $4) RETURNING id, code, name, type, is_active',
      [p.tenantId, a.code, a.name, a.type],
    );
    await recordAudit(c, { tenantId: p.tenantId, action: 'account.created', actorUserId: p.userId, entityType: 'account', entityId: rows[0].id, ip, detail: { code: rows[0].code } });
    return rows[0];
  });

export const updateAccount = (p: Principal, id: string, patch: AccountPatch, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const { rows } = await c.query(
      `UPDATE accounts SET name = COALESCE($2, name), is_active = COALESCE($3, is_active)
        WHERE id = $1 RETURNING id, code, name, type, is_active`,
      [id, patch.name ?? null, patch.is_active ?? null],
    );
    if (!rows[0]) throw notFound('Account');
    await recordAudit(c, { tenantId: p.tenantId, action: 'account.updated', actorUserId: p.userId, entityType: 'account', entityId: id, ip, detail: { fields: Object.keys(patch).sort() } });
    return rows[0];
  });

// ------------------------------------------------------------------- journal
interface EntryRow {
  id: string; entry_no: string; entry_date: string; description: string; reference: string | null;
  reverses_entry_id: string | null; reversed_by_entry_id: string | null; total: string; created_at: Date;
}

const entryOut = (r: EntryRow) => ({
  id: r.id, entry_no: Number(r.entry_no), entry_date: r.entry_date, description: r.description,
  reference: r.reference, reverses_entry_id: r.reverses_entry_id, reversed_by_entry_id: r.reversed_by_entry_id,
  total: r.total, created_at: r.created_at,
});

// Constant fragment, never built from input.
const ENTRY_SELECT = `
  SELECT e.id, e.entry_no, e.entry_date, e.description, e.reference, e.reverses_entry_id, e.created_at,
         (SELECT r.id FROM journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed_by_entry_id,
         COALESCE((SELECT sum(l.debit) FROM journal_lines l WHERE l.entry_id = e.id), 0)::text AS total
    FROM journal_entries e`;

export async function loadEntry(c: PoolClient, id: string) {
  const { rows } = await c.query<EntryRow>(ENTRY_SELECT + ' WHERE e.id = $1', [id]);
  if (!rows[0]) throw notFound('Journal entry');
  const lines = (
    await c.query(
      `SELECT l.line_no, l.account_id, a.code AS account_code, a.name AS account_name, l.debit::text, l.credit::text, l.memo
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.entry_id = $1 ORDER BY l.line_no`,
      [id],
    )
  ).rows;
  return { ...entryOut(rows[0]), lines };
}

/** One side per line, and debits must equal credits. Returns the entry total in integer units. */
export function assertBalanced(lines: { debit: string; credit: string }[]): bigint {
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    const d = toUnits(l.debit);
    const cr = toUnits(l.credit);
    if ((d > 0n) === (cr > 0n)) throw new ApiError(422, 'invalid_line', 'Each line needs either a debit or a credit, not both or neither.');
    debit += d;
    credit += cr;
  }
  if (debit !== credit) throw new ApiError(422, 'unbalanced_entry', 'Total debits must equal total credits.');
  return debit;
}

export interface InsertOpts {
  createdBy?: string;
  postedBy?: string;
  approvedBy?: string | null;
  closingYear?: number;
  detail?: Record<string, unknown>;
}

/** Inserts one balanced entry inside the caller's transaction. */
export async function insertEntry(
  c: PoolClient,
  p: Principal,
  data: EntryIn,
  ip: string | undefined,
  reverses: string | null,
  opts: InsertOpts = {},
) {
  const debit = assertBalanced(data.lines);

  const tenant = (await c.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [p.tenantId])).rows[0];
  if (tenant?.is_demo) {
    const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM journal_entries')).rows[0]?.n ?? 0);
    if (n >= getEnv().DEMO_MAX_ENTRIES) throw new ApiError(403, 'demo_limit', 'The demo workspace is full. It is reset nightly.');
  }

  const ids = [...new Set(data.lines.map((l) => l.account_id))];
  const ok = Number(
    (await c.query<{ n: string }>('SELECT count(*) AS n FROM accounts WHERE id = ANY($1::uuid[]) AND is_active', [ids])).rows[0]?.n,
  );
  if (ok !== ids.length) throw new ApiError(422, 'invalid_account', 'Every line must use an existing, active account.');

  // The row lock on the counter serialises postings per tenant: gapless, race-free numbers.
  const entryNo = (
    await c.query<{ journal_seq: string }>(
      'UPDATE tenant_counters SET journal_seq = journal_seq + 1 WHERE tenant_id = $1 RETURNING journal_seq',
      [p.tenantId],
    )
  ).rows[0]?.journal_seq;
  const id = randomUUID();
  await c.query(
    `INSERT INTO journal_entries (id, tenant_id, entry_no, entry_date, description, reference, reverses_entry_id, created_by, posted_by, approved_by, closing_year)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, p.tenantId, entryNo, data.entry_date, data.description, data.reference ?? null, reverses, opts.createdBy ?? p.userId, opts.postedBy ?? p.userId, opts.approvedBy ?? null, opts.closingYear ?? null],
  );
  await c.query(
    `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, debit, credit, memo)
     SELECT $1, $2, t.n, t.a, t.d, t.c, t.m
       FROM unnest($3::uuid[], $4::numeric[], $5::numeric[], $6::text[]) WITH ORDINALITY AS t(a, d, c, m, n)`,
    [p.tenantId, id, data.lines.map((l) => l.account_id), data.lines.map((l) => l.debit), data.lines.map((l) => l.credit), data.lines.map((l) => l.memo ?? null)],
  );
  await recordAudit(c, {
    tenantId: p.tenantId, action: reverses ? 'journal.reversed' : 'journal.posted', actorUserId: p.userId,
    entityType: 'journal_entry', entityId: id, ip, detail: { entry_no: Number(entryNo), total: fromUnits(debit), lines: data.lines.length, ...(opts.detail ?? {}) },
  });
  return id;
}

export const postEntry = (p: Principal, data: EntryIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    // When the workspace requires approval, entries go through drafts (FR-FIN-05).
    const gate = await c.query<{ require_approval: boolean }>('SELECT require_approval FROM tenant_settings');
    if (gate.rows[0]?.require_approval)
      throw new ApiError(409, 'approval_required', 'This workspace requires approval. Save a draft and submit it.');
    return loadEntry(c, await insertEntry(c, p, data, ip, null));
  });

export const reverseEntry = (p: Principal, id: string, on: string | undefined, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const e = (await c.query<{ entry_no: string; description: string; reverses_entry_id: string | null }>(
      'SELECT entry_no, description, reverses_entry_id FROM journal_entries WHERE id = $1', [id])).rows[0];
    if (!e) throw notFound('Journal entry');
    // Entries written by an invoice, bill or payment belong to that document; reversing them here would leave the
    // subledger saying something the ledger no longer does. The document is voided instead.
    const owned = await c.query(
      `SELECT 1 FROM documents WHERE journal_entry_id = $1 OR void_entry_id = $1
       UNION ALL SELECT 1 FROM payments WHERE journal_entry_id = $1
       UNION ALL SELECT 1 FROM payment_voids WHERE journal_entry_id = $1
       UNION ALL SELECT 1 FROM journal_entries WHERE id = $1 AND closing_year IS NOT NULL`,
      [id],
    );
    if (owned.rowCount) throw new ApiError(409, 'subledger_entry', 'This entry belongs to an invoice, bill, payment or year-end close. Undo it from there.');
    if (e.reverses_entry_id) throw new ApiError(409, 'not_reversible', 'A reversing entry cannot itself be reversed.');
    const lines = (await c.query<{ account_id: string; debit: string; credit: string; memo: string | null }>(
      'SELECT account_id, debit::text, credit::text, memo FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [id])).rows;
    const payload: EntryIn = {
      entry_date: on ?? new Date().toISOString().slice(0, 10),
      description: `Reversal of JE-${e.entry_no}: ${e.description}`.slice(0, 500),
      reference: `REV-${e.entry_no}`,
      lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined })),
    };
    return loadEntry(c, await insertEntry(c, p, payload, ip, id));
  });

export const listEntries = (p: Principal, limit: number, offset: number) =>
  withTenant(p.tenantId, async (c) => {
    const total = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM journal_entries')).rows[0]?.n ?? 0);
    const { rows } = await c.query<EntryRow>(
      ENTRY_SELECT + ' ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return { items: rows.map((r) => ({ ...entryOut(r), lines: [] })), total, limit, offset };
  });

export const getEntry = (p: Principal, id: string) => withTenant(p.tenantId, (c) => loadEntry(c, id));

// ------------------------------------------------------------------- reports
export const trialBalance = (p: Principal, asOf: string) =>
  withTenant(p.tenantId, async (c) => {
    const { rows } = await c.query<{ account_id: string; code: string; name: string; type: string; d: string; c: string }>(
      `SELECT a.id AS account_id, a.code, a.name, a.type, sum(l.debit)::text AS d, sum(l.credit)::text AS c
         FROM accounts a
         JOIN journal_lines l ON l.account_id = a.id
         JOIN journal_entries e ON e.id = l.entry_id AND e.entry_date <= $1
        GROUP BY a.id, a.code, a.name, a.type
        ORDER BY a.code`,
      [asOf],
    );
    let td = 0n;
    let tc = 0n;
    const out = rows.map((r) => {
      const net = toUnits(r.d) - toUnits(r.c);
      const debit = net > 0n ? net : 0n;
      const credit = net < 0n ? -net : 0n;
      td += debit;
      tc += credit;
      return { account_id: r.account_id, code: r.code, name: r.name, type: r.type, debit: fromUnits(debit), credit: fromUnits(credit) };
    });
    return { as_of: asOf, rows: out, total_debit: fromUnits(td), total_credit: fromUnits(tc), balanced: td === tc };
  });

export const recentAudit = (p: Principal, limit: number) =>
  withTenant(p.tenantId, async (c) =>
    (await c.query(
      `SELECT id::int, occurred_at, action, actor_user_id, entity_type, entity_id, detail
         FROM audit_log ORDER BY id DESC LIMIT $1`, [limit])).rows);
