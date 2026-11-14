import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountIds, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let amy: string;
let fin: string;
let cust: string;
let out12: string;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('ye-co', { amy: ['Accountant'], fin: ['FinanceManager'] });
  [amy, fin] = await Promise.all([tokenFor(api, t, 'amy'), tokenFor(api, t, 'fin')]);
  acc = await accountIds(t.tenantId);
  cust = (await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'c1', name: 'Cafe' }).expect(201)).body.id;
  out12 = ((await api.get('/api/v1/tax-codes').set(auth(amy))).body as { id: string; code: string }[]).find((c) => c.code === 'OUT12')!.id;
});
afterAll(shutdown);

const je = (date: string, dr: string, cr: string, amount: string) =>
  api.post('/api/v1/journal-entries').set(auth(amy)).send({ entry_date: date, description: 'x', lines: [{ account_id: acc[dr], debit: amount, credit: '0' }, { account_id: acc[cr], debit: '0', credit: amount }] }).expect(201);
const bs = async (asOf: string) => (await api.get('/api/v1/reports/balance-sheet').query({ as_of: asOf }).set(auth(amy)).expect(200)).body;
const is = async (from: string, to: string) => (await api.get('/api/v1/reports/income-statement').query({ from, to }).set(auth(amy)).expect(200)).body;

async function book() {
  await je('2026-01-05', '1010', '3000', '100000.00');
  await je('2026-03-01', '1100', '4000', '60000.00');
  await je('2026-04-01', '6000', '1010', '25000.00');
}

describe('year-end close', () => {
  it('previews, then moves profit into retained earnings with one flagged entry', async () => {
    await book();
    const pre = (await api.get('/api/v1/fiscal-years/2026/closing-preview').set(auth(fin)).expect(200)).body;
    expect(pre.net_income).toBe('35000.0000');
    expect(pre.accounts).toHaveLength(2);
    const r = (await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin)).expect(201)).body;
    expect(r.net_income).toBe('35000.0000');
    const e = (await api.get(`/api/v1/journal-entries/${r.journal_entry_id}`).set(auth(fin)).expect(200)).body;
    expect(e.entry_date).toBe('2026-12-31');
    expect(e.lines.find((l: { account_code: string }) => l.account_code === '3100').credit).toBe('35000.0000');
    // Revenue and expense are zero afterwards; retained earnings holds the profit; the sheet still balances.
    const sheet = await bs('2027-01-31');
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.earnings).toBe('0.0000');
    expect(sheet.equity.rows.find((x: { code: string }) => x.code === '3100').amount).toBe('35000.0000');
  });

  it('the income statement for the closed year still shows the year, not zero', async () => {
    await book();
    await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin)).expect(201);
    const r = await is('2026-01-01', '2026-12-31');
    expect(r.revenue.total).toBe('60000.0000');
    expect(r.net_income).toBe('35000.0000');
  });

  it('a loss debits retained earnings', async () => {
    await je('2026-02-01', '6000', '1010', '9000.00');
    const r = (await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin)).expect(201)).body;
    expect(r.net_income).toBe('-9000.0000');
    const e = (await api.get(`/api/v1/journal-entries/${r.journal_entry_id}`).set(auth(fin))).body;
    expect(e.lines.find((l: { account_code: string }) => l.account_code === '3100').debit).toBe('9000.0000');
  });

  it('refuses a second close, an empty year, an unknown year and open drafts', async () => {
    expect((await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin))).status).toBe(422);
    await book();
    await api.post('/api/v1/journal-drafts').set(auth(amy)).send({ entry_date: '2026-06-01', description: 'd', lines: [{ account_id: acc['1010'], debit: '1', credit: '0' }, { account_id: acc['3000'], debit: '0', credit: '1' }] }).expect(201);
    expect((await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin))).status).toBe(409);
    await owner.query('DELETE FROM journal_drafts WHERE tenant_id = $1', [t.tenantId]);
    await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin)).expect(201);
    expect((await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin))).status).toBe(409);
    expect((await api.post('/api/v1/fiscal-years/2031/close').set(auth(fin))).status).toBe(404);
  });

  it('only someone who manages periods can close a year, and the entry cannot be reversed by hand', async () => {
    await book();
    expect((await api.post('/api/v1/fiscal-years/2026/close').set(auth(amy))).status).toBe(403);
    expect((await api.get('/api/v1/fiscal-years/2026/closing-preview').set(auth(amy))).status).toBe(403);
    const r = (await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin)).expect(201)).body;
    const rev = await api.post(`/api/v1/journal-entries/${r.journal_entry_id}/reverse`).set(auth(fin)).send({});
    expect(rev.status).toBe(409);
    expect(rev.body.error.code).toBe('subledger_entry');
  });

  it('two simultaneous closes produce one entry', async () => {
    await book();
    const res = await Promise.all([1, 2].map(() => api.post('/api/v1/fiscal-years/2026/close').set(auth(fin))));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await owner.query('SELECT count(*)::int AS n FROM journal_entries WHERE closing_year = 2026')).rows[0].n).toBe(1);
  });

  it('a closed period still blocks the closing date', async () => {
    await book();
    const periods = (await api.get('/api/v1/fiscal-periods').set(auth(fin))).body as { id: string; year: number; month: number }[];
    await api.post(`/api/v1/fiscal-periods/${periods.find((p) => p.year === 2026 && p.month === 12)!.id}/close`).set(auth(fin)).send({}).expect(200);
    expect((await api.post('/api/v1/fiscal-years/2026/close').set(auth(fin))).status).toBeGreaterThanOrEqual(400);
  });
});

