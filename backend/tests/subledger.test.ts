import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountIds, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let amy: string;
let fin: string;
let vic: string;
let cust: string;
let supp: string;
let out12: string;
let in12: string;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('sub-co', { amy: ['Accountant'], fin: ['FinanceManager'], vic: ['Viewer'] });
  [amy, fin, vic] = await Promise.all([tokenFor(api, t, 'amy'), tokenFor(api, t, 'fin'), tokenFor(api, t, 'vic')]);
  acc = await accountIds(t.tenantId);
  cust = (await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'c1', name: 'Casa Verde Cafe', terms_days: 30 }).expect(201)).body.id;
  supp = (await api.post('/api/v1/suppliers').set(auth(amy)).send({ code: 's1', name: 'Harina Mills', terms_days: 15 }).expect(201)).body.id;
  const codes = (await api.get('/api/v1/tax-codes').set(auth(amy)).expect(200)).body as { id: string; code: string }[];
  out12 = codes.find((c) => c.code === 'OUT12')!.id;
  in12 = codes.find((c) => c.code === 'IN12')!.id;
});
afterAll(shutdown);

const inv = (over: Record<string, unknown> = {}) => ({
  party_id: cust, doc_date: '2026-11-01',
  lines: [{ description: 'Catering', account_id: acc['4000'], quantity: '2', unit_price: '500.00', tax_code_id: out12 }],
  ...over,
});
const bill = (over: Record<string, unknown> = {}) => ({
  party_id: supp, doc_date: '2026-11-02',
  lines: [{ description: 'Flour', account_id: acc['6000'], quantity: '1', unit_price: '250.00', tax_code_id: in12 }],
  ...over,
});
const draft = async (path: string, body: object, tok = amy) => (await api.post(`/api/v1/${path}`).set(auth(tok)).send(body).expect(201)).body;
const post = async (path: string, id: string, tok = amy) => (await api.post(`/api/v1/${path}/${id}/post`).set(auth(tok)).expect(200)).body;
const tb = async () => (await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(amy)).expect(200)).body;
const balanceOf = (b: { rows: { code: string; debit: string; credit: string }[] }, code: string) => b.rows.find((r) => r.code === code);

