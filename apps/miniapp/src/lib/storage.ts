import { zaloClient } from './zalo-client';

const ACCESS_TOKEN_KEY = 'eco_oil.access_token';
const REFRESH_TOKEN_KEY = 'eco_oil.refresh_token';

export interface TokenStorage {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(accessToken: string, refreshToken: string): void;
  clear(): void;
}

class ZaloTokenStorage implements TokenStorage {
  getAccessToken(): string | null {
    return this.read(ACCESS_TOKEN_KEY);
  }

  getRefreshToken(): string | null {
    return this.read(REFRESH_TOKEN_KEY);
  }

  setTokens(accessToken: string, refreshToken: string): void {
    zaloClient.setStorage(ACCESS_TOKEN_KEY, accessToken);
    zaloClient.setStorage(REFRESH_TOKEN_KEY, refreshToken);
  }

  clear(): void {
    zaloClient.removeStorage(ACCESS_TOKEN_KEY);
    zaloClient.removeStorage(REFRESH_TOKEN_KEY);
  }

  private read(key: string): string | null {
    try {
      return zaloClient.getStorage(key);
    } catch {
      return null;
    }
  }
}

export const tokenStorage: TokenStorage = new ZaloTokenStorage();
