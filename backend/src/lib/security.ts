/**
 * Password hashing and tokens (ADR-004, FR-IAM-02, FR-AUT-01).
 * Passwords: argon2id. Access token: short-lived HS256 JWT with a rotating key (`kid`).
 * Refresh token: opaque `<tenant_id>.<random>`; only its SHA-256 is stored.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify, decodeProtectedHeader } from 'jose';
import { getEnv } from '../config/env.js';

export const MIN_PASSWORD_LENGTH = 12;

export interface Principal {
  userId: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
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
  const token = await new SignJWT({ tid: p.tenantId, roles: p.roles, perms: p.permissions })
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
  return {
    userId: String(payload.sub),
    tenantId: String(payload['tid']),
    roles: (payload['roles'] as string[] | undefined) ?? [],
    permissions: (payload['perms'] as string[] | undefined) ?? [],
  };
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
