import { Router } from 'express';
import { z } from 'zod';
import { P, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import * as svc from './service.js';
import * as ye from './yearend.js';

const IdParam = z.object({ id: z.uuid() });
const YearParam = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
const YearBody = z.object({ year: z.number().int().min(2000).max(2100) });
const ReopenBody = z.object({ reason: z.string().trim().min(3).max(300) });
const SettingsBody = z.object({ require_approval: z.boolean() });

export function periodsRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, { method: 'get', path: '/fiscal-periods', tag: 'finance', summary: 'List fiscal periods',
    guard: requirePermission(P.REPORTS_READ), handler: ({ principal }) => svc.listPeriods(principal) });

  route(r, prefix, { method: 'post', path: '/fiscal-years', tag: 'finance', summary: 'Create the twelve periods of a fiscal year', status: 201,
    guard: requirePermission(P.PERIODS_MANAGE), body: YearBody,
    handler: ({ principal, body, req }) => svc.createFiscalYear(principal, body.year, req.ip) });

  route(r, prefix, { method: 'post', path: '/fiscal-periods/:id/close', tag: 'finance', summary: 'Close and lock a period',
    guard: requirePermission(P.PERIODS_MANAGE), params: IdParam,
    handler: ({ principal, params, req }) => svc.closePeriod(principal, params.id, req.ip) });

  route(r, prefix, { method: 'post', path: '/fiscal-periods/:id/reopen', tag: 'finance', summary: 'Reopen a closed period (reason required)',
    guard: requirePermission(P.PERIODS_MANAGE), params: IdParam, body: ReopenBody,
    handler: ({ principal, params, body, req }) => svc.reopenPeriod(principal, params.id, body.reason, req.ip) });

  route(r, prefix, { method: 'get', path: '/fiscal-years/:year/closing-preview', tag: 'finance', summary: 'What a year-end close would post',
    guard: requirePermission(P.PERIODS_MANAGE), params: YearParam, handler: ({ principal, params }) => ye.closingPreview(principal, params.year) });

  route(r, prefix, { method: 'post', path: '/fiscal-years/:year/close', tag: 'finance', summary: 'Close the year into retained earnings', status: 201,
    guard: requirePermission(P.PERIODS_MANAGE), params: YearParam,
    handler: ({ principal, params, req }) => ye.closeYear(principal, params.year, req.ip) });

  route(r, prefix, { method: 'get', path: '/settings', tag: 'settings', summary: 'Workspace settings',
    guard: requirePermission(P.JOURNAL_READ), handler: ({ principal }) => svc.getSettings(principal) });

  route(r, prefix, { method: 'patch', path: '/settings', tag: 'settings', summary: 'Change workspace settings',
    guard: requirePermission(P.SETTINGS_MANAGE), body: SettingsBody,
    handler: ({ principal, body, req }) => svc.updateSettings(principal, body.require_approval, req.ip) });

  return r;
}
