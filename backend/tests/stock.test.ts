import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountIds, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let amy: string;
let wes: string;
let vic: string;
let supp: string;
let cust: string;
let flour: string;

const MODS = ['finance', 'supply_chain'];
beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('sc-co', { amy: ['Accountant'], wes: ['WarehouseClerk'], vic: ['Viewer'] }, false, { modules: MODS });
  [amy, wes, vic] = await Promise.all([tokenFor(api, t, 'amy'), tokenFor(api, t, 'wes'), tokenFor(api, t, 'vic')]);
  acc = await accountIds(t.tenantId);
  supp = (await api.post('/api/v1/suppliers').set(auth(amy)).send({ code: 's1', name: 'Harina Mills' }).expect(201)).body.id;
  cust = (await api.post('/api/v1/customers').set(auth(amy)).send({ code: 'c1', name: 'Cafe' }).expect(201)).body.id;
  flour = (await api.post('/api/v1/items').set(auth(wes)).send({ sku: 'flr-25', name: 'Flour 25kg', uom: 'sack' }).expect(201)).body.id;
});
afterAll(shutdown);

const po = (qty: string, cost: string, over: object = {}) => ({ party_id: supp, order_date: '2026-11-01', lines: [{ item_id: flour, quantity: qty, unit_cost: cost }], ...over });
const so = (qty: string, price: string, over: object = {}) => ({ party_id: cust, order_date: '2026-11-01', lines: [{ item_id: flour, quantity: qty, unit_price: price }], ...over });
async function openOrder(path: string, body: object, tok = wes) {
  const d = (await api.post(`/api/v1/${path}`).set(auth(tok)).send(body).expect(201)).body;
  return (await api.post(`/api/v1/${path}/${d.id}/approve`).set(auth(tok)).expect(200)).body;
}
const receive = (id: string, lineId: string, quantity: string, date = '2026-11-05', tok = wes) =>
  api.post(`/api/v1/purchase-orders/${id}/receive`).set(auth(tok)).send({ date, lines: [{ line_id: lineId, quantity }] });
const deliver = (id: string, lineId: string, quantity: string, date = '2026-11-06', tok = wes) =>
  api.post(`/api/v1/sales-orders/${id}/deliver`).set(auth(tok)).send({ date, lines: [{ line_id: lineId, quantity }] });
const item = async () => ((await api.get('/api/v1/items').set(auth(amy)).expect(200)).body as Record<string, string>[]).find((i) => i.id === flour)!;
const valuation = async (asOf = '2026-12-31') => (await api.get('/api/v1/reports/stock-valuation').query({ as_of: asOf }).set(auth(amy)).expect(200)).body;
const bal = async (code: string) => {
  const r = ((await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(amy))).body.rows as { code: string; debit: string; credit: string }[]).find((x) => x.code === code);
  return r ? `${r.debit}/${r.credit}` : 'none';
};

describe('items', () => {
  it('creates items with zero stock and keeps SKUs unique', async () => {
    const i = await item();
    expect(i.sku).toBe('FLR-25');
    expect(i.qty_on_hand).toBe('0.0000');
    expect((await api.post('/api/v1/items').set(auth(wes)).send({ sku: 'FLR-25', name: 'Dup' })).status).toBe(409);
    expect((await api.post('/api/v1/items').set(auth(wes)).send({ sku: 'bad sku!', name: 'x' })).status).toBe(422);
  });
});

