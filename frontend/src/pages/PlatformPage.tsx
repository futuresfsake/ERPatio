import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, platform, type PlatformTenant } from '../api';
import { useAuth } from '../auth';
import { Dialog, Loading, Problem, useToast } from '../ui';

const MODULES: [string, string][] = [['finance', 'Finance'], ['supply_chain', 'Supply chain'], ['production', 'Production'], ['hcm', 'HR and payroll'], ['bi', 'Dashboards']];

/** Operator tools: workspaces, subscriptions, suspension, and read-only support sessions. */
export function PlatformPage() {
  const { startSupport } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-tenants'], queryFn: platform.tenants });
  const [target, setTarget] = useState<PlatformTenant | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-tenants'] });

  const status = useMutation({ mutationFn: (t: PlatformTenant) => platform.setStatus(t.id, t.status === 'active' ? 'suspended' : 'active'), onSuccess: () => { toast('Updated'); void refresh(); } });
  const mod = useMutation({ mutationFn: (v: { t: PlatformTenant; m: string; on: boolean }) => platform.setModules(v.t.id, { [v.m]: v.on }), onSuccess: () => void refresh() });
  const support = useMutation({
    mutationFn: () => platform.support(target!.id, reason.trim()),
    onSuccess: (s) => { setTarget(null); startSupport(s); nav('/'); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not open the session.'),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workspaces</h1>
          <p className="sub">Every customer workspace. Support sessions are read-only, last 15 minutes, and are recorded in the customer's own audit log.</p>
        </div>
      </div>
      <Problem error={q.error ?? status.error ?? mod.error} />
      {q.isLoading && <Loading what="workspaces" />}
      {q.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Workspace</th><th>Status</th><th className="num">People</th><th className="num hide-sm">Entries</th><th>Modules</th><th /></tr></thead>
            <tbody>
              {q.data.map((t) => (
                <tr key={t.id} className={t.status === 'active' ? '' : 'off'}>
                  <td><b>{t.name}</b><br /><span className="ref">{t.slug}{t.is_demo ? ' · demo' : ''}</span></td>
                  <td>{t.status === 'active' ? 'Active' : 'Suspended'}</td>
                  <td className="num">{t.users}</td>
                  <td className="num hide-sm">{t.entries}</td>
                  <td>
                    <div className="checks" style={{ gap: 2 }}>
                      {MODULES.map(([k, label]) => (
                        <label key={k} style={{ fontSize: 12.5 }}>
                          <input type="checkbox" checked={t.modules.find((m) => m.module === k)?.enabled ?? false} disabled={mod.isPending} onChange={(e) => mod.mutate({ t, m: k, on: e.target.checked })} /> {label}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td className="num" style={{ fontFamily: 'var(--sans)', whiteSpace: 'nowrap' }}>
                    <button className="linkbtn" disabled={t.status !== 'active'} onClick={() => { setTarget(t); setReason(''); setErr(null); }}>Support session</button>
                    <button className="linkbtn" style={{ marginLeft: 14 }} disabled={status.isPending} onClick={() => status.mutate(t)}>{t.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
                  </td>
                </tr>
              ))}
              {q.data.length === 0 && <tr><td colSpan={6} className="empty">No customer workspaces yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={!!target} onClose={() => setTarget(null)} title={target ? `Support session for ${target.name}` : ''}>
        <p>You will see this workspace read-only for 15 minutes. The reason is written to its audit log and the customer's administrators can read it.</p>
        <div className="stack" style={{ marginTop: 12 }}>
          <div><label htmlFor="why">Reason</label><input id="why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" autoFocus /><div className="hint">At least 8 characters. Say who asked and why.</div></div>
          {err && <div className="field-error" role="alert">{err}</div>}
        </div>
        <div className="row"><button className="btn" onClick={() => setTarget(null)}>Cancel</button><button className="btn primary" disabled={reason.trim().length < 8 || support.isPending} onClick={() => support.mutate()}>Open read-only session</button></div>
      </Dialog>
    </>
  );
}
