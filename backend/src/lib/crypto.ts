/**
 * Field-level envelope encryption (FR-PRV-02, FR-SEC-10, ADR-005).
 *
 *   master key (environment, outside the database)  ->  wraps a data key per tenant (table tenant_keys)
 *   tenant data key                                  ->  AES-256-GCM encrypts individual fields
 *
 * A database dump or backup therefore shows only ciphertext. Rotating the master key re-wraps the small
 * tenant keys; it never re-encrypts the data.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getEnv } from '../config/env.js';

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');
const kidOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

// Development and test only. Production refuses to boot without a real MASTER_KEY (config/env.ts).
const DEV_MASTER = createHash('sha256').update('erpatio-development-master-key').digest();

export function masterKeys(): { kid: string; key: Buffer }[] {
  const env = getEnv();
  const raw = [env.MASTER_KEY, env.MASTER_KEY_PREVIOUS].filter((k): k is string => !!k);
  const keys = raw.length ? raw.map((k) => Buffer.from(k, 'base64')) : [DEV_MASTER];
  for (const k of keys) if (k.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64 encoded');
  return keys.map((key) => ({ kid: kidOf(key), key }));
}

const currentMaster = () => masterKeys()[0]!;

function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad?: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function wrapKey(dataKey: Buffer): { wrapped: string; kid: string } {
  const m = currentMaster();
  const { iv, tag, ct } = seal(m.key, dataKey);
  return { wrapped: [m.kid, b64u(iv), b64u(tag), b64u(ct)].join('.'), kid: m.kid };
}

export function unwrapKey(wrapped: string): Buffer {
  const [kid, iv, tag, ct] = wrapped.split('.');
  const master = masterKeys().find((m) => m.kid === kid);
  if (!master || !iv || !tag || !ct) throw new Error('Cannot unwrap the tenant key: unknown master key');
  return open(master.key, fromB64u(iv), fromB64u(tag), fromB64u(ct));
}

/** The caller's transaction must already be scoped to `tenantId` (withTenant). */
export async function getTenantKey(c: PoolClient, tenantId: string, version?: number): Promise<{ version: number; key: Buffer }> {
  const found = await c.query<{ version: number; wrapped_key: string }>(
    version === undefined
      ? 'SELECT version, wrapped_key FROM tenant_keys WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1'
      : 'SELECT version, wrapped_key FROM tenant_keys WHERE tenant_id = $1 AND version = $2',
    version === undefined ? [tenantId] : [tenantId, version],
  );
  const row = found.rows[0];
  if (row) return { version: row.version, key: unwrapKey(row.wrapped_key) };
  if (version !== undefined) throw new Error(`Tenant key version ${version} does not exist`);
  const dataKey = randomBytes(32);
  const { wrapped, kid } = wrapKey(dataKey);
  // Two requests may create the first key at the same moment: the loser must use the winner's key.
  const won = await c.query(
    'INSERT INTO tenant_keys (tenant_id, version, wrapped_key, master_kid) VALUES ($1, 1, $2, $3) ON CONFLICT (tenant_id, version) DO NOTHING RETURNING version',
    [tenantId, wrapped, kid],
  );
  if (won.rowCount) return { version: 1, key: dataKey };
  const stored = (await c.query<{ version: number; wrapped_key: string }>('SELECT version, wrapped_key FROM tenant_keys WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [tenantId])).rows[0]!;
  return { version: stored.version, key: unwrapKey(stored.wrapped_key) };
}

export async function encryptField(c: PoolClient, tenantId: string, plaintext: string): Promise<string> {
  const { version, key } = await getTenantKey(c, tenantId);
  const { iv, tag, ct } = seal(key, Buffer.from(plaintext, 'utf8'), Buffer.from(tenantId));
  return ['enc1', String(version), b64u(iv), b64u(tag), b64u(ct)].join('.');
}

export async function decryptField(c: PoolClient, tenantId: string, token: string): Promise<string> {
  const [tag0, ver, iv, tag, ct] = token.split('.');
  if (tag0 !== 'enc1' || !ver || !iv || !tag || !ct) throw new Error('Not an encrypted field');
  const { key } = await getTenantKey(c, tenantId, Number(ver));
  return open(key, fromB64u(iv), fromB64u(tag), fromB64u(ct), Buffer.from(tenantId)).toString('utf8');
}

/** Searchable fingerprint for an encrypted value (a blind index). Deterministic per tenant, not reversible. */
export function blindIndex(tenantId: string, value: string): string {
  const k = createHmac('sha256', currentMaster().key).update(`blind-index:${tenantId}`).digest();
  return createHmac('sha256', k).update(value.trim().toLowerCase()).digest('hex');
}

export const isEncrypted = (v: string | null | undefined): boolean => !!v && v.startsWith('enc1.');

/** Re-wrap every tenant key with the current master key (key rotation, FR-SEC-10). Returns how many were rewrapped. */
export async function rewrapTenantKeys(c: PoolClient): Promise<number> {
  const rows = (await c.query<{ tenant_id: string; version: number; wrapped_key: string; master_kid: string }>('SELECT tenant_id, version, wrapped_key, master_kid FROM tenant_keys')).rows;
  let n = 0;
  for (const r of rows) {
    if (r.master_kid === currentMaster().kid) continue;
    const { wrapped, kid } = wrapKey(unwrapKey(r.wrapped_key));
    await c.query('UPDATE tenant_keys SET wrapped_key = $3, master_kid = $4 WHERE tenant_id = $1 AND version = $2', [r.tenant_id, r.version, wrapped, kid]);
    n++;
  }
  return n;
}
