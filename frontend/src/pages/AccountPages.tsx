import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { account, ApiError } from '../api';
import { errorText } from '../ui';
import { SignInFrame } from './SignInFrame';

const MIN = 12;
const msg = (e: unknown) => (e instanceof ApiError ? (e.code === 'rate_limited' ? 'Too many attempts. Wait a minute and try again.' : e.message) : errorText(e));

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="field-error" role="alert">{error}</div>}
    </div>
  );
}

export function SignUp() {
  const [f, setF] = useState({ company: '', full_name: '', email: '', password: '', accept: false });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean } }) => setF((x) => ({ ...x, [k]: k === 'accept' ? !!e.target.checked : e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const m: Record<string, string> = {};
    if (f.company.trim().length < 2) m.company = 'Enter your company name.';
    if (!f.full_name.trim()) m.full_name = 'Enter your name.';
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) m.email = 'Enter a valid email address.';
    if (f.password.length < MIN) m.password = `Use at least ${MIN} characters.`;
    if (!f.accept) m.accept = 'You need to accept the privacy notice to continue.';
    setErrs(m);
    if (Object.keys(m).length) return;
    setBusy(true);
    setError(null);
    try {
      await account.signup({ company: f.company.trim(), full_name: f.full_name.trim(), email: f.email.trim(), password: f.password, accept_privacy: true });
      setDone(true);
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <SignInFrame>
        <div style={{ marginTop: 40, maxWidth: 340 }}>
          <h1 style={{ fontSize: 20 }}>Check your email</h1>
          <p style={{ marginTop: 8 }}>We sent a link to <b>{f.email}</b>. Open it to confirm your address, then sign in.</p>
          <p className="muted" style={{ marginTop: 12 }}>Your workspace code is created from your company name. It appears in the confirmation email.</p>
          <p style={{ marginTop: 16 }}><Link to="/login">Back to sign in</Link></p>
        </div>
      </SignInFrame>
    );

  return (
    <SignInFrame>
      <form onSubmit={submit} noValidate>
        <div>
          <h1 style={{ fontSize: 20 }}>Create a workspace</h1>
          <p className="muted" style={{ marginTop: 3 }}>You become its administrator.</p>
        </div>
        <Field id="co" label="Company name" error={errs.company}><input id="co" value={f.company} onChange={set('company')} autoComplete="organization" maxLength={120} autoFocus aria-invalid={!!errs.company || undefined} /></Field>
        <Field id="nm" label="Your name" error={errs.full_name}><input id="nm" value={f.full_name} onChange={set('full_name')} autoComplete="name" maxLength={200} aria-invalid={!!errs.full_name || undefined} /></Field>
        <Field id="em" label="Work email" error={errs.email}><input id="em" type="email" value={f.email} onChange={set('email')} autoComplete="email" aria-invalid={!!errs.email || undefined} /></Field>
        <Field id="pw" label="Password" hint={`At least ${MIN} characters. A passphrase works well.`} error={errs.password}><input id="pw" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" aria-invalid={!!errs.password || undefined} /></Field>
        <div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', font: '400 13px var(--sans)', margin: 0 }}>
            <input type="checkbox" checked={f.accept} onChange={set('accept')} style={{ width: 16, height: 16, marginTop: 2, accentColor: 'var(--ink)' }} />
            <span>I have read the <Link to="/privacy" target="_blank">privacy notice</Link> and agree to it.</span>
          </label>
          {errs.accept && <div className="field-error" role="alert">{errs.accept}</div>}
        </div>
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="signin-actions">
          <span><Link to="/login">I already have one</Link></span>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create workspace'}</button>
        </div>
      </form>
    </SignInFrame>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'ok' | 'bad'>('working');
  const [error, setError] = useState('');
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // StrictMode runs effects twice; the link works once
    once.current = true;
    if (!token) { setState('bad'); return; }
    account.verifyEmail(token).then(() => setState('ok')).catch((e) => { setError(msg(e)); setState('bad'); });
  }, [token]);

  return (
    <SignInFrame>
      <div style={{ marginTop: 40, maxWidth: 340 }}>
        {state === 'working' && <p className="loading" role="status">Confirming your email</p>}
        {state === 'ok' && (<><h1 style={{ fontSize: 20 }}>Email confirmed</h1><p style={{ marginTop: 8 }}>Your address is confirmed. You can sign in now.</p><p style={{ marginTop: 16 }}><Link className="btn primary" to="/login">Sign in</Link></p></>)}
        {state === 'bad' && (<><h1 style={{ fontSize: 20 }}>That link did not work</h1><p style={{ marginTop: 8 }}>{error || 'It is missing, has already been used, or has expired.'}</p><ResendForm /></>)}
      </div>
    </SignInFrame>
  );
}