describe('purchase orders and receiving', () => {
  it('numbers on approval, receives in parts, values stock and posts to the ledger', async () => {
    const o = await openOrder('purchase-orders', po('100', '50.00'));
    expect(o.no).toBe('1');
    expect(o.total).toBe('5000.0000');
    const r1 = (await receive(o.id, o.lines[0].id, '40').expect(200)).body;
    expect(r1.order.status).toBe('open');
    expect((await item()).qty_on_hand).toBe('40.0000');
    expect((await item()).value_on_hand).toBe('2000.0000');
    expect(await bal('1200')).toBe('2000.0000/0.0000');
    expect(await bal('2050')).toBe('0.0000/2000.0000');
    const r2 = (await receive(o.id, o.lines[0].id, '60').expect(200)).body;
    expect(r2.order.status).toBe('closed');
    expect((await item()).value_on_hand).toBe('5000.0000');
  });

  it('refuses over-receipt, a draft order, a cancelled order and unknown lines', async () => {
    const d = (await api.post('/api/v1/purchase-orders').set(auth(wes)).send(po('10', '5')).expect(201)).body;
    expect((await receive(d.id, d.lines[0].id, '1')).status).toBe(409);
    const o = await openOrder('purchase-orders', po('10', '5'));
    const over = await receive(o.id, o.lines[0].id, '10.0001');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('over_fulfilment');
    expect((await receive(o.id, '00000000-0000-4000-8000-000000000000', '1')).status).toBe(422);
    await api.post(`/api/v1/purchase-orders/${o.id}/cancel`).set(auth(wes)).expect(200);
    expect((await receive(o.id, o.lines[0].id, '1')).status).toBe(409);
  });

  it('an order with receipts cannot be cancelled, and a draft can be edited and deleted', async () => {
    const o = await openOrder('purchase-orders', po('10', '5'));
    await receive(o.id, o.lines[0].id, '1').expect(200);
    expect((await api.post(`/api/v1/purchase-orders/${o.id}/cancel`).set(auth(wes))).status).toBe(409);
    const d = (await api.post('/api/v1/purchase-orders').set(auth(wes)).send(po('10', '5')).expect(201)).body;
    const e = (await api.put(`/api/v1/purchase-orders/${d.id}`).set(auth(wes)).send(po('20', '5', { reference: 'X' })).expect(200)).body;
    expect(e.total).toBe('100.0000');
    await api.delete(`/api/v1/purchase-orders/${d.id}`).set(auth(wes)).expect(200);
    expect((await api.put(`/api/v1/purchase-orders/${o.id}`).set(auth(wes)).send(po('1', '1'))).status).toBe(409);
  });

  it('numbers purchase and sales orders separately without gaps', async () => {
    expect((await openOrder('purchase-orders', po('1', '1'))).no).toBe('1');
    expect((await openOrder('purchase-orders', po('1', '1'))).no).toBe('2');
    expect((await openOrder('sales-orders', so('1', '1'))).no).toBe('1');
  });

  it('rejects the wrong party kind, inactive items and bad numbers', async () => {
    expect((await api.post('/api/v1/purchase-orders').set(auth(wes)).send(po('1', '1', { party_id: cust }))).status).toBe(422);
    expect((await api.post('/api/v1/sales-orders').set(auth(wes)).send(so('1', '1', { party_id: supp }))).status).toBe(422);
    await api.patch(`/api/v1/items/${flour}`).set(auth(wes)).send({ is_active: false }).expect(200);
    expect((await api.post('/api/v1/purchase-orders').set(auth(wes)).send(po('1', '1'))).status).toBe(422);
    expect((await api.post('/api/v1/purchase-orders').set(auth(wes)).send(po('0', '1'))).status).toBe(422);
    expect((await api.post('/api/v1/purchase-orders').set(auth(wes)).send(po('1.00001', '1'))).status).toBe(422);
  });
});

