import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, endpoints, type Period } from '../api';
import { useAuth } from '../auth';
import { formatApiNum } from '../lib/money';
import { sub } from '../subledger';
import { Dialog, Loading, Problem, useToast } from '../ui';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const day = (iso: string) => new Date(`${iso}T00:00`).toLocaleDateString('en-PH', { day: 'numeric', month: 'short' });

export function FiscalPeriods() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const manage = can('periods:manage');
  const q = useQuery({ queryKey: ['periods'], queryFn: endpoints.periods });
  const [reopening, setReopening] = useState<Period | null>(null);
  const [reason, setReason] = useState('');
  const [addingYear, setAddingYear] = useState(false);
  const [year, setYear] = useState('');
  const [closingYear, setClosingYear] = useState<number | null>(null);
  const preview = useQuery({ queryKey: ['closing-preview', closingYear], queryFn: () => sub.closingPreview(closingYear!), enabled: closingYear !== null });
  const closeYear = useMutation({
    mutationFn: () => sub.closeYear(closingYear!),
    onSuccess: () => { toast(`Fiscal year ${closingYear} closed`); setClosingYear(null); void qc.invalidateQueries({ queryKey: ['accounts'] }); void refresh(); },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['periods'] });
  const close = useMutation({
    mutationFn: (p: Period) => endpoints.closePeriod(p.id),
    onSuccess: () => { toast('Period closed'); void refresh(); },
  });
  const reopen = useMutation({
    mutationFn: () => endpoints.reopenPeriod(reopening!.id, reason.trim()),
    onSuccess: () => { toast('Period reopened'); setReopening(null); setReason(''); void refresh(); },
  });
  const addYear = useMutation({
    mutationFn: () => endpoints.createYear(Number(year)),
    onSuccess: () => { toast(`Fiscal year ${year} created`); setAddingYear(false); void refresh(); },
  });

  const years = [...new Set((q.data ?? []).map((p) => p.year))];
  const nextYear = years.length ? Math.max(...years) + 1 : new Date().getFullYear();
  const submitYear = (e: FormEvent) => { e.preventDefault(); if (/^\d{4}$/.test(year)) addYear.mutate(); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Fiscal periods</h1>
          <p className="sub">Closing a month locks it: nothing can be posted to it until it is reopened with a reason.</p>
        </div>
        <div className="actions">{manage && <button className="btn" onClick={() => { setYear(String(nextYear)); setAddingYear(true); }}>Add fiscal year</button>}</div>
      </div>
      <Problem error={q.error ?? close.error} />
      {q.isLoading && <Loading what="periods" />}
      <div className="stack" style={{ gap: 24 }}>
        {years.map((y) => (
          <section key={y}>
            <div className="toolbar"><h2 style={{ marginBottom: 8 }}>{y}</h2>{manage && <button className="linkbtn" onClick={() => setClosingYear(y)}>Close the year…</button>}</div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Month</th><th className="hide-sm">Dates</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {(q.data ?? []).filter((p) => p.year === y).map((p) => (
                    <tr key={p.id}>
                      <td>{MONTHS[p.month - 1]}</td>
                      <td className="ref hide-sm">{day(p.start_date)} to {day(p.end_date)}</td>
                      <td>
                        {p.status === 'closed' ? <b>Closed</b> : 'Open'}
                        {p.status === 'open' && p.open_drafts > 0 && <span className="muted"> · {p.open_drafts} draft{p.open_drafts === 1 ? '' : 's'} dated here</span>}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--sans)' }}>
                        {manage && p.status === 'open' && <button className="linkbtn" disabled={close.isPending} onClick={() => close.mutate(p)}>Close</button>}
                        {manage && p.status === 'closed' && <button className="linkbtn" onClick={() => { setReopening(p); setReason(''); }}>Reopen…</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      <Dialog open={closingYear !== null} onClose={() => setClosingYear(null)} title={`Close fiscal year ${closingYear ?? ''}`}>
        <p>One entry dated 31 December moves the year's revenue and expenses into retained earnings. The income statement for the year is unchanged. It cannot be undone from the journal.</p>
        {preview.isLoading && <Loading what="preview" />}
        <Problem error={preview.error ?? closeYear.error} />
        {preview.data && (
          <div className="stack" style={{ marginTop: 12 }}>
            {preview.data.already_closed && <div className="notice warn">This year has already been closed.</div>}
            {preview.data.open_drafts > 0 && <div className="notice warn">{preview.data.open_drafts} draft entries are dated in this year. Post or delete them first.</div>}
            <div className="tbl-wrap"><table><tbody>
              {preview.data.accounts.map((a) => <tr key={a.account_id}><td className="code">{a.code}</td><td>{a.name}</td><td className="num">{formatApiNum(a.balance)} {a.side === 'credit' ? 'Cr' : 'Dr'}</td></tr>)}
              {preview.data.accounts.length === 0 && <tr><td className="empty">No revenue or expense to close.</td></tr>}
            </tbody></table></div>
            <p><b>{preview.data.net_income.startsWith('-') ? 'Loss' : 'Profit'}</b> carried to retained earnings: {formatApiNum(preview.data.net_income.replace('-', ''))}</p>
          </div>
        )}
        <div className="row">
          <button className="btn" onClick={() => setClosingYear(null)}>Cancel</button>
          <button className="btn primary" disabled={!preview.data || preview.data.already_closed || preview.data.open_drafts > 0 || preview.data.accounts.length === 0 || closeYear.isPending} onClick={() => closeYear.mutate()}>Close the year</button>
        </div>
      </Dialog>

      <Dialog open={!!reopening} onClose={() => setReopening(null)} title={reopening ? `Reopen ${MONTHS[reopening.month - 1]} ${reopening.year}?` : ''}>
        <p>Postings are allowed again until you close it. The reason is kept in the audit log.</p>
        <div className="stack" style={{ marginTop: 12 }}>
          <div><label htmlFor="why">Reason</label><input id="why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" autoFocus /></div>
          <Problem error={reopen.error} />
        </div>
        <div className="row">
          <button className="btn" onClick={() => setReopening(null)}>Keep closed</button>
          <button className="btn primary" disabled={reason.trim().length < 3 || reopen.isPending} onClick={() => reopen.mutate()}>Reopen</button>
        </div>
      </Dialog>

      <Dialog open={addingYear} onClose={() => setAddingYear(false)} title="Add fiscal year">
        <form onSubmit={submitYear} className="stack" noValidate>
          <div>
            <label htmlFor="yr">Year</label>
            <input id="yr" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" maxLength={4} autoComplete="off" autoFocus />
            <div className="hint">Creates twelve open monthly periods, January to December.</div>
          </div>
          {addYear.error && <div className="field-error" role="alert">{addYear.error instanceof ApiError ? addYear.error.message : 'Could not create the year.'}</div>}
          <div className="row">
            <button type="button" className="btn" onClick={() => setAddingYear(false)}>Cancel</button>
            <button className="btn primary" disabled={addYear.isPending}>Create</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
