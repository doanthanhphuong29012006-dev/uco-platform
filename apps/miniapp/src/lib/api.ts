import type {
  ApiErrorBody,
  AdminWardSummary,
  AuthUser,
  DevAccount,
  CollectionCreateRequest,
  CollectionOrderResponse,
  CollectionTransactionResponse,
  ContainerLookupResponse,
  CurrentRouteResponse,
  CollectionRouteCancelResponse,
  GeoPoint,
  MerchantDashboardResponse,
  MerchantTransaction,
  MerchantRegistrationRequest,
  PagedResponse,
  PaymentListResponse,
  SyncBatchResponse,
  StationDeliveryCreateRequest,
  StationDeliveryResponse,
  StationRecommendation,
} from '@eco-oil/shared-types';
import { tokenStorage } from './storage';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown; retry?: boolean };

let refreshPromise: Promise<string | null> | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFromResponse(status: number, payload: unknown): ApiError {
  if (typeof payload === 'object' && payload !== null && 'code' in payload && 'message' in payload) {
    const body = payload as ApiErrorBody;
    return new ApiError(status, { code: body.code, message: body.message, details: body.details ?? null });
  }
  return new ApiError(status, { code: status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR', message: 'Không thể xử lý yêu cầu', details: null });
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = tokenStorage.getRefreshToken();
  if (!refreshToken) {
    return null;
  }
  const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw errorFromResponse(response.status, payload);
  }
  if (typeof payload !== 'object' || payload === null || !('access_token' in payload) || !('refresh_token' in payload)) {
    throw new ApiError(502, { code: 'INVALID_REFRESH_RESPONSE', message: 'Phản hồi làm mới phiên không hợp lệ', details: null });
  }
  const tokens = payload as { access_token: string; refresh_token: string };
  tokenStorage.setTokens(tokens.access_token, tokens.refresh_token);
  return tokens.access_token;
}

function getRefreshOnce(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().catch(() => null).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, retry = true, headers, ...init } = options;
  const accessToken = tokenStorage.getAccessToken();
  const requestHeaders = new Headers(headers);
  if (body !== undefined) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    requestHeaders.set('Authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await parseResponse(response);
  if (response.status === 401 && retry) {
    const refreshedToken = await getRefreshOnce();
    if (refreshedToken) {
      return request<T>(path, { ...options, retry: false });
    }
    tokenStorage.clear();
    unauthorizedHandler?.();
  }
  if (!response.ok) {
    throw errorFromResponse(response.status, payload);
  }
  return payload as T;
}

export const api = {
  devAccounts: () => request<DevAccount[]>('/auth/dev-accounts', { retry: false }),
  registerMerchant: (payload: MerchantRegistrationRequest) =>
    request<{ status: string; merchant: unknown }>('/merchants/register', { method: 'POST', body: payload, retry: false }),
  registrationWards: () => request<AdminWardSummary[]>('/merchants/register/wards', { retry: false }),
  updateMerchant: (id: string, payload: Partial<MerchantRegistrationRequest>) =>
    request<unknown>(`/merchants/${id}`, { method: 'PATCH', body: payload }),
  loginSeed: (zaloId: string, phone: string) =>
    request<{ access_token: string; refresh_token: string; user: AuthUser }>('/auth/zalo', {
      method: 'POST',
      body: { zalo_id: zaloId, phone },
      retry: false,
    }),
  loginWithZaloAccessToken: (accessToken: string) =>
    request<{ access_token: string; refresh_token: string; user: AuthUser }>('/auth/zalo', {
      method: 'POST',
      body: { access_token: accessToken },
      retry: false,
    }),
  resolveZaloLocation: (accessToken: string, locationToken: string) =>
    request<GeoPoint>('/auth/zalo/location', {
      method: 'POST',
      body: { access_token: accessToken, location_token: locationToken },
    }),
  logout: (refreshToken: string) => request<{ success: true }>('/auth/logout', { method: 'POST', body: { refresh_token: refreshToken }, retry: false }),
  me: () => request<AuthUser>('/auth/me'),
  dashboard: () => request<MerchantDashboardResponse>('/merchants/me/dashboard'),
  createReadyOrder: (expectedLiters?: number) =>
    request<CollectionOrderResponse>('/orders/ready', {
      method: 'POST',
      body: expectedLiters === undefined ? {} : { expected_liters: expectedLiters },
    }),
  transactions: (page: number, limit = 10, from?: string, to?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return request<PagedResponse<MerchantTransaction>>(`/merchants/me/transactions?${params.toString()}`);
  },
  payments: (period?: string, page = 1, limit = 50) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (period) params.set('period', period);
    return request<PaymentListResponse>(`/merchants/me/payments?${params.toString()}`);
  },
  orders: () => request<PagedResponse<CollectionOrderResponse>>('/orders/me?page=1&limit=50'),
  cancelOrder: (orderId: string) => request<CollectionOrderResponse>(`/orders/${orderId}/cancel`, { method: 'POST' }),
  currentRoute: (location?: GeoPoint) => {
    const query = location ? `?lat=${location.lat}&lng=${location.lng}` : '';
    return request<CurrentRouteResponse>(`/routes/current${query}`);
  },
  startRoute: (clientUuid: string, location?: GeoPoint) => request<CurrentRouteResponse>('/routes/start', {
    method: 'POST',
    body: { client_uuid: clientUuid, ...(location ? { lat: location.lat, lng: location.lng } : {}) },
  }),
  completeCurrentRoute: () => request<CurrentRouteResponse>('/routes/current/complete', { method: 'POST' }),
  cancelCurrentRoute: (reason?: string) => request<CollectionRouteCancelResponse>('/routes/current/cancel', {
    method: 'POST',
    body: reason ? { reason } : {},
  }),
  containerByQr: (code: string) => request<ContainerLookupResponse>(`/containers/by-qr/${encodeURIComponent(code)}`),
  createCollection: (payload: CollectionCreateRequest) =>
    request<CollectionTransactionResponse>('/collections', { method: 'POST', body: payload }),
  syncBatch: (items: CollectionCreateRequest[]) =>
    request<SyncBatchResponse>('/sync/batch', { method: 'POST', body: { items } }),
  recommendStations: (location: GeoPoint, liters: number) =>
    request<StationRecommendation[]>(`/stations/recommend?lat=${location.lat}&lng=${location.lng}&liters=${liters}`),
  createStationDelivery: (payload: StationDeliveryCreateRequest) =>
    request<StationDeliveryResponse>('/station-deliveries', { method: 'POST', body: payload }),
};
