import type { GeoPoint } from '@eco-oil/shared-types';
import type { GetLocationReturns, GetSettingReturn } from 'zmp-sdk';
import { scanBrowserQrCode } from './browser-qr-scanner';

export interface PhotoAsset {
  url: string;
  width: number;
  height: number;
}

export type ImageSource = 'camera' | 'album';

export interface SeedAccount {
  zaloId: string;
  phone: string;
  name?: string;
}

export interface IZaloClient {
  readonly mode: 'native' | 'browser' | 'mock';
  login(): Promise<SeedAccount>;
  setSeedAccount(account: SeedAccount): void;
  getAccessToken(): Promise<string>;
  getLocation(fallback?: GeoPoint | null): Promise<GeoPoint | null>;
  scanQRCode(): Promise<string>;
  chooseImage(source?: ImageSource): Promise<PhotoAsset>;
  cancelMediaPicker?(): void;
  openPhone(phoneNumber: string): Promise<void>;
  preparePhone?(): Promise<void>;
  openDirections(destination: GeoPoint, address?: string | null): Promise<void>;
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
  APP_ID?: string;
  zAppID?: string;
  ZaloMiniAppSDK?: {
    nativeStorage?: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    };
    getLocation?: unknown;
    scanQRCode?: unknown;
    chooseImage?: unknown;
    openPhone?: unknown;
    openWebview?: unknown;
    getAccessToken?: unknown;
  };
};

export function isZaloEnvironment(runtimeWindow: Window | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  if (!runtimeWindow) {
    return false;
  }
  const runtime = runtimeWindow as WindowWithZaloRuntime;
  const sdk = runtime.ZaloMiniAppSDK;
  const supportedNativeFunctions = [
    sdk?.getAccessToken,
    sdk?.getLocation,
    sdk?.scanQRCode,
    sdk?.chooseImage,
    sdk?.openPhone,
    sdk?.openWebview,
  ].filter((candidate) => typeof candidate === 'function').length;
  const userAgent = runtimeWindow.navigator?.userAgent ?? '';
  const hasAppIdentity = Boolean(runtime.APP_ID?.trim() || runtime.zAppID?.trim());
  let hasMiniAppUrl = false;
  try {
    const url = new URL(runtimeWindow.location.href);
    // zmp-sdk 2.53.0 appEnv/getEnv uses this host/path BEFORE it installs ZaloMiniAppSDK.
    hasMiniAppUrl = url.hostname === 'h5.zdn.vn' && (url.pathname.startsWith('/zapps/') || url.searchParams.get('env') === 'TESTING_LOCAL');
  } catch { /* Tests and older injected runtimes may not expose location yet. */ }

  // A real ZMP runtime exposes several documented SDK capabilities. Older
  // clients are also recognized from the Zalo UA plus an injected app id.
  return hasMiniAppUrl || supportedNativeFunctions >= 2 || (hasAppIdentity && /\bZalo\b/i.test(userAgent));
}

export class DeviceIntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceIntegrationError';
  }
}

export async function browserLocation(timeoutMs = 10_000): Promise<GeoPoint> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new DeviceIntegrationError('GEOLOCATION_UNSUPPORTED', 'Thiết bị hoặc trình duyệt không hỗ trợ GPS.');
  }
  return new Promise<GeoPoint>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new DeviceIntegrationError('GEOLOCATION_PERMISSION_DENIED', 'Quyền vị trí đã bị từ chối. Hãy bật Location cho Safari/Chrome rồi thử lại.'));
        } else if (error.code === error.TIMEOUT) {
          reject(new DeviceIntegrationError('GEOLOCATION_TIMEOUT', 'GPS không phản hồi trong thời gian cho phép. Hãy thử lại ở nơi thoáng hơn.'));
        } else {
          reject(new DeviceIntegrationError('GEOLOCATION_UNAVAILABLE', 'Không xác định được vị trí GPS hiện tại.'));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
    );
  });
}

