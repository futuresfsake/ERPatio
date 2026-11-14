import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Accounts } from './pages/Accounts';
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

function Frame() {
  const { user, signOut, can } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const link = (to: string, label: string, end = false) => (
    <NavLink to={to} end={end} onClick={() => setOpen(false)}>
      {label}
    </NavLink>
  );
  return (
    <div className="app">
      <aside className={`rail${open ? ' open' : ''}`} aria-label="Main">
        <div className="wordmark">ERPatio</div>
        <div className="rail-ws">
          <b>Casa Verde Trading Corp.</b>
          Demo workspace · PHP
        </div>
        <nav>
          <div className="label">Finance</div>
          {link('/', 'Overview', true)}
          {link('/accounts', 'Chart of accounts')}
          {link('/journal', 'Journal')}
          {link('/periods', 'Fiscal periods')}
          <div className="label">Reports</div>
          {link('/trial-balance', 'Trial balance')}
          {link('/reports/income-statement', 'Income statement')}
          {link('/reports/balance-sheet', 'Balance sheet')}
          {(can('audit:read') || can('settings:manage')) && <div className="label">Workspace</div>}
          {can('audit:read') && link('/audit', 'Audit log')}
          {can('settings:manage') && link('/settings', 'Settings')}
          <div className="label">Later</div>
          <a className="later" aria-disabled="true">Inventory</a>
          <a className="later" aria-disabled="true">Production</a>
          <a className="later" aria-disabled="true">Payroll</a>
        </nav>
        <div className="rail-foot">
          <div>
            {user?.full_name}
            <br />
            {user?.roles.join(', ')}
          </div>
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
        <main className="page" key={loc.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <p className="muted" style={{ padding: 32 }} role="status">Loading…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const { user, ready } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={ready && user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<Protected><Frame /></Protected>}>
        <Route index element={<Overview />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="journal" element={<Journal />} />
        <Route path="journal/new" element={<NewEntry />} />
        <Route path="journal/drafts/:id" element={<DraftPage />} />
        <Route path="journal/:id" element={<EntryDetail />} />
        <Route path="periods" element={<FiscalPeriods />} />
        <Route path="reports/income-statement" element={<IncomeStatementPage />} />
        <Route path="reports/balance-sheet" element={<BalanceSheetPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="trial-balance" element={<TrialBalancePage />} />
        <Route path="audit" element={<Audit />} />
        <Route path="*" element={<p className="muted">There is nothing at this address.</p>} />
      </Route>
    </Routes>
  );
}
