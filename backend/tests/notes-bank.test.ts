import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountIds, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let amy: string;
let vic: string;
let cust: string;
let supp: string;
let out12: string;
let in12: string;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('nb-co', { amy: ['Accountant'], vic: ['Viewer'] });
  [amy, vic] = await Promise.all([tokenFor(api, t, 'amy'), tokenFor(api, t, 'vic')]);
  acc = await accountIds(t.tenantId);
  cust = (await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'c1', name: 'Cafe' }).expect(201)).body.id;
  supp = (await api.post('/api/v1/suppliers').set(auth(amy)).send({ code: 's1', name: 'Mills' }).expect(201)).body.id;
  const codes = (await api.get('/api/v1/tax-codes').set(auth(amy))).body as { id: string; code: string }[];
  out12 = codes.find((c) => c.code === 'OUT12')!.id;
  in12 = codes.find((c) => c.code === 'IN12')!.id;
});
afterAll(shutdown);

const line = (account: string, price: string, tax: string | null) => ({ description: 'x', account_id: acc[account], quantity: '1', unit_price: price, tax_code_id: tax });
async function postDoc(path: string, body: object) {
  const d = (await api.post(`/api/v1/${path}`).set(auth(amy)).send(body).expect(201)).body;
  return (await api.post(`/api/v1/${path}/${d.id}/post`).set(auth(amy)).expect(200)).body;
}
const inv = (price = '1000.00') => postDoc('invoices', { party_id: cust, doc_date: '2026-11-01', lines: [line('4000', price, out12)] });
const bal = async (code: string) => {
  const r = ((await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(amy))).body.rows as { code: string; debit: string; credit: string }[]).find((x) => x.code === code);
  return r ? `${r.debit}/${r.credit}` : 'none';
};
const aging = async (side: string, asOf = '2026-12-31') => (await api.get(`/api/v1/reports/aging/${side}`).query({ as_of: asOf }).set(auth(amy)).expect(200)).body;

describe('credit notes', () => {
  it('posts the mirror image of an invoice and numbers separately', async () => {
    await inv();
    const cn = await postDoc('credit-notes', { party_id: cust, doc_date: '2026-11-05', lines: [line('4000', '200.00', out12)] });
    expect(cn.doc_no).toBe('1');
    expect(cn.total).toBe('224.0000');
    const je = (await api.get(`/api/v1/journal-entries/${cn.journal_entry_id}`).set(auth(amy)).expect(200)).body;
    const by = (code: string) => je.lines.find((l: { account_code: string }) => l.account_code === code);
    expect(by('4000').debit).toBe('200.0000');
    expect(by('2100').debit).toBe('24.0000');
    expect(by('1100').credit).toBe('224.0000');
    expect(await bal('1100')).toBe('896.0000/0.0000');
  });

  it('applies against an invoice, lowering what is owed on both, and the ledger still agrees', async () => {
    const i = await inv(); // 1120
    const cn = await postDoc('credit-notes', { party_id: cust, doc_date: '2026-11-05', lines: [line('4000', '200.00', out12)] }); // 224
    // before applying, the open credit shows as a negative item
    let a = await aging('receivables');
    expect(a.totals.total).toBe('896.0000');
    expect(a.reconciles).toBe(true);
    const r = (await api.post(`/api/v1/credit-notes/${cn.id}/apply`).set(auth(amy)).send({ date: '2026-11-06', allocations: [{ document_id: i.id, amount: '224.00' }] }).expect(200)).body;
    expect(r.balance).toBe('0.0000');
    expect((await api.get(`/api/v1/invoices/${i.id}`).set(auth(amy))).body.balance).toBe('896.0000');
    expect((await api.get(`/api/v1/invoices/${i.id}`).set(auth(amy))).body.applications).toHaveLength(1);
    a = await aging('receivables');
    expect(a.totals.total).toBe('896.0000');
    expect(a.reconciles).toBe(true);
    // a date before the application still sees the unapplied credit
    expect((await aging('receivables', '2026-11-05')).totals.total).toBe('896.0000');
  });

  it('refuses over-application, another customer, a draft note, an applied-note void, and a paid-up invoice', async () => {
    const i = await inv();
    const other = (await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'c2', name: 'Other' }).expect(201)).body.id;
    const draft = (await api.post('/api/v1/credit-notes').set(auth(amy)).send({ party_id: cust, doc_date: '2026-11-05', lines: [line('4000', '100.00', null)] }).expect(201)).body;
    const apply = (id: string, doc: string, amount: string) => api.post(`/api/v1/credit-notes/${id}/apply`).set(auth(amy)).send({ date: '2026-11-06', allocations: [{ document_id: doc, amount }] });
    expect((await apply(draft.id, i.id, '10.00')).status).toBe(409);
    await api.post(`/api/v1/credit-notes/${draft.id}/post`).set(auth(amy)).expect(200);
    expect((await apply(draft.id, i.id, '100.01')).status).toBe(422);
    const j = await postDoc('invoices', { party_id: other, doc_date: '2026-11-01', lines: [line('4000', '50.00', null)] });
    expect((await apply(draft.id, j.id, '10.00')).status).toBe(422);
    await apply(draft.id, i.id, '60.00').expect(200);
    expect((await apply(draft.id, i.id, '40.01')).status).toBe(422);
    expect((await api.post(`/api/v1/credit-notes/${draft.id}/void`).set(auth(amy)).send({})).status).toBe(409);
    expect((await api.post(`/api/v1/invoices/${i.id}/void`).set(auth(amy)).send({})).status).toBe(409);
  });

  it('an unapplied note can be voided; the invoice side rejects tax codes of the wrong side', async () => {
    const cn = await postDoc('credit-notes', { party_id: cust, doc_date: '2026-11-05', lines: [line('4000', '10.00', null)] });
    await api.post(`/api/v1/credit-notes/${cn.id}/void`).set(auth(amy)).send({}).expect(200);
    expect((await api.post('/api/v1/credit-notes').set(auth(amy)).send({ party_id: cust, doc_date: '2026-11-05', lines: [line('4000', '10.00', in12)] })).status).toBe(422);
    expect((await api.post('/api/v1/credit-notes').set(auth(amy)).send({ party_id: supp, doc_date: '2026-11-05', lines: [line('4000', '10.00', null)] })).status).toBe(422);
  });

  it('two simultaneous applications cannot use the same credit twice', async () => {
    const i1 = await inv();
    const i2 = await inv();
    const cn = await postDoc('credit-notes', { party_id: cust, doc_date: '2026-11-05', lines: [line('4000', '100.00', null)] });
    const go = (doc: string) => api.post(`/api/v1/credit-notes/${cn.id}/apply`).set(auth(amy)).send({ date: '2026-11-06', allocations: [{ document_id: doc, amount: '100.00' }] });
    const res = await Promise.all([go(i1.id), go(i2.id)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 422]);
  });
});

