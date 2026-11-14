import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { endpoints } from '../api';
import { useAuth } from '../auth';
import { formatNum, fromApi } from '../lib/money';
import { Loading, longDate, Problem } from '../ui';

const PAGE = 25;

export function Journal() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'drafts' ? 'drafts' : 'posted';
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ['entries', PAGE, offset], queryFn: () => endpoints.entries(PAGE, offset), enabled: tab === 'posted' });
  const drafts = useQuery({ queryKey: ['drafts'], queryFn: () => endpoints.drafts() });
  const total = q.data?.total ?? 0;
  const waiting = drafts.data?.filter((d) => d.status === 'submitted').length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Journal</h1>
          <p className="sub">Posted entries are locked. To correct one, reverse it and post a new entry.</p>
        </div>
        <div className="actions">{can('journal:post') && <Link className="btn primary" to="/journal/new">New entry</Link>}</div>
      </div>

      <div className="tabs" role="tablist">
        <a role="tab" href="?" aria-current={tab === 'posted' ? 'true' : undefined} onClick={(e) => { e.preventDefault(); setParams({}); }}>Posted</a>
        <a role="tab" href="?tab=drafts" aria-current={tab === 'drafts' ? 'true' : undefined} onClick={(e) => { e.preventDefault(); setParams({ tab: 'drafts' }); }}>
          Drafts{drafts.data ? ` (${drafts.data.length})` : ''}{waiting > 0 && <span className="muted"> · {waiting} waiting for approval</span>}
        </a>
      </div>

      {tab === 'posted' && (
        <>
          <Problem error={q.error} />
          {q.isLoading && <Loading what="entries" />}
          {q.data && (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr><th className="code">No.</th><th>Date</th><th>Description</th><th className="hide-sm">Reference</th><th className="num">Amount (PHP)</th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((e) => (
                    <tr className="link" key={e.id} onClick={() => nav(`/journal/${e.id}`)}>
                      <td className="code">JE-{e.entry_no}</td>
                      <td>{longDate(e.entry_date)}</td>
                      <td>
                        {e.description}
                        {e.reverses_entry_id && <span className="muted"> · reversal</span>}
                        {e.reversed_by_entry_id && <span className="muted"> · reversed</span>}
                      </td>
                      <td className="ref hide-sm">{e.reference}</td>
                      <td className="num">{formatNum(fromApi(e.total))}</td>
                    </tr>
                  ))}
                  {q.data.items.length === 0 && <tr><td colSpan={5} className="empty">No entries yet.</td></tr>}
                </tbody>
              </table>
              <div className="pager">
                <span>{total === 0 ? '0 entries' : `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`}</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
                  <button className="btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Older</button>
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'drafts' && (
        <>
          <Problem error={drafts.error} />
          {drafts.isLoading && <Loading what="drafts" />}
          {drafts.data && (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>Description</th><th className="hide-sm">Author</th><th>Status</th><th className="num">Amount (PHP)</th></tr>
                </thead>
                <tbody>
                  {drafts.data.map((d) => (
                    <tr className="link" key={d.id} onClick={() => nav(`/journal/drafts/${d.id}`)}>
                      <td>{longDate(d.entry_date)}</td>
                      <td>{d.description || <span className="muted">no description yet</span>}</td>
                      <td className="hide-sm">{d.created_by_name}</td>
                      <td>
                        {d.status === 'submitted' ? 'Waiting for approval' : d.rejection_note ? <span className="red">Sent back</span> : 'Draft'}
                      </td>
                      <td className="num">{formatNum(fromApi(d.total_debit))}</td>
                    </tr>
                  ))}
                  {drafts.data.length === 0 && <tr><td colSpan={5} className="empty">No drafts. Use “Save draft” on a new entry to keep work in progress.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
