import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as client from './api';
import type { SessionUser } from './api';

interface AuthState {
  user: SessionUser | null;
  ready: boolean;
  signIn: (workspace: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    client.setSessionLostHandler(() => {
      qc.clear();
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

  const signIn = useCallback(async (w: string, e: string, p: string) => setUser(await client.login(w, e, p)), []);
  const signOut = useCallback(async () => {
    await client.logout().catch(() => undefined);
    qc.clear();
    setUser(null);
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({ user, ready, signIn, signOut, can: (p) => !!user?.permissions.includes(p) }),
    [user, ready, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
