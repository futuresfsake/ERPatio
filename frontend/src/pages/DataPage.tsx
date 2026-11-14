import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { csvToObjects, downloadCsv } from '../lib/csv';
import { Problem, useToast } from '../ui';

const ENTITIES = {
  customers: { label: 'Customers', columns: ['code', 'name', 'email', 'phone', 'tin', 'terms_days'], required: ['code', 'name'] },
  suppliers: { label: 'Suppliers', columns: ['code', 'name', 'email', 'phone', 'tin', 'terms_days'], required: ['code', 'name'] },
  items: { label: 'Items', columns: ['sku', 'name', 'uom', 'reorder_level'], required: ['sku', 'name'] },
  accounts: { label: 'Accounts', columns: ['code', 'name', 'type'], required: ['code', 'name', 'type'] },
} as const;
type Entity = keyof typeof ENTITIES;
const MAX_ROWS = 5000;

interface Preview { rows: number; valid: number; already_exist: number; errors: { row: number; message: string }[] }

export function DataPage() {
  const { can } = useAuth();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [entity, setEntity] = useState<Entity>('customers');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'skip' | 'fail'>('skip');
  const [preview, setPreview] = useState<Preview | null>(null);
  const E = ENTITIES[entity];
  const parsed = text.trim() ? csvToObjects(text) : null;
  const missing = parsed ? E.required.filter((c) => !parsed.headers.includes(c)) : [];
  const unknown = parsed ? parsed.headers.filter((h) => !(E.columns as readonly string[]).includes(h)) : [];
  const rows = parsed && missing.length === 0 ? parsed.rows.map((r) => Object.fromEntries(E.columns.map((c) => [c, r[c] ?? '']))) : [];
  const tooMany = rows.length > MAX_ROWS;

  const check = useMutation({ mutationFn: () => api<Preview>(`/imports/${entity}/preview`, { method: 'POST', json: { rows } }), onSuccess: setPreview });
  const commit = useMutation({
    mutationFn: () => api<{ added: number; skipped: number }>(`/imports/${entity}/commit`, { method: 'POST', json: { rows, on_duplicate: mode } }),
    onSuccess: (r) => { toast(`${r.added} added, ${r.skipped} skipped`); setText(''); setPreview(null); },
    onError: (e) => { if (e instanceof ApiError && e.details) setPreview({ rows: rows.length, valid: 0, already_exist: 0, errors: e.details.map((d) => ({ row: Number(d.field.replace('row ', '')), message: d.reason })) }); },
  });
  const exportAll = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v1/export', { headers: { 'X-Requested-With': 'erpatio', Authorization: `Bearer ${await tokenForDownload()}` } });
      if (!res.ok) throw new ApiError(res.status, 'export_failed', res.status === 429 ? 'An export was made a moment ago. Try again in a few minutes.' : 'The export could not be made.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `erpatio-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
  });

  const onFile = (f: File | undefined) => { if (!f) return; if (f.size > 4_000_000) return setText(''); void f.text().then((t) => { setText(t); setPreview(null); }); };
  return (
    <>
      <div className="page-head"><div><h1>Data</h1><p className="sub">Bring in customers, suppliers, items and accounts from a spreadsheet, or take everything out.</p></div></div>
      {can('data:import') && (
        <section className="stack" style={{ maxWidth: 760 }}>
          <h2>Import from CSV</h2>
          <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
            <div><label htmlFor="ie">What are you importing?</label><select id="ie" value={entity} onChange={(e) => { setEntity(e.target.value as Entity); setPreview(null); }}>{(Object.keys(ENTITIES) as Entity[]).map((k) => <option key={k} value={k}>{ENTITIES[k].label}</option>)}</select></div>
            <button className="btn" onClick={() => downloadCsv(`${entity}-template.csv`, [[...E.columns]])}>Download a template</button>
          </div>
          <p className="muted">Columns: {E.columns.join(', ')}. First row is the header. Required: {E.required.join(', ')}. Up to {MAX_ROWS} rows.</p>
          <div><label htmlFor="if">CSV file</label><input id="if" ref={file} type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} /></div>
          <div><label htmlFor="it">…or paste it here</label><textarea id="it" rows={6} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} style={{ fontFamily: 'var(--mono)' }} /></div>
          {parsed && missing.length > 0 && <div className="notice error" role="alert">The header is missing: {missing.join(', ')}.</div>}
          {unknown.length > 0 && missing.length === 0 && <div className="notice warn">Ignoring columns that are not used: {unknown.join(', ')}.</div>}
          {tooMany && <div className="notice error" role="alert">That is {rows.length} rows. Split the file into pieces of {MAX_ROWS} or fewer.</div>}
          <div className="row"><button className="btn" disabled={rows.length === 0 || tooMany || check.isPending} onClick={() => check.mutate()}>Check {rows.length || ''} rows</button></div>
          <Problem error={check.error} />
          {preview && (
            <div role="status" className={preview.errors.length ? 'notice error' : 'notice'}>
              <p><b>{preview.valid}</b> of {preview.rows} rows are fine{preview.already_exist > 0 ? `, ${preview.already_exist} already exist` : ''}{preview.errors.length ? `, ${preview.errors.length} have problems` : ''}.</p>
              {preview.errors.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{preview.errors.slice(0, 12).map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}{preview.errors.length > 12 && <li>…and {preview.errors.length - 12} more</li>}</ul>}
            </div>
          )}
          {preview && preview.errors.length === 0 && (
            <div className="stack">
              {preview.already_exist > 0 && <div><label htmlFor="im">Rows that already exist</label><select id="im" value={mode} onChange={(e) => setMode(e.target.value as 'skip' | 'fail')}><option value="skip">Leave them as they are</option><option value="fail">Stop and import nothing</option></select></div>}
              <Problem error={commit.error instanceof ApiError && commit.error.details ? null : commit.error} />
              <div className="row"><button className="btn primary" disabled={commit.isPending} onClick={() => commit.mutate()}>Import {preview.valid - (mode === 'skip' ? preview.already_exist : 0)} rows</button></div>
            </div>
          )}
        </section>
      )}
      {can('data:export') && (
        <section className="stack" style={{ maxWidth: 760, marginTop: 32 }}>
          <h2>Export everything</h2>
          <p className="muted">One JSON file with the workspace's business data: ledger, customers, suppliers, stock, orders, production, people and the audit log. Passwords, tokens and encrypted personal fields are left out. One export every five minutes.</p>
          <Problem error={exportAll.error} />
          <div className="row"><button className="btn" disabled={exportAll.isPending} onClick={() => exportAll.mutate()}>Download the export</button></div>
        </section>
      )}
    </>
  );
}

/** The access token lives in memory inside api.ts; ask it for a fresh one through a harmless authenticated call, then read it back. */
async function tokenForDownload(): Promise<string> {
  const { currentAccessToken } = await import('../api');
  await api('/auth/me').catch(() => undefined);
  return currentAccessToken() ?? '';
}
