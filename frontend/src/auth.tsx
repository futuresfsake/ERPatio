import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as client from './api';
import type { SessionUser } from './api';

interface AuthState {
  user: SessionUser | null;
  ready: boolean;
  /** Returns the 2FA step token when a code is needed; otherwise signs in and returns null. */
  signIn: (workspace: string, email: string, password: string) => Promise<string | null>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
  /** Re-reads the person after a security change (for example turning on 2FA). */
  refreshUser: () => Promise<void>;
  /** Set while an operator is looking at a workspace read-only. */
  support: { tenant: string } | null;
  startSupport: (s: client.SupportSession) => void;
  endSupport: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [support, setSupport] = useState<{ tenant: string } | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    client.setSessionLostHandler(() => {
      qc.clear();
      client.setSupportMode(false);
      setSupport(null);
      setUser(null);
    });
    let live = true;
    client.restoreSession().then((u) => {
      if (live) {
        setUser(u);
        setReady(true);
      }
    });
    return () => {
      live = false;
    };
  }, [qc]);

  const signIn = useCallback(async (w: string, e: string, p: string) => {
    const r = await client.login(w, e, p);
    if (r.kind === 'mfa') return r.mfaToken;
    setUser(r.user);
    return null;
  }, []);
  const completeMfa = useCallback(async (token: string, code: string) => setUser(await client.loginMfa(token, code)), []);
  const signOut = useCallback(async () => {
    await client.logout().catch(() => undefined);
    qc.clear();
    setUser(null);
  }, [qc]);
  const startSupport = useCallback((s: client.SupportSession) => {
    qc.clear();
    client.setSupportMode(true);
    client.setAccessToken(s.access_token);
    setSupport({ tenant: s.tenant.name });
    setUser({ id: 'support', full_name: 'Support (read-only)', roles: ['Support (read-only)'], permissions: ['accounts:read', 'journal:read', 'reports:read', 'audit:read'], mfa_enabled: true, mfa_enrollment_required: false });
  }, [qc]);
  const endSupport = useCallback(async () => {
    qc.clear();
    client.setSupportMode(false);
    setSupport(null);
    setUser(await client.restoreSession()); // back to the operator's own session
  }, [qc]);
  const refreshUser = useCallback(async () => {
    const me = await client.account.me();
    setUser((u) => (u ? { ...u, mfa_enabled: me.mfa_enabled, mfa_enrollment_required: me.mfa_enrollment_required } : u));
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, ready, signIn, completeMfa, signOut, refreshUser, support, startSupport, endSupport, can: (p) => !!user?.permissions.includes(p) }),
    [user, ready, signIn, completeMfa, signOut, refreshUser, support, startSupport, endSupport],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
