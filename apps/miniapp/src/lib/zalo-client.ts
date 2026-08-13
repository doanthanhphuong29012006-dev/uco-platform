import type { GeoPoint } from '@eco-oil/shared-types';

export interface PhotoAsset {
  url: string;
  width: number;
  height: number;
}

export interface SeedAccount {
  zaloId: string;
  phone: string;
  name?: string;
}

export interface IZaloClient {
  readonly mode: 'real' | 'mock';
  login(): Promise<SeedAccount>;
  setSeedAccount(account: SeedAccount): void;
  getAccessToken(): Promise<string>;
  getLocation(fallback?: GeoPoint | null): Promise<GeoPoint | null>;
  scanQRCode(): Promise<string>;
  chooseImage(): Promise<PhotoAsset>;
  openDirections(destination: GeoPoint): void;
  getStorage(key: string): string | null;
  setStorage(key: string, value: string): void;
  removeStorage(key: string): void;
}

interface NativeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type WindowWithZaloRuntime = Window & {
  zmp?: unknown;
  __zmp?: unknown;
  zmpSdk?: unknown;
  ZaloMiniApp?: unknown;
  ZaloMiniAppSDK?: {
    nativeStorage?: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    };
  };
  ZaloJavaScriptInterface?: unknown;
};

export function isZaloEnvironment(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const runtime = window as WindowWithZaloRuntime;
  return Boolean(
    runtime.zmp
      || runtime.__zmp
      || runtime.zmpSdk
      || runtime.ZaloMiniApp
      || runtime.ZaloMiniAppSDK
      || runtime.ZaloJavaScriptInterface,
  );
}

async function browserLocation(): Promise<GeoPoint> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('GPS is not available');
  }
  return new Promise<GeoPoint>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => reject(new Error('Location permission denied')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8_000 },
    );
  });
}

export async function compressImageBlob(blob: Blob): Promise<PhotoAsset> {
  const source = await createImageBitmap(blob);
  const scale = Math.min(1, 1280 / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Image compression is unavailable');
  }
  context.drawImage(source, 0, 0, width, height);
  source.close();
  return { url: canvas.toDataURL('image/jpeg', 0.7), width, height };
}

async function compressImage(filePath: string): Promise<PhotoAsset> {
  const response = await fetch(filePath);
  return compressImageBlob(await response.blob());
}

class RealZaloClient implements IZaloClient {
  readonly mode = 'real' as const;
  private seedAccount: SeedAccount = { zaloId: '', phone: '' };

  async login(): Promise<SeedAccount> {
    const accessToken = await this.getAccessToken();
    return { zaloId: accessToken, phone: 'zmp-user' };
  }

  setSeedAccount(account: SeedAccount): void {
    this.seedAccount = account;
  }

  getAccessToken(): Promise<string> {
    return import('zmp-sdk').then(({ getAccessToken }) => getAccessToken());
  }

  async getLocation(): Promise<GeoPoint | null> {
    const { getLocation } = await import('zmp-sdk');
    await getLocation();
    try {
      return await browserLocation();
    } catch {
      // TODO(sprint-4): Exchange the Zalo location token with the backend location API in production.
      throw new Error('Không lấy được vị trí hiện tại');
    }
  }

  async scanQRCode(): Promise<string> {
    const { scanQRCode } = await import('zmp-sdk');
    const result = await scanQRCode();
    return result.content.trim();
  }

  async chooseImage(): Promise<PhotoAsset> {
    const { chooseImage } = await import('zmp-sdk');
    const result = await chooseImage({ count: 1, sourceType: ['camera'], cameraType: 'back' });
    const filePath = result.filePaths[0];
    if (!filePath) {
      throw new Error('Chưa chọn ảnh');
    }
    return compressImage(filePath);
  }

  openDirections(destination: GeoPoint): void {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  getStorage(key: string): string | null {
    return this.nativeStorage().getItem(key) || null;
  }

  setStorage(key: string, value: string): void {
    this.nativeStorage().setItem(key, value);
  }

  removeStorage(key: string): void {
    this.nativeStorage().removeItem(key);
  }

  private nativeStorage(): NativeStorage {
    const storage = (window as WindowWithZaloRuntime).ZaloMiniAppSDK?.nativeStorage;
    if (!storage) {
      throw new Error('Zalo native storage is unavailable');
    }
    return storage;
  }
}

class MockZaloClient implements IZaloClient {
  readonly mode = 'mock' as const;
  private seedAccount: SeedAccount = { zaloId: 'zalo_merchant_01', phone: '0900000001' };
  private qrCode = '';
  private readonly memoryStorage = new Map<string, string>();

  async login(): Promise<SeedAccount> {
    return this.seedAccount;
  }

  setSeedAccount(account: SeedAccount): void {
    this.seedAccount = account;
  }

  async getAccessToken(): Promise<string> {
    return `mock-access-token:${this.seedAccount.zaloId}`;
  }

  async getLocation(fallback: GeoPoint | null = null): Promise<GeoPoint | null> {
    try {
      return await browserLocation();
    } catch {
      return fallback;
    }
  }

  async scanQRCode(): Promise<string> {
    return this.qrCode;
  }

  async chooseImage(): Promise<PhotoAsset> {
    throw new Error('Camera is unavailable in mock mode. Choose an image file.');
  }

  openDirections(destination: GeoPoint): void {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  getStorage(key: string): string | null {
    const storage = this.browserStorage();
    if (!storage) {
      return this.memoryStorage.get(key) ?? null;
    }
    return storage.getItem(key);
  }

  setStorage(key: string, value: string): void {
    const storage = this.browserStorage();
    if (!storage) {
      this.memoryStorage.set(key, value);
      return;
    }
    try {
      storage.setItem(key, value);
    } catch {
      this.memoryStorage.set(key, value);
    }
  }

  removeStorage(key: string): void {
    const storage = this.browserStorage();
    if (!storage) {
      this.memoryStorage.delete(key);
      return;
    }
    try {
      storage.removeItem(key);
    } catch {
      this.memoryStorage.delete(key);
    }
  }

  private browserStorage(): Storage | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return typeof localStorage.getItem === 'function'
      && typeof localStorage.setItem === 'function'
      && typeof localStorage.removeItem === 'function'
      ? localStorage
      : null;
  }
}

export function createZaloClient(inZaloEnvironment = isZaloEnvironment()): IZaloClient {
  return inZaloEnvironment ? new RealZaloClient() : new MockZaloClient();
}

export const zaloClient = createZaloClient();

if (zaloClient.mode === 'mock') {
  console.warn('[zalo] Chạy ở chế độ MOCK — SDK thật không khả dụng.');
}