function ResendForm() {
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sent) return <p style={{ marginTop: 14 }} role="status">If that account needs confirming, a new email is on its way.</p>;
  return (
    <form style={{ marginTop: 16, display: 'grid', gap: 12 }} onSubmit={async (e) => { e.preventDefault(); setError(null); try { await account.resend(workspace.trim(), email.trim()); setSent(true); } catch (err) { setError(msg(err)); } }}>
      <p className="muted">Send a new link:</p>
      <Field id="rws" label="Workspace"><input id="rws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} autoCapitalize="none" spellCheck={false} /></Field>
      <Field id="rem" label="Email"><input id="rem" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      {error && <div className="field-error" role="alert">{error}</div>}
      <div><button className="btn" disabled={!workspace.trim() || !email.trim()}>Send new link</button></div>
    </form>
  );
}

export function ForgotPassword() {
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const m: Record<string, string> = {};
    if (!workspace.trim()) m.workspace = 'Enter your workspace code.';
    if (!email.trim()) m.email = 'Enter your email.';
    setErrs(m);
    if (Object.keys(m).length) return;
    setError(null);
    try { await account.forgot(workspace.trim(), email.trim()); setSent(true); } catch (err) { setError(msg(err)); }
  }

  return (
    <SignInFrame>
      {sent ? (
        <div style={{ marginTop: 40, maxWidth: 340 }}>
          <h1 style={{ fontSize: 20 }}>Check your email</h1>
          <p style={{ marginTop: 8 }}>If that account exists, we sent a link to choose a new password. It works once and expires in 30 minutes.</p>
          <p style={{ marginTop: 16 }}><Link to="/login">Back to sign in</Link></p>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <div><h1 style={{ fontSize: 20 }}>Reset your password</h1><p className="muted" style={{ marginTop: 3 }}>We will email you a link.</p></div>
          <Field id="ws" label="Workspace" error={errs.workspace}>
            <div className={`codefield${errs.workspace ? ' bad' : ''}`}><span className="pre" aria-hidden="true">ws</span><input id="ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="company-code" autoFocus /></div>
          </Field>
          <Field id="em" label="Email" error={errs.email}><input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" aria-invalid={!!errs.email || undefined} /></Field>
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="signin-actions"><span><Link to="/login">Back</Link></span><button className="btn primary">Send link</button></div>
        </form>
      )}
    </SignInFrame>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const m: Record<string, string> = {};
    if (pw.length < MIN) m.pw = `Use at least ${MIN} characters.`;
    else if (pw !== again) m.again = 'The two passwords do not match.';
    setErrs(m);
    if (Object.keys(m).length) return;
    setBusy(true);
    setError(null);
    try { await account.reset(token, pw); setDone(true); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }

  if (done)
    return (
      <SignInFrame>
        <div style={{ marginTop: 40, maxWidth: 340 }}>
          <h1 style={{ fontSize: 20 }}>Password changed</h1>
          <p style={{ marginTop: 8 }}>You have been signed out everywhere. Sign in with the new password.</p>
          <p style={{ marginTop: 16 }}><Link className="btn primary" to="/login">Sign in</Link></p>
        </div>
      </SignInFrame>
    );
  return (
    <SignInFrame>
      <form onSubmit={submit} noValidate>
        <div><h1 style={{ fontSize: 20 }}>Choose a new password</h1></div>
        {!token && <div className="notice error" role="alert">This link is incomplete. Request a new one.</div>}
        <Field id="np" label="New password" hint={`At least ${MIN} characters.`} error={errs.pw}><input id="np" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus aria-invalid={!!errs.pw || undefined} /></Field>
        <Field id="np2" label="Type it again" error={errs.again}><input id="np2" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={!!errs.again || undefined} /></Field>
        {error && <div className="notice error" role="alert">{error} <Link to="/forgot-password">Request a new link</Link></div>}
        <div className="signin-actions"><span /><button className="btn primary" disabled={busy || !token}>{busy ? 'Saving…' : 'Change password'}</button></div>
      </form>
    </SignInFrame>
  );
}
