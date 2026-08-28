import type { AuthUser } from '@eco-oil/shared-types';
import { create } from 'zustand';
import { ApiError, API_BASE_URL, api, setUnauthorizedHandler } from '../lib/api';
import { tokenStorage } from '../lib/storage';
import { setOutboxOwner } from '../lib/outbox-db';
import { isValidAuthUser } from '../components/login-screen-logic';
import { consumeZaloOAuthCode } from '../lib/oauth-callback';

interface AuthState {
  user: AuthUser | null;
  hydrated: boolean;
  busy: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  loginSeed: (zaloId: string, phone: string) => Promise<void>;
  loginWithZalo: (accessToken: string) => Promise<void>;
  signOut: () => Promise<void>;
}

function applyUserScope(user: AuthUser | null): void {
  setOutboxOwner(user?.role === 'COLLECTOR' ? user.collectorId ?? user.id : null);
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

let hydratePromise: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  hydrated: false,
  busy: false,
  error: null,
  hydrate: () => {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      let handoffSession: Awaited<ReturnType<typeof api.exchangeZaloOAuthCode>> | null = null;
      try {
        handoffSession = await consumeZaloOAuthCode((code) => api.exchangeZaloOAuthCode(code));
      } catch (error) {
        tokenStorage.clear();
        applyUserScope(null);
        set({ user: null, hydrated: true, busy: false, error: loginErrorMessage(error, '/auth/zalo/exchange') });
        return;
      }
      if (handoffSession) {
        try {
          if (!isValidAuthUser(handoffSession.user)) {
            throw new Error('Phản hồi đăng nhập không có định danh quán/người dùng hợp lệ.');
          }
          tokenStorage.setTokens(handoffSession.access_token, handoffSession.refresh_token);
          const user = await api.me();
          if (!isValidAuthUser(user)) {
            throw new Error('Phản hồi phiên đăng nhập không hợp lệ.');
          }
          applyUserScope(user);
          set({ user, hydrated: true, busy: false, error: null });
        } catch (error) {
          tokenStorage.clear();
          applyUserScope(null);
          set({ user: null, hydrated: true, busy: false, error: loginErrorMessage(error, '/auth/zalo/exchange') });
        }
        return;
      }

      try {
        const user = await api.me();
        if (!isValidAuthUser(user)) {
          tokenStorage.clear();
          applyUserScope(null);
          set({ user: null, hydrated: true, error: 'Phiên đăng nhập không hợp lệ. Vui lòng chọn lại tài khoản.' });
          return;
        }
        applyUserScope(user);
        set({ user, hydrated: true, error: null });
      } catch {
        tokenStorage.clear();
        applyUserScope(null);
        set({ user: null, hydrated: true, busy: false });
      }
    })().finally(() => {
      hydratePromise = null;
    });
    return hydratePromise;
  },
  loginSeed: async (zaloId, phone) => {
    set({ busy: true, error: null });
    try {
      const session = await api.loginSeed(zaloId, phone);
      if (!isValidAuthUser(session.user)) {
        throw new Error('Phản hồi đăng nhập không có định danh quán/người dùng hợp lệ.');
      }
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      applyUserScope(session.user);
      set({ user: session.user, busy: false });
    } catch (error) {
      set({ busy: false, error: loginErrorMessage(error, '/auth/zalo') });
    }
  },
  loginWithZalo: async (accessToken) => {
    set({ busy: true, error: null });
    try {
      const session = await api.loginWithZaloAccessToken(accessToken);
      if (!isValidAuthUser(session.user)) {
        throw new Error('Phản hồi đăng nhập không có định danh quán/người dùng hợp lệ.');
      }
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      applyUserScope(session.user);
      set({ user: session.user, busy: false });
    } catch (error) {
      set({ busy: false, error: loginErrorMessage(error, '/auth/zalo') });
    }
  },
  signOut: async () => {
    const refreshToken = tokenStorage.getRefreshToken();
    if (refreshToken) {
      try {
        await api.logout(refreshToken);
      } catch {
        // Local logout must still complete when the API is offline.
      }
    }
    tokenStorage.clear();
    applyUserScope(null);
    set({ user: null, busy: false, error: null, hydrated: true });
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().signOut());
