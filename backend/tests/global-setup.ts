import { execSync } from 'node:child_process';
import pg from 'pg';
import { TEST_DB } from './config.js';

/** Fresh schema, then the real migrations (the same command Render runs). */
export default async function setup(): Promise<void> {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE');
  await c.query('CREATE SCHEMA public');
  await c.end();
  execSync('npm run migrate --silent', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL_DIRECT: TEST_DB },
  });
}
