import { chooseImage, getAccessToken, getLocation, scanQRCode } from 'zmp-sdk';
import type { GeoPoint } from '@eco-oil/shared-types';

export const WARD_CENTER: GeoPoint = { lat: 10.7818, lng: 106.6851 };

export interface PhotoAsset {
  url: string;
  width: number;
  height: number;
}

export interface IZaloSdk {
  getAccessToken(): Promise<string>;
  getCurrentLocation(): Promise<GeoPoint>;
  scanQrCode(): Promise<string>;
  capturePhoto(): Promise<PhotoAsset>;
  openDirections(destination: GeoPoint): void;
}

async function browserLocation(): Promise<GeoPoint> {
  if (!navigator.geolocation) {
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

async function compressImage(filePath: string): Promise<PhotoAsset> {
  const response = await fetch(filePath);
  const source = await createImageBitmap(await response.blob());
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

class RealZaloSdk implements IZaloSdk {
  getAccessToken(): Promise<string> {
    return getAccessToken();
  }

  async getCurrentLocation(): Promise<GeoPoint> {
    await getLocation();
    try {
      return await browserLocation();
    } catch {
      // TODO(sprint-4): Exchange the Zalo location token with the backend location API in production.
      throw new Error('Không lấy được vị trí hiện tại');
    }
  }

  async scanQrCode(): Promise<string> {
    const result = await scanQRCode();
    return result.content.trim();
  }

  async capturePhoto(): Promise<PhotoAsset> {
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
}

class DevZaloSdk implements IZaloSdk {
  async getAccessToken(): Promise<string> {
    throw new Error('Zalo SDK is unavailable in browser development mode');
  }

  getCurrentLocation(): Promise<GeoPoint> {
    return browserLocation();
  }

  async scanQrCode(): Promise<string> {
    throw new Error('QR scanner is unavailable in browser development mode');
  }

  async capturePhoto(): Promise<PhotoAsset> {
    return { url: 'https://example.com/eco-oil-dev-photo.jpg', width: 1280, height: 960 };
  }

  openDirections(destination: GeoPoint): void {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export const zaloClient: IZaloSdk = import.meta.env.DEV ? new DevZaloSdk() : new RealZaloSdk();
