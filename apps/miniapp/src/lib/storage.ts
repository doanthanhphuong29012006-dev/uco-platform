const ACCESS_TOKEN_KEY = 'eco_oil.access_token';
const REFRESH_TOKEN_KEY = 'eco_oil.refresh_token';

type NativeStorageApi = (typeof import('zmp-sdk'))['nativeStorage'];

async function loadNativeStorage(): Promise<NativeStorageApi | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const { nativeStorage } = await import('zmp-sdk');
    return nativeStorage;
  } catch {
    return null;
  }
}

const nativeStorage = await loadNativeStorage();

export interface TokenStorage {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(accessToken: string, refreshToken: string): void;
  clear(): void;
}

class PersistentTokenStorage implements TokenStorage {
  private readonly memoryStorage = new Map<string, string>();

  getAccessToken(): string | null {
    return this.read(ACCESS_TOKEN_KEY);
  }

  getRefreshToken(): string | null {
    return this.read(REFRESH_TOKEN_KEY);
  }

  setTokens(accessToken: string, refreshToken: string): void {
    this.write(ACCESS_TOKEN_KEY, accessToken);
    this.write(REFRESH_TOKEN_KEY, refreshToken);
  }

  clear(): void {
    this.remove(ACCESS_TOKEN_KEY);
    this.remove(REFRESH_TOKEN_KEY);
  }

  private read(key: string): string | null {
    if (nativeStorage) {
      try {
        const value = nativeStorage.getItem(key);
        if (typeof value === 'string') {
          return value;
        }
      } catch {
        // Fall through to browser storage when the Zalo runtime is unavailable.
      }
    }

    const browserStorage = this.getBrowserStorage();
    if (browserStorage) {
      try {
        const value = browserStorage.getItem(key);
        if (value !== null) {
          return value;
        }
      } catch {
        // Fall through to memory when storage access is blocked.
      }
    }

    return this.memoryStorage.get(key) ?? null;
  }

  private write(key: string, value: string): void {
    if (nativeStorage) {
      try {
        nativeStorage.setItem(key, value);
        return;
      } catch {
        // Fall through to browser storage when the Zalo runtime is unavailable.
      }
    }

    const browserStorage = this.getBrowserStorage();
    if (browserStorage) {
      try {
        browserStorage.setItem(key, value);
        return;
      } catch {
        // Fall through to memory when storage access is blocked.
      }
    }

    this.memoryStorage.set(key, value);
  }

  private remove(key: string): void {
    if (nativeStorage) {
      try {
        nativeStorage.removeItem(key);
      } catch {
        // Continue clearing fallback storage.
      }
    }

    const browserStorage = this.getBrowserStorage();
    if (browserStorage) {
      try {
        browserStorage.removeItem(key);
      } catch {
        // Continue clearing in-memory storage.
      }
    }

    this.memoryStorage.delete(key);
  }

  private getBrowserStorage(): Storage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }
}

export const tokenStorage: TokenStorage = new PersistentTokenStorage();
