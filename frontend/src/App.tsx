import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { admin } from './api';
import { useAuth } from './auth';
import { Accounts } from './pages/Accounts';
import { ForgotPassword, ResetPassword, SignUp, VerifyEmail } from './pages/AccountPages';
import { Privacy } from './pages/Privacy';
import { Security } from './pages/Security';
import { PlatformPage } from './pages/PlatformPage';
import { People } from './pages/People';
import { RolesPage } from './pages/RolesPage';
import { DraftPage } from './pages/DraftPage';
import { FiscalPeriods } from './pages/FiscalPeriods';
import { Settings } from './pages/Settings';
import { BalanceSheetPage, IncomeStatementPage } from './pages/Statements';
import { Audit } from './pages/Audit';
import { EntryDetail } from './pages/EntryDetail';
import { Journal } from './pages/Journal';
import { Login } from './pages/Login';
import { NewEntry } from './pages/NewEntry';
import { Overview } from './pages/Overview';
import { TrialBalancePage } from './pages/TrialBalance';
import { AgingPage, VatPage } from './pages/AgingVat';
import { DocumentDetail, DocumentEditor, DocumentList } from './pages/Documents';
import { Parties } from './pages/Parties';
import { AttendancePage, EmployeesPage, PayrollPage, PayrollRunPage, RulesPage } from './pages/Hr';
import { BomPage, WipPage, WorkOrderDetail, WorkOrderList } from './pages/Production';
import { BankPage } from './pages/Bank';
import { Items, StockCard, ValuationPage } from './pages/Items';
import { OrderDetail, OrderEditor, OrderList } from './pages/Orders';

