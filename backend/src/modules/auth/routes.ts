import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { getEnv } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { publicRoute, requirePermission } from '../../lib/permissions.js';
import { route } from '../../lib/route.js';
import { IdParam } from '../ledger/schemas.js';
import * as account from './account.js';
import * as mfa from './mfa.js';
import * as svc from './service.js';

export const COOKIE = 'erp_refresh';
const COOKIE_PATH = '/api/v1/auth';

const Workspace = z.string().trim().min(2).max(40);
const Email = z.email().max(254);
const LoginBody = z.object({ workspace: Workspace, email: Email, password: z.string().min(1).max(256) });
const MfaLoginBody = z.object({ mfa_token: z.string().min(10).max(2000), code: z.string().trim().min(6).max(20) });
const SignupBody = z.object({
  company: z.string().trim().min(2).max(120),
  full_name: z.string().trim().min(1).max(200),
  email: Email,
  password: z.string().min(1).max(256),
  accept_privacy: z.literal(true, { error: 'You must accept the privacy notice.' }),
});
const TokenBody = z.object({ token: z.string().min(20).max(300) });
const WhoBody = z.object({ workspace: Workspace, email: Email });
const ResetBody = z.object({ token: z.string().min(20).max(300), password: z.string().min(1).max(256) });
const CodeBody = z.object({ code: z.string().trim().min(6).max(20) });
const DisableBody = z.object({ password: z.string().min(1).max(256), code: z.string().trim().min(6).max(20) });

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
const setSession = (res: Response, s: svc.Session) => {
  if (s.refreshToken) res.cookie(COOKIE, s.refreshToken, cookieOptions());
  return body(s);
};
const accepted = (message: string) => ({ message });

export function authRouter(prefix: string): Router {
  const r = Router();

  route(r, prefix, {
    method: 'post', path: '/login', tag: 'auth', summary: 'Sign in with workspace, email and password',
    guard: publicRoute('credential exchange'), body: LoginBody,
    handler: async ({ req, res, body: b }) => {
      const out = await svc.login(b.workspace, b.email, b.password, req.ip, req.get('user-agent'));
      if (out.kind === 'mfa') return { mfa_required: true, mfa_token: out.mfaToken };
      return setSession(res, out.session);
    },
  });

  route(r, prefix, {
    method: 'post', path: '/login/mfa', tag: 'auth', summary: 'Second sign-in step: a 6-digit code or a recovery code',
    guard: publicRoute('second factor; proves possession of the step token from /login'), body: MfaLoginBody,
    handler: async ({ req, res, body: b }) => setSession(res, await svc.loginMfa(b.mfa_token, b.code, req.ip, req.get('user-agent'))),
  });

  route(r, prefix, {
    method: 'post', path: '/refresh', tag: 'auth', summary: 'Rotate the refresh cookie and get a new access token',
    guard: publicRoute('authenticated by the HttpOnly refresh cookie'),
    handler: async ({ req, res }) => {
      csrfGuard(req);
      try {
        const raw = req.cookies?.[COOKIE] as string | undefined;
        if (!raw) throw new ApiError(401, 'invalid_token', 'Session expired. Please sign in again.');
        return setSession(res, await svc.refresh(raw, req.ip, req.get('user-agent')));
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

  // ---- self-service account lifecycle. All answer identically whether or not the account exists.
  route(r, prefix, {
    method: 'post', path: '/signup', tag: 'account', summary: 'Create a workspace and its first administrator', status: 202,
    guard: publicRoute('self-service sign-up; disabled unless SIGNUP_ENABLED'), body: SignupBody,
    handler: async ({ req, body: b }) => {
      await account.signup({ company: b.company, fullName: b.full_name, email: b.email, password: b.password, acceptPrivacy: b.accept_privacy }, req.ip);
      return accepted('Check your email to confirm your address.');
    },
  });
  route(r, prefix, {
    method: 'post', path: '/verify-email', tag: 'account', summary: 'Confirm an email address with the emailed token',
    guard: publicRoute('authenticated by a one-time emailed token'), body: TokenBody,
    handler: async ({ req, body: b }) => { await account.verifyEmail(b.token, req.ip); return accepted('Email confirmed. You can sign in.'); },
  });
  route(r, prefix, {
    method: 'post', path: '/resend-verification', tag: 'account', summary: 'Send the confirmation email again', status: 202,
    guard: publicRoute('always answers the same'), body: WhoBody,
    handler: async ({ body: b }) => { await account.resendVerification(b.workspace, b.email); return accepted('If that account needs confirming, an email is on its way.'); },
  });
  route(r, prefix, {
    method: 'post', path: '/forgot-password', tag: 'account', summary: 'Email a password-reset link', status: 202,
    guard: publicRoute('always answers the same'), body: WhoBody,
    handler: async ({ body: b }) => { await account.forgotPassword(b.workspace, b.email); return accepted('If that account exists, an email is on its way.'); },
  });
  route(r, prefix, {
    method: 'post', path: '/reset-password', tag: 'account', summary: 'Choose a new password with the emailed token',
    guard: publicRoute('authenticated by a one-time emailed token'), body: ResetBody,
    handler: async ({ req, body: b }) => { await account.resetPassword(b.token, b.password, req.ip); return accepted('Password changed. Sign in with the new one.'); },
  });

  // ---- the signed-in person
  route(r, prefix, {
    method: 'get', path: '/me', tag: 'auth', summary: 'Current person and their security state',
    guard: requirePermission(null, { allowMfaEnroll: true }), handler: ({ principal }) => mfa.getMe(principal),
  });
  route(r, prefix, {
    method: 'post', path: '/2fa/setup', tag: 'auth', summary: 'Start two-factor setup: returns the secret to scan',
    guard: requirePermission(null, { allowMfaEnroll: true }), handler: ({ principal }) => mfa.setupMfa(principal),
  });
  route(r, prefix, {
    method: 'post', path: '/2fa/enable', tag: 'auth', summary: 'Confirm a code, turn 2FA on, and get recovery codes (shown once)',
    guard: requirePermission(null, { allowMfaEnroll: true }), body: CodeBody,
    handler: ({ principal, body: b, req }) => mfa.enableMfa(principal, b.code, req.ip),
  });
  route(r, prefix, {
    method: 'post', path: '/2fa/disable', tag: 'auth', summary: 'Turn 2FA off (needs the password and a code)',
    guard: requirePermission(null), body: DisableBody,
    handler: ({ principal, body: b, req }) => mfa.disableMfa(principal, b.password, b.code, req.ip),
  });
  route(r, prefix, {
    method: 'get', path: '/sessions', tag: 'auth', summary: 'Where you are signed in',
    guard: requirePermission(null), handler: ({ principal }) => mfa.listSessions(principal),
  });
  route(r, prefix, {
    method: 'delete', path: '/sessions/:id', tag: 'auth', summary: 'Sign out one session', status: 204,
    guard: requirePermission(null), params: IdParam,
    handler: async ({ principal, params, req }) => { await mfa.revokeSession(principal, params.id, req.ip); return undefined; },
  });
  route(r, prefix, {
    method: 'post', path: '/sessions/revoke-all', tag: 'auth', summary: 'Sign out everywhere',
    guard: requirePermission(null), handler: ({ principal, req }) => mfa.revokeAllSessions(principal, req.ip),
  });

  return r;
}
