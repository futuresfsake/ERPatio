import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { formatApiNum, parseAmount, toApi } from '../lib/money';
import { prod, type WoDetail } from '../production';
import { stock } from '../stock';
import { Dialog, Loading, longDate, Problem, todayIso, useToast } from '../ui';

const qtyText = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const STATUS = { draft: 'Draft', released: 'Released', completed: 'Complete', closed: 'Closed short', cancelled: 'Cancelled' } as const;
const label = (w: { no: string | null }) => (w.no ? `WO-${w.no}` : 'Draft');

export function BomPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['boms'], queryFn: prod.boms });
  const detail = useQuery({ queryKey: ['bom', open], queryFn: () => prod.bom(open!), enabled: !!open });
  return (
    <>
      <div className="page-head">
        <div><h1>Bills of materials</h1><p className="sub">Saving a bill creates a new version and makes it the active one. Work orders keep the version they were made from.</p></div>
        <div className="actions">{can('production:write') && <button className="btn primary" onClick={() => setAdding(true)}>New bill</button>}</div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="bills" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th className="code">Product</th><th>Name</th><th className="num">Version</th><th className="num">Makes</th><th>Status</th></tr></thead>
          <tbody>
            {q.data.map((b) => <tr key={b.id} className={b.is_active ? '' : 'off'}><td className="code"><button className="linkbtn" onClick={() => setOpen(open === b.id ? null : b.id)}>{b.sku}</button></td><td className="name">{b.item_name}</td><td className="num">{b.version}</td><td className="num">{qtyText(b.output_qty)}</td><td>{b.is_active ? 'Active' : 'Replaced'}</td></tr>)}
            {q.data.length === 0 && <tr><td colSpan={5} className="empty">No bills of materials yet.</td></tr>}
          </tbody>
        </table></div>
      )}
      {detail.data && (
        <section style={{ marginTop: 20 }}>
          <h2>{detail.data.sku} version {detail.data.version}: for {qtyText(detail.data.output_qty)} {detail.data.note ? `· ${detail.data.note}` : ''}</h2>
          <div className="tbl-wrap"><table>
            <thead><tr><th className="code">Component</th><th>Name</th><th className="num">Quantity</th><th className="num">Avg cost now</th></tr></thead>
            <tbody>{detail.data.lines.map((l) => <tr key={l.item_id}><td className="code">{l.sku}</td><td className="name">{l.name}</td><td className="num">{qtyText(l.quantity)} {l.uom}</td><td className="num">{formatApiNum(l.unit_cost)}</td></tr>)}</tbody>
          </table></div>
          <p className="muted" style={{ marginTop: 8 }}>Estimated cost of one unit at today's average costs: {formatApiNum(detail.data.estimated_unit_cost)}.</p>
        </section>
      )}
      <NewBom open={adding} onClose={() => setAdding(false)} onDone={() => { toast('Bill saved'); void qc.invalidateQueries({ queryKey: ['boms'] }); }} />
    </>
  );
}