describe('debit notes', () => {
  it('post to payables in reverse and apply to a bill', async () => {
    const bill = await postDoc('bills', { party_id: supp, doc_date: '2026-11-01', lines: [line('6000', '500.00', in12)] }); // 560
    const dn = await postDoc('debit-notes', { party_id: supp, doc_date: '2026-11-03', lines: [line('6000', '100.00', in12)] }); // 112
    expect(await bal('2000')).toBe('0.0000/448.0000');
    expect(dn.doc_no).toBe('1');
    await api.post(`/api/v1/debit-notes/${dn.id}/apply`).set(auth(amy)).send({ date: '2026-11-04', allocations: [{ document_id: bill.id, amount: '112.00' }] }).expect(200);
    expect((await api.get(`/api/v1/bills/${bill.id}`).set(auth(amy))).body.balance).toBe('448.0000');
    const a = await aging('payables');
    expect(a.totals.total).toBe('448.0000');
    expect(a.reconciles).toBe(true);
  });

  it('a viewer cannot write notes', async () => {
    expect((await api.post('/api/v1/debit-notes').set(auth(vic)).send({ party_id: supp, doc_date: '2026-11-03', lines: [line('6000', '1.00', null)] })).status).toBe(403);
    expect((await api.get('/api/v1/debit-notes').set(auth(vic))).status).toBe(200);
    expect((await api.get('/api/v1/credit-notes')).status).toBe(401);
    expect((await api.post('/api/v1/journal-entries/00000000-0000-4000-8000-000000000000/reverse').set(auth(amy)).send({})).status).toBe(404);
  });
});