function loadImageFromDataUrl(url: string, timeoutMs = 15_000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = globalThis.setTimeout(
      () => reject(new DeviceIntegrationError('IMAGE_TIMEOUT', 'Đọc ảnh quá thời gian chờ.')),
      timeoutMs,
    );
    image.onload = () => {
      globalThis.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      globalThis.clearTimeout(timer);
      reject(new DeviceIntegrationError('IMAGE_INVALID', 'Không đọc được ảnh đã chọn.'));
    };
    image.src = url;
  });
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new DeviceIntegrationError('IMAGE_INVALID', 'Không đọc được ảnh đã chọn.'));
    reader.readAsDataURL(blob);
  });
}

async function imageSourceFromBlob(blob: Blob): Promise<CanvasImageSource & { width: number; height: number; close?: () => void }> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }
  const image = await loadImageFromDataUrl(await blobAsDataUrl(blob));
  return Object.assign(image, { width: image.naturalWidth, height: image.naturalHeight });
}

async function compressCanvasSource(
  source: CanvasImageSource & { width: number; height: number; close?: () => void },
): Promise<PhotoAsset> {
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
  source.close?.();
  return { url: canvas.toDataURL('image/jpeg', 0.7), width, height };
}

export async function compressImageBlob(blob: Blob): Promise<PhotoAsset> {
  return compressCanvasSource(await imageSourceFromBlob(blob));
}

export interface ZaloNavigationSdk {
  openPhone(args: { phoneNumber: string }): Promise<void>;
  openWebview(args: { url: string; config: { style: 'normal'; leftButton: 'back' } }): Promise<void>;
}

export interface ZaloLocationSdk {
  getAccessToken(): Promise<string>;
  getLocation(): Promise<GetLocationReturns>;
  getSetting?(): Promise<GetSettingReturn>;
  authorize?(args: { scopes: ['scope.userLocation'] }): Promise<{ 'scope.userLocation'?: boolean }>;
}

export interface ZaloMediaPickerError {
  code: number;
  message?: string;
  api?: string;
}

export interface ZaloMediaPickerResult {
  filePaths: string[];
}

export interface ZaloMediaPickerArgs {
  count: number;
  sourceType: ImageSource[];
  cameraType?: 'back' | 'front';
  success?: (result: ZaloMediaPickerResult) => void;
  fail?: (error: ZaloMediaPickerError) => void;
}

export interface ZaloMediaSdk {
  scanQRCode(): Promise<{ content: string }>;
  chooseImage(args: ZaloMediaPickerArgs): Promise<ZaloMediaPickerResult>;
}

export class MediaPickerCancelledError extends Error {
  constructor() {
    super('Bạn chưa chọn ảnh');
    this.name = 'MediaPickerCancelledError';
  }
}

