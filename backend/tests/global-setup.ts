import { execSync } from 'node:child_process';
import pg from 'pg';
import { TEST_DB } from './config.js';

/** Fresh schema, then the real migrations (the same command Render runs). */
export default async function setup(): Promise<void> {
  // This set-up drops the public schema. Refuse to run it against anything that is not clearly a disposable local database.
  const target = new URL(TEST_DB);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname) || !/test/i.test(target.pathname))
    throw new Error(`Refusing to run the tests: ${target.hostname}${target.pathname} does not look like a disposable local test database.`);
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
