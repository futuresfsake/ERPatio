/**
 * Production: bills of materials, work orders and work in progress.
 *
 * Materials issued to an order leave inventory at the moving average and sit in Work in Progress (Dr WIP, Cr Inventory).
 * Reporting output moves the matching share of that WIP, plus the conversion cost entered, into finished goods
 * (Dr Inventory, Cr WIP, Cr Conversion Cost Applied). Closing an order short writes the rest of its WIP to Production Variance.
 * Each order's own WIP balance always adds up to the WIP account in the ledger (gate: variance 0).
 */
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/pool.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import type { Principal } from '../../lib/security.js';
import { recordAudit } from '../audit/audit.js';
import { insertEntry } from '../ledger/service.js';
import { applyMovements } from '../stock/service.js';
import type { BomIn, CompleteIn, IssueIn, WoIn } from './schemas.js';

const U = 10000n;
const roundCent = (u: bigint): bigint => ((u + 50n) / 100n) * 100n;
const mul = (a: bigint, b: bigint): bigint => (a * b) / U;
/** round half up to 4 places of a * b / c */
const ratio = (a: bigint, b: bigint, c: bigint): bigint => (a * b + c / 2n) / c;

interface WipAccounts { wip: string; conversion: string; variance: string }
async function wipAccounts(c: PoolClient, tenantId: string): Promise<WipAccounts> {
  const r = (await c.query<Record<string, string | null>>('SELECT wip_account_id, conversion_account_id, variance_account_id FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!r?.wip_account_id || !r.conversion_account_id || !r.variance_account_id)
    throw new ApiError(409, 'no_production_accounts', 'Set the work in progress, conversion cost and production variance accounts in settings first.');
  return { wip: r.wip_account_id, conversion: r.conversion_account_id, variance: r.variance_account_id };
}

// ------------------------------------------------------------------ bills of materials
const BOM_SELECT = `SELECT b.id, b.item_id, i.sku, i.name AS item_name, b.version, b.output_qty::text, b.note, b.is_active, b.created_at
  FROM boms b JOIN items i ON i.id = b.item_id AND i.tenant_id = b.tenant_id`;

async function loadBom(c: PoolClient, tenantId: string, id: string) {
  const b = (await c.query(BOM_SELECT + ' WHERE b.tenant_id = $1 AND b.id = $2', [tenantId, id])).rows[0];
  if (!b) throw notFound('Bill of materials');
  const lines = (await c.query(
    `SELECT l.item_id, i.sku, i.name, i.uom, l.quantity::text,
            CASE WHEN s.qty > 0 THEN round(s.value / s.qty, 4) ELSE 0 END::numeric(19,4)::text AS unit_cost
       FROM bom_lines l JOIN items i ON i.id = l.item_id AND i.tenant_id = l.tenant_id JOIN item_stock s ON s.item_id = i.id AND s.tenant_id = i.tenant_id
      WHERE l.tenant_id = $1 AND l.bom_id = $2 ORDER BY i.sku`, [tenantId, id])).rows;
  // Estimated cost of one output unit at today's average component costs.
  let total = 0n;
  for (const l of lines) total += mul(toUnits(l.quantity), toUnits(l.unit_cost));
  const out = toUnits(b.output_qty);
  return { ...b, lines, estimated_unit_cost: fromUnits((total * U) / out) };
}

export const listBoms = (p: Principal, itemId?: string) =>
  withTenant(p.tenantId, async (c) => (await c.query(BOM_SELECT + ' WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR b.item_id = $2) ORDER BY i.sku, b.version DESC', [p.tenantId, itemId ?? null])).rows);

export const getBom = (p: Principal, id: string) => withTenant(p.tenantId, (c) => loadBom(c, p.tenantId, id));

/** Does `target` appear anywhere below `start` in the active bills of materials? Stops a loop before it is saved. */
async function appearsBelow(c: PoolClient, tenantId: string, start: string[], target: string): Promise<boolean> {
  const r = await c.query<{ hit: boolean }>(
    `WITH RECURSIVE below(item_id, depth) AS (
        SELECT unnest($2::uuid[]), 0
        UNION
        SELECT l.item_id, w.depth + 1 FROM below w
          JOIN boms b ON b.tenant_id = $1 AND b.item_id = w.item_id AND b.is_active
          JOIN bom_lines l ON l.bom_id = b.id AND l.tenant_id = b.tenant_id
         WHERE w.depth < 20)
     SELECT EXISTS (SELECT 1 FROM below WHERE item_id = $3) AS hit`, [tenantId, start, target]);
  return r.rows[0]!.hit;
}

export const createBom = (p: Principal, data: BomIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const ids = [data.item_id, ...data.lines.map((l) => l.item_id)];
    const found = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM items WHERE tenant_id = $1 AND is_active AND id = ANY($2::uuid[])', [p.tenantId, [...new Set(ids)]])).rows[0]?.n);
    if (found !== new Set(ids).size) throw new ApiError(422, 'invalid_item', 'Every item must exist and be active.');
    const comps = data.lines.map((l) => l.item_id);
    if (new Set(comps).size !== comps.length) throw new ApiError(422, 'duplicate_component', 'Each component can appear once.');
    if (comps.includes(data.item_id)) throw new ApiError(422, 'circular_bom', 'An item cannot be a component of itself.');
    if (await appearsBelow(c, p.tenantId, comps, data.item_id)) throw new ApiError(422, 'circular_bom', 'A component is itself made from this item, which would loop.');
    const version = Number((await c.query<{ v: string | null }>('SELECT max(version)::text AS v FROM boms WHERE tenant_id = $1 AND item_id = $2', [p.tenantId, data.item_id])).rows[0]?.v ?? 0) + 1;
    await c.query('UPDATE boms SET is_active = false WHERE tenant_id = $1 AND item_id = $2 AND is_active', [p.tenantId, data.item_id]);
    const id = (await c.query<{ id: string }>('INSERT INTO boms (tenant_id, item_id, version, output_qty, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [p.tenantId, data.item_id, version, data.output_qty, data.note ?? null, p.userId])).rows[0]!.id;
    for (const l of data.lines) await c.query('INSERT INTO bom_lines (tenant_id, bom_id, item_id, quantity) VALUES ($1, $2, $3, $4)', [p.tenantId, id, l.item_id, l.quantity]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'bom.created', actorUserId: p.userId, entityType: 'bom', entityId: id, ip, detail: { version } });
    return loadBom(c, p.tenantId, id);
  });

// ------------------------------------------------------------------ work orders
const WO_SELECT = `SELECT w.id, w.wo_no AS no, w.item_id, i.sku, i.name AS item_name, i.uom, w.bom_id, b.version AS bom_version, w.qty_planned::text, w.qty_completed::text,
    w.planned_date, w.reference, w.status, w.materials_issued::text, w.materials_to_goods::text, w.written_off::text, w.conversion_applied::text,
    (w.materials_issued - w.materials_to_goods - w.written_off)::text AS wip, w.created_at
  FROM work_orders w JOIN items i ON i.id = w.item_id AND i.tenant_id = w.tenant_id JOIN boms b ON b.id = w.bom_id AND b.tenant_id = w.tenant_id`;

async function loadWo(c: PoolClient, tenantId: string, id: string) {
  const w = (await c.query(WO_SELECT + ' WHERE w.tenant_id = $1 AND w.id = $2', [tenantId, id])).rows[0];
  if (!w) throw notFound('Work order');
  const components = (await c.query(
    `SELECT k.item_id, i.sku, i.name, i.uom, k.required_qty::text, k.issued_qty::text, (k.issued_qty - k.required_qty)::text AS variance_qty
       FROM work_order_components k JOIN items i ON i.id = k.item_id AND i.tenant_id = k.tenant_id WHERE k.tenant_id = $1 AND k.order_id = $2 ORDER BY i.sku`, [tenantId, id])).rows;
  return { ...w, components };
}

export const listWorkOrders = (p: Principal, q: { status?: string; limit: number; offset: number }) =>
  withTenant(p.tenantId, async (c) => {
    const total = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM work_orders WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)', [p.tenantId, q.status ?? null])).rows[0]?.n ?? 0);
    const rows = (await c.query(WO_SELECT + ' WHERE w.tenant_id = $1 AND ($2::text IS NULL OR w.status = $2) ORDER BY w.planned_date DESC, w.created_at DESC LIMIT $3 OFFSET $4', [p.tenantId, q.status ?? null, q.limit, q.offset])).rows;
    return { items: rows, total, limit: q.limit, offset: q.offset };
  });

export const getWorkOrder = (p: Principal, id: string) => withTenant(p.tenantId, (c) => loadWo(c, p.tenantId, id));

export const createWorkOrder = (p: Principal, data: WoIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const bom = (await c.query<{ id: string }>('SELECT id FROM boms WHERE tenant_id = $1 AND item_id = $2 AND is_active', [p.tenantId, data.item_id])).rows[0];
    if (!bom) throw new ApiError(422, 'no_bom', 'This item has no active bill of materials.');
    const id = (await c.query<{ id: string }>('INSERT INTO work_orders (tenant_id, item_id, bom_id, qty_planned, planned_date, reference, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [p.tenantId, data.item_id, bom.id, data.quantity, data.planned_date, data.reference ?? null, p.userId])).rows[0]!.id;
    await recordAudit(c, { tenantId: p.tenantId, action: 'work_order.draft_created', actorUserId: p.userId, entityType: 'work_order', entityId: id, ip });
    return loadWo(c, p.tenantId, id);
  });

async function lockWo(c: PoolClient, tenantId: string, id: string) {
  const w = (await c.query<{ status: string; item_id: string; bom_id: string; qty_planned: string; qty_completed: string; materials_issued: string; materials_to_goods: string; written_off: string; wo_no: string | null }>(
    'SELECT status, item_id, bom_id, qty_planned::text, qty_completed::text, materials_issued::text, materials_to_goods::text, written_off::text, wo_no::text FROM work_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id])).rows[0];
  if (!w) throw notFound('Work order');
  return w;
}

export const deleteWorkOrder = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    if ((await lockWo(c, p.tenantId, id)).status !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft work order can be deleted. Cancel a released one instead.');
    await c.query('DELETE FROM work_orders WHERE tenant_id = $1 AND id = $2', [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'work_order.draft_deleted', actorUserId: p.userId, entityType: 'work_order', entityId: id, ip });
    return { deleted: true };
  });

/** Release: gives the order its number and freezes the components needed, scaled from the bill of materials. */
export const releaseWorkOrder = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const w = await lockWo(c, p.tenantId, id);
    if (w.status !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft work order can be released.');
    const b = (await c.query<{ output_qty: string }>('SELECT output_qty::text FROM boms WHERE tenant_id = $1 AND id = $2', [p.tenantId, w.bom_id])).rows[0]!;
    const lines = (await c.query<{ item_id: string; quantity: string }>('SELECT item_id, quantity::text FROM bom_lines WHERE tenant_id = $1 AND bom_id = $2', [p.tenantId, w.bom_id])).rows;
    for (const l of lines) {
      // required = per-batch quantity x planned / batch output, rounded up to 4 places so a fraction is never under-issued
      const need = (toUnits(l.quantity) * toUnits(w.qty_planned) + toUnits(b.output_qty) - 1n) / toUnits(b.output_qty);
      await c.query('INSERT INTO work_order_components (tenant_id, order_id, item_id, required_qty) VALUES ($1, $2, $3, $4)', [p.tenantId, id, l.item_id, fromUnits(need)]);
    }
    const no = (await c.query<{ seq: string }>("UPDATE doc_counters SET seq = seq + 1 WHERE tenant_id = $1 AND kind = 'wo' RETURNING seq", [p.tenantId])).rows[0]!.seq;
    await c.query("UPDATE work_orders SET status = 'released', wo_no = $3 WHERE tenant_id = $1 AND id = $2", [p.tenantId, id, no]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'work_order.released', actorUserId: p.userId, entityType: 'work_order', entityId: id, ip, detail: { no: Number(no) } });
    return loadWo(c, p.tenantId, id);
  });

export const cancelWorkOrder = (p: Principal, id: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const w = await lockWo(c, p.tenantId, id);
    if (w.status !== 'draft' && w.status !== 'released') throw new ApiError(409, 'not_cancellable', 'This work order is already finished or cancelled.');
    if (toUnits(w.materials_issued) > 0n || toUnits(w.qty_completed) > 0n) throw new ApiError(409, 'work_started', 'Materials have been issued or output reported. Close the order instead, which writes off what is left.');
    await c.query("UPDATE work_orders SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2", [p.tenantId, id]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'work_order.cancelled', actorUserId: p.userId, entityType: 'work_order', entityId: id, ip });
    return loadWo(c, p.tenantId, id);
  });

