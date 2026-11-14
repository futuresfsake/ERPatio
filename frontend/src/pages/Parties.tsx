import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { SIDES, sub } from '../subledger';
import { Dialog, Loading, Problem, useToast } from '../ui';

export function Parties({ side }: { side: 'ar' | 'ap' }) {
  const S = SIDES[side];
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['parties', side], queryFn: () => sub.parties(side) });
  const toggle = useMutation({
    mutationFn: (p: { id: string; is_active: boolean }) => sub.updateParty(side, p.id, { is_active: !p.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['parties', side] }),
  });
  const write = can(S.write);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{S.Parties}</h1>
          <p className="sub">{side === 'ar' ? 'People and businesses you invoice.' : 'People and businesses you buy from.'} Tax numbers are stored encrypted.</p>
        </div>
        <div className="actions">{write && <button className="btn primary" onClick={() => setAdding(true)}>Add {S.party}</button>}</div>
      </div>
      <Problem error={list.error ?? toggle.error} />
      {list.isLoading && <Loading what={S.parties} />}
      {list.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th className="code">Code</th><th>Name</th><th>Email</th><th className="num">Terms</th><th /></tr></thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className={p.is_active ? '' : 'off'}>
                  <td className="code">{p.code}</td>
                  <td className="name">{p.name}{p.has_tin && <span className="muted"> · tax no. on file</span>}</td>
                  <td>{p.email ?? ''}</td>
                  <td className="num">{p.terms_days} days</td>
                  <td className="num">{write ? <button className="linkbtn" disabled={toggle.isPending} onClick={() => toggle.mutate(p)}>{p.is_active ? 'Deactivate' : 'Reactivate'}</button> : (p.is_active ? '' : 'Inactive')}</td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={5} className="empty">No {S.parties} yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <AddParty side={side} open={adding} onClose={() => setAdding(false)} onDone={() => { toast(`${S.Party} added`); void qc.invalidateQueries({ queryKey: ['parties', side] }); }} />
    </>
  );
}

function AddParty({ side, open, onClose, onDone }: { side: 'ar' | 'ap'; open: boolean; onClose: () => void; onDone: () => void }) {
  const S = SIDES[side];
  const [f, setF] = useState({ code: '', name: '', email: '', phone: '', tin: '', terms: '30' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () => sub.createParty(side, {
      code: f.code.trim().toUpperCase(), name: f.name.trim(), terms_days: Number(f.terms),
      ...(f.email.trim() && { email: f.email.trim() }), ...(f.phone.trim() && { phone: f.phone.trim() }), ...(f.tin.trim() && { tin: f.tin.trim() }),
    }),
    onSuccess: () => { onDone(); setF({ code: '', name: '', email: '', phone: '', tin: '', terms: '30' }); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === 'conflict' ? `Code ${f.code.trim().toUpperCase()} is already used.` : e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days = Number(f.terms);
    if (!/^[A-Za-z0-9.-]{1,20}$/.test(f.code.trim()) || !f.name.trim()) return setErr('Enter a code and a name.');
    if (!Number.isInteger(days) || days < 0 || days > 365) return setErr('Payment terms are 0 to 365 days.');
    create.mutate();
  };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title={`Add ${S.party}`}>
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="pc">Code</label><input id="pc" value={f.code} onChange={set('code')} maxLength={20} autoComplete="off" autoFocus /></div>
        <div><label htmlFor="pn">Name</label><input id="pn" value={f.name} onChange={set('name')} maxLength={200} autoComplete="off" /></div>
        <div><label htmlFor="pe">Email</label><input id="pe" type="email" value={f.email} onChange={set('email')} maxLength={254} autoComplete="off" /></div>
        <div><label htmlFor="pp">Phone</label><input id="pp" value={f.phone} onChange={set('phone')} maxLength={40} autoComplete="off" /></div>
        <div><label htmlFor="pt">Tax identification number</label><input id="pt" value={f.tin} onChange={set('tin')} maxLength={40} autoComplete="off" /><div className="hint">Encrypted at rest. Shown only on request and recorded in the audit log.</div></div>
        <div><label htmlFor="pd">Payment terms (days)</label><input id="pd" inputMode="numeric" value={f.terms} onChange={set('terms')} style={{ maxWidth: 120 }} /></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={create.isPending}>Save</button></div>
      </form>
    </Dialog>
  );
}