export function isMediaPickerCancelled(error: unknown): boolean {
  if (error instanceof MediaPickerCancelledError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = Number((error as { code?: unknown }).code);
  if ([-2003, -606, -101].includes(code)) return true;
  const message = String((error as { message?: unknown }).message ?? '').toLowerCase();
  return /user\s+(cancel|canceled|cancelled)|\b(cancel|canceled|cancelled)\b/.test(message);
}

const MEDIA_PICKER_WATCHDOG_MS = 90_000;

type MediaPickerEventTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export interface MediaPickerLifecycle {
  document: (MediaPickerEventTarget & { visibilityState?: string }) | null;
  window: MediaPickerEventTarget | null;
}

function getMediaPickerLifecycle(): MediaPickerLifecycle {
  const documentTarget = typeof document === 'undefined' ? null : document;
  const windowTarget = typeof window === 'undefined' ? null : window;
  return {
    document: documentTarget && typeof documentTarget.addEventListener === 'function' && typeof documentTarget.removeEventListener === 'function' ? documentTarget : null,
    window: windowTarget && typeof windowTarget.addEventListener === 'function' && typeof windowTarget.removeEventListener === 'function' ? windowTarget : null,
  };
}

function settleMediaPicker(
  sdk: Pick<ZaloMediaSdk, 'chooseImage'>,
  args: Omit<ZaloMediaPickerArgs, 'success' | 'fail'>,
  lifecycle: MediaPickerLifecycle,
  registerCancel?: (cancel: (() => void) | null) => void,
  timeoutMs = MEDIA_PICKER_WATCHDOG_MS,
): Promise<ZaloMediaPickerResult> {
  // Focus/visibility changes are not cancellation signals: iOS and Zalo both
  // leave the page while their native picker is open.
  void lifecycle;
  return new Promise<ZaloMediaPickerResult>((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (watchdog) clearTimeout(watchdog);
      registerCancel?.(null);
    };

    const finish = (outcome: { result: ZaloMediaPickerResult } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('result' in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };

    const success = (result: ZaloMediaPickerResult) => {
      if (result?.filePaths?.length) finish({ result });
      else finish({ error: new MediaPickerCancelledError() });
    };
    const fail = (error: ZaloMediaPickerError) => finish({ error });

    registerCancel?.(() => finish({ error: new MediaPickerCancelledError() }));
    watchdog = setTimeout(
      () => finish({ error: new DeviceIntegrationError('MEDIA_PICKER_TIMEOUT', 'Trình chọn ảnh không phản hồi. Hãy thử lại.') }),
      timeoutMs,
    );
    try {
      const operation = sdk.chooseImage({ ...args, success, fail });
      if (operation && typeof operation.then === 'function') {
        operation.then(success, fail);
      }
    } catch (error) {
      fail(error as ZaloMediaPickerError);
    }
  });
}

export function isZaloPermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return Number(code) === -201 || Number(code) === -2002 || code === 'GEOLOCATION_PERMISSION_DENIED' || code === 'CAMERA_PERMISSION_DENIED';
}

function withDeviceTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new DeviceIntegrationError('DEVICE_TIMEOUT', message)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function parseContainerCodeFromQr(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['container_code', 'containerCode', 'qr_code', 'code']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // A regular QR string is expected to fail JSON parsing.
  }

  try {
    const url = new URL(trimmed);
    for (const key of ['container_code', 'containerCode', 'qr_code', 'code']) {
      const value = url.searchParams.get(key)?.trim();
      if (value) return value;
    }
    const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '').trim();
    if (/^ECO[-_]/i.test(lastSegment)) return lastSegment;
  } catch {
    // A raw container code is expected to fail URL parsing.
  }

  return trimmed;
}

export function isValidGeoPoint(destination: { lat?: unknown; lng?: unknown }): boolean {
  return typeof destination.lat === 'number'
    && Number.isFinite(destination.lat)
    && destination.lat >= -90
    && destination.lat <= 90
    && typeof destination.lng === 'number'
    && Number.isFinite(destination.lng)
    && destination.lng >= -180
    && destination.lng <= 180;
}

export function buildGoogleMapsDirectionsUrl(destination: GeoPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${destination.lat},${destination.lng}`)}`;
}

export function normalizeVietnamesePhone(phoneNumber: string): string {
  const normalized = phoneNumber.trim().replace(/[\s().-]/g, '');
  if (/^0\d{9}$/.test(normalized)) return `+84${normalized.slice(1)}`;
  if (/^84\d{9}$/.test(normalized)) return `+${normalized}`;
  if (/^\+84\d{9}$/.test(normalized)) return normalized;
  throw new DeviceIntegrationError('PHONE_INVALID', 'Số điện thoại quán không hợp lệ.');
}

export async function copyPhoneNumber(phoneNumber: string): Promise<boolean> {
  const normalized = normalizeVietnamesePhone(phoneNumber);
  return copyText(normalized, typeof navigator === 'undefined' ? null : navigator);
}

async function compressImage(filePath: string): Promise<PhotoAsset> {
  const image = await loadImageFromDataUrl(filePath);
  return compressCanvasSource(
    Object.assign(image, { width: image.naturalWidth, height: image.naturalHeight }),
  );
}

