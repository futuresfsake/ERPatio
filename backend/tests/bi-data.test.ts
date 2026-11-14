import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cached, cacheSize, clearCache } from '../src/lib/cache.js';
import { accountIds, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let adm: string;
let fin: string;
let vic: string;
let wes: string;
let cust: string;
let supp: string;
let item: string;
const today = new Date().toISOString().slice(0, 10);
const MODS = ['finance', 'supply_chain', 'bi'];

beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  clearCache();
  t = await seedTenant('bi-co', { adm: ['TenantAdmin'], fin: ['FinanceManager'], vic: ['Viewer'], wes: ['WarehouseClerk'] }, false, { modules: MODS });
  [adm, fin, vic, wes] = await Promise.all([tokenFor(api, t, 'adm'), tokenFor(api, t, 'fin'), tokenFor(api, t, 'vic'), tokenFor(api, t, 'wes')]);
  acc = await accountIds(t.tenantId);
  cust = (await api.post('/api/v1/customers').set(auth(fin)).send({ code: 'c1', name: 'Cafe' }).expect(201)).body.id;
  supp = (await api.post('/api/v1/suppliers').set(auth(fin)).send({ code: 's1', name: 'Mills' }).expect(201)).body.id;
  item = (await api.post('/api/v1/items').set(auth(wes)).send({ sku: 'flr', name: 'Flour' }).expect(201)).body.id;
});
afterAll(shutdown);

const je = (date: string, dr: string, cr: string, amount: string) =>
  api.post('/api/v1/journal-entries').set(auth(fin)).send({ entry_date: date, description: 'x', lines: [{ account_id: acc[dr], debit: amount, credit: '0' }, { account_id: acc[cr], debit: '0', credit: amount }] }).expect(201);
const exec = async (tok = vic) => (await api.get('/api/v1/dashboards/executive').set(auth(tok)).expect(200)).body;
async function postInvoice(price: string, taxed = false) {
  const codes = (await api.get('/api/v1/tax-codes').set(auth(fin))).body as { id: string; code: string }[];
  const d = (await api.post('/api/v1/invoices').set(auth(fin)).send({ party_id: cust, doc_date: today, lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: price, tax_code_id: taxed ? codes.find((c) => c.code === 'OUT12')!.id : null }] }).expect(201)).body;
  return (await api.post(`/api/v1/invoices/${d.id}/post`).set(auth(fin)).expect(200)).body;
}

describe('executive dashboard', () => {
  it('shows cash, receivables, payables, profit and a six-month trend, from the ledger', async () => {
    await je(today, '1010', '3000', '50000.00');
    await postInvoice('1000.00', true); // 1120 receivable, 1000 revenue
    await je(today, '6000', '1010', '300.00');
    const d = await exec();
    expect(d.cash.balance).toBe('49700.0000');
    expect(d.receivables).toMatchObject({ open: '1120.0000', overdue: '0.0000', customers_owing: 1 });
    expect(d.year).toMatchObject({ revenue: '1000.0000', expenses: '300.0000', net_income: '700.0000' });
    expect(d.month.net_income).toBe('700.0000');
    expect(d.months).toHaveLength(6);
    expect(d.months[5]).toEqual({ month: today.slice(0, 7), revenue: '1000.0000', expenses: '300.0000' });
    expect(d.inventory.value).toBe('0.0000');
  });

  it('a posting shows up on the very next request even though dashboards are cached', async () => {
    expect((await exec()).year.revenue).toBe('0.0000');
    await postInvoice('500.00');
    expect((await exec()).year.revenue).toBe('500.0000');
    const before = cacheSize();
    await exec();
    expect(cacheSize()).toBe(before); // served from the cache
  });

  it('leaves out modules the workspace has not subscribed to and never mixes tenants', async () => {
    const t2 = await seedTenant('bi-fin-only', { zed: ['Viewer'] }, false, { modules: ['finance', 'bi'] });
    const zed = await tokenFor(api, t2, 'zed');
    expect((await exec(zed)).inventory).toBeUndefined();
    await postInvoice('777.00');
    expect((await exec(zed)).year.revenue).toBe('0.0000');
    expect((await exec()).year.revenue).toBe('777.0000');
  });

  it('needs dashboard access and the bi module', async () => {
    expect((await api.get('/api/v1/dashboards/executive').set(auth(wes))).status).toBe(403);
    expect((await api.get('/api/v1/dashboards/executive')).status).toBe(401);
    const t2 = await seedTenant('no-bi', { zed: ['Viewer'] }, false, { modules: ['finance'] });
    const r = await api.get('/api/v1/dashboards/executive').set(auth(await tokenFor(api, t2, 'zed')));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('module_disabled');
  });
});

describe('cache', () => {
  it('reuses a value for the same version, recomputes when the version changes, and keeps tenants apart', async () => {
    let calls = 0;
    const compute = async () => { calls += 1; return calls; };
    expect(await cached('a', 'k', 60_000, '1', compute)).toBe(1);
    expect(await cached('a', 'k', 60_000, '1', compute)).toBe(1);
    expect(await cached('a', 'k', 60_000, '2', compute)).toBe(2);
    expect(await cached('b', 'k', 60_000, '2', compute)).toBe(3);
    expect(await cached('c', 'k', 1, '1', compute)).toBe(4);
    await new Promise((r) => setTimeout(r, 15));
    expect(await cached('c', 'k', 1, '1', compute)).toBe(5); // the time limit passed
  });
});

