import { ApiError, createApiClient } from '@eco-oil/api-client';
import type {
  AdminAlert,
  AdminAiAnomaliesResponse,
  AdminAnomalyFeedback,
  AdminAiAnomalyPerformanceResponse,
  AnomalyFeedbackVerdict,
  AdminCollectorPerformance,
  AdminCollectorSummary,
  AdminCollectorInviteResponse,
  AdminMerchantSummary,
  AdminOverviewResponse,
  AdminPickupForecastPerformanceResponse,
  AdminImageGradingPerformanceResponse,
  AdminReconciliationResponse,
  AdminStationSummary,
  AdminContainerSummary,
  AdminContainerReturnRequest,
  AdminWardSummary,
  AuthUser,
  OilPriceRecord,
  PagedResponse,
  PaymentListResponse,
  PaymentRecord,
  PaymentRunResponse,
} from '@eco-oil/shared-types';
import { browserTokenStorage } from './storage';

export { ApiError };

export type StationFillForecast = {
  average_daily_incoming_liters: number;
  remaining_capacity_liters: number;
  estimated_days_until_full: number | null;
  projected_volumes: Array<{ day: number; volume_liters: number }>;
  status: 'INSUFFICIENT_DATA' | 'FULL' | 'CRITICAL' | 'WATCH' | 'STABLE';
  history_size: number;
  reason_codes: string[];
  explanation: {
    summary: string;
    used_daily_incoming_liters: number[];
    calculation_window_days: number;
    formula: string;
  };
};

export type StationSummaryWithForecast = AdminStationSummary & {
  fill_forecast?: StationFillForecast;
};

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

