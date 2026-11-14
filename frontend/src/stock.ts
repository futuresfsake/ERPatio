/** Supply chain endpoints: items, stock, purchase orders (receive) and sales orders (deliver). */
import { api } from './api';

export type OrderKind = 'po' | 'so';
export const ORDERS = {
  po: { path: 'purchase-orders', Title: 'Purchase orders', One: 'Purchase order', prefix: 'PO', party: 'supplier', Party: 'Supplier', parties: 'suppliers', price: 'Unit cost', act: 'receive', Act: 'Receive', done: 'Received' },
  so: { path: 'sales-orders', Title: 'Sales orders', One: 'Sales order', prefix: 'SO', party: 'customer', Party: 'Customer', parties: 'customers', price: 'Unit price', act: 'deliver', Act: 'Deliver', done: 'Delivered' },
} as const;

export interface Item { id: string; sku: string; name: string; uom: string; is_active: boolean; reorder_level: string; below_reorder: boolean; qty_on_hand: string; value_on_hand: string; avg_cost: string }
export interface OrderRow { id: string; no: string | null; party_id: string; party_code: string; party_name: string; order_date: string; reference: string | null; status: 'draft' | 'open' | 'closed' | 'cancelled'; total: string }
export interface OrderLine { id: string; line_no: number; item_id: string; sku: string; item_name: string; quantity: string; price: string; done_qty: string; open_qty: string }
export interface Order extends OrderRow { lines: OrderLine[] }
export interface OrderInput { party_id: string; order_date: string; reference?: string; lines: { item_id: string; quantity: string; unit_cost?: string; unit_price?: string }[] }
export interface Valuation { as_of: string; rows: { item_id: string; sku: string; name: string; uom: string; qty: string; value: string; avg_cost: string }[]; total_value: string; ledger_balance: string; variance: string; reconciles: boolean }
export interface Movement { id: string; move_date: string; kind: string; qty: string; unit_cost: string; value: string; note: string | null; run_qty: string; run_value: string }

export const stock = {
  items: () => api<Item[]>('/items'),
  createItem: (i: { sku: string; name: string; uom: string }) => api<Item>('/items', { method: 'POST', json: i }),
  updateItem: (id: string, p: Partial<{ is_active: boolean }>) => api<Item>(`/items/${id}`, { method: 'PATCH', json: p }),
  card: (id: string) => api<{ item: Item; movements: Movement[] }>(`/items/${id}/stock-card`),
  adjust: (a: { item_id: string; date: string; direction: 'in' | 'out'; quantity: string; unit_cost?: string; reason: string }) => api<{ journal_entry_id: string | null }>('/stock-adjustments', { method: 'POST', json: a }),
  orders: (k: OrderKind) => api<{ items: OrderRow[]; total: number }>(`/${ORDERS[k].path}?limit=100`),
  order: (k: OrderKind, id: string) => api<Order>(`/${ORDERS[k].path}/${id}`),
  createOrder: (k: OrderKind, o: OrderInput) => api<Order>(`/${ORDERS[k].path}`, { method: 'POST', json: o }),
  updateOrder: (k: OrderKind, id: string, o: OrderInput) => api<Order>(`/${ORDERS[k].path}/${id}`, { method: 'PUT', json: o }),
  deleteOrder: (k: OrderKind, id: string) => api<{ deleted: boolean }>(`/${ORDERS[k].path}/${id}`, { method: 'DELETE' }),
  approve: (k: OrderKind, id: string) => api<Order>(`/${ORDERS[k].path}/${id}/approve`, { method: 'POST' }),
  cancel: (k: OrderKind, id: string) => api<Order>(`/${ORDERS[k].path}/${id}/cancel`, { method: 'POST' }),
  fulfil: (k: OrderKind, id: string, date: string, lines: { line_id: string; quantity: string }[]) => api<{ order: Order }>(`/${ORDERS[k].path}/${id}/${ORDERS[k].act}`, { method: 'POST', json: { date, lines } }),
  fulfilReturn: (k: OrderKind, id: string, date: string, lines: { line_id: string; quantity: string }[]) => api<{ order: Order }>(`/${ORDERS[k].path}/${id}/return`, { method: 'POST', json: { date, lines } }),
  makeDocument: (k: OrderKind, id: string) => api<{ id: string }>(`/${ORDERS[k].path}/${id}/${k === 'po' ? 'bill' : 'invoice'}`, { method: 'POST', json: {} }),
  setReorder: (id: string, level: string) => api<Item>(`/items/${id}`, { method: 'PATCH', json: { reorder_level: level } }),
  valuation: (asOf: string) => api<Valuation>(`/reports/stock-valuation?as_of=${asOf}`),
};
