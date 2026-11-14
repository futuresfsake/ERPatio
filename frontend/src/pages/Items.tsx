import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { downloadCsv } from '../lib/csv';
import { formatApiNum, parseAmount, toApi } from '../lib/money';
import { stock, type Item } from '../stock';
import { Dialog, Loading, longDate, Problem, todayIso, useToast } from '../ui';

const qtyText = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function Items() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const write = can('inventory:write');
  const [adding, setAdding] = useState(false);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const q = useQuery({ queryKey: ['items'], queryFn: stock.items });
  const toggle = useMutation({ mutationFn: (i: Item) => stock.updateItem(i.id, { is_active: !i.is_active }), onSuccess: () => qc.invalidateQueries({ queryKey: ['items'] }) });
  const done = (m: string) => { toast(m); void qc.invalidateQueries({ queryKey: ['items'] }); void qc.invalidateQueries({ queryKey: ['valuation'] }); };
  return (
    <>
      <div className="page-head">
        <div><h1>Items</h1><p className="sub">Stock is valued at the moving average cost. One location per workspace.</p></div>
        <div className="actions">{write && <button className="btn primary" onClick={() => setAdding(true)}>Add item</button>}</div>
      </div>
      <Problem error={q.error ?? toggle.error} />
      {q.isLoading && <Loading what="items" />}
      {q.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th className="code">SKU</th><th>Name</th><th className="num">On hand</th><th className="num">Avg cost</th><th className="num">Value</th><th /></tr></thead>
            <tbody>
              {q.data.map((i) => (
                <tr key={i.id} className={i.is_active ? '' : 'off'}>
                  <td className="code"><Link to={`/items/${i.id}`}>{i.sku}</Link></td>
                  <td className="name">{i.name}</td>
                  <td className="num">{qtyText(i.qty_on_hand)} {i.uom}</td>
                  <td className="num">{formatApiNum(i.avg_cost)}</td>
                  <td className="num">{formatApiNum(i.value_on_hand)}</td>
                  <td className="num">{write && <><button className="linkbtn" onClick={() => setAdjusting(i)}>Adjust</button> · <button className="linkbtn" onClick={() => toggle.mutate(i)}>{i.is_active ? 'Deactivate' : 'Reactivate'}</button></>}</td>
                </tr>
              ))}
              {q.data.length === 0 && <tr><td colSpan={6} className="empty">No items yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <AddItem open={adding} onClose={() => setAdding(false)} onDone={() => done('Item added')} />
      <Adjust item={adjusting} onClose={() => setAdjusting(null)} onDone={() => done('Stock adjusted')} />
    </>
  );
}

function AddItem({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ sku: '', name: '', uom: 'pc' });
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => stock.createItem({ sku: f.sku.trim().toUpperCase(), name: f.name.trim(), uom: f.uom.trim() || 'pc' }),
    onSuccess: () => { onDone(); setF({ sku: '', name: '', uom: 'pc' }); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === 'conflict' ? 'That SKU is already used.' : e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!/^[A-Za-z0-9._-]{1,40}$/.test(f.sku.trim()) || !f.name.trim()) return setErr('Enter a SKU (letters, digits, dot, dash) and a name.'); m.mutate(); };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Add item">
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="is">SKU</label><input id="is" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} maxLength={40} autoFocus autoComplete="off" /></div>
        <div><label htmlFor="in">Name</label><input id="in" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} autoComplete="off" /></div>
        <div><label htmlFor="iu">Unit of measure</label><input id="iu" value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} maxLength={20} style={{ maxWidth: 140 }} /></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Save</button></div>
      </form>
    </Dialog>
  );
}

function Adjust({ item, onClose, onDone }: { item: Item | null; onClose: () => void; onDone: () => void }) {
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => stock.adjust({ item_id: item!.id, date, direction: dir, quantity: toApi(parseAmount(qty)!), ...(dir === 'in' && { unit_cost: toApi(parseAmount(cost)!) }), reason: reason.trim() }),
    onSuccess: () => { onDone(); setQty(''); setCost(''); setReason(''); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not adjust.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (parseAmount(qty) === null || parseAmount(qty) === 0n) return setErr('Enter a quantity like 12 or 2.5.');
    if (dir === 'in' && parseAmount(cost) === null) return setErr('A stock increase needs a unit cost.');
    if (reason.trim().length < 3) return setErr('Say why, in a few words.');
    m.mutate();
  };
  return (
    <Dialog open={!!item} onClose={() => { setErr(null); onClose(); }} title={item ? `Adjust ${item.sku}` : ''}>
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="ad">Direction</label><select id="ad" value={dir} onChange={(e) => setDir(e.target.value as 'in' | 'out')}><option value="in">Add stock</option><option value="out">Remove stock</option></select></div>
        <div><label htmlFor="aq">Quantity</label><input id="aq" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ maxWidth: 140 }} /></div>
        {dir === 'in' && <div><label htmlFor="ac2">Unit cost</label><input id="ac2" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} style={{ maxWidth: 140 }} /></div>}
        <div><label htmlFor="adt">Date</label><input id="adt" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
        <div><label htmlFor="ar2">Reason</label><input id="ar2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /><div className="hint">Recorded with the movement and posted to Inventory Adjustments.</div></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Post</button></div>
      </form>
    </Dialog>
  );
}