const client = createApiClient({
  baseUrl: API_BASE_URL,
  storage: browserTokenStorage,
  credentials: 'include',
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
  adminLogin: (zaloId: string, phone: string, password: string) =>
    client.request<{ access_token: string; refresh_token: string; user: AuthUser }>('/auth/admin/login', { method: 'POST', body: { zalo_id: zaloId, phone, password }, retry: false }),
  me: () => client.request<AuthUser>('/auth/me'),
  logout: (refreshToken?: string) => client.request('/auth/logout', { method: 'POST', ...(refreshToken ? { body: { refresh_token: refreshToken } } : {}) }),
  overview: (from?: string, to?: string) => client.request<AdminOverviewResponse>(`/admin/overview${query({ from, to })}`),
  pickupForecastPerformance: (windowDays: 30 | 90 | 180 = 90) =>
    client.request<AdminPickupForecastPerformanceResponse>(`/admin/ai-performance/pickup-forecast${query({ window_days: windowDays })}`),
  imageGradingPerformance: (windowDays: 30 | 90 | 180 = 90) =>
    client.request<AdminImageGradingPerformanceResponse>(`/admin/ai-performance/image-grading${query({ window_days: windowDays })}`),
  aiAnomalies: (params: { window_days?: 30 | 90 | 180; risk_level?: string; verdict?: AnomalyFeedbackVerdict; page?: number; limit?: number } = {}) =>
    client.request<AdminAiAnomaliesResponse>(`/admin/ai-anomalies${query({ window_days: 90, page: 1, limit: 100, ...params })}`),
  updateAiAnomalyFeedback: (transactionId: string, body: { verdict: AnomalyFeedbackVerdict; note?: string }) =>
    client.request<AdminAnomalyFeedback>(`/admin/ai-anomalies/${transactionId}/feedback`, { method: 'PUT', body }),
  aiAnomalyPerformance: (windowDays: 30 | 90 | 180 = 90) =>
    client.request<AdminAiAnomalyPerformanceResponse>(`/admin/ai-performance/anomaly-detection${query({ window_days: windowDays })}`),
  reconciliation: (date: string) => client.request<AdminReconciliationResponse>(`/admin/reconciliation?date=${date}`),
  reconciliationCsv: (date: string) => client.request<string>(`/admin/reconciliation/export?date=${date}`),
  alerts: (params: { type?: string; resolved?: boolean; page?: number; limit?: number }) =>
    client.request<PagedResponse<AdminAlert>>(`/admin/alerts${query(params)}`),
  resolveAlert: (id: string) => client.request<AdminAlert>(`/admin/alerts/${id}/resolve`, { method: 'PATCH' }),
  stations: async (): Promise<PagedResponse<StationSummaryWithForecast>> => {
    const response = await client.request<
      PagedResponse<Omit<StationSummaryWithForecast, 'fill_pct'> & { fill_pct?: number }>
    >('/stations?page=1&limit=100');
    return {
      ...response,
      data: response.data.map((station) => ({
        ...station,
        fill_pct:
          station.fill_pct ??
          (station.capacity_l > 0 ? (station.current_volume_l / station.capacity_l) * 100 : 0),
      })),
    };
  },
  merchants: (params: { search?: string; anomaly?: boolean; status?: string }) =>
    client.request<PagedResponse<AdminMerchantSummary>>(`/admin/merchants${query({ page: 1, limit: 100, ...params })}`),
  collectors: () => client.request<PagedResponse<AdminCollectorSummary>>('/admin/collectors?page=1&limit=100&include_inactive=true'),
  collectorPerformance: (id: string) => client.request<AdminCollectorPerformance>(`/admin/collectors/${id}/performance`),
  approveMerchant: (id: string, body: { lat: number; lng: number }) => client.request(`/admin/merchants/${id}/approve`, { method: 'POST', body }),
  rejectMerchant: (id: string, reason: string) => client.request(`/admin/merchants/${id}/reject`, { method: 'POST', body: { reason } }),
  createCollector: (body: { name: string; phone: string; vehicle_type: string; max_capacity_l: number; ward_ids: string[] }) =>
    client.request<AdminCollectorInviteResponse>('/admin/collectors', { method: 'POST', body }),
  regenerateCollectorInvite: (id: string) =>
    client.request<AdminCollectorInviteResponse>('/admin/collectors/' + id + '/invite', { method: 'POST' }),
  updateCollector: (id: string, body: Record<string, unknown>) => client.request(`/admin/collectors/${id}`, { method: 'PATCH', body }),
  containers: (params: { state?: string; merchant_id?: string; unassigned?: boolean } = {}) => client.request<PagedResponse<AdminContainerSummary>>(`/admin/containers${query({ page: 1, limit: 100, ...params })}`),
  wards: (includeInactive = false) => client.request<AdminWardSummary[]>(`/admin/wards?include_inactive=${includeInactive}`),
  createWard: (body: { code: string; name: string; district: string; city: string; center_lat?: number; center_lng?: number }) => client.request<AdminWardSummary>('/admin/wards', { method: 'POST', body }),
  updateWard: (id: string, body: Record<string, unknown>) => client.request<AdminWardSummary>(`/admin/wards/${id}`, { method: 'PATCH', body }),
  createContainer: (body: { ward_id?: string; ward_code?: string; capacity_liters: number; qr_code?: string }) => client.request<AdminContainerSummary>('/admin/containers', { method: 'POST', body }),
  assignContainer: (id: string, merchant_id: string) => client.request<AdminContainerSummary>(`/admin/containers/${id}/assign`, { method: 'POST', body: { merchant_id } }),
  unassignContainer: (id: string) => client.request<AdminContainerSummary>(`/admin/containers/${id}/unassign`, { method: 'POST' }),
  returnContainerToMerchant: (id: string, body: AdminContainerReturnRequest) => client.request<AdminContainerSummary>(`/admin/containers/${id}/return-to-merchant`, { method: 'POST', body }),
  cancelContainerTransit: (id: string, body: { note?: string }) => client.request<AdminContainerSummary & { affected_transaction_ids: string[] }>(`/admin/containers/${id}/cancel-transit`, { method: 'POST', body }),
  payments: (params: { period?: string; merchant_id?: string; status?: string; page?: number; limit?: number }) =>
    client.request<PaymentListResponse>(`/admin/payments${query(params)}`),
  runPayments: (period: string) => client.request<PaymentRunResponse>(`/admin/payments/run?period=${encodeURIComponent(period)}`, { method: 'POST' }),
  markPaymentPaid: (id: string) => client.request<PaymentRecord>(`/admin/payments/${id}/mark-paid`, { method: 'POST' }),
  oilPrices: () => client.request<OilPriceRecord[]>('/admin/oil-prices'),
  createOilPrice: (body: { unit_price: number; unit?: 'PER_LITER' | 'PER_KG'; effective_from?: string; note?: string }) =>
    client.request<OilPriceRecord>('/admin/oil-prices', { method: 'POST', body }),
};
