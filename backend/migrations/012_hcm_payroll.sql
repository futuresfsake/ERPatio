-- Up Migration

INSERT INTO accounts (tenant_id, code, name, type)
SELECT t.id, v.code, v.name, v.type FROM tenants t
  CROSS JOIN (VALUES ('2200', 'Withholding Tax Payable', 'liability'), ('2210', 'Contributions and Deductions Payable', 'liability'),
                     ('2220', 'Salaries Payable', 'liability'), ('6110', 'Employer Contributions Expense', 'expense')) v(code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = v.code);

ALTER TABLE tenant_settings
  ADD COLUMN salaries_account_id uuid, ADD COLUMN employer_contrib_account_id uuid, ADD COLUMN wht_account_id uuid,
  ADD COLUMN contrib_payable_account_id uuid, ADD COLUMN salaries_payable_account_id uuid,
  ADD COLUMN ot_multiplier numeric(5,2) NOT NULL DEFAULT 1.25 CHECK (ot_multiplier >= 1 AND ot_multiplier <= 3);
ALTER TABLE tenant_settings
  ADD FOREIGN KEY (tenant_id, salaries_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, employer_contrib_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, wht_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, contrib_payable_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, salaries_payable_account_id) REFERENCES accounts (tenant_id, id);
UPDATE tenant_settings s SET
  salaries_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '6100'),
  employer_contrib_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '6110'),
  wht_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '2200'),
  contrib_payable_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '2210'),
  salaries_payable_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '2220');

ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN ('invoice', 'bill', 'po', 'so', 'credit_note', 'debit_note', 'wo', 'emp', 'pr'));
INSERT INTO doc_counters (tenant_id, kind) SELECT t.id, k.kind FROM tenants t CROSS JOIN (VALUES ('emp'), ('pr')) k(kind) ON CONFLICT DO NOTHING;

-- People. Identifiers, bank account, birth date and the pay rate are stored encrypted (ADR-005); lists never return them.
CREATE TABLE employees (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  emp_no bigint NOT NULL,
  full_name varchar(200) NOT NULL,
  email varchar(254),
  phone varchar(40),
  department varchar(100),
  position varchar(100),
  hire_date date NOT NULL,
  termination_date date,
  status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated', 'erased')),
  pay_type varchar(10) NOT NULL CHECK (pay_type IN ('monthly', 'daily', 'hourly')),
  rate_enc text NOT NULL,
  tin_enc text, sss_enc text, philhealth_enc text, pagibig_enc text, bank_account_enc text, birth_date_enc text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, emp_no),
  CHECK (termination_date IS NULL OR termination_date >= hire_date),
  CHECK ((status = 'active') = (termination_date IS NULL) OR status = 'erased')
);

CREATE TABLE shifts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code varchar(20) NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,20}$'),
  name varchar(100) NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  break_minutes smallint NOT NULL DEFAULT 60 CHECK (break_minutes BETWEEN 0 AND 240),
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE attendance (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL,
  work_date date NOT NULL,
  status varchar(10) NOT NULL CHECK (status IN ('present', 'absent', 'leave')),
  shift_id uuid,
  time_in time,
  time_out time,
  regular_hours numeric(7,2) NOT NULL DEFAULT 0 CHECK (regular_hours >= 0 AND regular_hours <= 24),
  overtime_hours numeric(7,2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0 AND overtime_hours <= 24),
  note varchar(200),
  recorded_by uuid NOT NULL,
  PRIMARY KEY (id), UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users (tenant_id, id),
  CHECK (status = 'present' OR (regular_hours = 0 AND overtime_hours = 0))
);
CREATE INDEX ix_attendance_date ON attendance (tenant_id, work_date);

