import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, admin, api } from '../api';
import { useAuth } from '../auth';
import { Dialog, Loading, longDate, Problem, useToast } from '../ui';

// Mirrors the server's list of what a key can never hold; the server is the one that enforces it.
const NOT_FOR_KEYS = new Set(['users:manage', 'roles:manage', 'settings:manage', 'privacy:manage', 'platform:manage', 'integrations:manage', 'data:export', 'journal:approve', 'periods:manage', 'payroll:read', 'payroll:manage', 'payroll:approve', 'employees:write', 'audit:read']);

interface Key { id: string; name: string; key_prefix: string; permissions: string[]; rate_limit_per_min: number; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_by_name: string }
interface Hook { id: string; url: string; events: string[]; is_active: boolean; consecutive_failures: number; disabled_reason: string | null; created_at: string }
interface Delivery { id: string; event: string; status: string; attempts: number; last_status_code: number | null; last_error: string | null; created_at: string }
interface Usage { plan: { code: string; name: string; price_monthly: string }; limits: { users: number | null; entries_per_month: number | null }; usage: { users: number; entries_this_month: number; api_keys: number; webhooks: number }; history: { month: string; entries: number }[] }

const limitText = (n: number | null) => (n === null ? 'no limit' : n.toLocaleString('en-PH'));

export function Integrations() {
  const { can } = useAuth();
  const manage = can('integrations:manage');
  return (
    <>
      <div className="page-head"><div><h1>Integrations</h1><p className="sub">API keys for other systems, webhooks that tell them when something happens, and your plan.</p></div></div>
      {can('billing:read') && <PlanSection />}
      {manage && <KeysSection />}
      {manage && <HooksSection />}
    </>
  );
}

function PlanSection() {
  const q = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/billing/usage') });
  const u = q.data;
  const meter = (used: number, cap: number | null, label: string) => (
    <div style={{ minWidth: 200 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div className="num" style={{ textAlign: 'left' }}>{used.toLocaleString('en-PH')} of {limitText(cap)}</div>
      {cap !== null && <progress value={Math.min(used, cap)} max={cap} aria-label={label} style={{ width: '100%' }} />}
    </div>
  );
  return (
    <section className="stack" style={{ marginBottom: 32 }}>
      <h2>Plan and usage</h2>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="usage" />}
      {u && (
        <>
          <p>You are on the <b>{u.plan.name}</b> plan. Limits are enforced: a posting over the monthly allowance is refused.</p>
          <div className="row" style={{ gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {meter(u.usage.users, u.limits.users, 'Active users')}
            {meter(u.usage.entries_this_month, u.limits.entries_per_month, 'Journal entries this month')}
            <div><div className="muted" style={{ fontSize: 12 }}>API keys / webhooks</div><div className="num" style={{ textAlign: 'left' }}>{u.usage.api_keys} / {u.usage.webhooks}</div></div>
          </div>
          {u.history.length > 0 && <p className="muted">Entries by month: {u.history.map((h) => `${h.month} ${h.entries}`).join(' · ')}</p>}
        </>
      )}
    </section>
  );
}

function KeysSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['keys'], queryFn: () => api<Key[]>('/api-keys') });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api-keys/${id}`, { method: 'DELETE' }), onSuccess: () => { toast('Key revoked'); void qc.invalidateQueries({ queryKey: ['keys'] }); void qc.invalidateQueries({ queryKey: ['usage'] }); } });
  return (
    <section className="stack" style={{ marginBottom: 32 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>API keys</h2><button className="btn primary" onClick={() => setAdding(true)}>Create key</button></div>
      <p className="muted">Send a key as <span className="mono">Authorization: Bearer …</span>. A key can only do what you give it, never more than you can do, and stops when you are deactivated.</p>
      <Problem error={q.error ?? revoke.error} />
      {q.isLoading && <Loading what="keys" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Name</th><th>Key</th><th>Can</th><th>Last used</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {q.data.map((k) => (
              <tr key={k.id} className={k.revoked_at ? 'off' : ''}>
                <td className="name">{k.name}<div className="muted" style={{ fontSize: 12 }}>by {k.created_by_name}</div></td><td className="mono">{k.key_prefix}…</td>
                <td>{k.permissions.length} permissions</td><td>{k.last_used_at ? longDate(k.last_used_at) : 'never'}</td><td>{k.expires_at ? longDate(k.expires_at) : 'never'}</td>
                <td className="num">{k.revoked_at ? 'Revoked' : <button className="linkbtn" disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke ${k.name}? Anything using it stops working.`)) revoke.mutate(k.id); }}>Revoke</button>}</td>
              </tr>
            ))}
            {q.data.length === 0 && <tr><td colSpan={6} className="empty">No API keys.</td></tr>}
          </tbody>
        </table></div>
      )}
      <NewKey open={adding} onClose={() => setAdding(false)} onCreated={(key) => { setShown(key); void qc.invalidateQueries({ queryKey: ['keys'] }); void qc.invalidateQueries({ queryKey: ['usage'] }); }} />
      <Dialog open={shown !== null} onClose={() => setShown(null)} title="Copy your key now">
        <p>This is the only time it is shown. Store it in the other system's secret store, not in code.</p>
        <p className="mono" style={{ wordBreak: 'break-all', padding: 8, border: '1px solid var(--rule-strong)' }}>{shown}</p>
        <div className="row"><button className="btn" onClick={() => void navigator.clipboard?.writeText(shown ?? '')}>Copy</button><button className="btn primary" onClick={() => setShown(null)}>I have saved it</button></div>
      </Dialog>
    </section>
  );
}