describe('payment void', () => {
  const inv = () => api.post('/api/v1/invoices').set(auth(amy)).send({ party_id: cust, doc_date: '2026-11-01', lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: '1000.00', tax_code_id: out12 }] }).expect(201);
  async function paid() {
    const d = (await inv()).body;
    const p = (await api.post(`/api/v1/invoices/${d.id}/post`).set(auth(amy)).expect(200)).body;
    const pay = (await api.post('/api/v1/receipts').set(auth(amy)).send({ party_id: cust, pay_date: '2026-11-10', bank_account_id: acc['1010'], allocations: [{ document_id: p.id, amount: '500.00' }] }).expect(201)).body;
    return { p, pay };
  }

  it('restores the balance, reverses the ledger and lets the invoice be voided', async () => {
    const { p, pay } = await paid();
    const v = (await api.post(`/api/v1/receipts/${pay.id}/void`).set(auth(amy)).send({ void_date: '2026-11-12' }).expect(200)).body;
    expect(v.voided).toBe(true);
    const after = (await api.get(`/api/v1/invoices/${p.id}`).set(auth(amy))).body;
    expect(after.paid_total).toBe('0.0000');
    expect(after.payments[0].voided).toBe(true);
    const tb = (await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(amy))).body;
    expect(tb.rows.find((r: { code: string }) => r.code === '1010')).toMatchObject({ debit: '0.0000', credit: '0.0000' });
    await api.post(`/api/v1/invoices/${p.id}/void`).set(auth(amy)).send({}).expect(200);
  });

  it('can only be voided once, not before it was paid, and not by hand in the journal', async () => {
    const { pay } = await paid();
    expect((await api.post(`/api/v1/receipts/${pay.id}/void`).set(auth(amy)).send({ void_date: '2026-11-01' })).status).toBe(422);
    await api.post(`/api/v1/receipts/${pay.id}/void`).set(auth(amy)).send({}).expect(200);
    expect((await api.post(`/api/v1/receipts/${pay.id}/void`).set(auth(amy)).send({})).status).toBe(409);
    expect((await api.post(`/api/v1/journal-entries/${pay.journal_entry_id}/reverse`).set(auth(amy)).send({})).status).toBe(409);
    expect((await api.post(`/api/v1/vendor-payments/${pay.id}/void`).set(auth(amy)).send({})).status).toBe(404); // wrong side
  });

  it('aging counts the payment until the day it was voided, then the balance is open again', async () => {
    const { pay } = await paid();
    await api.post(`/api/v1/receipts/${pay.id}/void`).set(auth(amy)).send({ void_date: '2026-11-20' }).expect(200);
    const during = (await api.get('/api/v1/reports/aging/receivables').query({ as_of: '2026-11-15' }).set(auth(amy))).body;
    const after = (await api.get('/api/v1/reports/aging/receivables').query({ as_of: '2026-11-25' }).set(auth(amy))).body;
    expect(during.totals.total).toBe('620.0000');
    expect(after.totals.total).toBe('1120.0000');
    expect(after.reconciles).toBe(true);
  });

  it('two simultaneous voids give one reversal', async () => {
    const { pay } = await paid();
    const res = await Promise.all([1, 2].map(() => api.post(`/api/v1/receipts/${pay.id}/void`).set(auth(amy)).send({})));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await owner.query('SELECT count(*)::int AS n FROM payment_voids')).rows[0].n).toBe(1);
  });

  it('a voided payment row is never editable or deletable', async () => {
    const { pay } = await paid();
    await api.post(`/api/v1/receipts/${pay.id}/void`).set(auth(amy)).send({}).expect(200);
    await expect(owner.query('DELETE FROM payment_voids')).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM payments')).rejects.toThrow(/append-only/);
  });
});