describe('inventory dashboard and profitability', () => {
  async function stockAndSell() {
    const po = (await api.post('/api/v1/purchase-orders').set(auth(wes)).send({ party_id: supp, order_date: today, lines: [{ item_id: item, quantity: '100', unit_cost: '10.00' }] }).expect(201)).body;
    const o = (await api.post(`/api/v1/purchase-orders/${po.id}/approve`).set(auth(wes)).expect(200)).body;
    await api.post(`/api/v1/purchase-orders/${o.id}/receive`).set(auth(wes)).send({ date: today, lines: [{ line_id: o.lines[0].id, quantity: '100' }] }).expect(200);
    const so = (await api.post('/api/v1/sales-orders').set(auth(wes)).send({ party_id: cust, order_date: today, lines: [{ item_id: item, quantity: '30', unit_price: '25.00' }] }).expect(201)).body;
    const s = (await api.post(`/api/v1/sales-orders/${so.id}/approve`).set(auth(wes)).expect(200)).body;
    await api.post(`/api/v1/sales-orders/${s.id}/deliver`).set(auth(wes)).send({ date: today, lines: [{ line_id: s.lines[0].id, quantity: '30' }] }).expect(200);
    return s;
  }

  it('shows stock value, reorder warnings, open orders and movers', async () => {
    await stockAndSell();
    await api.patch(`/api/v1/items/${item}`).set(auth(wes)).send({ reorder_level: '80' }).expect(200);
    const d = (await api.get('/api/v1/dashboards/inventory').set(auth(vic)).expect(200)).body;
    expect(d.total_value).toBe('700.0000');
    expect(d.reconciles).toBe(true);
    expect(d.items_below_reorder).toBe(1);
    expect(d.top_by_value[0]).toMatchObject({ sku: 'FLR', value: '700.0000' });
    expect(d.fast_movers[0]).toMatchObject({ sku: 'FLR', qty: '30.0000' });
    expect(d.no_movement_90_days).toHaveLength(0);
  });

  it('margin by customer (invoices less credit notes) and by item (sales against cost)', async () => {
    const s = await stockAndSell();
    const inv = (await api.post(`/api/v1/sales-orders/${s.id}/invoice`).set(auth(fin)).send({}).expect(201)).body;
    await api.post(`/api/v1/invoices/${inv.id}/post`).set(auth(fin)).expect(200);
    const cn = (await api.post('/api/v1/credit-notes').set(auth(fin)).send({ party_id: cust, doc_date: today, lines: [{ description: 'x', account_id: acc['4000'], quantity: '1', unit_price: '50.00' }] }).expect(201)).body;
    await api.post(`/api/v1/credit-notes/${cn.id}/post`).set(auth(fin)).expect(200);
    const r = (await api.get('/api/v1/reports/profitability').query({ from: `${today.slice(0, 4)}-01-01`, to: today }).set(auth(vic)).expect(200)).body;
    expect(r.customers[0]).toMatchObject({ code: 'C1', invoiced: '750.0000', credited: '50.0000', net_sales: '700.0000' });
    expect(r.items[0]).toMatchObject({ sku: 'FLR', qty: '30.0000', sales: '750.0000', cost: '300.0000', margin: '450.0000', margin_pct: 60 });
    expect((await api.get('/api/v1/reports/profitability').query({ from: today, to: '2020-01-01' }).set(auth(vic))).status).toBe(422);
  });
});

