'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import type { AdminAlert } from '@eco-oil/shared-types';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { Badge, EmptyState, ErrorState, Skeleton } from './ui';

const ALERT_LABELS: Record<string, string> = {
  GEO_MISMATCH: 'Sai vị trí',
  DELIVERY_VARIANCE: 'Lệch nộp trạm',
  COLLECTION_LITERS_DEVIATION: 'Lệch số lít so với quán báo',
  CONTAINER_TRANSIT_CANCELLED: 'Đã huỷ ca vận chuyển của can',
  MASS_ESTIMATED_NOT_WEIGHED: 'Giao dịch chưa được cân, dùng số kg ước lượng',
  SUSPECTED_ADULTERATION: 'Nghi ngờ pha lẫn dầu',
  OIL_GRADE_C: 'Dầu hạng C',
  STATION_FILL_FORECAST: 'Dự báo đầy trạm',
};

function alertLabel(type: string): string {
  return ALERT_LABELS[type] ?? type;
}

type StationFillAlertDetails = {
  station_id?: string;
  station_name?: string;
  forecast_status?: 'FULL' | 'CRITICAL' | 'WATCH';
  estimated_days_until_full?: number | null;
};

function readStationFillAlertDetails(value: unknown): StationFillAlertDetails {
  if (!value || typeof value !== 'object') return {};
  const details = value as Record<string, unknown>;
  const status = details.forecast_status;
  return {
    station_id: typeof details.station_id === 'string' ? details.station_id : undefined,
    station_name: typeof details.station_name === 'string' ? details.station_name : undefined,
    forecast_status: status === 'FULL' || status === 'CRITICAL' || status === 'WATCH' ? status : undefined,
    estimated_days_until_full:
      typeof details.estimated_days_until_full === 'number' && Number.isFinite(details.estimated_days_until_full)
        ? details.estimated_days_until_full
        : details.estimated_days_until_full === null
          ? null
          : undefined,
  };
}

export function AlertListItem({ alert, onResolve, resolvePending }: {
  alert: AdminAlert;
  onResolve: (id: string) => void;
  resolvePending: boolean;
}) {
  const alertType = String(alert.type);
  const isStationFillAlert = alertType === 'STATION_FILL_FORECAST';
  const forecastDetails = isStationFillAlert ? readStationFillAlertDetails(alert.details) : {};
  const stationLabel = forecastDetails.station_name || forecastDetails.station_id || 'Trạm chưa xác định';
  const severityLabel = alert.severity === 'HIGH' ? 'Cần xử lý' : alert.severity === 'MEDIUM' ? 'Theo dõi' : alert.severity;

  return <article className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isStationFillAlert ? 'orange' : alertType === 'COLLECTION_LITERS_DEVIATION' || alertType === 'DELIVERY_VARIANCE' ? 'orange' : 'red'}>{alertLabel(alertType)}</Badge>
        {isStationFillAlert && <Badge tone="slate">Trạm: {stationLabel}</Badge>}
        {isStationFillAlert && forecastDetails.forecast_status && <Badge tone={forecastDetails.forecast_status === 'FULL' || forecastDetails.forecast_status === 'CRITICAL' ? 'red' : 'orange'}>{forecastDetails.forecast_status}</Badge>}
        {alert.severity && <Badge tone={alert.severity === 'HIGH' ? 'red' : 'orange'}>{isStationFillAlert ? severityLabel : alert.severity}</Badge>}
        {alert.resolved_at && <Badge tone="green">Đã xử lý</Badge>}
      </div>
      {isStationFillAlert && forecastDetails.estimated_days_until_full !== undefined && forecastDetails.estimated_days_until_full !== null && <p className="mt-2 text-sm font-semibold text-slate-700">Dự kiến đầy sau: {forecastDetails.estimated_days_until_full} ngày</p>}
      <p className="mt-2 font-semibold">{alert.message ?? 'Cảnh báo cần kiểm tra'}</p>
      <p className="mt-1 text-sm text-slate-500">{formatDate(alert.created_at)}</p>
    </div>
    {!alert.resolved_at && <button className="min-h-11 rounded-xl bg-ink px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={resolvePending} onClick={() => onResolve(alert.id)}>Đánh dấu đã xử lý</button>}
  </article>;
}

export function AlertsView() {
  const [type, setType] = useState('');
  const [resolved, setResolved] = useState('');
  const queryClient = useQueryClient();
  const alerts = useQuery({
    queryKey: ['alerts', type, resolved],
    queryFn: () => api.alerts({
      type: type || undefined,
      resolved: resolved === '' ? undefined : resolved === 'true',
      page: 1,
      limit: 100,
    }),
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api.resolveAlert(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['alerts'] });
      const keys = queryClient.getQueryCache().findAll({ queryKey: ['alerts'] });
      keys.forEach((query) => {
        queryClient.setQueryData<{ data: AdminAlert[]; meta: unknown }>(query.queryKey, (old) => old
          ? { ...old, data: old.data.map((alert) => alert.id === id ? { ...alert, resolved_at: new Date().toISOString() } : alert) }
          : old);
      });
    },
  });

  if (alerts.isLoading) {
    return <AdminShell><Skeleton className="h-10 w-56" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  }
  if (alerts.error) {
    return <AdminShell><ErrorState message={alerts.error instanceof ApiError ? alerts.error.message : 'Không thể tải cảnh báo.'} /></AdminShell>;
  }

  return <AdminShell>
    <div>
      <p className="text-sm font-semibold text-emerald-700">Theo dõi bất thường</p>
      <h2 className="mt-1 text-3xl font-bold">Cảnh báo</h2>
    </div>
    <div className="mt-6 flex flex-wrap gap-3">
      <select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" value={type} onChange={(event) => setType(event.target.value)}>
        <option value="">Tất cả loại</option>
        <option value="GEO_MISMATCH">Sai vị trí</option>
        <option value="DELIVERY_VARIANCE">Lệch nộp trạm</option>
        <option value="COLLECTION_LITERS_DEVIATION">Lệch số lít so với quán báo</option>
        <option value="CONTAINER_TRANSIT_CANCELLED">Đã huỷ ca vận chuyển của can</option>
        <option value="MASS_ESTIMATED_NOT_WEIGHED">Giao dịch chưa được cân, dùng số kg ước lượng</option>
        <option value="SUSPECTED_ADULTERATION">Nghi ngờ pha lẫn dầu</option>
        <option value="OIL_GRADE_C">Dầu hạng C</option>
      </select>
      <select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" value={resolved} onChange={(event) => setResolved(event.target.value)}>
        <option value="false">Chưa xử lý</option>
        <option value="true">Đã xử lý</option>
        <option value="">Tất cả trạng thái</option>
      </select>
    </div>
    <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      {!alerts.data?.data.length ? <EmptyState message="Không có cảnh báo phù hợp." /> : <div className="space-y-3">
        {alerts.data.data.map((alert) => <AlertListItem key={alert.id} alert={alert} resolvePending={resolve.isPending} onResolve={(id) => resolve.mutate(id)} />)}
      </div>}
    </section>
  </AdminShell>;
}