/** Issue components to the order. With no lines given, everything still required is issued. All or nothing. */
export const issueMaterials = (p: Principal, id: string, data: IssueIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const w = await lockWo(c, p.tenantId, id);
    if (w.status !== 'released') throw new ApiError(409, 'not_released', 'Materials can only be issued to a released work order.');
    const a = await wipAccounts(c, p.tenantId);
    const comps = (await c.query<{ item_id: string; required_qty: string; issued_qty: string }>(
      'SELECT item_id, required_qty::text, issued_qty::text FROM work_order_components WHERE tenant_id = $1 AND order_id = $2 ORDER BY item_id FOR UPDATE', [p.tenantId, id])).rows;
    const byItem = new Map(comps.map((k) => [k.item_id, k]));
    const wanted = data.lines
      ? data.lines.map((l) => ({ item_id: l.item_id, qty: toUnits(l.quantity) }))
      : comps.filter((k) => toUnits(k.required_qty) > toUnits(k.issued_qty)).map((k) => ({ item_id: k.item_id, qty: toUnits(k.required_qty) - toUnits(k.issued_qty) }));
    if (wanted.length === 0) throw new ApiError(409, 'nothing_to_issue', 'Everything required has already been issued.');
    const seen = new Set<string>();
    for (const x of wanted) {
      if (!byItem.has(x.item_id)) throw new ApiError(422, 'not_a_component', 'That item is not a component of this work order.');
      if (seen.has(x.item_id)) throw new ApiError(422, 'duplicate_line', 'Each component can appear once.');
      seen.add(x.item_id);
    }
    const res = await applyMovements(c, p, wanted.map((x) => ({ itemId: x.item_id, kind: 'issue' as const, qty: x.qty, note: `WO-${w.wo_no}` })), data.date,
      { type: 'work_order', id }, `Materials issued to WO-${w.wo_no}`, ip, { issueDebit: a.wip });
    const value = res.values.reduce((t, v) => t - v.value, 0n); // issue values are negative
    for (const x of wanted) await c.query('UPDATE work_order_components SET issued_qty = issued_qty + $3 WHERE tenant_id = $1 AND order_id = $2 AND item_id = $4', [p.tenantId, id, fromUnits(x.qty), x.item_id]);
    await c.query('UPDATE work_orders SET materials_issued = materials_issued + $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, id, fromUnits(value)]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'work_order.materials_issued', actorUserId: p.userId, entityType: 'work_order', entityId: id, ip, detail: { components: wanted.length, value: fromUnits(value) } });
    return { order: await loadWo(c, p.tenantId, id), journal_entry_id: res.entryId };
  });