describe('invoices', () => {
  it('computes totals exactly and defaults the due date from the customer terms', async () => {
    const d = await draft('invoices', inv());
    expect(d.status).toBe('draft');
    expect(d.subtotal).toBe('1000.0000');
    expect(d.tax_total).toBe('120.0000');
    expect(d.total).toBe('1120.0000');
    expect(d.due_date).toBe('2026-12-01');
    expect(d.doc_no).toBeNull();
  });

  it('rounds each line to the cent, half up', async () => {
    const d = await draft('invoices', inv({ lines: [{ description: 'x', account_id: acc['4000'], quantity: '3', unit_price: '0.335', tax_code_id: out12 }] }));
    expect(d.lines[0].net).toBe('1.0100'); // 1.005 -> 1.01
    expect(d.lines[0].tax).toBe('0.1200'); // 0.1212 -> 0.12
  });

  it('posting writes a balanced entry: receivable debit, revenue and output VAT credit', async () => {
    const d = await draft('invoices', inv());
    const p = await post('invoices', d.id);
    expect(p.status).toBe('posted');
    expect(p.doc_no).toBe('1');
    const je = (await api.get(`/api/v1/journal-entries/${p.journal_entry_id}`).set(auth(amy)).expect(200)).body;
    const by = (code: string) => je.lines.find((l: { account_code: string }) => l.account_code === code);
    expect(by('1100').debit).toBe('1120.0000');
    expect(by('4000').credit).toBe('1000.0000');
    expect(by('2100').credit).toBe('120.0000');
  });

  it('numbers invoices without gaps and a void does not free the number', async () => {
    const a = await post('invoices', (await draft('invoices', inv())).id);
    const b = await post('invoices', (await draft('invoices', inv())).id);
    expect([a.doc_no, b.doc_no]).toEqual(['1', '2']);
    await api.post(`/api/v1/invoices/${b.id}/void`).set(auth(amy)).send({ void_date: '2026-11-03' }).expect(200);
    const c = await post('invoices', (await draft('invoices', inv())).id);
    expect(c.doc_no).toBe('3');
  });

  it('only a draft can be edited or deleted', async () => {
    const d = await draft('invoices', inv());
    const upd = await api.put(`/api/v1/invoices/${d.id}`).set(auth(amy)).send(inv({ reference: 'PO-9' })).expect(200);
    expect(upd.body.reference).toBe('PO-9');
    await post('invoices', d.id);
    expect((await api.put(`/api/v1/invoices/${d.id}`).set(auth(amy)).send(inv())).status).toBe(409);
    expect((await api.delete(`/api/v1/invoices/${d.id}`).set(auth(amy))).status).toBe(409);
    expect((await api.post(`/api/v1/invoices/${d.id}/post`).set(auth(amy))).status).toBe(409);
    const d2 = await draft('invoices', inv());
    await api.delete(`/api/v1/invoices/${d2.id}`).set(auth(amy)).expect(200);
    expect((await api.get(`/api/v1/invoices/${d2.id}`).set(auth(amy))).status).toBe(404);
  });

  it('rejects the wrong kind of party, the wrong tax side, a zero total and a due date before the date', async () => {
    expect((await api.post('/api/v1/invoices').set(auth(amy)).send(inv({ party_id: supp }))).status).toBe(422);
    expect((await api.post('/api/v1/invoices').set(auth(amy)).send(inv({ lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: '10.00', tax_code_id: in12 }] }))).status).toBe(422);
    expect((await api.post('/api/v1/invoices').set(auth(amy)).send(inv({ lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: '0' }] }))).status).toBe(422);
    expect((await api.post('/api/v1/invoices').set(auth(amy)).send(inv({ due_date: '2026-10-01' }))).status).toBe(422);
    expect((await api.post('/api/v1/invoices').set(auth(amy)).send(inv({ lines: [{ description: 'x', account_id: acc['4000'], quantity: '1.5.2', unit_price: '10' }] }))).status).toBe(422);
  });

  it('voiding reverses the ledger and leaves the trial balance clean', async () => {
    const p = await post('invoices', (await draft('invoices', inv())).id);
    const v = (await api.post(`/api/v1/invoices/${p.id}/void`).set(auth(amy)).send({ void_date: '2026-11-05' }).expect(200)).body;
    expect(v.status).toBe('void');
    expect(v.void_entry_id).toBeTruthy();
    const b = await tb();
    expect(b.balanced).toBe(true);
    expect(balanceOf(b, '1100')).toMatchObject({ debit: '0.0000', credit: '0.0000' }); // reversed to nothing
  });

  it('refuses to void an invoice that has been paid, and to reverse its entry by hand', async () => {
    const p = await post('invoices', (await draft('invoices', inv())).id);
    await api.post('/api/v1/receipts').set(auth(amy)).send({ party_id: cust, pay_date: '2026-11-10', bank_account_id: acc['1010'], allocations: [{ document_id: p.id, amount: '100.00' }] }).expect(201);
    expect((await api.post(`/api/v1/invoices/${p.id}/void`).set(auth(amy)).send({})).status).toBe(409);
    const r = await api.post(`/api/v1/journal-entries/${p.journal_entry_id}/reverse`).set(auth(amy)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('subledger_entry');
  });
});

describe('bills', () => {
  it('posting debits the expense and input VAT and credits payables', async () => {
    const p = await post('bills', (await draft('bills', bill())).id);
    expect(p.total).toBe('280.0000');
    const je = (await api.get(`/api/v1/journal-entries/${p.journal_entry_id}`).set(auth(amy)).expect(200)).body;
    const by = (code: string) => je.lines.find((l: { account_code: string }) => l.account_code === code);
    expect(by('6000').debit).toBe('250.0000');
    expect(by('1300').debit).toBe('30.0000');
    expect(by('2000').credit).toBe('280.0000');
  });

  it('keeps invoice and bill numbering separate', async () => {
    const a = await post('invoices', (await draft('invoices', inv())).id);
    const b = await post('bills', (await draft('bills', bill())).id);
    expect([a.doc_no, b.doc_no]).toEqual(['1', '1']);
  });
});