export class RealZaloClient implements IZaloClient {
  readonly mode = 'native' as const;
  private seedAccount: SeedAccount = { zaloId: '', phone: '' };
  private cancelActiveMediaPicker: (() => void) | null = null;
  private mediaPickerCancelRequested = false;
  private navigationSdk: ZaloNavigationSdk | null = null;
  private navigationLoading: Promise<void> | null = null;
  private locationInFlight: Promise<GeoPoint | null> | null = null;
  private readonly usedLocationTokens = new Set<string>();

  constructor(
    private readonly loadSdk: () => Promise<ZaloNavigationSdk> = () => import('zmp-sdk'),
    private readonly loadLocationSdk: () => Promise<ZaloLocationSdk> = () => import('zmp-sdk'),
    private readonly resolveLocation: (accessToken: string, locationToken: string) => Promise<GeoPoint> = async (accessToken, locationToken) => {
      const { api } = await import('./api');
      return api.resolveZaloLocation(accessToken, locationToken);
    },
    private readonly loadMediaSdk: () => Promise<ZaloMediaSdk> = () => import('zmp-sdk'),
    private readonly resolveImage: (filePath: string) => Promise<PhotoAsset> = compressImage,
    private readonly mediaPickerLifecycle: () => MediaPickerLifecycle = getMediaPickerLifecycle,
    private readonly mediaPickerTimeoutMs = MEDIA_PICKER_WATCHDOG_MS,
    private readonly deviceTimeoutMs = 20_000,
  ) {}

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

  getLocation(): Promise<GeoPoint | null> {
    if (!this.locationInFlight) {
      this.locationInFlight = this.acquireLocation().finally(() => { this.locationInFlight = null; });
    }
    return this.locationInFlight;
  }

