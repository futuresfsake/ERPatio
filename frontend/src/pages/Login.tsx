import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { errorText } from '../ui';

// Public on purpose: the demo workspace holds synthetic data only (ADR-008).
const DEMO = { workspace: 'casa-verde-demo', email: 'demo@erpatio.app', password: 'ERPatio-Demo-2026' };

type Missing = { workspace?: string; email?: string; password?: string };

export function Login() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [missing, setMissing] = useState<Missing>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The button is never disabled: say what is missing instead of greying it out.
    const m: Missing = {};
    if (!workspace.trim()) m.workspace = 'Enter your workspace code.';
    if (!email.trim()) m.email = 'Enter your email.';
    if (!password) m.password = 'Enter your password.';
    setMissing(m);
    if (Object.keys(m).length) return;

    setBusy(true);
    setError(null);
    try {
      await signIn(workspace.trim(), email.trim(), password);
      nav((loc.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a minute and try again.' : errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <section className="signin-pane">
        <div className="wordmark" style={{ padding: 0, fontSize: 24 }}>ERPatio</div>
        <form onSubmit={submit} noValidate>
          <div>
            <h1 style={{ fontSize: 20 }}>Sign in</h1>
            <p className="muted" style={{ marginTop: 3 }}>Use your company workspace code.</p>
          </div>
          <div>
            <label htmlFor="ws">Workspace</label>
            <div className={`codefield${missing.workspace ? ' bad' : ''}`}>
              <span className="pre" aria-hidden="true">ws</span>
              <input id="ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} autoComplete="organization" spellCheck={false} autoCapitalize="none" placeholder="company-code" aria-invalid={!!missing.workspace || undefined} autoFocus />
            </div>
            {missing.workspace && <div className="field-error" role="alert">{missing.workspace}</div>}
          </div>
          <div>
            <label htmlFor="em">Email</label>
            <input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" aria-invalid={!!missing.email || undefined} />
            {missing.email && <div className="field-error" role="alert">{missing.email}</div>}
          </div>
          <div>
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" aria-invalid={!!missing.password || undefined} />
            {missing.password && <div className="field-error" role="alert">{missing.password}</div>}
          </div>
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="signin-actions">
            <span>Sessions last 7 days.</span>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : <>Sign in <kbd style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}>↵</kbd></>}
            </button>
          </div>
        </form>
        <div className="demo">
          <b>Public demo.</b> Synthetic data, reset every night. Anyone can sign in.
          <dl>
            <dt>Workspace</dt><dd>{DEMO.workspace}</dd>
            <dt>Email</dt><dd>{DEMO.email}</dd>
            <dt>Password</dt><dd>{DEMO.password}</dd>
          </dl>
          <button className="linkbtn" type="button" onClick={() => { setWorkspace(DEMO.workspace); setEmail(DEMO.email); setPassword(DEMO.password); setMissing({}); }}>
            Fill these in
          </button>
        </div>
        <div className="foot">Version 0.1</div>
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
