import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, endpoints } from '../api';
import { useAuth } from '../auth';
import { hcm, type Employee, type RunDetail } from '../hcm';
import { formatApiNum, parseAmount, toApi } from '../lib/money';
import { Dialog, Loading, longDate, Problem, todayIso, useToast } from '../ui';

const hrs = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

// ------------------------------------------------------------------ employees
export function EmployeesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [showing, setShowing] = useState<Employee | null>(null);
  const [ending, setEnding] = useState<Employee | null>(null);
  const q = useQuery({ queryKey: ['employees'], queryFn: hcm.employees });
  const write = can('employees:write');
  return (
    <>
      <div className="page-head">
        <div><h1>Employees</h1><p className="sub">Pay rates, identifiers and bank accounts are stored encrypted and never shown in this list.</p></div>
        <div className="actions">{write && can('payroll:manage') && <button className="btn primary" onClick={() => setAdding(true)}>Add employee</button>}</div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="employees" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th className="code">No.</th><th>Name</th><th>Department</th><th>Pay</th><th>Hired</th><th>Status</th><th /></tr></thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id} className={e.status === 'active' ? '' : 'off'}>
                <td className="code">{e.emp_no}</td><td className="name">{e.full_name}</td><td>{e.department ?? ''}</td><td>{e.pay_type}</td><td>{longDate(e.hire_date)}</td>
                <td>{e.status === 'active' ? 'Active' : e.status === 'terminated' ? `Left ${longDate(e.termination_date!)}` : 'Erased'}</td>
                <td className="num">{write && e.status !== 'erased' && <button className="linkbtn" onClick={() => setShowing(e)}>Show IDs</button>}{write && e.status === 'active' && <> · <button className="linkbtn" onClick={() => setEnding(e)}>End employment</button></>}</td>
              </tr>
            ))}
            {q.data.length === 0 && <tr><td colSpan={7} className="empty">No employees yet.</td></tr>}
          </tbody>
        </table></div>
      )}
      <AddEmployee open={adding} onClose={() => setAdding(false)} onDone={() => { toast('Employee added'); void qc.invalidateQueries({ queryKey: ['employees'] }); }} />
      <ShowIds emp={showing} onClose={() => setShowing(null)} />
      <End emp={ending} onClose={() => setEnding(null)} onDone={() => { toast('Employment ended'); void qc.invalidateQueries({ queryKey: ['employees'] }); }} />
    </>
  );
}

function AddEmployee({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const blank = { full_name: '', email: '', phone: '', department: '', position: '', hire_date: todayIso(), pay_type: 'monthly', rate: '', tin: '', sss: '', philhealth: '', pagibig: '', bank_account: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => hcm.createEmployee({
      full_name: f.full_name.trim(), hire_date: f.hire_date, pay_type: f.pay_type as 'monthly', rate: toApi(parseAmount(f.rate)!),
      ...Object.fromEntries((['email', 'phone', 'department', 'position', 'tin', 'sss', 'philhealth', 'pagibig', 'bank_account'] as const).filter((k) => f[k].trim()).map((k) => [k, f[k].trim()])),
    }),
    onSuccess: () => { onDone(); setF(blank); setErr(null); onClose(); },
    onError: (e) => setErr(errText(e, 'Could not save.')),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!f.full_name.trim()) return setErr('Enter a name.'); if (parseAmount(f.rate) === null || parseAmount(f.rate) === 0n) return setErr('Enter the pay rate, like 28000 or 850.50.'); m.mutate(); };
  const field = (id: string, label: string, k: keyof typeof blank, extra: object = {}) => <div><label htmlFor={id}>{label}</label><input id={id} value={f[k]} onChange={set(k)} autoComplete="off" {...extra} /></div>;
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Add employee">
      <form onSubmit={submit} className="stack" noValidate>
        {field('en', 'Full name', 'full_name', { autoFocus: true, maxLength: 200 })}
        {field('ee', 'Email', 'email', { type: 'email' })}{field('ep', 'Phone', 'phone')}{field('ed', 'Department', 'department')}{field('eo', 'Position', 'position')}
        {field('eh', 'Hire date', 'hire_date', { type: 'date', style: { width: 'auto' } })}
        <div><label htmlFor="et">Paid</label><select id="et" value={f.pay_type} onChange={set('pay_type')}><option value="monthly">Monthly</option><option value="daily">Daily</option><option value="hourly">Hourly</option></select></div>
        {field('er', f.pay_type === 'monthly' ? 'Monthly rate' : f.pay_type === 'daily' ? 'Daily rate' : 'Hourly rate', 'rate', { inputMode: 'decimal', style: { maxWidth: 160 } })}
        <details><summary>Identifiers (encrypted)</summary><div className="stack" style={{ marginTop: 8 }}>{field('t1', 'TIN', 'tin')}{field('t2', 'SSS number', 'sss')}{field('t3', 'PhilHealth number', 'philhealth')}{field('t4', 'Pag-IBIG number', 'pagibig')}{field('t5', 'Bank account', 'bank_account')}</div></details>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Save</button></div>
      </form>
    </Dialog>
  );
}

