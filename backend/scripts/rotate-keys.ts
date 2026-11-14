/**
 * Master-key rotation (FR-SEC-10). Set MASTER_KEY to the new key and MASTER_KEY_PREVIOUS to the old one,
 * run this, then remove MASTER_KEY_PREVIOUS. Only the small per-tenant keys are re-wrapped; data is not re-encrypted.
 */
import 'dotenv/config';
import { getEnv } from '../src/config/env.js';
import { rewrapTenantKeys } from '../src/lib/crypto.js';
import { createPool } from '../src/db/pool.js';

const env = getEnv();
const pool = createPool(env.DATABASE_URL_DIRECT ?? env.DATABASE_URL, 1);
const c = await pool.connect();
try {
  await c.query('BEGIN');
  const n = await rewrapTenantKeys(c);
  await c.query('COMMIT');
  console.log(`re-wrapped ${n} tenant key(s)`);
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  c.release();
  await pool.end();
}