/** Report output: finished goods come in at the matching share of WIP plus the conversion cost entered. */
export const completeWorkOrder = (p: Principal, id: string, data: CompleteIn, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const w = await lockWo(c, p.tenantId, id);
    if (w.status !== 'released') throw new ApiError(409, 'not_released', 'Output can only be reported on a released work order.');
    const a = await wipAccounts(c, p.tenantId);
    const q = toUnits(data.quantity);
    const remainingQty = toUnits(w.qty_planned) - toUnits(w.qty_completed);
    if (q > remainingQty) throw new ApiError(422, 'over_completion', 'That is more than is still planned on this order.');
    const wipBalance = toUnits(w.materials_issued) - toUnits(w.materials_to_goods) - toUnits(w.written_off);
    const share = q === remainingQty ? wipBalance : roundCent(ratio(wipBalance, q, remainingQty));
    const conversion = toUnits(data.conversion_cost);
    const total = share + conversion;
    const credits: { account_id: string; amount: bigint; memo: string }[] = [
      { account_id: a.wip, amount: share, memo: `Materials from WO-${w.wo_no}` },
      { account_id: a.conversion, amount: conversion, memo: `Conversion cost applied WO-${w.wo_no}` },
    ];
    const res = await applyMovements(c, p, [{ itemId: w.item_id, kind: 'receipt', qty: q, totalValue: total, note: `WO-${w.wo_no}` }], data.date,
      { type: 'work_order', id }, `Finished goods from WO-${w.wo_no}`, ip, { receiptCredits: credits });
    const done = toUnits(w.qty_completed) + q;
    await c.query("UPDATE work_orders SET qty_completed = $3, materials_to_goods = materials_to_goods + $4, conversion_applied = conversion_applied + $5, status = CASE WHEN $3::numeric >= qty_planned THEN 'completed' ELSE status END WHERE tenant_id = $1 AND id = $2",
      [p.tenantId, id, fromUnits(done), fromUnits(share), fromUnits(conversion)]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'work_order.completed', actorUserId: p.userId, entityType: 'work_order', entityId: id, ip, detail: { quantity: data.quantity, cost: fromUnits(total) } });
    return { order: await loadWo(c, p.tenantId, id), journal_entry_id: res.entryId, unit_cost: fromUnits(q > 0n ? (total * U) / q : 0n) };
  });

