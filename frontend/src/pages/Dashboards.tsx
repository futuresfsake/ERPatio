import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatApiNum, fromApi } from '../lib/money';
import { Loading, Problem, todayIso } from '../ui';

interface Exec {
  as_of: string; cash: { balance: string };
  month: { revenue: string; expenses: string; net_income: string }; year: { revenue: string; expenses: string; net_income: string };
  months: { month: string; revenue: string; expenses: string }[];
  receivables: { open: string; overdue: string; customers_owing: number }; payables: { open: string; overdue: string; suppliers_owed: number };
  inventory?: { value: string };
}
interface Inv {
  as_of: string; total_value: string; reconciles: boolean; items_below_reorder: number;
  open_purchase_orders: { count: number; value: string }; open_sales_orders: { count: number; value: string };
  top_by_value: { sku: string; name: string; qty: string; value: string }[]; fast_movers: { sku: string; name: string; qty: string }[]; no_movement_90_days: { sku: string; name: string; value: string }[];
}
interface Profit {
  from: string; to: string;
  customers: { party_id: string; code: string; name: string; invoiced: string; credited: string; net_sales: string }[];
  items: { item_id: string; sku: string; name: string; qty: string; sales: string; cost: string; margin: string; margin_pct: number | null }[];
}

const qty = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const neg = (s: string) => s.startsWith('-');
const money = (s: string) => `${neg(s) ? '-' : ''}${formatApiNum(s.replace('-', ''))}`;

