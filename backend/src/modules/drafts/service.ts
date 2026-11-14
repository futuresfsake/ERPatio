/**
 * Draft journal entries and the optional approval step (FR-FIN-02, FR-FIN-05, ADR-009).
 * Drafts are mutable and live apart from the ledger. Posting a draft inserts a normal ledger entry and
 * deletes the draft in one transaction, so the ledger itself never changes.
 */
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { P } from '../../lib/permissions.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { assertBalanced, insertEntry, loadEntry } from '../ledger/service.js';
import type { EntryIn } from '../ledger/schemas.js';
import type { DraftIn } from './schemas.js';

const DEMO_DRAFT_CAP = 30;

const DRAFT_SELECT =
  'SELECT d.id, d.entry_date, d.description, d.reference, d.status, d.created_by, u.full_name AS created_by_name, ' +
  'd.created_at, d.updated_at, d.submitted_at, d.rejection_note, ' +
  '(SELECT COALESCE(sum(l.debit), 0)::text FROM journal_draft_lines l WHERE l.draft_id = d.id) AS total_debit, ' +
  '(SELECT COALESCE(sum(l.credit), 0)::text FROM journal_draft_lines l WHERE l.draft_id = d.id) AS total_credit ' +
  'FROM journal_drafts d JOIN users u ON u.id = d.created_by';

interface DraftRow {
  id: string;
  entry_date: string;
  description: string;
  reference: string | null;
  status: 'draft' | 'submitted';
  created_by: string;
  created_by_name: string;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  rejection_note: string | null;
  total_debit: string;
  total_credit: string;
}

async function requireApproval(c: PoolClient): Promise<boolean> {
  const r = await c.query<{ require_approval: boolean }>('SELECT require_approval FROM tenant_settings');
  return r.rows[0]?.require_approval ?? false;
}

async function loadDraft(c: PoolClient, id: string, lock = false) {
  const row = (await c.query<DraftRow>(DRAFT_SELECT + ' WHERE d.id = $1' + (lock ? ' FOR UPDATE OF d' : ''), [id])).rows[0];
  if (!row) throw notFound('Draft');
  const lines = (
    await c.query(
      `SELECT l.line_no, l.account_id, a.code AS account_code, a.name AS account_name, l.debit::text, l.credit::text, l.memo
         FROM journal_draft_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.draft_id = $1 ORDER BY l.line_no`,
      [id],
    )
  ).rows;
  return { ...row, lines };
}

async function writeLines(c: PoolClient, tenantId: string, draftId: string, lines: DraftIn['lines']) {
  await c.query('DELETE FROM journal_draft_lines WHERE draft_id = $1', [draftId]);
  if (lines.length === 0) return;
  await c.query(
    `INSERT INTO journal_draft_lines (tenant_id, draft_id, line_no, account_id, debit, credit, memo)
     SELECT $1, $2, t.n, t.a, t.d, t.c, t.m
       FROM unnest($3::uuid[], $4::numeric[], $5::numeric[], $6::text[]) WITH ORDINALITY AS t(a, d, c, m, n)`,
    [tenantId, draftId, lines.map((l) => l.account_id), lines.map((l) => l.debit), lines.map((l) => l.credit), lines.map((l) => l.memo ?? null)],
  );
}

function ownOnly(p: Principal, d: { created_by: string }) {
  if (d.created_by !== p.userId) throw new ApiError(403, 'forbidden', 'Only the person who created a draft can change it.');
}

export const listDrafts = (p: Principal, status?: 'draft' | 'submitted') =>
  withTenant(p.tenantId, async (c) =>
    (await c.query<DraftRow>(DRAFT_SELECT + (status ? ' WHERE d.status = $1' : '') + ' ORDER BY d.updated_at DESC LIMIT 200', status ? [status] : [])).rows,
  );

export const getDraft = (p: Principal, id: string) => withTenant(p.tenantId, (c) => loadDraft(c, id));

export const createDraft = (p: Principal, data: DraftIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const demo = (await c.query<{ is_demo: boolean }>('SELECT is_demo FROM tenants WHERE id = $1', [p.tenantId])).rows[0]?.is_demo;
    if (demo) {
      const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM journal_drafts')).rows[0]?.n ?? 0);
      if (n >= DEMO_DRAFT_CAP) throw new ApiError(403, 'demo_limit', 'The demo workspace has too many drafts. It is reset nightly.');
    }
    const id = (
      await c.query<{ id: string }>(
        'INSERT INTO journal_drafts (tenant_id, entry_date, description, reference, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [p.tenantId, data.entry_date, data.description, data.reference ?? null, p.userId],
      )
    ).rows[0]!.id;
    await writeLines(c, p.tenantId, id, data.lines);
    await recordAudit(c, { tenantId: p.tenantId, action: 'draft.created', actorUserId: p.userId, entityType: 'journal_draft', entityId: id, ip });
    return loadDraft(c, id);
  });

