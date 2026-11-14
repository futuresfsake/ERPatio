import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { admin, ApiError, type Person, type RoleRow } from '../api';
import { useAuth } from '../auth';
import { Dialog, Loading, Problem, useToast } from '../ui';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never');
const status = (p: Person) => (p.erased_at ? 'Erased' : !p.is_active ? 'Deactivated' : p.invite_pending ? 'Invited' : 'Active');

function RolePicker({ roles, value, onChange }: { roles: RoleRow[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="checks" role="group" aria-label="Roles">
      {roles.map((r) => (
        <label key={r.id}>
          <input type="checkbox" checked={value.includes(r.id)} onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
          <span><b>{r.name}</b>{r.description && <span className="muted"> · {r.description}</span>}<br /><span className="muted" style={{ fontSize: 12 }}>{r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'}</span></span>
        </label>
      ))}
    </div>
  );
}

export function People() {
  const { can, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const manage = can('users:manage');
  const users = useQuery({ queryKey: ['users'], queryFn: admin.users });
  const roles = useQuery({ queryKey: ['roles'], queryFn: admin.roles });
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [f, setF] = useState({ name: '', email: '' });
  const [pick, setPick] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['roles'] }); };
  const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
  const invite = useMutation({ mutationFn: () => admin.invite({ email: f.email.trim(), full_name: f.name.trim(), role_ids: pick }), onSuccess: () => { toast('Invitation sent'); setInviting(false); refresh(); }, onError: (e) => setErr(msg(e)) });
  const saveRoles = useMutation({ mutationFn: () => admin.setRoles(editing!.id, pick), onSuccess: () => { toast('Roles saved'); setEditing(null); refresh(); }, onError: (e) => setErr(msg(e)) });
  const toggle = useMutation({ mutationFn: (p: Person) => admin.patchUser(p.id, { is_active: !p.is_active }), onSuccess: refresh });
  const resend = useMutation({ mutationFn: (p: Person) => admin.resendInvite(p.id), onSuccess: () => toast('Invitation sent again') });

  const submitInvite = (e: FormEvent) => {
    e.preventDefault();
    if (!f.name.trim() || !/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr('Enter a name and a valid email address.');
    if (pick.length === 0) return setErr('Choose at least one role.');
    setErr(null);
    invite.mutate();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p className="sub">Who can sign in to this workspace and what they may do.</p>
        </div>
        <div className="actions">{manage && <button className="btn primary" onClick={() => { setF({ name: '', email: '' }); setPick([]); setErr(null); setInviting(true); }}>Invite person</button>}</div>
      </div>
      <Problem error={users.error ?? toggle.error ?? resend.error} />
      {users.isLoading && <Loading what="people" />}
      {users.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Name</th><th className="hide-sm">Email</th><th>Roles</th><th>Status</th><th className="hide-sm">Last sign-in</th><th /></tr></thead>
            <tbody>
              {users.data.map((p) => (
                <tr key={p.id} className={p.is_active ? '' : 'off'}>
                  <td>{p.full_name}{p.totp_enabled && <span className="muted"> · 2FA</span>}</td>
                  <td className="ref hide-sm">{p.erased_at ? '—' : p.email}</td>
                  <td>{p.roles.map((r) => r.name).join(', ') || <span className="muted">none</span>}</td>
                  <td>{status(p)}</td>
                  <td className="hide-sm">{when(p.last_login_at)}</td>
                  <td className="num" style={{ fontFamily: 'var(--sans)', whiteSpace: 'nowrap' }}>
                    {manage && !p.erased_at && (
                      <span style={{ display: 'inline-flex', gap: 14 }}>
                        <button className="linkbtn" onClick={() => { setEditing(p); setPick(p.roles.map((r) => r.id)); setErr(null); }}>Roles</button>
                        {p.invite_pending && p.is_active && <button className="linkbtn" onClick={() => resend.mutate(p)}>Resend</button>}
                        {p.id !== user?.id && <button className="linkbtn" disabled={toggle.isPending} onClick={() => toggle.mutate(p)}>{p.is_active ? 'Deactivate' : 'Reactivate'}</button>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={inviting} onClose={() => setInviting(false)} title="Invite a person">
        <form onSubmit={submitInvite} className="stack" noValidate>
          <div><label htmlFor="pn">Name</label><input id="pn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} autoComplete="off" autoFocus /></div>
          <div><label htmlFor="pe">Email</label><input id="pe" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" /></div>
          <div><label>Roles</label>{roles.data && <RolePicker roles={roles.data} value={pick} onChange={setPick} />}</div>
          {err && <div className="field-error" role="alert">{err}</div>}
          <div className="row"><button type="button" className="btn" onClick={() => setInviting(false)}>Cancel</button><button className="btn primary" disabled={invite.isPending}>Send invitation</button></div>
        </form>
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing ? `Roles for ${editing.full_name}` : ''}>
        <div className="stack">
          {roles.data && <RolePicker roles={roles.data} value={pick} onChange={setPick} />}
          <p className="muted" style={{ fontSize: 12 }}>You can only give roles whose permissions you hold yourself. Changes apply the next time the person signs in or their session refreshes.</p>
          {err && <div className="field-error" role="alert">{err}</div>}
        </div>
        <div className="row"><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" disabled={pick.length === 0 || saveRoles.isPending} onClick={() => saveRoles.mutate()}>Save roles</button></div>
      </Dialog>
    </>
  );
}
