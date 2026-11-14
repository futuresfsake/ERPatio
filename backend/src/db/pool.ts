/**
 * Tenant-scoped transactions (ADR-002, US-019).
 *
 * Every unit of work is one transaction that first drops to `erpatio_app` (no BYPASSRLS) and sets
 * `app.tenant_id` with set_config(..., true), so the setting is transaction-local. That is compatible
 * with Neon's PgBouncer in transaction mode, which does not preserve session state.
 */
import pg from 'pg';
import { getEnv } from '../config/env.js';

pg.types.setTypeParser(1082, (v: string) => v); // DATE stays 'YYYY-MM-DD' (no timezone shifting)

let pool: pg.Pool | undefined;

export function normaliseUrl(url: string): string {
  const u = new URL(url.replace(/^postgres:\/\//, 'postgresql://'));
  u.searchParams.delete('channel_binding');
  return u.toString();
}

export function createPool(url: string, max = 10): pg.Pool {
  const p = new pg.Pool({
    connectionString: normaliseUrl(url),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: 'erpatio-api',
  });
  p.on('error', () => undefined); // idle-client errors must not crash the process
  return p;
}

export function getPool(): pg.Pool {
  const env = getEnv();
  return (pool ??= createPool(env.DATABASE_URL, env.DB_POOL_MAX));
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = undefined;
  await p?.end();
}

async function tx<T>(
  setup: (c: pg.PoolClient) => Promise<void>,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE erpatio_app');
    await setup(client);
    const result = await fn(client);
    await client.query('COMMIT'); // deferred constraint triggers (ledger balance) fire here
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const withTenant = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
  tx(async (c) => {
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  }, fn);

/** Pre-login: no tenant yet. Only SECURITY DEFINER functions are reachable. */
export const withSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
  tx(async () => undefined, fn);
