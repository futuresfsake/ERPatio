import { z } from 'zod';

const isoDate = z.iso.date();
const money = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Amount must be a decimal with at most 4 places');
const rate = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).refine((v) => Number(v) <= 100, 'Rate must be 0 to 100');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM');
const idText = z.string().trim().min(1).max(40);

export const EmployeeIn = z.object({
  full_name: z.string().trim().min(1).max(200),
  email: z.email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  department: z.string().trim().max(100).optional(),
  position: z.string().trim().max(100).optional(),
  hire_date: isoDate,
  pay_type: z.enum(['monthly', 'daily', 'hourly']),
  rate: money.refine((v) => Number(v) > 0, 'Rate must be above zero'),
  tin: idText.optional(), sss: idText.optional(), philhealth: idText.optional(), pagibig: idText.optional(),
  bank_account: idText.optional(), birth_date: isoDate.optional(),
});
export type EmployeeIn = z.infer<typeof EmployeeIn>;

export const EmployeePatch = z.object({
  full_name: z.string().trim().min(1).max(200), email: z.email().max(254).nullable(), phone: z.string().trim().max(40).nullable(),
  department: z.string().trim().max(100).nullable(), position: z.string().trim().max(100).nullable(),
  pay_type: z.enum(['monthly', 'daily', 'hourly']), rate: money.refine((v) => Number(v) > 0, 'Rate must be above zero'),
  tin: idText.nullable(), sss: idText.nullable(), philhealth: idText.nullable(), pagibig: idText.nullable(),
  bank_account: idText.nullable(), birth_date: isoDate.nullable(),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type EmployeePatch = z.infer<typeof EmployeePatch>;

export const TerminateIn = z.object({ date: isoDate });
export const EmpListQuery = z.object({ status: z.enum(['active', 'terminated', 'erased']).optional() });

export const ShiftIn = z.object({ code: z.string().regex(/^[A-Za-z0-9._-]{1,20}$/), name: z.string().trim().min(1).max(100), start_time: hhmm, end_time: hhmm, break_minutes: z.number().int().min(0).max(240).default(60) });
export const ShiftPatch = z.object({ name: z.string().trim().min(1).max(100), start_time: hhmm, end_time: hhmm, break_minutes: z.number().int().min(0).max(240), is_active: z.boolean() }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const AttendanceIn = z.object({
  employee_id: z.uuid(), work_date: isoDate, status: z.enum(['present', 'absent', 'leave']),
  shift_id: z.uuid().optional(), time_in: hhmm.optional(), time_out: hhmm.optional(),
  regular_hours: z.number().min(0).max(24).optional(), overtime_hours: z.number().min(0).max(24).optional(), note: z.string().trim().max(200).optional(),
});
export type AttendanceIn = z.infer<typeof AttendanceIn>;
export const AttendanceQuery = z.object({ from: isoDate, to: isoDate, employee_id: z.uuid().optional() });

export const RulesIn = z.object({
  ot_multiplier: z.number().min(1).max(3).optional(),
  statutory: z.array(z.object({ code: z.enum(['sss', 'philhealth', 'pagibig']), ee_rate: rate, er_rate: rate, base_min: money, base_max: money })).max(3).optional(),
  brackets: z.array(z.object({ lower: money, upper: money.nullable(), base_tax: money, rate })).min(1).max(12).optional(),
}).refine((v) => v.ot_multiplier !== undefined || v.statutory !== undefined || v.brackets !== undefined, 'Nothing to update');
export type RulesIn = z.infer<typeof RulesIn>;

export const RunIn = z.object({ period_start: isoDate, period_end: isoDate, pay_date: isoDate, frequency: z.enum(['monthly', 'semi_monthly']) });
export type RunIn = z.infer<typeof RunIn>;
export const AdjustmentIn = z.object({ employee_id: z.uuid(), kind: z.enum(['earning', 'deduction']), description: z.string().trim().min(1).max(200), amount: money.refine((v) => Number(v) > 0, 'Amount must be above zero') });
export type AdjustmentIn = z.infer<typeof AdjustmentIn>;
export const PayIn = z.object({ bank_account_id: z.uuid(), date: isoDate });
