import type { AuthUser } from '@eco-oil/shared-types';
import { create } from 'zustand';
import { api, setUnauthorizedHandler } from '../lib/api';
import { tokenStorage } from '../lib/storage';

interface AuthState {
  user: AuthUser | null;
  hydrated: boolean;
  busy: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  loginSeed: (zaloId: string, phone: string) => Promise<void>;
  loginWithZalo: (accessToken: string) => Promise<void>;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  hydrated: false,
  busy: false,
  error: null,
  hydrate: async () => {
    if (!tokenStorage.getAccessToken()) {
      set({ hydrated: true });
      return;
    }
    try {
      const user = await api.me();
      set({ user, hydrated: true });
    } catch {
      tokenStorage.clear();
      set({ user: null, hydrated: true });
    }
  },
  loginSeed: async (zaloId, phone) => {
    set({ busy: true, error: null });
    try {
      const session = await api.loginSeed(zaloId, phone);
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      set({ user: session.user, busy: false });
    } catch {
      set({ busy: false, error: 'Đăng nhập thất bại. Vui lòng thử lại.' });
      throw new Error('Seed login failed');
    }
  },
  loginWithZalo: async (accessToken) => {
    set({ busy: true, error: null });
    try {
      const session = await api.loginWithZaloAccessToken(accessToken);
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      set({ user: session.user, busy: false });
    } catch {
      set({ busy: false, error: 'Chưa thể xác thực tài khoản Zalo này.' });
      throw new Error('Zalo login failed');
    }
  },
  signOut: () => {
    tokenStorage.clear();
    set({ user: null, error: null });
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().signOut());