function Tile({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className="tile" style={{ border: '1px solid var(--rule-strong)', borderRadius: 'var(--r)', background: 'var(--sheet)', padding: '12px 14px' }}>
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div className="num" style={{ fontSize: 22, textAlign: 'left', marginTop: 4, color: warn ? 'var(--accent)' : undefined }}>{value}</div>
      {note && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

/** Revenue and expenses side by side for six months. SVG with a table underneath so nothing depends on seeing the picture. */
function Trend({ months }: { months: Exec['months'] }) {
  const W = 560; const H = 170; const pad = { l: 8, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...months.flatMap((m) => [Number(m.revenue), Number(m.expenses)]));
  const bw = (W - pad.l - pad.r) / months.length;
  const y = (v: string) => H - pad.b - ((H - pad.t - pad.b) * Math.max(0, Number(v))) / max;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Revenue and expenses for the last six months" style={{ width: '100%', maxWidth: 640, height: 'auto' }}>
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--rule-strong)" />
        {months.map((m, i) => {
          const x = pad.l + i * bw;
          return (
            <g key={m.month}>
              <rect x={x + bw * 0.12} y={y(m.revenue)} width={bw * 0.34} height={H - pad.b - y(m.revenue)} fill="var(--ink)" />
              <rect x={x + bw * 0.54} y={y(m.expenses)} width={bw * 0.34} height={H - pad.b - y(m.expenses)} fill="var(--accent)" />
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">{m.month.slice(5)}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="muted" style={{ fontSize: 12 }}><span style={{ color: 'var(--ink)' }}>■</span> Revenue <span style={{ color: 'var(--accent)', marginLeft: 10 }}>■</span> Expenses</figcaption>
      <details style={{ marginTop: 6 }}><summary>Show the figures</summary>
        <div className="tbl-wrap"><table><thead><tr><th>Month</th><th className="num">Revenue</th><th className="num">Expenses</th></tr></thead>
          <tbody>{months.map((m) => <tr key={m.month}><td>{m.month}</td><td className="num">{formatApiNum(m.revenue)}</td><td className="num">{formatApiNum(m.expenses)}</td></tr>)}</tbody></table></div>
      </details>
    </figure>
  );
}

export function Dashboards() {
  const ex = useQuery({ queryKey: ['dash-exec'], queryFn: () => api<Exec>('/dashboards/executive'), refetchInterval: 60_000 });
  const e = ex.data;
  const hasInv = !!e?.inventory;
  const inv = useQuery({ queryKey: ['dash-inv'], queryFn: () => api<Inv>('/dashboards/inventory'), enabled: hasInv, refetchInterval: 60_000 });
  const i = inv.data;
  return (
    <>
      <div className="page-head"><div><h1>Dashboards</h1><p className="sub">{e ? `As of ${e.as_of}. ` : ''}Figures come straight from the ledger, the same as the reports.</p></div></div>
      <Problem error={ex.error ?? inv.error} />
      {ex.isLoading && <Loading what="dashboard" />}
      {e && (
        <>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <Tile label="Cash" value={money(e.cash.balance)} />
            <Tile label="Owed to you" value={money(e.receivables.open)} note={`${money(e.receivables.overdue)} overdue · ${e.receivables.customers_owing} customers`} warn={fromApi(e.receivables.overdue.replace('-', '')) > 0n} />
            <Tile label="You owe" value={money(e.payables.open)} note={`${money(e.payables.overdue)} overdue · ${e.payables.suppliers_owed} suppliers`} warn={fromApi(e.payables.overdue.replace('-', '')) > 0n} />
            <Tile label="Profit this year" value={money(e.year.net_income)} note={`${money(e.month.net_income)} this month`} warn={neg(e.year.net_income)} />
            {e.inventory && <Tile label="Stock value" value={money(e.inventory.value)} />}
          </div>
          <h2 style={{ margin: '24px 0 8px' }}>Six months</h2>
          <Trend months={e.months} />
        </>
      )}
      {i && (
        <>
          <h2 style={{ margin: '28px 0 8px' }}>Inventory</h2>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <Tile label="Items to reorder" value={String(i.items_below_reorder)} warn={i.items_below_reorder > 0} note={i.reconciles ? 'Stock agrees with the ledger' : 'Stock differs from the ledger'} />
            <Tile label="Open purchase orders" value={String(i.open_purchase_orders.count)} note={money(i.open_purchase_orders.value)} />
            <Tile label="Open sales orders" value={String(i.open_sales_orders.count)} note={money(i.open_sales_orders.value)} />
          </div>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginTop: 16 }}>
            <div><h3>Most stock value</h3><div className="tbl-wrap"><table><tbody>{i.top_by_value.map((x) => <tr key={x.sku}><td className="code">{x.sku}</td><td className="name">{x.name}</td><td className="num">{formatApiNum(x.value)}</td></tr>)}{i.top_by_value.length === 0 && <tr><td className="empty">No stock.</td></tr>}</tbody></table></div></div>
            <div><h3>Selling fastest (90 days)</h3><div className="tbl-wrap"><table><tbody>{i.fast_movers.map((x) => <tr key={x.sku}><td className="code">{x.sku}</td><td className="name">{x.name}</td><td className="num">{qty(x.qty)}</td></tr>)}{i.fast_movers.length === 0 && <tr><td className="empty">No sales yet.</td></tr>}</tbody></table></div></div>
            <div><h3>Not moving (90 days)</h3><div className="tbl-wrap"><table><tbody>{i.no_movement_90_days.map((x) => <tr key={x.sku}><td className="code">{x.sku}</td><td className="name">{x.name}</td><td className="num">{formatApiNum(x.value)}</td></tr>)}{i.no_movement_90_days.length === 0 && <tr><td className="empty">Everything moved.</td></tr>}</tbody></table></div></div>
          </div>
        </>
      )}
      <p className="muted" style={{ marginTop: 20 }}><Link to="/reports/profitability">Profitability by customer and item</Link></p>
    </>
  );
}

export function ProfitabilityPage() {
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const ok = from <= to;
  const q = useQuery({ queryKey: ['profit', from, to], queryFn: () => api<Profit>(`/reports/profitability?from=${from}&to=${to}`), enabled: ok });
  const r = q.data;
  return (
    <>
      <div className="page-head">
        <div><h1>Profitability</h1><p className="sub">Customers by net sales (invoices less credit notes). Items by sales delivered against what the stock cost.</p></div>
        <div className="actions">
          <div><label htmlFor="pf">From</label><input id="pf" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} /></div>
          <div><label htmlFor="pt">To</label><input id="pt" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} /></div>
        </div>
      </div>
      {!ok && <div className="notice error" role="alert">Choose a start date that is not after the end date.</div>}
      <Problem error={q.error} />
      {q.isLoading && <Loading what="profitability" />}
      {r && (
        <>
          <h2>By customer</h2>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Customer</th><th className="num">Invoiced</th><th className="num">Credited</th><th className="num">Net sales</th></tr></thead>
            <tbody>{r.customers.map((c) => <tr key={c.party_id}><td className="name">{c.code} · {c.name}</td><td className="num">{formatApiNum(c.invoiced)}</td><td className="num">{formatApiNum(c.credited)}</td><td className="num">{money(c.net_sales)}</td></tr>)}{r.customers.length === 0 && <tr><td colSpan={4} className="empty">No invoices in this period.</td></tr>}</tbody>
          </table></div>
          {r.items.length > 0 && (
            <>
              <h2 style={{ marginTop: 20 }}>By item</h2>
              <div className="tbl-wrap"><table>
                <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Margin</th><th className="num">%</th></tr></thead>
                <tbody>{r.items.map((x) => <tr key={x.item_id}><td className="name">{x.sku} · {x.name}</td><td className="num">{qty(x.qty)}</td><td className="num">{formatApiNum(x.sales)}</td><td className="num">{formatApiNum(x.cost)}</td><td className="num">{money(x.margin)}</td><td className="num">{x.margin_pct === null ? '' : x.margin_pct.toFixed(1)}</td></tr>)}</tbody>
              </table></div>
            </>
          )}
        </>
      )}
    </>
  );
}
