import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { getEnv } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { publicRoute, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import * as svc from './service.js';

export const COOKIE = 'erp_refresh';
const COOKIE_PATH = '/api/v1/auth';

const LoginBody = z.object({
  workspace: z.string().trim().min(2).max(40),
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});

function cookieOptions(): CookieOptions {
  const env = getEnv();
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path: COOKIE_PATH, maxAge: env.REFRESH_DAYS * 86_400_000 };
}

const body = (s: svc.Session) => ({
  access_token: s.accessToken,
  token_type: 'bearer' as const,
  expires_in: s.expiresIn,
  user: s.user,
});

function csrfGuard(req: { headers: Record<string, unknown> }) {
  // SameSite=Strict is the primary defence; a custom header cannot be sent cross-site without CORS approval.
  if (req.headers['x-requested-with'] !== 'erpatio') throw new ApiError(403, 'csrf', 'Missing required header.');
}

const clear = (res: Response) => res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });

export function authRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, {
    method: 'post', path: '/login', tag: 'auth', summary: 'Sign in with workspace, email and password',
    guard: publicRoute('credential exchange'), body: LoginBody,
    handler: async ({ req, res, body: b }) => {
      const s = await svc.login(b.workspace, b.email, b.password, req.ip, req.get('user-agent'));
      res.cookie(COOKIE, s.refreshToken, cookieOptions());
      return body(s);
    },
  });

  route(r, prefix, {
    method: 'post', path: '/refresh', tag: 'auth', summary: 'Rotate the refresh cookie and get a new access token',
    guard: publicRoute('authenticated by the HttpOnly refresh cookie'),
    handler: async ({ req, res }) => {
      csrfGuard(req);
      try {
        const raw = req.cookies?.[COOKIE] as string | undefined;
        if (!raw) throw new ApiError(401, 'invalid_token', 'Session expired. Please sign in again.');
        const s = await svc.refresh(raw, req.ip, req.get('user-agent'));
        res.cookie(COOKIE, s.refreshToken, cookieOptions());
        return body(s);
      } catch (e) {
        clear(res);
        throw e;
      }
    },
  });

  route(r, prefix, {
    method: 'post', path: '/logout', tag: 'auth', summary: 'Revoke the session', status: 204,
    guard: publicRoute('idempotent; acts only on the caller\'s own refresh cookie'),
    handler: async ({ req, res }) => {
      csrfGuard(req);
      await svc.logout(req.cookies?.[COOKIE] as string | undefined, req.ip);
      clear(res);
      return undefined;
    },
  });

  route(r, prefix, {
    method: 'get', path: '/me', tag: 'auth', summary: 'Current principal',
    guard: requirePermission(null),
    handler: async ({ principal }) => ({
      id: principal.userId, tenant_id: principal.tenantId, roles: principal.roles, permissions: principal.permissions,
    }),
  });

  return r;
}