function NewBom({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const items = useQuery({ queryKey: ['items'], queryFn: stock.items, enabled: open });
  const [item, setItem] = useState('');
  const [out, setOut] = useState('1');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([{ item_id: '', quantity: '' }]);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => prod.createBom({ item_id: item, output_qty: toApi(parseAmount(out)!), ...(note.trim() && { note: note.trim() }), lines: lines.map((l) => ({ item_id: l.item_id, quantity: toApi(parseAmount(l.quantity)!) })) }),
    onSuccess: () => { onDone(); setItem(''); setOut('1'); setNote(''); setLines([{ item_id: '', quantity: '' }]); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!item) return setErr('Choose the product.');
    if (parseAmount(out) === null || parseAmount(out) === 0n) return setErr('Enter how many units the bill makes.');
    if (lines.some((l) => !l.item_id || parseAmount(l.quantity) === null || parseAmount(l.quantity) === 0n)) return setErr('Every component needs an item and a quantity.');
    m.mutate();
  };
  const active = (items.data ?? []).filter((i) => i.is_active);
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="New bill of materials">
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="bp">Product</label><select id="bp" value={item} onChange={(e) => setItem(e.target.value)}><option value="">Choose…</option>{active.map((i) => <option key={i.id} value={i.id}>{i.sku} · {i.name}</option>)}</select></div>
        <div><label htmlFor="bo">Quantity this bill makes</label><input id="bo" inputMode="decimal" value={out} onChange={(e) => setOut(e.target.value)} style={{ maxWidth: 140 }} /></div>
        <div><label htmlFor="bn">Note</label><input id="bn" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></div>
        {lines.map((l, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <select aria-label={`Component ${i + 1}`} value={l.item_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, item_id: e.target.value } : x)))}><option value="">Component…</option>{active.filter((c) => c.id !== item).map((c) => <option key={c.id} value={c.id}>{c.sku} · {c.name}</option>)}</select>
            <input aria-label={`Quantity ${i + 1}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} style={{ width: 100, textAlign: 'right' }} />
            {lines.length > 1 && <button type="button" className="linkbtn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        <div><button type="button" className="btn" onClick={() => setLines([...lines, { item_id: '', quantity: '' }])}>Add component</button></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Save as new version</button></div>
      </form>
    </Dialog>
  );
}

export function WorkOrderList() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['wos'], queryFn: prod.orders });
  return (
    <>
      <div className="page-head">
        <div><h1>Work orders</h1><p className="sub">Materials issued sit in work in progress until output is reported.</p></div>
        <div className="actions">{can('production:write') && <button className="btn primary" onClick={() => setAdding(true)}>New work order</button>}</div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="work orders" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>No.</th><th>Product</th><th>Planned</th><th className="num">Qty</th><th className="num">Done</th><th>Status</th><th className="num">In progress</th></tr></thead>
          <tbody>
            {q.data.items.map((w) => <tr key={w.id}><td className="code"><Link to={`/work-orders/${w.id}`}>{label(w)}</Link></td><td className="name">{w.sku} · {w.item_name}</td><td>{longDate(w.planned_date)}</td><td className="num">{qtyText(w.qty_planned)}</td><td className="num">{qtyText(w.qty_completed)}</td><td>{STATUS[w.status]}</td><td className="num">{w.status === 'draft' ? '' : formatApiNum(w.wip)}</td></tr>)}
            {q.data.items.length === 0 && <tr><td colSpan={7} className="empty">No work orders yet.</td></tr>}
          </tbody>
        </table></div>
      )}
      <NewWo open={adding} onClose={() => setAdding(false)} onDone={(id) => { toast('Draft saved'); void qc.invalidateQueries({ queryKey: ['wos'] }); nav(`/work-orders/${id}`); }} />
    </>
  );
}

function NewWo({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const boms = useQuery({ queryKey: ['boms'], queryFn: prod.boms, enabled: open });
  const [item, setItem] = useState('');
  const [qty, setQty] = useState('');
  const [date, setDate] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => prod.createOrder({ item_id: item, quantity: toApi(parseAmount(qty)!), planned_date: date }),
    onSuccess: (w) => { onDone(w.id); setItem(''); setQty(''); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!item) return setErr('Choose a product.'); if (parseAmount(qty) === null || parseAmount(qty) === 0n) return setErr('Enter a quantity.'); m.mutate(); };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="New work order">
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="wp">Product</label><select id="wp" value={item} onChange={(e) => setItem(e.target.value)}><option value="">Choose…</option>{(boms.data ?? []).filter((b) => b.is_active).map((b) => <option key={b.id} value={b.item_id}>{b.sku} · {b.item_name}</option>)}</select><div className="hint">Only products with an active bill of materials.</div></div>
        <div><label htmlFor="wq">Quantity</label><input id="wq" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ maxWidth: 140 }} /></div>
        <div><label htmlFor="wd">Planned date</label><input id="wd" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Save draft</button></div>
      </form>
    </Dialog>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [dlg, setDlg] = useState<'issue' | 'complete' | 'close' | null>(null);
  const q = useQuery({ queryKey: ['wo', id], queryFn: () => prod.order(id!) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['wo', id] }); void qc.invalidateQueries({ queryKey: ['wos'] }); void qc.invalidateQueries({ queryKey: ['items'] }); void qc.invalidateQueries({ queryKey: ['wip'] }); };
  const act = useMutation({
    mutationFn: (a: 'release' | 'cancel' | 'delete'): Promise<unknown> => (a === 'release' ? prod.release(id!) : a === 'cancel' ? prod.cancel(id!) : prod.deleteOrder(id!)),
    onSuccess: (_r, a) => { if (a === 'delete') { toast('Draft deleted'); void qc.invalidateQueries({ queryKey: ['wos'] }); nav('/work-orders'); } else { toast(a === 'release' ? 'Released' : 'Cancelled'); refresh(); } },
  });
  const w = q.data;
  const write = can('production:write');
  const started = !!w && (parseAmount(w.materials_issued) !== 0n || w.qty_completed !== '0.0000');
  return (
    <>
      <div className="page-head">
        <div><h1>{w ? `Work order ${label(w)}` : 'Work order'}</h1>{w && <p className="sub">{w.sku} · {w.item_name} · {STATUS[w.status]} · planned {longDate(w.planned_date)} · bill version {w.bom_version}</p>}</div>
        {w && write && (
          <div className="actions">
            {w.status === 'draft' && <><button className="btn" disabled={act.isPending} onClick={() => act.mutate('delete')}>Delete draft</button><button className="btn primary" disabled={act.isPending} onClick={() => act.mutate('release')}>Release</button></>}
            {w.status === 'released' && <><button className="btn" onClick={() => setDlg('issue')}>Issue materials</button><button className="btn primary" onClick={() => setDlg('complete')}>Report output</button><button className="btn" onClick={() => setDlg('close')}>Close short</button></>}
            {(w.status === 'released') && !started && <button className="btn" disabled={act.isPending} onClick={() => act.mutate('cancel')}>Cancel</button>}
          </div>
        )}
      </div>
      <Problem error={q.error ?? act.error} />
      {q.isLoading && <Loading what="work order" />}
      {w && (
        <>
          <div className="statement" style={{ maxWidth: 460 }}>
            <div className="ln"><span>Quantity</span><span className="dots" /><span className="num">{qtyText(w.qty_completed)} of {qtyText(w.qty_planned)} {w.uom}</span></div>
            <div className="ln"><span>Materials issued</span><span className="dots" /><span className="num">{formatApiNum(w.materials_issued)}</span></div>
            <div className="ln"><span>Moved to finished goods</span><span className="dots" /><span className="num">{formatApiNum(w.materials_to_goods)}</span></div>
            {w.written_off !== '0.0000' && <div className="ln"><span>Written off</span><span className="dots" /><span className="num">{formatApiNum(w.written_off)}</span></div>}
            <div className="ln"><span>Conversion cost applied</span><span className="dots" /><span className="num">{formatApiNum(w.conversion_applied)}</span></div>
            <div className="ln sum"><span>Work in progress</span><span className="dots" /><span className="num">{formatApiNum(w.wip)}</span></div>
          </div>
          {w.components.length > 0 && (
            <div className="tbl-wrap" style={{ marginTop: 16 }}><table>
              <thead><tr><th className="code">Component</th><th>Name</th><th className="num">Required</th><th className="num">Issued</th><th className="num">Variance</th></tr></thead>
              <tbody>{w.components.map((k) => <tr key={k.item_id}><td className="code">{k.sku}</td><td className="name">{k.name}</td><td className="num">{qtyText(k.required_qty)}</td><td className="num">{qtyText(k.issued_qty)}</td><td className="num">{k.variance_qty.startsWith('-') ? '' : '+'}{qtyText(k.variance_qty)}</td></tr>)}</tbody>
            </table></div>
          )}
          <WoDialog kind={dlg} order={w} onClose={() => setDlg(null)} onDone={(m) => { toast(m); refresh(); }} />
        </>
      )}
    </>
  );
}

function WoDialog({ kind, order, onClose, onDone }: { kind: 'issue' | 'complete' | 'close' | null; order: WoDetail; onClose: () => void; onDone: (m: string) => void }) {
  const [date, setDate] = useState(todayIso());
  const [qty, setQty] = useState('');
  const [conv, setConv] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => kind === 'issue' ? prod.issue(order.id, date) : kind === 'complete' ? prod.complete(order.id, date, toApi(parseAmount(qty)!), toApi(parseAmount(conv || '0')!)) : prod.close(order.id, date),
    onSuccess: () => { onDone(kind === 'issue' ? 'Materials issued' : kind === 'complete' ? 'Output reported' : 'Order closed'); setQty(''); setConv(''); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not post.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'complete' && (parseAmount(qty) === null || parseAmount(qty) === 0n)) return setErr('Enter the quantity finished.');
    if (kind === 'complete' && conv && parseAmount(conv) === null) return setErr('Conversion cost looks like 1250.50.');
    m.mutate();
  };
  const title = kind === 'issue' ? 'Issue materials' : kind === 'complete' ? 'Report output' : 'Close short';
  return (
    <Dialog open={kind !== null} onClose={() => { setErr(null); onClose(); }} title={title}>
      <form onSubmit={submit} className="stack" noValidate>
        {kind === 'issue' && <p>Issues everything still required for this order from stock, at the average cost. If stock is short nothing is issued.</p>}
        {kind === 'close' && <p>Whatever is left in work in progress ({formatApiNum(order.wip)}) is written off to Production Variance. The order cannot be reopened.</p>}
        <div><label htmlFor="wdd">Date</label><input id="wdd" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
        {kind === 'complete' && <>
          <div><label htmlFor="wcq">Quantity finished (up to {qtyText(String(Number(order.qty_planned) - Number(order.qty_completed)))})</label><input id="wcq" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ maxWidth: 140 }} autoFocus /></div>
          <div><label htmlFor="wcc">Labor and overhead for this output</label><input id="wcc" inputMode="decimal" value={conv} onChange={(e) => setConv(e.target.value)} style={{ maxWidth: 160 }} /><div className="hint">Credited to Conversion Cost Applied and added to the finished goods cost.</div></div>
        </>}
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>{title}</button></div>
      </form>
    </Dialog>
  );
}

export function WipPage() {
  const [asOf, setAsOf] = useState(todayIso());
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const q = useQuery({ queryKey: ['wip', asOf], queryFn: () => prod.wip(asOf), enabled: ok });
  const r = q.data;
  return (
    <>
      <div className="page-head">
        <div><h1>Work in progress</h1><p className="sub">What each open order holds, set against the work in progress account.</p></div>
        <div className="actions"><div><label htmlFor="wa">Ledger as of</label><input id="wa" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto' }} /></div></div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="work in progress" />}
      {r && (
        <>
          <div className="tbl-wrap"><table>
            <thead><tr><th>No.</th><th>Product</th><th>Status</th><th className="num">Done</th><th className="num">In progress</th></tr></thead>
            <tbody>
              {r.rows.map((x) => <tr key={x.id}><td className="code"><Link to={`/work-orders/${x.id}`}>WO-{x.no}</Link></td><td className="name">{x.sku} · {x.item_name}</td><td>{x.status}</td><td className="num">{qtyText(x.qty_completed)} / {qtyText(x.qty_planned)}</td><td className="num">{formatApiNum(x.wip)}</td></tr>)}
              {r.rows.length === 0 && <tr><td colSpan={5} className="empty">Nothing in progress.</td></tr>}
              {r.rows.length > 0 && <tr className="group"><td colSpan={4}>Total</td><td className="num">{formatApiNum(r.total_wip)}</td></tr>}
            </tbody>
          </table></div>
          <p className={r.reconciles ? 'muted' : 'notice warn'} style={{ marginTop: 12 }} role="status">
            {r.reconciles ? `Agrees with the work in progress account (${formatApiNum(r.ledger_balance)}).` : `The ledger account shows ${formatApiNum(r.ledger_balance)}, ${formatApiNum(r.variance)} ${r.variance_sign === '-' ? 'less' : 'more'} than the orders hold. A manual journal entry may have been posted to it.`}
          </p>
        </>
      )}
    </>
  );
}
