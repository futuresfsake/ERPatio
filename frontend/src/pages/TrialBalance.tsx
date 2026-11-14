import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { endpoints } from '../api';
import { downloadCsv } from '../lib/csv';
import { formatNum, fromApi } from '../lib/money';
import { Loading, Problem, todayIso } from '../ui';

export function TrialBalancePage() {
  const [asOf, setAsOf] = useState(todayIso());
  const q = useQuery({ queryKey: ['tb', asOf], queryFn: () => endpoints.trialBalance(asOf), enabled: /^\d{4}-\d{2}-\d{2}$/.test(asOf) });
  const tb = q.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trial balance</h1>
          <p className="sub">Net balance of every account with activity.</p>
        </div>
        <div className="actions">
          <div><label htmlFor="asof">As of</label><input id="asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto' }} /></div>
          <button className="btn" disabled={!tb} onClick={() => tb && downloadCsv(`trial-balance-${tb.as_of}.csv`, [
            ['Trial balance (PHP)', tb.as_of], ['Code', 'Account', 'Debit', 'Credit'],
            ...tb.rows.map((r) => [r.code, r.name, r.debit, r.credit]), ['', 'Totals', tb.total_debit, tb.total_credit],
          ])}>Download CSV</button>
        </div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="trial balance" />}
      {tb && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th className="code">Code</th><th>Account</th><th className="num">Debit (PHP)</th><th className="num">Credit (PHP)</th></tr></thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.account_id}>
                    <td className="code">{r.code}</td>
                    <td>{r.name}</td>
                    <td className="num">{fromApi(r.debit) ? formatNum(fromApi(r.debit)) : ''}</td>
                    <td className="num">{fromApi(r.credit) ? formatNum(fromApi(r.credit)) : ''}</td>
                  </tr>
                ))}
                {tb.rows.length === 0 && <tr><td colSpan={4} className="empty">Nothing was posted on or before this date.</td></tr>}
              </tbody>
              <tfoot><tr><td /><td>Totals</td><td className="num">{formatNum(fromApi(tb.total_debit))}</td><td className="num">{formatNum(fromApi(tb.total_credit))}</td></tr></tfoot>
            </table>
          </div>
          <p className={`check${tb.balanced ? '' : ' bad'}`}>
            {tb.balanced ? 'Debits and credits agree.' : `Out of balance by ${formatNum(fromApi(tb.total_debit) - fromApi(tb.total_credit))}. Contact support.`}
          </p>
        </>
      )}
    </>
  );
}
