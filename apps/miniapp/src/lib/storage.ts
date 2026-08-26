import type { CurrentRouteResponse, RouteStop } from '@eco-oil/shared-types';
import type { nativeStorage as ZaloNativeStorage } from 'zmp-sdk';

const ACCESS_TOKEN_KEY = 'eco_oil.access_token';
const REFRESH_TOKEN_KEY = 'eco_oil.refresh_token';
const PENDING_STATION_DELIVERY_KEY_PREFIX = 'eco_oil.pending_station_delivery.';

type NativeStorageApi = typeof ZaloNativeStorage;

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

  read(key: string): string | null {
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

  write(key: string, value: string): void {
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

  remove(key: string): void {
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

const persistentStorage = new PersistentTokenStorage();
export const tokenStorage: TokenStorage = persistentStorage;

export interface PendingStationDeliveryStop {
  liters: number;
  kilograms: number | null;
  clientUuid: string;
  stop: RouteStop;
}

export interface PendingStationDeliveryShift {
  completed: Record<string, PendingStationDeliveryStop>;
  totalStops: number;
  savedAt: string;
  activeRoute?: CurrentRouteResponse;
  routeClientUuid?: string;
}

export interface PendingStationDeliveryStorage {
  load(collectorId: string): PendingStationDeliveryShift | null;
  save(collectorId: string, shift: PendingStationDeliveryShift): void;
  clear(collectorId: string): void;
}

function pendingShiftKey(collectorId: string): string {
  return `${PENDING_STATION_DELIVERY_KEY_PREFIX}${collectorId}`;
}

export const pendingStationDeliveryStorage: PendingStationDeliveryStorage = {
  load(collectorId) {
    const value = persistentStorage.read(pendingShiftKey(collectorId));
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as PendingStationDeliveryShift;
      if (!parsed || typeof parsed !== 'object' || !parsed.completed || typeof parsed.totalStops !== 'number') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  },
  save(collectorId, shift) {
    persistentStorage.write(pendingShiftKey(collectorId), JSON.stringify(shift));
  },
  clear(collectorId) {
    persistentStorage.remove(pendingShiftKey(collectorId));
  },
};
