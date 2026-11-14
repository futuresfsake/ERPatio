import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/pool.js';
import { accountIds, auth, entry, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let amy: string; // Accountant
let fay: string; // FinanceManager
let vic: string; // Viewer

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('periods-co', { amy: ['Accountant'], fay: ['FinanceManager'], vic: ['Viewer'] });
  [amy, fay, vic] = await Promise.all([tokenFor(api, t, 'amy'), tokenFor(api, t, 'fay'), tokenFor(api, t, 'vic')]);
  acc = await accountIds(t.tenantId);
});
afterAll(shutdown);

const periods = async (tok = amy) => (await api.get('/api/v1/fiscal-periods').set(auth(tok))).body as { id: string; year: number; month: number; status: string; open_drafts: number }[];
const periodOf = async (year: number, month: number) => (await periods()).find((p) => p.year === year && p.month === month)!;
const post = (body: unknown, tok = amy) => api.post('/api/v1/journal-entries').set(auth(tok)).send(body as object);
const close = (id: string, tok = fay) => api.post(`/api/v1/fiscal-periods/${id}/close`).set(auth(tok)).send({});

describe('fiscal periods (FR-FIN-06)', () => {
  it('a new tenant has 36 open monthly periods and everyone with reports can see them', async () => {
    const all = await periods(vic);
    expect(all).toHaveLength(36);
    expect(all.every((p) => p.status === 'open')).toBe(true);
    expect(all[0]).toMatchObject({ year: 2025, month: 1 });
  });

  it('only a manager creates a fiscal year, once', async () => {
    expect((await api.post('/api/v1/fiscal-years').set(auth(amy)).send({ year: 2028 })).status).toBe(403);
    const ok = await api.post('/api/v1/fiscal-years').set(auth(fay)).send({ year: 2028 });
    expect(ok.status).toBe(201);
    expect((await periods()).filter((p) => p.year === 2028)).toHaveLength(12);
    const again = await api.post('/api/v1/fiscal-years').set(auth(fay)).send({ year: 2028 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('year_exists');
    expect((await api.post('/api/v1/fiscal-years').set(auth(fay)).send({ year: 1850 })).status).toBe(422);
  });

  it('periods follow the calendar, including February in a leap year', async () => {
    await api.post('/api/v1/fiscal-years').set(auth(fay)).send({ year: 2028 });
    const feb = (await owner.query("SELECT start_date::text, end_date::text FROM fiscal_periods WHERE year = 2028 AND month = 2")).rows[0];
    expect(feb).toEqual({ start_date: '2028-02-01', end_date: '2028-02-29' });
  });

  it('refuses a posting dated where no period exists', async () => {
    const r = await post(entry(acc, '10.00', '2030-01-15'));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('no_period');
  });
});

describe('closing and locking (FR-FIN-07)', () => {
  it('a closed period rejects postings; other periods stay open', async () => {
    const march = await periodOf(2026, 3);
    expect((await close(march.id)).status).toBe(200);
    const blocked = await post(entry(acc, '10.00', '2026-03-10'));
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('period_closed');
    expect((await post(entry(acc, '10.00', '2026-04-10'))).status).toBe(201);
    expect((await owner.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n).toBe(1);
  });

  it('the database itself refuses an entry in a closed period', async () => {
    const march = await periodOf(2026, 3);
    await close(march.id);
    await expect(
      withTenant(t.tenantId, (c) =>
        c.query("INSERT INTO journal_entries (tenant_id, entry_no, entry_date, description, created_by) VALUES ($1, 77, '2026-03-05', 'x', $2)", [t.tenantId, t.users.amy!.id])),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('is closed') });
  });

  it('a reversal is dated today, so it works even when the original period is closed', async () => {
    const posted = await post(entry(acc, '40.00', '2026-02-10'));
    await close((await periodOf(2026, 2)).id);
    const rev = await api.post(`/api/v1/journal-entries/${posted.body.id}/reverse`).set(auth(amy)).send({});
    expect(rev.status).toBe(201);
    expect(rev.body.entry_date >= '2026-11-01' || rev.body.entry_date.slice(0, 4) >= '2026').toBe(true);
    // and an explicit date inside the closed period is refused
    const inClosed = await post(entry(acc, '40.00', '2026-02-20'));
    expect(inClosed.body.error.code).toBe('period_closed');
  });

  it('unposted drafts block the close; deleting the draft unblocks it', async () => {
    const draft = await api.post('/api/v1/journal-drafts').set(auth(amy)).send({ entry_date: '2026-05-12', description: 'pending', lines: [] });
    const may = await periodOf(2026, 5);
    expect(may.open_drafts).toBe(1);
    const blocked = await close(may.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('unposted_drafts');
    expect(blocked.body.error.message).toMatch(/1 draft entry is dated/);
    await api.delete(`/api/v1/journal-drafts/${draft.body.id}`).set(auth(amy)).expect(204);
    expect((await close(may.id)).status).toBe(200);
  });

  it('close and reopen are guarded, one-way where they should be, and audited', async () => {
    const june = await periodOf(2026, 6);
    expect((await close(june.id, amy)).status).toBe(403);
    expect((await close(june.id, vic)).status).toBe(403);
    await close(june.id);
    expect((await close(june.id)).body.error.code).toBe('already_closed');

    const noReason = await api.post(`/api/v1/fiscal-periods/${june.id}/reopen`).set(auth(fay)).send({});
    expect(noReason.status).toBe(422);
    const reopened = await api.post(`/api/v1/fiscal-periods/${june.id}/reopen`).set(auth(fay)).send({ reason: 'Late supplier invoice' });
    expect(reopened.status).toBe(200);
    expect((await post(entry(acc, '10.00', '2026-06-10'))).status).toBe(201);
    expect((await api.post(`/api/v1/fiscal-periods/${june.id}/reopen`).set(auth(fay)).send({ reason: 'again please' })).body.error.code).toBe('already_open');

    const log = (await owner.query("SELECT action, detail FROM audit_log WHERE action LIKE 'period.%' ORDER BY id")).rows;
    expect(log.map((r) => r.action)).toEqual(['period.closed', 'period.reopened']);
    expect(log[1].detail).toMatchObject({ year: 2026, month: 6, reason: 'Late supplier invoice' });
  });

  it('tenant A cannot close tenant B\'s period', async () => {
    const other = await seedTenant('other-co', { ola: ['FinanceManager'] });
    const otherTok = await tokenFor(api, other, 'ola');
    const theirs = ((await api.get('/api/v1/fiscal-periods').set(auth(otherTok))).body as { id: string }[])[0]!;
    expect((await close(theirs.id, fay)).status).toBe(404);
    expect((await owner.query('SELECT status FROM fiscal_periods WHERE id = $1', [theirs.id])).rows[0].status).toBe('open');
  });
});