-- Statutory rules as data, so a rate change is an edit and not a deployment. Defaults are seeded at provisioning.
CREATE TABLE statutory_rules (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code varchar(12) NOT NULL CHECK (code IN ('sss', 'philhealth', 'pagibig')),
  ee_rate numeric(7,4) NOT NULL CHECK (ee_rate >= 0 AND ee_rate <= 100),
  er_rate numeric(7,4) NOT NULL CHECK (er_rate >= 0 AND er_rate <= 100),
  base_min numeric(19,4) NOT NULL DEFAULT 0,
  base_max numeric(19,4) NOT NULL,
  PRIMARY KEY (tenant_id, code), CHECK (base_max >= base_min)
);
CREATE TABLE tax_brackets (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  lower numeric(19,4) NOT NULL CHECK (lower >= 0),
  upper numeric(19,4),
  base_tax numeric(19,4) NOT NULL CHECK (base_tax >= 0),
  rate numeric(7,4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  PRIMARY KEY (tenant_id, lower), CHECK (upper IS NULL OR upper > lower)
);

CREATE TABLE payroll_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_no bigint,
  period_start date NOT NULL,
  period_end date NOT NULL,
  pay_date date NOT NULL,
  frequency varchar(12) NOT NULL CHECK (frequency IN ('monthly', 'semi_monthly')),
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked', 'paid')),
  created_by uuid NOT NULL,
  locked_by uuid,
  locked_at timestamptz,
  journal_entry_id uuid,
  paid_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, run_no),
  CHECK (period_end >= period_start AND pay_date >= period_start),
  CHECK (status = 'draft' OR (run_no IS NOT NULL AND locked_by IS NOT NULL AND journal_entry_id IS NOT NULL)),
  CHECK (locked_by IS NULL OR locked_by <> created_by), -- segregation of duties: the preparer cannot approve
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, locked_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, paid_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE TABLE payslips (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employee_name varchar(200) NOT NULL, -- as at the run; survives a later erasure of the employee record only as a pseudonym
  days_worked numeric(7,2) NOT NULL DEFAULT 0,
  regular_hours numeric(9,2) NOT NULL DEFAULT 0,
  overtime_hours numeric(9,2) NOT NULL DEFAULT 0,
  basic numeric(19,4) NOT NULL DEFAULT 0,
  overtime_pay numeric(19,4) NOT NULL DEFAULT 0,
  other_earnings numeric(19,4) NOT NULL DEFAULT 0,
  gross numeric(19,4) NOT NULL DEFAULT 0,
  sss_ee numeric(19,4) NOT NULL DEFAULT 0, philhealth_ee numeric(19,4) NOT NULL DEFAULT 0, pagibig_ee numeric(19,4) NOT NULL DEFAULT 0,
  tax numeric(19,4) NOT NULL DEFAULT 0,
  other_deductions numeric(19,4) NOT NULL DEFAULT 0,
  net numeric(19,4) NOT NULL DEFAULT 0,
  sss_er numeric(19,4) NOT NULL DEFAULT 0, philhealth_er numeric(19,4) NOT NULL DEFAULT 0, pagibig_er numeric(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (run_id, employee_id),
  CHECK (net >= 0),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE TABLE payroll_adjustments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  kind varchar(10) NOT NULL CHECK (kind IN ('earning', 'deduction')),
  description varchar(200) NOT NULL,
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- A locked run and everything under it never changes. Only the run's own status moves forward (locked to paid).
CREATE FUNCTION payroll_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; rid uuid;
BEGIN
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a locked payroll run cannot be deleted' USING ERRCODE = '42501'; END IF;
      RETURN OLD;
    END IF;
    IF OLD.status = 'paid' THEN RAISE EXCEPTION 'a paid payroll run cannot be changed' USING ERRCODE = '42501'; END IF;
    IF OLD.status = 'locked' AND NOT (NEW.status = 'paid' AND NEW.paid_entry_id IS NOT NULL AND NEW.journal_entry_id = OLD.journal_entry_id
         AND NEW.period_start = OLD.period_start AND NEW.period_end = OLD.period_end AND NEW.locked_by = OLD.locked_by) THEN
      RAISE EXCEPTION 'a locked payroll run can only move to paid' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'payslips' AND TG_OP = 'UPDATE' AND current_setting('app.erasure', true) = 'on'
     AND (to_jsonb(NEW) - 'employee_name') = (to_jsonb(OLD) - 'employee_name') THEN RETURN NEW; END IF; -- pseudonymising a person on erasure; amounts never change
  IF TG_OP = 'DELETE' THEN rid := OLD.run_id; ELSE rid := NEW.run_id; END IF;
  SELECT status INTO st FROM payroll_runs WHERE id = rid;
  IF st IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'this payroll run is locked' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_lock_guard();
CREATE TRIGGER payslips_guard BEFORE INSERT OR UPDATE OR DELETE ON payslips FOR EACH ROW EXECUTE FUNCTION payroll_lock_guard();
CREATE TRIGGER payroll_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_lock_guard();

ALTER TABLE employees ENABLE ROW LEVEL SECURITY; ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employees USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY; ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shifts USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY; ALTER TABLE attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attendance USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE statutory_rules ENABLE ROW LEVEL SECURITY; ALTER TABLE statutory_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON statutory_rules USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE tax_brackets ENABLE ROW LEVEL SECURITY; ALTER TABLE tax_brackets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_brackets USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_runs USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE payslips ENABLE ROW LEVEL SECURITY; ALTER TABLE payslips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payslips USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE payroll_adjustments ENABLE ROW LEVEL SECURITY; ALTER TABLE payroll_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_adjustments USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE ON employees, shifts, attendance, statutory_rules, payroll_runs TO erpatio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payslips, payroll_adjustments, tax_brackets TO erpatio_app;
GRANT DELETE ON payroll_runs, attendance TO erpatio_app; -- drafts only for runs; attendance corrections

-- Default statutory rules and withholding brackets for workspaces that already exist (new ones get them at provisioning).
-- These are starting values to be confirmed with the company's accountant and kept current by editing, not by deploying.
INSERT INTO statutory_rules (tenant_id, code, ee_rate, er_rate, base_min, base_max)
SELECT t.id, v.code, v.ee, v.er, v.bmin, v.bmax FROM tenants t
  CROSS JOIN (VALUES ('sss', 5, 10, 5000, 35000), ('philhealth', 2.5, 2.5, 10000, 100000), ('pagibig', 2, 2, 0, 10000)) v(code, ee, er, bmin, bmax);
INSERT INTO tax_brackets (tenant_id, lower, upper, base_tax, rate)
SELECT t.id, v.lo, v.hi, v.bt, v.r FROM tenants t
  CROSS JOIN (VALUES (0, 20833, 0, 0), (20833, 33333, 0, 15), (33333, 66667, 1875, 20), (66667, 166667, 8541.80, 25), (166667, 666667, 33541.80, 30), (666667, NULL, 183541.80, 35)) v(lo, hi, bt, r);

-- Down Migration

DROP TABLE IF EXISTS payroll_adjustments, payslips, payroll_runs, tax_brackets, statutory_rules, attendance, shifts, employees CASCADE;
DROP FUNCTION IF EXISTS payroll_lock_guard();
DELETE FROM doc_counters WHERE kind IN ('emp', 'pr');
