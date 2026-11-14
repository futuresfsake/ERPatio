import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { endpoints, type StatementLine } from '../api';
import { useAuth } from '../auth';
import { formatNum, fromApi } from '../lib/money';
import { Loading, longDate, Problem, todayIso } from '../ui';

const OPACITY = [1, 0.72, 0.5, 0.3, 0.16];

function Section({ title, rows, total, label }: { title: string; rows: StatementLine[]; total: string; label: string }) {
  return (
    <>
      <h2>{title}</h2>
      {rows.map((r) => (
        <div className="ln" key={r.account_id}><span>{r.name}</span><span className="dots" /><span className="num">{formatNum(fromApi(r.amount))}</span></div>
      ))}
      {rows.length === 0 && <div className="ln muted">Nothing posted yet.</div>}
      <div className="ln sum"><span>{label}</span><span className="dots" /><span className="num">{formatNum(fromApi(total))}</span></div>
    </>
  );
}

export function Overview() {
  const { can } = useAuth();
  const nav = useNavigate();
  const asOf = todayIso();
  const bs = useQuery({ queryKey: ['bs', asOf], queryFn: () => endpoints.balanceSheet(asOf) });
  const recent = useQuery({ queryKey: ['entries', 7, 0], queryFn: () => endpoints.entries(7, 0) });
  const b = bs.data;

  const held = (b?.assets.rows ?? []).map((r) => ({ ...r, v: fromApi(r.amount) })).filter((r) => r.v > 0n).sort((x, y) => (y.v > x.v ? 1 : -1));
  const heldTotal = held.reduce((s, r) => s + r.v, 0n);
  const pct = (v: bigint) => (heldTotal === 0n ? 0 : Number((v * 10000n) / heldTotal) / 100);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Position as of {longDate(asOf)}. Amounts in PHP.</p>
        </div>
        <div className="actions">{can('journal:post') && <Link className="btn primary" to="/journal/new">New entry</Link>}</div>
      </div>
      <Problem error={bs.error ?? recent.error} />
      {(bs.isLoading || recent.isLoading) && <Loading what="figures" />}
      {b && (
        <div className="cols">
          <div className="statement">
            <Section title="Assets" rows={b.assets.rows} total={b.assets.total} label="Total assets" />
            <Section title="Liabilities" rows={b.liabilities.rows} total={b.liabilities.total} label="Total liabilities" />
            <h2>Equity</h2>
            {b.equity.rows.map((r) => (
              <div className="ln" key={r.account_id}><span>{r.name}</span><span className="dots" /><span className="num">{formatNum(fromApi(r.amount))}</span></div>
            ))}
            <div className="ln"><span>Earnings to date</span><span className="dots" /><span className="num">{formatNum(fromApi(b.equity.earnings))}</span></div>
            <div className="ln sum"><span>Total equity</span><span className="dots" /><span className="num">{formatNum(fromApi(b.equity.total))}</span></div>
            <div className="asof">
              {b.balanced ? 'Assets equal liabilities plus equity.' : <span className="red">Does not balance. Contact support.</span>}
            </div>
          </div>
          <div>
            {held.length > 0 && (
              <div className="assets">
                <h2>Where the assets sit</h2>
                <div className="assetbar" role="img" aria-label={`Asset mix: ${held.map((r) => `${r.name} ${pct(r.v).toFixed(0)} percent`).join(', ')}`}>
                  {held.map((r, i) => <i key={r.account_id} title={`${r.name} ${pct(r.v).toFixed(1)}%`} style={{ flex: `${pct(r.v)} 0 0`, opacity: OPACITY[Math.min(i, OPACITY.length - 1)] }} />)}
                </div>
                <ul className="assetlegend">
                  {held.map((r, i) => (
                    <li key={r.account_id} style={{ ['--o' as string]: OPACITY[Math.min(i, OPACITY.length - 1)] }}>
                      <span className="nm">{r.name}</span><span>{formatNum(r.v)}</span><span className="pc">{pct(r.v).toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="toolbar"><h2 className="grow">Latest entries</h2><Link to="/journal">All entries</Link></div>
            <div className="tbl-wrap">
              <table>
                <tbody>
                  {recent.data?.items.map((e) => (
                    <tr className="link" key={e.id} onClick={() => nav(`/journal/${e.id}`)}>
                      <td className="code">JE-{e.entry_no}</td>
                      <td>{e.description}</td>
                      <td className="num">{formatNum(fromApi(e.total))}</td>
                    </tr>
                  ))}
                  {recent.data?.items.length === 0 && <tr><td className="empty">No entries yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