  private async acquireLocation(): Promise<GeoPoint> {
    let stage = 'sdk-load';
    const started = Date.now();
    const timed = <T,>(operation: Promise<T>) => withDeviceTimeout(operation, this.deviceTimeoutMs, `GPS không phản hồi tại bước ${stage}. Hãy thử lấy vị trí lại.`);
    try {
      const sdk = await timed(this.loadLocationSdk());
      stage = 'permission';
      if (sdk.getSetting && sdk.authorize) {
        const setting = await timed(sdk.getSetting());
        if (!setting.authSetting['scope.userLocation']) {
          const granted = await timed(sdk.authorize({ scopes: ['scope.userLocation'] }));
          if (!granted['scope.userLocation']) throw new DeviceIntegrationError('GEOLOCATION_PERMISSION_DENIED', 'Chưa được cấp quyền vị trí cho Mini App trong Zalo.');
        }
      }
      stage = 'access-token';
      const accessToken = (await timed(sdk.getAccessToken())).trim();
      if (!accessToken) throw new DeviceIntegrationError('ZALO_ACCESS_TOKEN_MISSING', 'Zalo không trả access token. Kiểm tra runtime và đăng nhập lại.');
      stage = 'location-result';
      const result = await timed(sdk.getLocation());
      const token = typeof result.token === 'string' ? result.token.trim() : '';
      console.info('[gps]', { stage, runtime: this.mode, has_token: Boolean(token), has_legacy_coordinates: result.latitude !== undefined && result.longitude !== undefined, elapsed_ms: Date.now() - started });
      if (!token) {
        // Older SDK clients can return real coordinates instead of a token.
        const point = { lat: Number(result.latitude), lng: Number(result.longitude) };
        if (result.latitude?.trim() && result.longitude?.trim() && isValidGeoPoint(point)) return point;
        throw new DeviceIntegrationError('ZALO_LOCATION_TOKEN_MISSING', 'SDK Zalo không trả token hoặc tọa độ vị trí. Kiểm tra quyền Mini App, runtime và phiên bản Zalo; relay chưa được gọi.');
      }
      if (this.usedLocationTokens.has(token)) throw new DeviceIntegrationError('ZALO_LOCATION_TOKEN_REUSED', 'Zalo trả lại token vị trí đã dùng. Hãy lấy vị trí mới.');
      this.usedLocationTokens.add(token);
      stage = 'backend-exchange';
      const point = await timed(this.resolveLocation(accessToken, token));
      if (!isValidGeoPoint(point)) throw new DeviceIntegrationError('ZALO_LOCATION_INVALID', 'Máy chủ trả tọa độ không hợp lệ.');
      console.info('[gps]', { stage: 'complete', runtime: this.mode, elapsed_ms: Date.now() - started });
      return point;
    } catch (error) {
      const details = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown } : {};
      console.warn('[gps]', { stage, runtime: this.mode, code: typeof details.code === 'number' || typeof details.code === 'string' && /^[A-Z_]+$/.test(details.code) ? details.code : 'UNKNOWN', http_status: typeof details.status === 'number' ? details.status : null, elapsed_ms: Date.now() - started });
      if (isZaloPermissionDenied(error)) throw new DeviceIntegrationError('GEOLOCATION_PERMISSION_DENIED', 'Quyền vị trí Mini App bị từ chối. Kiểm tra quyền trong Zalo rồi thử lại.');
      if (Number(details.code) === -1404) throw new DeviceIntegrationError('ZALO_LOCATION_SDK_UNSUPPORTED', 'Phiên bản Zalo này không hỗ trợ API/token vị trí. Hãy cập nhật Zalo và kiểm tra quyền API của Mini App.');
      if (!(error instanceof Error)) throw new DeviceIntegrationError('ZALO_LOCATION_SDK_ERROR', `Zalo báo lỗi ở bước ${stage} (mã ${typeof details.code === 'number' ? details.code : 'không rõ'}). Hãy thử lấy vị trí mới.`);
      throw error;
    }
  }

  async scanQRCode(): Promise<string> {
    const { scanQRCode } = await this.loadMediaSdk();
    const result = await withDeviceTimeout(
      scanQRCode(),
      45_000,
      'Trình quét QR Zalo không phản hồi.',
    );
    return parseContainerCodeFromQr(result.content);
  }

  async chooseImage(source: ImageSource = 'camera'): Promise<PhotoAsset> {
    this.mediaPickerCancelRequested = false;
    const { chooseImage } = await this.loadMediaSdk();
    if (this.mediaPickerCancelRequested) throw new MediaPickerCancelledError();
    const result = await settleMediaPicker({ chooseImage }, {
      count: 1,
      sourceType: [source],
      ...(source === 'camera' ? { cameraType: 'back' as const } : {}),
    }, this.mediaPickerLifecycle(), (cancel) => { this.cancelActiveMediaPicker = cancel; }, this.mediaPickerTimeoutMs);
    const filePath = result.filePaths?.[0];
    if (!filePath) {
      throw new MediaPickerCancelledError();
    }
    return this.resolveImage(filePath);
  }

  cancelMediaPicker(): void {
    if (this.cancelActiveMediaPicker) this.cancelActiveMediaPicker();
    else this.mediaPickerCancelRequested = true;
  }

  preparePhone(): Promise<void> {
    if (!this.navigationLoading) this.navigationLoading = this.loadSdk().then((sdk) => { this.navigationSdk = sdk; }).catch((error) => { this.navigationLoading = null; throw error; });
    return this.navigationLoading;
  }

  async openPhone(phoneNumber: string): Promise<void> {
    const normalizedPhone = normalizeVietnamesePhone(phoneNumber);
    if (!this.navigationSdk) throw new DeviceIntegrationError('PHONE_SDK_NOT_READY', 'SDK gọi điện chưa sẵn sàng. Hãy bấm “Gọi bằng điện thoại” bên dưới.');
    const started = Date.now();
    try {
      // Invoke before any await/import: preserve the user's native click gesture.
      await withDeviceTimeout(this.navigationSdk.openPhone({ phoneNumber: normalizedPhone }), this.deviceTimeoutMs, 'Zalo chưa phản hồi mở màn hình gọi.');
    } catch (error) {
      console.warn('[phone]', { stage: 'open-screen', runtime: this.mode, elapsed_ms: Date.now() - started, code: error instanceof DeviceIntegrationError ? error.code : typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : 'SDK_ERROR' });
      throw new DeviceIntegrationError(
        'PHONE_OPEN_BLOCKED',
        'Không xác nhận được việc mở màn hình gọi. Nếu chưa mở, hãy bấm “Gọi bằng điện thoại” hoặc sao chép số.',
      );
    }
  }

  async openDirections(destination: GeoPoint): Promise<void> {
    if (!isValidGeoPoint(destination)) {
      throw new Error('Tọa độ chỉ đường không hợp lệ');
    }
    const { openWebview } = await this.loadSdk();
    await openWebview({
      url: buildGoogleMapsDirectionsUrl(destination),
      config: { style: 'normal', leftButton: 'back' },
    });
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

type BrowserWindow = Pick<Window, 'location' | 'open'>;
type BrowserNavigator = Pick<Navigator, 'clipboard'>;

function getBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

async function copyText(value: string, browserNavigator: BrowserNavigator | null): Promise<boolean> {
  try {
    if (!browserNavigator?.clipboard?.writeText) return false;
    await browserNavigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function pickBrowserImage(source: ImageSource): Promise<PhotoAsset> {
  if (typeof document === 'undefined') {
    return Promise.reject(
      new DeviceIntegrationError('IMAGE_PICKER_UNSUPPORTED', 'Trình duyệt không hỗ trợ chọn ảnh.'),
    );
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (source === 'camera') input.setAttribute('capture', 'environment');
    input.className = 'accessible-file-input';
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    document.body.append(input);

    let settled = false;
    const finish = (result: PhotoAsset | Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      input.remove();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timeout = globalThis.setTimeout(
      () =>
        finish(
          new DeviceIntegrationError(
            'MEDIA_PICKER_TIMEOUT',
            'Trình chọn ảnh không phản hồi. Hãy thử lại.',
          ),
        ),
      MEDIA_PICKER_WATCHDOG_MS,
    );
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) {
        finish(new MediaPickerCancelledError());
        return;
      }
      void compressImageBlob(file).then(
        (photo) => finish(photo),
        (error) => finish(error instanceof Error ? error : new Error('Không đọc được ảnh.')),
      );
    });
    // Keep this synchronous so Safari sees the original user gesture.
    input.click();
  });
}

