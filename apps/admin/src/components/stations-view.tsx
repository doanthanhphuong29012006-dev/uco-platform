'use client';

import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { api, ApiError, type StationFillForecast, type StationSummaryWithForecast } from '../lib/api';
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

const FORECAST_PRIORITY: Record<StationFillForecast['status'], number> = {
  FULL: 0,
  CRITICAL: 1,
  WATCH: 2,
  STABLE: 3,
  INSUFFICIENT_DATA: 4,
};

export type StationPriorityFilter = 'ALL' | 'ACTION_REQUIRED' | 'WATCH' | 'STABLE' | 'INSUFFICIENT_DATA';

const FILTER_OPTIONS: Array<{ value: StationPriorityFilter; label: string }> = [
  { value: 'ALL', label: 'Tất cả' },
  { value: 'ACTION_REQUIRED', label: 'Cần xử lý' },
  { value: 'WATCH', label: 'Theo dõi' },
  { value: 'STABLE', label: 'Ổn định' },
  { value: 'INSUFFICIENT_DATA', label: 'Chưa đủ dữ liệu' },
];

export function sortStationsByFillForecast(
  stations: readonly StationSummaryWithForecast[],
): StationSummaryWithForecast[] {
  return stations
    .map((station, index) => ({ station, index }))
    .sort((left, right) => {
      const leftPriority = left.station.fill_forecast
        ? FORECAST_PRIORITY[left.station.fill_forecast.status]
        : 5;
      const rightPriority = right.station.fill_forecast
        ? FORECAST_PRIORITY[right.station.fill_forecast.status]
        : 5;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;

      if (leftPriority <= FORECAST_PRIORITY.WATCH) {
        const leftDays = left.station.fill_forecast?.estimated_days_until_full ?? null;
        const rightDays = right.station.fill_forecast?.estimated_days_until_full ?? null;
        if (leftDays !== rightDays) {
          if (leftDays === null) return 1;
          if (rightDays === null) return -1;
          return leftDays - rightDays;
        }
      }

      return left.index - right.index;
    })
    .map(({ station }) => station);
}

export function filterStationsByFillForecast(
  stations: readonly StationSummaryWithForecast[],
  filter: StationPriorityFilter = 'ALL',
): StationSummaryWithForecast[] {
  if (filter === 'ALL') return [...stations];
  return stations.filter((station) => {
    const status = station.fill_forecast?.status;
    if (filter === 'ACTION_REQUIRED') return status === 'FULL' || status === 'CRITICAL';
    if (filter === 'INSUFFICIENT_DATA') return status === 'INSUFFICIENT_DATA' || status === undefined;
    return status === filter;
  });
}

export function countStationsByFillForecast(stations: readonly StationSummaryWithForecast[]) {
  return stations.reduce(
    (counts, station) => {
      const status = station.fill_forecast?.status;
      if (status === 'FULL' || status === 'CRITICAL') counts.actionRequired += 1;
      else if (status === 'WATCH') counts.watch += 1;
      else if (status === 'STABLE') counts.stable += 1;
      else counts.insufficientData += 1;
      return counts;
    },
    { actionRequired: 0, watch: 0, stable: 0, insufficientData: 0 },
  );
}

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

export function StationsTable({ stations }: { stations: readonly StationSummaryWithForecast[] }) {
  const [filter, setFilter] = useState<StationPriorityFilter>('ALL');
  const counts = countStationsByFillForecast(stations);
  const sortedStations = sortStationsByFillForecast(stations);
  const visibleStations = filterStationsByFillForecast(sortedStations, filter);

  return (
    <>
      <div aria-label="Số lượng trạm theo mức ưu tiên" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div data-testid="station-count-action-required" className="rounded-lg bg-red-50 px-3 py-2 text-red-700">
          <p className="text-xs font-medium">Cần xử lý</p>
          <p className="text-xl font-bold">{counts.actionRequired}</p>
        </div>
        <div data-testid="station-count-watch" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
          <p className="text-xs font-medium">Theo dõi</p>
          <p className="text-xl font-bold">{counts.watch}</p>
        </div>
        <div data-testid="station-count-stable" className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-700">
          <p className="text-xs font-medium">Ổn định</p>
          <p className="text-xl font-bold">{counts.stable}</p>
        </div>
        <div data-testid="station-count-insufficient" className="rounded-lg bg-slate-100 px-3 py-2 text-slate-600">
          <p className="text-xs font-medium">Chưa đủ dữ liệu</p>
          <p className="text-xl font-bold">{counts.insufficientData}</p>
        </div>
      </div>
      <label className="mb-4 flex w-fit items-center gap-3 text-sm font-medium text-slate-700">
        <span>Mức ưu tiên</span>
        <select
          aria-label="Lọc mức độ ưu tiên"
          className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm"
          value={filter}
          onChange={(event) => setFilter(event.target.value as StationPriorityFilter)}
        >
          {FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {!stations.length ? <EmptyState message="Chưa có trạm hoạt động." /> : !visibleStations.length ? (
        <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-slate-500">
          Không có trạm phù hợp với bộ lọc.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b text-xs uppercase text-slate-400">
              <tr><th className="pb-3">Tên trạm</th><th className="pb-3">Địa chỉ</th><th className="pb-3">Dung tích</th><th className="pb-3">Mức đầy</th><th className="pb-3">Trạng thái</th></tr>
            </thead>
            <tbody>{visibleStations.map((station) => {
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
    </>
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
        <StationsTable stations={result.data?.data ?? []} />
      </section>
    </AdminShell>
  );
}
