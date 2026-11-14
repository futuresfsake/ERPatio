import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, endpoints } from '../api';
import { useAuth } from '../auth';
import { formatApiNum, formatNum, fromApi, parseAmount, toApi } from '../lib/money';
import { SIDES, sub, type Doc, type DocInput, type Side } from '../subledger';
import { Dialog, Loading, longDate, Problem, todayIso, useToast } from '../ui';

const label = (S: (typeof SIDES)[Side], d: Pick<Doc, 'doc_no' | 'status'>) => (d.doc_no ? `${S.prefix}-${d.doc_no}` : 'Draft');
const Status = ({ s }: { s: Doc['status'] }) => <span className={`muted${s === 'void' ? ' off' : ''}`}>{s === 'posted' ? 'Posted' : s === 'void' ? 'Void' : 'Draft'}</span>;

export function DocumentList({ side }: { side: Side }) {
  const S = SIDES[side];
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['docs', side, status], queryFn: () => sub.docs(side, status || undefined) });
  return (
    <>
      <div className="page-head">
        <div><h1>{S.Docs}</h1><p className="sub">{side === 'ar' ? 'Posting an invoice debits receivables and credits revenue and output tax.' : 'Posting a bill debits the expense and input tax and credits payables.'}</p></div>
        <div className="actions">
          <div><label htmlFor="st">Show</label>
            <select id="st" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All</option><option value="draft">Drafts</option><option value="posted">Posted</option><option value="void">Void</option>
            </select></div>
          {can(S.write) && <Link className="btn primary" to={`/${S.docs}/new`}>New {S.doc}</Link>}
        </div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what={S.docs} />}
      {q.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>No.</th><th>{S.Party}</th><th>Date</th><th>Due</th><th>Status</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {q.data.items.map((d) => (
                <tr key={d.id}>
                  <td className="code"><Link to={`/${S.docs}/${d.id}`}>{label(S, d)}</Link></td>
                  <td className="name">{d.party_name}</td>
                  <td>{longDate(d.doc_date)}</td>
                  <td>{longDate(d.due_date)}</td>
                  <td><Status s={d.status} /></td>
                  <td className="num">{formatApiNum(d.total)}</td>
                  <td className="num">{d.status === 'posted' ? formatApiNum(d.balance) : ''}</td>
                </tr>
              ))}
              {q.data.items.length === 0 && <tr><td colSpan={7} className="empty">No {S.docs} here yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface LineForm { description: string; account_id: string; quantity: string; unit_price: string; tax_code_id: string }
const blank = (): LineForm => ({ description: '', account_id: '', quantity: '1', unit_price: '', tax_code_id: '' });

export function DocumentEditor({ side }: { side: Side }) {
  const S = SIDES[side];
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ['doc', side, id], queryFn: () => sub.doc(side, id!), enabled: !!id });
  const parties = useQuery({ queryKey: ['parties', side], queryFn: () => sub.parties(side) });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const codes = useQuery({ queryKey: ['tax-codes'], queryFn: sub.taxCodes });
  const [party, setParty] = useState('');
  const [date, setDate] = useState(todayIso());
  const [due, setDue] = useState('');
  const [ref, setRef] = useState('');
  const [lines, setLines] = useState<LineForm[]>([blank()]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (existing.data && loaded !== existing.data.id) {
    const d = existing.data;
    setLoaded(d.id); setParty(d.party_id); setDate(d.doc_date); setDue(d.due_date); setRef(d.reference ?? '');
    setLines(d.lines.map((l) => ({ description: l.description, account_id: l.account_id, quantity: l.quantity.replace(/\.?0+$/, '') || '0', unit_price: l.unit_price.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), tax_code_id: l.tax_code_id ?? '' })));
  }

  const wantedTax = side === 'ar' ? 'output' : 'input';
  const usable = (codes.data ?? []).filter((c) => c.is_active && c.kind === wantedTax);
  const postable = (accounts.data ?? []).filter((a) => a.is_active && (side === 'ar' ? a.type === 'revenue' : a.type !== 'revenue' && a.type !== 'equity'));

  // Live preview in integer units; the server recomputes and is the authority.
  const preview = useMemo(() => {
    let net = 0n; let tax = 0n;
    for (const l of lines) {
      const q = parseAmount(l.quantity); const p = parseAmount(l.unit_price);
      if (q === null || p === null) continue;
      const n = ((q * p + 500000n) / 1000000n) * 100n;
      const rate = fromApi(usable.find((c) => c.id === l.tax_code_id)?.rate ?? '0');
      net += n; tax += (((n * rate) / 100n + 500000n) / 1000000n) * 100n;
    }
    return { net, tax, total: net + tax };
  }, [lines, usable]);

  const save = useMutation({
    mutationFn: (input: DocInput) => (id ? sub.updateDoc(side, id, input) : sub.createDoc(side, input)),
    onSuccess: (d) => { toast('Draft saved'); void qc.invalidateQueries({ queryKey: ['docs', side] }); void qc.invalidateQueries({ queryKey: ['doc', side, d.id] }); nav(`/${S.docs}/${d.id}`); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });

  const set = (i: number, k: keyof LineForm, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!party) return setErr(`Choose a ${S.party}.`);
    for (const [i, l] of lines.entries()) {
      if (!l.description.trim() || !l.account_id) return setErr(`Line ${i + 1} needs a description and an account.`);
      if (parseAmount(l.quantity) === null || parseAmount(l.unit_price) === null) return setErr(`Line ${i + 1} has an amount that is not a number.`);
    }
    save.mutate({
      party_id: party, doc_date: date, ...(due && { due_date: due }), ...(ref.trim() && { reference: ref.trim() }),
      lines: lines.map((l) => ({ description: l.description.trim(), account_id: l.account_id, quantity: toApi(parseAmount(l.quantity)!), unit_price: toApi(parseAmount(l.unit_price)!), tax_code_id: l.tax_code_id || null })),
    });
  };

  if (id && existing.isLoading) return <Loading what={S.doc} />;
  if (existing.data && existing.data.status !== 'draft') return <div className="notice warn">A posted {S.doc} cannot be edited. <Link to={`/${S.docs}/${id}`}>Open it</Link>.</div>;

  return (
    <>
      <div className="page-head"><div><h1>{id ? `Edit draft ${S.doc}` : `New ${S.doc}`}</h1><p className="sub">Nothing reaches the ledger until you post it.</p></div></div>
      <Problem error={existing.error ?? parties.error ?? accounts.error} />
      <form onSubmit={submit} className="stack" noValidate style={{ maxWidth: 960 }}>
        <div className="toolbar">
          <div><label htmlFor="dp">{S.Party}</label>
            <select id="dp" value={party} onChange={(e) => setParty(e.target.value)} style={{ minWidth: 220 }}>
              <option value="">Choose…</option>{(parties.data ?? []).filter((p) => p.is_active || p.id === party).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </select></div>
          <div><label htmlFor="dd">Date</label><input id="dd" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
          <div><label htmlFor="du">Due</label><input id="du" type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ width: 'auto' }} /><div className="hint">Blank uses the {S.party}'s terms.</div></div>
          <div><label htmlFor="dr">Reference</label><input id="dr" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} /></div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Description</th><th>Account</th><th className="num">Qty</th><th className="num">Unit price</th><th>Tax</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => set(i, 'description', e.target.value)} maxLength={300} /></td>
                  <td><select aria-label={`Line ${i + 1} account`} value={l.account_id} onChange={(e) => set(i, 'account_id', e.target.value)}><option value="">Choose…</option>{postable.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></td>
                  <td><input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} style={{ width: 80, textAlign: 'right' }} /></td>
                  <td><input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" value={l.unit_price} onChange={(e) => set(i, 'unit_price', e.target.value)} style={{ width: 110, textAlign: 'right' }} /></td>
                  <td><select aria-label={`Line ${i + 1} tax`} value={l.tax_code_id} onChange={(e) => set(i, 'tax_code_id', e.target.value)}><option value="">No tax</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></td>
                  <td>{lines.length > 1 && <button type="button" className="linkbtn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="toolbar"><button type="button" className="btn" onClick={() => setLines([...lines, blank()])} disabled={lines.length >= 100}>Add line</button></div>
        <div className="statement" style={{ maxWidth: 360, marginLeft: 'auto' }}>
          <div className="ln"><span>Subtotal</span><span className="dots" /><span className="num">{formatNum(preview.net)}</span></div>
          <div className="ln"><span>Tax</span><span className="dots" /><span className="num">{formatNum(preview.tax)}</span></div>
          <div className="ln sum"><span>Total</span><span className="dots" /><span className="num">{formatNum(preview.total)}</span></div>
        </div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><Link className="btn" to={`/${S.docs}`}>Cancel</Link><button className="btn primary" disabled={save.isPending}>Save draft</button></div>
      </form>
    </>
  );
}