describe('receipts and payments', () => {
  it('a partial receipt reduces the balance; the rest clears it; over-paying is refused', async () => {
    const p = await post('invoices', (await draft('invoices', inv())).id);
    const pay = (amount: string) => api.post('/api/v1/receipts').set(auth(amy)).send({ party_id: cust, pay_date: '2026-11-10', bank_account_id: acc['1010'], allocations: [{ document_id: p.id, amount }] });
    expect((await pay('500.00')).status).toBe(201);
    expect((await api.get(`/api/v1/invoices/${p.id}`).set(auth(amy))).body.balance).toBe('620.0000');
    const over = await pay('620.01');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('over_allocation');
    expect((await pay('620.00')).status).toBe(201);
    const after = (await api.get(`/api/v1/invoices/${p.id}`).set(auth(amy))).body;
    expect(after.balance).toBe('0.0000');
    expect(after.payments).toHaveLength(2);
    expect(balanceOf(await tb(), '1100')).toMatchObject({ debit: '0.0000', credit: '0.0000' }); // receivable fully cleared
    expect(balanceOf(await tb(), '1010')!.debit).toBe('1120.0000');
  });

  it('one payment can settle several bills', async () => {
    const b1 = await post('bills', (await draft('bills', bill())).id);
    const b2 = await post('bills', (await draft('bills', bill())).id);
    const r = await api.post('/api/v1/vendor-payments').set(auth(amy)).send({
      party_id: supp, pay_date: '2026-11-20', bank_account_id: acc['1010'], method: 'check',
      allocations: [{ document_id: b1.id, amount: '280.00' }, { document_id: b2.id, amount: '100.00' }],
    }).expect(201);
    expect(r.body.amount).toBe('380.0000');
    expect((await api.get(`/api/v1/bills/${b2.id}`).set(auth(amy))).body.balance).toBe('180.0000');
  });

  it('refuses another customer\'s invoice, a draft, a duplicate line and a non-asset bank account', async () => {
    const other = (await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'c2', name: 'Other' }).expect(201)).body.id;
    const p = await post('invoices', (await draft('invoices', inv())).id);
    const d = await draft('invoices', inv());
    const send = (body: object) => api.post('/api/v1/receipts').set(auth(amy)).send({ pay_date: '2026-11-10', bank_account_id: acc['1010'], ...body });
    expect((await send({ party_id: other, allocations: [{ document_id: p.id, amount: '1.00' }] })).status).toBe(422);
    expect((await send({ party_id: cust, allocations: [{ document_id: d.id, amount: '1.00' }] })).status).toBe(409);
    expect((await send({ party_id: cust, allocations: [{ document_id: p.id, amount: '1.00' }, { document_id: p.id, amount: '1.00' }] })).status).toBe(422);
    expect((await send({ party_id: cust, bank_account_id: acc['4000'], allocations: [{ document_id: p.id, amount: '1.00' }] })).status).toBe(422);
    expect((await send({ party_id: cust, allocations: [{ document_id: p.id, amount: '0' }] })).status).toBe(422);
    expect((await send({ party_id: supp, allocations: [{ document_id: p.id, amount: '1.00' }] })).status).toBe(422);
  });

  it('two simultaneous receipts cannot over-collect', async () => {
    const p = await post('invoices', (await draft('invoices', inv())).id);
    const go = () => api.post('/api/v1/receipts').set(auth(amy)).send({ party_id: cust, pay_date: '2026-11-10', bank_account_id: acc['1010'], allocations: [{ document_id: p.id, amount: '1000.00' }] });
    const res = await Promise.all([go(), go()]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 422]);
    expect((await api.get(`/api/v1/invoices/${p.id}`).set(auth(amy))).body.paid_total).toBe('1000.0000');
  });

  it('the database refuses a payment whose allocations do not add up', async () => {
    const p = await post('invoices', (await draft('invoices', inv())).id);
    const je = p.journal_entry_id as string;
    await expect(
      owner.query(
        `INSERT INTO payments (tenant_id, kind, party_id, pay_date, amount, bank_account_id, journal_entry_id, created_by)
         SELECT $1, 'receipt', $2, '2026-11-10', 50, $3, $4, created_by FROM documents WHERE id = $5`,
        [t.tenantId, cust, acc['1010'], je, p.id],
      ),
    ).rejects.toThrow(/not fully allocated/);
  });
});

