import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { formatApiNum, formatNum, parseAmount, toApi } from '../lib/money';
import { sub } from '../subledger';
import { ORDERS, stock, type OrderInput, type OrderKind, type Order } from '../stock';
import { Dialog, Loading, longDate, Problem, todayIso, useToast } from '../ui';

const qtyText = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const label = (k: OrderKind, o: { no: string | null }) => (o.no ? `${ORDERS[k].prefix}-${o.no}` : 'Draft');
const STATUS = { draft: 'Draft', open: 'Open', closed: 'Complete', cancelled: 'Cancelled' } as const;

export function OrderList({ kind }: { kind: OrderKind }) {
  const O = ORDERS[kind];
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['orders', kind], queryFn: () => stock.orders(kind) });
  return (
    <>
      <div className="page-head">
        <div><h1>{O.Title}</h1><p className="sub">{kind === 'po' ? 'Receiving stock debits inventory and credits goods received not invoiced.' : 'Delivering stock debits cost of goods sold at the moving average cost.'}</p></div>
        <div className="actions">{can('orders:write') && <Link className="btn primary" to={`/${O.path}/new`}>New {O.One.toLowerCase()}</Link>}</div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what={O.path} />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>No.</th><th>{O.Party}</th><th>Date</th><th>Status</th><th className="num">Total</th></tr></thead>
          <tbody>
            {q.data.items.map((o) => <tr key={o.id}><td className="code"><Link to={`/${O.path}/${o.id}`}>{label(kind, o)}</Link></td><td className="name">{o.party_name}</td><td>{longDate(o.order_date)}</td><td>{STATUS[o.status]}</td><td className="num">{formatApiNum(o.total)}</td></tr>)}
            {q.data.items.length === 0 && <tr><td colSpan={5} className="empty">No {O.path.replace('-', ' ')} yet.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}

interface LineForm { item_id: string; quantity: string; price: string }

export function OrderEditor({ kind }: { kind: OrderKind }) {
  const O = ORDERS[kind];
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ['order', kind, id], queryFn: () => stock.order(kind, id!), enabled: !!id });
  const parties = useQuery({ queryKey: ['parties', kind === 'po' ? 'ap' : 'ar'], queryFn: () => sub.parties(kind === 'po' ? 'ap' : 'ar') });
  const items = useQuery({ queryKey: ['items'], queryFn: stock.items });
  const [party, setParty] = useState('');
  const [date, setDate] = useState(todayIso());
  const [ref, setRef] = useState('');
  const [lines, setLines] = useState<LineForm[]>([{ item_id: '', quantity: '1', price: '' }]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (existing.data && loaded !== existing.data.id) {
    const d = existing.data;
    setLoaded(d.id); setParty(d.party_id); setDate(d.order_date); setRef(d.reference ?? '');
    setLines(d.lines.map((l) => ({ item_id: l.item_id, quantity: qtyText(l.quantity), price: qtyText(l.price) })));
  }
  const total = useMemo(() => lines.reduce((s, l) => { const q = parseAmount(l.quantity); const p = parseAmount(l.price); return q === null || p === null ? s : s + (((q * p) / 10000n + 50n) / 100n) * 100n; }, 0n), [lines]);
  const save = useMutation({
    mutationFn: (o: OrderInput) => (id ? stock.updateOrder(kind, id, o) : stock.createOrder(kind, o)),
    onSuccess: (o) => { toast('Draft saved'); void qc.invalidateQueries({ queryKey: ['orders', kind] }); void qc.invalidateQueries({ queryKey: ['order', kind, o.id] }); nav(`/${O.path}/${o.id}`); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const set = (i: number, k: keyof LineForm, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const submit = (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!party) return setErr(`Choose a ${O.party}.`);
    for (const [i, l] of lines.entries()) {
      if (!l.item_id) return setErr(`Line ${i + 1} needs an item.`);
      const q = parseAmount(l.quantity);
      if (q === null || q === 0n || parseAmount(l.price) === null) return setErr(`Line ${i + 1} has a quantity or price that is not a number.`);
    }
    save.mutate({ party_id: party, order_date: date, ...(ref.trim() && { reference: ref.trim() }),
      lines: lines.map((l) => ({ item_id: l.item_id, quantity: toApi(parseAmount(l.quantity)!), [kind === 'po' ? 'unit_cost' : 'unit_price']: toApi(parseAmount(l.price)!) })) });
  };
  if (id && existing.isLoading) return <Loading what="order" />;
  if (existing.data && existing.data.status !== 'draft') return <div className="notice warn">An approved order cannot be edited. <Link to={`/${O.path}/${id}`}>Open it</Link>.</div>;
  return (
    <>
      <div className="page-head"><div><h1>{id ? `Edit draft ${O.One.toLowerCase()}` : `New ${O.One.toLowerCase()}`}</h1><p className="sub">It gets a number when you approve it.</p></div></div>
      <Problem error={existing.error ?? parties.error ?? items.error} />
      <form onSubmit={submit} className="stack" noValidate style={{ maxWidth: 900 }}>
        <div className="toolbar">
          <div><label htmlFor="op">{O.Party}</label><select id="op" value={party} onChange={(e) => setParty(e.target.value)} style={{ minWidth: 220 }}><option value="">Choose…</option>{(parties.data ?? []).filter((p) => p.is_active || p.id === party).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></div>
          <div><label htmlFor="od">Date</label><input id="od" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
          <div><label htmlFor="orf">Reference</label><input id="orf" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} /></div>
        </div>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">{O.price}</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td><select aria-label={`Line ${i + 1} item`} value={l.item_id} onChange={(e) => set(i, 'item_id', e.target.value)}><option value="">Choose…</option>{(items.data ?? []).filter((x) => x.is_active || x.id === l.item_id).map((x) => <option key={x.id} value={x.id}>{x.sku} · {x.name}</option>)}</select></td>
              <td><input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} style={{ width: 90, textAlign: 'right' }} /></td>
              <td><input aria-label={`Line ${i + 1} price`} inputMode="decimal" value={l.price} onChange={(e) => set(i, 'price', e.target.value)} style={{ width: 120, textAlign: 'right' }} /></td>
              <td>{lines.length > 1 && <button type="button" className="linkbtn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
            </tr>))}</tbody>
        </table></div>
        <div className="toolbar"><button type="button" className="btn" onClick={() => setLines([...lines, { item_id: '', quantity: '1', price: '' }])} disabled={lines.length >= 100}>Add line</button></div>
        <div className="statement" style={{ maxWidth: 320, marginLeft: 'auto' }}><div className="ln sum"><span>Total</span><span className="dots" /><span className="num">{formatNum(total)}</span></div></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><Link className="btn" to={`/${O.path}`}>Cancel</Link><button className="btn primary" disabled={save.isPending}>Save draft</button></div>
      </form>
    </>
  );
}

