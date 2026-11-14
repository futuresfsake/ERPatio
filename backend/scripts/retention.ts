/**
 * Retention run (FR-PRV-07). Dry run by default: prints what would be removed.
 *   npm run retention            # report only
 *   npm run retention -- --apply # delete
 */
import 'dotenv/config';
import { getEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { runRetention } from '../src/modules/privacy/retention.js';

const env = getEnv();
const pool = createPool(env.DATABASE_URL_DIRECT ?? env.DATABASE_URL, 1);
const c = await pool.connect();
try {
  const report = await runRetention(c, process.argv.includes('--apply'));
  console.log(JSON.stringify(report));
} finally {
  c.release();
  await pool.end();
}
