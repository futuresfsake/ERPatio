import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DB } from './config.js';
import { owner, shutdown } from './helpers.js';

const run = (script: string) =>
  execSync(`npm run ${script} --silent`, { stdio: 'pipe', env: { ...process.env, DATABASE_URL_DIRECT: TEST_DB } });
const tables = async () =>
  (await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'pgmigrations'")).rows.map((r) => r.table_name as string);

afterAll(shutdown);

describe('migrations (DoD: Alembic-style reversible migration)', () => {
  it('roll back completely and re-apply', async () => {
    const before = (await tables()).sort();
    expect(before).toContain('journal_entries');
    run('migrate:down -- 11');
    expect(await tables()).toEqual([]);
    run('migrate');
    expect((await tables()).sort()).toEqual(before);
  });

  it('is idempotent when nothing is pending', () => {
    expect(() => run('migrate')).not.toThrow();
  });
});

describe('data classification register (FR-PRV-01)', async () => {
  const { CLASSIFICATION } = await import('../src/db/classification.js');

  it('every column of every table is classified, and nothing stale is listed', async () => {
    const { rows } = await owner.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'pgmigrations'",
    );
    const actual = rows.map((r) => `${r.table_name}.${r.column_name}`).sort();
    expect(Object.keys(CLASSIFICATION).sort()).toEqual(actual);
  });

  it('personal data columns are tagged', () => {
    expect(CLASSIFICATION['users.email']).toBe('personal');
    expect(CLASSIFICATION['users.password_hash']).toBe('confidential');
  });
});
