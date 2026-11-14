import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { admin, ApiError, type RoleRow } from '../api';
import { useAuth } from '../auth';
import { Dialog, Loading, Problem, useToast } from '../ui';

const MODULE_LABEL: Record<string, string> = { finance: 'Finance', core: 'Workspace' };

export function RolesPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const manage = can('roles:manage');
  const roles = useQuery({ queryKey: ['roles'], queryFn: admin.roles });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: admin.permissions });
  const [open, setOpen] = useState<null | { role?: RoleRow }>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const groups = useMemo(() => {
    const g = new Map<string, { key: string; label: string }[]>();
    for (const p of perms.data ?? []) g.set(p.module, [...(g.get(p.module) ?? []), p]);
    return [...g.entries()];
  }, [perms.data]);

  const done = () => { void qc.invalidateQueries({ queryKey: ['roles'] }); setOpen(null); };
  const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
  const save = useMutation({
    mutationFn: () => (open?.role ? admin.updateRole(open.role.id, { name: name.trim(), description: desc.trim(), permissions: sel }) : admin.createRole({ name: name.trim(), description: desc.trim() || undefined, permissions: sel })),
    onSuccess: () => { toast('Role saved'); done(); },
    onError: (e) => setErr(msg(e)),
  });
  const remove = useMutation({ mutationFn: (r: RoleRow) => admin.deleteRole(r.id), onSuccess: () => { toast('Role deleted'); void qc.invalidateQueries({ queryKey: ['roles'] }); } });

  const start = (role?: RoleRow) => { setOpen({ role }); setName(role?.name ?? ''); setDesc(role?.description ?? ''); setSel(role?.permissions ?? []); setErr(null); };
  const readOnly = !!open?.role?.is_system;
  const held = new Set(user?.permissions ?? []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Roles</h1>
          <p className="sub">A role is a named set of permissions. Built-in roles are fixed; make a custom role when you need something in between.</p>
        </div>
        <div className="actions">{manage && <button className="btn primary" onClick={() => start()}>New role</button>}</div>
      </div>
      <Problem error={roles.error ?? remove.error} />
      {roles.isLoading && <Loading what="roles" />}
      {roles.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Role</th><th className="hide-sm">What it is for</th><th className="num">Permissions</th><th className="num">People</th><th /></tr></thead>
            <tbody>
              {roles.data.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b>{r.is_system && <span className="muted"> · built in</span>}</td>
                  <td className="hide-sm muted">{r.description ?? ''}</td>
                  <td className="num">{r.permissions.length}</td>
                  <td className="num">{r.user_count}</td>
                  <td className="num" style={{ fontFamily: 'var(--sans)', whiteSpace: 'nowrap' }}>
                    <button className="linkbtn" onClick={() => start(r)}>{r.is_system || !manage ? 'View' : 'Edit'}</button>
                    {manage && !r.is_system && <button className="linkbtn" style={{ marginLeft: 14 }} disabled={remove.isPending} onClick={() => remove.mutate(r)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.role ? (readOnly || !manage ? open.role.name : `Edit ${open.role.name}`) : 'New role'}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim().length < 2) return setErr('Give the role a name.'); setErr(null); save.mutate(); }} noValidate>
          {!readOnly && manage && (
            <>
              <div><label htmlFor="rn">Name</label><input id="rn" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" autoFocus /></div>
              <div><label htmlFor="rd">What it is for</label><input id="rd" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} autoComplete="off" /></div>
            </>
          )}
          {groups.map(([mod, items]) => (
            <fieldset key={mod} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend><h2 style={{ marginBottom: 6 }}>{MODULE_LABEL[mod] ?? mod}</h2></legend>
              <div className="checks">
                {items.map((p) => (
                  <label key={p.key}>
                    <input type="checkbox" checked={sel.includes(p.key)} disabled={readOnly || !manage || !held.has(p.key)} onChange={(e) => setSel(e.target.checked ? [...sel, p.key] : sel.filter((x) => x !== p.key))} />
                    <span>{p.label}{!held.has(p.key) && !readOnly && manage && <span className="muted"> · you do not hold this</span>}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {err && <div className="field-error" role="alert">{err}</div>}
          <div className="row">
            <button type="button" className="btn" onClick={() => setOpen(null)}>{readOnly || !manage ? 'Close' : 'Cancel'}</button>
            {!readOnly && manage && <button className="btn primary" disabled={save.isPending}>Save role</button>}
          </div>
        </form>
      </Dialog>
    </>
  );
}
