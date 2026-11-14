import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { account, ApiError } from '../api';
import { useAuth } from '../auth';
import { Loading, Problem, useToast } from '../ui';

const when = (iso: string) => new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function browser(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function TwoFactor() {
  const { refreshUser } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: account.me });
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [pw, setPw] = useState('');
  const [offCode, setOffCode] = useState('');

  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.otpauth_url, { margin: 1, width: 180 }).then(setQr).catch(() => setQr(''));
  }, [setup]);

  const start = useMutation({ mutationFn: account.setup2fa, onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => account.enable2fa(code.trim()),
    onSuccess: async (r) => {
      setRecovery(r.recovery_codes);
      setSetup(null);
      setCode('');
      await refreshUser();
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const disable = useMutation({
    mutationFn: () => account.disable2fa(pw, offCode.trim()),
    onSuccess: async () => { toast('Two-factor sign-in is off'); setPw(''); setOffCode(''); await refreshUser(); void qc.invalidateQueries({ queryKey: ['me'] }); },
  });

  if (me.isLoading) return <Loading what="security settings" />;
  const m = me.data;
  if (!m) return <Problem error={me.error} />;

  if (recovery)
    return (
      <>
        <div className="notice" role="status"><b>Two-factor sign-in is on.</b> Save these recovery codes now. Each works once if you lose your phone, and they will not be shown again.</div>
        <ul className="codes" aria-label="Recovery codes">{recovery.map((c) => <li key={c}>{c}</li>)}</ul>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => download('erpatio-recovery-codes.txt', `ERPatio recovery codes\n\n${recovery.join('\n')}\n`, 'text/plain')}>Download as text</button>
          <button className="btn primary" onClick={() => setRecovery(null)}>I have saved them</button>
        </div>
      </>
    );

  if (m.mfa_enabled)
    return (
      <>
        <p>Two-factor sign-in is <b>on</b>. You have {m.recovery_codes_left} recovery code{m.recovery_codes_left === 1 ? '' : 's'} left.</p>
        <details>
          <summary>Turn it off</summary>
          <form style={{ display: 'grid', gap: 12, maxWidth: 340, marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
            <div><label htmlFor="offpw">Password</label><input id="offpw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></div>
            <div><label htmlFor="offcode">Current code</label><input id="offcode" value={offCode} onChange={(e) => setOffCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></div>
            {disable.error && <div className="field-error" role="alert">{disable.error instanceof ApiError ? disable.error.message : 'Could not turn it off.'}</div>}
            <div><button className="btn danger" disabled={!pw || offCode.trim().length < 6 || disable.isPending}>Turn off</button></div>
          </form>
        </details>
      </>
    );

  return (
    <>
      {m.mfa_enrollment_required && <div className="notice error" role="alert"><b>Your role must use two-factor sign-in.</b> Set it up to carry on.</div>}
      {!setup ? (
        <>
          <p className="muted" style={{ maxWidth: 560 }}>Adds a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password) to your password.</p>
          <Problem error={start.error} />
          <div><button className="btn primary" disabled={start.isPending} onClick={() => start.mutate()}>Set up two-factor sign-in</button></div>
        </>
      ) : (
        <form style={{ display: 'grid', gap: 14, maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
            <li>Scan this with your authenticator app, or type the key.</li>
          </ol>
          {qr && <img src={qr} alt="QR code for your authenticator app" width={180} height={180} style={{ border: '1px solid var(--rule-strong)', borderRadius: 2, background: '#fff' }} />}
          <div><label>Key</label><code style={{ userSelect: 'all', overflowWrap: 'anywhere' }}>{setup.secret}</code></div>
          <div><label htmlFor="c">Then enter the 6-digit code it shows</label><input id="c" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus style={{ fontFamily: 'var(--mono)', letterSpacing: '0.12em', maxWidth: 200 }} /></div>
          {enable.error && <div className="field-error" role="alert">{enable.error instanceof ApiError ? enable.error.message : 'Could not turn it on.'}</div>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn" onClick={() => setSetup(null)}>Cancel</button>
            <button className="btn primary" disabled={code.trim().length < 6 || enable.isPending}>Turn on</button>
          </div>
        </form>
      )}
    </>
  );
}

function Sessions() {
  const toast = useToast();
  const qc = useQueryClient();
  const { signOut } = useAuth();
  const q = useQuery({ queryKey: ['sessions'], queryFn: account.sessions });
  const revoke = useMutation({ mutationFn: (id: string) => account.revokeSession(id), onSuccess: () => { toast('Signed out'); void qc.invalidateQueries({ queryKey: ['sessions'] }); } });
  const all = useMutation({ mutationFn: account.revokeAll, onSuccess: () => void signOut() });
  if (q.isLoading) return <Loading what="sessions" />;
  return (
    <>
      <Problem error={q.error ?? revoke.error ?? all.error} />
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Device</th><th className="hide-sm">Address</th><th>Last active</th><th /></tr></thead>
          <tbody>
            {(q.data ?? []).map((s) => (
              <tr key={s.id}>
                <td>{browser(s.user_agent)}{s.current && <span className="muted"> · this device</span>}</td>
                <td className="ref hide-sm">{s.ip ?? 'unknown'}</td>
                <td>{when(s.last_active_at)}</td>
                <td className="num" style={{ fontFamily: 'var(--sans)' }}>{!s.current && <button className="linkbtn" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>Sign out</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><button className="btn" disabled={all.isPending} onClick={() => all.mutate()}>Sign out everywhere</button></div>
    </>
  );
}

export function Security() {
  const toast = useToast();
  const exp = useMutation({
    mutationFn: account.exportMine,
    onSuccess: (data) => { download('my-erpatio-data.json', JSON.stringify(data, null, 2), 'application/json'); toast('Download started'); },
  });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account security</h1>
          <p className="sub">How you sign in, where you are signed in, and the data held about you.</p>
        </div>
      </div>
      <div className="stack" style={{ gap: 30, maxWidth: 760 }}>
        <section className="stack"><h2>Two-factor sign-in</h2><TwoFactor /></section>
        <section className="stack"><h2>Where you are signed in</h2><Sessions /></section>
        <section className="stack">
          <h2>Your data</h2>
          <p className="muted">Download everything this workspace holds about you: your profile, sign-in history, consents and activity. See the <a href="/privacy">privacy notice</a>.</p>
          <Problem error={exp.error} />
          <div><button className="btn" disabled={exp.isPending} onClick={() => exp.mutate()}>Download my data</button></div>
        </section>
      </div>
    </>
  );
}
