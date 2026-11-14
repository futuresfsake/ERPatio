/**
 * Password hashing and tokens (ADR-004, FR-IAM-02, FR-AUT-01).
 * Passwords: argon2id. Access token: short-lived HS256 JWT with a rotating key (`kid`).
 * Refresh token: opaque `<tenant_id>.<random>`; only its SHA-256 is stored.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify, decodeProtectedHeader } from 'jose';
import { getEnv } from '../config/env.js';
import { API_KEY_PREFIX, authenticateApiKey } from '../modules/apikeys/service.js';

export const MIN_PASSWORD_LENGTH = 12;

export interface Principal {
  userId: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  /** Set when a role in this workspace must use 2FA and this user has not enrolled yet. */
  mfaEnrollRequired?: boolean;
  /** Modules the workspace has subscribed to. */
  modules?: string[];
  /** Set on a support session: the platform operator who is acting, read-only. */
  impersonator?: string;
  /** The refresh-token family this access token belongs to (for the sessions list). */
  sessionId?: string;
  /** Set when the caller is an API key rather than a signed-in person. */
  apiKeyId?: string;
}

let dummyHash: Promise<string> | undefined;

export const hashPassword = (pw: string): Promise<string> => argon2.hash(pw, { type: argon2.argon2id });

/** Verifies against a dummy hash when the account does not exist so timing is equalised (FR-AUT-06). */
export async function verifyPassword(pw: string, hash: string | null): Promise<boolean> {
  dummyHash ??= hashPassword('not-a-real-password-for-timing-equalisation');
  try {
    const ok = await argon2.verify(hash ?? (await dummyHash), pw);
    return ok && hash !== null;
  } catch {
    return false;
  }
}

export function passwordPolicyError(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > 256) return 'Password is too long.';
  return null;
}

const kidOf = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 8);
const keyOf = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(p: Principal): Promise<{ token: string; expiresIn: number }> {
  const env = getEnv();
  const token = await new SignJWT({ tid: p.tenantId, roles: p.roles, perms: p.permissions, ...(p.mfaEnrollRequired ? { mfa_enroll: true } : {}), ...(p.modules ? { mods: p.modules } : {}), ...(p.impersonator ? { imp: p.impersonator } : {}), ...(p.sessionId ? { sid: p.sessionId } : {}) })
    .setProtectedHeader({ alg: 'HS256', kid: kidOf(env.JWT_SECRET) })
    .setSubject(p.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_MINUTES}m`)
    .setJti(randomBytes(8).toString('hex'))
    .sign(keyOf(env.JWT_SECRET));
  return { token, expiresIn: env.ACCESS_MINUTES * 60 };
}

/** Throws on any problem. Only HS256 is accepted; the key is chosen by `kid` among known keys. */
export async function verifyAccessToken(token: string): Promise<Principal> {
  if (token.startsWith(API_KEY_PREFIX)) return authenticateApiKey(token);
  const env = getEnv();
  const secrets = [env.JWT_SECRET, ...(env.JWT_SECRET_PREVIOUS ? [env.JWT_SECRET_PREVIOUS] : [])];
  const kid = decodeProtectedHeader(token).kid;
  const secret = secrets.find((s) => kidOf(s) === kid);
  if (!secret) throw new Error('unknown key id');
  const { payload } = await jwtVerify(token, keyOf(secret), {
    algorithms: ['HS256'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    requiredClaims: ['sub', 'tid', 'exp'],
  });
  if (payload['purpose']) throw new Error('not an access token'); // a 2FA step token must never act as one
  return {
    userId: String(payload.sub),
    tenantId: String(payload['tid']),
    roles: (payload['roles'] as string[] | undefined) ?? [],
    permissions: (payload['perms'] as string[] | undefined) ?? [],
    mfaEnrollRequired: payload['mfa_enroll'] === true,
    modules: Array.isArray(payload['mods']) ? (payload['mods'] as string[]) : undefined,
    impersonator: typeof payload['imp'] === 'string' ? payload['imp'] : undefined,
    sessionId: typeof payload['sid'] === 'string' ? payload['sid'] : undefined,
  };
}

/** Short-lived token that proves the password step passed and a 2FA code is now needed. */
export async function signMfaToken(userId: string, tenantId: string): Promise<string> {
  const env = getEnv();
  return new SignJWT({ tid: tenantId, purpose: 'mfa' })
    .setProtectedHeader({ alg: 'HS256', kid: kidOf(env.JWT_SECRET) })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keyOf(env.JWT_SECRET));
}

export async function verifyMfaToken(token: string): Promise<{ userId: string; tenantId: string }> {
  const env = getEnv();
  const secrets = [env.JWT_SECRET, ...(env.JWT_SECRET_PREVIOUS ? [env.JWT_SECRET_PREVIOUS] : [])];
  const secret = secrets.find((s) => kidOf(s) === decodeProtectedHeader(token).kid);
  if (!secret) throw new Error('unknown key id');
  const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ['HS256'], issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE });
  if (payload['purpose'] !== 'mfa') throw new Error('not an mfa token');
  return { userId: String(payload.sub), tenantId: String(payload['tid']) };
}

export const hashRefreshToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

export function newRefreshToken(tenantId: string): { raw: string; hash: string } {
  const raw = `${tenantId}.${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashRefreshToken(raw) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function tenantOfRefreshToken(raw: string): string | null {
  const head = raw.split('.', 1)[0] ?? '';
  return UUID_RE.test(head) ? head.toLowerCase() : null;
}
