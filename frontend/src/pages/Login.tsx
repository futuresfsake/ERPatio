import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { account, ApiError } from '../api';
import { useAuth } from '../auth';
import { errorText } from '../ui';
import { SignInFrame } from './SignInFrame';

// Public on purpose: the demo workspace holds synthetic data only (ADR-008).
const DEMO = { workspace: 'casa-verde-demo', email: 'demo@erpatio.app', password: 'ERPatio-Demo-2026' };

type Missing = { workspace?: string; email?: string; password?: string; code?: string };

export function Login() {
  const { signIn, completeMfa } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const cfg = useQuery({ queryKey: ['public-config'], queryFn: account.publicConfig, staleTime: 60_000 });
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [missing, setMissing] = useState<Missing>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const after = () => nav((loc.state as { from?: string } | null)?.from ?? '/', { replace: true });

  const fail = (err: unknown) => {
    setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a minute and try again.' : errorText(err));
    setBusy(false);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The button is never disabled: say what is missing instead of greying it out.
    const m: Missing = {};
    if (!mfaToken) {
      if (!workspace.trim()) m.workspace = 'Enter your workspace code.';
      if (!email.trim()) m.email = 'Enter your email.';
      if (!password) m.password = 'Enter your password.';
    } else if (!code.trim()) m.code = 'Enter the 6-digit code from your authenticator app, or a recovery code.';
    setMissing(m);
    if (Object.keys(m).length) return;

    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await completeMfa(mfaToken, code.trim());
        after();
        return;
      }
      const step = await signIn(workspace.trim(), email.trim(), password);
      if (step) {
        setMfaToken(step);
        setBusy(false);
        return;
      }
      after();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_token' && mfaToken) {
        setMfaToken(null);
        setCode('');
        setError('That sign-in step expired. Enter your password again.');
        setBusy(false);
        return;
      }
      fail(err);
    }
  }

  return (
    <SignInFrame
      below={
        !mfaToken && (
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
        )
      }
    >
      <form onSubmit={submit} noValidate>
        {!mfaToken ? (
          <>
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
          </>
        ) : (
          <>
            <div>
              <h1 style={{ fontSize: 20 }}>Two-factor code</h1>
              <p className="muted" style={{ marginTop: 3 }}>Open your authenticator app and enter the 6-digit code.</p>
            </div>
            <div>
              <label htmlFor="code">Code</label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} autoFocus aria-invalid={!!missing.code || undefined} style={{ fontFamily: 'var(--mono)', letterSpacing: '0.12em' }} />
              <div className="hint">Lost your phone? Enter one of your recovery codes instead.</div>
              {missing.code && <div className="field-error" role="alert">{missing.code}</div>}
            </div>
          </>
        )}
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="signin-actions">
          <span>
            {mfaToken ? <button type="button" className="linkbtn" onClick={() => { setMfaToken(null); setCode(''); setError(null); }}>Back</button> : <Link to="/forgot-password">Forgot password?</Link>}
          </span>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : <>{mfaToken ? 'Verify' : 'Sign in'} <kbd style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}>↵</kbd></>}
          </button>
        </div>
        {!mfaToken && cfg.data?.signup_enabled && <p className="muted">New here? <Link to="/signup">Create a workspace</Link></p>}
      </form>
    </SignInFrame>
  );
}
