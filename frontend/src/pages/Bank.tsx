import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api, endpoints } from '../api';
import { parseCsv } from '../lib/csv';
import { formatApiNum } from '../lib/money';
import { Dialog, Loading, longDate, Problem, todayIso, useToast } from '../ui';

interface Recon {
  account: { id: string; code: string; name: string }; as_of: string; ledger_balance: string; statement_total: string; difference: string;
  unmatched_statement_total: string; unmatched_ledger_total: string; explained: boolean; reconciled: boolean; matched_count: number;
  unmatched_statement: { id: string; date: string; description: string; reference: string | null; amount: string }[];
  unmatched_ledger: { journal_line_id: string; entry_id: string; entry_no: number; date: string; description: string; amount: string }[];
  suggestions: { statement_line_id: string; journal_line_id: string; days: number; unique: boolean }[];
}

/** date,description,amount[,reference] with an optional header row. Amounts may carry commas, a minus sign or brackets. */
export function parseStatement(text: string): { date: string; description: string; amount: string; reference?: string }[] {
  const out: { date: string; description: string; amount: string; reference?: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const row = raw.trim();
    if (!row) continue;
    const cols = parseCsv(row)[0] ?? [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cols[0] ?? '')) continue; // header or junk
    let amt = (cols[2] ?? '').replace(/,/g, '');
    if (/^\(.*\)$/.test(amt)) amt = '-' + amt.slice(1, -1);
    if (!/^-?\d{1,15}(\.\d{1,4})?$/.test(amt)) continue;
    out.push({ date: cols[0]!, description: cols[1] || 'Statement line', amount: amt, ...(cols[3] && { reference: cols[3] }) });
  }
  return out;
}