describe('bank reconciliation', () => {
  const bank = () => acc['1010'];
  const importLines = (lines: object[], account = bank(), tok = amy) => api.post(`/api/v1/bank/${account}/statement-lines`).set(auth(tok)).send({ lines });
  const recon = async (asOf = '2026-12-31') => (await api.get(`/api/v1/bank/${bank()}/reconciliation`).query({ as_of: asOf }).set(auth(amy)).expect(200)).body;
  const je = (date: string, dr: string, cr: string, amount: string) =>
    api.post('/api/v1/journal-entries').set(auth(amy)).send({ entry_date: date, description: 'x', lines: [{ account_id: acc[dr], debit: amount, credit: '0' }, { account_id: acc[cr], debit: '0', credit: amount }] }).expect(201);

  it('imports once, ignores a repeat, keeps genuinely identical lines in one file', async () => {
    const lines = [{ date: '2026-11-02', description: 'Deposit', amount: '500.00' }, { date: '2026-11-02', description: 'Deposit', amount: '500.00' }, { date: '2026-11-03', description: 'Fee', amount: '-25.50' }];
    expect((await importLines(lines).expect(201)).body).toMatchObject({ added: 3, skipped: 0 });
    expect((await importLines(lines).expect(201)).body).toMatchObject({ added: 0, skipped: 3 });
    expect((await recon()).unmatched_statement).toHaveLength(3);
  });

  it('suggests and auto-matches unambiguous lines, and reports the difference exactly', async () => {
    await je('2026-11-02', '1010', '3000', '500.00');
    await je('2026-11-04', '6000', '1010', '300.00');
    await importLines([{ date: '2026-11-03', description: 'Deposit', amount: '500.00' }, { date: '2026-11-06', description: 'Check 101', amount: '-300.00' }, { date: '2026-11-07', description: 'Bank fee', amount: '-25.00' }]).expect(201);
    const before = await recon();
    expect(before.suggestions).toHaveLength(2);
    expect(before.reconciled).toBe(false);
    expect((await api.post(`/api/v1/bank/${bank()}/auto-match`).query({ as_of: '2026-12-31' }).set(auth(amy)).expect(200)).body.matched).toBe(2);
    const after = await recon();
    expect(after.matched_count).toBe(2);
    expect(after.unmatched_statement).toHaveLength(1);
    expect(after.unmatched_ledger).toHaveLength(0);
    expect(after.difference).toBe('25.0000'); // ledger 200 vs statement 175: the fee is not in the books yet
    expect(after.explained).toBe(true);
  });

  it('posting the fee from the statement books it and matches it, and the account is reconciled', async () => {
    await je('2026-11-02', '1010', '3000', '500.00');
    await importLines([{ date: '2026-11-02', description: 'Deposit', amount: '500.00' }, { date: '2026-11-07', description: 'Bank fee', amount: '-25.00' }]).expect(201);
    await api.post(`/api/v1/bank/${bank()}/auto-match`).set(auth(amy)).expect(200);
    const fee = (await recon()).unmatched_statement[0];
    await api.post(`/api/v1/bank/statement-lines/${fee.id}/post`).set(auth(amy)).send({ account_id: acc['6200'], memo: 'Monthly fee' }).expect(201);
    const r = await recon();
    expect(r.reconciled).toBe(true);
    expect(r.difference).toBe('0.0000');
    expect(await bal('6200')).toBe('25.0000/0.0000');
    expect((await api.post(`/api/v1/bank/statement-lines/${fee.id}/post`).set(auth(amy)).send({ account_id: acc['6200'] })).status).toBe(409);
  });

  it('leaves ambiguous lines alone, matches by hand, refuses mismatches and can undo', async () => {
    await je('2026-11-02', '1010', '3000', '100.00');
    await je('2026-11-03', '1010', '3000', '100.00');
    await importLines([{ date: '2026-11-02', description: 'A', amount: '100.00' }, { date: '2026-11-03', description: 'B', amount: '100.00' }, { date: '2026-11-04', description: 'C', amount: '77.00' }]).expect(201);
    expect((await api.post(`/api/v1/bank/${bank()}/auto-match`).set(auth(amy)).expect(200)).body.matched).toBe(0);
    const r = await recon();
    const s = r.unmatched_statement as { id: string; amount: string }[];
    const l = r.unmatched_ledger as { journal_line_id: string }[];
    const m = (sid: string, lid: string) => api.post('/api/v1/bank/matches').set(auth(amy)).send({ statement_line_id: sid, journal_line_id: lid });
    expect((await m(s[2]!.id, l[0]!.journal_line_id)).status).toBe(422); // 77 vs 100
    await m(s[0]!.id, l[0]!.journal_line_id).expect(201);
    expect((await m(s[1]!.id, l[0]!.journal_line_id)).status).toBe(409); // ledger line already used
    await api.delete(`/api/v1/bank/matches/${s[0]!.id}`).set(auth(amy)).expect(200);
    expect((await api.delete(`/api/v1/bank/matches/${s[0]!.id}`).set(auth(amy))).status).toBe(404);
  });

  it('only asset accounts, only people with bank access, and nothing across tenants', async () => {
    expect((await importLines([{ date: '2026-11-02', description: 'x', amount: '1' }], acc['4000'])).status).toBe(422);
    expect((await importLines([{ date: '2026-11-02', description: 'x', amount: '1' }], bank(), vic)).status).toBe(403);
    expect((await importLines([{ date: '2026-11-02', description: 'x', amount: '0' }])).status).toBe(422);
    expect((await importLines([])).status).toBe(422);
    await importLines([{ date: '2026-11-02', description: 'x', amount: '5' }]).expect(201);
    const t2 = await seedTenant('nb-other', { zed: ['Accountant'] });
    const zed = await tokenFor(api, t2, 'zed');
    const mine = (await recon()).unmatched_statement[0].id as string;
    expect((await api.post(`/api/v1/bank/statement-lines/${mine}/post`).set(auth(zed)).send({ account_id: (await accountIds(t2.tenantId))['6200'] })).status).toBe(404);
    expect((await api.get(`/api/v1/bank/${bank()}/reconciliation`).set(auth(zed))).status).toBe(422);
    await expect(owner.query('UPDATE bank_statement_lines SET amount = 1')).rejects.toThrow();
  });
});
