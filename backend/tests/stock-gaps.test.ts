import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let amy: string;
let wes: string;
let vic: string;
let supp: string;
let cust: string;
let flour: string;
let in12: string;

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('sg-co', { amy: ['Accountant'], wes: ['WarehouseClerk'], vic: ['Viewer'] }, false, { modules: ['finance', 'supply_chain'] });
  [amy, wes, vic] = await Promise.all([tokenFor(api, t, 'amy'), tokenFor(api, t, 'wes'), tokenFor(api, t, 'vic')]);
  supp = (await api.post('/api/v1/suppliers').set(auth(amy)).send({ code: 's1', name: 'Harina Mills' }).expect(201)).body.id;
  cust = (await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'c1', name: 'Cafe' }).expect(201)).body.id;
  flour = (await api.post('/api/v1/items').set(auth(wes)).send({ sku: 'flr', name: 'Flour' }).expect(201)).body.id;
  in12 = ((await api.get('/api/v1/tax-codes').set(auth(amy))).body as { id: string; code: string }[]).find((c) => c.code === 'IN12')!.id;
});
afterAll(shutdown);

async function openPo(qty: string, cost: string) {
  const d = (await api.post('/api/v1/purchase-orders').set(auth(wes)).send({ party_id: supp, order_date: '2026-11-01', lines: [{ item_id: flour, quantity: qty, unit_cost: cost }] }).expect(201)).body;
  return (await api.post(`/api/v1/purchase-orders/${d.id}/approve`).set(auth(wes)).expect(200)).body;
}
async function openSo(qty: string, price: string) {
  const d = (await api.post('/api/v1/sales-orders').set(auth(wes)).send({ party_id: cust, order_date: '2026-11-01', lines: [{ item_id: flour, quantity: qty, unit_price: price }] }).expect(201)).body;
  return (await api.post(`/api/v1/sales-orders/${d.id}/approve`).set(auth(wes)).expect(200)).body;
}
const move = (path: string, act: string, o: { id: string; lines: { id: string }[] }, qty: string, tok = wes) =>
  api.post(`/api/v1/${path}/${o.id}/${act}`).set(auth(tok)).send({ date: '2026-11-05', lines: [{ line_id: o.lines[0]!.id, quantity: qty }] });
const bal = async (code: string) => {
  const r = ((await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(amy))).body.rows as { code: string; debit: string; credit: string }[]).find((x) => x.code === code);
  return r ? `${r.debit}/${r.credit}` : 'none';
};
const item = async () => ((await api.get('/api/v1/items').set(auth(amy))).body as Record<string, string | boolean>[]).find((i) => i.id === flour)!;

describe('three-way match (bill from receipt)', () => {
  it('bills only what was received, and posting clears goods received not invoiced', async () => {
    const o = await openPo('10', '100.00');
    await move('purchase-orders', 'receive', o, '6').expect(200);
    expect(await bal('2050')).toBe('0.0000/600.0000');
    const bill = (await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(amy)).send({ doc_date: '2026-11-10', tax_code_id: in12 }).expect(201)).body;
    expect(bill.status).toBe('draft');
    expect(bill.lines[0].quantity).toBe('6.0000');
    expect(bill.lines[0].account_code).toBe('2050');
    expect(bill.total).toBe('672.0000'); // 600 + 12% input tax
    await api.post(`/api/v1/bills/${bill.id}/post`).set(auth(amy)).expect(200);
    expect(await bal('2050')).toBe('0.0000/0.0000');
    expect(await bal('2000')).toBe('0.0000/672.0000');
    expect((await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(amy)).send({})).status).toBe(409); // nothing left to bill
    await move('purchase-orders', 'receive', o, '4').expect(200);
    const second = (await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(amy)).send({}).expect(201)).body;
    expect(second.lines[0].quantity).toBe('4.0000');
  });

  it('two drafts cannot bill the same goods twice; voiding the bill releases them', async () => {
    const o = await openPo('10', '10.00');
    await move('purchase-orders', 'receive', o, '10').expect(200);
    const b1 = (await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(amy)).send({}).expect(201)).body;
    const b2 = (await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(amy)).send({}).expect(201)).body;
    await api.post(`/api/v1/bills/${b1.id}/post`).set(auth(amy)).expect(200);
    const r = await api.post(`/api/v1/bills/${b2.id}/post`).set(auth(amy));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('over_billing');
    await api.post(`/api/v1/bills/${b1.id}/void`).set(auth(amy)).send({}).expect(200);
    await api.post(`/api/v1/bills/${b2.id}/post`).set(auth(amy)).expect(200);
  });

  it('a price difference is fixed by editing the draft; the variance stays on the goods-received account', async () => {
    const o = await openPo('10', '100.00');
    await move('purchase-orders', 'receive', o, '10').expect(200);
    const b = (await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(amy)).send({}).expect(201)).body;
    const l = b.lines[0];
    await api.put(`/api/v1/bills/${b.id}`).set(auth(amy)).send({ party_id: supp, doc_date: '2026-11-10', lines: [{ description: l.description, account_id: l.account_id, quantity: '10', unit_price: '105.00', po_line_id: l.po_line_id }] }).expect(200);
    await api.post(`/api/v1/bills/${b.id}/post`).set(auth(amy)).expect(200);
    expect(await bal('2050')).toBe('50.0000/0.0000'); // billed 1050 against 1000 received: a visible variance to clear
  });

  it('needs payables permission: a warehouse clerk cannot bill and a viewer cannot either', async () => {
    const o = await openPo('1', '1');
    await move('purchase-orders', 'receive', o, '1').expect(200);
    expect((await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(wes)).send({})).status).toBe(403);
    expect((await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(vic)).send({})).status).toBe(403);
  });
});

