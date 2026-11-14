/**
 * People and payroll. Identifiers, bank account, birth date and pay rate are encrypted per workspace (ADR-005) and never
 * listed; showing one is a separate, audited call. A payroll run is prepared as a draft, then locked by a different person,
 * which posts one balanced entry and freezes the run (the database refuses any later change). Statutory rates and
 * withholding brackets are data the payroll manager keeps current, not code.
 */
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { insertEntry } from '../ledger/service.js';
import type { AdjustmentIn, AttendanceIn, EmployeeIn, EmployeePatch, RulesIn, RunIn } from './schemas.js';

const U = 10000n;
const roundCent = (u: bigint): bigint => ((u + 50n) / 100n) * 100n;
const dayMs = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);

// ------------------------------------------------------------------ employees
const EMP_COLS = `id, emp_no, full_name, email, phone, department, position, hire_date, termination_date, status, pay_type,
  (tin_enc IS NOT NULL) AS has_tin, (sss_enc IS NOT NULL) AS has_sss, (philhealth_enc IS NOT NULL) AS has_philhealth,
  (pagibig_enc IS NOT NULL) AS has_pagibig, (bank_account_enc IS NOT NULL) AS has_bank_account`;
const SENSITIVE = ['tin', 'sss', 'philhealth', 'pagibig', 'bank_account', 'birth_date'] as const;
const COL: Record<(typeof SENSITIVE)[number], string> = { tin: 'tin_enc', sss: 'sss_enc', philhealth: 'philhealth_enc', pagibig: 'pagibig_enc', bank_account: 'bank_account_enc', birth_date: 'birth_date_enc' };

export const listEmployees = (p: Principal, status?: string) =>
  withTenant(p.tenantId, async (c) => (await c.query('SELECT ' + EMP_COLS + ' FROM employees WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY emp_no', [p.tenantId, status ?? null])).rows);