describe('costing and delivery', () => {
  async function stocked() {
    const a = await openOrder('purchase-orders', po('10', '100.00'));
    await receive(a.id, a.lines[0].id, '10', '2026-11-02').expect(200);
    const b = await openOrder('purchase-orders', po('10', '120.00'));
    await receive(b.id, b.lines[0].id, '10', '2026-11-03').expect(200);
  }

  it('costs issues at the moving average and books cost of goods sold', async () => {
    await stocked(); // 20 units, value 2200, average 110
    expect((await item()).avg_cost).toBe('110.0000');
    const s = await openOrder('sales-orders', so('5', '200.00'));
    const d = (await deliver(s.id, s.lines[0].id, '5').expect(200)).body;
    expect(d.order.status).toBe('closed');
    const i = await item();
    expect(i.qty_on_hand).toBe('15.0000');
    expect(i.value_on_hand).toBe('1650.0000');
    expect(await bal('5000')).toBe('550.0000/0.0000');
    expect(await bal('1200')).toBe('1650.0000/0.0000');
  });

  it('the last unit out takes the remaining value, so no residue is stranded', async () => {
    const a = await openOrder('purchase-orders', po('3', '10.00'));
    await receive(a.id, a.lines[0].id, '3').expect(200); // value 30.00
    const s = await openOrder('sales-orders', so('3', '20'));
    await deliver(s.id, s.lines[0].id, '1').expect(200); // 10.00
    await deliver(s.id, s.lines[0].id, '1').expect(200); // 10.00
    await deliver(s.id, s.lines[0].id, '1').expect(200); // 10.00
    const i = await item();
    expect(i.qty_on_hand).toBe('0.0000');
    expect(i.value_on_hand).toBe('0.0000');
  });

  it('thirds of an awkward value still add up to the whole', async () => {
    const a = await openOrder('purchase-orders', po('3', '3.3333'));
    await receive(a.id, a.lines[0].id, '3').expect(200); // 9.9999 -> 10.00 at the cent
    const s = await openOrder('sales-orders', so('3', '20'));
    for (let n = 0; n < 3; n += 1) await deliver(s.id, s.lines[0].id, '1').expect(200);
    expect((await item()).value_on_hand).toBe('0.0000');
    expect((await valuation()).reconciles).toBe(true);
  });

  it('refuses to deliver more than is on hand, leaving everything unchanged', async () => {
    await stocked();
    const s = await openOrder('sales-orders', so('25', '200'));
    const r = await deliver(s.id, s.lines[0].id, '25');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('insufficient_stock');
    expect((await item()).qty_on_hand).toBe('20.0000');
    expect((await api.get(`/api/v1/sales-orders/${s.id}`).set(auth(wes))).body.status).toBe('open');
  });

  it('two simultaneous deliveries cannot oversell', async () => {
    const a = await openOrder('purchase-orders', po('10', '10'));
    await receive(a.id, a.lines[0].id, '10').expect(200);
    const s1 = await openOrder('sales-orders', so('8', '20'));
    const s2 = await openOrder('sales-orders', so('8', '20'));
    const res = await Promise.all([deliver(s1.id, s1.lines[0].id, '8'), deliver(s2.id, s2.lines[0].id, '8')]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await item()).qty_on_hand).toBe('2.0000');
  });

  it('the stock card shows every movement with a running balance', async () => {
    await stocked();
    const s = await openOrder('sales-orders', so('5', '200'));
    await deliver(s.id, s.lines[0].id, '5').expect(200);
    const c = (await api.get(`/api/v1/items/${flour}/stock-card`).set(auth(amy)).expect(200)).body;
    expect(c.movements).toHaveLength(3);
    expect(c.movements[0]).toMatchObject({ kind: 'issue', qty: '-5.0000', run_qty: '15.0000', run_value: '1650.0000' });
  });
});

