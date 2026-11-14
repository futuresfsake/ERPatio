/**
 * Bank reconciliation: statement lines are imported, then matched one to one with ledger lines of the bank account.
 * A line with no ledger counterpart (a bank fee, interest) can be posted straight from the statement.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { insertEntry } from '../ledger/service.js';

export interface StatementLineIn { date: string; description: string; reference?: string; amount: string }

const signed = (s: string): bigint => (s.startsWith('-') ? -toUnits(s.slice(1)) : toUnits(s));
const signedOut = (n: bigint): string => (n < 0n ? '-' + fromUnits(-n) : fromUnits(n));

async function bankAccount(c: PoolClient, tenantId: string, accountId: string) {
  const a = (await c.query<{ code: string; name: string; type: string; is_active: boolean }>('SELECT code, name, type, is_active FROM accounts WHERE tenant_id = $1 AND id = $2', [tenantId, accountId])).rows[0];
  if (!a || a.type !== 'asset') throw new ApiError(422, 'invalid_account', 'Choose a cash or bank account (an asset account).');
  return a;
}

export const importLines = (p: Principal, accountId: string, lines: StatementLineIn[], ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await bankAccount(c, p.tenantId, accountId);
    // The same file imported twice adds nothing; two genuinely identical lines in one file are both kept (occurrence number).
    const seen = new Map<string, number>();
    let added = 0;
    for (const l of lines) {
      const key = [l.date, signedOut(signed(l.amount)), (l.reference ?? '').trim().toLowerCase(), l.description.trim().toLowerCase()].join('|');
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const fingerprint = createHash('sha256').update(`${key}#${n}`).digest('hex');
      const r = await c.query(
        `INSERT INTO bank_statement_lines (tenant_id, account_id, line_date, description, reference, amount, fingerprint, imported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, account_id, fingerprint) DO NOTHING`,
        [p.tenantId, accountId, l.date, l.description.trim(), l.reference?.trim() || null, signedOut(signed(l.amount)), fingerprint, p.userId]);
      added += r.rowCount ?? 0;
    }
    await recordAudit(c, { tenantId: p.tenantId, action: 'bank.imported', actorUserId: p.userId, entityType: 'account', entityId: accountId, ip, detail: { lines: lines.length, added } });
    return { received: lines.length, added, skipped: lines.length - added };
  });

interface Unmatched { id: string; date: string; description: string; reference: string | null; amount: string }
interface UnmatchedLedger { journal_line_id: string; entry_id: string; entry_no: number; date: string; description: string; amount: string }

export const reconciliation = (p: Principal, accountId: string, asOf: string) =>
  withTenant(p.tenantId, async (c) => {
    const acct = await bankAccount(c, p.tenantId, accountId);
    const stmt = (await c.query<{ id: string; date: string; description: string; reference: string | null; amount: string }>(
      `SELECT s.id, s.line_date::text AS date, s.description, s.reference, s.amount::text FROM bank_statement_lines s
        WHERE s.tenant_id = $1 AND s.account_id = $2 AND s.line_date <= $3::date AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.tenant_id = s.tenant_id AND m.statement_line_id = s.id)
        ORDER BY s.line_date, s.imported_at, s.id`, [p.tenantId, accountId, asOf])).rows;
    const ledger = (await c.query<{ journal_line_id: string; entry_id: string; entry_no: string; date: string; description: string; amount: string }>(
      `SELECT l.id AS journal_line_id, e.id AS entry_id, e.entry_no::text, e.entry_date::text AS date, e.description, (l.debit - l.credit)::text AS amount
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1 AND l.account_id = $2 AND e.entry_date <= $3::date AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.tenant_id = l.tenant_id AND m.journal_line_id = l.id)
        ORDER BY e.entry_date, e.entry_no, l.line_no`, [p.tenantId, accountId, asOf])).rows;
    const totals = (await c.query<{ gl: string | null; st: string | null; matched: string }>(
      `SELECT (SELECT sum(l.debit - l.credit) FROM journal_lines l WHERE l.tenant_id = $1 AND l.account_id = $2 AND l.entry_date <= $3::date)::text AS gl,
              (SELECT sum(amount) FROM bank_statement_lines WHERE tenant_id = $1 AND account_id = $2 AND line_date <= $3::date)::text AS st,
              (SELECT count(*) FROM bank_matches m JOIN bank_statement_lines s ON s.id = m.statement_line_id AND s.tenant_id = m.tenant_id WHERE m.tenant_id = $1 AND s.account_id = $2 AND s.line_date <= $3::date)::text AS matched`,
      [p.tenantId, accountId, asOf])).rows[0]!;
    const gl = signed(totals.gl ?? '0');
    const st = signed(totals.st ?? '0');
    const unStmt = stmt.reduce((t, x) => t + signed(x.amount), 0n);
    const unLedger = ledger.reduce((t, x) => t + signed(x.amount), 0n);

    // Suggestions: same signed amount, dates within a week, nearest first, each line used once.
    const usedLedger = new Set<string>();
    const suggestions: { statement_line_id: string; journal_line_id: string; days: number; unique: boolean }[] = [];
    for (const s of stmt) {
      const cands = ledger.filter((l) => !usedLedger.has(l.journal_line_id) && signed(l.amount) === signed(s.amount)
        && Math.abs((Date.parse(l.date) - Date.parse(s.date)) / 86_400_000) <= 7)
        .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(s.date)) - Math.abs(Date.parse(b.date) - Date.parse(s.date)));
      const best = cands[0];
      if (!best) continue;
      usedLedger.add(best.journal_line_id);
      const rivals = stmt.filter((o) => o.id !== s.id && signed(o.amount) === signed(s.amount) && Math.abs((Date.parse(best.date) - Date.parse(o.date)) / 86_400_000) <= 7).length;
      suggestions.push({ statement_line_id: s.id, journal_line_id: best.journal_line_id, days: Math.round(Math.abs(Date.parse(best.date) - Date.parse(s.date)) / 86_400_000), unique: cands.length === 1 && rivals === 0 });
    }
    return {
      account: { id: accountId, code: acct.code, name: acct.name }, as_of: asOf,
      ledger_balance: fromUnits(gl), statement_total: signedOut(st), difference: signedOut(gl - st),
      unmatched_statement_total: signedOut(unStmt), unmatched_ledger_total: signedOut(unLedger),
      // With nothing before the first imported line, ledger minus statement equals the unmatched ledger less the unmatched statement.
      explained: gl - st === unLedger - unStmt,
      reconciled: stmt.length === 0 && ledger.length === 0 && Number(totals.matched) > 0,
      matched_count: Number(totals.matched),
      unmatched_statement: stmt as Unmatched[], unmatched_ledger: ledger.map((l) => ({ ...l, entry_no: Number(l.entry_no) })) as UnmatchedLedger[],
      suggestions,
    };
  });

async function doMatch(c: PoolClient, p: Principal, statementLineId: string, journalLineId: string) {
  const s = (await c.query<{ account_id: string; amount: string }>('SELECT account_id, amount::text FROM bank_statement_lines WHERE tenant_id = $1 AND id = $2', [p.tenantId, statementLineId])).rows[0];
  if (!s) throw notFound('Statement line');
  const l = (await c.query<{ account_id: string; amount: string }>('SELECT account_id, (debit - credit)::text AS amount FROM journal_lines WHERE tenant_id = $1 AND id = $2', [p.tenantId, journalLineId])).rows[0];
  if (!l) throw notFound('Ledger line');
  if (l.account_id !== s.account_id) throw new ApiError(422, 'wrong_account', 'The ledger line belongs to a different account.');
  if (signed(l.amount) !== signed(s.amount)) throw new ApiError(422, 'amount_mismatch', 'The amounts do not agree, so these cannot be matched.');
  await c.query('INSERT INTO bank_matches (tenant_id, statement_line_id, journal_line_id, matched_by) VALUES ($1, $2, $3, $4)', [p.tenantId, statementLineId, journalLineId, p.userId]);
}

export const match = (p: Principal, statementLineId: string, journalLineId: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await doMatch(c, p, statementLineId, journalLineId);
    await recordAudit(c, { tenantId: p.tenantId, action: 'bank.matched', actorUserId: p.userId, entityType: 'bank_statement_line', entityId: statementLineId, ip });
    return { matched: true };
  });

export const unmatch = (p: Principal, statementLineId: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = await c.query('DELETE FROM bank_matches WHERE tenant_id = $1 AND statement_line_id = $2', [p.tenantId, statementLineId]);
    if (!r.rowCount) throw notFound('Match');
    await recordAudit(c, { tenantId: p.tenantId, action: 'bank.unmatched', actorUserId: p.userId, entityType: 'bank_statement_line', entityId: statementLineId, ip });
    return { matched: false };
  });

/** Accepts the unambiguous suggestions only: one candidate each way. Anything doubtful is left for a person. */
export const autoMatch = (p: Principal, accountId: string, asOf: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await bankAccount(c, p.tenantId, accountId);
    const stmt = (await c.query<{ id: string; date: string; amount: string }>(
      `SELECT s.id, s.line_date::text AS date, s.amount::text FROM bank_statement_lines s WHERE s.tenant_id = $1 AND s.account_id = $2 AND s.line_date <= $3::date
          AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.tenant_id = s.tenant_id AND m.statement_line_id = s.id) ORDER BY s.id`, [p.tenantId, accountId, asOf])).rows;
    const ledger = (await c.query<{ id: string; date: string; amount: string }>(
      `SELECT l.id, e.entry_date::text AS date, (l.debit - l.credit)::text AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1 AND l.account_id = $2 AND e.entry_date <= $3::date AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.tenant_id = l.tenant_id AND m.journal_line_id = l.id) ORDER BY l.id`, [p.tenantId, accountId, asOf])).rows;
    const near = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000) <= 7;
    let done = 0;
    for (const s of stmt) {
      const cands = ledger.filter((l) => signed(l.amount) === signed(s.amount) && near(l.date, s.date));
      const rivals = stmt.filter((o) => signed(o.amount) === signed(s.amount) && near(o.date, cands[0]?.date ?? s.date));
      if (cands.length === 1 && rivals.length === 1) {
        await doMatch(c, p, s.id, cands[0]!.id);
        ledger.splice(ledger.indexOf(cands[0]!), 1);
        done += 1;
      }
    }
    await recordAudit(c, { tenantId: p.tenantId, action: 'bank.auto_matched', actorUserId: p.userId, entityType: 'account', entityId: accountId, ip, detail: { matched: done } });
    return { matched: done };
  });

