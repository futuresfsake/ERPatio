import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let pm: string;
let wes: string;
let vic: string;
let supp: string;
let flour: string;
let sugar: string;
let bread: string;

const MODS = ['finance', 'supply_chain', 'production'];
beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('pr-co', { pm: ['ProductionManager'], wes: ['WarehouseClerk'], vic: ['Viewer'], amy: ['Accountant'] }, false, { modules: MODS });
  [pm, wes, vic] = await Promise.all([tokenFor(api, t, 'pm'), tokenFor(api, t, 'wes'), tokenFor(api, t, 'vic')]);
  const amy = await tokenFor(api, t, 'amy');
  supp = (await api.post('/api/v1/suppliers').set(auth(amy)).send({ code: 's1', name: 'Mills' }).expect(201)).body.id;
  const mk = async (sku: string) => (await api.post('/api/v1/items').set(auth(wes)).send({ sku, name: sku }).expect(201)).body.id as string;
  [flour, sugar, bread] = [await mk('FLR'), await mk('SGR'), await mk('BRD')];
  // stock: 100 flour @ 10, 50 sugar @ 20
  const d = (await api.post('/api/v1/purchase-orders').set(auth(wes)).send({ party_id: supp, order_date: '2026-11-01', lines: [{ item_id: flour, quantity: '100', unit_cost: '10.00' }, { item_id: sugar, quantity: '50', unit_cost: '20.00' }] }).expect(201)).body;
  const o = (await api.post(`/api/v1/purchase-orders/${d.id}/approve`).set(auth(wes)).expect(200)).body;
  await api.post(`/api/v1/purchase-orders/${o.id}/receive`).set(auth(wes)).send({ date: '2026-11-02', lines: o.lines.map((l: { id: string; quantity: string }) => ({ line_id: l.id, quantity: l.quantity })) }).expect(200);
});
afterAll(shutdown);

// 10 loaves need 4 flour and 1 sugar
const bom = (over: object = {}) => ({ item_id: bread, output_qty: '10', lines: [{ item_id: flour, quantity: '4' }, { item_id: sugar, quantity: '1' }], ...over });
const wo = async (qty = '20', date = '2026-11-03') => {
  await api.post('/api/v1/boms').set(auth(pm)).send(bom()).expect(201);
  const d = (await api.post('/api/v1/work-orders').set(auth(pm)).send({ item_id: bread, quantity: qty, planned_date: date }).expect(201)).body;
  return (await api.post(`/api/v1/work-orders/${d.id}/release`).set(auth(pm)).expect(200)).body;
};
const issue = (id: string, body: object = { date: '2026-11-04' }) => api.post(`/api/v1/work-orders/${id}/issue`).set(auth(pm)).send(body);
const complete = (id: string, quantity: string, conversion_cost = '0', date = '2026-11-05') => api.post(`/api/v1/work-orders/${id}/complete`).set(auth(pm)).send({ date, quantity, conversion_cost });
const item = async (id: string) => ((await api.get('/api/v1/items').set(auth(pm)).expect(200)).body as Record<string, string>[]).find((i) => i.id === id)!;
const bal = async (code: string) => {
  const amy = await tokenFor(api, t, 'amy');
  const r = ((await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(amy))).body.rows as { code: string; debit: string; credit: string }[]).find((x) => x.code === code);
  return r ? `${r.debit}/${r.credit}` : 'none';
};
const wip = async () => (await api.get('/api/v1/reports/wip').query({ as_of: '2026-12-31' }).set(auth(pm)).expect(200)).body;