export function DocumentDetail({ side }: { side: Side }) {
  const S = SIDES[side];
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const q = useQuery({ queryKey: ['doc', side, id], queryFn: () => sub.doc(side, id!) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['doc', side, id] }); void qc.invalidateQueries({ queryKey: ['docs', side] }); };
  const act = useMutation({
    mutationFn: (a: 'post' | 'void' | 'delete'): Promise<unknown> => (a === 'post' ? sub.postDoc(side, id!) : a === 'void' ? sub.voidDoc(side, id!) : sub.deleteDoc(side, id!)),
    onSuccess: (_r, a) => { if (a === 'delete') { toast('Draft deleted'); void qc.invalidateQueries({ queryKey: ['docs', side] }); nav(`/${S.docs}`); } else { toast(a === 'post' ? 'Posted to the ledger' : 'Voided'); refresh(); } },
  });
  const d = q.data;
  const write = can(S.write);
  return (
    <>
      <div className="page-head">
        <div><h1>{d ? `${S.Doc} ${label(S, d)}` : S.Doc}</h1>{d && <p className="sub">{d.party_name} · <Status s={d.status} /></p>}</div>
        {d && write && (
          <div className="actions">
            {d.status === 'draft' && <><Link className="btn" to={`/${S.docs}/${d.id}/edit`}>Edit</Link><button className="btn" disabled={act.isPending} onClick={() => act.mutate('delete')}>Delete draft</button><button className="btn primary" disabled={act.isPending} onClick={() => act.mutate('post')}>Post to ledger</button></>}
            {d.status === 'posted' && fromApi(d.balance) > 0n && <button className="btn primary" onClick={() => setPaying(true)}>Record {S.PayOne.toLowerCase()}</button>}
            {d.status === 'posted' && fromApi(d.paid_total) === 0n && <button className="btn" disabled={act.isPending} onClick={() => { if (window.confirm(`Void ${label(S, d)}? The ledger entry is reversed.`)) act.mutate('void'); }}>Void</button>}
          </div>
        )}
      </div>
      <Problem error={q.error ?? act.error} />
      {q.isLoading && <Loading what={S.doc} />}
      {d && (
        <>
          <p className="muted">Dated {longDate(d.doc_date)} · due {longDate(d.due_date)}{d.reference ? ` · ref ${d.reference}` : ''}{d.journal_entry_id && <> · <Link to={`/journal/${d.journal_entry_id}`}>ledger entry</Link></>}</p>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Description</th><th>Account</th><th className="num">Qty</th><th className="num">Unit price</th><th>Tax</th><th className="num">Net</th><th className="num">Tax</th></tr></thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.line_no}><td className="name">{l.description}</td><td className="code">{l.account_code}</td><td className="num">{formatApiNum(l.quantity)}</td><td className="num">{formatApiNum(l.unit_price)}</td><td>{l.tax_code ?? ''}</td><td className="num">{formatApiNum(l.net)}</td><td className="num">{formatApiNum(l.tax)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="statement" style={{ maxWidth: 360, marginLeft: 'auto', marginTop: 16 }}>
            <div className="ln"><span>Subtotal</span><span className="dots" /><span className="num">{formatApiNum(d.subtotal)}</span></div>
            <div className="ln"><span>Tax</span><span className="dots" /><span className="num">{formatApiNum(d.tax_total)}</span></div>
            <div className="ln sum"><span>Total</span><span className="dots" /><span className="num">{formatApiNum(d.total)}</span></div>
            {d.status !== 'draft' && <><div className="ln"><span>{S.paid}</span><span className="dots" /><span className="num">{formatApiNum(d.paid_total)}</span></div>
              <div className="ln sum"><span>Balance</span><span className="dots" /><span className="num">{formatApiNum(d.balance)}</span></div></>}
          </div>
          {d.payments.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>{S.PayOne}s against this {S.doc}</h2>
              <div className="tbl-wrap"><table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th className="num">Amount</th></tr></thead>
                <tbody>{d.payments.map((p) => <tr key={p.payment_id}><td>{longDate(p.pay_date)}</td><td>{p.method}</td><td>{p.reference ?? ''}</td><td className="num">{formatApiNum(p.amount)}</td></tr>)}</tbody></table></div>
            </>
          )}
          <PayDialog side={side} doc={d} open={paying} onClose={() => setPaying(false)} onDone={() => { toast(`${S.PayOne} recorded`); refresh(); }} />
        </>
      )}
    </>
  );
}

