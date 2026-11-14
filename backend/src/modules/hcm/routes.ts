import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission } from '../../lib/permissions.js';
import { ApiError } from '../../lib/errors.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import * as svc from './service.js';
import { AdjustmentIn, AttendanceIn, AttendanceQuery, EmpListQuery, EmployeeIn, EmployeePatch, PayIn, RulesIn, RunIn, ShiftIn, ShiftPatch, TerminateIn } from './schemas.js';

const AdjParam = z.object({ id: z.uuid(), adjId: z.uuid() });

export function hcmRouter(prefix: string): Router {
  const r = Router();
  const tag = 'hcm';
  const eRead = requirePermission(P.EMPLOYEES_READ);
  const eWrite = requirePermission(P.EMPLOYEES_WRITE);
  const pRead = requirePermission(P.PAYROLL_READ);
  const pManage = requirePermission(P.PAYROLL_MANAGE);
  const pApprove = requirePermission(P.PAYROLL_APPROVE);
  const privacy = requirePermission(P.PRIVACY_MANAGE);

  route(r, prefix, { method: 'get', path: '/employees', tag, summary: 'List employees (no pay, no identifiers)', guard: eRead, query: EmpListQuery, handler: ({ principal, query }) => svc.listEmployees(principal, query.status) });
  route(r, prefix, { method: 'post', path: '/employees', tag, summary: 'Add an employee', status: 201, guard: eWrite, body: EmployeeIn,
    handler: async ({ principal, body, req }) => {
      // Setting a pay rate is a payroll decision as well as an HR one.
      if (!principal.permissions.includes(P.PAYROLL_MANAGE)) throw new ApiError(403, 'forbidden', 'Adding an employee sets a pay rate, which needs payroll access.');
      return svc.createEmployee(principal, body, req.ip);
    } });
  route(r, prefix, { method: 'get', path: '/employees/:id', tag, summary: 'One employee', guard: eRead, params: IdParam, handler: ({ principal, params }) => svc.getEmployee(principal, params.id) });
  route(r, prefix, { method: 'patch', path: '/employees/:id', tag, summary: 'Change an employee', guard: eWrite, params: IdParam, body: EmployeePatch,
    handler: ({ principal, params, body, req }) => svc.updateEmployee(principal, params.id, body, principal.permissions.includes(P.PAYROLL_MANAGE), req.ip) });
  route(r, prefix, { method: 'post', path: '/employees/:id/terminate', tag, summary: 'Record an end of employment', guard: eWrite, params: IdParam, body: TerminateIn,
    handler: ({ principal, params, body, req }) => svc.terminateEmployee(principal, params.id, body.date, req.ip) });
  route(r, prefix, { method: 'get', path: '/employees/:id/identifiers', tag, summary: 'Show identifiers and bank account (audited)', guard: eWrite, params: IdParam, handler: ({ principal, params, req }) => svc.revealIdentifiers(principal, params.id, req.ip) });
  route(r, prefix, { method: 'get', path: '/employees/:id/compensation', tag, summary: 'Show the pay rate (audited)', guard: pRead, params: IdParam, handler: ({ principal, params, req }) => svc.revealCompensation(principal, params.id, req.ip) });
  route(r, prefix, { method: 'get', path: '/employees/:id/export', tag, summary: 'Everything held about one employee (audited)', guard: privacy, params: IdParam, handler: ({ principal, params, req }) => svc.exportEmployee(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/employees/:id/erase', tag, summary: 'Pseudonymise a former employee', guard: privacy, params: IdParam, handler: ({ principal, params, req }) => svc.eraseEmployee(principal, params.id, req.ip) });

  route(r, prefix, { method: 'get', path: '/shifts', tag, summary: 'List shifts', guard: eRead, handler: ({ principal }) => svc.listShifts(principal) });
  route(r, prefix, { method: 'post', path: '/shifts', tag, summary: 'Create a shift', status: 201, guard: eWrite, body: ShiftIn, handler: ({ principal, body, req }) => svc.createShift(principal, body, req.ip) });
  route(r, prefix, { method: 'patch', path: '/shifts/:id', tag, summary: 'Change a shift', guard: eWrite, params: IdParam, body: ShiftPatch, handler: ({ principal, params, body, req }) => svc.updateShift(principal, params.id, body, req.ip) });

  route(r, prefix, { method: 'get', path: '/attendance', tag, summary: 'Attendance for a date range', guard: eRead, query: AttendanceQuery, handler: ({ principal, query }) => svc.listAttendance(principal, query.from, query.to, query.employee_id) });
  route(r, prefix, { method: 'post', path: '/attendance', tag, summary: 'Record a day (hours are worked out from the shift)', status: 201, guard: eWrite, body: AttendanceIn, handler: ({ principal, body, req }) => svc.recordAttendance(principal, body, req.ip) });
  route(r, prefix, { method: 'delete', path: '/attendance/:id', tag, summary: 'Remove a day that is not in a locked run', guard: eWrite, params: IdParam, handler: ({ principal, params, req }) => svc.deleteAttendance(principal, params.id, req.ip) });

  route(r, prefix, { method: 'get', path: '/payroll/rules', tag, summary: 'Statutory rates, withholding brackets and overtime multiplier', guard: pRead, handler: ({ principal }) => svc.getRules(principal) });
  route(r, prefix, { method: 'put', path: '/payroll/rules', tag, summary: 'Update the rules', guard: pManage, body: RulesIn, handler: ({ principal, body, req }) => svc.updateRules(principal, body, req.ip) });
  route(r, prefix, { method: 'get', path: '/payroll/liabilities', tag: 'reports', summary: 'Payroll liabilities in payslips against the ledger', guard: pRead, handler: ({ principal }) => svc.liabilities(principal) });

  route(r, prefix, { method: 'get', path: '/payroll-runs', tag, summary: 'List payroll runs', guard: pRead, handler: ({ principal }) => svc.listRuns(principal) });
  route(r, prefix, { method: 'post', path: '/payroll-runs', tag, summary: 'Prepare a payroll run for a period', status: 201, guard: pManage, body: RunIn, handler: ({ principal, body, req }) => svc.createRun(principal, body, req.ip) });
  route(r, prefix, { method: 'get', path: '/payroll-runs/:id', tag, summary: 'One run with payslips', guard: pRead, params: IdParam, handler: ({ principal, params }) => svc.getRun(principal, params.id) });
  route(r, prefix, { method: 'delete', path: '/payroll-runs/:id', tag, summary: 'Delete a draft run', guard: pManage, params: IdParam, handler: ({ principal, params, req }) => svc.deleteRun(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/payroll-runs/:id/recompute', tag, summary: 'Recompute a draft from current attendance and rules', guard: pManage, params: IdParam, handler: ({ principal, params, req }) => svc.recomputeRun(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/payroll-runs/:id/adjustments', tag, summary: 'Add a one-off earning or deduction to a draft', status: 201, guard: pManage, params: IdParam, body: AdjustmentIn, handler: ({ principal, params, body, req }) => svc.addAdjustment(principal, params.id, body, req.ip) });
  route(r, prefix, { method: 'delete', path: '/payroll-runs/:id/adjustments/:adjId', tag, summary: 'Remove an adjustment from a draft', guard: pManage, params: AdjParam, handler: ({ principal, params, req }) => svc.removeAdjustment(principal, params.id, params.adjId, req.ip) });
  route(r, prefix, { method: 'post', path: '/payroll-runs/:id/lock', tag, summary: 'Approve, post to the ledger and freeze (not by the preparer)', guard: pApprove, params: IdParam, handler: ({ principal, params, req }) => svc.lockRun(principal, params.id, req.ip) });
  route(r, prefix, { method: 'post', path: '/payroll-runs/:id/pay', tag, summary: 'Record the payment of net pay', guard: pApprove, params: IdParam, body: PayIn, handler: ({ principal, params, body, req }) => svc.payRun(principal, params.id, body.bank_account_id, body.date, req.ip) });
  return r;
}
