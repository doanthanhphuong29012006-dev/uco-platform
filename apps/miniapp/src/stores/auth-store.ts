import type { AuthUser } from '@eco-oil/shared-types';
import { create } from 'zustand';
import { ApiError, API_BASE_URL, api, setUnauthorizedHandler } from '../lib/api';
import { authUserStorage, tokenStorage } from '../lib/storage';
import { setOutboxOwner } from '../lib/outbox-db';
import { isValidAuthSession, isValidAuthUser } from '../components/login-screen-logic';
import { consumeZaloOAuthCode } from '../lib/oauth-callback';

interface AuthState {
  user: AuthUser | null;
  hydrated: boolean;
  busy: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  loginSeed: (zaloId: string, phone: string) => Promise<void>;
  loginWithZalo: (accessToken: string) => Promise<void>;
  acceptCollectorInvite: (code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

function applyUserScope(user: AuthUser | null): void {
  setOutboxOwner(user?.role === 'COLLECTOR' ? user.collectorId ?? user.id : null);
}

function persistUser(user: AuthUser): void {
  authUserStorage.save(user);
  applyUserScope(user);
}

function clearSession(): void {
  tokenStorage.clear();
  authUserStorage.clear();
  applyUserScope(null);
}

function isExpiredSessionError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
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
    });
    return 'Zalo SDK không khả dụng. Hãy mở lại trong Zalo hoặc đăng nhập qua browser.';
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
    set({ hydrated: false, busy: true, error: null });
    hydratePromise = (async () => {
      const cachedUser = authUserStorage.load();
      const restoreAfterTemporaryFailure = (error: unknown, endpoint: string) => {
        if (cachedUser && isValidAuthUser(cachedUser) && tokenStorage.getAccessToken()) {
          applyUserScope(cachedUser);
          set({
            user: cachedUser,
            error: `${loginErrorMessage(error, endpoint)} Đang dùng phiên và dữ liệu đã lưu trên máy.`,
          });
          return;
        }
        applyUserScope(null);
        set({ user: null, error: loginErrorMessage(error, endpoint) });
      };

      let handoffSession: Awaited<ReturnType<typeof api.exchangeZaloOAuthCode>> | null = null;
      try {
        handoffSession = await consumeZaloOAuthCode((code) => api.exchangeZaloOAuthCode(code));
      } catch (error) {
        if (isExpiredSessionError(error)) clearSession();
        else restoreAfterTemporaryFailure(error, '/auth/zalo/exchange');
        return;
      }
      if (handoffSession) {
        if (!isValidAuthSession(handoffSession)) {
          clearSession();
          set({ user: null, error: 'Phản hồi đăng nhập không có định danh người dùng hợp lệ.' });
          return;
        }
        tokenStorage.setTokens(handoffSession.access_token, handoffSession.refresh_token);
        persistUser(handoffSession.user);
        try {
          const user = await api.me();
          if (!isValidAuthUser(user)) {
            throw new Error('Phản hồi phiên đăng nhập không hợp lệ.');
          }
          persistUser(user);
          set({ user, error: null });
        } catch (error) {
          if (isExpiredSessionError(error)) {
            clearSession();
            set({ user: null, error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
          } else {
            set({
              user: handoffSession.user,
              error: `${loginErrorMessage(error, '/auth/me')} Đang dùng phiên vừa đăng nhập đã lưu trên máy.`,
            });
          }
        }
        return;
      }

      try {
        const user = await api.me();
        if (!isValidAuthUser(user)) {
          clearSession();
          set({ user: null, error: 'Phiên đăng nhập không hợp lệ. Vui lòng chọn lại tài khoản.' });
          return;
        }
        persistUser(user);
        set({ user, error: null });
      } catch (error) {
        if (isExpiredSessionError(error)) {
          clearSession();
          set({ user: null, error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
        } else {
          restoreAfterTemporaryFailure(error, '/auth/me');
        }
      }
    })().finally(() => {
      set({ hydrated: true, busy: false });
      hydratePromise = null;
    });
    return hydratePromise;
  },
  loginSeed: async (zaloId, phone) => {
    set({ busy: true, error: null });
    try {
      const session = await api.loginSeed(zaloId, phone);
      if (!isValidAuthSession(session)) {
        throw new Error('Phản hồi đăng nhập không có định danh người dùng hợp lệ.');
      }
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      persistUser(session.user);
      set({ user: session.user, busy: false });
    } catch (error) {
      set({ busy: false, error: loginErrorMessage(error, '/auth/zalo') });
    }
  },
  loginWithZalo: async (accessToken) => {
    set({ busy: true, error: null });
    try {
      const session = await api.loginWithZaloAccessToken(accessToken);
      if (!isValidAuthSession(session)) {
        throw new Error('Phản hồi đăng nhập không có định danh người dùng hợp lệ.');
      }
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      persistUser(session.user);
      set({ user: session.user, busy: false });
    } catch (error) {
      set({ busy: false, error: loginErrorMessage(error, '/auth/zalo') });
    }
  },
  acceptCollectorInvite: async (code) => {
    set({ busy: true, error: null });
    try {
      const session = await api.acceptCollectorInvite(code);
      if (!isValidAuthSession(session)) {
        throw new Error('Phản hồi liên kết người thu gom không hợp lệ.');
      }
      tokenStorage.setTokens(session.access_token, session.refresh_token);
      const user = await api.me();
      if (!isValidAuthUser(user)) {
        throw new Error('Phản hồi phiên người thu gom không hợp lệ.');
      }
      persistUser(user);
      set({ user, busy: false, error: null });
    } catch (error) {
      set({ busy: false, error: loginErrorMessage(error, '/auth/collector-invites/accept') });
      throw error;
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
    clearSession();
    set({ user: null, busy: false, error: null, hydrated: true });
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().signOut());
