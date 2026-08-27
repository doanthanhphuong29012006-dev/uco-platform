'use client';

import type { AuthUser } from '@eco-oil/shared-types';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { browserTokenStorage } from './storage';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  loginAdmin: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.me().then((nextUser) => {
      if (nextUser.role === 'ADMIN') setUser(nextUser);
      else browserTokenStorage.clear();
    }).catch(() => browserTokenStorage.clear()).finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    error,
    loginAdmin: async (password: string) => {
      setLoading(true);
      setError(null);
      try {
        const session = await api.adminLogin(
          process.env.NEXT_PUBLIC_ADMIN_ZALO_ID ?? 'zalo_admin_01',
          process.env.NEXT_PUBLIC_ADMIN_PHONE ?? '0900000000',
          password,
        );
        if (session.user.role !== 'ADMIN') throw new Error('Tài khoản không có quyền quản trị');
        browserTokenStorage.setTokens(session.access_token, session.refresh_token);
        setUser(session.user);
      } catch (loginError) {
        setError(loginError instanceof Error ? loginError.message : 'Không thể đăng nhập');
      } finally {
        setLoading(false);
      }
    },
    signOut: async () => {
      const refreshToken = browserTokenStorage.getRefreshToken();
      try {
        await api.logout(refreshToken ?? undefined);
      } catch {
        // Token cleanup must still happen when the API session has expired.
      } finally {
        browserTokenStorage.clear();
        setUser(null);
      }
    },
  }), [error, loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
