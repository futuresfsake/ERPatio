/**
 * Supply chain: items, the stock ledger, purchase and sales orders, moving-average costing.
 * Every stock movement is valued in the same transaction by one balanced journal entry, so inventory in the
 * stock ledger and inventory in the general ledger cannot drift (gate: variance 0). One location per workspace.
 */
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { insertEntry } from '../ledger/service.js';
import type { EntryIn } from '../ledger/schemas.js';
import type { AdjustIn, ItemIn, ItemPatch, PoIn, ReceiveIn, SoIn } from './schemas.js';

const U = 10000n; // 1.0000
const roundCent = (u: bigint): bigint => ((u + 50n) / 100n) * 100n;
/** quantity (4 places) times a per-unit amount (4 places), as units, rounded to the cent. */
const extend = (q: bigint, price: bigint): bigint => roundCent((q * price) / U);

// ------------------------------------------------------------------ items
const ITEM_SELECT = `SELECT i.id, i.sku, i.name, i.uom, i.is_active, s.qty::text AS qty_on_hand, s.value::text AS value_on_hand,
  CASE WHEN s.qty > 0 THEN round(s.value / s.qty, 4)::text ELSE '0.0000' END AS avg_cost
  FROM items i JOIN item_stock s ON s.item_id = i.id AND s.tenant_id = i.tenant_id`;

export const listItems = (p: Principal) =>
  withTenant(p.tenantId, async (c) => (await c.query(ITEM_SELECT + ' WHERE i.tenant_id = $1 ORDER BY i.sku', [p.tenantId])).rows);

export const createItem = (p: Principal, a: ItemIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>('INSERT INTO items (tenant_id, sku, name, uom) VALUES ($1, upper($2), $3, $4) RETURNING id', [p.tenantId, a.sku, a.name, a.uom]);
    await c.query('INSERT INTO item_stock (tenant_id, item_id) VALUES ($1, $2)', [p.tenantId, rows[0]!.id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'item.created', actorUserId: p.userId, entityType: 'item', entityId: rows[0]!.id, ip, detail: { sku: a.sku.toUpperCase() } });
    return (await c.query(ITEM_SELECT + ' WHERE i.tenant_id = $1 AND i.id = $2', [p.tenantId, rows[0]!.id])).rows[0];
  });

export const updateItem = (p: Principal, id: string, patch: ItemPatch, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const r = await c.query('UPDATE items SET name = COALESCE($3, name), uom = COALESCE($4, uom), is_active = COALESCE($5, is_active) WHERE tenant_id = $1 AND id = $2',
      [p.tenantId, id, patch.name ?? null, patch.uom ?? null, patch.is_active ?? null]);
    if (!r.rowCount) throw notFound('Item');
    await recordAudit(c, { tenantId: p.tenantId, action: 'item.updated', actorUserId: p.userId, entityType: 'item', entityId: id, ip, detail: { fields: Object.keys(patch).sort() } });
    return (await c.query(ITEM_SELECT + ' WHERE i.tenant_id = $1 AND i.id = $2', [p.tenantId, id])).rows[0];
  });

export const stockCard = (p: Principal, id: string) =>
  withTenant(p.tenantId, async (c) => {
    const item = (await c.query(ITEM_SELECT + ' WHERE i.tenant_id = $1 AND i.id = $2', [p.tenantId, id])).rows[0];
    if (!item) throw notFound('Item');
    const moves = (await c.query(
      `SELECT id, move_date, kind, qty::text, unit_cost::text, value::text, source_type, source_id, note, journal_entry_id,
              sum(qty) OVER w AS run_qty, sum(value) OVER w AS run_value
         FROM stock_movements WHERE tenant_id = $1 AND item_id = $2
       WINDOW w AS (ORDER BY move_date, created_at, id ROWS UNBOUNDED PRECEDING)
        ORDER BY move_date DESC, created_at DESC, id DESC LIMIT 200`, [p.tenantId, id])).rows;
    return { item, movements: moves.map((m) => ({ ...m, run_qty: fromUnits(toUnits(String(m.run_qty))), run_value: fromUnits(toUnits(String(m.run_value))) })) };
  });