function ShowIds({ emp, onClose }: { emp: Employee | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ids', emp?.id], queryFn: () => hcm.identifiers(emp!.id), enabled: !!emp, gcTime: 0, staleTime: 0 });
  const label: Record<string, string> = { tin: 'TIN', sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG', bank_account: 'Bank account', birth_date: 'Birth date' };
  return (
    <Dialog open={!!emp} onClose={onClose} title={emp ? `Identifiers: ${emp.full_name}` : ''}>
      <p className="muted">Showing these is recorded in the audit log.</p>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="identifiers" />}
      {q.data && <dl>{Object.entries(label).map(([k, l]) => <div key={k} style={{ display: 'flex', gap: 12 }}><dt style={{ width: 120 }} className="muted">{l}</dt><dd className="mono">{q.data[k] ?? 'not on file'}</dd></div>)}</dl>}
      <div className="row"><button className="btn" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

function End({ emp, onClose, onDone }: { emp: Employee | null; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayIso());
  const m = useMutation({ mutationFn: () => hcm.terminate(emp!.id, date), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Dialog open={!!emp} onClose={onClose} title={emp ? `End employment: ${emp.full_name}` : ''}>
      <div className="stack"><div><label htmlFor="ed2">Last day</label><input id="ed2" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div><Problem error={m.error} /></div>
      <div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>End employment</button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ attendance
export function AttendancePage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [from, setFrom] = useState(`${todayIso().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayIso());
  const [adding, setAdding] = useState(false);
  const ok = from <= to;
  const q = useQuery({ queryKey: ['attendance', from, to], queryFn: () => hcm.attendance(from, to), enabled: ok });
  const del = useMutation({ mutationFn: (id: string) => hcm.removeDay(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance'] }) });
  const write = can('employees:write');
  return (
    <>
      <div className="page-head">
        <div><h1>Attendance</h1><p className="sub">Hours come from the shift and the times you enter. A day inside a locked payroll run cannot be changed.</p></div>
        <div className="actions">
          <div><label htmlFor="af">From</label><input id="af" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} /></div>
          <div><label htmlFor="at">To</label><input id="at" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} /></div>
          {write && <button className="btn primary" onClick={() => setAdding(true)}>Record a day</button>}
        </div>
      </div>
      <Problem error={q.error ?? del.error} />
      {q.isLoading && <Loading what="attendance" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Date</th><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th className="num">Regular</th><th className="num">Overtime</th><th /></tr></thead>
          <tbody>
            {q.data.map((a) => <tr key={a.id}><td>{longDate(a.work_date)}</td><td className="name">{a.full_name}</td><td>{a.status}</td><td>{a.time_in ?? ''}</td><td>{a.time_out ?? ''}</td><td className="num">{hrs(a.regular_hours)}</td><td className="num">{hrs(a.overtime_hours)}</td><td className="num">{write && <button className="linkbtn" onClick={() => del.mutate(a.id)}>Remove</button>}</td></tr>)}
            {q.data.length === 0 && <tr><td colSpan={8} className="empty">Nothing recorded in this range.</td></tr>}
          </tbody>
        </table></div>
      )}
      <RecordDay open={adding} onClose={() => setAdding(false)} onDone={() => { toast('Recorded'); void qc.invalidateQueries({ queryKey: ['attendance'] }); }} />
    </>
  );
}

function RecordDay({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const emps = useQuery({ queryKey: ['employees'], queryFn: hcm.employees, enabled: open });
  const shifts = useQuery({ queryKey: ['shifts'], queryFn: hcm.shifts, enabled: open });
  const [f, setF] = useState({ employee_id: '', work_date: todayIso(), status: 'present', shift_id: '', time_in: '', time_out: '' });
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => hcm.record({ employee_id: f.employee_id, work_date: f.work_date, status: f.status, ...(f.shift_id && { shift_id: f.shift_id }), ...(f.time_in && { time_in: f.time_in }), ...(f.time_out && { time_out: f.time_out }) }),
    onSuccess: () => { onDone(); setErr(null); onClose(); },
    onError: (e) => setErr(errText(e, 'Could not record.')),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!f.employee_id) return setErr('Choose an employee.'); if ((f.time_in && !f.time_out) || (!f.time_in && f.time_out)) return setErr('Enter both times or neither.'); m.mutate(); };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Record a day">
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="re">Employee</label><select id="re" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}><option value="">Choose…</option>{(emps.data ?? []).filter((e) => e.status === 'active').map((e) => <option key={e.id} value={e.id}>{e.emp_no} · {e.full_name}</option>)}</select></div>
        <div><label htmlFor="rd">Date</label><input id="rd" type="date" value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} style={{ width: 'auto' }} /></div>
        <div><label htmlFor="rs">Status</label><select id="rs" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="present">Present</option><option value="absent">Absent</option><option value="leave">Paid leave</option></select></div>
        {f.status === 'present' && <>
          <div><label htmlFor="rh">Shift</label><select id="rh" value={f.shift_id} onChange={(e) => setF({ ...f, shift_id: e.target.value })}><option value="">No shift (8 hours)</option>{(shifts.data ?? []).filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.start_time}-{s.end_time}</option>)}</select></div>
          <div className="row" style={{ gap: 12 }}><div><label htmlFor="ri">In</label><input id="ri" type="time" value={f.time_in} onChange={(e) => setF({ ...f, time_in: e.target.value })} /></div><div><label htmlFor="ro">Out</label><input id="ro" type="time" value={f.time_out} onChange={(e) => setF({ ...f, time_out: e.target.value })} /></div></div>
        </>}
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Save</button></div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ payroll
const STATUS = { draft: 'Draft', locked: 'Approved, unpaid', paid: 'Paid' } as const;

export function PayrollPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['runs'], queryFn: hcm.runs });
  const liab = useQuery({ queryKey: ['liabilities'], queryFn: hcm.liabilities });
  return (
    <>
      <div className="page-head">
        <div><h1>Payroll</h1><p className="sub">A run is prepared as a draft. A different person approves it, which posts it to the ledger and freezes it.</p></div>
        <div className="actions">{can('payroll:manage') && <><Link className="btn" to="/payroll/rules">Rates and brackets</Link><button className="btn primary" onClick={() => setAdding(true)}>New run</button></>}</div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="payroll runs" />}
      {q.data && (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Run</th><th>Period</th><th>Pay date</th><th>Status</th><th className="num">People</th><th className="num">Gross</th><th className="num">Net</th></tr></thead>
          <tbody>
            {q.data.map((r) => <tr key={r.id}><td className="code"><Link to={`/payroll/${r.id}`}>{r.run_no ? `PR-${r.run_no}` : 'Draft'}</Link></td><td>{longDate(r.period_start)} – {longDate(r.period_end)}</td><td>{longDate(r.pay_date)}</td><td>{STATUS[r.status]}</td><td className="num">{r.employees}</td><td className="num">{formatApiNum(r.gross)}</td><td className="num">{formatApiNum(r.net)}</td></tr>)}
            {q.data.length === 0 && <tr><td colSpan={7} className="empty">No payroll runs yet.</td></tr>}
          </tbody>
        </table></div>
      )}
      {liab.data && <p className={liab.data.reconciles ? 'muted' : 'notice warn'} style={{ marginTop: 12 }} role="status">{liab.data.reconciles ? 'Net pay, withholding tax and contributions owed agree with the ledger.' : 'Payroll liabilities in the ledger differ from the approved payslips. A manual journal entry may have been posted to a payroll account.'}</p>}
      <NewRun open={adding} onClose={() => setAdding(false)} onDone={(id) => nav(`/payroll/${id}`)} />
    </>
  );
}

function NewRun({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const n = new Date();
  const first = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const [f, setF] = useState({ period_start: first, period_end: last, pay_date: last, frequency: 'monthly' });
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({ mutationFn: () => hcm.createRun(f), onSuccess: (r) => { setErr(null); onClose(); onDone(r.id); }, onError: (e) => setErr(errText(e, 'Could not create the run.')) });
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="New payroll run">
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="stack" noValidate>
        <div><label htmlFor="ps">Period start</label><input id="ps" type="date" value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} style={{ width: 'auto' }} /></div>
        <div><label htmlFor="pe">Period end</label><input id="pe" type="date" value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} style={{ width: 'auto' }} /></div>
        <div><label htmlFor="pd">Pay date</label><input id="pd" type="date" value={f.pay_date} onChange={(e) => setF({ ...f, pay_date: e.target.value })} style={{ width: 'auto' }} /></div>
        <div><label htmlFor="pf">Frequency</label><select id="pf" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="monthly">Monthly</option><option value="semi_monthly">Semi-monthly</option></select></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Compute</button></div>
      </form>
    </Dialog>
  );
}

export function PayrollRunPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [adj, setAdj] = useState(false);
  const [paying, setPaying] = useState(false);
  const q = useQuery({ queryKey: ['run', id], queryFn: () => hcm.run(id!) });
  const [warnings, setWarnings] = useState<string[]>([]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['run', id] }); void qc.invalidateQueries({ queryKey: ['runs'] }); void qc.invalidateQueries({ queryKey: ['liabilities'] }); };
  const act = useMutation({
    mutationFn: (a: 'recompute' | 'lock' | 'delete'): Promise<unknown> => (a === 'recompute' ? hcm.recompute(id!) : a === 'lock' ? hcm.lock(id!) : hcm.deleteRun(id!)),
    onSuccess: (r, a) => { if (a === 'delete') { toast('Draft deleted'); nav('/payroll'); } else { setWarnings((r as RunDetail).warnings ?? []); toast(a === 'lock' ? 'Approved and posted' : 'Recomputed'); refresh(); } },
  });
  const rm = useMutation({ mutationFn: (a: string) => hcm.removeAdjustment(id!, a), onSuccess: () => refresh() });
  const r = q.data;
  const mine = !!r && r.created_by === user?.id;
  const sum = (k: keyof RunDetail['payslips'][number]) => (r?.payslips ?? []).reduce((s, x) => s + BigInt(String(x[k]).replace('.', '')), 0n);
  const total = (k: keyof RunDetail['payslips'][number]) => { const v = sum(k).toString().padStart(5, '0'); return `${v.slice(0, -4)}.${v.slice(-4)}`; };
  return (
    <>
      <div className="page-head">
        <div><h1>{r ? (r.run_no ? `Payroll PR-${r.run_no}` : 'Payroll draft') : 'Payroll'}</h1>{r && <p className="sub">{longDate(r.period_start)} – {longDate(r.period_end)} · pay date {longDate(r.pay_date)} · {STATUS[r.status]}</p>}</div>
        {r && (
          <div className="actions">
            {r.status === 'draft' && can('payroll:manage') && <><button className="btn" onClick={() => setAdj(true)}>Add adjustment</button><button className="btn" disabled={act.isPending} onClick={() => act.mutate('recompute')}>Recompute</button><button className="btn" disabled={act.isPending} onClick={() => act.mutate('delete')}>Delete draft</button></>}
            {r.status === 'draft' && can('payroll:approve') && <button className="btn primary" disabled={act.isPending || mine} title={mine ? 'You prepared this run, so someone else must approve it.' : undefined} onClick={() => { if (window.confirm('Approve and post this payroll? It cannot be changed afterwards.')) act.mutate('lock'); }}>Approve and post</button>}
            {r.status === 'locked' && can('payroll:approve') && <button className="btn primary" onClick={() => setPaying(true)}>Record payment</button>}
          </div>
        )}
      </div>
      {r && r.status === 'draft' && mine && can('payroll:approve') && <div className="notice warn">You prepared this run, so someone else has to approve it.</div>}
      <Problem error={q.error ?? act.error ?? rm.error} />
      {warnings.length > 0 && <div className="notice warn" role="status">{warnings.map((w) => <div key={w}>{w}</div>)}</div>}
      {q.isLoading && <Loading what="payroll run" />}
      {r && (
        <>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Employee</th><th className="num">Days</th><th className="num">OT hrs</th><th className="num">Gross</th><th className="num">SSS</th><th className="num">PhilHealth</th><th className="num">Pag-IBIG</th><th className="num">Tax</th><th className="num">Other</th><th className="num">Net</th></tr></thead>
            <tbody>
              {r.payslips.map((s) => <tr key={s.id}><td className="name">{s.employee_name}</td><td className="num">{hrs(s.days_worked)}</td><td className="num">{hrs(s.overtime_hours)}</td><td className="num">{formatApiNum(s.gross)}</td><td className="num">{formatApiNum(s.sss_ee)}</td><td className="num">{formatApiNum(s.philhealth_ee)}</td><td className="num">{formatApiNum(s.pagibig_ee)}</td><td className="num">{formatApiNum(s.tax)}</td><td className="num">{formatApiNum(s.other_deductions)}</td><td className="num"><b>{formatApiNum(s.net)}</b></td></tr>)}
              {r.payslips.length === 0 && <tr><td colSpan={10} className="empty">Nobody was employed in this period.</td></tr>}
              {r.payslips.length > 0 && <tr className="group"><td colSpan={3}>Total</td><td className="num">{formatApiNum(total('gross'))}</td><td className="num">{formatApiNum(total('sss_ee'))}</td><td className="num">{formatApiNum(total('philhealth_ee'))}</td><td className="num">{formatApiNum(total('pagibig_ee'))}</td><td className="num">{formatApiNum(total('tax'))}</td><td className="num">{formatApiNum(total('other_deductions'))}</td><td className="num">{formatApiNum(total('net'))}</td></tr>}
            </tbody>
          </table></div>
          <p className="muted" style={{ marginTop: 8 }}>Employer share on top: SSS {formatApiNum(total('sss_er'))}, PhilHealth {formatApiNum(total('philhealth_er'))}, Pag-IBIG {formatApiNum(total('pagibig_er'))}.</p>
          {r.adjustments.length > 0 && (
            <>
              <h2 style={{ marginTop: 20 }}>Adjustments</h2>
              <div className="tbl-wrap"><table><tbody>
                {r.adjustments.map((a) => <tr key={a.id}><td className="name">{r.payslips.find((s) => s.employee_id === a.employee_id)?.employee_name}</td><td>{a.kind === 'earning' ? 'Earning' : 'Deduction'}: {a.description}</td><td className="num">{formatApiNum(a.amount)}</td><td className="num">{r.status === 'draft' && can('payroll:manage') && <button className="linkbtn" onClick={() => rm.mutate(a.id)}>Remove</button>}</td></tr>)}
              </tbody></table></div>
            </>
          )}
          <Adjust run={r} open={adj} onClose={() => setAdj(false)} onDone={(w) => { setWarnings(w); toast('Adjustment added'); refresh(); }} />
          <PayDialog id={r.id} open={paying} onClose={() => setPaying(false)} onDone={() => { toast('Payment recorded'); refresh(); }} />
        </>
      )}
    </>
  );
}

function Adjust({ run, open, onClose, onDone }: { run: RunDetail; open: boolean; onClose: () => void; onDone: (w: string[]) => void }) {
  const [f, setF] = useState({ employee_id: '', kind: 'earning', description: '', amount: '' });
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => hcm.addAdjustment(run.id, { employee_id: f.employee_id, kind: f.kind, description: f.description.trim(), amount: toApi(parseAmount(f.amount)!) }),
    onSuccess: (r) => { onDone(r.warnings ?? []); setF({ employee_id: '', kind: 'earning', description: '', amount: '' }); setErr(null); onClose(); },
    onError: (e) => setErr(errText(e, 'Could not add.')),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!f.employee_id || !f.description.trim()) return setErr('Choose a person and say what it is for.'); if (parseAmount(f.amount) === null || parseAmount(f.amount) === 0n) return setErr('Enter an amount.'); m.mutate(); };
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Add adjustment">
      <form onSubmit={submit} className="stack" noValidate>
        <div><label htmlFor="ae">Employee</label><select id="ae" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}><option value="">Choose…</option>{run.payslips.map((s) => <option key={s.employee_id} value={s.employee_id}>{s.employee_name}</option>)}</select></div>
        <div><label htmlFor="ak">Kind</label><select id="ak" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="earning">Extra pay (allowance, bonus)</option><option value="deduction">Deduction (loan, advance)</option></select></div>
        <div><label htmlFor="ad2">What for</label><input id="ad2" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={200} /></div>
        <div><label htmlFor="aa">Amount</label><input id="aa" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ maxWidth: 160 }} /></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Add and recompute</button></div>
      </form>
    </Dialog>
  );
}

function PayDialog({ id, open, onClose, onDone }: { id: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts, enabled: open });
  const [bank, setBank] = useState('');
  const [date, setDate] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({ mutationFn: () => hcm.pay(id, bank, date), onSuccess: () => { onDone(); setErr(null); onClose(); }, onError: (e) => setErr(errText(e, 'Could not record.')) });
  return (
    <Dialog open={open} onClose={() => { setErr(null); onClose(); }} title="Record payment of net pay">
      <form onSubmit={(e) => { e.preventDefault(); if (!bank) return setErr('Choose the account the money came from.'); m.mutate(); }} className="stack" noValidate>
        <div><label htmlFor="pb2">Paid from</label><select id="pb2" value={bank} onChange={(e) => setBank(e.target.value)}><option value="">Choose…</option>{(accounts.data ?? []).filter((a) => a.is_active && a.type === 'asset').map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
        <div><label htmlFor="pd2">Date</label><input id="pd2" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></div>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending}>Record</button></div>
      </form>
    </Dialog>
  );
}

export function RulesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['rules'], queryFn: hcm.rules });
  const [ot, setOt] = useState<string | null>(null);
  const [stat, setStat] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => hcm.saveRules({
      ...(ot !== null && { ot_multiplier: Number(ot) }),
      statutory: (q.data?.statutory ?? []).map((s) => ({ code: s.code, ee_rate: stat[`${s.code}.ee`] ?? s.ee_rate, er_rate: stat[`${s.code}.er`] ?? s.er_rate, base_min: stat[`${s.code}.min`] ?? s.base_min, base_max: stat[`${s.code}.max`] ?? s.base_max })),
    }),
    onSuccess: () => { toast('Rules saved'); setStat({}); setOt(null); setErr(null); void qc.invalidateQueries({ queryKey: ['rules'] }); },
    onError: (e) => setErr(errText(e, 'Could not save.')),
  });
  const cell = (code: string, k: 'ee' | 'er' | 'min' | 'max', current: string) => <input aria-label={`${code} ${k}`} inputMode="decimal" value={stat[`${code}.${k}`] ?? hrs(current)} onChange={(e) => setStat({ ...stat, [`${code}.${k}`]: e.target.value })} style={{ width: 110, textAlign: 'right' }} />;
  return (
    <>
      <div className="page-head"><div><h1>Rates and brackets</h1><p className="sub">Starting values only. Confirm them with your accountant and keep them current here.</p></div></div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="rules" />}
      {q.data && (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }} className="stack" noValidate>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Contribution</th><th className="num">Employee %</th><th className="num">Employer %</th><th className="num">Salary base from</th><th className="num">Salary base up to</th></tr></thead>
            <tbody>{q.data.statutory.map((s) => <tr key={s.code}><td className="name">{s.code === 'sss' ? 'SSS' : s.code === 'philhealth' ? 'PhilHealth' : 'Pag-IBIG'}</td><td className="num">{cell(s.code, 'ee', s.ee_rate)}</td><td className="num">{cell(s.code, 'er', s.er_rate)}</td><td className="num">{cell(s.code, 'min', s.base_min)}</td><td className="num">{cell(s.code, 'max', s.base_max)}</td></tr>)}</tbody>
          </table></div>
          <div><label htmlFor="ot">Overtime multiplier</label><input id="ot" inputMode="decimal" value={ot ?? hrs(q.data.ot_multiplier)} onChange={(e) => setOt(e.target.value)} style={{ maxWidth: 100 }} /></div>
          <h2>Monthly withholding tax brackets</h2>
          <div className="tbl-wrap"><table>
            <thead><tr><th className="num">Over</th><th className="num">Up to</th><th className="num">Base tax</th><th className="num">Plus %</th></tr></thead>
            <tbody>{q.data.brackets.map((b) => <tr key={b.lower}><td className="num">{formatApiNum(b.lower)}</td><td className="num">{b.upper ? formatApiNum(b.upper) : 'and above'}</td><td className="num">{formatApiNum(b.base_tax)}</td><td className="num">{hrs(b.rate)}</td></tr>)}</tbody>
          </table></div>
          {err && <div className="field-error" role="alert">{err}</div>}
          <div className="row"><button className="btn primary" disabled={save.isPending}>Save rates</button></div>
        </form>
      )}
    </>
  );
}
