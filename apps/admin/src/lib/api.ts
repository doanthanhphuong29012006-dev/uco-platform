import { ApiError, createApiClient } from '@eco-oil/api-client';
import type {
  AdminAlert,
  AdminCollectorPerformance,
  AdminCollectorSummary,
  AdminMerchantSummary,
  AdminOverviewResponse,
  AdminReconciliationResponse,
  AdminStationSummary,
  AuthUser,
  PagedResponse,
} from '@eco-oil/shared-types';
import { browserTokenStorage } from './storage';

export { ApiError };

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');

const client = createApiClient({
  baseUrl: API_BASE_URL,
  storage: browserTokenStorage,
});

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) search.set(key, String(value));
  });
  const result = search.toString();
  return result ? `?${result}` : '';
};

export const api = {
  loginSeed: (zaloId: string, phone: string) =>
    client.request<{ access_token: string; refresh_token: string; user: AuthUser }>('/auth/zalo', {
      method: 'POST',
      body: { zalo_id: zaloId, phone },
      retry: false,
    }),
  me: () => client.request<AuthUser>('/auth/me'),
  logout: (refreshToken: string) => client.request('/auth/logout', { method: 'POST', body: { refresh_token: refreshToken } }),
  overview: (from?: string, to?: string) => client.request<AdminOverviewResponse>(`/admin/overview${query({ from, to })}`),
  reconciliation: (date: string) => client.request<AdminReconciliationResponse>(`/admin/reconciliation?date=${date}`),
  alerts: (params: { type?: string; resolved?: boolean; page?: number; limit?: number }) =>
    client.request<PagedResponse<AdminAlert>>(`/admin/alerts${query(params)}`),
  resolveAlert: (id: string) => client.request<AdminAlert>(`/admin/alerts/${id}/resolve`, { method: 'PATCH' }),
  stations: () => client.request<PagedResponse<AdminStationSummary>>('/admin/stations?page=1&limit=100'),
  merchants: (params: { search?: string; anomaly?: boolean }) =>
    client.request<PagedResponse<AdminMerchantSummary>>(`/admin/merchants${query({ page: 1, limit: 100, ...params })}`),
  collectors: () => client.request<PagedResponse<AdminCollectorSummary>>('/admin/collectors?page=1&limit=100'),
  collectorPerformance: (id: string) => client.request<AdminCollectorPerformance>(`/admin/collectors/${id}/performance`),
};