// ------------------------------------------------------------------ posting stock
interface Accounts { inventory: string; cogs: string; grni: string; adjustment: string }

async function accountsFor(c: PoolClient, tenantId: string): Promise<Accounts> {
  const r = (await c.query<Record<string, string | null>>(
    'SELECT inventory_account_id, cogs_account_id, grni_account_id, adjustment_account_id FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!r?.inventory_account_id || !r.cogs_account_id || !r.grni_account_id || !r.adjustment_account_id)
    throw new ApiError(409, 'no_stock_accounts', 'Set the inventory, cost of goods sold, goods-received and adjustment accounts in settings first.');
  return { inventory: r.inventory_account_id, cogs: r.cogs_account_id, grni: r.grni_account_id, adjustment: r.adjustment_account_id };
}

interface Move { itemId: string; kind: 'receipt' | 'issue' | 'adjust_in' | 'adjust_out'; qty: bigint; unitCost?: bigint; note?: string }

/**
 * Applies a batch of movements and writes one journal entry for the lot. Items are locked in id order so two
 * postings over the same items cannot deadlock. Issues are costed at the moving average; the last unit out takes
 * whatever value remains, so no rounding residue is ever stranded in the stock.
 */
async function applyMovements(
  c: PoolClient, p: Principal, moves: Move[], date: string, source: { type: 'purchase_order' | 'sales_order' | 'adjustment'; id?: string },
  desc: string, ip: string | undefined,
) {
  const a = await accountsFor(c, p.tenantId);
  const ids = [...new Set(moves.map((m) => m.itemId))].sort();
  const stock = new Map<string, { qty: bigint; value: bigint }>();
  for (const id of ids) {
    const r = (await c.query<{ qty: string; value: string; active: boolean }>(
      'SELECT s.qty::text, s.value::text, i.is_active AS active FROM item_stock s JOIN items i ON i.id = s.item_id AND i.tenant_id = s.tenant_id WHERE s.tenant_id = $1 AND s.item_id = $2 FOR UPDATE OF s', [p.tenantId, id])).rows[0];
    if (!r) throw new ApiError(422, 'invalid_item', 'Every line must use an existing item.');
    stock.set(id, { qty: toUnits(r.qty), value: toUnits(r.value) });
  }

  const planned: { m: Move; qty: bigint; unitCost: bigint; value: bigint }[] = [];
  let cogs = 0n; let grni = 0n;
  for (const m of moves) {
    const s = stock.get(m.itemId)!;
    if (m.kind === 'receipt' || m.kind === 'adjust_in') {
      const unitCost = m.unitCost ?? 0n;
      const value = extend(m.qty, unitCost);
      s.qty += m.qty; s.value += value;
      planned.push({ m, qty: m.qty, unitCost, value });
      if (m.kind === 'receipt') grni += value;
    } else {
      if (m.qty > s.qty) throw new ApiError(409, 'insufficient_stock', 'There is not enough stock on hand for that quantity.');
      const value = m.qty === s.qty ? s.value : roundCent((m.qty * s.value) / s.qty);
      const unitCost = s.qty > 0n ? (value * U) / m.qty : 0n;
      s.qty -= m.qty; s.value -= value;
      planned.push({ m, qty: -m.qty, unitCost, value: -value });
      if (m.kind === 'issue') cogs += value;
    }
  }

  // One entry: inventory against the other side(s). Receipts credit GRNI, issues debit COGS, adjustments hit the adjustment account.
  const lines: EntryIn['lines'] = [];
  const dr = (account_id: string, v: bigint, memo: string) => lines.push({ account_id, debit: fromUnits(v), credit: '0', memo });
  const cr = (account_id: string, v: bigint, memo: string) => lines.push({ account_id, debit: '0', credit: fromUnits(v), memo });
  const inIn = planned.filter((x) => x.value > 0n).reduce((t, x) => t + x.value, 0n);
  const inOut = planned.filter((x) => x.value < 0n).reduce((t, x) => t - x.value, 0n);
  if (inIn > 0n) dr(a.inventory, inIn, 'Stock in');
  if (inOut > 0n) cr(a.inventory, inOut, 'Stock out');
  if (grni > 0n) cr(a.grni, grni, 'Goods received not invoiced');
  if (cogs > 0n) dr(a.cogs, cogs, 'Cost of goods sold');
  const adjIn = planned.filter((x) => x.m.kind === 'adjust_in').reduce((t, x) => t + x.value, 0n);
  const adjOut = planned.filter((x) => x.m.kind === 'adjust_out').reduce((t, x) => t - x.value, 0n);
  if (adjIn > 0n) cr(a.adjustment, adjIn, 'Stock adjustment');
  if (adjOut > 0n) dr(a.adjustment, adjOut, 'Stock adjustment');

  let entryId: string | null = null;
  if (lines.length > 0) entryId = await insertEntry(c, p, { entry_date: date, description: desc.slice(0, 500), lines }, ip, null, { detail: { stock: source.type } });

  for (const x of planned) {
    await c.query(
      `INSERT INTO stock_movements (tenant_id, item_id, move_date, kind, qty, unit_cost, value, source_type, source_id, note, journal_entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [p.tenantId, x.m.itemId, date, x.m.kind, fromUnits(x.qty), fromUnits(x.unitCost), fromUnits(x.value), source.type, source.id ?? null, x.m.note ?? null, x.value === 0n ? null : entryId, p.userId]);
  }
  for (const [id, s] of stock) await c.query('UPDATE item_stock SET qty = $3, value = $4 WHERE tenant_id = $1 AND item_id = $2', [p.tenantId, id, fromUnits(s.qty), fromUnits(s.value)]);
  return { entryId, moves: planned.length };
}

export const adjustStock = (p: Principal, a: AdjustIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if (a.direction === 'in' && a.unit_cost === undefined) throw new ApiError(422, 'validation_error', 'A stock increase needs a unit cost.');
    const r = await applyMovements(c, p, [{ itemId: a.item_id, kind: a.direction === 'in' ? 'adjust_in' : 'adjust_out', qty: toUnits(a.quantity), unitCost: a.unit_cost ? toUnits(a.unit_cost) : undefined, note: a.reason }],
      a.date, { type: 'adjustment' }, `Stock adjustment: ${a.reason}`, ip);
    await recordAudit(c, { tenantId: p.tenantId, action: 'stock.adjusted', actorUserId: p.userId, entityType: 'item', entityId: a.item_id, ip, detail: { direction: a.direction, quantity: a.quantity } });
    return { journal_entry_id: r.entryId };
  });

// ------------------------------------------------------------------ orders (purchase and sales share one shape)
type Kind = 'po' | 'so';
const T = {
  po: { table: 'purchase_orders', lines: 'purchase_order_lines', no: 'po_no', party: 'supplier', label: 'Purchase order', price: 'unit_cost', done: 'received_qty', prefix: 'PO' },
  so: { table: 'sales_orders', lines: 'sales_order_lines', no: 'so_no', party: 'customer', label: 'Sales order', price: 'unit_price', done: 'delivered_qty', prefix: 'SO' },
} as const;

type OrderIn = PoIn | SoIn;
const priceOf = (k: Kind, l: PoIn['lines'][number] | SoIn['lines'][number]) => ('unit_cost' in l ? l.unit_cost : (l as SoIn['lines'][number]).unit_price) ?? (k === 'po' ? '0' : '0');

const orderSelect = (k: Kind) =>
  'SELECT o.id, o.' + T[k].no + ' AS no, o.party_id, p.code AS party_code, p.name AS party_name, o.order_date, o.reference, o.status, o.total::text, o.created_at ' +
  'FROM ' + T[k].table + ' o JOIN parties p ON p.id = o.party_id AND p.tenant_id = o.tenant_id';

async function loadOrder(c: PoolClient, tenantId: string, k: Kind, id: string) {
  const o = (await c.query(orderSelect(k) + ' WHERE o.tenant_id = $1 AND o.id = $2', [tenantId, id])).rows[0];
  if (!o) throw notFound(T[k].label);
  const lines = (await c.query(
    'SELECT l.id, l.line_no, l.item_id, i.sku, i.name AS item_name, l.quantity::text, l.' + T[k].price + '::text AS price, l.' + T[k].done + '::text AS done_qty, ' +
    '(l.quantity - l.' + T[k].done + ')::text AS open_qty FROM ' + T[k].lines + ' l JOIN items i ON i.id = l.item_id AND i.tenant_id = l.tenant_id ' +
    'WHERE l.tenant_id = $1 AND l.order_id = $2 ORDER BY l.line_no', [tenantId, id])).rows;
  return { ...o, lines };
}

async function checkParty(c: PoolClient, tenantId: string, k: Kind, partyId: string) {
  const r = (await c.query<{ kind: string; is_active: boolean }>('SELECT kind, is_active FROM parties WHERE tenant_id = $1 AND id = $2', [tenantId, partyId])).rows[0];
  if (!r || r.kind !== T[k].party) throw new ApiError(422, 'invalid_party', `Choose an existing ${T[k].party}.`);
  if (!r.is_active) throw new ApiError(422, 'inactive_party', 'This party is inactive.');
}

async function writeOrderLines(c: PoolClient, tenantId: string, k: Kind, id: string, data: OrderIn) {
  const items = [...new Set(data.lines.map((l) => l.item_id))];
  const ok = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM items WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND is_active', [tenantId, items])).rows[0]?.n);
  if (ok !== items.length) throw new ApiError(422, 'invalid_item', 'Every line must use an existing, active item.');
  let total = 0n;
  await c.query('DELETE FROM ' + T[k].lines + ' WHERE tenant_id = $1 AND order_id = $2', [tenantId, id]);
  let n = 0;
  for (const l of data.lines) {
    n += 1;
    total += extend(toUnits(l.quantity), toUnits(priceOf(k, l)));
    await c.query('INSERT INTO ' + T[k].lines + ' (tenant_id, order_id, line_no, item_id, quantity, ' + T[k].price + ') VALUES ($1, $2, $3, $4, $5, $6)', [tenantId, id, n, l.item_id, l.quantity, priceOf(k, l)]);
  }
  await c.query('UPDATE ' + T[k].table + ' SET total = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, id, fromUnits(total)]);
}

export const listOrders = (p: Principal, k: Kind, q: { status?: string; limit: number; offset: number }) =>
  withTenant(p.tenantId, async (c) => {
    const total = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM ' + T[k].table + ' WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)', [p.tenantId, q.status ?? null])).rows[0]?.n ?? 0);
    const rows = (await c.query(orderSelect(k) + ' WHERE o.tenant_id = $1 AND ($2::text IS NULL OR o.status = $2) ORDER BY o.order_date DESC, o.created_at DESC LIMIT $3 OFFSET $4', [p.tenantId, q.status ?? null, q.limit, q.offset])).rows;
    return { items: rows, total, limit: q.limit, offset: q.offset };
  });

export const getOrder = (p: Principal, k: Kind, id: string) => withTenant(p.tenantId, (c) => loadOrder(c, p.tenantId, k, id));

export const createOrder = (p: Principal, k: Kind, data: OrderIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    await checkParty(c, p.tenantId, k, data.party_id);
    const id = (await c.query<{ id: string }>('INSERT INTO ' + T[k].table + ' (tenant_id, party_id, order_date, reference, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [p.tenantId, data.party_id, data.order_date, data.reference ?? null, p.userId])).rows[0]!.id;
    await writeOrderLines(c, p.tenantId, k, id, data);
    await recordAudit(c, { tenantId: p.tenantId, action: `${k === 'po' ? 'purchase_order' : 'sales_order'}.draft_created`, actorUserId: p.userId, entityType: T[k].table, entityId: id, ip });
    return loadOrder(c, p.tenantId, k, id);
  });

async function lockOrder(c: PoolClient, tenantId: string, k: Kind, id: string) {
  const o = (await c.query<{ status: string }>('SELECT status FROM ' + T[k].table + ' WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id])).rows[0];
  if (!o) throw notFound(T[k].label);
  return o.status;
}

export const updateOrder = (p: Principal, k: Kind, id: string, data: OrderIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if ((await lockOrder(c, p.tenantId, k, id)) !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft order can be changed.');
    await checkParty(c, p.tenantId, k, data.party_id);
    await c.query('UPDATE ' + T[k].table + ' SET party_id = $3, order_date = $4, reference = $5 WHERE tenant_id = $1 AND id = $2', [p.tenantId, id, data.party_id, data.order_date, data.reference ?? null]);
    await writeOrderLines(c, p.tenantId, k, id, data);
    await recordAudit(c, { tenantId: p.tenantId, action: `${k === 'po' ? 'purchase_order' : 'sales_order'}.draft_updated`, actorUserId: p.userId, entityType: T[k].table, entityId: id, ip });
    return loadOrder(c, p.tenantId, k, id);
  });

export const deleteOrder = (p: Principal, k: Kind, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if ((await lockOrder(c, p.tenantId, k, id)) !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft order can be deleted. Cancel an approved order instead.');
    await c.query('DELETE FROM ' + T[k].table + ' WHERE tenant_id = $1 AND id = $2', [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: `${k === 'po' ? 'purchase_order' : 'sales_order'}.draft_deleted`, actorUserId: p.userId, entityType: T[k].table, entityId: id, ip });
    return { deleted: true };
  });

export const approveOrder = (p: Principal, k: Kind, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if ((await lockOrder(c, p.tenantId, k, id)) !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft order can be approved.');
    const no = (await c.query<{ seq: string }>('UPDATE doc_counters SET seq = seq + 1 WHERE tenant_id = $1 AND kind = $2 RETURNING seq', [p.tenantId, k])).rows[0]!.seq;
    await c.query('UPDATE ' + T[k].table + " SET status = 'open', " + T[k].no + ' = $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, id, no]);
    await recordAudit(c, { tenantId: p.tenantId, action: `${k === 'po' ? 'purchase_order' : 'sales_order'}.approved`, actorUserId: p.userId, entityType: T[k].table, entityId: id, ip, detail: { no: Number(no) } });
    return loadOrder(c, p.tenantId, k, id);
  });

export const cancelOrder = (p: Principal, k: Kind, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const st = await lockOrder(c, p.tenantId, k, id);
    if (st !== 'draft' && st !== 'open') throw new ApiError(409, 'not_cancellable', 'This order is already closed or cancelled.');
    const done = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM ' + T[k].lines + ' WHERE tenant_id = $1 AND order_id = $2 AND ' + T[k].done + ' > 0', [p.tenantId, id])).rows[0]?.n);
    if (done > 0) throw new ApiError(409, 'already_fulfilled', 'Part of this order has already moved stock, so it cannot be cancelled.');
    await c.query("UPDATE " + T[k].table + " SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2", [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: `${k === 'po' ? 'purchase_order' : 'sales_order'}.cancelled`, actorUserId: p.userId, entityType: T[k].table, entityId: id, ip });
    return loadOrder(c, p.tenantId, k, id);
  });

/** Receive against a purchase order (k = 'po') or deliver against a sales order (k = 'so'). */
export const fulfil = (p: Principal, k: Kind, id: string, data: ReceiveIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if ((await lockOrder(c, p.tenantId, k, id)) !== 'open') throw new ApiError(409, 'not_open', 'Only an approved, open order can be received or delivered.');
    const ids = data.lines.map((l) => l.line_id);
    if (new Set(ids).size !== ids.length) throw new ApiError(422, 'duplicate_line', 'Each line can appear once.');
    const rows = (await c.query<{ id: string; item_id: string; quantity: string; price: string; done: string }>(
      'SELECT id, item_id, quantity::text, ' + T[k].price + '::text AS price, ' + T[k].done + '::text AS done FROM ' + T[k].lines + ' WHERE tenant_id = $1 AND order_id = $2 AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE',
      [p.tenantId, id, ids])).rows;
    if (rows.length !== ids.length) throw new ApiError(422, 'invalid_line', 'Every line must belong to this order.');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const moves: Move[] = [];
    for (const l of data.lines) {
      const r = byId.get(l.line_id)!;
      const q = toUnits(l.quantity);
      if (q > toUnits(r.quantity) - toUnits(r.done)) throw new ApiError(422, 'over_fulfilment', 'That is more than is still open on the line.');
      moves.push(k === 'po' ? { itemId: r.item_id, kind: 'receipt', qty: q, unitCost: toUnits(r.price) } : { itemId: r.item_id, kind: 'issue', qty: q });
    }
    const no = (await c.query<{ n: string }>('SELECT ' + T[k].no + '::text AS n FROM ' + T[k].table + ' WHERE tenant_id = $1 AND id = $2', [p.tenantId, id])).rows[0]!.n;
    const res = await applyMovements(c, p, moves, data.date, { type: k === 'po' ? 'purchase_order' : 'sales_order', id },
      `${k === 'po' ? 'Goods received' : 'Goods delivered'} ${T[k].prefix}-${no}`, ip);
    for (const l of data.lines) await c.query('UPDATE ' + T[k].lines + ' SET ' + T[k].done + ' = ' + T[k].done + ' + $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, l.line_id, l.quantity]);
    const open = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM ' + T[k].lines + ' WHERE tenant_id = $1 AND order_id = $2 AND ' + T[k].done + ' < quantity', [p.tenantId, id])).rows[0]?.n);
    if (open === 0) await c.query("UPDATE " + T[k].table + " SET status = 'closed' WHERE tenant_id = $1 AND id = $2", [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: k === 'po' ? 'purchase_order.received' : 'sales_order.delivered', actorUserId: p.userId, entityType: T[k].table, entityId: id, ip, detail: { lines: data.lines.length } });
    return { order: await loadOrder(c, p.tenantId, k, id), journal_entry_id: res.entryId };
  });

// ------------------------------------------------------------------ valuation
/** Stock value by item as of a date, set against the inventory account in the ledger. The gate is a variance of zero. */
export const valuation = (p: Principal, asOf: string) =>
  withTenant(p.tenantId, async (c) => {
    const rows = (await c.query<{ item_id: string; sku: string; name: string; uom: string; qty: string; value: string }>(
      `SELECT i.id AS item_id, i.sku, i.name, i.uom, sum(m.qty)::text AS qty, sum(m.value)::text AS value
         FROM stock_movements m JOIN items i ON i.id = m.item_id AND i.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.move_date <= $2::date GROUP BY i.id, i.sku, i.name, i.uom HAVING sum(m.qty) <> 0 OR sum(m.value) <> 0 ORDER BY i.sku`, [p.tenantId, asOf])).rows;
    let total = 0n;
    const out = rows.map((r) => {
      const v = toUnits(r.value); const q = toUnits(r.qty);
      total += v;
      return { ...r, qty: fromUnits(q), value: fromUnits(v), avg_cost: q > 0n ? fromUnits((v * U) / q) : '0.0000' };
    });
    const gl = (await c.query<{ bal: string | null }>(
      `SELECT sum(l.debit - l.credit)::text AS bal FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id AND e.entry_date <= $2::date
        WHERE l.tenant_id = $1 AND l.account_id = (SELECT inventory_account_id FROM tenant_settings WHERE tenant_id = $1)`, [p.tenantId, asOf])).rows[0]?.bal ?? '0';
    const variance = toUnits(gl) - total;
    return { as_of: asOf, rows: out, total_value: fromUnits(total), ledger_balance: fromUnits(toUnits(gl)), variance: fromUnits(variance), reconciles: variance === 0n };
  });

export const reorderView = (p: Principal) =>
  withTenant(p.tenantId, async (c) => ({
    open_purchase: (await c.query(`SELECT l.item_id, sum(l.quantity - l.received_qty)::text AS qty FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id AND o.tenant_id = l.tenant_id WHERE l.tenant_id = $1 AND o.status = 'open' GROUP BY l.item_id`, [p.tenantId])).rows,
    open_sales: (await c.query(`SELECT l.item_id, sum(l.quantity - l.delivered_qty)::text AS qty FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id AND o.tenant_id = l.tenant_id WHERE l.tenant_id = $1 AND o.status = 'open' GROUP BY l.item_id`, [p.tenantId])).rows,
  }));
