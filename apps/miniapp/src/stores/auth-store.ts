import type { AuthUser } from '@eco-oil/shared-types';
import { create } from 'zustand';
import { ApiError, API_BASE_URL, api, setUnauthorizedHandler } from '../lib/api';
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

function loginErrorMessage(error: unknown, endpoint: string): string {
  const url = `${API_BASE_URL}${endpoint}`;
  const sdkError = typeof error === 'object' && error !== null
    ? error as { code?: unknown; api?: unknown; message?: unknown }
    : null;
  if (sdkError?.code === -2000) {
    console.error('[auth] Zalo SDK error', {
      url,
      api: sdkError.api,
      code: sdkError.code,
      message: sdkError.message,
      error,
    });
    return 'Zalo SDK không khả dụng ngoài app Zalo — đang dùng chế độ mô phỏng.';
  }
  if (error instanceof ApiError) {
    console.error('[auth] HTTP login error', { url, code: error.code, details: error.details });
    return error.message;
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    console.error('[auth] Network/CORS login error', { url, error });
    return 'Không kết nối được máy chủ. Kiểm tra API đã chạy chưa.';
  }
  console.error('[auth] Unexpected login error', { url, error });
  return error instanceof Error ? error.message : 'Đăng nhập thất bại. Vui lòng thử lại.';
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
    } catch (error) {
      set({ busy: false, error: loginErrorMessage(error, '/auth/zalo') });
    }
  },
  loginWithZalo: async (accessToken) => {
    set({ busy: true, error: null });
    try {
      const session = await api.loginWithZaloAccessToken(accessToken);
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      set({ user: session.user, busy: false });
    } catch (error) {
      set({ busy: false, error: loginErrorMessage(error, '/auth/zalo') });
    }
  },
  signOut: () => {
    tokenStorage.clear();
    set({ user: null, error: null });
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().signOut());