describe('aging, VAT and the ledger', () => {
  it('buckets open items by days past due and agrees with the ledger control account', async () => {
    await post('invoices', (await draft('invoices', inv({ doc_date: '2026-08-01' }))).id); // due 2026-08-31
    await post('invoices', (await draft('invoices', inv({ doc_date: '2026-10-20' }))).id); // due 2026-11-19
    const r = (await api.get('/api/v1/reports/aging/receivables').query({ as_of: '2026-11-30' }).set(auth(vic)).expect(200)).body;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].d90_plus).toBe('1120.0000'); // 91 days late
    expect(r.rows[0].d1_30).toBe('1120.0000'); // 11 days late
    expect(r.totals.total).toBe('2240.0000');
    expect(r.ledger_balance).toBe('2240.0000');
    expect(r.reconciles).toBe(true);
  });

  it('payments dated after the cut-off do not reduce an earlier aging', async () => {
    const p = await post('invoices', (await draft('invoices', inv())).id);
    await api.post('/api/v1/receipts').set(auth(amy)).send({ party_id: cust, pay_date: '2026-12-10', bank_account_id: acc['1010'], allocations: [{ document_id: p.id, amount: '1120.00' }] }).expect(201);
    const before = (await api.get('/api/v1/reports/aging/receivables').query({ as_of: '2026-11-30' }).set(auth(amy))).body;
    const after = (await api.get('/api/v1/reports/aging/receivables').query({ as_of: '2026-12-31' }).set(auth(amy))).body;
    expect(before.totals.total).toBe('1120.0000');
    expect(after.rows).toHaveLength(0);
  });

  it('a manual entry on the control account shows up as a difference', async () => {
    await post('invoices', (await draft('invoices', inv())).id);
    await api.post('/api/v1/journal-entries').set(auth(amy)).send({
      entry_date: '2026-11-15', description: 'Manual', lines: [{ account_id: acc['1100'], debit: '10.00', credit: '0' }, { account_id: acc['4000'], debit: '0', credit: '10.00' }],
    }).expect(201);
    const r = (await api.get('/api/v1/reports/aging/receivables').query({ as_of: '2026-11-30' }).set(auth(amy))).body;
    expect(r.reconciles).toBe(false);
  });

  it('the VAT report nets output tax against input tax', async () => {
    await post('invoices', (await draft('invoices', inv())).id);
    await post('bills', (await draft('bills', bill())).id);
    await draft('invoices', inv()); // a draft never counts
    const v = (await api.get('/api/v1/reports/vat').query({ from: '2026-11-01', to: '2026-11-30' }).set(auth(amy)).expect(200)).body;
    expect(v.output_tax).toBe('120.0000');
    expect(v.input_tax).toBe('30.0000');
    expect(v.payable).toBe('90.0000');
  });
});