function NewKey({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (key: string) => void }) {
  const perms = useQuery({ queryKey: ['permissions'], queryFn: admin.permissions, enabled: open });
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [days, setDays] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const list = (perms.data ?? []).filter((p) => !NOT_FOR_KEYS.has(p.key));
  const m = useMutation({
    mutationFn: () => api<{ key: string }>('/api-keys', { method: 'POST', json: { name: name.trim(), permissions: [...chosen], ...(days && { expires_in_days: Number(days) }) } }),
    onSuccess: (r) => { onCreated(r.key); setName(''); setChosen(new Set()); setDays(''); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not create the key.'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return setErr('Name the key after what uses it.'); if (chosen.size === 0) return setErr('Choose at least one thing it may do.'); if (days && !/^\d{1,3}$/.test(days)) return setErr('Days is a number.'); m.mutate(); };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Create API key">
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="kn">Name</label><input id="kn" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="Online shop" /></div>
        <div><label htmlFor="kd">Expires after (days, optional)</label><input id="kd" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 120 }} /></div>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend>May do</legend>
          <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 4 }}>
            {list.map((p) => <label key={p.key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={chosen.has(p.key)} onChange={() => { const n = new Set(chosen); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); setChosen(n); }} />{p.label}</label>)}
          </div>
        </fieldset>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Create</button></div>
      </form>
    </Dialog>
  );
}

function HooksSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['hooks'], queryFn: () => api<Hook[]>('/webhooks') });
  const log = useQuery({ queryKey: ['deliveries', open], queryFn: () => api<Delivery[]>(`/webhooks/${open}/deliveries`), enabled: !!open, refetchInterval: 10_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['hooks'] }); void qc.invalidateQueries({ queryKey: ['usage'] }); void qc.invalidateQueries({ queryKey: ['deliveries'] }); };
  const act = useMutation({
    mutationFn: (a: { id: string; what: 'test' | 'toggle' | 'delete'; on?: boolean }) => a.what === 'test' ? api(`/webhooks/${a.id}/test`, { method: 'POST' }) : a.what === 'delete' ? api(`/webhooks/${a.id}`, { method: 'DELETE' }) : api(`/webhooks/${a.id}`, { method: 'PATCH', json: { is_active: a.on } }),
    onSuccess: (_r, a) => { toast(a.what === 'test' ? 'Test event queued' : a.what === 'delete' ? 'Webhook removed' : 'Saved'); refresh(); },
  });
  return (
    <section className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>Webhooks</h2><button className="btn primary" onClick={() => setAdding(true)}>Add webhook</button></div>
      <p className="muted">We send a signed POST to an https address when something you choose happens. Events carry identifiers only; fetch the record through the API. Failed sends are retried for about nine hours.</p>
      <Problem error={q.error ?? act.error} />
      {q.isLoading && <Loading what="webhooks" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Address</th><th>Events</th><th>Status</th><th /></tr></thead>
          <tbody>
            {q.data.map((h) => (
              <tr key={h.id} className={h.is_active ? '' : 'off'}>
                <td className="name"><button className="linkbtn" onClick={() => setOpen(open === h.id ? null : h.id)}>{h.url}</button></td><td>{h.events.length}</td>
                <td>{h.is_active ? 'On' : `Off${h.disabled_reason ? `: ${h.disabled_reason}` : ''}`}</td>
                <td className="num"><button className="linkbtn" onClick={() => act.mutate({ id: h.id, what: 'test' })}>Send test</button> · <button className="linkbtn" onClick={() => act.mutate({ id: h.id, what: 'toggle', on: !h.is_active })}>{h.is_active ? 'Turn off' : 'Turn on'}</button> · <button className="linkbtn" onClick={() => { if (window.confirm('Remove this webhook?')) act.mutate({ id: h.id, what: 'delete' }); }}>Remove</button></td>
              </tr>
            ))}
            {q.data.length === 0 && <tr><td colSpan={4} className="empty">No webhooks.</td></tr>}
          </tbody>
        </table></div>
      )}
      {open && log.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>When</th><th>Event</th><th>Result</th><th className="num">Tries</th></tr></thead>
          <tbody>{log.data.map((d) => <tr key={d.id}><td>{new Date(d.created_at).toLocaleString('en-PH')}</td><td>{d.event}</td><td>{d.status}{d.last_error ? ` · ${d.last_error}` : ''}</td><td className="num">{d.attempts}</td></tr>)}{log.data.length === 0 && <tr><td colSpan={4} className="empty">Nothing sent yet.</td></tr>}</tbody>
        </table></div>
      )}
      <NewHook open={adding} onClose={() => setAdding(false)} onCreated={(s) => { setSecret(s); refresh(); }} />
      <Dialog open={secret !== null} onClose={() => setSecret(null)} title="Copy the signing secret now">
        <p>Use it to check the <span className="mono">X-ERPatio-Signature</span> header: HMAC-SHA256 of the timestamp, a dot, then the raw body. It is not shown again.</p>
        <p className="mono" style={{ wordBreak: 'break-all', padding: 8, border: '1px solid var(--rule-strong)' }}>{secret}</p>
        <div className="row"><button className="btn primary" onClick={() => setSecret(null)}>I have saved it</button></div>
      </Dialog>
    </section>
  );
}

function NewHook({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (secret: string) => void }) {
  const events = useQuery({ queryKey: ['hook-events'], queryFn: () => api<string[]>('/webhook-events'), enabled: open });
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api<{ secret: string }>('/webhooks', { method: 'POST', json: { url: url.trim(), events: [...chosen] } }),
    onSuccess: (r) => { onCreated(r.secret); setUrl(''); setChosen(new Set()); setErr(null); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not add the webhook.'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!/^https:\/\//i.test(url.trim())) return setErr('The address must start with https://.'); if (chosen.size === 0) return setErr('Choose at least one event.'); m.mutate(); };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Add webhook">
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="wu">Address</label><input id="wu" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} autoFocus placeholder="https://example.com/erpatio" /></div>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend>Tell me when</legend>
          <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 4 }}>
            {(events.data ?? []).filter((e) => e !== 'ping').map((e) => <label key={e} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={chosen.has(e)} onChange={() => { const n = new Set(chosen); if (n.has(e)) n.delete(e); else n.add(e); setChosen(n); }} />{e.replace('.', ' · ').replace(/_/g, ' ')}</label>)}
          </div>
        </fieldset>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Add</button></div>
      </form>
    </Dialog>
  );
}
