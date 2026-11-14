import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountIds, auth, newApi, owner, resetData, seedTenant, shutdown, tokenFor, type Api, type Seeded } from './helpers.js';

let api: Api;
let t: Seeded;
let acc: Record<string, string>;
let hr: string;
let apr: string;
let adm: string;
let vic: string;
let monthly: string; // 30,000 a month
let daily: string; // 1,000 a day

const MODS = ['finance', 'hcm'];
beforeAll(() => { api = newApi(); });
beforeEach(async () => {
  await resetData();
  t = await seedTenant('hc-co', { hr: ['HRManager'], apr: ['PayrollApprover'], adm: ['TenantAdmin'], vic: ['Viewer'], amy: ['FinanceManager'] }, false, { modules: MODS });
  [hr, apr, adm, vic] = await Promise.all([tokenFor(api, t, 'hr'), tokenFor(api, t, 'apr'), tokenFor(api, t, 'adm'), tokenFor(api, t, 'vic')]);
  acc = await accountIds(t.tenantId);
  monthly = (await api.post('/api/v1/employees').set(auth(hr)).send({ full_name: 'Ana Reyes', hire_date: '2025-01-06', pay_type: 'monthly', rate: '30000', email: 'ana@example.test', tin: '123-456-789-000', bank_account: '0011-2233-44' }).expect(201)).body.id;
  daily = (await api.post('/api/v1/employees').set(auth(hr)).send({ full_name: 'Ben Cruz', hire_date: '2025-03-03', pay_type: 'daily', rate: '1000' }).expect(201)).body.id;
});
afterAll(shutdown);

const att = (employee_id: string, work_date: string, extra: object = { status: 'present' }, tok = hr) => api.post('/api/v1/attendance').set(auth(tok)).send({ employee_id, work_date, ...extra });
async function benWorks() {
  for (let d = 2; d <= 11; d += 1) await att(daily, `2026-11-${String(d).padStart(2, '0')}`, d === 11 ? { status: 'present', overtime_hours: 4 } : { status: 'present' }).expect(201);
}
const run = (over: object = {}, tok = hr) => api.post('/api/v1/payroll-runs').set(auth(tok)).send({ period_start: '2026-11-01', period_end: '2026-11-30', pay_date: '2026-11-30', frequency: 'monthly', ...over });
const slip = (r: { payslips: { employee_id: string }[] }, id: string) => r.payslips.find((s) => s.employee_id === id) as Record<string, string>;
const bal = async (code: string) => {
  const r = ((await api.get('/api/v1/reports/trial-balance').query({ as_of: '2026-12-31' }).set(auth(adm))).body.rows as { code: string; debit: string; credit: string }[]).find((x) => x.code === code);
  return r ? `${r.debit}/${r.credit}` : 'none';
};

describe('employees and sensitive data', () => {
  it('lists without pay or identifiers, stores them encrypted, reveals on request and audits it', async () => {
    const list = (await api.get('/api/v1/employees').set(auth(hr)).expect(200)).body;
    expect(list).toHaveLength(2);
    const json = JSON.stringify(list);
    expect(json).not.toContain('123-456');
    expect(json).not.toContain('30000');
    expect(list[0]).toMatchObject({ emp_no: '1', has_tin: true, has_bank_account: true });
    const raw = (await owner.query('SELECT rate_enc, tin_enc, bank_account_enc FROM employees WHERE id = $1', [monthly])).rows[0];
    for (const v of Object.values(raw) as string[]) { expect(v.startsWith('enc1.')).toBe(true); expect(v).not.toContain('30000'); expect(v).not.toContain('123-456'); }
    expect((await api.get(`/api/v1/employees/${monthly}/identifiers`).set(auth(hr)).expect(200)).body).toMatchObject({ tin: '123-456-789-000', bank_account: '0011-2233-44', sss: null });
    expect((await api.get(`/api/v1/employees/${monthly}/compensation`).set(auth(hr)).expect(200)).body).toEqual({ pay_type: 'monthly', rate: '30000.0000' });
    const a = await owner.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action IN ('employee.identifiers_viewed', 'employee.compensation_viewed')", [t.tenantId]);
    expect(a.rowCount).toBe(2);
  });

  it('needs the right permissions: a viewer sees nothing, an approver cannot add people, pay changes need payroll access', async () => {
    expect((await api.get('/api/v1/employees').set(auth(vic))).status).toBe(403);
    expect((await api.get('/api/v1/employees').set(auth(apr)).expect(200)).body).toHaveLength(2);
    expect((await api.post('/api/v1/employees').set(auth(apr)).send({ full_name: 'X', hire_date: '2026-01-01', pay_type: 'monthly', rate: '1' })).status).toBe(403);
    expect((await api.get(`/api/v1/employees/${monthly}/compensation`).set(auth(vic))).status).toBe(403);
    expect((await api.get('/api/v1/employees')).status).toBe(401);
    expect((await api.post('/api/v1/employees').set(auth(hr)).send({ full_name: 'X', hire_date: '2026-01-01', pay_type: 'monthly', rate: '0' })).status).toBe(422);
  });

  it('a patch changes only what is sent; a null clears an identifier', async () => {
    await api.patch(`/api/v1/employees/${monthly}`).set(auth(hr)).send({ department: 'Finance', tin: null, rate: '32000' }).expect(200);
    const ids = (await api.get(`/api/v1/employees/${monthly}/identifiers`).set(auth(hr))).body;
    expect(ids.tin).toBeNull();
    expect(ids.bank_account).toBe('0011-2233-44');
    expect((await api.get(`/api/v1/employees/${monthly}/compensation`).set(auth(hr))).body.rate).toBe('32000.0000');
    expect((await api.patch(`/api/v1/employees/${monthly}`).set(auth(hr)).send({})).status).toBe(422);
  });
});

