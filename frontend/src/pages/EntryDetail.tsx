import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, endpoints } from '../api';
import { useAuth } from '../auth';
import { formatNum, fromApi } from '../lib/money';
import { Dialog, Loading, longDate, Problem, useToast } from '../ui';

export function EntryDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const fresh = (useLocation().state as { fresh?: boolean } | null)?.fresh === true;
  const toast = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({ queryKey: ['entry', id], queryFn: () => endpoints.entry(id) });
  const reverse = useMutation({
    mutationFn: () => endpoints.reverse(id),
    onSuccess: (e) => {
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['entries'] });
      void qc.invalidateQueries({ queryKey: ['entry'] });
      void qc.invalidateQueries({ queryKey: ['tb'] });
      toast(`Posted JE-${e.entry_no}`);
      nav(`/journal/${e.id}`, { state: { fresh: true } });
    },
  });
  const e = q.data;
  const total = e ? fromApi(e.total) : 0n;

  if (q.error instanceof ApiError && q.error.status === 404)
    return <><div className="page-head"><h1>Entry not found</h1></div><p className="muted">There is no such entry in this workspace.</p></>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb"><Link to="/journal">Journal</Link> /</div>
          <h1>{e ? `JE-${e.entry_no}` : 'Journal entry'}</h1>
        </div>
        <div className="actions">
          {e && <span className={`stamp${fresh ? ' thunk' : ''}`}>Posted {longDate(e.entry_date)}</span>}
          {e?.reversed_by_entry_id && <span className="stamp reversed">Reversed</span>}
          {e && can('journal:reverse') && !e.reverses_entry_id && !e.reversed_by_entry_id && (
            <button className="btn danger" onClick={() => setConfirm(true)}>Reverse entry…</button>
          )}
        </div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="entry" />}
      {e && (
        <>
          <dl className="kv">
            <dt>Date</dt><dd>{longDate(e.entry_date)}</dd>
            <dt>Description</dt><dd>{e.description}</dd>
            <dt>Reference</dt><dd className="mono">{e.reference ?? 'none'}</dd>
            <dt>Status</dt>
            <dd>
              Locked. Corrections are made by reversal.
              {e.reverses_entry_id && <> Reverses <Link to={`/journal/${e.reverses_entry_id}`}>an earlier entry</Link></>}
              {e.reversed_by_entry_id && <> Reversed by <Link to={`/journal/${e.reversed_by_entry_id}`}>a later entry</Link></>}
            </dd>
          </dl>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th className="code">Account</th><th>Name</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>
                {e.lines.map((l) => (
                  <tr key={l.line_no}>
                    <td className="code">{l.account_code}</td>
                    <td>{l.account_name}</td>
                    <td className="num">{fromApi(l.debit) ? formatNum(fromApi(l.debit)) : ''}</td>
                    <td className="num">{fromApi(l.credit) ? formatNum(fromApi(l.credit)) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td /><td>Total (PHP)</td><td className="num">{formatNum(total)}</td><td className="num">{formatNum(total)}</td></tr></tfoot>
            </table>
          </div>
        </>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Reverse JE-${e?.entry_no ?? ''}?`}>
        <p>This posts a new entry that swaps every debit and credit. The original stays on the books and is marked reversed. It cannot be undone.</p>
        {reverse.error && <div className="field-error" role="alert" style={{ marginTop: 10 }}>{reverse.error instanceof ApiError ? reverse.error.message : 'Could not reverse the entry.'}</div>}
        <div className="row">
          <button className="btn" onClick={() => setConfirm(false)}>Keep entry</button>
          <button className="btn danger" disabled={reverse.isPending} onClick={() => reverse.mutate()}>{reverse.isPending ? 'Reversing…' : 'Reverse entry'}</button>
        </div>
      </Dialog>
    </>
  );
}
