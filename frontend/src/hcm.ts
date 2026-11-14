/** People and payroll endpoints. */
import { api } from './api';

export interface Employee { id: string; emp_no: string; full_name: string; email: string | null; phone: string | null; department: string | null; position: string | null; hire_date: string; termination_date: string | null; status: 'active' | 'terminated' | 'erased'; pay_type: 'monthly' | 'daily' | 'hourly'; has_tin: boolean; has_sss: boolean; has_philhealth: boolean; has_pagibig: boolean; has_bank_account: boolean }
export interface EmployeeInput { full_name: string; email?: string; phone?: string; department?: string; position?: string; hire_date: string; pay_type: 'monthly' | 'daily' | 'hourly'; rate: string; tin?: string; sss?: string; philhealth?: string; pagibig?: string; bank_account?: string; birth_date?: string }
export interface Shift { id: string; code: string; name: string; start_time: string; end_time: string; break_minutes: number; is_active: boolean }
export interface AttendanceRow { id: string; employee_id: string; full_name: string; work_date: string; status: string; time_in: string | null; time_out: string | null; regular_hours: string; overtime_hours: string; note: string | null }
export interface Payslip { id: string; employee_id: string; employee_name: string; days_worked: string; regular_hours: string; overtime_hours: string; basic: string; overtime_pay: string; other_earnings: string; gross: string; sss_ee: string; philhealth_ee: string; pagibig_ee: string; tax: string; other_deductions: string; net: string; sss_er: string; philhealth_er: string; pagibig_er: string }
export interface Run { id: string; run_no: string | null; period_start: string; period_end: string; pay_date: string; frequency: 'monthly' | 'semi_monthly'; status: 'draft' | 'locked' | 'paid'; created_by: string; locked_by: string | null; journal_entry_id: string | null; employees: number; gross: string; net: string }
export interface RunDetail extends Run { payslips: Payslip[]; adjustments: { id: string; employee_id: string; kind: 'earning' | 'deduction'; description: string; amount: string }[]; warnings?: string[] }
export interface Rules { ot_multiplier: string; statutory: { code: string; ee_rate: string; er_rate: string; base_min: string; base_max: string }[]; brackets: { lower: string; upper: string | null; base_tax: string; rate: string }[] }
export interface Liabilities { payslips: { net_unpaid: string; tax: string; contributions: string }; ledger: { net_unpaid: string; tax: string; contributions: string }; reconciles: boolean }

export const hcm = {
  employees: () => api<Employee[]>('/employees'),
  createEmployee: (e: EmployeeInput) => api<Employee>('/employees', { method: 'POST', json: e }),
  terminate: (id: string, date: string) => api<Employee>(`/employees/${id}/terminate`, { method: 'POST', json: { date } }),
  identifiers: (id: string) => api<Record<string, string | null>>(`/employees/${id}/identifiers`),
  shifts: () => api<Shift[]>('/shifts'),
  createShift: (s: { code: string; name: string; start_time: string; end_time: string; break_minutes: number }) => api<Shift>('/shifts', { method: 'POST', json: s }),
  attendance: (from: string, to: string) => api<AttendanceRow[]>(`/attendance?from=${from}&to=${to}`),
  record: (a: { employee_id: string; work_date: string; status: string; shift_id?: string; time_in?: string; time_out?: string }) => api('/attendance', { method: 'POST', json: a }),
  removeDay: (id: string) => api(`/attendance/${id}`, { method: 'DELETE' }),
  runs: () => api<Run[]>('/payroll-runs'),
  run: (id: string) => api<RunDetail>(`/payroll-runs/${id}`),
  createRun: (r: { period_start: string; period_end: string; pay_date: string; frequency: string }) => api<RunDetail>('/payroll-runs', { method: 'POST', json: r }),
  recompute: (id: string) => api<RunDetail>(`/payroll-runs/${id}/recompute`, { method: 'POST' }),
  deleteRun: (id: string) => api(`/payroll-runs/${id}`, { method: 'DELETE' }),
  addAdjustment: (id: string, a: { employee_id: string; kind: string; description: string; amount: string }) => api<RunDetail>(`/payroll-runs/${id}/adjustments`, { method: 'POST', json: a }),
  removeAdjustment: (id: string, adj: string) => api<RunDetail>(`/payroll-runs/${id}/adjustments/${adj}`, { method: 'DELETE' }),
  lock: (id: string) => api<RunDetail>(`/payroll-runs/${id}/lock`, { method: 'POST' }),
  pay: (id: string, bank_account_id: string, date: string) => api(`/payroll-runs/${id}/pay`, { method: 'POST', json: { bank_account_id, date } }),
  rules: () => api<Rules>('/payroll/rules'),
  saveRules: (r: Partial<{ ot_multiplier: number; statutory: Rules['statutory']; brackets: Rules['brackets'] }>) => api<Rules>('/payroll/rules', { method: 'PUT', json: r }),
  liabilities: () => api<Liabilities>('/payroll/liabilities'),
};