describe('access, tax codes and privacy', () => {
  it('a viewer reads but cannot write; no token is 401', async () => {
    const d = await draft('invoices', inv());
    expect((await api.get('/api/v1/invoices').set(auth(vic))).status).toBe(200);
    expect((await api.get(`/api/v1/invoices/${d.id}`).set(auth(vic))).status).toBe(200);
    expect((await api.post('/api/v1/invoices').set(auth(vic)).send(inv())).status).toBe(403);
    expect((await api.post(`/api/v1/invoices/${d.id}/post`).set(auth(vic))).status).toBe(403);
    expect((await api.post('/api/v1/customers').set(auth(vic)).send({ code: 'x', name: 'x' })).status).toBe(403);
    expect((await api.get('/api/v1/invoices')).status).toBe(401);
    expect((await api.post('/api/v1/receipts').send({})).status).toBe(401);
  });

  it('only a finance manager manages tax codes; a bad rate is refused', async () => {
    const body = { code: 'ZERO', name: 'Zero rated', rate: '0', kind: 'output', account_id: acc['2100'] };
    expect((await api.post('/api/v1/tax-codes').set(auth(amy)).send(body)).status).toBe(403);
    expect((await api.post('/api/v1/tax-codes').set(auth(fin)).send(body)).status).toBe(201);
    expect((await api.post('/api/v1/tax-codes').set(auth(fin)).send({ ...body, code: 'BAD', rate: '101' })).status).toBe(422);
    const codes = (await api.get('/api/v1/tax-codes').set(auth(amy))).body as { id: string; code: string }[];
    const zero = codes.find((c) => c.code === 'ZERO')!;
    await api.patch(`/api/v1/tax-codes/${zero.id}`).set(auth(fin)).send({ is_active: false }).expect(200);
    const r = await api.post('/api/v1/invoices').set(auth(amy)).send(inv({ lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: '10', tax_code_id: zero.id }] }));
    expect(r.status).toBe(422);
  });

  it('the tax number is stored encrypted, never listed, and revealing it is audited', async () => {
    await api.patch(`/api/v1/customers/${cust}`).set(auth(amy)).send({ tin: '123-456-789-000' }).expect(200);
    const list = (await api.get('/api/v1/customers').set(auth(amy)).expect(200)).body;
    expect(JSON.stringify(list)).not.toContain('123-456');
    expect(list[0].has_tin).toBe(true);
    const raw = (await owner.query('SELECT tin_enc FROM parties WHERE id = $1', [cust])).rows[0].tin_enc as string;
    expect(raw.startsWith('enc1.')).toBe(true);
    expect(raw).not.toContain('123-456');
    expect((await api.get(`/api/v1/customers/${cust}/tin`).set(auth(vic))).status).toBe(403);
    expect((await api.get(`/api/v1/customers/${cust}/tin`).set(auth(amy)).expect(200)).body.tin).toBe('123-456-789-000');
    const audit = await owner.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'customer.tin_viewed'", [t.tenantId]);
    expect(audit.rowCount).toBe(1);
  });

  it('customers and suppliers are separate lists, and codes are unique per kind', async () => {
    expect((await api.get('/api/v1/customers').set(auth(amy))).body.map((p: { code: string }) => p.code)).toEqual(['C1']);
    expect((await api.get('/api/v1/suppliers').set(auth(amy))).body.map((p: { code: string }) => p.code)).toEqual(['S1']);
    expect((await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'C1', name: 'Dup' })).status).toBe(409);
    expect((await api.patch(`/api/v1/suppliers/${cust}`).set(auth(amy)).send({ name: 'x' })).status).toBe(404); // a customer id on the supplier route
  });

  it('another tenant cannot see or use this tenant\'s documents', async () => {
    const d = await draft('invoices', inv());
    const t2 = await seedTenant('other-co', { zed: ['Accountant'] });
    const zed = await tokenFor(api, t2, 'zed');
    expect((await api.get(`/api/v1/invoices/${d.id}`).set(auth(zed))).status).toBe(404);
    expect((await api.get('/api/v1/invoices').set(auth(zed))).body.total).toBe(0);
    expect((await api.get('/api/v1/customers').set(auth(zed))).body).toEqual([]);
    expect((await api.post(`/api/v1/invoices/${d.id}/post`).set(auth(zed))).status).toBe(404);
    expect((await api.post('/api/v1/invoices').set(auth(zed)).send(inv())).status).toBe(422); // customer id from another tenant
  });
});