export function StockCard() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['stock-card', id], queryFn: () => stock.card(id!) });
  return (
    <>
      <div className="page-head"><div><h1>{q.data ? `${q.data.item.sku} · ${q.data.item.name}` : 'Stock card'}</h1><p className="sub">Every movement, newest first, with the balance after it.</p></div></div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="stock card" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Date</th><th>Movement</th><th className="num">Qty</th><th className="num">Unit cost</th><th className="num">Value</th><th className="num">Balance qty</th><th className="num">Balance value</th></tr></thead>
          <tbody>
            {q.data.movements.map((m) => (
              <tr key={m.id}><td>{longDate(m.move_date)}</td><td>{m.kind.replace('_', ' ')}{m.note ? ` · ${m.note}` : ''}</td><td className="num">{qtyText(m.qty)}</td><td className="num">{formatApiNum(m.unit_cost)}</td><td className="num">{formatApiNum(m.value.replace('-', ''))}{m.value.startsWith('-') ? ' Cr' : ''}</td><td className="num">{qtyText(m.run_qty)}</td><td className="num">{formatApiNum(m.run_value)}</td></tr>
            ))}
            {q.data.movements.length === 0 && <tr><td colSpan={7} className="empty">No movements yet.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}

export function ValuationPage() {
  const [asOf, setAsOf] = useState(todayIso());
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const q = useQuery({ queryKey: ['valuation', asOf], queryFn: () => stock.valuation(asOf), enabled: ok });
  const r = q.data;
  const csv = () => r && downloadCsv(`stock-valuation-${r.as_of}.csv`, [['Stock valuation (PHP)', r.as_of], [], ['SKU', 'Name', 'Qty', 'Avg cost', 'Value'], ...r.rows.map((x) => [x.sku, x.name, x.qty, x.avg_cost, x.value]), ['', 'Total', '', '', r.total_value]]);
  return (
    <>
      <div className="page-head">
        <div><h1>Stock valuation</h1><p className="sub">Value of stock on hand, set against the inventory account in the ledger.</p></div>
        <div className="actions"><div><label htmlFor="vd">As of</label><input id="vd" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto' }} /></div><button className="btn" disabled={!r} onClick={csv}>Download CSV</button></div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="valuation" />}
      {r && (
        <>
          <div className="tbl-wrap"><table>
            <thead><tr><th className="code">SKU</th><th>Name</th><th className="num">Qty</th><th className="num">Avg cost</th><th className="num">Value</th></tr></thead>
            <tbody>
              {r.rows.map((x) => <tr key={x.item_id}><td className="code">{x.sku}</td><td className="name">{x.name}</td><td className="num">{qtyText(x.qty)} {x.uom}</td><td className="num">{formatApiNum(x.avg_cost)}</td><td className="num">{formatApiNum(x.value)}</td></tr>)}
              {r.rows.length === 0 && <tr><td colSpan={5} className="empty">No stock on this date.</td></tr>}
              {r.rows.length > 0 && <tr className="group"><td colSpan={4}>Total</td><td className="num">{formatApiNum(r.total_value)}</td></tr>}
            </tbody>
          </table></div>
          <p className={r.reconciles ? 'muted' : 'notice warn'} style={{ marginTop: 12 }} role="status">
            {r.reconciles ? `Agrees with the inventory account in the ledger (${formatApiNum(r.ledger_balance)}).` : `The inventory account shows ${formatApiNum(r.ledger_balance)}, a difference of ${formatApiNum(r.variance.replace('-', ''))}${r.variance.startsWith('-') ? ' under' : ' over'} the stock value. A manual journal entry may have been posted to it.`}
          </p>
        </>
      )}
    </>
  );
}
