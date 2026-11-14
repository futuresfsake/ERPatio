import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { endpoints, type Draft, type DraftInput } from '../api';
import { formatNum, fromApi, parseAmount, toApi } from '../lib/money';
import { Dialog, Loading, Problem, todayIso, useToast } from '../ui';

interface Row { key: number; account: string; debit: string; credit: string }
let seq = 0;
const blank = (): Row => ({ key: ++seq, account: '', debit: '', credit: '' });
const show = (apiAmount: string) => (fromApi(apiAmount) === 0n ? '' : formatNum(fromApi(apiAmount)));

/** New entry or an existing draft. When the workspace requires approval the primary action is "Submit for approval". */
export function EntryEditor({ draft }: { draft?: Draft }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const settings = useQuery({ queryKey: ['settings'], queryFn: endpoints.settings });
  const approval = settings.data?.require_approval ?? false;

  const [date, setDate] = useState(draft?.entry_date ?? todayIso());
  const [description, setDescription] = useState(draft?.description ?? '');
  const [reference, setReference] = useState(draft?.reference ?? '');
  const [rows, setRows] = useState<Row[]>(() => {
    const start = (draft?.lines ?? []).map((l) => ({ key: ++seq, account: l.account_id, debit: show(l.debit), credit: show(l.credit) }));
    while (start.length < 2) start.push(blank());
    return start;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const calc = useMemo(() => {
    let debit = 0n, credit = 0n, invalid = false, missing = false;
    const bad = new Set<string>();
    for (const r of rows) {
      for (const [side, v] of [['debit', r.debit], ['credit', r.credit]] as const) {
        if (!v.trim()) continue;
        const n = parseAmount(v);
        if (n === null || n === 0n) { invalid = true; bad.add(`${r.key}:${side}`); continue; }
        if (side === 'debit') debit += n; else credit += n;
        if (!r.account) missing = true;
      }
    }
    const diff = debit > credit ? debit - credit : credit - debit;
    const ready = !invalid && !missing && debit > 0n && debit === credit && description.trim().length > 0;
    const message = ready || (debit === 0n && credit === 0n && !invalid) ? '' :
      invalid ? 'An amount is not valid.' : missing ? 'Choose an account for each amount.' :
      diff !== 0n ? 'Out of balance.' : 'Add a description.';
    return { debit, credit, diff, ready, message, bad, savable: !invalid && !missing };
  }, [rows, description]);

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const input = (): DraftInput => ({
    entry_date: date,
    description: description.trim(),
    reference: reference.trim() || undefined,
    lines: rows
      .filter((r) => r.account || r.debit.trim() || r.credit.trim())
      .map((r) => ({ account_id: r.account, debit: toApi(parseAmount(r.debit) ?? 0n), credit: toApi(parseAmount(r.credit) ?? 0n) })),
  });

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const refresh = () => {
    for (const k of ['entries', 'drafts', 'tb', 'periods']) void qc.invalidateQueries({ queryKey: [k] });
  };

  const saveDraft = () => guarded(async () => {
    if (!calc.savable) throw new Error('Fix the highlighted amounts and accounts first.');
    const saved = draft ? await endpoints.updateDraft(draft.id, input()) : await endpoints.createDraft(input());
    refresh();
    void qc.invalidateQueries({ queryKey: ['draft', saved.id] });
    toast('Draft saved');
    if (!draft) nav(`/journal/drafts/${saved.id}`, { replace: true });
  });

  const primary = () => guarded(async () => {
    if (!calc.ready) return;
    if (approval) {
      const saved = draft ? await endpoints.updateDraft(draft.id, input()) : await endpoints.createDraft(input());
      await endpoints.submitDraft(saved.id);
      refresh();
      toast('Submitted for approval');
      nav('/journal?tab=drafts');
      return;
    }
    const posted = draft
      ? (await endpoints.updateDraft(draft.id, input()), await endpoints.postDraft(draft.id))
      : await endpoints.postEntry({ ...input(), lines: input().lines });
    refresh();
    toast(`Posted JE-${posted.entry_no}`);
    nav(`/journal/${posted.id}`, { state: { fresh: true } });
  });

  const remove = () => guarded(async () => {
    if (!draft) return;
    await endpoints.deleteDraft(draft.id);
    refresh();
    toast('Draft deleted');
    nav('/journal?tab=drafts');
  });

  const submit = (e?: FormEvent) => { e?.preventDefault(); void primary(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) submit(); };
  const errMsg = error instanceof Error && !('status' in error) ? error.message : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb"><Link to="/journal">Journal</Link> /</div>
          <h1>{draft ? 'Edit draft' : 'New entry'}</h1>
          <p className="sub">
            {approval ? 'This workspace requires approval: submit the entry and a manager posts it.' : 'Debits and credits must match before you can post.'}
          </p>
        </div>
        {draft && <div className="actions"><button className="linkbtn" type="button" onClick={() => setConfirmDelete(true)}>Delete draft</button></div>}
      </div>
      {draft?.rejection_note && <div className="notice warn" role="status" style={{ marginBottom: 14 }}><b>Sent back:</b> {draft.rejection_note}</div>}
      {errMsg ? <div className="notice error" role="alert" style={{ marginBottom: 14 }}>{errMsg}</div> : <Problem error={error ?? accounts.error} />}
      {(accounts.isLoading || settings.isLoading) && <Loading what="accounts" />}
      {accounts.data && settings.data && (
        <form className="voucher" onSubmit={submit} onKeyDown={onKey} noValidate>
          <div className="top">
            <div className="formrow">
              <div><label htmlFor="d">Date</label><input id="d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div><label htmlFor="ds">Description</label><input id="ds" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} autoComplete="off" autoFocus={!draft} /></div>
              <div><label htmlFor="rf">Reference</label><input id="rf" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} autoComplete="off" /></div>
            </div>
          </div>
          <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table>
              <thead>
                <tr><th>Account</th><th className="num" style={{ width: 150 }}>Debit</th><th className="num" style={{ width: 150 }}>Credit</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <select aria-label="Account" value={r.account} onChange={(e) => update(r.key, { account: e.target.value })}>
                        <option value="" />
                        {accounts.data.filter((a) => a.is_active || a.id === r.account).map((a) => <option key={a.id} value={a.id}>{a.code}  {a.name}</option>)}
                      </select>
                    </td>
                    {(['debit', 'credit'] as const).map((side) => (
                      <td className="amt" key={side}>
                        <input
                          aria-label={side === 'debit' ? 'Debit' : 'Credit'} inputMode="decimal" autoComplete="off"
                          aria-invalid={calc.bad.has(`${r.key}:${side}`) || undefined}
                          value={r[side]}
                          onChange={(e) => update(r.key, side === 'debit' ? { debit: e.target.value, credit: e.target.value ? '' : r.credit } : { credit: e.target.value, debit: e.target.value ? '' : r.debit })}
                        />
                      </td>
                    ))}
                    <td className="rm">
                      <button type="button" className="linkbtn" aria-label="Remove line" title="Remove line" disabled={rows.length <= 2} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="below">
            <button type="button" className="linkbtn" onClick={() => setRows((rs) => [...rs, blank()])}>Add line</button>
            <span className="muted">Enter an amount in either column. Tab moves across.</span>
          </div>
          <div className="foot">
            <div className="sums">
              <div><span>Debits</span><strong>{formatNum(calc.debit)}</strong></div>
              <div><span>Credits</span><strong>{formatNum(calc.credit)}</strong></div>
              <div><span>Difference</span><strong className={calc.diff ? 'red' : ''}>{formatNum(calc.diff)}</strong></div>
            </div>
            <div className="actions-row">
              <span className={calc.ready ? 'balanced-note' : 'muted'} role="status">{calc.ready ? 'In balance. Ready.' : calc.message}</span>
              <button type="button" className="btn" disabled={busy} onClick={() => void saveDraft()}>Save draft</button>
              <button className="btn primary" disabled={!calc.ready || busy}>
                {busy ? 'Working…' : <>{approval ? 'Submit for approval' : 'Post'} <kbd style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}>Ctrl+↵</kbd></>}
              </button>
            </div>
          </div>
        </form>
      )}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this draft?">
        <p>The draft is removed for good. Nothing has been posted to the ledger.</p>
        <div className="row">
          <button className="btn" onClick={() => setConfirmDelete(false)}>Keep draft</button>
          <button className="btn danger" disabled={busy} onClick={() => void remove()}>Delete draft</button>
        </div>
      </Dialog>
    </>
  );
}