describe('shifts and attendance', () => {
  it('works hours out from the shift: break taken off, the rest beyond the shift is overtime', async () => {
    const shift = (await api.post('/api/v1/shifts').set(auth(hr)).send({ code: 'day', name: 'Day', start_time: '08:00', end_time: '17:00', break_minutes: 60 }).expect(201)).body;
    expect(shift.code).toBe('DAY');
    const a = (await att(monthly, '2026-11-03', { status: 'present', shift_id: shift.id, time_in: '08:00', time_out: '19:00' }).expect(201)).body;
    expect(a).toMatchObject({ regular_hours: 8, overtime_hours: 2 });
    const b = (await att(monthly, '2026-11-04', { status: 'present', shift_id: shift.id, time_in: '09:00', time_out: '15:00' }).expect(201)).body;
    expect(b).toMatchObject({ regular_hours: 5, overtime_hours: 0 });
    const c = (await att(monthly, '2026-11-05', { status: 'absent' }).expect(201)).body;
    expect(c).toMatchObject({ regular_hours: 0, overtime_hours: 0 });
    await att(monthly, '2026-11-03', { status: 'present', regular_hours: 6 }).expect(201); // same day again updates
    const list = (await api.get('/api/v1/attendance').query({ from: '2026-11-01', to: '2026-11-30', employee_id: monthly }).set(auth(hr)).expect(200)).body;
    expect(list).toHaveLength(3);
  });

  it('refuses days outside employment, unknown people and shifts, and bad times', async () => {
    expect((await att(daily, '2025-01-01')).status).toBe(422);
    expect((await att('00000000-0000-4000-8000-000000000000', '2026-11-03')).status).toBe(422);
    expect((await att(monthly, '2026-11-03', { status: 'present', shift_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
    expect((await att(monthly, '2026-11-03', { status: 'present', time_in: '25:00', time_out: '17:00' })).status).toBe(422);
    expect((await att(monthly, '2026-11-03', { status: 'present' }, vic)).status).toBe(403);
  });
});

describe('payroll computation', () => {
  it('works out pay, statutory contributions and withholding tax exactly', async () => {
    await benWorks();
    const r = (await run().expect(201)).body;
    const a = slip(r, monthly);
    expect(a).toMatchObject({ basic: '30000.0000', gross: '30000.0000', sss_ee: '1500.0000', philhealth_ee: '750.0000', pagibig_ee: '200.0000', tax: '1007.5500', net: '26542.4500', sss_er: '3000.0000', philhealth_er: '750.0000', pagibig_er: '200.0000' });
    const b = slip(r, daily);
    expect(b).toMatchObject({ days_worked: '10.00', basic: '10000.0000', overtime_pay: '625.0000', gross: '10625.0000', sss_ee: '531.2500', philhealth_ee: '265.6300', pagibig_ee: '200.0000', tax: '0.0000', net: '9628.1200' });
    expect(r.employees).toBe(2);
    expect(r.status).toBe('draft');
  });

  it('a semi-monthly run halves pay and shares the monthly statutory amounts', async () => {
    const r = (await run({ period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-15', frequency: 'semi_monthly' }).expect(201)).body;
    const a = slip(r, monthly);
    expect(a).toMatchObject({ basic: '15000.0000', gross: '15000.0000', sss_ee: '750.0000', tax: '503.7800' });
  });

  it('prorates a new hire and takes off absent days at the daily equivalent', async () => {
    const x = (await api.post('/api/v1/employees').set(auth(hr)).send({ full_name: 'Cara Diaz', hire_date: '2026-11-16', pay_type: 'monthly', rate: '30000' }).expect(201)).body.id;
    await att(monthly, '2026-11-09', { status: 'absent' }).expect(201);
    const r = (await run().expect(201)).body;
    expect(slip(r, x).basic).toBe('15000.0000'); // 15 of 30 days
    expect(slip(r, monthly).basic).toBe('28620.6900'); // 30000 - 1 day at 30000 / 21.75 = 1379.31
  });

  it('adjustments add pay or take it off; deductions beyond take-home pay are capped with a warning', async () => {
    const r0 = (await run().expect(201)).body;
    const r1 = (await api.post(`/api/v1/payroll-runs/${r0.id}/adjustments`).set(auth(hr)).send({ employee_id: daily, kind: 'earning', description: 'Allowance', amount: '500' }).expect(201)).body;
    expect(slip(r1, daily).other_earnings).toBe('500.0000');
    expect(slip(r1, daily).net).toBe('0.0000'); // 500 earned, contributions limited to it
    expect(r1.warnings[0]).toContain('limited to the pay earned');
    const r2 = (await api.post(`/api/v1/payroll-runs/${r0.id}/adjustments`).set(auth(hr)).send({ employee_id: monthly, kind: 'deduction', description: 'Loan', amount: '999999' }).expect(201)).body;
    expect(r2.warnings[0]).toContain('exceed take-home pay');
    expect(slip(r2, monthly).net).toBe('0.0000');
    const adj = r2.adjustments.find((x: { description: string }) => x.description === 'Loan');
    const r3 = (await api.delete(`/api/v1/payroll-runs/${r0.id}/adjustments/${adj.id}`).set(auth(hr)).expect(200)).body;
    expect(slip(r3, monthly).net).toBe('26542.4500');
  });

  it('refuses a bad period, an overlapping run, and a workspace without rules', async () => {
    expect((await run({ period_end: '2026-10-01' })).status).toBe(422);
    expect((await run({ period_start: '2026-10-01', period_end: '2026-12-31' })).status).toBe(422);
    await run().expect(201);
    expect((await run({ period_start: '2026-11-20', period_end: '2026-12-10' })).status).toBe(409);
    await owner.query('DELETE FROM statutory_rules WHERE tenant_id = $1', [t.tenantId]);
    expect((await run({ period_start: '2027-01-01', period_end: '2027-01-31', pay_date: '2027-01-31' })).status).toBe(409);
  });
});

describe('rules as data', () => {
  it('changing a rate changes the next computation; brackets must be contiguous and open-ended', async () => {
    await api.put('/api/v1/payroll/rules').set(auth(hr)).send({ statutory: [{ code: 'sss', ee_rate: '4', er_rate: '8', base_min: '5000', base_max: '35000' }] }).expect(200);
    const r = (await run().expect(201)).body;
    expect(slip(r, monthly).sss_ee).toBe('1200.0000');
    const bad = await api.put('/api/v1/payroll/rules').set(auth(hr)).send({ brackets: [{ lower: '0', upper: '100', base_tax: '0', rate: '0' }, { lower: '200', upper: null, base_tax: '0', rate: '10' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_brackets');
    expect((await api.put('/api/v1/payroll/rules').set(auth(hr)).send({ brackets: [{ lower: '0', upper: '100', base_tax: '0', rate: '0' }] })).status).toBe(422);
    await api.put('/api/v1/payroll/rules').set(auth(hr)).send({ brackets: [{ lower: '0', upper: null, base_tax: '0', rate: '10' }], ot_multiplier: 1.5 }).expect(200);
    expect((await api.get('/api/v1/payroll/rules').set(auth(apr)).expect(200)).body.ot_multiplier).toBe('1.50');
    expect((await api.put('/api/v1/payroll/rules').set(auth(apr)).send({ ot_multiplier: 2 })).status).toBe(403);
  });
});

describe('locking, posting and paying', () => {
  async function ready() { await benWorks(); return (await run().expect(201)).body as { id: string; payslips: { employee_id: string }[] }; }

  it('the preparer cannot approve their own run, even an administrator who holds both permissions', async () => {
    const r = (await run({}, adm).expect(201)).body;
    const self = await api.post(`/api/v1/payroll-runs/${r.id}/lock`).set(auth(adm));
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval');
    expect((await api.post(`/api/v1/payroll-runs/${r.id}/lock`).set(auth(hr))).status).toBe(403); // no approve permission
    await expect(owner.query("UPDATE payroll_runs SET status = 'locked', run_no = 9, locked_by = created_by, journal_entry_id = (SELECT id FROM journal_entries LIMIT 1) WHERE id = $1", [r.id])).rejects.toThrow();
  });

  it('posts one balanced entry and freezes the run', async () => {
    const r = await ready();
    const locked = (await api.post(`/api/v1/payroll-runs/${r.id}/lock`).set(auth(apr)).expect(200)).body;
    expect(locked.status).toBe('locked');
    expect(locked.run_no).toBe('1');
    const je = (await api.get(`/api/v1/journal-entries/${locked.journal_entry_id}`).set(auth(adm)).expect(200)).body;
    const by = (code: string) => je.lines.find((l: { account_code: string }) => l.account_code === code);
    // Ana: gross 30000, ER 3950, tax 1007.55; Ben: gross 10625, ER 2 x ... see below
    expect(by('6100').debit).toBe('40625.0000');
    expect(by('2220').credit).toBe('36170.5700'); // 26542.45 + 9628.12
    expect(by('2200').credit).toBe('1007.5500');
    expect(je.total).toBe(je.lines.reduce((s: number, l: { debit: string }) => s + Number(l.debit), 0).toFixed(4));
    expect(await bal('2200')).toBe('0.0000/1007.5500');
    // frozen: no edit, no delete, no new adjustment, no recompute, no re-lock; the database says so too
    const id = r.id;
    expect((await api.delete(`/api/v1/payroll-runs/${id}`).set(auth(hr))).status).toBe(409);
    expect((await api.post(`/api/v1/payroll-runs/${id}/recompute`).set(auth(hr))).status).toBe(409);
    expect((await api.post(`/api/v1/payroll-runs/${id}/adjustments`).set(auth(hr)).send({ employee_id: daily, kind: 'earning', description: 'x', amount: '1' })).status).toBe(409);
    expect((await api.post(`/api/v1/payroll-runs/${id}/lock`).set(auth(apr))).status).toBe(409);
    await expect(owner.query('UPDATE payslips SET net = 1 WHERE run_id = $1', [id])).rejects.toThrow(/locked/);
    await expect(owner.query('DELETE FROM payslips WHERE run_id = $1', [id])).rejects.toThrow(/locked/);
    await expect(owner.query('DELETE FROM payroll_runs WHERE id = $1', [id])).rejects.toThrow(/cannot be deleted/);
    // attendance inside the run is closed too, and the entry cannot be reversed by hand
    expect((await att(daily, '2026-11-12')).status).toBe(409);
    expect((await api.post(`/api/v1/journal-entries/${locked.journal_entry_id}/reverse`).set(auth(adm)).send({})).status).toBe(409);
    expect((await run().expect(409)).body.error.code).toBe('overlapping_run');
  });

  it('pays net pay once, and the liabilities in the payslips equal the ledger', async () => {
    const r = await ready();
    await api.post(`/api/v1/payroll-runs/${r.id}/lock`).set(auth(apr)).expect(200);
    let l = (await api.get('/api/v1/payroll/liabilities').set(auth(apr)).expect(200)).body;
    expect(l.reconciles).toBe(true);
    expect(l.payslips.net_unpaid).toBe('36170.5700');
    expect((await api.post(`/api/v1/payroll-runs/${r.id}/pay`).set(auth(apr)).send({ bank_account_id: acc['4000'], date: '2026-11-30' })).status).toBe(422);
    const paid = (await api.post(`/api/v1/payroll-runs/${r.id}/pay`).set(auth(apr)).send({ bank_account_id: acc['1010'], date: '2026-12-01' }).expect(200)).body;
    expect(paid.status).toBe('paid');
    expect(await bal('2220')).toBe('0.0000/0.0000');
    expect(await bal('1010')).toBe('0.0000/36170.5700');
    expect((await api.post(`/api/v1/payroll-runs/${r.id}/pay`).set(auth(apr)).send({ bank_account_id: acc['1010'], date: '2026-12-01' })).status).toBe(409);
    l = (await api.get('/api/v1/payroll/liabilities').set(auth(apr)).expect(200)).body;
    expect(l.reconciles).toBe(true);
    expect(l.payslips.net_unpaid).toBe('0.0000');
  });

  it('a draft must be paid for before it is locked: a run with no pay is refused, and unlocked runs cannot be paid', async () => {
    const empty = (await run({ period_start: '2024-01-01', period_end: '2024-01-31', pay_date: '2024-01-31' }).expect(201)).body;
    expect((await api.post(`/api/v1/payroll-runs/${empty.id}/lock`).set(auth(apr))).status).toBe(409);
    const r = await ready();
    expect((await api.post(`/api/v1/payroll-runs/${r.id}/pay`).set(auth(apr)).send({ bank_account_id: acc['1010'], date: '2026-11-30' })).status).toBe(409);
  });
});

describe('erasure and isolation', () => {
  it('only a former employee can be erased; payslips keep their amounts under a pseudonym', async () => {
    await benWorks();
    const r = (await run().expect(201)).body;
    await api.post(`/api/v1/payroll-runs/${r.id}/lock`).set(auth(apr)).expect(200);
    const adm2 = adm;
    expect((await api.post(`/api/v1/employees/${monthly}/erase`).set(auth(adm2))).status).toBe(409); // still active
    await api.post(`/api/v1/employees/${monthly}/terminate`).set(auth(hr)).send({ date: '2026-12-31' }).expect(200);
    const exp = (await api.get(`/api/v1/employees/${monthly}/export`).set(auth(adm2)).expect(200)).body;
    expect(exp.profile.full_name).toBe('Ana Reyes');
    expect(exp.identifiers.tin).toBe('123-456-789-000');
    expect(exp.payslips).toHaveLength(1);
    await api.post(`/api/v1/employees/${monthly}/erase`).set(auth(adm2)).expect(200);
    const e = (await api.get(`/api/v1/employees/${monthly}`).set(auth(hr)).expect(200)).body;
    expect(e).toMatchObject({ full_name: 'Former employee 1', status: 'erased', has_tin: false, email: null });
    const s = (await api.get(`/api/v1/payroll-runs/${r.id}`).set(auth(apr)).expect(200)).body.payslips.find((x: { employee_id: string }) => x.employee_id === monthly);
    expect(s.employee_name).toBe('Former employee 1');
    expect(s.net).toBe('26542.4500'); // the money never changes
    expect((await api.post(`/api/v1/employees/${monthly}/erase`).set(auth(adm2))).status).toBe(409);
    expect((await api.patch(`/api/v1/employees/${monthly}`).set(auth(hr)).send({ department: 'x' })).status).toBe(409);
    await expect(owner.query('UPDATE payslips SET net = 5 WHERE employee_id = $1', [monthly])).rejects.toThrow();
  });

  it('a workspace without the hcm module is refused, and another tenant sees nothing', async () => {
    const t2 = await seedTenant('no-hcm', { zed: ['HRManager'] });
    const r = await api.get('/api/v1/employees').set(auth(await tokenFor(api, t2, 'zed')));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('module_disabled');
    const t3 = await seedTenant('other-hcm', { yan: ['HRManager'] }, false, { modules: MODS });
    const yan = await tokenFor(api, t3, 'yan');
    expect((await api.get('/api/v1/employees').set(auth(yan))).body).toEqual([]);
    expect((await api.get(`/api/v1/employees/${monthly}`).set(auth(yan))).status).toBe(404);
    expect((await api.get(`/api/v1/employees/${monthly}/compensation`).set(auth(yan))).status).toBe(404);
    expect((await api.get('/api/v1/payroll-runs').set(auth(yan))).body).toEqual([]);
  });
});
