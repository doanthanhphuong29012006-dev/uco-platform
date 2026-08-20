'use client';

import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { api, ApiError, type StationFillForecast } from '../lib/api';
import { formatLiters } from '../lib/dashboard-utils';
import { AdminShell } from './admin-shell';
import { EmptyState, ErrorState, Skeleton } from './ui';

const forecastBadge = (forecast: StationFillForecast) => {
  const days = forecast.estimated_days_until_full;
  switch (forecast.status) {
    case 'FULL':
      return { label: 'Đã đầy', className: 'bg-red-100 text-red-700' };
    case 'CRITICAL':
      return {
        label: days === null ? 'Có thể sắp đầy' : `Có thể đầy trong ${days} ngày`,
        className: 'bg-red-100 text-red-700',
      };
    case 'WATCH':
      return {
        label: days === null ? 'Cần theo dõi' : `Có thể đầy trong ${days} ngày`,
        className: 'bg-amber-100 text-amber-800',
      };
    case 'STABLE':
      return { label: 'Ổn định', className: 'bg-emerald-100 text-emerald-700' };
    case 'INSUFFICIENT_DATA':
      return { label: 'Chưa đủ dữ liệu', className: 'bg-slate-100 text-slate-600' };
  }
};

export function StationForecastStatus({
  forecast,
  fillPct,
}: {
  forecast?: StationFillForecast;
  fillPct: number;
}) {
  if (!forecast) {
    return <>{fillPct > 95 ? 'Gần đầy' : fillPct > 80 ? 'Cần theo dõi' : 'Bình thường'}</>;
  }

  const badge = forecastBadge(forecast);
  return (
    <div className="max-w-64">
      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${badge.className}`}>
        {badge.label}
      </span>
      {forecast.status === 'STABLE' && forecast.estimated_days_until_full !== null ? (
        <p className="mt-1 text-xs text-slate-500">Còn khoảng {forecast.estimated_days_until_full} ngày</p>
      ) : null}
      {forecast.status === 'INSUFFICIENT_DATA' ? (
        <p className="mt-1 text-xs text-slate-500">{forecast.history_size}/3 ngày lịch sử</p>
      ) : null}
      {forecast.explanation.summary ? (
        <p className="mt-1 text-xs leading-5 text-slate-500">{forecast.explanation.summary}</p>
      ) : null}
    </div>
  );
}

export function StationsView() {
  const result = useQuery({ queryKey: ['stations'], queryFn: api.stations });
  if (result.isLoading) {
    return <AdminShell><Skeleton className="h-10 w-48" /><Skeleton className="mt-6 h-96" /></AdminShell>;
  }
  if (result.error) {
    return <AdminShell><ErrorState message={result.error instanceof ApiError ? result.error.message : 'Không thể tải danh sách trạm.'} /></AdminShell>;
  }
  return (
    <AdminShell>
      <p className="text-sm font-semibold text-emerald-700">Điểm tiếp nhận</p>
      <h2 className="mt-1 text-3xl font-bold">Trạm</h2>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {!result.data?.data.length ? <EmptyState message="Chưa có trạm hoạt động." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b text-xs uppercase text-slate-400">
                <tr><th className="pb-3">Tên trạm</th><th className="pb-3">Địa chỉ</th><th className="pb-3">Dung tích</th><th className="pb-3">Mức đầy</th><th className="pb-3">Trạng thái</th></tr>
              </thead>
              <tbody>{result.data.data.map((station) => {
                const tone = station.fill_pct > 95 ? 'bg-red-600' : station.fill_pct > 80 ? 'bg-orange-500' : 'bg-emerald-600';
                return (
                  <tr key={station.id} className="border-b last:border-0">
                    <td className="py-4 font-semibold">{station.name}</td>
                    <td className="py-4 text-slate-600">{station.address ?? '—'}</td>
                    <td className="py-4">{formatLiters(station.current_volume_l)} / {formatLiters(station.capacity_l)}</td>
                    <td className="py-4"><div className="flex items-center gap-3"><div className="h-2 w-32 rounded-full bg-slate-200"><div className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.min(station.fill_pct, 100)}%` }} /></div><span className="font-semibold">{station.fill_pct.toFixed(1)}%</span></div></td>
                    <td className="py-4"><StationForecastStatus forecast={station.fill_forecast} fillPct={station.fill_pct} /></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