describe('invoice from delivery', () => {
  it('invoices only what was delivered, on the sales account, once', async () => {
    const a = await openPo('10', '50.00');
    await move('purchase-orders', 'receive', a, '10').expect(200);
    const o = await openSo('5', '120.00');
    expect((await api.post(`/api/v1/sales-orders/${o.id}/invoice`).set(auth(amy)).send({})).status).toBe(409);
    await move('sales-orders', 'deliver', o, '3').expect(200);
    const inv = (await api.post(`/api/v1/sales-orders/${o.id}/invoice`).set(auth(amy)).send({ doc_date: '2026-11-12' }).expect(201)).body;
    expect(inv.lines[0].quantity).toBe('3.0000');
    expect(inv.lines[0].account_code).toBe('4000');
    expect(inv.total).toBe('360.0000');
    await api.post(`/api/v1/invoices/${inv.id}/post`).set(auth(amy)).expect(200);
    expect((await api.post(`/api/v1/sales-orders/${o.id}/invoice`).set(auth(amy)).send({})).status).toBe(409);
    await api.post(`/api/v1/invoices/${inv.id}/void`).set(auth(amy)).send({}).expect(200);
    expect((await api.post(`/api/v1/sales-orders/${o.id}/invoice`).set(auth(amy)).send({})).status).toBe(201);
  });
});

describe('returns', () => {
  it('a purchase return before billing takes stock out at the order price and debits goods received', async () => {
    const o = await openPo('10', '100.00');
    await move('purchase-orders', 'receive', o, '10').expect(200);
    const r = (await move('purchase-orders', 'return', o, '4').expect(200)).body;
    expect(r.order.lines[0].done_qty).toBe('6.0000');
    expect((await item()).qty_on_hand).toBe('6.0000');
    expect((await item()).value_on_hand).toBe('600.0000');
    expect(await bal('2050')).toBe('0.0000/600.0000');
    expect(await bal('1200')).toBe('600.0000/0.0000');
  });

  it('a received-and-closed order reopens on return, and billed goods cannot be returned this way', async () => {
    const o = await openPo('10', '10.00');
    await move('purchase-orders', 'receive', o, '10').expect(200);
    expect((await api.get(`/api/v1/purchase-orders/${o.id}`).set(auth(wes))).body.status).toBe('closed');
    await move('purchase-orders', 'return', o, '2').expect(200);
    expect((await api.get(`/api/v1/purchase-orders/${o.id}`).set(auth(wes))).body.status).toBe('open');
    const b = (await api.post(`/api/v1/purchase-orders/${o.id}/bill`).set(auth(amy)).send({}).expect(201)).body;
    await api.post(`/api/v1/bills/${b.id}/post`).set(auth(amy)).expect(200);
    const r = await move('purchase-orders', 'return', o, '1');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('over_return');
  });

  it('a sales return puts stock back at what the delivery cost and credits cost of goods sold', async () => {
    const a = await openPo('10', '80.00');
    await move('purchase-orders', 'receive', a, '10').expect(200);
    const o = await openSo('5', '200.00');
    await move('sales-orders', 'deliver', o, '5').expect(200);
    expect(await bal('5000')).toBe('400.0000/0.0000');
    await move('sales-orders', 'return', o, '2').expect(200);
    expect(await bal('5000')).toBe('240.0000/0.0000');
    const i = await item();
    expect(i.qty_on_hand).toBe('7.0000');
    expect(i.value_on_hand).toBe('560.0000');
    const v = (await api.get('/api/v1/reports/stock-valuation').query({ as_of: '2026-12-31' }).set(auth(amy))).body;
    expect(v.reconciles).toBe(true);
  });

  it('cannot return more than was received or delivered, or from a draft order', async () => {
    const o = await openPo('10', '1.00');
    await move('purchase-orders', 'receive', o, '3').expect(200);
    expect((await move('purchase-orders', 'return', o, '4')).status).toBe(422);
    const d = (await api.post('/api/v1/sales-orders').set(auth(wes)).send({ party_id: cust, order_date: '2026-11-01', lines: [{ item_id: flour, quantity: '1', unit_price: '1' }] }).expect(201)).body;
    expect((await move('sales-orders', 'return', d, '1')).status).toBe(409);
    expect((await move('purchase-orders', 'return', o, '1', vic)).status).toBe(403);
  });
});

describe('reorder level', () => {
  it('flags items at or below their level and shows what is on order and committed', async () => {
    await api.patch(`/api/v1/items/${flour}`).set(auth(wes)).send({ reorder_level: '5' }).expect(200);
    expect((await item()).below_reorder).toBe(true);
    const o = await openPo('20', '10.00');
    let rep = (await api.get('/api/v1/reports/reorder').set(auth(vic)).expect(200)).body;
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ sku: 'FLR', on_hand: '0.0000', on_order: '20.0000', committed: '0.0000' });
    await move('purchase-orders', 'receive', o, '20').expect(200);
    rep = (await api.get('/api/v1/reports/reorder').set(auth(vic)).expect(200)).body;
    expect(rep).toHaveLength(0);
    expect((await api.patch(`/api/v1/items/${flour}`).set(auth(wes)).send({ reorder_level: '-1' })).status).toBe(422);
  });

  it('database refuses billing past receipts', async () => {
    const o = await openPo('10', '1.00');
    await move('purchase-orders', 'receive', o, '2').expect(200);
    await expect(owner.query('UPDATE purchase_order_lines SET billed_qty = 3')).rejects.toThrow();
  });
});
