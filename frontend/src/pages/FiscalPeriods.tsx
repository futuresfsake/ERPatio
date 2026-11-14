import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, endpoints, type Period } from '../api';
import { useAuth } from '../auth';
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
            <h2 style={{ marginBottom: 8 }}>{y}</h2>
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