describe('bills of materials', () => {
  it('versions: a new save becomes the active one and estimates the cost', async () => {
    const a = (await api.post('/api/v1/boms').set(auth(pm)).send(bom()).expect(201)).body;
    expect(a.version).toBe(1);
    expect(a.estimated_unit_cost).toBe('6.0000'); // (4 x 10 + 1 x 20) / 10
    const b = (await api.post('/api/v1/boms').set(auth(pm)).send(bom({ lines: [{ item_id: flour, quantity: '5' }] })).expect(201)).body;
    expect(b.version).toBe(2);
    const list = (await api.get('/api/v1/boms').query({ item_id: bread }).set(auth(pm)).expect(200)).body as { version: number; is_active: boolean }[];
    expect(list.map((x) => [x.version, x.is_active])).toEqual([[2, true], [1, false]]);
  });

  it('refuses a component that is the product, a loop, duplicates, unknown items and a zero quantity', async () => {
    expect((await api.post('/api/v1/boms').set(auth(pm)).send(bom({ lines: [{ item_id: bread, quantity: '1' }] }))).status).toBe(422);
    await api.post('/api/v1/boms').set(auth(pm)).send(bom()).expect(201);
    // flour made from bread would loop: bread -> flour -> bread
    const loop = await api.post('/api/v1/boms').set(auth(pm)).send({ item_id: flour, output_qty: '1', lines: [{ item_id: bread, quantity: '1' }] });
    expect(loop.status).toBe(422);
    expect(loop.body.error.code).toBe('circular_bom');
    expect((await api.post('/api/v1/boms').set(auth(pm)).send(bom({ lines: [{ item_id: flour, quantity: '1' }, { item_id: flour, quantity: '2' }] }))).status).toBe(422);
    expect((await api.post('/api/v1/boms').set(auth(pm)).send(bom({ lines: [{ item_id: '00000000-0000-4000-8000-000000000000', quantity: '1' }] }))).status).toBe(422);
    expect((await api.post('/api/v1/boms').set(auth(pm)).send(bom({ lines: [{ item_id: flour, quantity: '0' }] }))).status).toBe(422);
    await expect(owner.query('DELETE FROM bom_lines')).rejects.toThrow();
  });
});

describe('work orders', () => {
  it('releases with a number and a frozen component list scaled from the bill', async () => {
    const w = await wo('20');
    expect(w.no).toBe('1');
    expect(w.status).toBe('released');
    expect(w.components.map((k: { sku: string; required_qty: string }) => [k.sku, k.required_qty])).toEqual([['FLR', '8.0000'], ['SGR', '2.0000']]);
    await api.post('/api/v1/boms').set(auth(pm)).send(bom({ lines: [{ item_id: flour, quantity: '9' }] })).expect(201);
    expect((await api.get(`/api/v1/work-orders/${w.id}`).set(auth(pm))).body.components[0].required_qty).toBe('8.0000'); // snapshot unchanged
  });

  it('needs an active bill; drafts can be deleted; started orders cannot be cancelled', async () => {
    expect((await api.post('/api/v1/work-orders').set(auth(pm)).send({ item_id: bread, quantity: '1', planned_date: '2026-11-03' })).status).toBe(422);
    await api.post('/api/v1/boms').set(auth(pm)).send(bom()).expect(201);
    const d = (await api.post('/api/v1/work-orders').set(auth(pm)).send({ item_id: bread, quantity: '1', planned_date: '2026-11-03' }).expect(201)).body;
    await api.delete(`/api/v1/work-orders/${d.id}`).set(auth(pm)).expect(200);
    const w = await wo('10');
    await issue(w.id).expect(200);
    expect((await api.post(`/api/v1/work-orders/${w.id}/cancel`).set(auth(pm))).status).toBe(409);
    const w2 = await wo('10');
    await api.post(`/api/v1/work-orders/${w2.id}/cancel`).set(auth(pm)).expect(200);
    expect((await issue(w2.id)).status).toBe(409);
  });
});