function Frame() {
  const { user, signOut, can, support, endSupport } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const operator = can('platform:manage');
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: admin.tenant, enabled: !operator, staleTime: 60_000 });
  const link = (to: string, label: string, end = false) => (
    <NavLink to={to} end={end} onClick={() => setOpen(false)}>
      {label}
    </NavLink>
  );
  const people = can('users:read');
  return (
    <div className="app">
      <aside className={`rail${open ? ' open' : ''}`} aria-label="Main">
        <div className="wordmark">ERPatio</div>
        <div className="rail-ws">
          <b>{operator ? 'ERPatio platform' : (tenant.data?.name ?? ' ')}</b>
          {operator ? 'Operator console' : tenant.data ? `${tenant.data.is_demo ? 'Demo workspace' : tenant.data.slug} · ${tenant.data.base_currency}` : ' '}
        </div>
        <nav>
          {operator ? (
            <>
              <div className="label">Operate</div>
              {link('/platform', 'Workspaces')}
            </>
          ) : (
            <>
              <div className="label">Finance</div>
              {link('/', 'Overview', true)}
              {link('/accounts', 'Chart of accounts')}
              {link('/journal', 'Journal')}
              {link('/periods', 'Fiscal periods')}
              {can('bank:manage') && link('/bank', 'Bank reconciliation')}
              {can('receivables:read') && <div className="label">Receivables</div>}
              {can('receivables:read') && link('/customers', 'Customers')}
              {can('receivables:read') && link('/invoices', 'Invoices')}
              {can('receivables:read') && link('/credit-notes', 'Credit notes')}
              {can('receivables:read') && link('/reports/aging/receivables', 'Receivables aging')}
              {can('payables:read') && <div className="label">Payables</div>}
              {can('payables:read') && link('/suppliers', 'Suppliers')}
              {can('payables:read') && link('/bills', 'Bills')}
              {can('payables:read') && link('/debit-notes', 'Debit notes')}
              {can('payables:read') && link('/reports/aging/payables', 'Payables aging')}
              {can('inventory:read') && <div className="label">Supply chain</div>}
              {can('inventory:read') && link('/items', 'Items')}
              {can('orders:read') && link('/purchase-orders', 'Purchase orders')}
              {can('orders:read') && link('/sales-orders', 'Sales orders')}
              {can('inventory:read') && link('/reports/stock-valuation', 'Stock valuation')}
              {can('production:read') && <div className="label">Production</div>}
              {can('production:read') && link('/boms', 'Bills of materials')}
              {can('production:read') && link('/work-orders', 'Work orders')}
              {can('production:read') && link('/reports/wip', 'Work in progress')}
              {can('employees:read') && <div className="label">People</div>}
              {can('employees:read') && link('/employees', 'Employees')}
              {can('employees:read') && link('/attendance', 'Attendance')}
              {can('payroll:read') && link('/payroll', 'Payroll')}
              <div className="label">Reports</div>
              {link('/trial-balance', 'Trial balance')}
              {link('/reports/income-statement', 'Income statement')}
              {link('/reports/balance-sheet', 'Balance sheet')}
              {can('reports:read') && link('/reports/vat', 'Tax report')}
              {(can('audit:read') || can('settings:manage') || people) && <div className="label">Workspace</div>}
              {people && link('/people', 'People')}
              {people && link('/roles', 'Roles')}
              {can('audit:read') && link('/audit', 'Audit log')}
              {can('settings:manage') && link('/settings', 'Settings')}
            </>
          )}
        </nav>
        <div className="rail-foot">
          <div>
            {user?.full_name}
            <br />
            {user?.roles.join(', ')}
          </div>
          {!support && <NavLink to="/security" onClick={() => setOpen(false)} style={{ padding: 0, color: 'var(--on-ink)' }}>Account security</NavLink>}
          <button onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar-sm">
          <span className="wordmark">ERPatio</span>
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Close' : 'Menu'}
          </button>
        </header>
        {support && (
          <div className="banner-support" role="status">
            <span><b>Support session</b> in {support.tenant}. Read-only; it ends after 15 minutes and is recorded in their audit log.</span>
            <button className="linkbtn" style={{ color: 'inherit' }} onClick={() => void endSupport()}>Leave</button>
          </div>
        )}
        <main className="page" key={loc.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** The operator has no books of their own, so the home page is the platform console. */
function Home() {
  const { can } = useAuth();
  return can('platform:manage') ? <Navigate to="/platform" replace /> : <Overview />;
}

function Protected({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <p className="muted" style={{ padding: 32 }} role="status">Loading…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  // A role that must use two-factor sign-in goes straight to setup until it is done.
  if (user.mfa_enrollment_required && loc.pathname !== '/security') return <Navigate to="/security" replace />;
  return <>{children}</>;
}

export function App() {
  const { user, ready } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={ready && user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route element={<Protected><Frame /></Protected>}>
        <Route index element={<Home />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="journal" element={<Journal />} />
        <Route path="journal/new" element={<NewEntry />} />
        <Route path="journal/drafts/:id" element={<DraftPage />} />
        <Route path="journal/:id" element={<EntryDetail />} />
        <Route path="periods" element={<FiscalPeriods />} />
        <Route path="reports/income-statement" element={<IncomeStatementPage />} />
        <Route path="reports/balance-sheet" element={<BalanceSheetPage />} />
        <Route path="bank" element={<BankPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="payroll" element={<PayrollPage />} />
        <Route path="payroll/rules" element={<RulesPage />} />
        <Route path="payroll/:id" element={<PayrollRunPage />} />
        <Route path="boms" element={<BomPage />} />
        <Route path="work-orders" element={<WorkOrderList />} />
        <Route path="work-orders/:id" element={<WorkOrderDetail />} />
        <Route path="reports/wip" element={<WipPage />} />
        {(['arc', 'apc'] as const).flatMap((s) => {
          const docs = s === 'arc' ? 'credit-notes' : 'debit-notes';
          return [
            <Route key={`${s}l`} path={docs} element={<DocumentList side={s} />} />,
            <Route key={`${s}n`} path={`${docs}/new`} element={<DocumentEditor side={s} />} />,
            <Route key={`${s}e`} path={`${docs}/:id/edit`} element={<DocumentEditor side={s} />} />,
            <Route key={`${s}d`} path={`${docs}/:id`} element={<DocumentDetail side={s} />} />,
          ];
        })}
        {(['ar', 'ap'] as const).flatMap((s) => {
          const n = s === 'ar' ? { parties: 'customers', docs: 'invoices', aging: 'receivables' } : { parties: 'suppliers', docs: 'bills', aging: 'payables' };
          return [
            <Route key={`${s}p`} path={n.parties} element={<Parties side={s} />} />,
            <Route key={`${s}l`} path={n.docs} element={<DocumentList side={s} />} />,
            <Route key={`${s}n`} path={`${n.docs}/new`} element={<DocumentEditor side={s} />} />,
            <Route key={`${s}e`} path={`${n.docs}/:id/edit`} element={<DocumentEditor side={s} />} />,
            <Route key={`${s}d`} path={`${n.docs}/:id`} element={<DocumentDetail side={s} />} />,
            <Route key={`${s}a`} path={`reports/aging/${n.aging}`} element={<AgingPage side={s} />} />,
          ];
        })}
        <Route path="reports/vat" element={<VatPage />} />
        <Route path="items" element={<Items />} />
        <Route path="items/:id" element={<StockCard />} />
        <Route path="reports/stock-valuation" element={<ValuationPage />} />
        {(['po', 'so'] as const).flatMap((k) => {
          const path = k === 'po' ? 'purchase-orders' : 'sales-orders';
          return [
            <Route key={`${k}l`} path={path} element={<OrderList kind={k} />} />,
            <Route key={`${k}n`} path={`${path}/new`} element={<OrderEditor kind={k} />} />,
            <Route key={`${k}e`} path={`${path}/:id/edit`} element={<OrderEditor kind={k} />} />,
            <Route key={`${k}d`} path={`${path}/:id`} element={<OrderDetail kind={k} />} />,
          ];
        })}
        <Route path="settings" element={<Settings />} />
        <Route path="trial-balance" element={<TrialBalancePage />} />
        <Route path="audit" element={<Audit />} />
        <Route path="security" element={<Security />} />
        <Route path="people" element={<People />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="platform" element={<PlatformPage />} />
        <Route path="*" element={<p className="muted">There is nothing at this address.</p>} />
      </Route>
    </Routes>
  );
}