export const updateDraft = (p: Principal, id: string, data: DraftIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const d = await loadDraft(c, id, true);
    ownOnly(p, d);
    if (d.status !== 'draft') throw new ApiError(409, 'not_editable', 'A submitted draft cannot be changed. Ask the approver to send it back.');
    await c.query('UPDATE journal_drafts SET entry_date = $2, description = $3, reference = $4, updated_at = now() WHERE id = $1', [id, data.entry_date, data.description, data.reference ?? null]);
    await writeLines(c, p.tenantId, id, data.lines);
    await recordAudit(c, { tenantId: p.tenantId, action: 'draft.updated', actorUserId: p.userId, entityType: 'journal_draft', entityId: id, ip });
    return loadDraft(c, id);
  });

export const deleteDraft = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const d = await loadDraft(c, id, true);
    ownOnly(p, d);
    if (d.status !== 'draft') throw new ApiError(409, 'not_editable', 'A submitted draft cannot be deleted. Ask the approver to send it back.');
    await c.query('DELETE FROM journal_drafts WHERE id = $1', [id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'draft.deleted', actorUserId: p.userId, entityType: 'journal_draft', entityId: id, ip });
  });

const asEntry = (d: Awaited<ReturnType<typeof loadDraft>>): EntryIn => ({
  entry_date: d.entry_date,
  description: d.description,
  reference: d.reference ?? undefined,
  lines: d.lines.map((l) => ({ account_id: l.account_id as string, debit: l.debit as string, credit: l.credit as string, memo: (l.memo as string | null) ?? undefined })),
});

function assertPostable(d: Awaited<ReturnType<typeof loadDraft>>) {
  if (!d.description.trim()) throw new ApiError(422, 'validation_error', 'Add a description before this draft can be posted.');
  if (d.lines.length < 2) throw new ApiError(422, 'validation_error', 'An entry needs at least two lines.');
  assertBalanced(asEntry(d).lines);
}

export const submitDraft = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if (!(await requireApproval(c))) throw new ApiError(409, 'approval_not_required', 'This workspace does not use approval. Post the draft instead.');
    const d = await loadDraft(c, id, true);
    ownOnly(p, d);
    if (d.status !== 'draft') throw new ApiError(409, 'not_editable', 'This draft is already submitted.');
    assertPostable(d);
    await c.query("UPDATE journal_drafts SET status = 'submitted', submitted_at = now(), rejection_note = NULL, updated_at = now() WHERE id = $1", [id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'draft.submitted', actorUserId: p.userId, entityType: 'journal_draft', entityId: id, ip });
    return loadDraft(c, id);
  });

export const rejectDraft = (p: Principal, id: string, note: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const d = await loadDraft(c, id, true);
    if (d.status !== 'submitted') throw new ApiError(409, 'not_submitted', 'Only a submitted draft can be sent back.');
    await c.query("UPDATE journal_drafts SET status = 'draft', rejection_note = $2, updated_at = now() WHERE id = $1", [id, note]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'draft.rejected', actorUserId: p.userId, entityType: 'journal_draft', entityId: id, ip });
    return loadDraft(c, id);
  });

export const postDraft = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const needsApproval = await requireApproval(c);
    const d = await loadDraft(c, id, true);
    if (needsApproval) {
      if (d.status !== 'submitted') throw new ApiError(409, 'not_submitted', 'Submit the draft for approval first.');
      if (!p.permissions.includes(P.JOURNAL_APPROVE)) throw new ApiError(403, 'forbidden', 'You do not have permission to approve entries.');
      if (d.created_by === p.userId) throw new ApiError(403, 'self_approval', 'You cannot approve an entry you created.');
    } else if (d.status === 'draft' && d.created_by !== p.userId && !p.permissions.includes(P.JOURNAL_APPROVE)) {
      throw new ApiError(403, 'forbidden', 'Only the person who created a draft can post it.');
    }
    assertPostable(d);
    const entryId = await insertEntry(c, p, asEntry(d), ip, null, {
      createdBy: d.created_by,
      postedBy: p.userId,
      approvedBy: needsApproval ? p.userId : null,
      detail: { draft_id: id },
    });
    await c.query('DELETE FROM journal_drafts WHERE id = $1', [id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'draft.posted', actorUserId: p.userId, entityType: 'journal_draft', entityId: id, ip, detail: { entry_id: entryId } });
    return loadEntry(c, entryId);
  });

