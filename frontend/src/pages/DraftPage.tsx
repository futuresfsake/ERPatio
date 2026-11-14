import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, endpoints } from '../api';
import { useAuth } from '../auth';
import { formatNum, fromApi } from '../lib/money';
import { Dialog, Loading, longDate, Problem, useToast } from '../ui';
import { EntryEditor } from './EntryEditor';

/** A draft: editable by its author, readable by others, and approvable by a manager who did not write it. */
export function DraftPage() {
  const { id = '' } = useParams();
  const { user, can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [sendBack, setSendBack] = useState(false);
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['draft', id], queryFn: () => endpoints.draft(id) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: endpoints.settings });
  const d = q.data;

  const done = () => { for (const k of ['entries', 'drafts', 'draft', 'tb', 'periods']) void qc.invalidateQueries({ queryKey: [k] }); };
  const approve = useMutation({
    mutationFn: () => endpoints.postDraft(id),
    onSuccess: (e) => { done(); toast(`Posted JE-${e.entry_no}`); nav(`/journal/${e.id}`, { state: { fresh: true } }); },
  });
  const reject = useMutation({
    mutationFn: () => endpoints.rejectDraft(id, note.trim()),
    onSuccess: () => { done(); toast('Sent back to the author'); nav('/journal?tab=drafts'); },
  });

  if (q.error instanceof ApiError && q.error.status === 404)
    return <><div className="page-head"><h1>Draft not found</h1></div><p className="muted">It may have been posted or deleted.</p></>;
  if (q.isLoading || settings.isLoading) return <Loading what="draft" />;
  if (!d) return <Problem error={q.error} />;

  const own = d.created_by === user?.id;
  if (d.status === 'draft' && own && can('journal:post')) return <EntryEditor key={d.updated_at} draft={d} />;

  const needsApproval = settings.data?.require_approval ?? false;
  const canApprove = can('journal:approve') && !own && (d.status === 'submitted' || !needsApproval);
  const lines = d.lines ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb"><Link to="/journal?tab=drafts">Drafts</Link> /</div>
          <h1>{d.status === 'submitted' ? 'Waiting for approval' : 'Draft entry'}</h1>
          <p className="sub">By {d.created_by_name}. Not in the ledger until it is posted.</p>
        </div>
        <div className="actions">
          {canApprove && <button className="btn primary" disabled={approve.isPending} onClick={() => approve.mutate()}>{approve.isPending ? 'Posting…' : needsApproval ? 'Approve and post' : 'Post'}</button>}
          {canApprove && d.status === 'submitted' && <button className="btn" onClick={() => setSendBack(true)}>Send back…</button>}
        </div>
      </div>
      <Problem error={approve.error} />
      {d.status === 'submitted' && own && <div className="notice" role="status" style={{ marginBottom: 14 }}>You submitted this entry, so someone else has to approve it.</div>}
      {d.status === 'draft' && !own && <div className="notice" role="status" style={{ marginBottom: 14 }}>Only {d.created_by_name} can edit this draft.</div>}
      {d.rejection_note && <div className="notice warn" role="status" style={{ marginBottom: 14 }}><b>Sent back:</b> {d.rejection_note}</div>}
      <dl className="kv">
        <dt>Date</dt><dd>{longDate(d.entry_date)}</dd>
        <dt>Description</dt><dd>{d.description || <span className="muted">none yet</span>}</dd>
        <dt>Reference</dt><dd className="mono">{d.reference ?? 'none'}</dd>
        <dt>Status</dt><dd>{d.status === 'submitted' ? 'Submitted for approval' : 'Draft'}</dd>
      </dl>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th className="code">Account</th><th>Name</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.line_no}>
                <td className="code">{l.account_code}</td><td>{l.account_name}</td>
                <td className="num">{fromApi(l.debit) ? formatNum(fromApi(l.debit)) : ''}</td>
                <td className="num">{fromApi(l.credit) ? formatNum(fromApi(l.credit)) : ''}</td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={4} className="empty">No lines yet.</td></tr>}
          </tbody>
          <tfoot><tr><td /><td>Total (PHP)</td><td className="num">{formatNum(fromApi(d.total_debit))}</td><td className="num">{formatNum(fromApi(d.total_credit))}</td></tr></tfoot>
        </table>
      </div>
      <Dialog open={sendBack} onClose={() => setSendBack(false)} title="Send this entry back?">
        <p>The author gets the draft back with your note and can fix it and submit again.</p>
        <div className="stack" style={{ marginTop: 12 }}>
          <div>
            <label htmlFor="note">What needs to change</label>
            <input id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoComplete="off" />
          </div>
          <Problem error={reject.error} />
        </div>
        <div className="row">
          <button className="btn" onClick={() => setSendBack(false)}>Cancel</button>
          <button className="btn primary" disabled={note.trim().length < 3 || reject.isPending} onClick={() => reject.mutate()}>Send back</button>
        </div>
      </Dialog>
    </>
  );
}
