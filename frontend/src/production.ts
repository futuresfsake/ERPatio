/** Production endpoints: bills of materials, work orders, work in progress. */
import { api } from './api';

export interface BomRow { id: string; item_id: string; sku: string; item_name: string; version: number; output_qty: string; note: string | null; is_active: boolean }
export interface BomDetail extends BomRow { lines: { item_id: string; sku: string; name: string; uom: string; quantity: string; unit_cost: string }[]; estimated_unit_cost: string }
export interface WoRow { id: string; no: string | null; item_id: string; sku: string; item_name: string; uom: string; bom_version: number; qty_planned: string; qty_completed: string; planned_date: string; reference: string | null; status: 'draft' | 'released' | 'completed' | 'closed' | 'cancelled'; materials_issued: string; materials_to_goods: string; written_off: string; conversion_applied: string; wip: string }
export interface WoDetail extends WoRow { components: { item_id: string; sku: string; name: string; uom: string; required_qty: string; issued_qty: string; variance_qty: string }[] }
export interface WipReport { as_of: string; rows: { id: string; no: string; sku: string; item_name: string; status: string; qty_planned: string; qty_completed: string; wip: string }[]; total_wip: string; ledger_balance: string; variance: string; variance_sign: string; reconciles: boolean }

export const prod = {
  boms: () => api<BomRow[]>('/boms'),
  bom: (id: string) => api<BomDetail>(`/boms/${id}`),
  createBom: (b: { item_id: string; output_qty: string; note?: string; lines: { item_id: string; quantity: string }[] }) => api<BomDetail>('/boms', { method: 'POST', json: b }),
  orders: () => api<{ items: WoRow[]; total: number }>('/work-orders?limit=100'),
  order: (id: string) => api<WoDetail>(`/work-orders/${id}`),
  createOrder: (o: { item_id: string; quantity: string; planned_date: string; reference?: string }) => api<WoDetail>('/work-orders', { method: 'POST', json: o }),
  deleteOrder: (id: string) => api<{ deleted: boolean }>(`/work-orders/${id}`, { method: 'DELETE' }),
  release: (id: string) => api<WoDetail>(`/work-orders/${id}/release`, { method: 'POST' }),
  cancel: (id: string) => api<WoDetail>(`/work-orders/${id}/cancel`, { method: 'POST' }),
  issue: (id: string, date: string, lines?: { item_id: string; quantity: string }[]) => api<{ order: WoDetail }>(`/work-orders/${id}/issue`, { method: 'POST', json: { date, ...(lines && { lines }) } }),
  complete: (id: string, date: string, quantity: string, conversion_cost: string) => api<{ order: WoDetail; unit_cost: string }>(`/work-orders/${id}/complete`, { method: 'POST', json: { date, quantity, conversion_cost } }),
  close: (id: string, date: string) => api<{ order: WoDetail }>(`/work-orders/${id}/close`, { method: 'POST', json: { date } }),
  wip: (asOf: string) => api<WipReport>(`/reports/wip?as_of=${asOf}`),
};
