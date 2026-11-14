import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { endpoints, ApiError, type Account, type AccountType } from '../api';
import { useAuth } from '../auth';
import { Dialog, Loading, Problem, useToast } from '../ui';

const GROUPS: [AccountType, string][] = [
  ['asset', 'Assets'], ['liability', 'Liabilities'], ['equity', 'Equity'], ['revenue', 'Revenue'], ['expense', 'Expenses'],
];

export function Accounts() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const toggle = useMutation({
    mutationFn: (a: Account) => endpoints.updateAccount(a.id, { is_active: !a.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
  const write = can('accounts:write');

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list.data ?? []).filter((a) => !q || `${a.code} ${a.name}`.toLowerCase().includes(q));
  }, [list.data, filter]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Chart of accounts</h1>
          <p className="sub">An account that has postings cannot be deleted, only deactivated.</p>
        </div>
        <div className="actions">{write && <button className="btn primary" onClick={() => setAdding(true)}>Add account</button>}</div>
      </div>
      <div className="toolbar">
        <label className="sr-only" htmlFor="q">Filter</label>
        <input id="q" placeholder="Filter by code or name" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 280 }} />
      </div>
      <Problem error={list.error ?? toggle.error} />
      {list.isLoading && <Loading what="accounts" />}
      {list.data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th className="code">Code</th><th>Name</th><th /></tr></thead>
            <tbody>
              {GROUPS.map(([type, label]) => {
                const rows = visible.filter((a) => a.type === type);
                if (!rows.length) return null;
                return [
                  <tr className="group" key={type}><td colSpan={3}>{label}</td></tr>,
                  ...rows.map((a) => (
                    <tr key={a.id} className={a.is_active ? '' : 'off'}>
                      <td className="code">{a.code}</td>
                      <td className="name">{a.name}</td>
                      <td className="num">
                        {write ? (
                          <button className="linkbtn" disabled={toggle.isPending} onClick={() => toggle.mutate(a)}>
                            {a.is_active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        ) : (a.is_active ? '' : 'Inactive')}
                      </td>
                    </tr>
                  )),
                ];
              })}
              {visible.length === 0 && <tr><td colSpan={3} className="empty">No account matches “{filter}”.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <AddAccount open={adding} onClose={() => setAdding(false)} onDone={() => { toast('Account added'); void qc.invalidateQueries({ queryKey: ['accounts'] }); }} />
    </>
  );
}

function AddAccount({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('asset');
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => endpoints.createAccount({ code: code.trim().toUpperCase(), name: name.trim(), type }),
    onSuccess: () => { onDone(); setCode(''); setName(''); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === 'conflict' ? `Code ${code.trim().toUpperCase()} is already used.` : e instanceof ApiError ? e.message : 'Could not save the account.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[A-Za-z0-9.-]{1,20}$/.test(code.trim()) || !name.trim()) return setErr('Enter a code and a name.');
    create.mutate();
  };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Add account">
      <form onSubmit={submit} className="stack" noValidate>
        <div>
          <label htmlFor="ac">Code</label>
          <input id="ac" value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} autoComplete="off" autoFocus />
          <div className="hint">Letters, digits, dot or dash. Up to 20.</div>
        </div>
        <div><label htmlFor="an">Name</label><input id="an" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" /></div>
        <div>
          <label htmlFor="at">Type</label>
          <select id="at" value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {GROUPS.map(([v, l]) => <option key={v} value={v}>{l.replace(/s$/, '').replace('Liabilitie', 'Liability')}</option>)}
          </select>
        </div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={create.isPending}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}