/** Close a released order short: whatever is left in its WIP is written off to Production Variance. */
export const closeWorkOrder = (p: Principal, id: string, date: string, ip?: string) =>
  withTenant(p.tenantId, async (c) => {
    const w = await lockWo(c, p.tenantId, id);
    if (w.status !== 'released') throw new ApiError(409, 'not_released', 'Only a released work order can be closed.');
    const a = await wipAccounts(c, p.tenantId);
    const left = toUnits(w.materials_issued) - toUnits(w.materials_to_goods) - toUnits(w.written_off);
    let entryId: string | null = null;
    if (left > 0n) {
      entryId = await insertEntry(c, p, {
        entry_date: date, description: `Close WO-${w.wo_no}: write off remaining work in progress`, reference: `WO-${w.wo_no}`,
        lines: [{ account_id: a.variance, debit: fromUnits(left), credit: '0', memo: 'Production variance' }, { account_id: a.wip, debit: '0', credit: fromUnits(left), memo: `WO-${w.wo_no}` }],
      }, ip, null, { detail: { work_order: id } });
    }
    await c.query("UPDATE work_orders SET status = 'closed', written_off = written_off + $3, close_entry_id = $4 WHERE tenant_id = $1 AND id = $2", [p.tenantId, id, fromUnits(left), entryId]);
    await recordAudit(c, { tenantId: p.tenantId, action: 'work_order.closed', actorUserId: p.userId, entityType: 'work_order', entityId: id, ip, detail: { written_off: fromUnits(left) } });
    return { order: await loadWo(c, p.tenantId, id), journal_entry_id: entryId };
  });