/** Post a statement line that has no entry yet (a bank fee, interest) against another account, and match it. */
export const postStatementLine = (p: Principal, statementLineId: string, counterAccountId: string, memo: string | undefined, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const s = (await c.query<{ account_id: string; line_date: string; description: string; amount: string }>(
      'SELECT account_id, line_date::text, description, amount::text FROM bank_statement_lines WHERE tenant_id = $1 AND id = $2', [p.tenantId, statementLineId])).rows[0];
    if (!s) throw notFound('Statement line');
    if ((await c.query('SELECT 1 FROM bank_matches WHERE tenant_id = $1 AND statement_line_id = $2', [p.tenantId, statementLineId])).rowCount) throw new ApiError(409, 'already_matched', 'This line is already matched.');
    if (counterAccountId === s.account_id) throw new ApiError(422, 'invalid_account', 'Choose a different account for the other side.');
    const amt = signed(s.amount);
    const abs = fromUnits(amt < 0n ? -amt : amt);
    const entryId = await insertEntry(c, p, {
      entry_date: s.line_date, description: (memo?.trim() || s.description).slice(0, 500), reference: 'BANK',
      lines: amt > 0n
        ? [{ account_id: s.account_id, debit: abs, credit: '0', memo: s.description.slice(0, 500) }, { account_id: counterAccountId, debit: '0', credit: abs }]
        : [{ account_id: counterAccountId, debit: abs, credit: '0' }, { account_id: s.account_id, debit: '0', credit: abs, memo: s.description.slice(0, 500) }],
    }, ip, null, { detail: { bank: true } });
    const jl = (await c.query<{ id: string }>('SELECT id FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 AND account_id = $3', [p.tenantId, entryId, s.account_id])).rows[0]!;
    await doMatch(c, p, statementLineId, jl.id);
    await recordAudit(c, { tenantId: p.tenantId, action: 'bank.posted', actorUserId: p.userId, entityType: 'bank_statement_line', entityId: statementLineId, ip, detail: { entry: entryId } });
    return { journal_entry_id: entryId };
  });
