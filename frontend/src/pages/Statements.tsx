import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { endpoints, type StatementLine } from '../api';
import { downloadCsv } from '../lib/csv';
import { formatNum, fromApi } from '../lib/money';
import { Loading, longDate, Problem, todayIso } from '../ui';

const Row = ({ l }: { l: StatementLine }) => (
  <div className="ln"><span><span className="mono muted">{l.code}</span>  {l.name}</span><span className="dots" /><span className="num">{formatNum(fromApi(l.amount))}</span></div>
);
const Sum = ({ label, v }: { label: string; v: string }) => (
  <div className="ln sum"><span>{label}</span><span className="dots" /><span className="num">{formatNum(fromApi(v))}</span></div>
);

export function IncomeStatementPage() {
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const q = useQuery({ queryKey: ['income', from, to], queryFn: () => endpoints.incomeStatement(from, to), enabled: ok });
  const r = q.data;

  const csv = () => {
    if (!r) return;
    downloadCsv(`income-statement-${r.from}-to-${r.to}.csv`, [
      ['Income statement (PHP)', r.from, r.to], [],
      ['Revenue'], ...r.revenue.rows.map((x) => [x.code, x.name, x.amount]), ['', 'Total revenue', r.revenue.total], [],
      ['Expenses'], ...r.expenses.rows.map((x) => [x.code, x.name, x.amount]), ['', 'Total expenses', r.expenses.total], [],
      ['', 'Net income', r.net_income],
    ]);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Income statement</h1>
          <p className="sub">Revenue less expenses for a period. Amounts in PHP.</p>
        </div>
        <div className="actions">
          <div><label htmlFor="from">From</label><input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} /></div>
          <div><label htmlFor="to">To</label><input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} /></div>
          <button className="btn" disabled={!r} onClick={csv}>Download CSV</button>
        </div>
      </div>
      {!ok && <div className="notice error" role="alert">Choose a start date that is not after the end date.</div>}
      <Problem error={q.error} />
      {q.isLoading && <Loading what="statement" />}
      {r && (
        <div className="statement" style={{ maxWidth: 640 }}>
          <h2>Revenue</h2>
          {r.revenue.rows.map((l) => <Row key={l.account_id} l={l} />)}
          {r.revenue.rows.length === 0 && <div className="ln muted">No revenue in this period.</div>}
          <Sum label="Total revenue" v={r.revenue.total} />
          <h2>Expenses</h2>
          {r.expenses.rows.map((l) => <Row key={l.account_id} l={l} />)}
          {r.expenses.rows.length === 0 && <div className="ln muted">No expenses in this period.</div>}
          <Sum label="Total expenses" v={r.expenses.total} />
          <div className="ln sum" style={{ borderBottom: '3px double var(--ink)', paddingBottom: 6, marginTop: 14 }}>
            <span>Net income</span><span className="dots" /><span className={`num${fromApi(r.net_income) < 0n ? ' red' : ''}`}>{formatNum(fromApi(r.net_income))}</span>
          </div>
          <div className="asof">{longDate(r.from)} to {longDate(r.to)}</div>
        </div>
      )}
    </>
  );
}

export function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(todayIso());
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const q = useQuery({ queryKey: ['bs', asOf], queryFn: () => endpoints.balanceSheet(asOf), enabled: ok });
  const b = q.data;

  const csv = () => {
    if (!b) return;
    downloadCsv(`balance-sheet-${b.as_of}.csv`, [
      ['Balance sheet (PHP)', b.as_of], [],
      ['Assets'], ...b.assets.rows.map((x) => [x.code, x.name, x.amount]), ['', 'Total assets', b.assets.total], [],
      ['Liabilities'], ...b.liabilities.rows.map((x) => [x.code, x.name, x.amount]), ['', 'Total liabilities', b.liabilities.total], [],
      ['Equity'], ...b.equity.rows.map((x) => [x.code, x.name, x.amount]), ['', 'Earnings to date', b.equity.earnings], ['', 'Total equity', b.equity.total],
    ]);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Balance sheet</h1>
          <p className="sub">What the business owns and owes on a date. Amounts in PHP.</p>
        </div>
        <div className="actions">
          <div><label htmlFor="asof">As of</label><input id="asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto' }} /></div>
          <button className="btn" disabled={!b} onClick={csv}>Download CSV</button>
        </div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="balance sheet" />}
      {b && (
        <>
          <div className="statement" style={{ maxWidth: 640 }}>
            <h2>Assets</h2>
            {b.assets.rows.map((l) => <Row key={l.account_id} l={l} />)}
            {b.assets.rows.length === 0 && <div className="ln muted">Nothing posted yet.</div>}
            <Sum label="Total assets" v={b.assets.total} />
            <h2>Liabilities</h2>
            {b.liabilities.rows.map((l) => <Row key={l.account_id} l={l} />)}
            {b.liabilities.rows.length === 0 && <div className="ln muted">None.</div>}
            <Sum label="Total liabilities" v={b.liabilities.total} />
            <h2>Equity</h2>
            {b.equity.rows.map((l) => <Row key={l.account_id} l={l} />)}
            <div className="ln"><span>Earnings to date</span><span className="dots" /><span className="num">{formatNum(fromApi(b.equity.earnings))}</span></div>
            <Sum label="Total equity" v={b.equity.total} />
            <div className="ln sum" style={{ borderBottom: '3px double var(--ink)', paddingBottom: 6, marginTop: 14 }}>
              <span>Liabilities plus equity</span><span className="dots" /><span className="num">{formatNum(fromApi(b.liabilities.total) + fromApi(b.equity.total))}</span>
            </div>
          </div>
          <p className={`check${b.balanced ? '' : ' bad'}`}>
            {b.balanced ? 'Assets equal liabilities plus equity.' : 'Does not balance. Contact support.'}
            {' '}<span className="muted">Earnings are cumulative until year-end closing is built.</span>
          </p>
        </>
      )}
    </>
  );
}