export class BrowserZaloClient implements IZaloClient {
  readonly mode = 'browser' as const;
  private seedAccount: SeedAccount = { zaloId: '', phone: '' };
  private readonly memoryStorage = new Map<string, string>();

  constructor(
    private readonly getBrowserLocation: () => Promise<GeoPoint> = () => browserLocation(),
    private readonly scanBrowserQr: () => Promise<string> = () => scanBrowserQrCode(),
    private readonly chooseBrowserImage: (source: ImageSource) => Promise<PhotoAsset> = pickBrowserImage,
    private readonly browserWindow: BrowserWindow | null =
      typeof window === 'undefined' ? null : window,
    private readonly browserNavigator: BrowserNavigator | null =
      typeof navigator === 'undefined' ? null : navigator,
  ) {}

  async login(): Promise<SeedAccount> {
    return this.seedAccount;
  }

  setSeedAccount(account: SeedAccount): void {
    this.seedAccount = account;
  }

  async getAccessToken(): Promise<string> {
    throw new DeviceIntegrationError(
      'ZALO_NATIVE_UNAVAILABLE',
      'Hãy dùng nút đăng nhập Zalo trên web.',
    );
  }

  getLocation(): Promise<GeoPoint> {
    return this.getBrowserLocation();
  }

  async scanQRCode(): Promise<string> {
    return parseContainerCodeFromQr(await this.scanBrowserQr());
  }

  chooseImage(source: ImageSource = 'camera'): Promise<PhotoAsset> {
    return this.chooseBrowserImage(source);
  }

