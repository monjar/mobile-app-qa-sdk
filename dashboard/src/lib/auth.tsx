/**
 * Session state: who is signed in, and the CSRF token that goes with the cookie.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Me, UserView } from '@snitch/contract';
import { ApiError, api, setCsrfToken, setUnauthorizedHandler } from './api';

interface AuthState {
  user: UserView | null;
  loading: boolean;
  signIn: (me: Me) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserView | null>(null);
  const [loading, setLoading] = useState(true);

  const signIn = useCallback((me: Me) => {
    setCsrfToken(me.csrfToken);
    setUser(me.user);
  }, []);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    api<Me>('/auth/me')
      .then(signIn)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
  }, [signIn, clear]);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    clear();
  }, [clear]);

  const value = useMemo(() => ({ user, loading, signIn, signOut }), [user, loading, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