export function BankPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const banks = (accounts.data ?? []).filter((a) => a.is_active && a.type === 'asset');
  const [acct, setAcct] = useState('');
  const [asOf, setAsOf] = useState(todayIso());
  const [text, setText] = useState('');
  const [posting, setPosting] = useState<Recon['unmatched_statement'][number] | null>(null);
  const id = acct || banks.find((b) => b.code === '1010')?.id || '';
  const q = useQuery({ queryKey: ['bank', id, asOf], queryFn: () => api<Recon>(`/bank/${id}/reconciliation?as_of=${asOf}`), enabled: !!id });
  const refresh = () => qc.invalidateQueries({ queryKey: ['bank'] });
  const imp = useMutation({
    mutationFn: () => api<{ added: number; skipped: number }>(`/bank/${id}/statement-lines`, { method: 'POST', json: { lines: parseStatement(text) } }),
    onSuccess: (r) => { toast(`${r.added} added, ${r.skipped} already there`); setText(''); void refresh(); },
  });
  const auto = useMutation({ mutationFn: () => api<{ matched: number }>(`/bank/${id}/auto-match?as_of=${asOf}`, { method: 'POST' }), onSuccess: (r) => { toast(`${r.matched} matched`); void refresh(); } });
  const match = useMutation({ mutationFn: (m: { s: string; l: string }) => api('/bank/matches', { method: 'POST', json: { statement_line_id: m.s, journal_line_id: m.l } }), onSuccess: () => { toast('Matched'); void refresh(); } });
  const r = q.data;
  const parsed = parseStatement(text).length;
  const sugFor = (sid: string) => r?.suggestions.find((x) => x.statement_line_id === sid);
  const ledgerOf = (lid: string) => r?.unmatched_ledger.find((x) => x.journal_line_id === lid);
  return (
    <>
      <div className="page-head">
        <div><h1>Bank reconciliation</h1><p className="sub">Import the statement, match it to the books, and post what is missing (fees, interest).</p></div>
        <div className="actions">
          <div><label htmlFor="ba">Account</label><select id="ba" value={id} onChange={(e) => setAcct(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></div>
          <div><label htmlFor="bd">As of</label><input id="bd" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto' }} /></div>
        </div>
      </div>
      <Problem error={q.error ?? imp.error ?? auto.error ?? match.error} />
      <details style={{ marginBottom: 16 }}>
        <summary>Import statement lines</summary>
        <div className="stack" style={{ marginTop: 8, maxWidth: 640 }}>
          <label htmlFor="bt">Paste CSV: date (YYYY-MM-DD), description, amount, reference. Money in is positive, money out negative.</label>
          <textarea id="bt" rows={6} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'var(--mono)' }} />
          <div className="row"><span className="muted">{parsed} line{parsed === 1 ? '' : 's'} read</span><button className="btn primary" disabled={!parsed || !id || imp.isPending} onClick={() => imp.mutate()}>Import</button></div>
        </div>
      </details>
      {q.isLoading && <Loading what="reconciliation" />}
      {r && (
        <>
          <div className="statement" style={{ maxWidth: 460 }}>
            <div className="ln"><span>Ledger balance</span><span className="dots" /><span className="num">{formatApiNum(r.ledger_balance.replace('-', ''))}{r.ledger_balance.startsWith('-') ? ' Cr' : ''}</span></div>
            <div className="ln"><span>Statement total</span><span className="dots" /><span className="num">{formatApiNum(r.statement_total.replace('-', ''))}{r.statement_total.startsWith('-') ? ' Cr' : ''}</span></div>
            <div className="ln sum"><span>Difference</span><span className="dots" /><span className="num">{formatApiNum(r.difference.replace('-', ''))}{r.difference.startsWith('-') ? ' Cr' : ''}</span></div>
          </div>
          <p className={r.reconciled ? 'muted' : 'notice warn'} style={{ marginTop: 12 }} role="status">
            {r.reconciled ? `Reconciled: ${r.matched_count} lines matched and nothing left over.` : `${r.unmatched_statement.length} statement lines and ${r.unmatched_ledger.length} ledger lines are not matched.${r.explained ? ' The difference is fully explained by them.' : ' The difference is not fully explained, so check the opening balance.'}`}
          </p>
          <div className="toolbar"><button className="btn" disabled={auto.isPending || r.suggestions.length === 0} onClick={() => auto.mutate()}>Auto-match clear cases</button></div>
          <h2>On the statement, not in the books</h2>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Suggested match</th><th /></tr></thead>
            <tbody>
              {r.unmatched_statement.map((s) => { const sg = sugFor(s.id); const l = sg && ledgerOf(sg.journal_line_id); return (
                <tr key={s.id}><td>{longDate(s.date)}</td><td className="name">{s.description}{s.reference ? ` · ${s.reference}` : ''}</td><td className="num">{formatApiNum(s.amount.replace('-', ''))}{s.amount.startsWith('-') ? ' out' : ' in'}</td>
                  <td>{l ? `JE-${l.entry_no} · ${longDate(l.date)}${sg.unique ? '' : ' (not the only candidate)'}` : ''}</td>
                  <td className="num">{sg && <button className="linkbtn" onClick={() => match.mutate({ s: s.id, l: sg.journal_line_id })}>Match</button>}{!sg && <button className="linkbtn" onClick={() => setPosting(s)}>Post to account…</button>}</td></tr>); })}
              {r.unmatched_statement.length === 0 && <tr><td colSpan={5} className="empty">Every statement line is matched.</td></tr>}
            </tbody>
          </table></div>
          <h2 style={{ marginTop: 20 }}>In the books, not on the statement</h2>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Date</th><th>Entry</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {r.unmatched_ledger.map((l) => <tr key={l.journal_line_id}><td>{longDate(l.date)}</td><td className="name">JE-{l.entry_no} · {l.description}</td><td className="num">{formatApiNum(l.amount.replace('-', ''))}{l.amount.startsWith('-') ? ' out' : ' in'}</td></tr>)}
              {r.unmatched_ledger.length === 0 && <tr><td colSpan={3} className="empty">Nothing outstanding.</td></tr>}
            </tbody>
          </table></div>
        </>
      )}
      <PostLine line={posting} accounts={(accounts.data ?? []).filter((a) => a.is_active && a.id !== id)} onClose={() => setPosting(null)} onDone={() => { toast('Posted and matched'); void refresh(); void qc.invalidateQueries({ queryKey: ['accounts'] }); }} />
    </>
  );
}

function PostLine({ line, accounts, onClose, onDone }: { line: Recon['unmatched_statement'][number] | null; accounts: { id: string; code: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [acct, setAcct] = useState('');
  const [memo, setMemo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api(`/bank/statement-lines/${line!.id}/post`, { method: 'POST', json: { account_id: acct, ...(memo.trim() && { memo: memo.trim() }) } }),
    onSuccess: () => { onDone(); setAcct(''); setMemo(''); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not post.'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!acct) return setErr('Choose the other account.'); m.mutate(); };
  return (
    <Dialog open={!!line} onClose={() => { setErr(null); onClose(); }} title="Post statement line">
      <form onSubmit={submit} className="stack" noValidate>
        {line && <p>{longDate(line.date)} · {line.description} · {formatApiNum(line.amount.replace('-', ''))} {line.amount.startsWith('-') ? 'out' : 'in'}</p>}
        <div><label htmlFor="pla">Other side of the entry</label><select id="pla" value={acct} onChange={(e) => setAcct(e.target.value)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
        <div><label htmlFor="plm">Description</label><input id="plm" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} placeholder={line?.description} /></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Post and match</button></div>
      </form>
    </Dialog>
  );
}
