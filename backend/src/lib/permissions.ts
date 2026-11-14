/** Permission catalogue, system roles and route guards (FR-IAM-06/07, FR-AUT-07, BRU-SEC-1: default deny). */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from './errors.js';
import { als } from './logger.js';
import { recordDenied } from './security-events.js';
import { verifyAccessToken, type Principal } from './security.js';

export const P = {
  ACCOUNTS_READ: 'accounts:read',
  ACCOUNTS_WRITE: 'accounts:write',
  JOURNAL_READ: 'journal:read',
  JOURNAL_POST: 'journal:post',
  JOURNAL_REVERSE: 'journal:reverse',
  JOURNAL_APPROVE: 'journal:approve',
  PERIODS_MANAGE: 'periods:manage',
  SETTINGS_MANAGE: 'settings:manage',
  REPORTS_READ: 'reports:read',
  AUDIT_READ: 'audit:read',
  USERS_READ: 'users:read',
  PRIVACY_MANAGE: 'privacy:manage',
  USERS_MANAGE: 'users:manage',
  ROLES_MANAGE: 'roles:manage',
  PLATFORM_MANAGE: 'platform:manage',
} as const;
export type Permission = (typeof P)[keyof typeof P];
export const ALL_PERMISSIONS: Permission[] = Object.values(P);
/** What a workspace can ever grant. `platform:manage` belongs to the operator's own tenant only. */
export const TENANT_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => p !== P.PLATFORM_MANAGE);

export type Module = 'finance' | 'supply_chain' | 'production' | 'hcm' | 'bi';
export const MODULES: Module[] = ['finance', 'supply_chain', 'production', 'hcm', 'bi'];
/** Which subscribed module a permission belongs to. 'core' is always available. */
export const MODULE_OF: Record<Permission, Module | 'core' | 'platform'> = {
  'accounts:read': 'finance', 'accounts:write': 'finance', 'journal:read': 'finance', 'journal:post': 'finance',
  'journal:reverse': 'finance', 'journal:approve': 'finance', 'reports:read': 'finance', 'periods:manage': 'finance',
  'audit:read': 'core', 'settings:manage': 'core', 'users:read': 'core', 'users:manage': 'core', 'roles:manage': 'core',
  'privacy:manage': 'core', 'platform:manage': 'platform',
};
export const PERMISSION_LABELS: Record<Permission, string> = {
  'accounts:read': 'See the chart of accounts', 'accounts:write': 'Add and change accounts',
  'journal:read': 'See journal entries and drafts', 'journal:post': 'Save drafts, post and submit entries',
  'journal:reverse': 'Reverse posted entries', 'journal:approve': 'Approve entries and send them back',
  'reports:read': 'See reports and fiscal periods', 'periods:manage': 'Close and reopen fiscal periods',
  'audit:read': 'Read the audit log', 'settings:manage': 'Change workspace settings',
  'users:read': 'See people and roles', 'users:manage': 'Invite, deactivate and assign roles to people',
  'roles:manage': 'Create and change custom roles', 'privacy:manage': 'Export and erase personal data',
  'platform:manage': 'Operate the platform',
};

const accountant: Permission[] = [P.ACCOUNTS_READ, P.ACCOUNTS_WRITE, P.JOURNAL_READ, P.JOURNAL_POST, P.JOURNAL_REVERSE, P.REPORTS_READ];

export const SYSTEM_ROLES: Record<string, Permission[]> = {
  TenantAdmin: TENANT_PERMISSIONS,
  Accountant: accountant,
  Viewer: [P.ACCOUNTS_READ, P.JOURNAL_READ, P.REPORTS_READ],
  // Customer persona: the finance manager approves entries, closes periods and sets the approval policy.
  FinanceManager: [...accountant, P.JOURNAL_APPROVE, P.PERIODS_MANAGE, P.SETTINGS_MANAGE, P.AUDIT_READ],
};
/** Public demo role: posts and reads like an Accountant plus the audit log; no administration. */
export const DEMO_ROLE: [string, Permission[]] = ['DemoUser', [...accountant, P.AUDIT_READ]];

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export const GUARD = Symbol('erpatio.guard');
export interface GuardInfo {
  kind: 'public' | 'authenticated' | 'permission';
  permission?: Permission;
  reason?: string;
}
type Guarded = RequestHandler & { [GUARD]: GuardInfo };

const tag = (fn: RequestHandler, info: GuardInfo): Guarded => Object.assign(fn, { [GUARD]: info });

/** Explicitly public route. The reason is mandatory so exposure is always a conscious decision. */
export const publicRoute = (reason: string): Guarded =>
  tag((_req: Request, _res: Response, next: NextFunction) => next(), { kind: 'public', reason });

/** `null` = any authenticated user (e.g. /auth/me). */
export function requirePermission(permission: Permission | null, opts: { allowMfaEnroll?: boolean } = {}): Guarded {
  const handler: RequestHandler = async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token)
      return next(new ApiError(401, 'unauthenticated', 'Authentication required.', { 'WWW-Authenticate': 'Bearer' }));
    let principal: Principal;
    try {
      principal = await verifyAccessToken(token);
    } catch {
      return next(new ApiError(401, 'invalid_token', 'Your session is invalid or has expired.', { 'WWW-Authenticate': 'Bearer' }));
    }
    const ctx = als.getStore();
    if (ctx) ctx.tenantId = principal.tenantId;
    req.principal = principal;
    const mod = permission ? MODULE_OF[permission] : null;
    if (mod && mod !== 'core' && mod !== 'platform' && !(principal.modules ?? ['finance']).includes(mod))
      return next(new ApiError(403, 'module_disabled', 'This module is not part of your subscription.'));
    if (principal.mfaEnrollRequired && !opts.allowMfaEnroll)
      return next(new ApiError(403, 'mfa_enrollment_required', 'Set up two-factor sign-in before continuing.'));
    if (permission && !principal.permissions.includes(permission)) {
      recordDenied(principal, permission, req.method, req.path);
      return next(new ApiError(403, 'forbidden', 'You do not have permission to do that.'));
    }
    next();
  };
  return tag(handler, permission ? { kind: 'permission', permission } : { kind: 'authenticated' });
}

/** Walks the real Express router and returns every route whose handler chain has no guard. */
export function unguardedRoutes(app: { router: unknown }): string[] {
  const bad: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const handlers: unknown[] = layer.route.stack.map((l: { handle: unknown }) => l.handle);
        const ok = handlers.some((h) => typeof h === 'function' && GUARD in (h as object));
        if (!ok) {
          const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
          bad.push(`${methods} ${prefix}${layer.route.path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walk((app.router as any).stack, '');
  return bad.sort();
}

export function assertAllRoutesGuarded(app: { router: unknown }): void {
  const bad = unguardedRoutes(app);
  if (bad.length) throw new Error(`Routes without a declared guard: ${bad.join(', ')}`);
}