/** Work in progress by order, set against the WIP account in the ledger. The gate is a variance of zero. */
export const wipReport = (p: Principal, asOf: string) =>
  withTenant(p.tenantId, async (c) => {
    // Orders' own WIP is a running balance, so the report is as of now; the ledger side is as of the same moment.
    const rows = (await c.query<{ id: string; no: string; sku: string; item_name: string; status: string; qty_planned: string; qty_completed: string; wip: string }>(
      `SELECT w.id, w.wo_no::text AS no, i.sku, i.name AS item_name, w.status, w.qty_planned::text, w.qty_completed::text, (w.materials_issued - w.materials_to_goods - w.written_off)::text AS wip
         FROM work_orders w JOIN items i ON i.id = w.item_id AND i.tenant_id = w.tenant_id
        WHERE w.tenant_id = $1 AND w.status <> 'draft' AND (w.materials_issued - w.materials_to_goods - w.written_off) <> 0 ORDER BY w.wo_no`, [p.tenantId])).rows;
    let total = 0n;
    for (const r of rows) total += toUnits(r.wip);
    const gl = (await c.query<{ bal: string | null }>(
      `SELECT sum(l.debit - l.credit)::text AS bal FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id AND e.entry_date <= $2::date
        WHERE l.tenant_id = $1 AND l.account_id = (SELECT wip_account_id FROM tenant_settings WHERE tenant_id = $1)`, [p.tenantId, asOf])).rows[0]?.bal ?? '0';
    const variance = toUnits(gl) - total;
    return { as_of: asOf, rows, total_wip: fromUnits(total), ledger_balance: fromUnits(toUnits(gl)), variance: fromUnits(variance < 0n ? -variance : variance), variance_sign: variance < 0n ? '-' : '+', reconciles: variance === 0n };
  });