  async openPhone(phoneNumber: string): Promise<void> {
    const normalized = normalizeVietnamesePhone(phoneNumber);
    if (!this.browserWindow) {
      throw new DeviceIntegrationError('PHONE_UNSUPPORTED', 'Thiết bị không hỗ trợ mở cuộc gọi.');
    }
    try {
      this.browserWindow.location.href = `tel:${normalized}`;
    } catch {
      const copied = await copyText(normalized, this.browserNavigator);
      throw new DeviceIntegrationError(
        'PHONE_OPEN_BLOCKED',
        copied
          ? 'WebView chặn cuộc gọi; số điện thoại đã được sao chép.'
          : `WebView chặn cuộc gọi. Số quán: ${normalized}`,
      );
    }
  }

  async openDirections(destination: GeoPoint, address?: string | null): Promise<void> {
    if (!isValidGeoPoint(destination)) {
      throw new DeviceIntegrationError('DIRECTIONS_INVALID', 'Tọa độ chỉ đường không hợp lệ.');
    }
    if (!this.browserWindow) {
      throw new DeviceIntegrationError('DIRECTIONS_UNSUPPORTED', 'Thiết bị không hỗ trợ mở bản đồ.');
    }
    const opened = this.browserWindow.open(
      buildGoogleMapsDirectionsUrl(destination),
      '_blank',
      'noopener,noreferrer',
    );
    if (opened) return;

    const fallback = address?.trim() || `${destination.lat}, ${destination.lng}`;
    const copied = await copyText(fallback, this.browserNavigator);
    throw new DeviceIntegrationError(
      'DIRECTIONS_OPEN_BLOCKED',
      copied
        ? 'WebView chặn Google Maps; địa chỉ đã được sao chép.'
        : `WebView chặn Google Maps. Địa chỉ: ${fallback}`,
    );
  }

  getStorage(key: string): string | null {
    return getBrowserStorage()?.getItem(key) ?? this.memoryStorage.get(key) ?? null;
  }

  setStorage(key: string, value: string): void {
    try {
      const storage = getBrowserStorage();
      if (storage) storage.setItem(key, value);
      else this.memoryStorage.set(key, value);
    } catch {
      this.memoryStorage.set(key, value);
    }
  }

  removeStorage(key: string): void {
    try {
      getBrowserStorage()?.removeItem(key);
    } finally {
      this.memoryStorage.delete(key);
    }
  }
}

export class MockZaloClient implements IZaloClient {
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
    throw new Error('Zalo media picker is unavailable in mock mode. Choose an image file.');
  }

  async openPhone(phoneNumber: string): Promise<void> {
    if (!phoneNumber.trim()) {
      throw new Error('Số điện thoại quán không hợp lệ');
    }
  }

  async openDirections(destination: GeoPoint): Promise<void> {
    if (!isValidGeoPoint(destination)) {
      throw new Error('Tọa độ chỉ đường không hợp lệ');
    }
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

export type DeviceClientMode = 'native' | 'browser' | 'mock';

export function createZaloClient(mode?: DeviceClientMode | boolean): IZaloClient {
  const resolvedMode =
    typeof mode === 'boolean'
      ? mode
        ? 'native'
        : 'browser'
      : mode ?? (isZaloEnvironment() ? 'native' : 'browser');
  if (resolvedMode === 'native') return new RealZaloClient();
  if (resolvedMode === 'mock') return new MockZaloClient();
  return new BrowserZaloClient();
}

const viteEnvironment = (
  import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }
).env;

const configuredMode: DeviceClientMode | undefined =
  viteEnvironment?.VITE_DEMO_MODE === 'true' && viteEnvironment.VITE_DEVICE_CLIENT_MODE === 'mock'
    ? 'mock'
    : undefined;

export const zaloClient = createZaloClient(configuredMode);

if (viteEnvironment?.MODE !== 'test' && typeof window !== 'undefined') {
  console.info('[device] capabilities', {
    mode: zaloClient.mode,
    geolocation: typeof navigator !== 'undefined' && Boolean(navigator.geolocation),
    camera:
      typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),
    barcodeDetector: typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector === 'function',
  });
}
