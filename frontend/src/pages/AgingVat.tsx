import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { downloadCsv } from '../lib/csv';
import { formatApiNum } from '../lib/money';
import { SIDES, sub, type Side } from '../subledger';
import { Loading, Problem, todayIso } from '../ui';

const COLS = [['current', 'Not yet due'], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90_plus', 'Over 90'], ['total', 'Total']] as const;

export function AgingPage({ side }: { side: Side }) {
  const S = SIDES[side];
  const [asOf, setAsOf] = useState(todayIso());
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const q = useQuery({ queryKey: ['aging', side, asOf], queryFn: () => sub.aging(side, asOf), enabled: ok });
  const r = q.data;
  const csv = () => {
    if (!r) return;
    downloadCsv(`${S.aging}-aging-${r.as_of}.csv`, [
      [`${S.Parties} aging (PHP)`, r.as_of], [],
      ['Code', 'Name', ...COLS.map((c) => c[1])],
      ...r.rows.map((x) => [x.code, x.name, ...COLS.map(([k]) => x[k])]),
      ['', 'Total', ...COLS.map(([k]) => r.totals[k] ?? '')],
    ]);
  };
  return (
    <>
      <div className="page-head">
        <div><h1>{side === 'ar' ? 'Receivables aging' : 'Payables aging'}</h1><p className="sub">Open items by days past due. Payments dated after the chosen day do not count.</p></div>
        <div className="actions">
          <div><label htmlFor="asof">As of</label><input id="asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto' }} /></div>
          <button className="btn" disabled={!r} onClick={csv}>Download CSV</button>
        </div>
      </div>
      <Problem error={q.error} />
      {q.isLoading && <Loading what="aging" />}
      {r && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>{S.Party}</th>{COLS.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
              <tbody>
                {r.rows.map((x) => <tr key={x.party_id}><td className="name">{x.code} · {x.name}</td>{COLS.map(([k]) => <td key={k} className="num">{formatApiNum(x[k])}</td>)}</tr>)}
                {r.rows.length === 0 && <tr><td colSpan={7} className="empty">Nothing is open on this date.</td></tr>}
                {r.rows.length > 0 && <tr className="group"><td>Total</td>{COLS.map(([k]) => <td key={k} className="num">{formatApiNum(r.totals[k] ?? '0')}</td>)}</tr>}
              </tbody>
            </table>
          </div>
          <p className={r.reconciles ? 'muted' : 'notice warn'} style={{ marginTop: 12 }} role="status">
            {r.reconciles ? `Agrees with the ledger control account (${formatApiNum(r.ledger_balance)}).` : `The ledger control account shows ${formatApiNum(r.ledger_balance)}, which differs from the open items. A manual journal entry may have been posted to it.`}
          </p>
        </>
      )}
    </>
  );
}

export function VatPage() {
  const [from, setFrom] = useState(`${todayIso().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayIso());
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const q = useQuery({ queryKey: ['vat', from, to], queryFn: () => sub.vat(from, to), enabled: ok });
  const r = q.data;
  return (
    <>
      <div className="page-head">
        <div><h1>Tax report</h1><p className="sub">Output tax on invoices against input tax on bills. Posted documents only.</p></div>
        <div className="actions">
          <div><label htmlFor="vf">From</label><input id="vf" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} /></div>
          <div><label htmlFor="vt">To</label><input id="vt" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} /></div>
        </div>
      </div>
      {!ok && <div className="notice error" role="alert">Choose a start date that is not after the end date.</div>}
      <Problem error={q.error} />
      {q.isLoading && <Loading what="tax report" />}
      {r && (
        <>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Code</th><th>Side</th><th className="num">Rate %</th><th className="num">Net amount</th><th className="num">Tax</th></tr></thead>
              <tbody>
                {r.rows.map((x) => <tr key={x.code}><td className="code">{x.code}</td><td>{x.kind === 'output' ? 'Sales' : 'Purchases'}</td><td className="num">{formatApiNum(x.rate)}</td><td className="num">{formatApiNum(x.base)}</td><td className="num">{formatApiNum(x.tax)}</td></tr>)}
                {r.rows.length === 0 && <tr><td colSpan={5} className="empty">No taxed documents in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="statement" style={{ maxWidth: 360, marginTop: 16 }}>
            <div className="ln"><span>Output tax</span><span className="dots" /><span className="num">{formatApiNum(r.output_tax)}</span></div>
            <div className="ln"><span>Input tax</span><span className="dots" /><span className="num">{formatApiNum(r.input_tax)}</span></div>
            <div className="ln sum"><span>{r.payable.startsWith('-') ? 'Refundable or carried forward' : 'Payable'}</span><span className="dots" /><span className="num">{formatApiNum(r.payable.replace('-', ''))}</span></div>
          </div>
        </>
      )}
    </>
  );
}
