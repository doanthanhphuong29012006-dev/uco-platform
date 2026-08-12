import type { TokenStorage } from '@eco-oil/api-client';

const ACCESS_TOKEN_KEY = 'eco_oil.admin.access_token';
const REFRESH_TOKEN_KEY = 'eco_oil.admin.refresh_token';

export const browserTokenStorage: TokenStorage = {
  getAccessToken: () => (typeof window === 'undefined' ? null : window.localStorage.getItem(ACCESS_TOKEN_KEY)),
  getRefreshToken: () => (typeof window === 'undefined' ? null : window.localStorage.getItem(REFRESH_TOKEN_KEY)),
  setTokens: (accessToken, refreshToken) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear: () => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};