describe('materials, output and cost', () => {
  it('issues what is required to work in progress at the average cost, and moves it to finished goods on completion', async () => {
    const w = await wo('20'); // needs 8 flour (80) and 2 sugar (40) = 120
    const r = (await issue(w.id).expect(200)).body;
    expect(r.order.wip).toBe('120.0000');
    expect(await bal('1210')).toBe('120.0000/0.0000');
    expect((await item(flour)).qty_on_hand).toBe('92.0000');
    expect((await issue(w.id)).status).toBe(409); // nothing left to issue
    const c = (await complete(w.id, '20', '30.00').expect(200)).body;
    expect(c.unit_cost).toBe('7.5000'); // (120 + 30) / 20
    expect(c.order.status).toBe('completed');
    expect(c.order.wip).toBe('0.0000');
    expect((await item(bread)).qty_on_hand).toBe('20.0000');
    expect((await item(bread)).value_on_hand).toBe('150.0000');
    expect(await bal('1210')).toBe('0.0000/0.0000');
    expect(await bal('5200')).toBe('0.0000/30.0000');
    expect(await bal('1200')).toBe('2030.0000/0.0000'); // raw 920 + 960 plus bread 150
  });

  it('partial output takes a proportionate share, the last batch takes the rest', async () => {
    const w = await wo('30');
    await issue(w.id).expect(200); // 12 flour (120) + 3 sugar (60) = 180
    const a = (await complete(w.id, '10').expect(200)).body;
    expect(a.order.wip).toBe('120.0000');
    expect(a.order.status).toBe('released');
    expect(a.unit_cost).toBe('6.0000');
    const b = (await complete(w.id, '20').expect(200)).body;
    expect(b.order.wip).toBe('0.0000');
    expect(b.order.status).toBe('completed');
    expect((await item(bread)).value_on_hand).toBe('180.0000');
  });

  it('thirds that do not divide evenly leave no residue in work in progress', async () => {
    await api.post('/api/v1/boms').set(auth(pm)).send(bom({ output_qty: '3', lines: [{ item_id: flour, quantity: '1' }] })).expect(201);
    const d = (await api.post('/api/v1/work-orders').set(auth(pm)).send({ item_id: bread, quantity: '3', planned_date: '2026-11-03' }).expect(201)).body;
    const w = (await api.post(`/api/v1/work-orders/${d.id}/release`).set(auth(pm)).expect(200)).body;
    await issue(w.id, { date: '2026-11-04', lines: [{ item_id: flour, quantity: '1' }] }).expect(200); // 10.00 in WIP
    for (const q of ['1', '1', '1']) await complete(w.id, q).expect(200);
    expect((await wip()).total_wip).toBe('0.0000');
    expect((await wip()).reconciles).toBe(true);
    expect((await item(bread)).value_on_hand).toBe('10.0000');
  });

  it('explicit lines can over-issue, shown as a usage variance; unknown and duplicate components are refused', async () => {
    const w = await wo('10'); // needs 4 flour, 1 sugar
    await issue(w.id, { date: '2026-11-04', lines: [{ item_id: flour, quantity: '5' }] }).expect(200);
    const k = (await api.get(`/api/v1/work-orders/${w.id}`).set(auth(pm))).body.components.find((x: { sku: string }) => x.sku === 'FLR');
    expect(k.variance_qty).toBe('1.0000');
    expect((await issue(w.id, { date: '2026-11-04', lines: [{ item_id: bread, quantity: '1' }] })).status).toBe(422);
    expect((await issue(w.id, { date: '2026-11-04', lines: [{ item_id: sugar, quantity: '1' }, { item_id: sugar, quantity: '1' }] })).status).toBe(422);
  });

  it('refuses output beyond the plan or before release, and issuing more than is in stock changes nothing', async () => {
    const w = await wo('10');
    expect((await complete(w.id, '10.0001')).status).toBe(422);
    await api.post('/api/v1/boms').set(auth(pm)).send(bom({ lines: [{ item_id: flour, quantity: '1000' }] })).expect(201);
    const big = (await api.post('/api/v1/work-orders').set(auth(pm)).send({ item_id: bread, quantity: '10', planned_date: '2026-11-03' }).expect(201)).body;
    const rel = (await api.post(`/api/v1/work-orders/${big.id}/release`).set(auth(pm)).expect(200)).body;
    const r = await issue(rel.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('insufficient_stock');
    expect((await item(flour)).qty_on_hand).toBe('100.0000');
    expect((await api.get(`/api/v1/work-orders/${rel.id}`).set(auth(pm))).body.wip).toBe('0.0000');
    const draft = (await api.post('/api/v1/work-orders').set(auth(pm)).send({ item_id: bread, quantity: '1', planned_date: '2026-11-03' }).expect(201)).body;
    expect((await complete(draft.id, '1')).status).toBe(409);
  });

  it('closing short writes the leftover work in progress to production variance', async () => {
    const w = await wo('20');
    await issue(w.id).expect(200); // 120
    await complete(w.id, '10', '5.00').expect(200); // takes 60
    const c = (await api.post(`/api/v1/work-orders/${w.id}/close`).set(auth(pm)).send({ date: '2026-11-10' }).expect(200)).body;
    expect(c.order.status).toBe('closed');
    expect(c.order.wip).toBe('0.0000');
    expect(await bal('5300')).toBe('60.0000/0.0000');
    expect(await bal('1210')).toBe('0.0000/0.0000');
    expect((await api.post(`/api/v1/journal-entries/${c.journal_entry_id}/reverse`).set(auth(pm)).send({})).status).toBe(403); // no journal access
    expect((await complete(w.id, '5')).status).toBe(409);
  });

  it('work in progress by order equals the ledger, and a manual entry shows as a difference', async () => {
    const a = await wo('20');
    await issue(a.id).expect(200);
    const b = await wo('10');
    await issue(b.id).expect(200);
    let r = await wip();
    expect(r.rows).toHaveLength(2);
    expect(r.total_wip).toBe('180.0000');
    expect(r.reconciles).toBe(true);
    const amy = await tokenFor(api, t, 'amy');
    const accts = (await api.get('/api/v1/accounts').set(auth(amy))).body as { id: string; code: string }[];
    const id = (c: string) => accts.find((x) => x.code === c)!.id;
    await api.post('/api/v1/journal-entries').set(auth(amy)).send({ entry_date: '2026-11-10', description: 'm', lines: [{ account_id: id('1210'), debit: '7.00', credit: '0' }, { account_id: id('3000'), debit: '0', credit: '7.00' }] }).expect(201);
    r = await wip();
    expect(r.reconciles).toBe(false);
    expect(r.variance).toBe('7.0000');
  });

  it('stock still equals the ledger after production', async () => {
    const w = await wo('20');
    await issue(w.id).expect(200);
    await complete(w.id, '20', '30.00').expect(200);
    const v = (await api.get('/api/v1/reports/stock-valuation').query({ as_of: '2026-12-31' }).set(auth(pm)).expect(200)).body;
    expect(v.reconciles).toBe(true);
    expect(v.total_value).toBe('2030.0000'); // flour 92 x 10 + sugar 48 x 20 + bread 150
  });
});

describe('access', () => {
  it('only production roles write; a viewer without production read is refused; a workspace without the module too', async () => {
    expect((await api.post('/api/v1/boms').set(auth(vic)).send(bom())).status).toBe(403);
    expect((await api.get('/api/v1/work-orders').set(auth(vic))).status).toBe(200);
    expect((await api.post('/api/v1/boms').set(auth(wes)).send(bom())).status).toBe(403);
    expect((await api.get('/api/v1/work-orders')).status).toBe(401);
    const t2 = await seedTenant('no-prod', { zed: ['ProductionManager'] }, false, { modules: ['finance', 'supply_chain'] });
    const r = await api.get('/api/v1/boms').set(auth(await tokenFor(api, t2, 'zed')));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('module_disabled');
  });

  it('another tenant sees none of it', async () => {
    const w = await wo('10');
    const t2 = await seedTenant('other-pr', { zed: ['ProductionManager'] }, false, { modules: MODS });
    const zed = await tokenFor(api, t2, 'zed');
    expect((await api.get(`/api/v1/work-orders/${w.id}`).set(auth(zed))).status).toBe(404);
    expect((await issue(w.id)).status).toBe(200);
    expect((await api.post(`/api/v1/work-orders/${w.id}/issue`).set(auth(zed)).send({ date: '2026-11-04' })).status).toBe(404);
    expect((await api.get('/api/v1/boms').set(auth(zed))).body).toEqual([]);
  });
});
