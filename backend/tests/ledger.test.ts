import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/pool.js';
import { accountIds, auth, entry, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let tok: string;
let acc: Record<string, string>;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('ledger-co', { amy: ['Accountant'], vic: ['Viewer'], ada: ['TenantAdmin'] });
  tok = await tokenFor(api, t, 'amy');
  acc = await accountIds(t.tenantId);
});
afterAll(shutdown);

const post = (body: unknown, token = tok) => api.post('/api/v1/journal-entries').set(auth(token)).send(body as object);

describe('posting rules (ADR-003)', () => {
  it('posts a balanced entry with gapless numbering', async () => {
    const r1 = await post(entry(acc));
    const r2 = await post(entry(acc, '50.5'));
    expect(r1.status).toBe(201);
    expect([r1.body.entry_no, r2.body.entry_no]).toEqual([1, 2]);
    expect(r1.body.total).toBe('100.0000');
    expect(r1.body.lines).toHaveLength(2);
  });

  it('rejects an unbalanced entry', async () => {
    const bad = entry(acc);
    bad.lines[1]!.credit = '99.99';
    const r = await post(bad);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('unbalanced_entry');
    expect((await owner.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n).toBe(0);
  });

  it('is exact with decimals: 0.1 + 0.2 balances against 0.3', async () => {
    const r = await post({
      entry_date: '2026-11-01', description: 'decimal',
      lines: [
        { account_id: acc['1010'], debit: '0.1', credit: '0' },
        { account_id: acc['1000'], debit: '0.2', credit: '0' },
        { account_id: acc['4000'], debit: '0', credit: '0.3' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe('0.3000');
  });

  it.each([
    ['negative amount', { debit: '-5', credit: '0' }],
    ['five decimal places', { debit: '1.00001', credit: '0' }],
    ['exponent notation', { debit: '1e3', credit: '0' }],
    ['not a number', { debit: 'abc', credit: '0' }],
  ])('rejects %s', async (_n, line) => {
    const e = entry(acc);
    Object.assign(e.lines[0]!, line);
    expect((await post(e)).status).toBe(422);
  });

  it('rejects a line with both or neither side, a single line, and inactive accounts', async () => {
    const both = entry(acc);
    both.lines[0]!.credit = '100.00';
    expect((await post(both)).body.error.code).toBe('invalid_line');
    expect((await post({ ...entry(acc), lines: [entry(acc).lines[0]] })).status).toBe(422);
    await owner.query("UPDATE accounts SET is_active = false WHERE id = $1", [acc['4000']]);
    expect((await post(entry(acc))).body.error.code).toBe('invalid_account');
  });

  it('numbers 20 concurrent postings without gaps or duplicates', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(entry(acc, String(10 + i)))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nos = results.map((r) => r.body.entry_no as number).sort((x, y) => x - y);
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('database enforces the ledger rules on its own (defence in depth)', () => {
  const raw = async (fn: (c: import('pg').PoolClient) => Promise<void>) => withTenant(t.tenantId, fn);

  it('refuses an unbalanced entry written directly with SQL, at COMMIT', async () => {
    await expect(raw(async (c) => {
      const id = '00000000-0000-4000-8000-000000000001';
      await c.query("INSERT INTO journal_entries (id, tenant_id, entry_no, entry_date, description, created_by) VALUES ($1,$2,99,'2026-11-01','x',$3)", [id, t.tenantId, t.users.amy!.id]);
      await c.query('INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, debit, credit) VALUES ($1,$2,1,$3,10,0),($1,$2,2,$4,0,9)', [t.tenantId, id, acc['1010'], acc['4000']]);
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an entry with no lines', async () => {
    await expect(raw(async (c) => {
      await c.query("INSERT INTO journal_entries (tenant_id, entry_no, entry_date, description, created_by) VALUES ($1,98,'2026-11-01','x',$2)", [t.tenantId, t.users.amy!.id]);
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a line with both debit and credit', async () => {
    await expect(raw(async (c) => {
      await c.query("INSERT INTO journal_entries (id, tenant_id, entry_no, entry_date, description, created_by) VALUES ('00000000-0000-4000-8000-000000000002',$1,97,'2026-11-01','x',$2)", [t.tenantId, t.users.amy!.id]);
      await c.query("INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, debit, credit) VALUES ($1,'00000000-0000-4000-8000-000000000002',1,$2,5,5)", [t.tenantId, acc['1010']]);
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('posted entries cannot be updated or deleted by the app role or even the table owner', async () => {
    const posted = await post(entry(acc));
    const id = posted.body.id as string;
    await expect(raw(async (c) => { await c.query("UPDATE journal_entries SET description = 'edited' WHERE id = $1", [id]); })).rejects.toMatchObject({ code: '42501' });
    await expect(raw(async (c) => { await c.query('DELETE FROM journal_lines WHERE entry_id = $1', [id]); })).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query("UPDATE journal_entries SET description = 'edited' WHERE id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM journal_lines WHERE entry_id = $1', [id])).rejects.toThrow(/append-only/);
  });

  it('the audit log is append-only too', async () => {
    await post(entry(acc));
    await expect(owner.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('reversal, reporting and audit', () => {
  it('reverses an entry exactly once and the trial balance returns to zero', async () => {
    const posted = await post(entry(acc, '250.00'));
    const rev = await api.post(`/api/v1/journal-entries/${posted.body.id}/reverse`).set(auth(tok)).send({});
    expect(rev.status).toBe(201);
    expect(rev.body.reverses_entry_id).toBe(posted.body.id);
    expect(rev.body.lines.map((l: { debit: string }) => l.debit)).toEqual(['0.0000', '250.0000']);

    const again = await api.post(`/api/v1/journal-entries/${posted.body.id}/reverse`).set(auth(tok)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_reversed');
    const ofReversal = await api.post(`/api/v1/journal-entries/${rev.body.id}/reverse`).set(auth(tok)).send({});
    expect(ofReversal.body.error.code).toBe('not_reversible');

    const tb = await api.get('/api/v1/reports/trial-balance').query({ as_of: '2099-01-01' }).set(auth(tok));
    expect(tb.body.rows.every((r: { debit: string; credit: string }) => r.debit === '0.0000' && r.credit === '0.0000')).toBe(true);
    const original = await api.get(`/api/v1/journal-entries/${posted.body.id}`).set(auth(tok));
    expect(original.body.reversed_by_entry_id).toBe(rev.body.id);
  });

  it('concurrent reversals of one entry produce exactly one reversal', async () => {
    const posted = await post(entry(acc));
    const rs = await Promise.all(Array.from({ length: 5 }, () => api.post(`/api/v1/journal-entries/${posted.body.id}/reverse`).set(auth(tok)).send({})));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('trial balance ties and honours the as-of date', async () => {
    await post(entry(acc, '100.00', '2026-01-10'));
    await post({ entry_date: '2026-03-01', description: 'expense', lines: [
      { account_id: acc['6000'], debit: '40.25', credit: '0' }, { account_id: acc['1010'], debit: '0', credit: '40.25' }] });
    const full = (await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(tok))).body;
    const early = (await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-02-01' }).set(auth(tok))).body;
    expect(full.balanced).toBe(true);
    expect(full.total_debit).toBe('100.0000');
    expect(early.rows).toHaveLength(2);
    expect(early.total_debit).toBe(early.total_credit);
    expect(full.rows.find((r: { code: string }) => r.code === '1010').debit).toBe('59.7500');
  });

  it('writes an audit record for every state change, without personal data', async () => {
    await post(entry(acc));
    await api.post('/api/v1/accounts').set(auth(tok)).send({ code: '7000', name: 'Misc', type: 'expense' });
    const rows = (await owner.query('SELECT action, detail FROM audit_log WHERE tenant_id = $1 ORDER BY id', [t.tenantId])).rows;
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.login', 'journal.posted', 'account.created']));
    expect(JSON.stringify(rows)).not.toMatch(/@/);
  });

  it('rejects duplicate account codes with 409', async () => {
    const r = await api.post('/api/v1/accounts').set(auth(tok)).send({ code: '1000', name: 'dup', type: 'asset' });
    expect(r.status).toBe(409);
  });
});

describe('role-based access (FR-IAM-06)', () => {
  it('a Viewer can read but not post, reverse or edit', async () => {
    const v = await tokenFor(api, t, 'vic');
    expect((await api.get('/api/v1/accounts').set(auth(v))).status).toBe(200);
    expect((await api.get('/api/v1/reports/trial-balance').set(auth(v))).status).toBe(200);
    expect((await post(entry(acc), v)).status).toBe(403);
    expect((await api.post('/api/v1/accounts').set(auth(v)).send({ code: '9', name: 'x', type: 'asset' })).status).toBe(403);
    expect((await api.get('/api/v1/audit-log').set(auth(v))).status).toBe(403);
  });

  it('only roles with audit:read can see the audit log', async () => {
    const admin = await tokenFor(api, t, 'ada');
    expect((await api.get('/api/v1/audit-log').set(auth(admin))).status).toBe(200);
  });
});
