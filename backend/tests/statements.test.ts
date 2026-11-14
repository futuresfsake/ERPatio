import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountIds, auth, newApi, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let amy: string;
let vic: string;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('stmt-co', { amy: ['Accountant'], vic: ['Viewer'] });
  [amy, vic] = await Promise.all([tokenFor(api, t, 'amy'), tokenFor(api, t, 'vic')]);
  acc = await accountIds(t.tenantId);
});
afterAll(shutdown);

const je = (date: string, desc: string, dr: string, cr: string, amount: string) =>
  api.post('/api/v1/journal-entries').set(auth(amy)).send({
    entry_date: date, description: desc,
    lines: [{ account_id: acc[dr], debit: amount, credit: '0' }, { account_id: acc[cr], debit: '0', credit: amount }],
  }).expect(201);

async function book() {
  await je('2026-01-05', 'Capital', '1010', '3000', '1000000.00');
  await je('2026-02-10', 'Sale on account', '1100', '4000', '300000.00');
  await je('2026-03-01', 'Rent', '6000', '1010', '45000.50');
  await je('2026-03-15', 'Supplier owed', '1200', '2000', '80000.00');
}
const income = (q: Record<string, string>, tok = amy) => api.get('/api/v1/reports/income-statement').query(q).set(auth(tok));
const sheet = (asOf: string, tok = amy) => api.get('/api/v1/reports/balance-sheet').query({ as_of: asOf }).set(auth(tok));

describe('income statement', () => {
  it('revenue minus expenses for the range, with exact decimals', async () => {
    await book();
    const r = (await income({ from: '2026-01-01', to: '2026-12-31' })).body;
    expect(r.revenue.rows).toEqual([{ account_id: acc['4000'], code: '4000', name: 'Sales Revenue', amount: '300000.0000' }]);
    expect(r.expenses.rows.map((x: { code: string; amount: string }) => [x.code, x.amount])).toEqual([['6000', '45000.5000']]);
    expect(r.revenue.total).toBe('300000.0000');
    expect(r.expenses.total).toBe('45000.5000');
    expect(r.net_income).toBe('254999.5000');
  });

  it('honours the date range', async () => {
    await book();
    const feb = (await income({ from: '2026-02-01', to: '2026-02-28' })).body;
    expect(feb.revenue.total).toBe('300000.0000');
    expect(feb.expenses.total).toBe('0.0000');
    const mar = (await income({ from: '2026-03-01', to: '2026-03-31' })).body;
    expect(mar.revenue.total).toBe('0.0000');
    expect(mar.net_income).toBe('-45000.5000');
  });

  it('defaults to the current year to date and rejects bad dates', async () => {
    const r = await api.get('/api/v1/reports/income-statement').set(auth(vic));
    expect(r.status).toBe(200);
    expect(r.body.from).toBe(`${new Date().getUTCFullYear()}-01-01`);
    expect((await income({ from: 'yesterday' })).status).toBe(422);
  });

  it('a reversal removes an entry\'s effect', async () => {
    const posted = await je('2026-04-01', 'Sale', '1010', '4000', '500.00');
    await api.post(`/api/v1/journal-entries/${posted.body.id}/reverse`).set(auth(amy)).send({ entry_date: '2026-04-02' }).expect(201);
    expect((await income({ from: '2026-04-01', to: '2026-04-30' })).body.net_income).toBe('0.0000');
  });
});

describe('balance sheet', () => {
  it('assets equal liabilities plus equity, with earnings to date', async () => {
    await book();
    const b = (await sheet('2026-12-31')).body;
    const total = (s: { rows: { code: string; amount: string }[] }) => s.rows.map((x) => [x.code, x.amount]);
    expect(total(b.assets)).toEqual([['1010', '954999.5000'], ['1100', '300000.0000'], ['1200', '80000.0000']]);
    expect(b.assets.total).toBe('1334999.5000');
    expect(total(b.liabilities)).toEqual([['2000', '80000.0000']]);
    expect(b.equity.earnings).toBe('254999.5000');
    expect(total(b.equity)).toEqual([['3000', '1000000.0000']]);
    expect(b.equity.total).toBe('1254999.5000');
    expect(b.balanced).toBe(true);
  });

  it('is as-of: later entries do not leak into an earlier date', async () => {
    await book();
    const jan = (await sheet('2026-01-31')).body;
    expect(jan.assets.total).toBe('1000000.0000');
    expect(jan.equity.earnings).toBe('0.0000');
    expect(jan.balanced).toBe(true);
    const feb = (await sheet('2026-02-28')).body;
    expect(feb.equity.earnings).toBe('300000.0000');
    expect(feb.balanced).toBe(true);
  });

  it('an empty workspace balances at zero and a viewer can read it', async () => {
    const b = (await sheet('2026-06-30', vic)).body;
    expect(b).toMatchObject({ balanced: true, assets: { total: '0.0000' }, liabilities: { total: '0.0000' } });
    expect(b.equity.earnings).toBe('0.0000');
  });

  it('only shows the caller\'s tenant', async () => {
    await book();
    const other = await seedTenant('stmt-other', { ola: ['Accountant'] });
    const tok = await tokenFor(api, other, 'ola');
    expect((await sheet('2026-12-31', tok)).body.assets.rows).toEqual([]);
  });
});