describe('adjustments and the ledger', () => {
  it('an increase needs a cost; both directions post to the adjustment account', async () => {
    expect((await api.post('/api/v1/stock-adjustments').set(auth(wes)).send({ item_id: flour, date: '2026-11-02', direction: 'in', quantity: '5', reason: 'Found stock' })).status).toBe(422);
    await api.post('/api/v1/stock-adjustments').set(auth(wes)).send({ item_id: flour, date: '2026-11-02', direction: 'in', quantity: '10', unit_cost: '20', reason: 'Opening count' }).expect(201);
    expect(await bal('5100')).toBe('0.0000/200.0000');
    await api.post('/api/v1/stock-adjustments').set(auth(wes)).send({ item_id: flour, date: '2026-11-03', direction: 'out', quantity: '2', reason: 'Spoiled' }).expect(201);
    expect(await bal('5100')).toBe('0.0000/160.0000');
    expect((await item()).qty_on_hand).toBe('8.0000');
    expect((await api.post('/api/v1/stock-adjustments').set(auth(wes)).send({ item_id: flour, date: '2026-11-03', direction: 'out', quantity: '50', reason: 'Too many' })).status).toBe(409);
    expect((await api.post('/api/v1/stock-adjustments').set(auth(wes)).send({ item_id: flour, date: '2026-11-03', direction: 'out', quantity: '1', reason: 'x' })).status).toBe(422);
  });

  it('valuation agrees with the inventory account (variance zero) and flags a manual entry', async () => {
    const a = await openOrder('purchase-orders', po('10', '10'));
    await receive(a.id, a.lines[0].id, '10').expect(200);
    let v = await valuation();
    expect(v.total_value).toBe('100.0000');
    expect(v.variance).toBe('0.0000');
    expect(v.reconciles).toBe(true);
    await api.post('/api/v1/journal-entries').set(auth(amy)).send({ entry_date: '2026-11-10', description: 'manual', lines: [{ account_id: acc['1200'], debit: '5.00', credit: '0' }, { account_id: acc['3000'], debit: '0', credit: '5.00' }] }).expect(201);
    v = await valuation();
    expect(v.variance).toBe('5.0000');
    expect(v.reconciles).toBe(false);
  });

  it('valuation as of an earlier date ignores later movements', async () => {
    const a = await openOrder('purchase-orders', po('10', '10'));
    await receive(a.id, a.lines[0].id, '10', '2026-11-20').expect(200);
    expect((await valuation('2026-11-10')).rows).toHaveLength(0);
    expect((await valuation('2026-11-30')).rows).toHaveLength(1);
    expect((await valuation('2026-11-10')).reconciles).toBe(true);
  });

  it('a stock entry cannot be reversed by hand, and stock rows are append-only', async () => {
    const a = await openOrder('purchase-orders', po('10', '10'));
    const r = (await receive(a.id, a.lines[0].id, '10').expect(200)).body;
    expect((await api.post(`/api/v1/journal-entries/${r.journal_entry_id}/reverse`).set(auth(amy)).send({})).status).toBe(409);
    await expect(owner.query('DELETE FROM stock_movements')).rejects.toThrow(/append-only/);
    await expect(owner.query("UPDATE item_stock SET qty = -1")).rejects.toThrow();
  });
});

describe('access', () => {
  it('a viewer reads but cannot write; a clerk cannot post to the ledger; no token is 401', async () => {
    const o = await openOrder('purchase-orders', po('10', '5'));
    expect((await api.get('/api/v1/items').set(auth(vic))).status).toBe(200);
    expect((await api.get(`/api/v1/purchase-orders/${o.id}`).set(auth(vic))).status).toBe(200);
    expect((await api.post('/api/v1/items').set(auth(vic)).send({ sku: 'x', name: 'x' })).status).toBe(403);
    expect((await receive(o.id, o.lines[0].id, '1', '2026-11-05', vic)).status).toBe(403);
    expect((await api.post('/api/v1/purchase-orders').set(auth(vic)).send(po('1', '1'))).status).toBe(403);
    expect((await api.post('/api/v1/journal-entries').set(auth(wes)).send({ entry_date: '2026-11-01', description: 'x', lines: [] })).status).toBe(403);
    expect((await api.get('/api/v1/items')).status).toBe(401);
    expect((await api.post('/api/v1/stock-adjustments').send({})).status).toBe(401);
  });

  it('a workspace without the supply chain module is refused', async () => {
    const t2 = await seedTenant('fin-only', { zed: ['Accountant', 'WarehouseClerk'] });
    const zed = await tokenFor(api, t2, 'zed');
    const r = await api.get('/api/v1/items').set(auth(zed));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('module_disabled');
  });

  it('another tenant sees none of it', async () => {
    const o = await openOrder('purchase-orders', po('10', '5'));
    const t2 = await seedTenant('other-sc', { zed: ['WarehouseClerk'] }, false, { modules: MODS });
    const zed = await tokenFor(api, t2, 'zed');
    expect((await api.get('/api/v1/items').set(auth(zed))).body).toEqual([]);
    expect((await api.get(`/api/v1/purchase-orders/${o.id}`).set(auth(zed))).status).toBe(404);
    expect((await receive(o.id, o.lines[0].id, '1', '2026-11-05', zed)).status).toBe(404);
    expect((await api.get(`/api/v1/items/${flour}/stock-card`).set(auth(zed))).status).toBe(404);
    expect((await api.post('/api/v1/purchase-orders').set(auth(zed)).send(po('1', '1'))).status).toBe(422);
  });
});