export const getEmployee = (p: Principal, id: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = (await c.query('SELECT ' + EMP_COLS + ' FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
    if (!r) throw notFound('Employee');
    return r;
  });

export const createEmployee = (p: Principal, a: EmployeeIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const no = (await c.query<{ seq: string }>("UPDATE doc_counters SET seq = seq + 1 WHERE tenant_id = $1 AND kind = 'emp' RETURNING seq", [p.tenantId])).rows[0]!.seq;
    const enc = async (v?: string) => (v ? encryptField(c, p.tenantId, v) : null);
    const id = (await c.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, emp_no, full_name, email, phone, department, position, hire_date, pay_type, rate_enc, tin_enc, sss_enc, philhealth_enc, pagibig_enc, bank_account_enc, birth_date_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [p.tenantId, no, a.full_name, a.email ?? null, a.phone ?? null, a.department ?? null, a.position ?? null, a.hire_date, a.pay_type, await encryptField(c, p.tenantId, a.rate),
        await enc(a.tin), await enc(a.sss), await enc(a.philhealth), await enc(a.pagibig), await enc(a.bank_account), await enc(a.birth_date)])).rows[0]!.id;
    await recordAudit(c, { tenantId: p.tenantId, action: 'employee.created', actorUserId: p.userId, entityType: 'employee', entityId: id, ip, detail: { emp_no: Number(no) } });
    return (await c.query('SELECT ' + EMP_COLS + ' FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
  });

export const updateEmployee = (p: Principal, id: string, patch: EmployeePatch, canSeePay: boolean, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const cur = (await c.query<{ status: string }>('SELECT status FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, id])).rows[0];
    if (!cur) throw notFound('Employee');
    if (cur.status === 'erased') throw new ApiError(409, 'erased', 'This employee record has been erased.');
    if ((patch.rate !== undefined || patch.pay_type !== undefined) && !canSeePay) throw new ApiError(403, 'forbidden', 'Changing pay needs payroll access.');
    const sets: string[] = [];
    const vals: unknown[] = [p.tenantId, id];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    for (const k of ['full_name', 'email', 'phone', 'department', 'position', 'pay_type'] as const) if (patch[k] !== undefined) add(k, patch[k]);
    if (patch.rate !== undefined) add('rate_enc', await encryptField(c, p.tenantId, patch.rate));
    for (const k of SENSITIVE) if (patch[k] !== undefined) add(COL[k], patch[k] === null ? null : await encryptField(c, p.tenantId, patch[k]!));
    // Column names above come from fixed lists, never from the request.
    await c.query('UPDATE employees SET ' + sets.join(', ') + ' WHERE tenant_id = $1 AND id = $2', vals);
    await recordAudit(c, { tenantId: p.tenantId, action: 'employee.updated', actorUserId: p.userId, entityType: 'employee', entityId: id, ip, detail: { fields: Object.keys(patch).sort() } });
    return (await c.query('SELECT ' + EMP_COLS + ' FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
  });

export const terminateEmployee = (p: Principal, id: string, date: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const e = (await c.query<{ status: string; hire_date: string }>('SELECT status, hire_date::text FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, id])).rows[0];
    if (!e) throw notFound('Employee');
    if (e.status !== 'active') throw new ApiError(409, 'not_active', 'This employee is not active.');
    if (date < e.hire_date) throw new ApiError(422, 'invalid_date', 'The end date cannot be before the hire date.');
    await c.query("UPDATE employees SET status = 'terminated', termination_date = $3 WHERE tenant_id = $1 AND id = $2", [p.tenantId, id, date]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'employee.terminated', actorUserId: p.userId, entityType: 'employee', entityId: id, ip });
    return (await c.query('SELECT ' + EMP_COLS + ' FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
  });

/** Identifiers on request, decrypted, and the read is recorded. */
export const revealIdentifiers = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = (await c.query<Record<string, string | null>>('SELECT tin_enc, sss_enc, philhealth_enc, pagibig_enc, bank_account_enc, birth_date_enc FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
    if (!r) throw notFound('Employee');
    const out: Record<string, string | null> = {};
    for (const k of SENSITIVE) { const v = r[COL[k]]; out[k] = v ? await decryptField(c, p.tenantId, v) : null; }
    await recordAudit(c, { tenantId: p.tenantId, action: 'employee.identifiers_viewed', actorUserId: p.userId, entityType: 'employee', entityId: id, ip });
    return out;
  });

export const revealCompensation = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = (await c.query<{ rate_enc: string; pay_type: string }>('SELECT rate_enc, pay_type FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
    if (!r) throw notFound('Employee');
    await recordAudit(c, { tenantId: p.tenantId, action: 'employee.compensation_viewed', actorUserId: p.userId, entityType: 'employee', entityId: id, ip });
    return { pay_type: r.pay_type, rate: fromUnits(toUnits(await decryptField(c, p.tenantId, r.rate_enc))) };
  });

/** Everything held about one person, for a data-subject request. Decrypted, audited. */
export const exportEmployee = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const e = (await c.query('SELECT ' + EMP_COLS + ', rate_enc FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
    if (!e) throw notFound('Employee');
    const ids = await (async () => {
      const r = (await c.query<Record<string, string | null>>('SELECT tin_enc, sss_enc, philhealth_enc, pagibig_enc, bank_account_enc, birth_date_enc FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0]!;
      const o: Record<string, string | null> = {};
      for (const k of SENSITIVE) { const v = r[COL[k]]; o[k] = v ? await decryptField(c, p.tenantId, v) : null; }
      return o;
    })();
    const { rate_enc, ...profile } = e as Record<string, string> & { rate_enc: string };
    const attendance = (await c.query('SELECT work_date, status, time_in, time_out, regular_hours, overtime_hours, note FROM attendance WHERE tenant_id = $1 AND employee_id = $2 ORDER BY work_date', [p.tenantId, id])).rows;
    const payslips = (await c.query(
      `SELECT r.run_no, r.period_start, r.period_end, r.pay_date, s.gross, s.sss_ee, s.philhealth_ee, s.pagibig_ee, s.tax, s.other_deductions, s.net
         FROM payslips s JOIN payroll_runs r ON r.id = s.run_id AND r.tenant_id = s.tenant_id WHERE s.tenant_id = $1 AND s.employee_id = $2 ORDER BY r.period_start`, [p.tenantId, id])).rows;
    await recordAudit(c, { tenantId: p.tenantId, action: 'employee.exported', actorUserId: p.userId, entityType: 'employee', entityId: id, ip });
    return { exported_at: new Date().toISOString(), profile, pay: { rate: fromUnits(toUnits(await decryptField(c, p.tenantId, rate_enc))) }, identifiers: ids, attendance, payslips };
  });

/** Pseudonymise a former employee. Payslips stay (they are accounting and tax records) under a pseudonym; amounts never change. */
export const eraseEmployee = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const e = (await c.query<{ status: string; emp_no: string }>('SELECT status, emp_no::text FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, id])).rows[0];
    if (!e) throw notFound('Employee');
    if (e.status === 'erased') throw new ApiError(409, 'erased', 'This employee record has already been erased.');
    if (e.status !== 'terminated') throw new ApiError(409, 'still_active', 'Only a former employee can be erased. Record their end date first.');
    const alias = `Former employee ${e.emp_no}`;
    await c.query("SELECT set_config('app.erasure', 'on', true)");
    await c.query('UPDATE payslips SET employee_name = $3 WHERE tenant_id = $1 AND employee_id = $2', [p.tenantId, id, alias]);
    await c.query(
      `UPDATE employees SET full_name = $3, email = NULL, phone = NULL, department = NULL, position = NULL, status = 'erased',
              tin_enc = NULL, sss_enc = NULL, philhealth_enc = NULL, pagibig_enc = NULL, bank_account_enc = NULL, birth_date_enc = NULL, rate_enc = $4
        WHERE tenant_id = $1 AND id = $2`, [p.tenantId, id, alias, await encryptField(c, p.tenantId, '0')]);
    await c.query('DELETE FROM attendance WHERE tenant_id = $1 AND employee_id = $2', [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'employee.erased', actorUserId: p.userId, entityType: 'employee', entityId: id, ip });
    return { erased: true };
  });

// ------------------------------------------------------------------ shifts and attendance
export const listShifts = (p: Principal) =>
  withTenant(p.tenantId, async (c) => (await c.query("SELECT id, code, name, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, break_minutes, is_active FROM shifts WHERE tenant_id = $1 ORDER BY code", [p.tenantId])).rows);

export const createShift = (p: Principal, a: { code: string; name: string; start_time: string; end_time: string; break_minutes: number }, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const id = (await c.query<{ id: string }>('INSERT INTO shifts (tenant_id, code, name, start_time, end_time, break_minutes) VALUES ($1, upper($2), $3, $4, $5, $6) RETURNING id', [p.tenantId, a.code, a.name, a.start_time, a.end_time, a.break_minutes])).rows[0]!.id;
    await recordAudit(c, { tenantId: p.tenantId, action: 'shift.created', actorUserId: p.userId, entityType: 'shift', entityId: id, ip });
    return (await c.query("SELECT id, code, name, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, break_minutes, is_active FROM shifts WHERE tenant_id = $1 AND id = $2", [p.tenantId, id])).rows[0];
  });

export const updateShift = (p: Principal, id: string, patch: Record<string, unknown>, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = await c.query('UPDATE shifts SET name = COALESCE($3, name), start_time = COALESCE($4, start_time), end_time = COALESCE($5, end_time), break_minutes = COALESCE($6, break_minutes), is_active = COALESCE($7, is_active) WHERE tenant_id = $1 AND id = $2',
      [p.tenantId, id, patch.name ?? null, patch.start_time ?? null, patch.end_time ?? null, patch.break_minutes ?? null, patch.is_active ?? null]);
    if (!r.rowCount) throw notFound('Shift');
    await recordAudit(c, { tenantId: p.tenantId, action: 'shift.updated', actorUserId: p.userId, entityType: 'shift', entityId: id, ip, detail: { fields: Object.keys(patch).sort() } });
    return (await c.query("SELECT id, code, name, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, break_minutes, is_active FROM shifts WHERE tenant_id = $1 AND id = $2", [p.tenantId, id])).rows[0];
  });

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** A day inside a locked payroll run cannot be re-recorded: the run already paid for it. */
async function assertNotPaidFor(c: PoolClient, tenantId: string, date: string) {
  const r = await c.query("SELECT 1 FROM payroll_runs WHERE tenant_id = $1 AND status <> 'draft' AND $2::date BETWEEN period_start AND period_end", [tenantId, date]);
  if (r.rowCount) throw new ApiError(409, 'period_locked', 'That day is inside a locked payroll run.');
}

export const recordAttendance = (p: Principal, a: AttendanceIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const e = (await c.query<{ status: string; hire_date: string; termination_date: string | null }>('SELECT status, hire_date::text, termination_date::text FROM employees WHERE tenant_id = $1 AND id = $2', [p.tenantId, a.employee_id])).rows[0];
    if (!e || e.status === 'erased') throw new ApiError(422, 'invalid_employee', 'Choose an existing employee.');
    if (a.work_date < e.hire_date || (e.termination_date && a.work_date > e.termination_date)) throw new ApiError(422, 'outside_employment', 'That date is outside the employee\'s employment.');
    await assertNotPaidFor(c, p.tenantId, a.work_date);
    let regular = 0; let overtime = 0;
    if (a.status === 'present') {
      let shiftHours = 8;
      if (a.shift_id) {
        const s = (await c.query<{ start_time: string; end_time: string; break_minutes: number }>("SELECT to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, break_minutes FROM shifts WHERE tenant_id = $1 AND id = $2 AND is_active", [p.tenantId, a.shift_id])).rows[0];
        if (!s) throw new ApiError(422, 'invalid_shift', 'Choose an existing, active shift.');
        const len = (minutes(s.end_time) - minutes(s.start_time) + 1440) % 1440;
        shiftHours = Math.max(0, len - s.break_minutes) / 60;
      }
      if (a.time_in && a.time_out) {
        const worked = Math.max(0, (minutes(a.time_out) - minutes(a.time_in) + 1440) % 1440) / 60;
        const brk = a.shift_id ? (await c.query<{ b: number }>('SELECT break_minutes AS b FROM shifts WHERE tenant_id = $1 AND id = $2', [p.tenantId, a.shift_id])).rows[0]!.b / 60 : 1;
        const net = Math.max(0, worked - brk);
        regular = Math.min(net, shiftHours);
        overtime = Math.max(0, net - shiftHours);
      } else { regular = a.regular_hours ?? shiftHours; overtime = a.overtime_hours ?? 0; }
      regular = Math.round(regular * 100) / 100; overtime = Math.round(overtime * 100) / 100;
    }
    await c.query(
      `INSERT INTO attendance (tenant_id, employee_id, work_date, status, shift_id, time_in, time_out, regular_hours, overtime_hours, note, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET status = EXCLUDED.status, shift_id = EXCLUDED.shift_id, time_in = EXCLUDED.time_in, time_out = EXCLUDED.time_out,
         regular_hours = EXCLUDED.regular_hours, overtime_hours = EXCLUDED.overtime_hours, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by`,
      [p.tenantId, a.employee_id, a.work_date, a.status, a.shift_id ?? null, a.time_in ?? null, a.time_out ?? null, regular, overtime, a.note ?? null, p.userId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'attendance.recorded', actorUserId: p.userId, entityType: 'employee', entityId: a.employee_id, ip, detail: { date: a.work_date, status: a.status } });
    return { employee_id: a.employee_id, work_date: a.work_date, status: a.status, regular_hours: regular, overtime_hours: overtime };
  });

export const listAttendance = (p: Principal, from: string, to: string, employeeId?: string) =>
  withTenant(p.tenantId, async (c) => (await c.query(
    `SELECT a.id, a.employee_id, e.full_name, a.work_date, a.status, to_char(a.time_in, 'HH24:MI') AS time_in, to_char(a.time_out, 'HH24:MI') AS time_out, a.regular_hours::text, a.overtime_hours::text, a.note
       FROM attendance a JOIN employees e ON e.id = a.employee_id AND e.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.work_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR a.employee_id = $4) ORDER BY a.work_date, e.full_name LIMIT 2000`, [p.tenantId, from, to, employeeId ?? null])).rows);

export const deleteAttendance = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const a = (await c.query<{ work_date: string }>('SELECT work_date::text FROM attendance WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0];
    if (!a) throw notFound('Attendance record');
    await assertNotPaidFor(c, p.tenantId, a.work_date);
    await c.query('DELETE FROM attendance WHERE tenant_id = $1 AND id = $2', [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'attendance.deleted', actorUserId: p.userId, entityType: 'attendance', entityId: id, ip });
    return { deleted: true };
  });

// ------------------------------------------------------------------ statutory rules
export const getRules = (p: Principal) =>
  withTenant(p.tenantId, async (c) => ({
    ot_multiplier: (await c.query<{ m: string }>('SELECT ot_multiplier::text AS m FROM tenant_settings WHERE tenant_id = $1', [p.tenantId])).rows[0]!.m,
    statutory: (await c.query('SELECT code, ee_rate::text, er_rate::text, base_min::text, base_max::text FROM statutory_rules WHERE tenant_id = $1 ORDER BY code', [p.tenantId])).rows,
    brackets: (await c.query('SELECT lower::text, upper::text, base_tax::text, rate::text FROM tax_brackets WHERE tenant_id = $1 ORDER BY lower', [p.tenantId])).rows,
  }));

export const updateRules = (p: Principal, r: RulesIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if (r.ot_multiplier !== undefined) await c.query('UPDATE tenant_settings SET ot_multiplier = $2 WHERE tenant_id = $1', [p.tenantId, r.ot_multiplier]);
    for (const s of r.statutory ?? []) {
      if (toUnits(s.base_max) < toUnits(s.base_min)) throw new ApiError(422, 'invalid_rule', 'The upper salary base cannot be below the lower.');
      await c.query('UPDATE statutory_rules SET ee_rate = $3, er_rate = $4, base_min = $5, base_max = $6 WHERE tenant_id = $1 AND code = $2', [p.tenantId, s.code, s.ee_rate, s.er_rate, s.base_min, s.base_max]);
    }
    if (r.brackets) {
      // Contiguous from zero, in order, the last one open-ended: a gap would silently tax nobody, an overlap twice.
      const b = [...r.brackets].sort((x, y) => (toUnits(x.lower) < toUnits(y.lower) ? -1 : 1));
      if (toUnits(b[0]!.lower) !== 0n) throw new ApiError(422, 'invalid_brackets', 'The first bracket must start at zero.');
      for (let i = 0; i < b.length; i += 1) {
        const last = i === b.length - 1;
        if (last ? b[i]!.upper !== null : b[i]!.upper === null || toUnits(b[i]!.upper!) !== toUnits(b[i + 1]!.lower))
          throw new ApiError(422, 'invalid_brackets', 'Brackets must follow one another without gaps, and the last one must have no upper limit.');
      }
      await c.query('DELETE FROM tax_brackets WHERE tenant_id = $1', [p.tenantId]);
      for (const x of b) await c.query('INSERT INTO tax_brackets (tenant_id, lower, upper, base_tax, rate) VALUES ($1, $2, $3, $4, $5)', [p.tenantId, x.lower, x.upper, x.base_tax, x.rate]);
    }
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.rules_updated', actorUserId: p.userId, ip, detail: { parts: [r.ot_multiplier !== undefined && 'ot', r.statutory && 'statutory', r.brackets && 'brackets'].filter(Boolean) } });
  }).then(() => getRules(p));

// ------------------------------------------------------------------ payroll
interface Rule { code: string; ee: bigint; er: bigint; min: bigint; max: bigint }
interface Bracket { lower: bigint; upper: bigint | null; base: bigint; rate: bigint }

const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);
/** base (4 places) times a percentage (4 places) divided by 100, rounded to the cent. */
const rate = (base: bigint, r: bigint) => roundCent((base * r) / (100n * U));

function tax(monthlyTaxable: bigint, brackets: Bracket[]): bigint {
  if (monthlyTaxable <= 0n) return 0n;
  const b = [...brackets].reverse().find((x) => monthlyTaxable > x.lower) ?? brackets[0]!;
  return roundCent(b.base + rate(monthlyTaxable - b.lower, b.rate) * 1n);
}

interface Slip {
  employee_id: string; employee_name: string; days_worked: bigint; regular_hours: bigint; overtime_hours: bigint; basic: bigint; overtime_pay: bigint; other_earnings: bigint;
  gross: bigint; sss_ee: bigint; philhealth_ee: bigint; pagibig_ee: bigint; tax: bigint; other_deductions: bigint; net: bigint; sss_er: bigint; philhealth_er: bigint; pagibig_er: bigint; warnings: string[];
}

async function rulesFor(c: PoolClient, tenantId: string) {
  const rules = new Map((await c.query<{ code: string; ee_rate: string; er_rate: string; base_min: string; base_max: string }>('SELECT code, ee_rate::text, er_rate::text, base_min::text, base_max::text FROM statutory_rules WHERE tenant_id = $1', [tenantId])).rows
    .map((r) => [r.code, { code: r.code, ee: toUnits(r.ee_rate), er: toUnits(r.er_rate), min: toUnits(r.base_min), max: toUnits(r.base_max) } as Rule]));
  const brackets = (await c.query<{ lower: string; upper: string | null; base_tax: string; rate: string }>('SELECT lower::text, upper::text, base_tax::text, rate::text FROM tax_brackets WHERE tenant_id = $1 ORDER BY lower', [tenantId])).rows
    .map((b) => ({ lower: toUnits(b.lower), upper: b.upper === null ? null : toUnits(b.upper), base: toUnits(b.base_tax), rate: toUnits(b.rate) }) as Bracket);
  const ot = toUnits((await c.query<{ m: string }>('SELECT ot_multiplier::text AS m FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0]!.m);
  if (brackets.length === 0 || !rules.has('sss') || !rules.has('philhealth') || !rules.has('pagibig'))
    throw new ApiError(409, 'no_payroll_rules', 'Set the statutory rates and withholding brackets first.');
  return { rules, brackets, ot };
}

/** One employee's payslip for the period. All amounts in integer units, each rounded to the cent. */
async function computeSlip(c: PoolClient, tenantId: string, run: { id: string; period_start: string; period_end: string; frequency: string }, emp: { id: string; full_name: string; hire_date: string; termination_date: string | null; pay_type: string; rate_enc: string },
  ctx: Awaited<ReturnType<typeof rulesFor>>): Promise<Slip> {
  const R = toUnits(await decryptField(c, tenantId, emp.rate_enc));
  const att = (await c.query<{ status: string; n: string; reg: string; ot: string }>(
    `SELECT status, count(*)::text AS n, COALESCE(sum(regular_hours), 0)::text AS reg, COALESCE(sum(overtime_hours), 0)::text AS ot
       FROM attendance WHERE tenant_id = $1 AND employee_id = $2 AND work_date BETWEEN $3::date AND $4::date GROUP BY status`, [tenantId, emp.id, run.period_start, run.period_end])).rows;
  const get = (s: string) => att.find((x) => x.status === s);
  const present = BigInt(get('present')?.n ?? 0); const leave = BigInt(get('leave')?.n ?? 0); const absent = BigInt(get('absent')?.n ?? 0);
  const regH = toUnits(get('present')?.reg ?? '0'); const otH = toUnits(get('present')?.ot ?? '0');
  const split = run.frequency === 'semi_monthly' ? 2n : 1n;
  const MONTH_DAYS = 21_7500n; // 21.75 working days a month (4 places)
  let basic: bigint; let hourly: bigint;
  if (emp.pay_type === 'monthly') {
    // Prorate for a start or end inside the period, then take off absent days at the daily equivalent.
    const pStart = run.period_start; const pEnd = run.period_end;
    const from = emp.hire_date > pStart ? emp.hire_date : pStart;
    const to = emp.termination_date && emp.termination_date < pEnd ? emp.termination_date : pEnd;
    const employed = BigInt(days(from, to) + 1); const total = BigInt(days(pStart, pEnd) + 1);
    const full = roundCent(R / split);
    basic = employed >= total ? full : roundCent((full * employed) / total);
    const daily = (R * U) / MONTH_DAYS;
    const cut = roundCent(absent * daily);
    basic = basic > cut ? basic - cut : 0n;
    hourly = daily / 8n;
  } else if (emp.pay_type === 'daily') {
    basic = roundCent((present + leave) * R);
    hourly = R / 8n;
  } else {
    basic = roundCent(((regH + leave * 8n * U) * R) / U);
    hourly = R;
  }
  const overtime_pay = roundCent((((otH * hourly) / U) * ctx.ot) / U);
  const adj = (await c.query<{ kind: string; s: string }>('SELECT kind, sum(amount)::text AS s FROM payroll_adjustments WHERE tenant_id = $1 AND employee_id = $2 AND run_id = $3 GROUP BY kind', [tenantId, emp.id, run.id])).rows;
  const other_earnings = toUnits(adj.find((x) => x.kind === 'earning')?.s ?? '0');
  let other_deductions = toUnits(adj.find((x) => x.kind === 'deduction')?.s ?? '0');
  const gross = basic + overtime_pay + other_earnings;
  // Statutory amounts are worked out on a monthly basis and shared across the runs in the month.
  const monthly = gross * split;
  const part = (r: Rule, side: 'ee' | 'er') => rate(clamp(monthly, r.min, r.max), side === 'ee' ? r.ee : r.er) / split;
  const sssR = ctx.rules.get('sss')!; const phR = ctx.rules.get('philhealth')!; const piR = ctx.rules.get('pagibig')!;
  const zero = gross === 0n;
  let [sss_ee, philhealth_ee, pagibig_ee] = zero ? [0n, 0n, 0n] : [roundCent(part(sssR, 'ee')), roundCent(part(phR, 'ee')), roundCent(part(piR, 'ee'))];
  // Minimum salary bases can make a small pay smaller than its contributions. Never take more than was earned: SSS first, then PhilHealth, then Pag-IBIG.
  const warnings: string[] = [];
  if (sss_ee + philhealth_ee + pagibig_ee > gross) {
    let left = gross;
    sss_ee = sss_ee < left ? sss_ee : left; left -= sss_ee;
    philhealth_ee = philhealth_ee < left ? philhealth_ee : left; left -= philhealth_ee;
    pagibig_ee = pagibig_ee < left ? pagibig_ee : left;
    warnings.push(`${emp.full_name}: contributions were limited to the pay earned`);
  }
  const [sss_er, philhealth_er, pagibig_er] = zero ? [0n, 0n, 0n] : [roundCent(part(sssR, 'er')), roundCent(part(phR, 'er')), roundCent(part(piR, 'er'))];
  const eeTotal = sss_ee + philhealth_ee + pagibig_ee;
  const taxable = monthly - eeTotal * split;
  const taxAmt = zero ? 0n : roundCent(tax(taxable, ctx.brackets) / split);
  const room = gross - eeTotal - taxAmt;
  if (other_deductions > room) { warnings.push(`${emp.full_name}: deductions of ${fromUnits(other_deductions)} exceed take-home pay; reduced to ${fromUnits(room > 0n ? room : 0n)}`); other_deductions = room > 0n ? room : 0n; }
  const net = gross - eeTotal - taxAmt - other_deductions;
  return { employee_id: emp.id, employee_name: emp.full_name, days_worked: (present + leave) * U, regular_hours: regH, overtime_hours: otH, basic, overtime_pay, other_earnings, gross,
    sss_ee, philhealth_ee, pagibig_ee, tax: taxAmt, other_deductions, net, sss_er, philhealth_er, pagibig_er, warnings };
}

const RUN_SELECT = `SELECT r.id, r.run_no, r.period_start, r.period_end, r.pay_date, r.frequency, r.status, r.created_by, r.locked_by, r.locked_at, r.journal_entry_id, r.paid_entry_id, r.created_at,
  (SELECT count(*)::int FROM payslips s WHERE s.run_id = r.id) AS employees,
  (SELECT COALESCE(sum(gross), 0)::text FROM payslips s WHERE s.run_id = r.id) AS gross,
  (SELECT COALESCE(sum(net), 0)::text FROM payslips s WHERE s.run_id = r.id) AS net FROM payroll_runs r`;

async function loadRun(c: PoolClient, tenantId: string, id: string, withSlips: boolean) {
  const r = (await c.query(RUN_SELECT + ' WHERE r.tenant_id = $1 AND r.id = $2', [tenantId, id])).rows[0];
  if (!r) throw notFound('Payroll run');
  if (!withSlips) return r;
  const payslips = (await c.query(
    `SELECT id, employee_id, employee_name, days_worked::text, regular_hours::text, overtime_hours::text, basic::text, overtime_pay::text, other_earnings::text, gross::text,
            sss_ee::text, philhealth_ee::text, pagibig_ee::text, tax::text, other_deductions::text, net::text, sss_er::text, philhealth_er::text, pagibig_er::text
       FROM payslips WHERE tenant_id = $1 AND run_id = $2 ORDER BY employee_name`, [tenantId, id])).rows;
  const adjustments = (await c.query('SELECT a.id, a.employee_id, a.kind, a.description, a.amount::text FROM payroll_adjustments a WHERE a.tenant_id = $1 AND a.run_id = $2 ORDER BY a.kind, a.description', [tenantId, id])).rows;
  return { ...r, payslips, adjustments };
}

export const listRuns = (p: Principal) => withTenant(p.tenantId, async (c) => (await c.query(RUN_SELECT + ' WHERE r.tenant_id = $1 ORDER BY r.period_start DESC, r.created_at DESC', [p.tenantId])).rows);
export const getRun = (p: Principal, id: string) => withTenant(p.tenantId, (c) => loadRun(c, p.tenantId, id, true));

async function fill(c: PoolClient, p: Principal, runId: string) {
  const run = (await c.query<{ id: string; period_start: string; period_end: string; frequency: string }>('SELECT id, period_start::text, period_end::text, frequency FROM payroll_runs WHERE tenant_id = $1 AND id = $2', [p.tenantId, runId])).rows[0]!;
  const ctx = await rulesFor(c, p.tenantId);
  const emps = (await c.query<{ id: string; full_name: string; hire_date: string; termination_date: string | null; pay_type: string; rate_enc: string }>(
    `SELECT id, full_name, hire_date::text, termination_date::text, pay_type, rate_enc FROM employees
      WHERE tenant_id = $1 AND status <> 'erased' AND hire_date <= $3::date AND (termination_date IS NULL OR termination_date >= $2::date) ORDER BY emp_no`, [p.tenantId, run.period_start, run.period_end])).rows;
  await c.query('DELETE FROM payslips WHERE tenant_id = $1 AND run_id = $2', [p.tenantId, runId]);
  const warnings: string[] = [];
  for (const e of emps) {
    const s = await computeSlip(c, p.tenantId, run, e, ctx);
    warnings.push(...s.warnings);
    await c.query(
      `INSERT INTO payslips (tenant_id, run_id, employee_id, employee_name, days_worked, regular_hours, overtime_hours, basic, overtime_pay, other_earnings, gross, sss_ee, philhealth_ee, pagibig_ee, tax, other_deductions, net, sss_er, philhealth_er, pagibig_er)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [p.tenantId, runId, s.employee_id, s.employee_name, fromUnits(s.days_worked), fromUnits(s.regular_hours), fromUnits(s.overtime_hours), fromUnits(s.basic), fromUnits(s.overtime_pay), fromUnits(s.other_earnings), fromUnits(s.gross),
        fromUnits(s.sss_ee), fromUnits(s.philhealth_ee), fromUnits(s.pagibig_ee), fromUnits(s.tax), fromUnits(s.other_deductions), fromUnits(s.net), fromUnits(s.sss_er), fromUnits(s.philhealth_er), fromUnits(s.pagibig_er)]);
  }
  return warnings;
}

export const createRun = (p: Principal, a: RunIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if (a.period_end < a.period_start) throw new ApiError(422, 'invalid_period', 'The period end cannot be before its start.');
    if (a.pay_date < a.period_start) throw new ApiError(422, 'invalid_period', 'The pay date cannot be before the period starts.');
    if (days(a.period_start, a.period_end) > 31) throw new ApiError(422, 'invalid_period', 'A payroll period is at most a month.');
    const overlap = await c.query("SELECT 1 FROM payroll_runs WHERE tenant_id = $1 AND period_start <= $3::date AND period_end >= $2::date", [p.tenantId, a.period_start, a.period_end]);
    if (overlap.rowCount) throw new ApiError(409, 'overlapping_run', 'Another payroll run already covers some of those days.');
    const id = (await c.query<{ id: string }>('INSERT INTO payroll_runs (tenant_id, period_start, period_end, pay_date, frequency, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [p.tenantId, a.period_start, a.period_end, a.pay_date, a.frequency, p.userId])).rows[0]!.id;
    const warnings = await fill(c, p, id);
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.run_created', actorUserId: p.userId, entityType: 'payroll_run', entityId: id, ip });
    return { ...(await loadRun(c, p.tenantId, id, true)), warnings };
  });

async function lockDraft(c: PoolClient, tenantId: string, id: string) {
  const r = (await c.query<{ status: string; created_by: string; pay_date: string; period_start: string; period_end: string }>('SELECT status, created_by, pay_date::text, period_start::text, period_end::text FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id])).rows[0];
  if (!r) throw notFound('Payroll run');
  if (r.status !== 'draft') throw new ApiError(409, 'run_locked', 'This payroll run is locked.');
  return r;
}

export const recomputeRun = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await lockDraft(c, p.tenantId, id);
    const warnings = await fill(c, p, id);
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.run_recomputed', actorUserId: p.userId, entityType: 'payroll_run', entityId: id, ip });
    return { ...(await loadRun(c, p.tenantId, id, true)), warnings };
  });

export const deleteRun = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await lockDraft(c, p.tenantId, id);
    await c.query('DELETE FROM payroll_adjustments WHERE tenant_id = $1 AND run_id = $2', [p.tenantId, id]);
    await c.query('DELETE FROM payslips WHERE tenant_id = $1 AND run_id = $2', [p.tenantId, id]);
    await c.query('DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = $2', [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.run_deleted', actorUserId: p.userId, entityType: 'payroll_run', entityId: id, ip });
    return { deleted: true };
  });

export const addAdjustment = (p: Principal, id: string, a: AdjustmentIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await lockDraft(c, p.tenantId, id);
    const e = await c.query("SELECT 1 FROM employees WHERE tenant_id = $1 AND id = $2 AND status <> 'erased'", [p.tenantId, a.employee_id]);
    if (!e.rowCount) throw new ApiError(422, 'invalid_employee', 'Choose an existing employee.');
    await c.query('INSERT INTO payroll_adjustments (tenant_id, run_id, employee_id, kind, description, amount) VALUES ($1, $2, $3, $4, $5, $6)', [p.tenantId, id, a.employee_id, a.kind, a.description, a.amount]);
    const warnings = await fill(c, p, id);
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.adjustment_added', actorUserId: p.userId, entityType: 'payroll_run', entityId: id, ip, detail: { kind: a.kind } });
    return { ...(await loadRun(c, p.tenantId, id, true)), warnings };
  });

export const removeAdjustment = (p: Principal, id: string, adjId: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await lockDraft(c, p.tenantId, id);
    const r = await c.query('DELETE FROM payroll_adjustments WHERE tenant_id = $1 AND run_id = $2 AND id = $3', [p.tenantId, id, adjId]);
    if (!r.rowCount) throw notFound('Adjustment');
    const warnings = await fill(c, p, id);
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.adjustment_removed', actorUserId: p.userId, entityType: 'payroll_run', entityId: id, ip });
    return { ...(await loadRun(c, p.tenantId, id, true)), warnings };
  });

/** Lock: a different person approves, one balanced entry is posted, and the run is frozen by the database. */
export const lockRun = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const run = await lockDraft(c, p.tenantId, id);
    if (run.created_by === p.userId) throw new ApiError(403, 'self_approval', 'The person who prepared a payroll run cannot approve it.');
    await fill(c, p, id); // approve what the current rules and attendance produce, never a stale draft
    const t = (await c.query<{ n: string; gross: string; net: string; tax: string; other: string; ee: string; er: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(gross), 0)::text AS gross, COALESCE(sum(net), 0)::text AS net, COALESCE(sum(tax), 0)::text AS tax, COALESCE(sum(other_deductions), 0)::text AS other,
              COALESCE(sum(sss_ee + philhealth_ee + pagibig_ee), 0)::text AS ee, COALESCE(sum(sss_er + philhealth_er + pagibig_er), 0)::text AS er FROM payslips WHERE tenant_id = $1 AND run_id = $2`, [p.tenantId, id])).rows[0]!;
    if (Number(t.n) === 0 || toUnits(t.gross) === 0n) throw new ApiError(409, 'nothing_to_pay', 'This run has no pay in it.');
    const a = (await c.query<Record<string, string | null>>('SELECT salaries_account_id, employer_contrib_account_id, wht_account_id, contrib_payable_account_id, salaries_payable_account_id FROM tenant_settings WHERE tenant_id = $1', [p.tenantId])).rows[0];
    if (!a?.salaries_account_id || !a.employer_contrib_account_id || !a.wht_account_id || !a.contrib_payable_account_id || !a.salaries_payable_account_id)
      throw new ApiError(409, 'no_payroll_accounts', 'Set the payroll accounts in settings first.');
    const gross = toUnits(t.gross); const er = toUnits(t.er); const ee = toUnits(t.ee); const taxT = toUnits(t.tax); const other = toUnits(t.other); const net = toUnits(t.net);
    const dr = (account_id: string, v: bigint, memo: string) => ({ account_id, debit: fromUnits(v), credit: '0', memo });
    const cr = (account_id: string, v: bigint, memo: string) => ({ account_id, debit: '0', credit: fromUnits(v), memo });
    const lines = [dr(a.salaries_account_id, gross, 'Gross pay')];
    if (er > 0n) lines.push(dr(a.employer_contrib_account_id, er, 'Employer contributions'));
    if (taxT > 0n) lines.push(cr(a.wht_account_id, taxT, 'Withholding tax'));
    if (ee + er + other > 0n) lines.push(cr(a.contrib_payable_account_id, ee + er + other, 'Contributions and deductions'));
    lines.push(cr(a.salaries_payable_account_id, net, 'Net pay'));
    const no = (await c.query<{ seq: string }>("UPDATE doc_counters SET seq = seq + 1 WHERE tenant_id = $1 AND kind = 'pr' RETURNING seq", [p.tenantId])).rows[0]!.seq;
    const entryId = await insertEntry(c, p, { entry_date: run.pay_date, description: `Payroll PR-${no} ${run.period_start} to ${run.period_end}`, reference: `PR-${no}`, lines }, ip, null, { detail: { payroll: `PR-${no}` } });
    await c.query("UPDATE payroll_runs SET status = 'locked', run_no = $3, locked_by = $4, locked_at = now(), journal_entry_id = $5 WHERE tenant_id = $1 AND id = $2", [p.tenantId, id, no, p.userId, entryId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.run_locked', actorUserId: p.userId, entityType: 'payroll_run', entityId: id, ip, detail: { run_no: Number(no), gross: fromUnits(gross), net: fromUnits(net) } });
    return loadRun(c, p.tenantId, id, true);
  });

export const payRun = (p: Principal, id: string, bankAccountId: string, date: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = (await c.query<{ status: string; run_no: string; period_start: string }>('SELECT status, run_no::text, period_start::text FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, id])).rows[0];
    if (!r) throw notFound('Payroll run');
    if (r.status !== 'locked') throw new ApiError(409, r.status === 'paid' ? 'already_paid' : 'not_locked', r.status === 'paid' ? 'This run has already been paid.' : 'Lock the run before paying it.');
    if (date < r.period_start) throw new ApiError(422, 'invalid_date', 'The payment date cannot be before the period starts.');
    const bank = await c.query("SELECT 1 FROM accounts WHERE tenant_id = $1 AND id = $2 AND is_active AND type = 'asset'", [p.tenantId, bankAccountId]);
    if (!bank.rowCount) throw new ApiError(422, 'invalid_account', 'The cash or bank account must be an active asset account.');
    const net = toUnits((await c.query<{ net: string }>('SELECT COALESCE(sum(net), 0)::text AS net FROM payslips WHERE tenant_id = $1 AND run_id = $2', [p.tenantId, id])).rows[0]!.net);
    const payable = (await c.query<{ id: string }>('SELECT salaries_payable_account_id AS id FROM tenant_settings WHERE tenant_id = $1', [p.tenantId])).rows[0]!.id;
    const entryId = await insertEntry(c, p, { entry_date: date, description: `Net pay PR-${r.run_no}`, reference: `PR-${r.run_no}`,
      lines: [{ account_id: payable, debit: fromUnits(net), credit: '0' }, { account_id: bankAccountId, debit: '0', credit: fromUnits(net) }] }, ip, null, { detail: { payroll: `PR-${r.run_no}`, paid: true } });
    await c.query("UPDATE payroll_runs SET status = 'paid', paid_entry_id = $3 WHERE tenant_id = $1 AND id = $2", [p.tenantId, id, entryId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'payroll.run_paid', actorUserId: p.userId, entityType: 'payroll_run', entityId: id, ip, detail: { net: fromUnits(net) } });
    return loadRun(c, p.tenantId, id, false);
  });

/** What the payroll accounts in the ledger should equal: net unpaid, contributions and tax owed. */
export const liabilities = (p: Principal) =>
  withTenant(p.tenantId, async (c) => {
    const t = (await c.query<{ net_unpaid: string; tax: string; contributions: string }>(
      `SELECT COALESCE(sum(s.net) FILTER (WHERE r.status = 'locked'), 0)::text AS net_unpaid, COALESCE(sum(s.tax), 0)::text AS tax,
              COALESCE(sum(s.sss_ee + s.philhealth_ee + s.pagibig_ee + s.sss_er + s.philhealth_er + s.pagibig_er + s.other_deductions), 0)::text AS contributions
         FROM payslips s JOIN payroll_runs r ON r.id = s.run_id AND r.tenant_id = s.tenant_id WHERE s.tenant_id = $1 AND r.status <> 'draft'`, [p.tenantId])).rows[0]!;
    const bal = async (col: string) => toUnits((await c.query<{ b: string | null }>(
      'SELECT sum(l.credit - l.debit)::text AS b FROM journal_lines l WHERE l.tenant_id = $1 AND l.account_id = (SELECT ' + col + ' FROM tenant_settings WHERE tenant_id = $1)', [p.tenantId])).rows[0]?.b ?? '0');
    const ledger = { net_unpaid: await bal('salaries_payable_account_id'), tax: await bal('wht_account_id'), contributions: await bal('contrib_payable_account_id') };
    return {
      payslips: { net_unpaid: fromUnits(toUnits(t.net_unpaid)), tax: fromUnits(toUnits(t.tax)), contributions: fromUnits(toUnits(t.contributions)) },
      ledger: { net_unpaid: fromUnits(ledger.net_unpaid), tax: fromUnits(ledger.tax), contributions: fromUnits(ledger.contributions) },
      reconciles: ledger.net_unpaid === toUnits(t.net_unpaid) && ledger.tax === toUnits(t.tax) && ledger.contributions === toUnits(t.contributions),
    };
  });
