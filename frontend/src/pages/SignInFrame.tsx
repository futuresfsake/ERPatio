import type { ReactNode } from 'react';

/** The two-panel layout shared by every page you can reach before signing in: a form on paper, a ledger page on ink. */
export function SignInFrame({ children, below }: { children: ReactNode; below?: ReactNode }) {
  return (
    <div className="signin">
      <section className="signin-pane">
        <div className="wordmark" style={{ padding: 0, fontSize: 24 }}>ERPatio</div>
        {children}
        {below}
        <div className="foot">Version 0.1 · <a href="/privacy">Privacy notice</a></div>
      </section>
      <section className="signin-side" aria-hidden="true">
        <p className="lead">
          <span>An entry balances before it is saved.</span>
          <span>A mistake is reversed, never edited.</span>
        </p>
        <div className="sample">
          <div className="r h"><span>JE</span><span>Account</span><span>Debit</span><span>Credit</span></div>
          <div className="r"><span>14</span><span>1010 Cash in Bank</span><span>100,000.00</span><span></span></div>
          <div className="r"><span></span><span>1000 Cash on Hand</span><span></span><span>100,000.00</span></div>
          <div className="r"><span>13</span><span>6300 Office Supplies</span><span>3,200.00</span><span></span></div>
          <div className="r"><span></span><span>1000 Cash on Hand</span><span></span><span>3,200.00</span></div>
          <div className="r"><span>12</span><span>6200 Utilities</span><span>8,500.00</span><span></span></div>
          <div className="r"><span></span><span>1010 Cash in Bank</span><span></span><span>8,500.00</span></div>
          <div className="r t"><span></span><span>Total</span><span>111,700.00</span><span>111,700.00</span></div>
          <div className="cap">Casa Verde Trading Corp. · journal, November 2026 · every pair balances</div>
        </div>
      </section>
    </div>
  );
}