describe('import', () => {
  const imp = (entity: string, rows: object[], tok = fin, mode = 'commit', extra: object = {}) => api.post(`/api/v1/imports/${entity}/${mode}`).set(auth(tok)).send({ rows, ...extra });
  const count = async (sql: string) => Number((await owner.query(sql, [t.tenantId])).rows[0].n);

  it('previews problems without writing anything, then imports good rows', async () => {
    const rows = [{ code: 'k1', name: 'Kopi Corner', email: 'k@example.test', terms_days: '15', tin: '111-222' }, { code: 'bad code', name: 'Bad' }, { code: 'k3', name: '' }, { code: 'K1', name: 'dup in file' }];
    const p = (await imp('customers', rows, fin, 'preview').expect(200)).body;
    expect(p).toMatchObject({ rows: 4, valid: 1 });
    expect(p.errors.map((e: { row: number }) => e.row).sort()).toEqual([2, 3, 4]);
    expect(await count("SELECT count(*) AS n FROM parties WHERE tenant_id = $1 AND kind = 'customer' AND code <> 'C1'")).toBe(0);
    const ok = (await imp('customers', [rows[0]!, { code: 'k2', name: 'Second' }]).expect(201)).body;
    expect(ok).toMatchObject({ added: 2, skipped: 0 });
    const raw = (await owner.query("SELECT tin_enc FROM parties WHERE tenant_id = $1 AND code = 'K1'", [t.tenantId])).rows[0].tin_enc as string;
    expect(raw.startsWith('enc1.')).toBe(true);
  });

  it('one bad row means nothing is imported, and says which', async () => {
    const r = await imp('items', [{ sku: 'a1', name: 'Good' }, { sku: 'a2', name: 'Good too' }, { sku: 'bad sku!', name: 'Bad' }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('import_errors');
    expect(r.body.error.details[0].field).toBe('row 3');
    expect(await count("SELECT count(*) AS n FROM items WHERE tenant_id = $1 AND sku IN ('A1', 'A2')")).toBe(0);
  });

  it('existing codes are skipped or refused, case does not matter, and items get a stock row', async () => {
    await imp('items', [{ sku: 'x1', name: 'One', uom: 'box', reorder_level: '5' }, { sku: 'x2', name: 'Two' }]).expect(201);
    expect(await count('SELECT count(*) AS n FROM item_stock WHERE tenant_id = $1')).toBe(3);
    const again = (await imp('items', [{ sku: 'X1', name: 'One again' }, { sku: 'x3', name: 'Three' }]).expect(201)).body;
    expect(again).toMatchObject({ added: 1, skipped: 1 });
    expect((await imp('items', [{ sku: 'x1', name: 'One' }], fin, 'commit', { on_duplicate: 'fail' })).status).toBe(409);
    expect((await api.get('/api/v1/items').set(auth(wes))).body.find((i: { sku: string }) => i.sku === 'X1')).toMatchObject({ uom: 'box', reorder_level: '5.0000' });
  });

  it('imports accounts (types checked) and suppliers', async () => {
    await imp('accounts', [{ code: '7000', name: 'Marketing', type: 'Expense' }]).expect(201);
    expect((await imp('accounts', [{ code: '7100', name: 'Odd', type: 'banana' }])).status).toBe(422);
    expect((await imp('accounts', [{ code: '1010', name: 'Dup', type: 'asset' }]).expect(201)).body.skipped).toBe(1);
    expect((await imp('suppliers', [{ code: 'ms', name: 'Metro Supply' }]).expect(201)).body.added).toBe(1);
    expect((await api.get('/api/v1/suppliers').set(auth(fin))).body.map((s: { code: string }) => s.code)).toContain('MS');
  });

  it('refuses empty, oversized and malformed input and people without import permission', async () => {
    expect((await imp('items', [])).status).toBe(422);
    expect((await imp('items', Array.from({ length: 5001 }, (_, i) => ({ sku: `s${i}`, name: 'n' })))).status).toBe(422);
    expect((await imp('items', [{ sku: { $ne: 1 }, name: 'n' }])).status).toBe(422);
    expect((await imp('widgets', [{ a: 'b' }])).status).toBe(422);
    expect((await imp('items', [{ sku: 'ok', name: 'n' }], vic)).status).toBe(403);
    expect((await api.post('/api/v1/imports/items/commit').send({ rows: [] })).status).toBe(401);
  });

  it('accepts a few thousand rows in one go', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ sku: `bulk${i}`, name: `Item ${i}` }));
    expect((await imp('items', rows).expect(201)).body.added).toBe(3000);
  });
});

describe('full export', () => {
  it('downloads the workspace without secrets, only to someone who may, and not twice in a row', async () => {
    await je(today, '1010', '3000', '123.00');
    const r = await api.get('/api/v1/export').set(auth(adm)).buffer(true).parse((res, cb) => { let s = ''; res.on('data', (d: Buffer) => (s += d.toString())); res.on('end', () => cb(null, s)); });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('attachment');
    const body = JSON.parse(r.body as string);
    expect(body.workspace.slug).toBe('bi-co');
    expect(body.tables.journal_entries).toHaveLength(1);
    expect(body.tables.accounts.length).toBeGreaterThan(10);
    expect(body.tables.users.map((u: { email: string }) => u.email)).toContain('adm@bi-co.test');
    const text = r.body as string;
    expect(text).not.toContain('password_hash');
    expect(text).not.toMatch(/_enc"/);
    expect(text).not.toContain('argon2');
    expect((await api.get('/api/v1/export').set(auth(adm))).status).toBe(429);
    expect((await api.get('/api/v1/export').set(auth(fin))).status).toBe(403);
    expect((await owner.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'data.exported'", [t.tenantId])).rowCount).toBe(1);
  });

  it('contains only this workspace', async () => {
    const t2 = await seedTenant('other-exp', { zed: ['TenantAdmin'] }, false, { modules: MODS });
    const zed = await tokenFor(api, t2, 'zed');
    await api.post('/api/v1/customers').set(auth(zed)).send({ code: 'secretco', name: 'Other Tenant Only' }).expect(201);
    const r = await api.get('/api/v1/export').set(auth(adm)).buffer(true).parse((res, cb) => { let s = ''; res.on('data', (d: Buffer) => (s += d.toString())); res.on('end', () => cb(null, s)); });
    expect(r.body as string).not.toContain('Other Tenant Only');
  });
});