function PayDialog({ side, doc, open, onClose, onDone }: { side: Side; doc: Doc; open: boolean; onClose: () => void; onDone: () => void }) {
  const S = SIDES[side];
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts, enabled: open });
  const [bank, setBank] = useState('');
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank');
  const [ref, setRef] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const assets = (accounts.data ?? []).filter((a) => a.is_active && a.type === 'asset');
  const pay = useMutation({
    mutationFn: () => sub.pay(side, { party_id: doc.party_id, pay_date: date, bank_account_id: bank, method, ...(ref.trim() && { reference: ref.trim() }), allocations: [{ document_id: doc.id, amount: amount ? toApi(parseAmount(amount)!) : toApi(fromApi(doc.balance)) }] }),
    onSuccess: () => { onDone(); setAmount(''); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not record.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!bank) return setErr('Choose the cash or bank account.');
    if (amount && (parseAmount(amount) === null || parseAmount(amount) === 0n)) return setErr('Enter an amount like 1250.50.');
    pay.mutate();
  };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title={`Record ${S.PayOne.toLowerCase()}`}>
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="pa">Amount</label><input id="pa" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={formatApiNum(doc.balance)} autoFocus /><div className="hint">Leave blank to settle the full balance of {formatApiNum(doc.balance)}.</div></div>
        <div><label htmlFor="pdt">Date</label><input id="pdt" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
        <div><label htmlFor="pb">{side === 'ar' ? 'Deposited to' : 'Paid from'}</label>
          <select id="pb" value={bank} onChange={(e) => setBank(e.target.value)}><option value="">Choose…</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
        <div><label htmlFor="pm">Method</label><select id="pm" value={method} onChange={(e) => setMethod(e.target.value)}>{['bank', 'cash', 'check', 'card', 'online'].map((m) => <option key={m}>{m}</option>)}</select></div>
        <div><label htmlFor="prf">Reference</label><input id="prf" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} /></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={pay.isPending}>Record</button></div>
      </form>
    </Dialog>
  );
}
