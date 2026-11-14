import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../api';
import { useAuth } from '../auth';
import { Loading, Problem, useToast } from '../ui';

export function Settings() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: endpoints.settings });
  const save = useMutation({
    mutationFn: (v: boolean) => endpoints.updateSettings(v),
    onSuccess: (s) => { void qc.invalidateQueries({ queryKey: ['settings'] }); toast(s.require_approval ? 'Approval is now required' : 'Approval is now off'); },
  });
  if (!can('settings:manage')) return <div className="notice error" role="alert">Your role cannot change settings.</div>;
  const on = q.data?.require_approval ?? false;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Policies for this workspace.</p>
        </div>
      </div>
      <Problem error={q.error ?? save.error} />
      {q.isLoading && <Loading what="settings" />}
      {q.data && (
        <div className="tbl-wrap" style={{ maxWidth: 640 }}>
          <div style={{ padding: 16, display: 'grid', gap: 8 }}>
            <label htmlFor="appr" style={{ display: 'flex', gap: 10, alignItems: 'center', font: '500 14px var(--sans)', margin: 0 }}>
              <input id="appr" type="checkbox" checked={on} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--ink)' }} />
              Require approval before entries are posted
            </label>
            <p className="muted">
              When on, accountants save a draft and submit it. A manager with approval rights posts it, and nobody can approve their own entry.
              Reversals are never held. When off, anyone who can post does so directly.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