export function OrderDetail({ kind }: { kind: OrderKind }) {
  const O = ORDERS[kind];
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [moving, setMoving] = useState<'move' | 'return' | null>(null);
  const q = useQuery({ queryKey: ['order', kind, id], queryFn: () => stock.order(kind, id!) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['order', kind, id] }); void qc.invalidateQueries({ queryKey: ['orders', kind] }); void qc.invalidateQueries({ queryKey: ['items'] }); };
  const act = useMutation({
    mutationFn: (a: 'approve' | 'cancel' | 'delete'): Promise<unknown> => (a === 'approve' ? stock.approve(kind, id!) : a === 'cancel' ? stock.cancel(kind, id!) : stock.deleteOrder(kind, id!)),
    onSuccess: (_r, a) => { if (a === 'delete') { toast('Draft deleted'); void qc.invalidateQueries({ queryKey: ['orders', kind] }); nav(`/${O.path}`); } else { toast(a === 'approve' ? 'Approved' : 'Cancelled'); refresh(); } },
  });
  const makeDoc = useMutation({
    mutationFn: () => stock.makeDocument(kind, id!),
    onSuccess: (d) => { toast(kind === 'po' ? 'Draft bill created' : 'Draft invoice created'); nav(`/${kind === 'po' ? 'bills' : 'invoices'}/${d.id}`); },
  });
  const o = q.data;
  const orders = can('orders:write');
  const hasDone = (o?.lines ?? []).some((l) => l.done_qty !== '0.0000');
  const anyDone = o?.lines.some((l) => parseAmount(l.done_qty) !== 0n && l.done_qty !== '0.0000') ?? false;
  return (
    <>
      <div className="page-head">
        <div><h1>{o ? `${O.One} ${label(kind, o)}` : O.One}</h1>{o && <p className="sub">{o.party_name} · {STATUS[o.status]} · {longDate(o.order_date)}</p>}</div>
        {o && (
          <div className="actions">
            {orders && o.status === 'draft' && <><Link className="btn" to={`/${O.path}/${o.id}/edit`}>Edit</Link><button className="btn" disabled={act.isPending} onClick={() => act.mutate('delete')}>Delete draft</button><button className="btn primary" disabled={act.isPending} onClick={() => act.mutate('approve')}>Approve</button></>}
            {o.status === 'open' && can('inventory:write') && <button className="btn primary" onClick={() => setMoving('move')}>{O.Act} goods</button>}
            {(o.status === 'open' || o.status === 'closed') && hasDone && can('inventory:write') && <button className="btn" onClick={() => setMoving('return')}>Return goods</button>}
            {hasDone && can(kind === 'po' ? 'payables:write' : 'receivables:write') && <button className="btn" disabled={makeDoc.isPending} onClick={() => makeDoc.mutate()}>{kind === 'po' ? 'Create bill' : 'Create invoice'}</button>}
            {orders && (o.status === 'open') && !anyDone && <button className="btn" disabled={act.isPending} onClick={() => { if (window.confirm('Cancel this order?')) act.mutate('cancel'); }}>Cancel order</button>}
          </div>
        )}
      </div>
      <Problem error={q.error ?? act.error ?? makeDoc.error} />
      {q.isLoading && <Loading what="order" />}
      {o && (
        <>
          <div className="tbl-wrap"><table>
            <thead><tr><th className="code">SKU</th><th>Item</th><th className="num">Ordered</th><th className="num">{O.done}</th><th className="num">Still open</th><th className="num">{O.price}</th></tr></thead>
            <tbody>{o.lines.map((l) => <tr key={l.id}><td className="code">{l.sku}</td><td className="name">{l.item_name}</td><td className="num">{qtyText(l.quantity)}</td><td className="num">{qtyText(l.done_qty)}</td><td className="num">{qtyText(l.open_qty)}</td><td className="num">{formatApiNum(l.price)}</td></tr>)}</tbody>
          </table></div>
          <div className="statement" style={{ maxWidth: 320, marginLeft: 'auto', marginTop: 16 }}><div className="ln sum"><span>Total</span><span className="dots" /><span className="num">{formatApiNum(o.total)}</span></div></div>
          <Move kind={kind} order={o} mode={moving ?? 'move'} open={moving !== null} onClose={() => setMoving(null)} onDone={() => { toast(moving === 'return' ? 'Goods returned' : kind === 'po' ? 'Goods received' : 'Goods delivered'); refresh(); }} />
        </>
      )}
    </>
  );
}

