import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../api';
import { useAuth } from '../auth';
import { Loading, Problem } from '../ui';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function Audit() {
  const { can } = useAuth();
  const allowed = can('audit:read');
  const q = useQuery({ queryKey: ['audit'], queryFn: endpoints.audit, enabled: allowed });
  if (!allowed) return <div className="notice error" role="alert">Your role cannot open the audit log.</div>;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="sub">Written by the system on every change. Rows cannot be edited or deleted.</p>
        </div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="events" />}
      {q.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>Event</th><th>Subject</th><th>Detail</th></tr></thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id}>
                  <td className="ref">{when(a.occurred_at)}</td>
                  <td className="mono">{a.action}</td>
                  <td className="ref">{a.entity_type ? `${a.entity_type} ${a.entity_id?.slice(0, 8) ?? ''}` : ''}</td>
                  <td className="ref">{Object.entries(a.detail).map(([k, v]) => `${k}=${String(v)}`).join('  ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
