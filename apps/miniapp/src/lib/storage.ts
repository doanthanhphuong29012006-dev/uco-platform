import { nativeStorage } from 'zmp-sdk';

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
    nativeStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    nativeStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }

  clear(): void {
    nativeStorage.removeItem(ACCESS_TOKEN_KEY);
    nativeStorage.removeItem(REFRESH_TOKEN_KEY);
  }

  private read(key: string): string | null {
    try {
      const value = nativeStorage.getItem(key);
      return value || null;
    } catch {
      return null;
    }
  }
}

export const tokenStorage: TokenStorage = new ZaloTokenStorage();