function Move({ kind, order, mode, open, onClose, onDone }: { kind: OrderKind; order: Order; mode: 'move' | 'return'; open: boolean; onClose: () => void; onDone: () => void }) {
  const O = ORDERS[kind];
  const [date, setDate] = useState(todayIso());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => (mode === 'return' ? stock.fulfilReturn : stock.fulfil)(kind, order.id, date, order.lines.filter((l) => parseAmount(qty[l.id] ?? '') !== null && parseAmount(qty[l.id] ?? '') !== 0n).map((l) => ({ line_id: l.id, quantity: toApi(parseAmount(qty[l.id]!)!) }))),
    onSuccess: () => { onDone(); setQty({}); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not post.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!order.lines.some((l) => parseAmount(qty[l.id] ?? '') !== null && parseAmount(qty[l.id] ?? '') !== 0n)) return setErr('Enter a quantity on at least one line.');
    m.mutate();
  };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title={mode === 'return' ? 'Return goods' : `${O.Act} goods`}>
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="mdt">Date</label><input id="mdt" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
        {order.lines.filter((l) => (mode === 'return' ? l.done_qty !== '0.0000' : l.open_qty !== '0.0000')).map((l) => (
          <div key={l.id}><label htmlFor={`q${l.id}`}>{l.sku} · {l.item_name} ({mode === 'return' ? `${qtyText(l.done_qty)} ${kind === 'po' ? 'received' : 'delivered'}` : `open ${qtyText(l.open_qty)}`})</label><input id={`q${l.id}`} inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} style={{ maxWidth: 140 }} /></div>
        ))}
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>{mode === 'return' ? 'Return' : O.Act}</button></div>
      </form>
    </Dialog>
  );
}
